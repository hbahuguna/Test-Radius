import { spawn } from "child_process";
import path from "path";
import { logger } from "./logger";

const BROWSER_USE_PORT = 8001;
const BROWSER_USE_URL = process.env.BROWSER_USE_URL ?? `http://localhost:${BROWSER_USE_PORT}`;

/** Returns true if the configured BROWSER_USE_URL points at localhost — meaning
 *  we need to manage the Python service ourselves. */
function isLocalBrowserUse(): boolean {
  try {
    const url = new URL(BROWSER_USE_URL);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/** Poll the browser-use /health endpoint until it responds or we time out. */
async function waitForBrowserUse(timeoutMs = 120_000): Promise<boolean> {
  const healthUrl = `http://localhost:${BROWSER_USE_PORT}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Spawns the browser-use Python microservice in the background when
 * BROWSER_USE_URL points at localhost. Safe to call multiple times —
 * it checks the health endpoint first and skips if already running.
 */
export async function ensureBrowserUseRunning(): Promise<void> {
  if (!isLocalBrowserUse()) {
    logger.info({ url: BROWSER_USE_URL }, "browser-use: using external service, skipping spawn");
    return;
  }

  // If already healthy, nothing to do.
  try {
    const res = await fetch(`http://localhost:${BROWSER_USE_PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      logger.info("browser-use: already running, skipping spawn");
      return;
    }
  } catch {
    // not running yet — fall through to spawn
  }

  // Resolve the workspace root (two levels up from artifacts/api-server/src/lib/)
  const workspaceRoot = path.resolve(__dirname, "../../../../");
  const startScript = path.join(workspaceRoot, "artifacts/browser-use/start.sh");

  logger.info({ startScript }, "browser-use: spawning Python service...");

  const child = spawn("bash", [startScript], {
    cwd: path.join(workspaceRoot, "artifacts/browser-use"),
    env: {
      ...process.env,
      // Override PORT so the Python service doesn't inherit the main server's port
      BROWSER_USE_PORT: String(BROWSER_USE_PORT),
      PORT: undefined as unknown as string, // unset PORT so uvicorn doesn't pick it up
      PATH: `/home/runner/workspace/.pythonlibs/bin:${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) logger.info({ service: "browser-use" }, line);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) logger.warn({ service: "browser-use" }, line);
  });
  child.on("exit", (code, signal) => {
    logger.warn({ code, signal }, "browser-use: process exited");
  });

  logger.info("browser-use: waiting for service to become healthy (up to 120s)...");
  const ready = await waitForBrowserUse(120_000);
  if (ready) {
    logger.info("browser-use: service is healthy ✓");
  } else {
    logger.error("browser-use: service did not become healthy within 120s — agent runs will fail");
  }
}
