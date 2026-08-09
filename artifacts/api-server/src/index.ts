import app from "./app";
import { logger } from "./lib/logger";
import { ensureBrowserUseRunning } from "./lib/browser-use-spawner";

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

// Start the browser-use Python microservice in the background.
// This is a no-op if BROWSER_USE_URL points to an external host,
// or if the service is already running.
ensureBrowserUseRunning().catch((err) => {
  logger.error({ err }, "browser-use: failed to spawn service");
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
