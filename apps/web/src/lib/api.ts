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
const SESSION_KEY = "zig-operator-session";

export function hasControlToken() {
  return typeof window !== "undefined" && Boolean(sessionStorage.getItem(TOKEN_KEY));
}

export function setControlToken(token: string) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(TOKEN_KEY, token.trim());
  // Sessions are signed against a specific token, so a token change invalidates
  // any session already stored for this browser.
  localStorage.removeItem(SESSION_KEY);
}

export function clearControlToken() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
}

function authHeader() {
  if (typeof window === "undefined") return {};
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

let pendingSession: Promise<string> | null = null;

async function requestSession(): Promise<string> {
  const response = await fetch(`${getApiUrl()}/api/v1/session`, {
    method: "POST",
    headers: authHeader(),
  });
  if (!response.ok) throw new Error("The operator access token was rejected.");
  const { session } = (await response.json()) as { session: string };
  localStorage.setItem(SESSION_KEY, session);
  return session;
}

/**
 * The session id is issued and signed by the server. The browser can no longer
 * invent one, which is what stops a token holder from naming another operator's
 * session and taking over their wallet.
 */
async function ensureSession(): Promise<string> {
  if (typeof window === "undefined") return "";
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  pendingSession ??= requestSession().finally(() => {
    pendingSession = null;
  });
  return pendingSession;
}

async function request<T>(path: string, init?: RequestInit, allowReissue = true): Promise<T> {
  let response: Response;
  const hasBody = init?.body !== undefined && init.body !== null;
  const session = await ensureSession();
  try {
    response = await fetch(`${getApiUrl()}${path}`, {
      ...init,
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...authHeader(),
        ...(session ? { "X-Operator-Session": session } : {}),
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
    // A rotated signing key or a server restart retires existing sessions.
    // Re-issue once so the operator is not forced to re-enter the token.
    if (allowReissue && response.status === 401 && error?.code === "SESSION_INVALID") {
      localStorage.removeItem(SESSION_KEY);
      return request<T>(path, init, false);
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
  clearWallet: () => request<BotSnapshot>("/api/v1/wallet/clear", { method: "POST" }),
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
