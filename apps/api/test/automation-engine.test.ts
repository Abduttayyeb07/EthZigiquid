import { describe, expect, it, vi } from "vitest";
import type { RpcHealth } from "@zig/shared";
import { AppError } from "../src/lib/errors.js";
import { AutomationEngine } from "../src/services/automation-engine.js";
import type { LiveTrader } from "../src/services/live-trader.js";
import type { RuntimeStateStore } from "../src/state/runtime-state-store.js";

const address = "0x0000000000000000000000000000000000000001";
const rpcHealth: RpcHealth[] = [{
  url: "https://rpc.example",
  healthy: true,
  latencyMs: 20,
  blockNumber: 1,
  failures: 0,
  lastCheckedAt: new Date().toISOString(),
  active: true,
}];

function createEngine(feeUsd = 0.5) {
  return new AutomationEngine(
    { estimate: vi.fn().mockResolvedValue({ feeUsd }) },
    { healthCheck: vi.fn().mockResolvedValue(rpcHealth), snapshot: () => rpcHealth },
    "paper",
  );
}

function createLiveEngine(
  executeSwap: ReturnType<typeof vi.fn>,
  getBalances = vi.fn().mockResolvedValue({
  walletAddress: address,
  eth: "1.000000",
  zig: "0.000000",
  updatedAt: new Date().toISOString(),
  ethRaw: 1_000_000_000_000_000_000n,
  zigRaw: 0n,
  }),
  stateStore?: RuntimeStateStore,
) {
  const trader = {
    verifyCredentials: vi.fn().mockResolvedValue(address),
    getBalances,
    parseEthAmount: vi.fn().mockReturnValue(1_000_000_000_000_000n),
    executeSwap,
  } as unknown as LiveTrader;
  return new AutomationEngine(
    { estimate: vi.fn().mockResolvedValue({ feeUsd: 0.5 }) },
    { healthCheck: vi.fn().mockResolvedValue(rpcHealth), snapshot: () => rpcHealth },
    "live",
    trader,
    stateStore,
  );
}

describe("AutomationEngine", () => {
  it("requires an external wallet identity before starting", async () => {
    const engine = createEngine();
    await expect(engine.start()).rejects.toMatchObject({ code: "WALLET_DISCONNECTED" });
    engine.dispose();
  });

  it("changes its interval while active", async () => {
    const engine = createEngine();
    engine.updateSettings({ walletAddress: address });
    await engine.start();
    engine.updateSettings({ intervalSeconds: 10 });
    expect(engine.snapshot().settings.intervalSeconds).toBe(10);
    engine.stop();
    engine.dispose();
  });

  it("waits without submitting when gas is over the threshold", async () => {
    const engine = createEngine(2);
    engine.updateSettings({ walletAddress: address, gasThresholdUsd: 1 });
    await engine.start();
    await vi.waitFor(() => expect(engine.snapshot().status).toBe("waiting_for_gas"));
    expect(engine.snapshot().statistics.totalTransactions).toBe(0);
    engine.stop();
    engine.dispose();
  });

  it("retries a failed sell without running another buy", async () => {
    vi.useFakeTimers();
    const executeSwap = vi.fn()
      .mockResolvedValueOnce({ side: "buy", hash: "0xbuy", receivedRaw: "500", gasUsd: 0.1 })
      .mockRejectedValueOnce(new AppError("RPC_UNAVAILABLE"))
      .mockResolvedValueOnce({ side: "sell", hash: "0xsell", soldRaw: "500", receivedRaw: "900", gasUsd: 0.1 });
    const engine = createLiveEngine(executeSwap);
    await engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) });
    await engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(executeSwap.mock.calls.map(([input]) => input.side)).toEqual(["buy"]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(executeSwap.mock.calls.map(([input]) => input.side)).toEqual(["buy", "sell"]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(executeSwap.mock.calls.map(([input]) => input.side)).toEqual(["buy", "sell", "sell"]);
    expect(executeSwap.mock.calls[2]?.[0].amountRaw).toBe("500");
    engine.stop();
    engine.dispose();
    vi.useRealTimers();
  });

  it("keeps retrying temporary failures beyond the old three-failure limit", async () => {
    vi.useFakeTimers();
    const executeSwap = vi.fn().mockRejectedValue(new AppError("RPC_UNAVAILABLE"));
    const engine = createLiveEngine(executeSwap);
    await engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) });
    await engine.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executeSwap).toHaveBeenCalledTimes(4);
    expect(engine.snapshot().status).toBe("running");
    engine.stop();
    engine.dispose();
    vi.useRealTimers();
  });

  it("reports the cycle and leg when a non-retryable failure stops automation", async () => {
    vi.useFakeTimers();
    const executeSwap = vi.fn().mockRejectedValue(new AppError("SWAP_REVERTED", "Router reverted.", 409));
    const engine = createLiveEngine(executeSwap);
    await engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) });
    await engine.start();
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = engine.snapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.statusMessage).toContain("Automation stopped at cycle #1 during the buy leg");
    expect(snapshot.logs[0]?.message).toContain("Automation stopped at cycle #1 during the buy leg");
    engine.dispose();
    vi.useRealTimers();
  });

  it("stays stopped when the start balance preflight fails", async () => {
    const getBalances = vi.fn()
      .mockResolvedValueOnce({
        walletAddress: address,
        eth: "1.000000",
        zig: "0.000000",
        updatedAt: new Date().toISOString(),
        ethRaw: 1_000_000_000_000_000_000n,
        zigRaw: 0n,
      })
      .mockRejectedValueOnce(new AppError("RPC_UNAVAILABLE"));
    const engine = createLiveEngine(vi.fn(), getBalances);
    await engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) });
    await expect(engine.start()).rejects.toMatchObject({ code: "RPC_UNAVAILABLE" });
    expect(engine.snapshot().status).toBe("stopped");
    engine.dispose();
  });

  it("does not keep wallet credentials when balance refresh fails during setup", async () => {
    const getBalances = vi.fn().mockRejectedValue(new AppError("RPC_UNAVAILABLE"));
    const engine = createLiveEngine(vi.fn(), getBalances);

    await expect(
      engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) }),
    ).rejects.toMatchObject({ code: "RPC_UNAVAILABLE" });

    expect(engine.snapshot()).toMatchObject({
      signerConfigured: false,
      settings: { walletAddress: null },
    });
    engine.dispose();
  });

  it("does not keep wallet credentials when persistence fails during setup", async () => {
    const stateStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockRejectedValue(new Error("database unavailable")),
    } as unknown as RuntimeStateStore;
    const engine = createLiveEngine(vi.fn(), undefined, stateStore);

    await expect(
      engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) }),
    ).rejects.toThrow("database unavailable");

    expect(engine.snapshot()).toMatchObject({
      signerConfigured: false,
      settings: { walletAddress: null },
    });
    engine.dispose();
  });

  it("rolls back settings when persistence fails", async () => {
    const stateStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockRejectedValue(new Error("database unavailable")),
    } as unknown as RuntimeStateStore;
    const engine = new AutomationEngine(
      { estimate: vi.fn().mockResolvedValue({ feeUsd: 0.5 }) },
      { healthCheck: vi.fn().mockResolvedValue(rpcHealth), snapshot: () => rpcHealth },
      "paper",
      undefined,
      stateStore,
    );

    await expect(engine.updateSettings({ tradeAmountEth: "0.05" })).rejects.toThrow("database unavailable");
    expect(engine.snapshot().settings.tradeAmountEth).toBe("0.001");
    engine.dispose();
  });

  it("stays stopped when persistence fails during start", async () => {
    const stateStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("database unavailable")),
    } as unknown as RuntimeStateStore;
    const engine = createLiveEngine(vi.fn(), undefined, stateStore);
    await engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) });

    await expect(engine.start()).rejects.toThrow("database unavailable");
    expect(engine.snapshot().status).toBe("stopped");
    expect(engine.snapshot().statistics.nextExecutionAt).toBeNull();
    engine.dispose();
  });

  it("preserves automatic resume intent during graceful shutdown", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const stateStore = {
      load: vi.fn().mockResolvedValue(null),
      save,
    } as unknown as RuntimeStateStore;
    const engine = createLiveEngine(vi.fn(), undefined, stateStore);
    await engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) });
    await engine.start();
    await engine.shutdown();
    expect(save.mock.calls.at(-1)?.[0].shouldResume).toBe(true);
    engine.dispose();
  });

  it("purges credentials and does not submit another transaction after manual stop", async () => {
    let finishBuy!: (value: {
      side: "buy";
      hash: string;
      receivedRaw: string;
      gasUsd: number;
    }) => void;
    const buyPending = new Promise<{
      side: "buy";
      hash: string;
      receivedRaw: string;
      gasUsd: number;
    }>((resolve) => {
      finishBuy = resolve;
    });
    const executeSwap = vi.fn()
      .mockReturnValueOnce(buyPending)
      .mockResolvedValueOnce({ side: "sell", hash: "0xsell", soldRaw: "500", receivedRaw: "900", gasUsd: 0.1 });
    const save = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn().mockResolvedValue(undefined);
    const stateStore = {
      load: vi.fn().mockResolvedValue(null),
      save,
      clear,
    } as unknown as RuntimeStateStore;
    const engine = createLiveEngine(executeSwap, undefined, stateStore);
    await engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) });
    await engine.start();
    await vi.waitFor(() => expect(executeSwap).toHaveBeenCalledTimes(1));

    await engine.stop();
    expect(engine.snapshot()).toMatchObject({
      signerConfigured: false,
      settings: { walletAddress: null },
      statistics: { ethBalance: "0.0000", zigBalance: "0.00" },
    });
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({
      walletPrivateKey: null,
      pendingSellAmountRaw: null,
      shouldResume: false,
      settings: { walletAddress: null },
    });
    expect(clear).toHaveBeenCalledOnce();

    finishBuy({ side: "buy", hash: "0xbuy", receivedRaw: "500", gasUsd: 0.1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executeSwap).toHaveBeenCalledTimes(1);
    await expect(engine.start()).rejects.toMatchObject({ code: "WALLET_DISCONNECTED" });
    engine.dispose();
  });

  it("records confirmed swaps newest first with explorer-ready hashes", async () => {
    vi.useFakeTimers();
    const executeSwap = vi.fn()
      .mockResolvedValueOnce({
        side: "buy",
        hash: "0xbuy",
        soldRaw: "1000000000000000",
        receivedRaw: "4778167863778748062",
        gasUsd: 0.12,
      })
      .mockResolvedValueOnce({
        side: "sell",
        hash: "0xsell",
        soldRaw: "4778167863778748062",
        receivedRaw: "994000000000000",
        gasUsd: 0.14,
      });
    const engine = createLiveEngine(executeSwap);
    await engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) });
    await engine.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(engine.snapshot().recentTransactions).toMatchObject([
      { side: "buy", hash: "0xbuy", ethAmount: "0.001", zigAmount: "4.778167863778748062" },
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    const [sell, buy] = engine.snapshot().recentTransactions;
    expect(sell).toMatchObject({
      side: "sell",
      hash: "0xsell",
      zigAmount: "4.778167863778748062",
      ethAmount: "0.000994",
      gasUsd: 0.14,
    });
    expect(buy).toMatchObject({ side: "buy", hash: "0xbuy" });

    await engine.stop();
    // A hash resolves to the wallet on any explorer, so it must not outlive the
    // credentials that the stop path purges.
    expect(engine.snapshot().recentTransactions).toEqual([]);
    engine.dispose();
    vi.useRealTimers();
  });

  it("keeps only the five newest transactions", async () => {
    vi.useFakeTimers();
    const executeSwap = vi.fn().mockImplementation(({ side }: { side: "buy" | "sell" }) =>
      Promise.resolve({
        side,
        hash: `0x${side}${executeSwap.mock.calls.length}`,
        soldRaw: "1000000000000000",
        receivedRaw: "1000000000000000",
        gasUsd: 0.1,
      }),
    );
    const engine = createLiveEngine(executeSwap);
    await engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) });
    await engine.start();

    await vi.advanceTimersByTimeAsync(0);
    for (let leg = 0; leg < 6; leg += 1) await vi.advanceTimersByTimeAsync(30_000);
    expect(executeSwap.mock.calls.length).toBe(7);

    const recent = engine.snapshot().recentTransactions;
    expect(recent).toHaveLength(5);
    expect(recent.map((tx) => tx.hash)).toEqual(["0xbuy7", "0xsell6", "0xbuy5", "0xsell4", "0xbuy3"]);
    engine.dispose();
    vi.useRealTimers();
  });

  it("records a confirmed swap even when the trader omits an amount field", async () => {
    vi.useFakeTimers();
    // The buy leg must still lock its sell and keep running; display formatting
    // is never allowed to abort a cycle that already holds a position.
    const executeSwap = vi.fn()
      .mockResolvedValueOnce({ side: "buy", hash: "0xbuy", receivedRaw: "500", gasUsd: 0.1 })
      .mockResolvedValueOnce({ side: "sell", hash: "0xsell", soldRaw: "500", receivedRaw: "900", gasUsd: 0.1 });
    const engine = createLiveEngine(executeSwap);
    await engine.configureWallet({ walletAddress: address, privateKey: "1".repeat(64) });
    await engine.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(engine.snapshot().recentTransactions).toMatchObject([
      { side: "buy", hash: "0xbuy", ethAmount: "0.0" },
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(executeSwap.mock.calls.map(([input]) => input.side)).toEqual(["buy", "sell"]);
    expect(engine.snapshot().status).not.toBe("error");
    engine.dispose();
    vi.useRealTimers();
  });
});
