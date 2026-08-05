import { randomUUID, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance } from "fastify";
import { Registry, collectDefaultMetrics, Counter, Gauge } from "prom-client";
import { z } from "zod";
import type { AutomationSettings } from "@zig/shared";
import { config } from "./config.js";
import { AppError, normalizeError } from "./lib/errors.js";
import { AutomationEngine } from "./services/automation-engine.js";
import { GasService } from "./services/gas-service.js";
import { LiveTrader } from "./services/live-trader.js";
import { RpcManager } from "./services/rpc-manager.js";
import { RuntimeStateStore } from "./state/runtime-state-store.js";

const settingsSchema = z
  .object({
    intervalSeconds: z.number().int().min(5).max(86_400).optional(),
    gasThresholdUsd: z.number().min(0.05).max(500).optional(),
    slippageBps: z.number().int().min(1).max(2_000).optional(),
    maxPriceImpactBps: z.number().int().min(1).max(5_000).optional(),
    tradeAmountEth: z.string().regex(/^\d+(\.\d{1,18})?$/).optional(),
    minimumBalanceUsd: z.number().min(1).max(1_000_000).optional(),
    maxConsecutiveFailures: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export interface AppContext {
  app: FastifyInstance;
  engine: AutomationEngine;
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

export async function buildApp(overrides?: {
  engine?: AutomationEngine;
  rpc?: RpcManager;
}): Promise<AppContext> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers['x-api-key']"],
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
    allowedHeaders: ["authorization", "content-type"],
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
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/")) return;
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const expected = config.CONTROL_API_TOKEN;
    const valid = supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!valid) {
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "A valid operator access token is required.",
        suggestedAction: "Enter the deployment control token.",
        retryable: false,
      });
    }
  });

  const rpc = overrides?.rpc ?? new RpcManager(config.rpcHttpUrls);
  const gas = new GasService(rpc);
  const trader = new LiveTrader(
    rpc,
    gas,
    config.ZIG_TOKEN_ADDRESS,
    config.UNISWAP_V2_ROUTER_ADDRESS,
    config.WETH_ADDRESS,
  );
  const stateStore = config.persistRuntimeState
    ? new RuntimeStateStore(config.DATABASE_URL, config.STATE_ENCRYPTION_KEY)
    : undefined;
  if (stateStore) await stateStore.initialize();
  const engine = overrides?.engine ?? new AutomationEngine(gas, rpc, config.EXECUTION_MODE, trader, stateStore);
  await engine.initialize();

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
    botStatusGauge.set(["stopped", "error"].includes(engine.snapshot().status) ? 0 : 1);
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  app.get("/api/v1/state", async () => engine.snapshot());

  app.post("/api/v1/wallet/connect", async (request) => {
    const input = z
      .object({
        walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        privateKey: z.string().regex(/^(0x)?[a-fA-F0-9]{64}$/),
      })
      .strict()
      .parse(request.body);
    return engine.configureWallet(input);
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
        amountEth: z.string().regex(/^\d+(\.\d{1,18})?$/),
        slippageBps: z.number().int().min(1).max(2_000).optional(),
      })
      .strict()
      .parse(request.body);
    return trader.simulateBuy(input.amountEth, input.slippageBps ?? engine.snapshot().settings.slippageBps);
  });

  app.get("/api/v1/events", async (request, reply) => {
    const requestOrigin = request.headers.origin;
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

  app.post("/api/v1/automation/start", async () => {
    try {
      const result = await engine.start();
      actionCounter.inc({ action: "start", result: "success" });
      return result;
    } catch (error) {
      actionCounter.inc({ action: "start", result: "error" });
      throw error;
    }
  });

  app.post("/api/v1/automation/stop", async () => {
    actionCounter.inc({ action: "stop", result: "success" });
    return engine.stop();
  });

  app.patch("/api/v1/settings", async (request) => {
    const patch = settingsSchema.parse(request.body) as Partial<AutomationSettings>;
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
    engine.dispose();
    await stateStore?.close();
    rpc.destroy();
  });

  return { app, engine, rpc };
}
