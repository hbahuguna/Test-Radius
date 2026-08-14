import { constants, existsSync, mkdirSync, accessSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Role-keyed model overrides (PLAN-live-agent.md Phase 0): fall back to `model`. */
  agentModel?: string;
  plannerModel?: string;
}

export interface Config {
  llm: LlmConfig;
  chromePath: string;
  dataDir: string;
}

const DEFAULT_LLM_PROVIDER = "openai-compatible";
const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";

const CHROME_CANDIDATES: string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

export function listVersionDirs(root: string, prefix = ""): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !prefix || entry.startsWith(prefix))
    .map((entry) => ({
      name: entry,
      version: Number(entry.replace(/\D/g, "")) || 0,
    }))
    .sort((a, b) => b.version - a.version)
    .map((entry) => join(root, entry.name));
}

function cachedChromeCandidates(home = homedir()): string[] {
  const candidates: string[] = [];
  for (const root of [
    join(home, "Library", "Caches", "ms-playwright"),
    join(home, ".cache", "ms-playwright"),
    join(home, "AppData", "Local", "ms-playwright"),
  ]) {
    for (const dir of listVersionDirs(root, "chromium-")) {
      candidates.push(
        join(dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        join(dir, "chrome-linux", "chrome"),
        join(dir, "chrome-headless-shell-mac", "chrome-headless-shell", "chrome-headless-shell"),
        join(dir, "chrome-headless-shell-linux", "chrome-headless-shell"),
      );
    }
  }
  for (const root of [
    join(home, ".cache", "puppeteer", "chrome"),
    join(home, "AppData", "Local", "puppeteer", "cache", "chrome"),
  ]) {
    for (const dir of listVersionDirs(root)) {
      candidates.push(
        join(dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        join(dir, "chrome-linux", "chrome"),
        join(dir, "chrome-win", "chrome.exe"),
      );
    }
  }
  return candidates;
}

export function defaultDataDir(): string {
  return join(homedir(), ".queryfirst");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const llm: LlmConfig = {
    provider: env.QF_LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER,
    baseUrl: env.QF_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
    apiKey: env.QF_LLM_API_KEY ?? "",
    model: env.QF_LLM_MODEL ?? DEFAULT_LLM_MODEL,
  };
  if (env.QF_LLM_AGENT_MODEL) llm.agentModel = env.QF_LLM_AGENT_MODEL;
  if (env.QF_LLM_PLANNER_MODEL) llm.plannerModel = env.QF_LLM_PLANNER_MODEL;
  return {
    llm,
    chromePath: env.QF_CHROME_PATH ?? "auto",
    dataDir: env.QF_DATA_DIR ?? defaultDataDir(),
  };
}

export function resolveChromePath(chromePath: string): string {
  if (chromePath && chromePath !== "auto") return chromePath;
  for (const candidate of [...cachedChromeCandidates(), ...CHROME_CANDIDATES]) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateConfig(config: Config): ValidationResult {
  const errors: string[] = [];

  const resolvedChrome = resolveChromePath(config.chromePath);
  if (!resolvedChrome || !existsSync(resolvedChrome)) {
    errors.push(
      `QF_CHROME_PATH does not point to an existing Chrome/Chromium binary (got "${config.chromePath}")`,
    );
  }

  try {
    mkdirSync(config.dataDir, { recursive: true });
    accessSync(config.dataDir, constants.W_OK);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    errors.push(`QF_DATA_DIR could not be created/accessed ("${config.dataDir}"): ${reason}`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function initConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = loadConfig(env);
  const result = validateConfig(config);
  if (!result.ok) {
    throw new Error(`Invalid configuration:\n- ${result.errors.join("\n- ")}`);
  }
  return config;
}
