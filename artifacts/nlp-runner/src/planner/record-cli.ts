/**
 * CLI wiring for the QF-54 record quality gates.
 *
 * `run "<query>"` (when no direct test match exists, or `--record` is forced)
 * drives `RecordSession` with a headless Chrome `RecorderDriver`, a real
 * `ReplayRunner` dry-run gate, and the configured LLM. `--confirm` pauses per
 * milestone; `--auto` (default for known domains) skips prompts. The resulting
 * `RecordReport` is printed to stdout.
 */
import type { Page } from "../browser/session.js";
import { BrowserSession } from "../browser/session.js";
import type { DataStore } from "../cache/queries.js";
import type { TestWithSteps } from "../cache/types.js";
import { ReplayRunner, type ReplayResult } from "../replay/engine.js";
import { RecorderDriver } from "./recorder-driver.js";
import { RecordSession, type DriverBundle, type DryRunGate, type DryRunResult } from "./record-session.js";
import type { RecordReport } from "./record-session.js";
export type { RecordReport };
import type { LLMClient } from "../llm/client.js";
import type { LaunchOptions } from "../browser/launch.js";

export interface RecordCliOptions {
  confirm?: boolean;
  auto?: boolean;
  dryRun?: boolean;
  minimize?: boolean;
  variables?: Record<string, string>;
  site?: string;
  entryUrl?: string;
  headful?: boolean;
  maxDryRunAttempts?: number;
}

export class BrowserDriverFactory {
  constructor(private readonly store: DataStore, private readonly launchOpts: LaunchOptions) {}

  async create(): Promise<DriverBundle> {
    const session = await BrowserSession.launch({
      ...this.launchOpts,
      headless: this.launchOpts.headless ?? true,
      timeoutMs: this.launchOpts.timeoutMs ?? 20_000,
    });
    const page = await session.newPage();
    const driver = new RecorderDriver(page, this.store);
    return { driver, page, close: async () => session.close() };
  }
}

export class ReplayDryRunGate implements DryRunGate {
  private session: BrowserSession | null = null;
  private page: Page | null = null;

  constructor(private readonly store: DataStore, private readonly launchOpts: LaunchOptions) {}

  private async ready(): Promise<{ session: BrowserSession; page: Page }> {
    if (!this.session) {
      this.session = await BrowserSession.launch({
        ...this.launchOpts,
        headless: this.launchOpts.headless ?? true,
        timeoutMs: this.launchOpts.timeoutMs ?? 20_000,
      });
    }
    if (!this.page) {
      this.page = await this.session.newPage();
    }
    return { session: this.session, page: this.page };
  }

  async dryRun(
    test: TestWithSteps,
    opts?: { variables?: Record<string, string>; timeoutMs?: number },
  ): Promise<DryRunResult> {
    const { page } = await this.ready();
    const result: ReplayResult = await new ReplayRunner(page).runTest(this.store, test, {
      variables: opts?.variables,
      timeoutMs: opts?.timeoutMs ?? 15_000,
    });
    if (result.success) return { success: true };
    const failed = result.steps.find((s) => s.status === "failed");
    return {
      success: false,
      error: result.error,
      failingStep: failed?.idx ?? result.steps.length - 1,
      failingIntent: failed?.intent,
    };
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.close();
      this.session = null;
      this.page = null;
    }
  }
}

export function parseRecordArgs(argv: string[]): RecordCliOptions & { query?: string } {
  const opts: RecordCliOptions & { query?: string } = {
    confirm: false,
    auto: false,
    dryRun: true,
    minimize: true,
  };
  const take = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--confirm") {
      opts.confirm = true;
    } else if (arg === "--auto") {
      opts.auto = true;
    } else if (arg === "--no-dry-run") {
      opts.dryRun = false;
    } else if (arg === "--no-minimize") {
      opts.minimize = false;
    } else if (arg === "--variables" || arg.startsWith("--variables=")) {
      const raw = arg.startsWith("--variables=") ? arg.slice("--variables=".length) : take(i, "--variables");
      if (arg === "--variables") i++;
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("--variables: expected a JSON object");
      }
      opts.variables = parsed as Record<string, string>;
    } else if (arg === "--site") {
      opts.site = take(i, "--site");
      if (arg === "--site") i++;
    } else if (arg === "--max-dry-run-attempts") {
      opts.maxDryRunAttempts = Number(take(i, "--max-dry-run-attempts"));
      if (arg === "--max-dry-run-attempts") i++;
    } else if (arg.startsWith("--max-dry-run-attempts=")) {
      opts.maxDryRunAttempts = Number(arg.slice("--max-dry-run-attempts=".length));
    } else if (arg === "--headful") {
      opts.headful = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag "${arg}"`);
    } else if (!opts.query) {
      opts.query = arg;
    } else {
      throw new Error(`unexpected extra argument "${arg}"`);
    }
  }
  if (!opts.query) throw new Error("expected a query (natural-language description of what to record)");
  return opts;
}

export function formatRecordReport(report: RecordReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.testName}  ${report.cached ? "[CACHED]" : "[NOT CACHED]"}`);
  lines.push(`query: ${report.query}`);
  lines.push(`milestones: ${report.milestones.length} (${report.milestones.join(" -> ")})`);
  lines.push("metrics:");
  lines.push(`  turns: ${report.metrics.turns}`);
  lines.push(`  steps: ${report.metrics.steps}`);
  lines.push(`  llm_calls: ${report.metrics.llmCalls}`);
  lines.push(`  backtracks: ${report.metrics.backtracks}`);
  lines.push(`  guard_fires: ${report.metrics.guardFires}`);
  lines.push(`dry_run: ${report.dryRun.passed ? "PASS" : "FAIL"} (attempts ${report.dryRun.attempts})`);
  if (report.dryRun.error) lines.push(`  error: ${report.dryRun.error}`);
  lines.push(`minimized: ${report.minimized.before} -> ${report.minimized.after} steps`);
  if (report.error) lines.push(`error: ${report.error}`);
  return lines.join("\n");
}

export async function runRecord(
  store: DataStore,
  llm: LLMClient,
  query: string,
  launchOpts: LaunchOptions,
  sessionOpts: {
    confirm?: boolean;
    auto?: boolean;
    dryRun?: boolean;
    minimize?: boolean;
    variables?: Record<string, string>;
    site?: string;
    entryUrl?: string;
    maxDryRunAttempts?: number;
  },
): Promise<{ ok: boolean; report: RecordReport }> {
  const factory = new BrowserDriverFactory(store, launchOpts);
  const gate = new ReplayDryRunGate(store, launchOpts);
  const confirm = sessionOpts.confirm
    ? async (m: string, i: number, t: number) => {
        const { stdin, stdout } = process;
        return new Promise<boolean>((resolve) => {
          stdout.write(`\n[milestone ${i}/${t}] ${m} — proceed? [y/N] `);
          stdin.resume();
          stdin.once("data", (data) => {
            const answer = String(data).trim().toLowerCase();
            resolve(answer === "y" || answer === "yes");
          });
        });
      }
    : undefined;
  try {
    const session = new RecordSession(llm, store, factory, gate, {
      confirm: sessionOpts.confirm ? confirm : undefined,
      auto: sessionOpts.auto,
      dryRun: sessionOpts.dryRun ?? true,
      minimize: sessionOpts.minimize ?? true,
      variables: sessionOpts.variables,
      site: sessionOpts.site,
      entryUrl: sessionOpts.entryUrl,
      maxDryRunAttempts: sessionOpts.maxDryRunAttempts,
    });
    const outcome = await session.record(query, "recorded");
    return { ok: outcome.ok, report: outcome.report };
  } finally {
    await gate.close();
  }
}
