import app from "./app";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";
import { startWorker, stopWorker } from "./lib/worker";
import { assertCustodyConfiguration } from "./lib/custody-crypto";

const rawPort = process.env["PORT"];

assertCustodyConfiguration();

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startWorker();
});

// Graceful shutdown: stop accepting connections, drain the DB pool, then
// exit. A hard timeout guarantees the process never hangs on shutdown.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  const forceExit = setTimeout(() => process.exit(1), 8_000);
  forceExit.unref();
  const serverClosed = new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) logger.warn({ err }, "Error while closing HTTP server");
      resolve();
    });
  });
  void Promise.all([
    serverClosed,
    stopWorker().catch((err) => logger.warn({ err }, "Error while stopping worker")),
  ])
    .then(() => pool.end())
    .catch((err) => logger.warn({ err }, "Error while draining database pool"))
    .finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
