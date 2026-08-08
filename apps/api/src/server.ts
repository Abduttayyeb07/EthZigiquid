import { buildApp } from "./app.js";
import { config } from "./config.js";

const { app, operators, rpc } = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Graceful shutdown started");
  for (const { engine } of operators.values()) {
    await engine.shutdown(`Service stopping (${signal}); automation will resume after restart`);
  }
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info({ port: config.PORT, mode: config.EXECUTION_MODE }, "ZIG automation API listening");
  setInterval(() => void rpc.healthCheck(), 30_000).unref();
  void rpc.healthCheck();
} catch (error) {
  app.log.fatal(error);
  process.exit(1);
}
