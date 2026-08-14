import { existsSync } from "node:fs";
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

// Point the queryfirst/nlp-runner routes at the system Chromium installed via Nix (pkgs.chromium).
// This binary is always present — no download needed. Falls back to playwright's bundled binary
// if for some reason the system one is missing.
if (!process.env["QF_CHROME_PATH"]) {
  // Primary: system Chromium from Nix (installed via replit.nix pkgs.chromium)
  const { execSync } = require("child_process") as typeof import("child_process");
  let systemChrome = "";
  try {
    systemChrome = execSync("which chromium", { encoding: "utf8" }).trim();
  } catch { /* not found */ }

  if (systemChrome && existsSync(systemChrome)) {
    process.env["QF_CHROME_PATH"] = systemChrome;
    logger.info({ execPath: systemChrome }, "QF_CHROME_PATH resolved from system Nix Chromium");
  } else {
    // Fallback: Node.js playwright's bundled Chromium
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { chromium } = require("playwright") as typeof import("playwright");
      const execPath = chromium.executablePath();
      if (execPath && existsSync(execPath)) {
        process.env["QF_CHROME_PATH"] = execPath;
        logger.info({ execPath }, "QF_CHROME_PATH resolved from playwright (fallback)");
      } else {
        logger.warn("No Chrome binary found — queryfirst Chrome launch will fail until Chrome is available");
      }
    } catch (e) {
      logger.warn({ err: e }, "Could not resolve QF_CHROME_PATH");
    }
  }
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
