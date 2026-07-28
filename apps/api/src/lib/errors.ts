export type ErrorCode =
  | "RPC_UNAVAILABLE"
  | "TRANSACTION_TIMEOUT"
  | "SWAP_REVERTED"
  | "SLIPPAGE_EXCEEDED"
  | "INSUFFICIENT_ETH"
  | "INSUFFICIENT_ZIG"
  | "NONCE_CONFLICT"
  | "NETWORK_CONGESTION"
  | "WALLET_DISCONNECTED"
  | "PRICE_IMPACT_HIGH"
  | "LIQUIDITY_UNAVAILABLE"
  | "SIMULATION_INCOMPLETE"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR";

const guidance: Record<ErrorCode, { message: string; action: string; retryable: boolean }> = {
  RPC_UNAVAILABLE: {
    message: "All Ethereum RPC providers are currently unavailable.",
    action: "The service will retry and fail over automatically. Check provider status if this persists.",
    retryable: true,
  },
  TRANSACTION_TIMEOUT: {
    message: "The transaction was not confirmed before the timeout.",
    action: "Wait for the original transaction to settle before replacing it with the same nonce.",
    retryable: true,
  },
  SWAP_REVERTED: {
    message: "The swap was rejected by the EVM.",
    action: "Review the simulation result, allowance, route, and token behavior before retrying.",
    retryable: false,
  },
  SLIPPAGE_EXCEEDED: {
    message: "The market moved beyond the configured minimum output.",
    action: "Wait for liquidity to stabilize or deliberately adjust slippage.",
    retryable: true,
  },
  INSUFFICIENT_ETH: {
    message: "The wallet does not have enough ETH for the swap and its gas reserve.",
    action: "Fund the wallet or reduce the trade amount.",
    retryable: false,
  },
  INSUFFICIENT_ZIG: {
    message: "The wallet does not have enough ZIG for the sell leg.",
    action: "Reconcile the buy receipt and token balance before resuming.",
    retryable: false,
  },
  NONCE_CONFLICT: {
    message: "The wallet nonce conflicts with another pending transaction.",
    action: "The service will refresh the pending nonce and retry once.",
    retryable: true,
  },
  NETWORK_CONGESTION: {
    message: "Ethereum is congested and the transaction fee exceeds the configured limit.",
    action: "No transaction was submitted. Trading will resume when fees fall.",
    retryable: true,
  },
  WALLET_DISCONNECTED: {
    message: "No authorized wallet signer is connected.",
    action: "Reconnect the wallet and approve the requested transaction.",
    retryable: false,
  },
  PRICE_IMPACT_HIGH: {
    message: "The quoted trade would move the market beyond the configured price-impact limit.",
    action: "Reduce trade size or wait for deeper liquidity.",
    retryable: true,
  },
  LIQUIDITY_UNAVAILABLE: {
    message: "No safe route is currently available for ETH and ZIG.",
    action: "Wait for liquidity to return; verify the ZIG contract address.",
    retryable: true,
  },
  SIMULATION_INCOMPLETE: {
    message: "The aggregator could not fully simulate the proposed transaction.",
    action: "Do not submit until balance, allowance, and an independent eth_call simulation succeed.",
    retryable: false,
  },
  INVALID_REQUEST: {
    message: "The request contains invalid or unsafe values.",
    action: "Correct the highlighted fields and try again.",
    retryable: false,
  },
  INTERNAL_ERROR: {
    message: "An unexpected internal error occurred.",
    action: "Use the request ID to inspect structured server logs.",
    retryable: false,
  },
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly suggestedAction: string;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(code: ErrorCode, details?: string, statusCode = 500) {
    const entry = guidance[code];
    super(details ? `${entry.message} ${details}` : entry.message);
    this.name = "AppError";
    this.code = code;
    this.suggestedAction = entry.action;
    this.retryable = entry.retryable;
    this.statusCode = statusCode;
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const detail = error instanceof Error ? error.message : "Unknown error";
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (
    ["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "UNKNOWN_ERROR"].includes(code) ||
    /network|socket|timeout|timed out|fetch failed|connection|503|429/i.test(detail)
  ) {
    return new AppError("RPC_UNAVAILABLE", detail);
  }
  if (["NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED", "TRANSACTION_REPLACED"].includes(code)) {
    return new AppError("NONCE_CONFLICT", detail);
  }
  if (code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(detail)) {
    return new AppError("INSUFFICIENT_ETH", detail, 409);
  }
  return new AppError("INTERNAL_ERROR", detail);
}
