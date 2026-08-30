import app from "./app";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";
import { startWorker, stopWorker } from "./lib/worker";

const rawPort = process.env["PORT"];

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
  void stopWorker().catch(() => undefined);
  server.close(() => {
    void pool
      .end()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
