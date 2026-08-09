import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

export interface CodeRunEvent {
  event: string;
  [key: string]: unknown;
}

interface CodeRunState {
  id: string;
  userId: string;
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  events: CodeRunEvent[];
  emitter: EventEmitter;
  child: ChildProcessWithoutNullStreams | null;
}

const runs = new Map<string, CodeRunState>();
const MAX_RUNTIME_MS = 120_000;
const MAX_OUTPUT_EVENTS = 500;

function workerPath(): string {
  const configured = process.env.PLAYWRIGHT_WORKER_PATH;
  if (configured) return configured;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "workers/playwright-code-worker.mjs");
}

function publish(run: CodeRunState, event: CodeRunEvent): void {
  if (run.events.length >= MAX_OUTPUT_EVENTS) return;
  run.events.push(event);
  run.emitter.emit("event", event);
}

export function getCodeRun(id: string): CodeRunState | undefined {
  return runs.get(id);
}

export function startCodeRun(input: { id?: string; code: string; url: string; userId: string }): string {
  const id = input.id || randomUUID();
  const run: CodeRunState = { id, userId: input.userId, status: "queued", events: [], emitter: new EventEmitter(), child: null };
  runs.set(id, run);

  const child = spawn(process.execPath, [
    "--disable-proto=delete",
    "--no-addons",
    "--max-old-space-size=256",
    workerPath(),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH || "",
      NODE_ENV: "production",
      CODE_RUN_ALLOWED_ORIGINS: process.env.CODE_RUN_ALLOWED_ORIGINS || "",
    },
  });
  run.child = child;
  run.status = "running";
  const timeout = setTimeout(() => {
    if (run.status === "running") {
      run.status = "failed";
      publish(run, { event: "code_run_completed", success: false, error: "Execution timed out" });
      child.kill("SIGKILL");
    }
  }, MAX_RUNTIME_MS);

  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as CodeRunEvent;
        if (event.event === "code_run_completed") run.status = event.success ? "completed" : "failed";
        publish(run, event);
      } catch {
        publish(run, { event: "console", level: "error", message: "Worker emitted malformed output" });
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => publish(run, { event: "console", level: "error", message: chunk.toString("utf8").slice(0, 4000) }));
  child.on("error", (error) => publish(run, { event: "code_run_completed", success: false, error: error.message }));
  child.on("close", (code) => {
    clearTimeout(timeout);
    if (run.status === "running") run.status = code === 0 ? "completed" : "failed";
    run.child = null;
  });
  child.stdin.end(JSON.stringify(input));
  return id;
}

export function stopCodeRun(id: string): boolean {
  const run = runs.get(id);
  if (!run || !run.child || run.status !== "running") return false;
  run.status = "stopped";
  run.child.kill("SIGTERM");
  publish(run, { event: "code_run_stopped" });
  return true;
}

export function isWorkerAvailable(): boolean {
  return existsSync(workerPath());
}
