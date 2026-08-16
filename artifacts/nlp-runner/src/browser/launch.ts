import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { resolveChromePath } from "../config.js";
import { ChromePipe } from "./pipe.js";

export interface LaunchOptions {
  /** Path to a Chrome/Chromium binary. Defaults to QF_CHROME_PATH then auto-detection. */
  chromePath?: string;
  /** Launch headless (default) or with a visible window. */
  headless?: boolean;
  /**
   * Drive Chrome over the DevTools pipe (`--remote-debugging-pipe`) instead of
   * a TCP debug port. Some Chrome builds (e.g. Chrome for Testing on older
   * macOS) never expose a debug port; the pipe transport works everywhere.
   * The returned wsUrl is a local bridge that proxies the pipe framing.
   */
  pipe?: boolean;
  /** Debugging port; 0 lets Chrome pick a free port (default). */
  port?: number;
  /** How long to wait for the DevTools WebSocket URL before failing (ms). */
  timeoutMs?: number;
  /** Reuse a profile dir instead of creating a temp one (not deleted on close). */
  userDataDir?: string;
  /** Extra arguments appended after the defaults. */
  args?: string[];
  /** Extra environment variables merged over process.env. */
  env?: NodeJS.ProcessEnv;
  /** Viewport width in CSS pixels (default: 1280). */
  viewportWidth?: number;
  /** Viewport height in CSS pixels (default: 720). */
  viewportHeight?: number;
}

export interface LaunchedBrowser {
  /** `ws://127.0.0.1:PORT/devtools/browser/<id>` WebSocket URL. */
  wsUrl: string;
  pid: number;
  port: number;
  headless: boolean;
  /** Kill the browser and remove the temp profile dir. */
  close(): Promise<void>;
}

export class ChromeLaunchError extends Error {
  override name = "ChromeLaunchError";
}

export function parseDevToolsUrl(output: string): string | null {
  const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
  return match ? match[1] : null;
}

export function buildLaunchArgs(options: {
  headless: boolean;
  port: number;
  userDataDir: string;
  viewportWidth?: number;
  viewportHeight?: number;
  pipe?: boolean;
}): string[] {
  const vw = options.viewportWidth ?? 1280;
  const vh = options.viewportHeight ?? 720;
  return [
    ...(options.pipe
      ? ["--remote-debugging-pipe"]
      : [
          `--remote-debugging-port=${options.port}`,
          "--remote-debugging-address=127.0.0.1",
        ]),
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${vw},${vh}`,
    ...(options.headless
      ? ["--headless=new"]
      : [
          // Headful windows must not expose automation signals: Google blocks
          // sign-in ("this browser or app may not be secure") when the page
          // can read `navigator.webdriver` and friends.
          "--disable-blink-features=AutomationControlled",
        ]),
  ];
}

function chromeErrorMessage(chromePath: string, requested: string): string {
  return (
    `Failed to launch Chrome: no usable Chrome/Chromium binary (QF_CHROME_PATH="${requested}" -> "${chromePath}"). ` +
    `Install Chrome or point QF_CHROME_PATH at a valid binary.`
  );
}

function tail(stderr: string): string {
  return stderr.trim() || "(no output)";
}

async function closeBrowser(
  child: ChildProcess,
  ownsProfileDir: boolean,
  userDataDir: string,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const killer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 2000);
    killer.unref();
    await exited;
    clearTimeout(killer);
  }
  if (ownsProfileDir) {
    rmSync(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

export function launch(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  return new Promise((resolve, reject) => {
    const requested = options.chromePath ?? process.env.QF_CHROME_PATH ?? "auto";
    const chromePath = options.chromePath ?? resolveChromePath(requested);
    if (!chromePath || !existsSync(chromePath)) {
      reject(new ChromeLaunchError(chromeErrorMessage(chromePath, requested)));
      return;
    }

    const headless = options.headless ?? true;
    const port = options.port ?? 0;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const pipe = options.pipe ?? false;
    const ownsProfileDir = !options.userDataDir;
    const userDataDir =
      options.userDataDir ?? mkdtempSync(join(tmpdir(), "qf-chrome-"));

    let child: ChildProcess;
    try {
      child = spawn(
        chromePath,
        [
          ...buildLaunchArgs({ headless, port, userDataDir, viewportWidth: options.viewportWidth, viewportHeight: options.viewportHeight, pipe }),
          ...(options.args ?? []),
        ],
        { stdio: pipe ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], env: { ...process.env, ...options.env } },
      );
    } catch (err) {
      rmSync(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      const reason = err instanceof Error ? err.message : String(err);
      reject(
        new ChromeLaunchError(
          `Failed to launch Chrome at "${chromePath}": ${reason}`,
        ),
      );
      return;
    }

    let settled = false;
    let stderr = "";

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid !== undefined) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      rmSync(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      reject(new ChromeLaunchError(message));
    };

    const timer = setTimeout(() => {
      fail(
        `Failed to launch Chrome: timed out after ${timeoutMs}ms waiting for the DevTools WebSocket URL. stderr: ${tail(stderr)}`,
      );
    }, timeoutMs);
    timer.unref();

    if (pipe) {
      // Bridge Chrome's DevTools pipe (fd3 = commands in, fd4 = responses out)
      // to a local WebSocket so the ws-based CdpClient works unchanged. Frames
      // are proxied 1:1; the pipe protocol itself is null-terminated JSON.
      //
      // We wrap the WebSocketServer inside an HTTP Server to mock standard Chrome
      // metadata endpoints (/json/version, /json, /json/list). This ensures that any
      // downstream frameworks (such as browser-use or ShadowRecorder) that do
      // HTTP-based discovery work completely transparently.
      const server = createServer((req, res) => {
        if (req.url === "/json/version" || req.url === "/json" || req.url === "/json/list") {
          const addr = server.address();
          const port = typeof addr === "object" && addr !== null ? addr.port : 0;
          const wsUrl = `ws://127.0.0.1:${port}/devtools/browser/pipe`;
          res.writeHead(200, { "Content-Type": "application/json" });
          if (req.url === "/json/version") {
            res.end(JSON.stringify({
              "Browser": "Chrome/147.0.7727.15",
              "Protocol-Version": "1.3",
              "webSocketDebuggerUrl": wsUrl
            }));
          } else {
            res.end(JSON.stringify([{
              "description": "",
              "devtoolsFrontendUrl": `https://chrome-devtools-frontend.appspot.com/serve_file/@6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/inspector.html?ws=127.0.0.1:${port}/devtools/browser/pipe`,
              "id": "pipe",
              "title": "Chrome",
              "type": "browser",
              "webSocketDebuggerUrl": wsUrl
            }]));
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const wss = new WebSocketServer({ server });
      const clients = new Set<WebSocket>();
      const chromePipe = new ChromePipe(
        child.stdio[4] as unknown as import("node:stream").Readable,
        child.stdio[3] as unknown as import("node:stream").Writable,
        (text) => {
          for (const ws of [...clients]) {
            if (ws.readyState === WebSocket.OPEN) ws.send(text);
          }
        },
      );
      // Drain fd1/fd2 so Chrome never blocks on a full stderr/stdout pipe.
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        stderr = (stderr + chunk.toString("utf8")).slice(-4096);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (settled) return;
        stderr = (stderr + chunk.toString("utf8")).slice(-4096);
      });
      wss.on("connection", (ws) => {
        clients.add(ws);
        ws.on("message", (data) => {
          chromePipe.send(data.toString("utf8"));
        });
        ws.on("close", () => clients.delete(ws));
        ws.on("error", () => clients.delete(ws));
      });
      wss.on("error", (err) => {
        fail(
          `Failed to launch Chrome over the DevTools pipe: ${err.message}`,
        );
      });
      server.on("error", (err) => {
        fail(
          `Failed to launch Chrome over the DevTools pipe: ${err.message}`,
        );
      });
      child.on("error", (err) => {
        fail(
          `Failed to launch Chrome at "${chromePath}": ${err.message}. stderr: ${tail(stderr)}`,
        );
      });
      child.on("exit", (code, signal) => {
        if (!settled) {
          fail(
            `Failed to launch Chrome: exited before the pipe bridge was ready (code=${code ?? "null"}, signal=${signal ?? "null"}). stderr: ${tail(stderr)}`,
          );
        }
      });
      server.on("listening", () => {
        if (settled) return;
        const address = server.address();
        const bridgePort =
          typeof address === "object" && address !== null ? address.port : 0;
        if (!bridgePort) {
          fail("Failed to launch Chrome: the pipe bridge did not get a port");
          return;
        }
        const pid = child.pid;
        if (pid === undefined) {
          fail(
            `Failed to launch Chrome: process exited before the pipe bridge was ready. stderr: ${tail(stderr)}`,
          );
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          wsUrl: `ws://127.0.0.1:${bridgePort}/devtools/browser/pipe`,
          pid,
          port: bridgePort,
          headless,
          close: async () => {
            for (const ws of [...clients]) ws.close();
            wss.close();
            server.close();
            chromePipe.close();
            await closeBrowser(child, ownsProfileDir, userDataDir);
          },
        });
      });
      server.listen(0, "127.0.0.1");
      return;
    }

    const onOutput = (chunk: Buffer): void => {
      if (settled) return;
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
      const wsUrl = parseDevToolsUrl(stderr);
      if (!wsUrl) return;
      const pid = child.pid;
      if (pid === undefined) {
        fail(
          `Failed to launch Chrome: process exited before the DevTools URL appeared. stderr: ${tail(stderr)}`,
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      const portMatch = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(wsUrl);
      resolve({
        wsUrl,
        pid,
        port: portMatch ? Number(portMatch[1]) : 0,
        headless,
        close: () => closeBrowser(child, ownsProfileDir, userDataDir),
      });
    };

    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);

    child.on("error", (err) => {
      fail(
        `Failed to launch Chrome at "${chromePath}": ${err.message}. stderr: ${tail(stderr)}`,
      );
    });

    child.on("exit", (code, signal) => {
      if (!settled) {
        fail(
          `Failed to launch Chrome: exited before the DevTools URL appeared (code=${code ?? "null"}, signal=${signal ?? "null"}). stderr: ${tail(stderr)}`,
        );
      }
    });
  });
}
