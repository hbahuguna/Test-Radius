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

function msPlaywrightRoots(home: string): string[] {
  // Collect all roots to search for ms-playwright caches.
  // Playwright may install relative to HOME, but on Replit the workspace is
  // /home/runner/workspace while HOME=/home/runner — so we check both.
  const roots = new Set<string>([
    join(home, "Library", "Caches", "ms-playwright"),
    join(home, ".cache", "ms-playwright"),
    join(home, "AppData", "Local", "ms-playwright"),
  ]);
  // Also check $HOME env var in case os.homedir() differs, and the workspace dir.
  const envHome = process.env["HOME"];
  if (envHome && envHome !== home) {
    roots.add(join(envHome, ".cache", "ms-playwright"));
  }
  // Replit workspace-relative cache (common when playwright ran from within the workspace).
  const cwd = process.cwd();
  roots.add(join(cwd, ".cache", "ms-playwright"));
  // Explicit workspace path for Replit Cloud Run.
  roots.add("/home/runner/workspace/.cache/ms-playwright");
  return [...roots];
}

function findInPath(name: string): string {
  const pathEnv = process.env.PATH || "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return "";
}

function cachedChromeCandidates(home = homedir()): string[] {
  const candidates: string[] = [];

  for (const root of msPlaywrightRoots(home)) {
    for (const dir of listVersionDirs(root, "chromium-")) {
      candidates.push(
        // macOS
        join(dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        // Linux (older playwright naming)
        join(dir, "chrome-linux", "chrome"),
        // Linux (newer playwright naming, e.g. chromium-1223)
        join(dir, "chrome-linux64", "chrome"),
        // Headless shell variants
        join(dir, "chrome-headless-shell-mac", "chrome-headless-shell", "chrome-headless-shell"),
        join(dir, "chrome-headless-shell-linux", "chrome-headless-shell"),
        join(dir, "chrome-headless-shell-linux64", "chrome-headless-shell"),
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
        join(dir, "chrome-linux64", "chrome"),
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

  // 1. Try finding in the system shell PATH first (great for Nix/Replit/system packages)
  const binaries = process.platform === "win32"
    ? ["chrome.exe", "chromium.exe"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const b of binaries) {
    const pathBinary = findInPath(b);
    if (pathBinary) return pathBinary;
  }

  // 2. Fall back to cached Playwright browsers and standard paths
  for (const candidate of [...cachedChromeCandidates(), ...CHROME_CANDIDATES]) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

/**
 * Resolve a Chrome-*branded* binary (as opposed to a Chromium build). Google
 * blocks sign-in ("this browser or app may not be secure") when the browser is
 * a bare Chromium build, so sign-in flows prefer a real Chrome. Priority:
 * explicit path (QF_CHROME_PATH), QF_GOOGLE_CHROME_PATH, Playwright's
 * Chrome-for-Testing cache, a system Chrome install, then any Chromium build.
 */
export function resolveGoogleChromePath(
  chromePath = "auto",
  home = homedir(),
): string {
  if (chromePath && chromePath !== "auto") return chromePath;
  const override = process.env["QF_GOOGLE_CHROME_PATH"];
  if (override) return override;

  // 1. Search system PATH for real Chrome first
  const googleBinaries = process.platform === "win32"
    ? ["chrome.exe"]
    : ["google-chrome", "google-chrome-stable"];
  for (const b of googleBinaries) {
    const pathBinary = findInPath(b);
    if (pathBinary) return pathBinary;
  }

  // 2. Search Playwright Chrome-for-Testing cache
  const cftCandidates = [
    join("chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
    join("chrome-linux64", "chrome"),
    join("chrome-win", "chrome.exe"),
  ];
  for (const root of msPlaywrightRoots(home)) {
    for (const dir of listVersionDirs(root, "chromium-")) {
      for (const cft of cftCandidates) {
        const candidate = join(dir, cft);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  // 3. Search standard fixed directories for Chrome
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }

  // 4. Fallback to general resolveChromePath
  return resolveChromePath("auto");
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
