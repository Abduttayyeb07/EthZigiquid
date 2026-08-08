import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { Registry, collectDefaultMetrics, Counter, Gauge } from "prom-client";
import { z } from "zod";
import type { AutomationSettings } from "@zig/shared";
import { config } from "./config.js";
import { AppError, normalizeError } from "./lib/errors.js";
import { AutomationEngine } from "./services/automation-engine.js";
import { GasService } from "./services/gas-service.js";
import { LiveTrader } from "./services/live-trader.js";
import { RpcManager } from "./services/rpc-manager.js";
import { RuntimeStateStore, initializeRuntimeStateSchema } from "./state/runtime-state-store.js";

declare module "fastify" {
  interface FastifyRequest {
    operatorId?: string;
    tokenId?: string;
  }
}

const SESSION_ISSUE_PATH = "/api/v1/session";
const SESSION_RUNTIME_PREFIX = "session:";
const OPERATOR_IDLE_TTL_MS = 30 * 60_000;
const OPERATOR_SWEEP_INTERVAL_MS = 5 * 60_000;
const MAX_ACTIVE_OPERATORS = 64;

const sessionIdSchema = z.string().regex(/^[a-fA-F0-9-]{16,80}$/);
const positiveEthAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/)
  .refine((value) => value.replace(".", "").replace(/^0+/, "").length > 0, {
    message: "Trade amount must be greater than zero.",
  });

// Domain-separated from the state-encryption key so the signing key cannot be
// interchanged with the key that protects persisted wallet credentials.
const sessionSigningKey = Buffer.from(
  hkdfSync(
    "sha256",
    Buffer.from(config.STATE_ENCRYPTION_KEY, "hex"),
    Buffer.alloc(0),
    "zig-operator-session-v1",
    32,
  ),
);

interface OperatorRuntime {
  engine: AutomationEngine;
  lastSeenAt: number;
  pinned: boolean;
}

const settingsSchema = z
  .object({
    intervalSeconds: z.number().int().min(5).max(86_400).optional(),
    gasThresholdUsd: z.number().min(0.05).max(500).optional(),
    slippageBps: z.number().int().min(1).max(2_000).optional(),
    maxPriceImpactBps: z.number().int().min(1).max(5_000).optional(),
    tradeAmountEth: positiveEthAmountSchema.optional(),
    minimumBalanceUsd: z.number().min(1).max(1_000_000).optional(),
    maxConsecutiveFailures: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export interface AppContext {
  app: FastifyInstance;
  engine: AutomationEngine;
  operators: Map<string, OperatorRuntime>;
  rpc: RpcManager;
}

function isPrivateDevelopmentOrigin(origin: string) {
  if (config.NODE_ENV !== "development") return false;
  try {
    const url = new URL(origin);
    const privateIpv4 =
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(url.hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
    return url.protocol === "http:" && url.port === "3000" &&
      (["localhost", "127.0.0.1"].includes(url.hostname) || privateIpv4);
  } catch {
    return false;
  }
}

function allowedBrowserOrigin(origin?: string) {
  if (!origin) return false;
  return origin === config.WEB_ORIGIN || isPrivateDevelopmentOrigin(origin);
}

function configuredOperatorTokens() {
  return config.CONTROL_API_TOKEN
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function operatorIdFromToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenHash(supplied: string) {
  for (const expected of configuredOperatorTokens()) {
    const valid =
      supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (valid) return operatorIdFromToken(expected);
  }
  return null;
}

function operatorIdForSession(tokenId: string, sessionId: string) {
  return `${SESSION_RUNTIME_PREFIX}${createHash("sha256").update(`${tokenId}:${sessionId}`).digest("hex")}`;
}

function signSession(tokenId: string, sessionId: string) {
  return createHmac("sha256", sessionSigningKey).update(`${tokenId}:${sessionId}`).digest("base64url");
}

function issueSession(tokenId: string) {
  const sessionId = randomUUID();
  return `${sessionId}.${signSession(tokenId, sessionId)}`;
}

/**
 * Returns the session id only when this server signed it for this exact token.
 * A client-asserted session id is never trusted: without this check any holder
 * of the shared access token could name another operator's session and take
 * over that operator's wallet, automation, and logs.
 */
function verifySignedSession(tokenId: string, value: string): string | null {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const sessionId = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!sessionIdSchema.safeParse(sessionId).success) return null;
  const expected = signSession(tokenId, sessionId);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return sessionId;
}

export async function buildApp(overrides?: {
  engine?: AutomationEngine;
  rpc?: RpcManager;
}): Promise<AppContext> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // A signed session grants full control of one operator's wallet, so it is
      // a credential and must never reach disk in plaintext.
      redact: [
        "req.headers.authorization",
        "req.headers['x-api-key']",
        "req.headers['x-operator-session']",
      ],
    },
    genReqId: () => randomUUID(),
    // Enable only when requests arrive through a trusted reverse proxy.
    // Direct public deployments must not trust spoofable forwarding headers.
    trustProxy: config.trustProxy,
    bodyLimit: 32 * 1024,
  });

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    methods: ["GET", "HEAD", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-operator-session"],
    origin: (origin, callback) => {
      if (!origin || allowedBrowserOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"), false);
    },
    credentials: true,
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  const rpc = overrides?.rpc ?? new RpcManager(config.rpcHttpUrls);
  const gas = new GasService(rpc);
  const trader = new LiveTrader(
    rpc,
    gas,
    config.ZIG_TOKEN_ADDRESS,
    config.UNISWAP_V2_ROUTER_ADDRESS,
    config.WETH_ADDRESS,
  );
  const operators = new Map<string, OperatorRuntime>();

  // One pool for every operator session. Per-session pools multiply PostgreSQL
  // connections by the number of browsers that have ever connected.
  const statePool = config.persistRuntimeState
    ? new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 })
    : undefined;
  if (statePool) await initializeRuntimeStateSchema(statePool);

  /**
   * Drops operator runtimes that are idle and hold no unfinished position.
   * Engines that are running, mid-cycle, or holding a locked sell leg are never
   * evicted; abandoning one would leave real funds committed with no owner.
   */
  const sweepIdleOperators = () => {
    const cutoff = Date.now() - OPERATOR_IDLE_TTL_MS;
    for (const [operatorId, runtime] of operators) {
      if (runtime.pinned || runtime.lastSeenAt > cutoff) continue;
      if (!runtime.engine.isEvictable()) continue;
      runtime.engine.dispose();
      operators.delete(operatorId);
      app.log.info({ operator: operatorId.slice(0, 12) }, "Reclaimed idle operator session");
    }
  };

  const createEngine = async (operatorId: string, pinned: boolean) => {
    if (operators.size >= MAX_ACTIVE_OPERATORS) {
      sweepIdleOperators();
      if (operators.size >= MAX_ACTIVE_OPERATORS) {
        throw new AppError("CAPACITY_EXCEEDED", undefined, 503);
      }
    }
    const stateStore = statePool
      ? new RuntimeStateStore(statePool, config.STATE_ENCRYPTION_KEY, operatorId)
      : undefined;
    const engine = new AutomationEngine(gas, rpc, config.EXECUTION_MODE, trader, stateStore);
    await engine.initialize();
    operators.set(operatorId, { engine, lastSeenAt: Date.now(), pinned });
    return engine;
  };

  const engineForOperator = async (operatorId: string, pinned = false) => {
    const existing = operators.get(operatorId);
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing.engine;
    }
    return createEngine(operatorId, pinned);
  };

  const engineForRequest = async (request: { operatorId?: string }) => {
    if (overrides?.engine) return overrides.engine;
    if (!request.operatorId) throw new AppError("SESSION_INVALID", undefined, 401);
    return engineForOperator(request.operatorId);
  };

  if (statePool && !overrides?.engine) {
    const bootstrapStore = new RuntimeStateStore(
      statePool,
      config.STATE_ENCRYPTION_KEY,
      `${SESSION_RUNTIME_PREFIX}bootstrap`,
    );
    const runtimeIds = await bootstrapStore.listIds(SESSION_RUNTIME_PREFIX);
    for (const runtimeId of runtimeIds) {
      await engineForOperator(runtimeId, true);
    }
  }

  const defaultEngine =
    overrides?.engine ?? new AutomationEngine(gas, rpc, config.EXECUTION_MODE, trader);

  const sweepTimer = setInterval(sweepIdleOperators, OPERATOR_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/")) return;
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const tokenId = tokenHash(supplied);
    if (!tokenId) {
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "A valid operator access token is required.",
        suggestedAction: "Enter the deployment control token.",
        retryable: false,
      });
    }
    request.tokenId = tokenId;
    // Session issuance authenticates with the token alone; it is what hands out
    // the signed session that every other route requires.
    if (request.url.split("?")[0] === SESSION_ISSUE_PATH) return;

    const sessionHeader = request.headers["x-operator-session"];
    const rawSession = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const sessionId = rawSession ? verifySignedSession(tokenId, rawSession) : null;
    if (!sessionId) {
      return reply.code(401).send({
        code: "SESSION_INVALID",
        message: "A session signed by this server is required.",
        suggestedAction: "Request a new operator session; the dashboard does this automatically.",
        retryable: false,
      });
    }
    request.operatorId = operatorIdForSession(tokenId, sessionId);
  });

  app.post(SESSION_ISSUE_PATH, async (request) => {
    if (!request.tokenId) throw new AppError("SESSION_INVALID", undefined, 401);
    return { session: issueSession(request.tokenId) };
  });

  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "zig_" });
  const actionCounter = new Counter({
    name: "zig_api_actions_total",
    help: "Automation API actions",
    labelNames: ["action", "result"],
    registers: [registry],
  });
  const botStatusGauge = new Gauge({
    name: "zig_bot_running",
    help: "Whether the automation state machine is active",
    registers: [registry],
  });
  const operatorGauge = new Gauge({
    name: "zig_operator_sessions",
    help: "Operator sessions currently held in memory",
    registers: [registry],
  });

  app.get("/health", async () => ({
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    version: "0.1.0",
    executionMode: config.EXECUTION_MODE,
    timestamp: new Date().toISOString(),
  }));

  app.get("/ready", async (_request, reply) => {
    const health = await rpc.healthCheck();
    const ready = health.some((node) => node.healthy);
    return reply.code(ready ? 200 : 503).send({ ready, rpc: health });
  });

  app.get("/metrics", async (_request, reply) => {
    const anyRunning = [...operators.values()].some(
      ({ engine }) => !["stopped", "error"].includes(engine.snapshot().status),
    );
    botStatusGauge.set(anyRunning ? 1 : 0);
    operatorGauge.set(operators.size);
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  app.get("/api/v1/state", async (request) => (await engineForRequest(request)).snapshot());

  app.post("/api/v1/wallet/connect", async (request) => {
    const input = z
      .object({
        walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        privateKey: z.string().regex(/^(0x)?[a-fA-F0-9]{64}$/),
      })
      .strict()
      .parse(request.body);
    return (await engineForRequest(request)).configureWallet(input);
  });

  app.post("/api/v1/wallet/balances", async (request) => {
    const input = z
      .object({
        walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      })
      .strict()
      .parse(request.body);
    const balances = await trader.getBalances(input.walletAddress);
    return {
      walletAddress: balances.walletAddress,
      eth: balances.eth,
      zig: balances.zig,
      updatedAt: balances.updatedAt,
    };
  });

  app.post("/api/v1/quote/buy", async (request) => {
    const input = z
      .object({
        amountEth: positiveEthAmountSchema,
        slippageBps: z.number().int().min(1).max(2_000).optional(),
      })
      .strict()
      .parse(request.body);
    const engine = await engineForRequest(request);
    return trader.simulateBuy(input.amountEth, input.slippageBps ?? engine.snapshot().settings.slippageBps);
  });

  app.get("/api/v1/events", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    const engine = await engineForRequest(request);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(requestOrigin && allowedBrowserOrigin(requestOrigin)
        ? { "Access-Control-Allow-Origin": requestOrigin }
        : {}),
    });
    const send = (snapshot: ReturnType<typeof engine.snapshot>) => {
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };
    send(engine.snapshot());
    const unsubscribe = engine.subscribe(send);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post("/api/v1/automation/start", async (request) => {
    try {
      const engine = await engineForRequest(request);
      const result = await engine.start();
      actionCounter.inc({ action: "start", result: "success" });
      return result;
    } catch (error) {
      actionCounter.inc({ action: "start", result: "error" });
      throw error;
    }
  });

  app.post("/api/v1/automation/stop", async (request) => {
    actionCounter.inc({ action: "stop", result: "success" });
    const engine = await engineForRequest(request);
    return engine.stop();
  });

  app.post("/api/v1/wallet/clear", async (request) => {
    actionCounter.inc({ action: "clear_wallet", result: "success" });
    const engine = await engineForRequest(request);
    return engine.clearWallet();
  });

  app.patch("/api/v1/settings", async (request) => {
    const patch = settingsSchema.parse(request.body) as Partial<AutomationSettings>;
    const engine = await engineForRequest(request);
    return engine.updateSettings(patch);
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized =
      error instanceof z.ZodError
        ? new AppError("INVALID_REQUEST", error.issues.map((issue) => issue.message).join("; "), 400)
        : normalizeError(error);
    request.log.error({ err: error, code: normalized.code }, normalized.message);
    void reply.code(normalized.statusCode).send({
      code: normalized.code,
      message: normalized.message,
      suggestedAction: normalized.suggestedAction,
      retryable: normalized.retryable,
      requestId: request.id,
    });
  });

  app.addHook("onClose", async () => {
    clearInterval(sweepTimer);
    for (const { engine } of operators.values()) engine.dispose();
    await statePool?.end();
    rpc.destroy();
  });

  return { app, engine: defaultEngine, operators, rpc };
}
