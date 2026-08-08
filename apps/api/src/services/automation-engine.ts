import { EventEmitter } from "node:events";
import { formatUnits } from "ethers";
import { nanoid } from "nanoid";
import {
  DEFAULT_SETTINGS,
  RECENT_TRANSACTION_LIMIT,
  type AutomationSettings,
  type BotSnapshot,
  type BotStatistics,
  type BotStatus,
  type LogEntry,
  type LogLevel,
  type RpcHealth,
  type TransactionRecord,
} from "@zig/shared";
import { AppError, normalizeError } from "../lib/errors.js";
import type { ExecutedSwap, LiveTrader } from "./live-trader.js";
import type { RuntimeStateStore } from "../state/runtime-state-store.js";

export interface GasReader {
  estimate(): Promise<{ feeUsd: number }>;
}

export interface RpcHealthReader {
  healthCheck(): Promise<RpcHealth[]>;
  snapshot(): RpcHealth[];
}

export class AutomationEngine {
  private status: BotStatus = "stopped";
  private statusMessage = "Automation is stopped";
  private settings: AutomationSettings = { ...DEFAULT_SETTINGS };
  private walletPrivateKey: string | null = null;
  private readonly logs: LogEntry[] = [];
  private recentTransactions: TransactionRecord[] = [];
  private readonly events = new EventEmitter();
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight = false;
  private shuttingDown = false;
  private resumeAfterShutdown = false;
  private consecutiveFailures = 0;
  private pendingSellAmountRaw: string | null = null;
  private stats: BotStatistics = {
    totalCycles: 0,
    successfulSwaps: 0,
    failedSwaps: 0,
    currentCycle: 0,
    startedAt: null,
    runtimeSeconds: 0,
    ethBalance: "0.0000",
    zigBalance: "0.00",
    totalGasUsd: 0,
    averageGasUsd: 0,
    totalVolumeUsd: 0,
    lastTradeAt: null,
    currentGasUsd: null,
    nextExecutionAt: null,
    totalTransactions: 0,
  };

  constructor(
    private readonly gas: GasReader,
    private readonly rpc: RpcHealthReader,
    private readonly executionMode: "paper" | "live",
    private readonly trader?: LiveTrader,
    private readonly stateStore?: RuntimeStateStore,
  ) {
    this.addLog("info", `Service initialized in ${executionMode.toUpperCase()} mode`);
  }

  async initialize(): Promise<void> {
    if (!this.stateStore) return;
    const restored = await this.stateStore.load();
    if (!restored) return;
    this.settings = restored.settings;
    this.stats = restored.stats;
    this.walletPrivateKey = restored.walletPrivateKey;
    this.pendingSellAmountRaw = restored.pendingSellAmountRaw;
    this.recentTransactions = restored.recentTransactions ?? [];
    if (restored.shouldResume && this.walletPrivateKey && this.settings.walletAddress) {
      this.status = "running";
      this.statusMessage = this.pendingSellAmountRaw ? "Resuming persisted sell leg" : "Resuming automation";
      this.addLog("warning", "Recovered encrypted automation state after restart");
      this.scheduleNext(1_000);
    }
  }

  snapshot(): BotSnapshot {
    return {
      status: this.status,
      statusMessage: this.statusMessage,
      settings: { ...this.settings },
      statistics: { ...this.stats, runtimeSeconds: this.runtimeSeconds() },
      logs: [...this.logs],
      recentTransactions: [...this.recentTransactions],
      rpcHealth: this.rpc.snapshot(),
      executionMode: this.executionMode,
      signerConfigured: Boolean(this.walletPrivateKey),
    };
  }

  subscribe(listener: (snapshot: BotSnapshot) => void): () => void {
    this.events.on("snapshot", listener);
    return () => this.events.off("snapshot", listener);
  }

  async start(): Promise<BotSnapshot> {
    if (this.status !== "stopped" && this.status !== "error") return this.snapshot();
    if (this.cycleInFlight) {
      throw new AppError(
        "INVALID_REQUEST",
        "The previous transaction is still settling. Wait before starting again.",
        409,
      );
    }
    if (!this.settings.walletAddress) throw new AppError("WALLET_DISCONNECTED", undefined, 409);
    if (this.executionMode === "live" && !this.walletPrivateKey) throw new AppError("WALLET_DISCONNECTED", "Private key is not configured on the server.", 409);
    // Complete preflight before changing state so a transient balance failure
    // cannot leave the engine marked as running without a scheduled cycle.
    await this.refreshBalances();
    const previousStatus = this.status;
    const previousStatusMessage = this.statusMessage;
    const previousStats = { ...this.stats };
    const previousFailures = this.consecutiveFailures;
    this.status = "running";
    this.statusMessage = this.executionMode === "live" ? "Automation running on Ethereum mainnet" : "Automation running in paper mode";
    this.stats.startedAt = new Date().toISOString();
    this.stats.nextExecutionAt = new Date().toISOString();
    this.consecutiveFailures = 0;
    try {
      await this.persist(true);
    } catch (error) {
      this.status = previousStatus;
      this.statusMessage = previousStatusMessage;
      this.stats = previousStats;
      this.consecutiveFailures = previousFailures;
      this.emit();
      throw error;
    }
    this.addLog("success", "Automation started");
    this.emit();
    void this.runCycle();
    return this.snapshot();
  }

  async stop(reason = "Stopped manually"): Promise<BotSnapshot> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status = "stopped";
    this.statusMessage = reason;
    this.stats.nextExecutionAt = null;
    this.walletPrivateKey = null;
    this.pendingSellAmountRaw = null;
    this.settings = { ...this.settings, walletAddress: null };
    this.stats.ethBalance = "0.0000";
    this.stats.zigBalance = "0.00";
    // A transaction hash resolves to the wallet address on any explorer, so the
    // history is purged alongside the credentials it would otherwise expose.
    this.recentTransactions = [];
    this.addLog("warning", `${reason}; wallet credentials were purged`);
    await this.purgePersistedCredentials();
    this.emit();
    return this.snapshot();
  }

  async clearWallet(reason = "Wallet credentials cleared"): Promise<BotSnapshot> {
    if (this.status !== "stopped" && this.status !== "error") {
      throw new AppError("INVALID_REQUEST", "Stop automation before clearing wallet credentials.", 409);
    }
    if (this.cycleInFlight) {
      throw new AppError(
        "INVALID_REQUEST",
        "The previous transaction is still settling. Wait before clearing wallet credentials.",
        409,
      );
    }
    this.walletPrivateKey = null;
    this.pendingSellAmountRaw = null;
    this.settings = { ...this.settings, walletAddress: null };
    this.stats.ethBalance = "0.0000";
    this.stats.zigBalance = "0.00";
    this.stats.nextExecutionAt = null;
    this.recentTransactions = [];
    this.addLog("warning", reason);
    await this.purgePersistedCredentials();
    this.emit();
    return this.snapshot();
  }

  async shutdown(reason = "Service shutting down"): Promise<void> {
    this.resumeAfterShutdown = this.canSchedule() || this.cycleInFlight;
    this.shuttingDown = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stats.nextExecutionAt = null;
    this.addLog("warning", reason);
    await this.persist(this.resumeAfterShutdown);
    this.emit();
  }

  async updateSettings(patch: Partial<AutomationSettings>): Promise<BotSnapshot> {
    if (this.executionMode === "live" && "walletAddress" in patch) {
      throw new AppError("INVALID_REQUEST", "Wallet credentials must be changed through the wallet connection endpoint.", 400);
    }
    const previousInterval = this.settings.intervalSeconds;
    const previousSettings = this.settings;
    this.settings = { ...this.settings, ...patch };
    try {
      await this.persist();
    } catch (error) {
      this.settings = previousSettings;
      this.emit();
      throw error;
    }
    this.addLog("info", "Settings updated", { fields: Object.keys(patch) });
    if (patch.intervalSeconds && patch.intervalSeconds !== previousInterval && this.timer) {
      clearTimeout(this.timer);
      this.scheduleNext();
      this.addLog("success", `Interval changed to ${patch.intervalSeconds}s while running`);
    }
    this.emit();
    return this.snapshot();
  }

  async configureWallet(input: { walletAddress: string; privateKey: string }): Promise<BotSnapshot> {
    if (!this.trader) throw new AppError("INTERNAL_ERROR", "Live trader is not available.");
    if (this.status !== "stopped" && this.status !== "error") {
      throw new AppError("INVALID_REQUEST", "Stop automation before changing wallet credentials.", 409);
    }
    if (this.cycleInFlight) {
      throw new AppError(
        "INVALID_REQUEST",
        "The previous transaction is still settling. Wait before entering another wallet.",
        409,
      );
    }
    if (
      this.pendingSellAmountRaw &&
      this.settings.walletAddress &&
      this.settings.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        "A pending sell is locked to the current wallet. Resume and complete it before changing wallets.",
        409,
      );
    }
    const walletAddress = await this.trader.verifyCredentials(input.walletAddress, input.privateKey);
    const previousSettings = this.settings;
    const previousPrivateKey = this.walletPrivateKey;
    const previousStats = { ...this.stats };
    try {
      this.settings = { ...this.settings, walletAddress };
      this.walletPrivateKey = input.privateKey;
      await this.refreshBalances();
      await this.persist();
    } catch (error) {
      this.settings = previousSettings;
      this.walletPrivateKey = previousPrivateKey;
      this.stats = previousStats;
      this.emit();
      throw error;
    }
    this.addLog("success", "Server-side wallet credentials configured", {
      walletAddress,
    });
    this.emit();
    return this.snapshot();
  }

  async refreshBalances(): Promise<BotSnapshot> {
    if (!this.settings.walletAddress || !this.trader) return this.snapshot();
    const balances = await this.trader.getBalances(this.settings.walletAddress);
    this.stats.ethBalance = balances.eth;
    this.stats.zigBalance = balances.zig;
    this.emit();
    return this.snapshot();
  }

  async refreshHealth(): Promise<void> {
    await this.rpc.healthCheck();
    this.emit();
  }

  /**
   * True only when dropping this engine from memory cannot abandon funds.
   * A cycle in flight, a locked sell leg, or any non-terminal status means the
   * engine is still responsible for an unfinished position and must be kept.
   */
  isEvictable(): boolean {
    return (
      !this.cycleInFlight &&
      !this.pendingSellAmountRaw &&
      (this.status === "stopped" || this.status === "error")
    );
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.events.removeAllListeners();
  }

  private async runCycle(): Promise<void> {
    if (this.status === "stopped" || this.cycleInFlight) return;
    this.cycleInFlight = true;
    const isSellLeg = Boolean(this.pendingSellAmountRaw);
    if (!isSellLeg) {
      this.stats.currentCycle += 1;
    }
    this.setStatus(
      "processing",
      isSellLeg
        ? `Preparing sell leg for cycle #${this.stats.currentCycle}`
        : `Preparing buy leg for cycle #${this.stats.currentCycle}`,
    );
    let retryDelayMs: number | undefined;

    try {
      const estimate = await this.gas.estimate();
      if (!this.shouldContinueExecution()) return;
      this.stats.currentGasUsd = round(estimate.feeUsd);
      if (estimate.feeUsd > this.settings.gasThresholdUsd) {
        this.setStatus("waiting_for_gas", "Waiting for gas fees to fall below threshold...");
        this.addLog(
          "warning",
          `Gas $${estimate.feeUsd.toFixed(2)} exceeds $${this.settings.gasThresholdUsd.toFixed(2)} limit; nothing submitted`,
        );
        return;
      }

      this.addLog("success", `Gas acceptable ($${estimate.feeUsd.toFixed(2)})`);
      let completedCycle = false;
      if (this.executionMode === "paper") {
        completedCycle = await this.paperLeg(estimate.feeUsd);
      } else {
        completedCycle = await this.liveLeg();
      }
      if (!this.shouldContinueExecution()) return;
      this.consecutiveFailures = 0;
      if (completedCycle) {
        this.stats.totalCycles += 1;
        this.stats.lastTradeAt = new Date().toISOString();
        this.setStatus("running", `Cycle #${this.stats.currentCycle} completed successfully`);
        this.addLog("success", `Cycle #${this.stats.currentCycle} completed successfully`);
      } else {
        this.setStatus("running", `Buy leg completed; sell leg scheduled after interval`);
      }
    } catch (error) {
      if (!this.shouldContinueExecution()) {
        this.addLog("info", "Current execution halted before another transaction was submitted");
        return;
      }
      const normalized = normalizeError(error);
      this.consecutiveFailures += 1;
      this.stats.failedSwaps += 1;
      this.addLog("error", normalized.message, {
        code: normalized.code,
        suggestedAction: normalized.suggestedAction,
        retryable: normalized.retryable,
      });
      if (!normalized.retryable) {
        const failedLeg = this.pendingSellAmountRaw ? "sell" : "buy";
        const haltMessage =
          `Automation stopped at cycle #${this.stats.currentCycle} during the ${failedLeg} leg: ${normalized.message}`;
        this.status = "error";
        this.statusMessage = haltMessage;
        this.addLog("error", haltMessage, {
          cycle: this.stats.currentCycle,
          leg: failedLeg,
          code: normalized.code,
          suggestedAction: normalized.suggestedAction,
        });
      } else {
        retryDelayMs = Math.min(60_000, 5_000 * (2 ** Math.min(this.consecutiveFailures - 1, 4)));
        const retrySeconds = Math.ceil(retryDelayMs / 1_000);
        const leg = this.pendingSellAmountRaw ? "sell" : "cycle";
        this.setStatus("running", `Temporary error; retrying the same ${leg} in ${retrySeconds}s`);
        this.addLog("warning", `Retrying the same ${leg} in ${retrySeconds}s`);
      }
    } finally {
      this.cycleInFlight = false;
      if (this.canSchedule()) this.scheduleNext(retryDelayMs);
      this.emit();
    }
  }

  private async paperLeg(gasUsd: number): Promise<boolean> {
    if (!this.pendingSellAmountRaw) {
      await this.paperSwap("buy", gasUsd);
      this.pendingSellAmountRaw = "paper";
      await this.persist();
      return false;
    }
    await this.paperSwap("sell", gasUsd);
    this.pendingSellAmountRaw = null;
    await this.persist();
    return true;
  }

  private async paperSwap(side: "buy" | "sell", gasUsd: number): Promise<void> {
    const verb = side === "buy" ? "Buying ZIG" : "Selling ZIG";
    this.setStatus("waiting_for_confirmation", `${verb} (paper simulation)...`);
    this.addLog("info", `${verb}...`);
    await new Promise((resolve) => setTimeout(resolve, 450));
    this.stats.successfulSwaps += 1;
    this.stats.totalTransactions += 1;
    this.stats.totalGasUsd = round(this.stats.totalGasUsd + gasUsd);
    this.stats.averageGasUsd = round(this.stats.totalGasUsd / this.stats.totalTransactions);
    this.stats.totalVolumeUsd = round(this.stats.totalVolumeUsd + 2.5);
    this.stats.ethBalance = side === "buy" ? "0.0236" : "0.0248";
    this.stats.zigBalance = side === "buy" ? "58.42" : "0.00";
    this.addLog("success", `${side === "buy" ? "Buy" : "Sell"} confirmed (paper)`);
  }

  private async liveLeg(): Promise<boolean> {
    if (!this.trader || !this.walletPrivateKey || !this.settings.walletAddress) {
      throw new AppError("WALLET_DISCONNECTED", "Wallet credentials are incomplete.", 409);
    }

    if (!this.pendingSellAmountRaw) {
      const tradeAmountRaw = this.trader.parseEthAmount(this.settings.tradeAmountEth);
      const before = await this.trader.getBalances(this.settings.walletAddress);
      if (!this.shouldContinueExecution()) return false;
      if (before.ethRaw <= tradeAmountRaw) {
        throw new AppError("INSUFFICIENT_ETH", `Wallet balance ${before.eth} ETH is below the configured trade size ${this.settings.tradeAmountEth} ETH.`, 409);
      }

      this.setStatus("waiting_for_confirmation", "Buying ZIG...");
      this.addLog("info", `Submitting buy leg for ${this.settings.tradeAmountEth} ETH`);
      const buy = await this.trader.executeSwap({
        side: "buy",
        walletAddress: this.settings.walletAddress,
        privateKey: this.walletPrivateKey,
        amountRaw: tradeAmountRaw.toString(),
        slippageBps: this.settings.slippageBps,
        gasThresholdUsd: this.settings.gasThresholdUsd,
        maxPriceImpactBps: this.settings.maxPriceImpactBps,
        minimumBalanceUsd: this.settings.minimumBalanceUsd,
        shouldContinue: () => this.shouldContinueExecution(),
      });
      if (!this.shouldContinueExecution()) return false;
      this.recordSwapMetrics(buy.gasUsd);

      if (BigInt(buy.receivedRaw) <= 0n) {
        throw new AppError("SWAP_REVERTED", "Buy leg returned zero ZIG.", 409);
      }

      // This is set immediately after confirmation. Every subsequent retry is
      // forced through the sell branch until this exact amount is sold.
      this.pendingSellAmountRaw = buy.receivedRaw;
      // Recorded only after the sell lock is set. Display bookkeeping must never
      // run ahead of the guarantee that a confirmed buy will be sold.
      this.recordTransaction(buy);
      await this.persist();
      this.addLog("success", "Buy confirmed; sell leg locked", {
        hash: buy.hash,
        receivedRaw: buy.receivedRaw,
      });
      await this.refreshBalancesBestEffort();
      if (!this.shouldContinueExecution()) return false;
      return false;
    } else {
      this.addLog("warning", `Resuming pending sell for ${this.pendingSellAmountRaw} ZIG base units; no new buy will run`);
    }

    const sellAmountRaw = this.pendingSellAmountRaw;
    if (!sellAmountRaw) throw new AppError("INTERNAL_ERROR", "Pending sell amount was lost.");
    if (!this.shouldContinueExecution()) return false;
    this.setStatus("waiting_for_confirmation", "Selling ZIG...");
    this.addLog("info", `Submitting sell leg for ${sellAmountRaw} ZIG base units`);
    const sell = await this.trader.executeSwap({
      side: "sell",
      walletAddress: this.settings.walletAddress,
      privateKey: this.walletPrivateKey,
      amountRaw: sellAmountRaw,
      slippageBps: this.settings.slippageBps,
      gasThresholdUsd: this.settings.gasThresholdUsd,
      maxPriceImpactBps: this.settings.maxPriceImpactBps,
      minimumBalanceUsd: this.settings.minimumBalanceUsd,
      shouldContinue: () => this.shouldContinueExecution(),
    });
    this.recordSwapMetrics(sell.gasUsd);
    // Cleared first for the same reason: a recording failure must not leave the
    // lock set and cause the same ZIG to be sold twice.
    this.pendingSellAmountRaw = null;
    this.recordTransaction(sell);
    await this.persist();
    this.addLog("success", "Sell confirmed", {
      hash: sell.hash,
      soldRaw: sellAmountRaw,
      receivedRaw: sell.receivedRaw,
    });
    await this.refreshBalancesBestEffort();
    return true;
  }

  private scheduleNext(delayOverrideMs?: number): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = delayOverrideMs ?? this.settings.intervalSeconds * 1_000;
    this.stats.nextExecutionAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => void this.runCycle(), delay);
  }

  private canSchedule(): boolean {
    return !this.shuttingDown && this.status !== "stopped" && this.status !== "error";
  }

  private async refreshBalancesBestEffort(): Promise<void> {
    try {
      await this.refreshBalances();
    } catch (error) {
      const normalized = normalizeError(error);
      this.addLog("warning", `Balance refresh delayed: ${normalized.message}`);
    }
  }

  private async persist(shouldResume = this.shouldResumeOnRestart()): Promise<void> {
    await this.stateStore?.save({
      settings: this.settings,
      stats: this.stats,
      walletPrivateKey: this.walletPrivateKey,
      pendingSellAmountRaw: this.pendingSellAmountRaw,
      recentTransactions: this.recentTransactions,
      shouldResume,
    });
  }

  private async purgePersistedCredentials(): Promise<void> {
    if (!this.stateStore) return;
    let overwriteError: unknown;
    try {
      // First replace the live row with a credential-free payload so a failed
      // DELETE still leaves no usable key in the current database record.
      await this.persist(false);
    } catch (error) {
      overwriteError = error;
    }
    try {
      await this.stateStore.clear();
    } catch (deleteError) {
      throw overwriteError ?? deleteError;
    }
  }

  private shouldContinueExecution(): boolean {
    return !this.shuttingDown && this.status !== "stopped";
  }

  private shouldResumeOnRestart(): boolean {
    return this.shuttingDown ? this.resumeAfterShutdown : this.canSchedule();
  }

  private setStatus(status: BotStatus, message: string): void {
    this.status = status;
    this.statusMessage = message;
    this.emit();
  }

  private addLog(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const entry: LogEntry = {
      id: nanoid(),
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(context ? { context } : {}),
    };
    this.logs.unshift(entry);
    if (this.logs.length > 500) this.logs.length = 500;
  }

  private emit(): void {
    this.events.emit("snapshot", this.snapshot());
  }

  private runtimeSeconds(): number {
    if (!this.stats.startedAt) return 0;
    return Math.max(0, Math.floor((Date.now() - Date.parse(this.stats.startedAt)) / 1_000));
  }

  private recordSwapMetrics(gasUsd: number): void {
    this.stats.successfulSwaps += 1;
    this.stats.totalTransactions += 1;
    this.stats.totalGasUsd = round(this.stats.totalGasUsd + gasUsd);
    this.stats.averageGasUsd = round(this.stats.totalGasUsd / this.stats.totalTransactions);
    this.stats.lastTradeAt = new Date().toISOString();
  }

  /**
   * Keeps the newest confirmed swaps so the dashboard can link each one to a
   * block explorer. Only confirmed hashes reach this list; a reverted or
   * never-broadcast swap throws before it is called.
   */
  private recordTransaction(swap: ExecutedSwap): void {
    const isBuy = swap.side === "buy";
    this.recentTransactions.unshift({
      id: nanoid(),
      hash: swap.hash,
      side: swap.side,
      cycle: this.stats.currentCycle,
      ethAmount: formatRaw(isBuy ? swap.soldRaw : swap.receivedRaw),
      zigAmount: formatRaw(isBuy ? swap.receivedRaw : swap.soldRaw),
      gasUsd: round(swap.gasUsd),
      timestamp: new Date().toISOString(),
    });
    if (this.recentTransactions.length > RECENT_TRANSACTION_LIMIT) {
      this.recentTransactions.length = RECENT_TRANSACTION_LIMIT;
    }
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Formats a base-unit amount for display without ever throwing. This runs after
 * a swap has already settled on chain, so a malformed field must degrade to a
 * readable row rather than abort the cycle that owns the position.
 */
function formatRaw(value: string | undefined): string {
  try {
    return formatUnits(BigInt(value ?? "0"), 18);
  } catch {
    return "0";
  }
}
