export const BOT_STATUSES = [
  "running",
  "waiting_for_gas",
  "waiting_for_confirmation",
  "processing",
  "stopped",
  "error",
] as const;

export type BotStatus = (typeof BOT_STATUSES)[number];
export type LogLevel = "info" | "warning" | "error" | "success";
export type TradeSide = "buy" | "sell";

export interface AutomationSettings {
  intervalSeconds: number;
  gasThresholdUsd: number;
  slippageBps: number;
  maxPriceImpactBps: number;
  tradeAmountEth: string;
  minimumBalanceUsd: number;
  maxConsecutiveFailures: number;
  walletAddress: string | null;
}

export interface BotStatistics {
  totalCycles: number;
  successfulSwaps: number;
  failedSwaps: number;
  currentCycle: number;
  startedAt: string | null;
  runtimeSeconds: number;
  ethBalance: string;
  zigBalance: string;
  totalGasUsd: number;
  averageGasUsd: number;
  totalVolumeUsd: number;
  lastTradeAt: string | null;
  currentGasUsd: number | null;
  nextExecutionAt: string | null;
  totalTransactions: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

export interface RpcHealth {
  url: string;
  healthy: boolean;
  latencyMs: number | null;
  blockNumber: number | null;
  failures: number;
  lastCheckedAt: string | null;
  active: boolean;
}

export interface BotSnapshot {
  status: BotStatus;
  statusMessage: string;
  settings: AutomationSettings;
  statistics: BotStatistics;
  logs: LogEntry[];
  rpcHealth: RpcHealth[];
  executionMode: "paper" | "live";
  signerConfigured: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  suggestedAction: string;
  retryable: boolean;
  requestId?: string;
}

export interface WalletBalances {
  walletAddress: string;
  eth: string;
  zig: string;
  updatedAt: string;
}

export const DEFAULT_SETTINGS: AutomationSettings = {
  intervalSeconds: 30,
  gasThresholdUsd: 1,
  slippageBps: 100,
  maxPriceImpactBps: 300,
  tradeAmountEth: "0.001",
  minimumBalanceUsd: 10,
  maxConsecutiveFailures: 3,
  walletAddress: null,
};
