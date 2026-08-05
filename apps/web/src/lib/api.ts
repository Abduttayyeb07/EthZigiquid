import type { ApiError, AutomationSettings, BotSnapshot, WalletBalances } from "@zig/shared";

export interface BuySimulation {
  amountInEth: string;
  amountInUsd: number;
  ethUsd: number;
  estimatedZig: string;
  impliedZigUsd: number;
  minimumZig: string;
  slippageBps: number;
}

function resolveApiUrl() {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (typeof window !== "undefined") {
    if (configured) {
      const configuredUrl = new URL(configured);
      const pageIsLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
      const apiIsLocalhost = ["localhost", "127.0.0.1"].includes(configuredUrl.hostname);
      if (apiIsLocalhost && !pageIsLocalhost) {
        configuredUrl.hostname = window.location.hostname;
      }
      return configuredUrl.toString().replace(/\/$/, "");
    }
    return `${window.location.protocol}//${window.location.hostname}:4000`;
  }
  return configured || "http://127.0.0.1:4000";
}

export function getApiUrl() {
  return resolveApiUrl();
}

const TOKEN_KEY = "zig-control-token";

export function hasControlToken() {
  return typeof window !== "undefined" && Boolean(sessionStorage.getItem(TOKEN_KEY));
}

export function setControlToken(token: string) {
  if (typeof window !== "undefined") sessionStorage.setItem(TOKEN_KEY, token.trim());
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const hasBody = init?.body !== undefined && init.body !== null;
  try {
    response = await fetch(`${getApiUrl()}${path}`, {
      ...init,
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(typeof window !== "undefined" && sessionStorage.getItem(TOKEN_KEY)
          ? { Authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY)}` }
          : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error(`Could not reach the backend API at ${getApiUrl()}.`);
  }
  if (!response.ok) {
    let error: ApiError | null = null;
    try {
      error = (await response.json()) as ApiError;
    } catch {
      // Fall back to the HTTP status when the backend did not return JSON.
    }
    if (error?.message) {
      throw new Error(`${error.message}${error.suggestedAction ? ` ${error.suggestedAction}` : ""}`);
    }
    throw new Error(`Backend request failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  state: () => request<BotSnapshot>("/api/v1/state"),
  start: () => request<BotSnapshot>("/api/v1/automation/start", { method: "POST" }),
  stop: () => request<BotSnapshot>("/api/v1/automation/stop", { method: "POST" }),
  connectWallet: (input: { walletAddress: string; privateKey: string }) =>
    request<BotSnapshot>("/api/v1/wallet/connect", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  balances: (walletAddress: string) =>
    request<WalletBalances>("/api/v1/wallet/balances", {
      method: "POST",
      body: JSON.stringify({ walletAddress }),
    }),
  simulateBuy: (input: { amountEth: string; slippageBps?: number }) =>
    request<BuySimulation>("/api/v1/quote/buy", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  settings: (patch: Partial<AutomationSettings>) =>
    request<BotSnapshot>("/api/v1/settings", { method: "PATCH", body: JSON.stringify(patch) }),
};
