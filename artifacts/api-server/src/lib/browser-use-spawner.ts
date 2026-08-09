import { spawn } from "child_process";
import path from "path";
import { logger } from "./logger";

const BROWSER_USE_PORT = 8001;
const BROWSER_USE_URL = process.env.BROWSER_USE_URL ?? `http://localhost:${BROWSER_USE_PORT}`;

// Cached health state — re-checked every CACHE_TTL_MS so we never block on a stale flag.
const CACHE_TTL_MS = 20_000; // re-check every 20 seconds at most
let _cachedReady: boolean | null = null;
let _cacheExpiry = 0;
let _externalService = false;

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

/** Live health check — result is cached for CACHE_TTL_MS to keep latency low. */
export async function isBrowserUseReady(): Promise<boolean> {
  // External service: treat as always ready (let the first real request surface errors).
  if (_externalService) return true;

  const now = Date.now();
  if (_cachedReady !== null && now < _cacheExpiry) {
    return _cachedReady;
  }

  try {
    const res = await fetch(`http://localhost:${BROWSER_USE_PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    _cachedReady = res.ok;
  } catch {
    _cachedReady = false;
  }
  _cacheExpiry = Date.now() + CACHE_TTL_MS;
  return _cachedReady ?? false;
}

/**
 * Spawns the browser-use Python microservice in the background when
 * BROWSER_USE_URL points at localhost. Returns immediately — health is
 * tracked via isBrowserUseReady() polling instead of a blocking wait.
 */
export async function ensureBrowserUseRunning(): Promise<void> {
  if (!isLocalBrowserUse()) {
    _externalService = true;
    logger.info({ url: BROWSER_USE_URL }, "browser-use: using external service, skipping spawn");
    return;
  }

  // If already healthy, nothing to do.
  try {
    const res = await fetch(`http://localhost:${BROWSER_USE_PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      _cachedReady = true;
      _cacheExpiry = Date.now() + CACHE_TTL_MS;
      logger.info("browser-use: already running, skipping spawn");
      return;
    }
  } catch {
    // not running yet — fall through to spawn
  }

  // Resolve the workspace root.
  // Production dist is at: <workspace>/artifacts/api-server/dist/index.mjs
  // __dirname = <workspace>/artifacts/api-server/dist  →  3 levels up = workspace root
  const workspaceRoot = path.resolve(__dirname, "../../../");
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

  child.on("error", (err) => {
    // Must handle this event — unhandled 'error' events crash the Node.js process.
    logger.error({ err }, "browser-use: failed to spawn process");
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
    // Clear the cache so the next readiness check detects the outage.
    _cachedReady = false;
    _cacheExpiry = 0;
  });

  // Log a warning if the service takes a very long time (informational only —
  // isBrowserUseReady() will catch it whenever it actually comes up).
  const warnTimer = setTimeout(() => {
    logger.warn("browser-use: service has not become healthy after 10 min — check logs above");
  }, 600_000);
  // Don't let this timer keep the process alive.
  if (typeof warnTimer === "object" && warnTimer !== null && "unref" in warnTimer) {
    (warnTimer as NodeJS.Timeout).unref();
  }

  logger.info("browser-use: service spawned — readiness will be detected automatically via health checks");
}
