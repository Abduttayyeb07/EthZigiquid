import { buildApp } from "./app.js";
import { config } from "./config.js";

const { app, engine } = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Graceful shutdown started");
  await engine.shutdown(`Service stopping (${signal}); automation will resume after restart`);
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info({ port: config.PORT, mode: config.EXECUTION_MODE }, "ZIG automation API listening");
  setInterval(() => void engine.refreshHealth(), 30_000).unref();
  void engine.refreshHealth();
} catch (error) {
  app.log.fatal(error);
  process.exit(1);
}
