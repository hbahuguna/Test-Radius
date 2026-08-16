import { BrowserSession } from "./browser/session.js";
import { openDatabase } from "./cache/db.js";
import { DataStore } from "./cache/queries.js";
import type { TestWithSteps } from "./cache/types.js";
import { loadConfig, resolveGoogleChromePath, type Config } from "./config.js";
import { ReplayRunner } from "./replay/engine.js";
import { OpenAIChatClient } from "./llm/client.js";
import { LLMStepHealer } from "./replay/heal.js";
import type { LaunchOptions } from "./browser/launch.js";
import { detectGoogleSignIn } from "./browser/google-signin.js";
import { runRecord, formatRecordReport } from "./planner/record-cli.js";
import { createMatcher } from "./embeddings/matcher.js";
import { embedCached } from "./embeddings/embed.js";
import {
  chooseCandidate,
  decideRun,
  disambiguatePrompt,
  extractStartUrl,
  refillVariables,
  resolveStartUrl,
} from "./planner/nl-query.js";
import type { MatchResult } from "./embeddings/matcher.js";
import type { RunMode } from "./planner/nl-query.js";
import { clearSiteMemory } from "./planner/site-memory.js";
export { formatRecordReport };
export type { RecordReport } from "./planner/record-cli.js";
import { renderChecklist } from "./util/describe.js";
import { LiveAgent } from "./live/agent.js";
import type { BrowseResult } from "./live/views.js";
import { mkdirSync, writeFileSync } from "node:fs";

export { describeLocator, renderChecklist, stepToEnglish } from "./util/describe.js";

export function listTests(store: DataStore): string {
  const tests = store.listTests();
  if (tests.length === 0) return "No recorded tests yet.";
  const rows = tests.map((t) => {
    const stepCount = store.listStepsByTest(t.id).length;
    const runCount = store.listRuns(t.id).length;
    return `  ${String(t.id).padEnd(4)} ${t.name.padEnd(28)} ${t.source.padEnd(9)} steps=${String(stepCount).padEnd(3)} runs=${runCount}  ${t.entryUrl ?? ""}`;
  });
  return ["#id  name                         source    steps runs  entry_url", ...rows].join("\n");
}

export function showTest(store: DataStore, id: number): string {
  const test = store.getTestWithSteps(id);
  if (!test) return `No test with id ${id}.`;
  const slots = store.listSlotsByTest(id);
  const lines: string[] = [];
  lines.push(`Test #${test.id}: ${test.name} (${test.source})`);
  if (test.entryUrl) lines.push(`Entry URL: ${test.entryUrl}`);
  if (test.description) lines.push(`Description: ${test.description}`);
  if (slots.length > 0) {
    lines.push(
      `Slots: ${slots.map((s) => `${s.name} (${s.kind}) = "${s.defaultValue ?? ""}"`).join(", ")}`,
    );
  }
  lines.push("Steps:");
  lines.push(renderChecklist(test.steps));
  return lines.join("\n");
}

export function showRuns(store: DataStore, id: number): string {
  const test = store.getTest(id);
  if (!test) return `No test with id ${id}.`;
  const runs = store.listRuns(id);
  if (runs.length === 0) {
    return `No runs yet for test ${id} (${test.name}).`;
  }
  const rows = runs.map((r) => {
    const duration =
      r.finishedAt && r.startedAt
        ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
        : null;
    const durationStr = duration === null ? "n/a" : `${duration}ms`;
    return `  run#${r.id} result=${r.status.padEnd(8)} started=${r.startedAt} finished=${r.finishedAt ?? "-"} duration=${durationStr} llm_calls=${r.llmCalls}`;
  });
  return [`Runs for test ${id} (${test.name}):`, ...rows].join("\n");
}

export function showVersions(store: DataStore, id: number): string {
  const versions = store.listVersionsByTest(id);
  if (versions.length === 0) {
    return `No version history for test ${id}.`;
  }
  const rows = versions.map((v) => {
    const stepCount = (v.steps as unknown[] | null)?.length ?? 0;
    return `  v${v.version}  ${v.createdAt}  steps=${stepCount}  ${v.reason ?? ""}`;
  });
  return [`Versions for test ${id}:`, ...rows].join("\n");
}

export function healCommand(store: DataStore, rest: string[]): number {
  const id = Number(rest[0]);
  if (!Number.isInteger(id) || id <= 0) {
    console.error("Usage: qf heal <id> [--rollback]  (id must be a positive integer)");
    return 1;
  }
  if (!store.getTestWithSteps(id)) {
    console.error(`heal: no test with id ${id}`);
    return 1;
  }

  if (rest.includes("--rollback")) {
    const versions = store.listVersionsByTest(id);
    // restore the most recent pre-heal baseline (the version whose reason
    // indicates it was the state before a self-heal), i.e. the oldest baseline
    // if any, otherwise the penultimate version.
    const baselines = versions.filter((v) => /baseline/i.test(v.reason ?? ""));
    const target =
      baselines.length > 0
        ? baselines[baselines.length - 1]
        : versions[versions.length - 2];
    if (!target) {
      console.error("heal: nothing to roll back to (no prior version)");
      return 1;
    }
    const ok = store.restoreVersion(id, target.version);
    if (!ok) {
      console.error(`heal: could not restore version v${target.version}`);
      return 1;
    }
    console.log(`Rolled back test #${id} to v${target.version} (reason: ${target.reason ?? "-"})`);
    return 0;
  }

  // heal history = versions created by a self-heal
  const heals = store.listVersionsByTest(id).filter((v) => /self-heal/i.test(v.reason ?? ""));
  if (heals.length === 0) {
    console.log(`No self-heal history for test #${id}.`);
    return 0;
  }
  const rows = heals.map((v) => `  v${v.version}  ${v.createdAt}  ${v.reason ?? ""}`);
  console.log(`Self-heal history for test #${id}:`);
  console.log(rows.join("\n"));
  return 0;
}

export function usage(): string {
  return [
    "Usage: qf <command> [args]",
    "",
    "Commands:",
    "  list                        list recorded tests",
    "  show <id>                   show a test's steps as a checklist",
    "  runs <id>                   show run history for a test",
    "  versions <id>               show version history for a test (self-heal baselines + healed versions)",
    "  heal <id> [--rollback]      show self-heal history, or restore the previous version with --rollback",
    "  run <id|query> [options]    replay a test, or record via LLM when no match (options: --variables <json>,",
    "                               --headful, --screenshot-dir <dir>, --confirm, --auto, --record,",
    "                               --no-dry-run, --no-minimize, --site <url>, --max-dry-run-attempts <n>)",
    "  browse \"<task>\" [options]    live agent automates the task in a real browser (options: --headful,",
    "                               --max-steps <n>, --screenshot-dir <dir>, --save-transcript <path>,",
    "                               --vision, --max-actions <n>)",
  ].join("\n");
}

// ----- run command ----------------------------------------------------------

/**
 * Google blocks sign-in in headless *and* bare-Chromium builds, so a task that
 * signs in/up with Google must launch a real Chrome window over the DevTools
 * pipe (works for Chrome for Testing builds that never bind a debug port).
 */
function googleLaunchOptions(config: Config): LaunchOptions {
  return {
    pipe: true,
    chromePath: resolveGoogleChromePath(config.chromePath),
  };
}

export interface RunCommandArgs {
  target: string;
  variables: Record<string, string>;
  headful: boolean;
  screenshotDir: string | null;
  // QF-54 record quality gates (used when falling back to recording)
  record?: boolean;
  confirm?: boolean;
  auto?: boolean;
  noDryRun?: boolean;
  noMinimize?: boolean;
  site?: string;
  entryUrl?: string;
  maxDryRunAttempts?: number;
  /** QF-63: bypass similarity matching / disambiguation and replay this test id. */
  test?: number;
}

export function parseRunArgs(argv: string[]): RunCommandArgs {
  const args: RunCommandArgs = {
    target: "",
    variables: {},
    headful: false,
    screenshotDir: null,
  };
  const take = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--headful") {
      args.headful = true;
    } else if (arg === "--variables" || arg.startsWith("--variables=")) {
      const raw = arg.startsWith("--variables=")
        ? arg.slice("--variables=".length)
        : take(i, "--variables");
      if (arg === "--variables") i++;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("expected a JSON object");
        }
        args.variables = parsed as Record<string, string>;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`--variables: invalid JSON: ${reason}`);
      }
    } else if (arg === "--screenshot-dir" || arg.startsWith("--screenshot-dir=")) {
      args.screenshotDir = arg.startsWith("--screenshot-dir=")
        ? arg.slice("--screenshot-dir=".length)
        : take(i, "--screenshot-dir");
      if (arg === "--screenshot-dir") i++;
    } else if (arg === "--record") {
      args.record = true;
    } else if (arg === "--confirm") {
      args.confirm = true;
    } else if (arg === "--auto") {
      args.auto = true;
    } else if (arg === "--no-dry-run") {
      args.noDryRun = true;
    } else if (arg === "--no-minimize") {
      args.noMinimize = true;
    } else if (arg === "--site") {
      args.site = take(i, "--site");
      i++;
    } else if (arg === "--entry-url") {
      args.entryUrl = take(i, "--entry-url");
      i++;
    } else if (arg === "--test") {
      args.test = Number(take(i, "--test"));
      i++;
    } else if (arg === "--max-dry-run-attempts") {
      args.maxDryRunAttempts = Number(take(i, "--max-dry-run-attempts"));
      i++;
    } else if (arg.startsWith("--max-dry-run-attempts=")) {
      args.maxDryRunAttempts = Number(arg.slice("--max-dry-run-attempts=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag "${arg}"`);
    } else if (!args.target) {
      args.target = arg;
    } else {
      throw new Error(`unexpected extra argument "${arg}"`);
    }
  }
  if (args.test !== undefined && (isNaN(args.test) || args.test <= 0)) {
    throw new Error("--test requires a positive integer id");
  }
  if (!args.target && args.test === undefined) throw new Error("expected a test id or query");
  return args;
}

export async function resolveRunTarget(
  store: DataStore,
  target: string,
): Promise<TestWithSteps | null> {
  if (/^\d+$/.test(target)) {
    return store.getTestWithSteps(Number(target));
  }
  const test = store.getTestByQuery(target);
  return test ? store.getTestWithSteps(test.id) : null;
}

async function runRecordCommand(store: DataStore, parsed: RunCommandArgs): Promise<number> {
  const config = loadConfig();
  const llm = new OpenAIChatClient(config.llm);
  // Google blocks sign-in in headless Chrome, so a task that signs in/up with
  // Google forces a visible window regardless of --headful.
  const google = detectGoogleSignIn({ query: parsed.target, url: parsed.entryUrl ?? undefined });
  const opts: LaunchOptions = {
    headless: !(parsed.headful || google),
    ...(google
      ? googleLaunchOptions(config)
      : config.chromePath === "auto"
        ? {}
        : { chromePath: config.chromePath }),
  };
  const { ok, report } = await runRecord(store, llm, parsed.target, opts as LaunchOptions, {
    confirm: parsed.confirm,
    auto: parsed.auto,
    dryRun: !parsed.noDryRun,
    minimize: !parsed.noMinimize,
    variables: parsed.variables,
    site: parsed.site,
    entryUrl: parsed.entryUrl,
    maxDryRunAttempts: parsed.maxDryRunAttempts,
  });
  console.log(formatRecordReport(report));
  return ok ? 0 : 1;
}

function memoryCommand(store: DataStore, argv: string[]): number {
  const [subcmd, ...rest] = argv;
  if (subcmd === "clear") {
    const site = rest[0];
    const count = site ? clearSiteMemory(store, site) : clearSiteMemory(store);
    console.log(count === 0 ? "No site memory to clear." : `Cleared ${count} site-memory entr${count === 1 ? "y" : "ies"}.`);
    return 0;
  }
  console.error("Usage: qf memory <clear [site]>");
  return 1;
}

// ----- browse command (PLAN-live-agent.md Phase 4) -------------------------

export interface BrowseCommandArgs {
  task: string;
  headful: boolean;
  maxSteps: number;
  maxActions: number;
  screenshotDir: string | null;
  saveTranscript: string | null;
  vision: boolean;
}

export function parseBrowseArgs(argv: string[]): BrowseCommandArgs {
  const args: BrowseCommandArgs = {
    task: "",
    headful: false,
    maxSteps: 100,
    maxActions: 3,
    screenshotDir: null,
    saveTranscript: null,
    vision: false,
  };
  const take = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    return value;
  };
  const intOf = (flag: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} requires a positive integer`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--headful") {
      args.headful = true;
    } else if (arg === "--vision") {
      args.vision = true;
    } else if (arg === "--max-steps" || arg.startsWith("--max-steps=")) {
      const raw = arg.startsWith("--max-steps=") ? arg.slice("--max-steps=".length) : take(i, "--max-steps");
      if (arg === "--max-steps") i++;
      args.maxSteps = intOf("--max-steps", raw);
    } else if (arg === "--max-actions" || arg.startsWith("--max-actions=")) {
      const raw = arg.startsWith("--max-actions=") ? arg.slice("--max-actions=".length) : take(i, "--max-actions");
      if (arg === "--max-actions") i++;
      args.maxActions = intOf("--max-actions", raw);
    } else if (arg === "--screenshot-dir" || arg.startsWith("--screenshot-dir=")) {
      const raw = arg.startsWith("--screenshot-dir=") ? arg.slice("--screenshot-dir=".length) : take(i, "--screenshot-dir");
      if (arg === "--screenshot-dir") i++;
      args.screenshotDir = raw;
    } else if (arg === "--save-transcript" || arg.startsWith("--save-transcript=")) {
      const raw = arg.startsWith("--save-transcript=") ? arg.slice("--save-transcript=".length) : take(i, "--save-transcript");
      if (arg === "--save-transcript") i++;
      args.saveTranscript = raw;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag "${arg}"`);
    } else if (!args.task) {
      args.task = arg;
    } else {
      throw new Error(`unexpected extra argument "${arg}"`);
    }
  }
  if (!args.task) throw new Error('browse: expected a task string, e.g. qf browse "go to example.com"');
  return args;
}

export interface BrowseEvent {
  kind: "step" | "screenshot" | "done";
  step?: number;
  text?: string;
}

/** Stream a plain-text summary of a browse run to stdout. */
function formatBrowseEvent(e: BrowseEvent): string {
  if (e.kind === "step" && e.step !== undefined) return `  ▶ step ${e.step + 1}: ${e.text ?? ""}`;
  if (e.kind === "screenshot") return `  📸 screenshot saved: ${e.text ?? ""}`;
  if (e.kind === "done") return e.text ?? "";
  return "";
}

/** Wire the `browse` command to a LiveAgent and return the run result (or null on launch failure). */
export async function runBrowse(
  parsed: BrowseCommandArgs,
  onEvent?: (e: BrowseEvent) => void,
): Promise<BrowseResult | null> {
  const emit = onEvent ?? ((e: BrowseEvent) => console.log(formatBrowseEvent(e)));
  const cfg = loadConfig();
  const llm = new OpenAIChatClient(cfg.llm);
  const google = detectGoogleSignIn({ query: parsed.task });
  let session;
  try {
    session = await BrowserSession.launch({
      headless: !(parsed.headful || google),
      ...(google ? googleLaunchOptions(cfg) : {}),
      timeoutMs: 30_000,
    });
    const agent = new LiveAgent({
      session,
      llm,
      maxSteps: parsed.maxSteps,
      maxActionsPerStep: parsed.maxActions,
      useVision: parsed.vision,
    });
    const result = await agent.browse(parsed.task);
    if (parsed.screenshotDir && result.screenshots.length > 0) {
      mkdirSync(parsed.screenshotDir, { recursive: true });
      result.screenshots.forEach((data, n) => {
        writeFileSync(`${parsed.screenshotDir}/step-${String(n + 1).padStart(3, "0")}.png`, Buffer.from(data, "base64"));
      });
      emit({ kind: "screenshot", text: `${parsed.screenshotDir}/ (${result.screenshots.length} files)` });
    }
    return result;
  } catch (err) {
    console.error(`browse: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    if (session) await session.close();
  }
}

async function browseCommand(argv: string[]): Promise<number> {
  let parsed: BrowseCommandArgs;
  try {
    parsed = parseBrowseArgs(argv);
  } catch (err) {
    console.error(`browse: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const result = await runBrowse(parsed);
  if (!result) return 1;
  if (parsed.saveTranscript) {
    try {
      writeFileSync(parsed.saveTranscript, JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`browse: could not write transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const verdict = result.success ? "DONE" : "ABORTED";
  const summary = [
    `${verdict} in ${result.steps} step(s), ${result.actions} action(s), ${result.llmCalls} llm call(s), ${result.durationMs}ms.`,
    `  result: ${result.finalText}`,
  ];
  if (result.errors.length > 0) summary.push(`  errors: ${result.errors.join("; ")}`);
  console.log("");
  console.log(summary.join("\n"));
  return result.success ? 0 : 1;
}

async function readStdinLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise<string>((resolve) => {
    process.stdin.resume();
    const onData = (data: Buffer) => {
      process.stdin.off("data", onData);
      resolve(data.toString().trim());
    };
    process.stdin.on("data", onData);
  });
}

/** QF-62: build replay variables (heuristic re-fill from the query, LLM fallback
 *  only when a slot can't be resolved heuristically). Returns the variable map
 *  and whether an LLM call was used (drives the run's `llm_calls` counter). */
async function buildReplayVariables(
  store: DataStore,
  test: TestWithSteps,
  parsed: RunCommandArgs,
  queryForRefill: string | undefined,
): Promise<{ variables: Record<string, string>; usedLlm: boolean }> {
  if (parsed.variables && Object.keys(parsed.variables).length > 0) {
    return { variables: parsed.variables, usedLlm: false };
  }
  if (!queryForRefill || /^\d+$/.test(queryForRefill)) {
    return { variables: {}, usedLlm: false };
  }
  const llm = new OpenAIChatClient(loadConfig().llm);
  const slots = store.listSlotsByTest(test.id);
  const res = await refillVariables(slots, queryForRefill, llm);
  return { variables: res.variables, usedLlm: res.usedLlm };
}

async function replayTest(
  store: DataStore,
  test: TestWithSteps,
  parsed: RunCommandArgs,
  queryForRefill?: string,
): Promise<number> {
  const { variables, usedLlm: refillLlm } = await buildReplayVariables(store, test, parsed, queryForRefill);
  const config = loadConfig();
  const cfg = config.llm;
  // A healer is only wired when an LLM endpoint + key are configured; without it
  // a replay that can't locate an element simply fails (llm_calls stays 0).
  const healer = cfg.apiKey ? new LLMStepHealer(new OpenAIChatClient(cfg)) : undefined;
  const google = detectGoogleSignIn({
    query: queryForRefill ?? parsed.target,
    url: test.entryUrl ?? undefined,
  });
  let session;
  try {
    session = await BrowserSession.launch({
      headless: !(parsed.headful || google),
      ...(google ? googleLaunchOptions(config) : {}),
      timeoutMs: 20_000,
    });
    const page = await session.newPage();
    const runner = new ReplayRunner(page);
    const result = await runner.runTest(store, test, {
      variables,
      screenshotDir: parsed.screenshotDir ?? undefined,
      llmCalls: refillLlm ? 1 : 0,
      healer,
    });
    for (const s of result.steps) {
      const mark =
        s.status === "passed" ? "[PASS]" : s.status === "failed" ? "[FAIL]" : "[SKIP]";
       const healMark = (() => {
         const d = s.detail;
         if (d && typeof d === "object" && "healed" in d) {
           const h = (d as { healed?: string | null }).healed;
           return h ? ` [HEALED -> ${h}]` : "";
         }
         return "";
       })();
      console.log(`  ${mark} ${s.idx + 1}/${result.steps.length} ${s.intent}${healMark}`);
    }
    for (const [key, value] of Object.entries(result.extracted)) {
      console.log(`  extracted ${key} = "${value}"`);
    }
    console.log(`  llm_calls: ${result.llmCalls}  self_healed: ${result.selfHealed}`);
    if (result.success) {
      console.log(`PASS (run #${result.runId} of test #${result.testId})`);
      return 0;
    }
    console.error(result.error);
    console.error(`FAIL (run #${result.runId} of test #${result.testId})`);
    return 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    if (session) await session.close();
  }
}

async function runCommand(store: DataStore, argv: string[]): Promise<number> {
  let parsed: RunCommandArgs;
  try {
    parsed = parseRunArgs(argv);
  } catch (err) {
    console.error(`run: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // QF-63: --test <id> bypasses matching/disambiguation and replays a test.
  if (parsed.test !== undefined) {
    const test = store.getTestWithSteps(parsed.test);
    if (!test) {
      console.error(`run: no test matches id ${parsed.test}`);
      return 1;
    }
    const queryForRefill = parsed.target && !/^\d+$/.test(parsed.target) ? parsed.target : undefined;
    return replayTest(store, test, parsed, queryForRefill);
  }

  // Numeric id -> direct replay (no slot re-fill; no matching).
  if (/^\d+$/.test(parsed.target)) {
    const test = store.getTestWithSteps(Number(parsed.target));
    if (!test) {
      console.error(`run: no test matches id ${parsed.target}`);
      return 1;
    }
    return replayTest(store, test, parsed);
  }

  // Non-numeric target is a natural-language query (QF-61/62/63).
  // Fast path: exact query match (no embedding) -> replay.
  const exact = await resolveRunTarget(store, parsed.target);
  if (exact) return replayTest(store, exact, parsed, parsed.target);

  // Similarity dispatch: match -> replay, many matches -> prompt, none -> record.
  const matcher = createMatcher(store, { embed: embedCached });
  const decision: RunMode = await decideRun(parsed.target, store, matcher);
  if (decision.mode === "replay") {
    console.log(`mode: replay (match ${Math.round(decision.score * 100)}%)`);
    return replayTest(store, decision.test, parsed, parsed.target);
  }
  if (decision.mode === "disambiguate") {
    console.log(disambiguatePrompt(decision.candidates));
    const line = await readStdinLine("");
    const chosen = chooseCandidate(decision.candidates, line);
    if (!chosen) {
      console.error("run: cancelled");
      return 1;
    }
    const test = store.getTestWithSteps(chosen.test.id);
    if (!test) {
      console.error(`run: test #${chosen.test.id} not found`);
      return 1;
    }
    console.log(`mode: replay (test #${test.id})`);
    return replayTest(store, test, parsed, parsed.target);
  }

  // No high-confidence match -> record a new test (QF-54 gates via QF-61).
  const startUrl = resolveStartUrl(parsed.entryUrl, parsed.target, parsed.site);
  if (!startUrl) {
    console.log(
      "No starting URL in the query. What page should I start on?\n(Type a URL, or press Enter to cancel)",
    );
    const line = await readStdinLine("Starting URL: ");
    if (!line) {
      console.error("run: cancelled (no starting URL)");
      return 1;
    }
    parsed = { ...parsed, entryUrl: line };
  } else if (!parsed.entryUrl) {
    parsed = { ...parsed, entryUrl: startUrl };
  }
  return runRecordCommand(store, parsed);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command) {
    console.error(usage());
    return 1;
  }
  const config = loadConfig();
  const db = openDatabase(config.dataDir);
  const store = new DataStore(db);
  try {
    switch (command) {
      case "list": {
        console.log(listTests(store));
        return 0;
      }
      case "show": {
        const id = Number(rest[0]);
        if (!Number.isInteger(id) || id <= 0) {
          console.error("Usage: qf show <id>  (id must be a positive integer)");
          return 1;
        }
        console.log(showTest(store, id));
        return 0;
      }
       case "runs": {
         const id = Number(rest[0]);
         if (!Number.isInteger(id) || id <= 0) {
           console.error("Usage: qf runs <id>  (id must be a positive integer)");
           return 1;
         }
         console.log(showRuns(store, id));
         return 0;
       }
       case "versions": {
         const id = Number(rest[0]);
         if (!Number.isInteger(id) || id <= 0) {
           console.error("Usage: qf versions <id>  (id must be a positive integer)");
           return 1;
         }
         console.log(showVersions(store, id));
         return 0;
       }
       case "heal":
         return healCommand(store, rest);
case "run":
         return await runCommand(store, rest);
      case "browse":
        // `browse` does not need the DB; skip the store machinery.
        return await browseCommand(rest);
      case "memory":
        return memoryCommand(store, rest);
      default:
        console.error(usage());
        return 1;
    }
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
