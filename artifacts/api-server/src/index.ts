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

// Resolve and set QF_CHROME_PATH so the queryfirst/nlp-runner routes can launch Chrome.
// Try multiple strategies so both dev (workspace cache) and prod (fresh Cloud Run instance) work.
if (!process.env["QF_CHROME_PATH"]) {
  try {
    // Strategy 1: Node.js playwright knows its own bundled Chromium path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require("playwright") as typeof import("playwright");
    const execPath = chromium.executablePath();
    if (execPath && existsSync(execPath)) {
      process.env["QF_CHROME_PATH"] = execPath;
      logger.info({ execPath }, "QF_CHROME_PATH resolved from playwright (Node.js)");
    } else {
      // Strategy 2: Python playwright (used by browser-use) downloads to a known location.
      // Try the most common Python playwright Chromium build numbers on Linux.
      const { join } = require("path") as typeof import("path");
      const pythonPlaywrightRoots = [
        join(process.env["HOME"] ?? "", ".cache", "ms-playwright"),
        "/home/runner/workspace/.cache/ms-playwright",
        "/root/.cache/ms-playwright",
      ];
      let found = "";
      for (const root of pythonPlaywrightRoots) {
        // Check known build dirs (sorted newest-first)
        for (const build of ["chromium-1187", "chromium-1179", "chromium-1169"]) {
          for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
            const candidate = join(root, build, sub);
            if (existsSync(candidate)) { found = candidate; break; }
          }
          if (found) break;
        }
        if (found) break;
      }
      if (found) {
        process.env["QF_CHROME_PATH"] = found;
        logger.info({ execPath: found }, "QF_CHROME_PATH resolved from Python playwright cache");
      } else {
        logger.warn({ tried: execPath }, "No Chrome binary found yet — queryfirst will retry on each request until Chrome is downloaded");
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "Could not resolve QF_CHROME_PATH from playwright");
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
