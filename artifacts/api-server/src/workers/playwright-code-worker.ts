import { transformSync } from "esbuild";
import { chromium } from "playwright";
import vm from "node:vm";
import { stdin, stdout } from "node:process";

type WorkerInput = { code: string; url: string };
const MAX_STEPS = 100;
const MAX_SCREENSHOT_BYTES = 2_000_000;

function emit(event: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify(event)}\n`);
}

function rejectUnsafeCode(code: string): void {
  const executableCode = code.replace(/^\s*import\s+type\s+[^;]+;?\s*$/gm, "");
  const forbidden = /(?:child_process|worker_threads|node:fs|node:net|node:http|node:https|require\s*\(|process\.binding|import\s+(?!type\b)[^;]+\s+from)/;
  if (forbidden.test(executableCode)) {
    throw new Error("Code contains a restricted import or process API");
  }
}

async function readInput(): Promise<WorkerInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WorkerInput;
  if (!input.code || input.code.length > 250_000) throw new Error("Invalid or oversized script");
  if (!input.url) throw new Error("A source URL is required");
  return input;
}

async function main(): Promise<void> {
  const input = await readInput();
  rejectUnsafeCode(input.code);
  emit({ event: "code_run_started" });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);
  const sourceOrigin = new URL(input.url).origin;
  const configuredOrigins = (process.env.CODE_RUN_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = new Set([sourceOrigin, ...configuredOrigins]);
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) {
      await route.continue();
      return;
    }
    try {
      const parsed = new URL(requestUrl);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && allowedOrigins.has(parsed.origin)) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    } catch {
      await route.abort("blockedbyclient");
    }
  });
  const messages: string[] = [];
  const safeConsole = {
    log: (...args: unknown[]) => {
      const message = args.map(String).join(" ").slice(0, 4000);
      messages.push(message);
      emit({ event: "console", level: "log", message });
    },
    error: (...args: unknown[]) => emit({ event: "console", level: "error", message: args.map(String).join(" ").slice(0, 4000) }),
  };
  let stepCount = 0;

  try {
    const compiled = transformSync(input.code, { loader: "ts", format: "cjs", target: "node20" }).code;
    const module = { exports: {} as Record<string, unknown> };
    const sandbox = {
      module,
      exports: module.exports,
      console: safeConsole,
      process: { env: {} },
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(compiled, sandbox, { timeout: 10_000 });
    const run = module.exports.default;
    if (typeof run !== "function") throw new Error("Script must export a default run function");

    const step = async (name: string, action: () => Promise<void>) => {
      if (stepCount >= MAX_STEPS) throw new Error(`Maximum step count (${MAX_STEPS}) exceeded`);
      stepCount += 1;
      const startedAt = Date.now();
      emit({ event: "code_step_started", name });
      try {
        await action();
        const screenshot = (await page.screenshot({ type: "jpeg", quality: 50 })).toString("base64");
        if (screenshot.length <= MAX_SCREENSHOT_BYTES) {
          emit({ event: "screenshot", name, screenshot: `data:image/jpeg;base64,${screenshot}` });
        }
        emit({ event: "code_step_completed", name, durationMs: Date.now() - startedAt, url: page.url() });
      } catch (error) {
        emit({ event: "code_step_failed", name, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error), url: page.url() });
        throw error;
      }
    };

    await run({ page, step });
    emit({ event: "code_run_completed", success: true, url: page.url() });
  } catch (error) {
    emit({ event: "code_run_completed", success: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  emit({ event: "code_run_completed", success: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
