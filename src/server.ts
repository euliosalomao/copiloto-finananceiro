import "dotenv/config";
import { buildApp } from "./app.js";
import { loadServerConfig } from "./config/serverConfig.js";

const config = loadServerConfig();
const app = buildApp({
  n8nApiToken: config.N8N_API_TOKEN,
  logLevel: config.LOG_LEVEL,
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "Graceful shutdown started");
  await app.close();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    { host: config.HOST, port: config.PORT },
    "Copiloto Financeiro backend ready",
  );
} catch (error) {
  app.log.fatal({ error }, "Backend startup failed");
  process.exitCode = 1;
}
