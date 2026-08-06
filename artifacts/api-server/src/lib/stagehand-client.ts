import { Stagehand } from "@browserbasehq/stagehand";
import { chromium } from "playwright";
import { existsSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";
import { logger } from "./logger";

// ============================================================
// Types
// ============================================================

export interface StagehandConfig {
  provider: string;
  modelId: string;
  apiKey: string;
}

export interface Assertion {
  type: "visibility" | "text" | "url" | "interaction";
  target?: string;
  expected?: string;
  pattern?: string;
  description?: string;
  /** CSS selector to scope the LLM's search area (reduces tokens + improves accuracy) */
  selector?: string;
  /** For "interaction" assertions: the action to perform before verifying */
  action?: string;
  /** For "interaction" assertions: the follow-up assertion after the action */
  then?: Pick<Assertion, "type" | "target" | "expected" | "pattern" | "selector">;
}

export interface AssertionResult {
  index: number;
  pass: boolean;
  reason: string;
}

export interface CreateStagehandOptions {
  cacheDir?: string;
  headless?: boolean;
}

export interface StagehandMetrics {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalReasoningTokens: number;
  totalCachedInputTokens: number;
  totalInferenceTimeMs: number;
  actInferenceTimeMs: number;
  extractInferenceTimeMs: number;
  observeInferenceTimeMs: number;
}

// ============================================================
// Model Configuration (v3 unified format)
// ============================================================

/**
 * Resolve Stagehand model options from our provider config.
 *
 * Stagehand v3 uses a unified `model` parameter:
 * - openai / anthropic: use the `"provider/model"` string format
 * - openrouter / poolside: use the object format with a custom baseURL
 *
 * Model versions are pinned to avoid silent behaviour changes from
 * floating tags (e.g. gpt-4o → gpt-4o-2024-11-20).
 */
function resolveModelOptions(
  config: StagehandConfig,
): { model: string } | { model: { modelName: string; apiKey: string; baseURL: string; provider?: "openai"; openaiEndpointFormat?: "responses" | "chat" } } {
  switch (config.provider) {
    case "openai":
      return { model: `openai/${config.modelId}` };

    case "anthropic":
      return { model: `anthropic/${config.modelId}` };

    case "openrouter":
      return {
        model: {
          modelName: config.modelId,
          apiKey: config.apiKey,
          baseURL: "https://openrouter.ai/api/v1",
        },
      };

    case "poolside":
      return {
        model: {
          // Poolside exposes an OpenAI-compatible chat API. Stagehand's AI SDK
          // parser needs a supported provider prefix even with a custom base URL.
          modelName: `openai/${config.modelId.startsWith("poolside/") ? config.modelId : `poolside/${config.modelId}`}`,
          apiKey: config.apiKey,
          baseURL: "https://inference.poolside.ai/v1",
          provider: "openai",
          openaiEndpointFormat: "chat",
        },
      };

    case "opencode":
      return {
        model: {
          // OpenCode Zen exposes an OpenAI-compatible API. Stagehand's AI SDK
          // provider parser needs the model prefix to be an SDK provider.
          modelName: `openai/${config.modelId.replace(/^opencode\//, "")}`,
          apiKey: config.apiKey,
          baseURL: process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1",
          openaiEndpointFormat: "chat",
        },
      };

    default:
      throw new Error(
        `Unsupported Stagehand provider: ${config.provider}. ` +
        "Supported: openai, anthropic, openrouter, poolside, opencode",
      );
  }
}

// ============================================================
// Retry Helper
// ============================================================

async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelay?: number; label?: string } = {},
): Promise<T> {
  const { maxRetries = 2, baseDelay = 1000, label = "operation" } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      logger.warn(
        { attempt: attempt + 1, maxRetries, delay, label },
        "Stagehand operation failed, retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("unreachable");
}

// ============================================================
// Stagehand Instance Creation
// ============================================================

/**
 * Create and initialise a Stagehand instance.
 *
 * The caller **must** call `stagehand.close()` when done (typically in a
 * `finally` block) to avoid leaking browser processes.
 */
export async function createStagehand(
  config: StagehandConfig,
  options: CreateStagehandOptions = {},
): Promise<Stagehand> {
  const modelOptions = resolveModelOptions(config);
  const executablePath = resolveBrowserExecutable();
  const localBrowserLaunchOptions = existsSync(executablePath)
    ? { executablePath, headless: true }
    : { headless: true };

  logger.info({ executablePath }, "Using shared Chromium executable for Stagehand");

  const stagehand = new Stagehand({
    env: "LOCAL",
    ...modelOptions,
    localBrowserLaunchOptions,
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    domSettleTimeout: 5000,
    verbose: 2,
    experimental: true,
    disableAPI: true,
  });

  logger.info(
    { provider: config.provider, modelId: config.modelId },
    "Creating Stagehand instance",
  );

  await stagehand.init();

  return stagehand;
}

function resolveBrowserExecutable(): string {
  const configured = process.env.BROWSER_USE_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) return configured;

  const playwrightPath = chromium.executablePath();
  if (existsSync(playwrightPath)) return playwrightPath;

  const cacheRoot = `${homedir()}/Library/Caches/ms-playwright`;
  const candidates = globSync(`${cacheRoot}/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium`)
    .concat(globSync(`${cacheRoot}/chromium-*/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`))
    .filter((candidate) => existsSync(candidate))
    .sort()
    .reverse();
  if (candidates[0]) return candidates[0];

  return configured || playwrightPath;
}

// ============================================================
// Metrics Collection
// ============================================================

export async function collectMetrics(stagehand: Stagehand): Promise<StagehandMetrics> {
  try {
    const metrics = await stagehand.metrics;
    return {
      totalPromptTokens: metrics?.totalPromptTokens ?? 0,
      totalCompletionTokens: metrics?.totalCompletionTokens ?? 0,
      totalReasoningTokens: metrics?.totalReasoningTokens ?? 0,
      totalCachedInputTokens: metrics?.totalCachedInputTokens ?? 0,
      totalInferenceTimeMs: metrics?.totalInferenceTimeMs ?? 0,
      actInferenceTimeMs: metrics?.actInferenceTimeMs ?? 0,
      extractInferenceTimeMs: metrics?.extractInferenceTimeMs ?? 0,
      observeInferenceTimeMs: metrics?.observeInferenceTimeMs ?? 0,
    };
  } catch {
    return {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalReasoningTokens: 0,
      totalCachedInputTokens: 0,
      totalInferenceTimeMs: 0,
      actInferenceTimeMs: 0,
      extractInferenceTimeMs: 0,
      observeInferenceTimeMs: 0,
    };
  }
}

export async function refineLocatorsWithStagehand(
  url: string,
  instruction: string,
  config: StagehandConfig,
): Promise<Array<{ selector?: string; description?: string; method?: string; arguments?: unknown }>> {
  const stagehand = await createStagehand(config, { cacheDir: "/tmp/stagehand-locator-cache" });
  try {
    const page = stagehand.context.pages()[0];
    await page.goto(url);
    const observed = await stagehand.observe(instruction);
    return (observed ?? []).map((item) => ({
      selector: item.selector,
      description: item.description,
      method: item.method,
      arguments: item.arguments,
    }));
  } finally {
    await stagehand.close();
  }
}

// ============================================================
// Assertion Evaluation
// ============================================================

function getAssertionDescription(assertion: Assertion, index: number): string {
  switch (assertion.type) {
    case "visibility":
      return `Check if element "${assertion.target}" is visible on the page`;
    case "text":
      return `Check if the page contains the text "${assertion.expected}"`;
    case "url":
      return `Check if the current URL matches the pattern "${assertion.pattern}"`;
    case "interaction":
      return `Perform action "${assertion.action}" then verify ${assertion.then?.type ?? "visibility"}`;
    default:
      return `Check assertion ${index + 1}`;
  }
}

const assertionEvalSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().describe("1-based assertion index"),
      pass: z.boolean(),
      reason: z
        .string()
        .describe("Brief explanation of why the assertion passed or failed"),
    }),
  ),
});

/**
 * Evaluate an array of test assertions against a page using Stagehand.
 *
 * - URL assertions: checked directly against `page.url()`, no LLM
 * - Visibility/text assertions: evaluated via `extract()` with LLM
 * - Interaction assertions: perform `act()` then verify with `extract()`
 */
export async function evaluateAssertions(
  url: string,
  assertions: Assertion[],
  config: StagehandConfig,
): Promise<{ results: AssertionResult[]; metrics: StagehandMetrics }> {
  if (assertions.length === 0) return { results: [], metrics: await emptyMetrics() };

  const stagehand = await createStagehand(config);

  try {
    const page = stagehand.context.pages()[0];
    await page.goto(url);

    const results: AssertionResult[] = [];

    for (let i = 0; i < assertions.length; i++) {
      const a = assertions[i];

      // URL assertions: check directly, no LLM needed
      if (a.type === "url" && a.pattern) {
        const pageUrl = page.url();
        const pass = pageUrl.includes(a.pattern);
        results.push({
          index: i,
          pass,
          reason: pass
            ? `URL "${pageUrl}" matches pattern "${a.pattern}"`
            : `URL "${pageUrl}" does not match pattern "${a.pattern}"`,
        });
        continue;
      }

      // Interaction assertions: act() then verify
      if (a.type === "interaction" && a.action) {
        try {
          const actInput = a.selector
            ? { selector: a.selector, description: a.action }
            : a.action;
          await withRetry(
            () => stagehand.act(actInput as any),
            { label: `act:${a.action}` },
          );

          // Now verify the follow-up assertion
          if (a.then) {
            const verifyResult = await evaluateSingleAssertion(stagehand, i, a.then);
            results.push(verifyResult);
          } else {
            results.push({ index: i, pass: true, reason: `Action "${a.action}" performed successfully` });
          }
        } catch (error) {
          results.push({
            index: i,
            pass: false,
            reason: `Interaction failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        continue;
      }

      // Visibility/text assertions: evaluate via extract()
      const verifyResult = await evaluateSingleAssertion(stagehand, i, a);
      results.push(verifyResult);
    }

    const metrics = await collectMetrics(stagehand);
    return { results, metrics };
  } catch (error) {
    logger.error({ error, url }, "Failed to evaluate assertions with Stagehand");
    const metrics = await collectMetrics(stagehand);
    return {
      results: assertions.map((a, i) => ({
        index: i,
        pass: false,
        reason: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      })),
      metrics,
    };
  } finally {
    await stagehand.close();
  }
}

async function evaluateSingleAssertion(
  stagehand: Stagehand,
  index: number,
  assertion: Pick<Assertion, "type" | "target" | "expected" | "selector">,
): Promise<AssertionResult> {
  const description = getAssertionDescription(assertion as Assertion, index);

  // If selector is provided, prepend it to the instruction for LLM scoping
  const scopedDescription = assertion.selector
    ? `Within the element matching selector "${assertion.selector}": ${description}`
    : description;

  const result = await withRetry(
    () =>
      stagehand.extract(
        `Evaluate this single assertion: ${scopedDescription}. ` +
          "Return results with the 1-based index set to 1.",
        assertionEvalSchema,
      ),
    { label: `extract:${assertion.type}` },
  );

  const llmResult = result?.results?.[0];
  if (llmResult) {
    return { index, pass: llmResult.pass, reason: llmResult.reason };
  }

  return { index, pass: false, reason: "Could not evaluate assertion" };
}

async function emptyMetrics(): Promise<StagehandMetrics> {
  return {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalReasoningTokens: 0,
    totalCachedInputTokens: 0,
    totalInferenceTimeMs: 0,
    actInferenceTimeMs: 0,
    extractInferenceTimeMs: 0,
    observeInferenceTimeMs: 0,
  };
}
