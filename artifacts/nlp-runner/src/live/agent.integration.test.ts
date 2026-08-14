import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveChromePath } from "../config.js";
import { BrowserSession } from "../browser/session.js";
import { LiveAgent } from "./agent.js";
import { ActionRegistry } from "./registry.js";
import { registerBuiltins } from "./actions.js";
import type { LLMChatOptions, LLMClient, LLMMessage, LLMResult } from "../llm/client.js";

const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureServerPath = fileURLToPath(new URL("../../fixture/server.ts", import.meta.url));

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const detectedChrome = resolveChromePath("auto");
let fixtureProc: ChildProcess | undefined;
let fixtureBase = "";
const fixtureUp = detectedChrome
  ? (() => {
      const port = 5000 + Math.floor(Math.random() * 100);
      const proc = spawn("pnpm", ["exec", "tsx", fixtureServerPath], {
        cwd: pkgRoot,
        env: { ...process.env, PORT: String(port) },
        stdio: "ignore",
      });
      fixtureProc = proc;
      fixtureBase = `http://127.0.0.1:${port}`;
      return waitForServer(`${fixtureBase}/`, 30_000);
    })()
  : Promise.resolve(false);

const integration = detectedChrome && (await fixtureUp);

afterAll(() => {
  fixtureProc?.kill("SIGTERM");
});

/** Scripted LLM: replays a fixed action script, one JSON object per step. */
class ScriptedLLM implements LLMClient {
  queue: string[];
  calls = 0;
  constructor(responses: string[]) {
    this.queue = [...responses];
  }
  async chat(_messages: LLMMessage[], _opts?: LLMChatOptions): Promise<LLMResult> {
    this.calls += 1;
    return { text: this.queue.shift() ?? '{"action":[]}' };
  }
}

function json(action: object[], rest: Record<string, unknown> = {}): string {
  return JSON.stringify({
    evaluation_previous_goal: "ok",
    memory: "m",
    next_goal: "g",
    action,
    ...rest,
  });
}

describe.runIf(integration)("LiveAgent.browse (real Chrome)", () => {
  it("navigates → fills the signup form → submits → done", async () => {
    const session = await BrowserSession.launch({
      chromePath: detectedChrome,
      headless: true,
      timeoutMs: 20_000,
    });
    try {
      const llm = new ScriptedLLM([
        // Step 1: navigate to the signup fixture.
        json([{ navigate: { url: `${fixtureBase}/signup` } }]),
        // Step 2: fill the three fields then click submit (deterministic indexes).
        json([
          { input_text: { index: 1, text: "Grace Hopper" } },
          { input_text: { index: 2, text: "grace@navy.test" } },
          { input_text: { index: 3, text: "secret123" } },
          { click: { index: 4 } },
        ]),
        // Step 3: declare success.
        json([{ done: { success: true, text: "Created the account." } }]),
      ]);
      const registry = new ActionRegistry();
      registerBuiltins((a) => registry.register(a));
      const agent = new LiveAgent({
        session,
        llm,
        registry,
        maxSteps: 8,
        maxActionsPerStep: 4,
        maxFailures: 3,
        useVision: false,
      });

      const result = await agent.browse("Sign up on the fixture page");

      expect(result.success).toBe(true);
      expect(result.urls).toContain(`${fixtureBase}/signup`);
      expect(result.errors).toEqual([]);

      // The form submit handler should have revealed the welcome message.
      const welcome = await agent.currentPage.evaluate<string>(
        () => document.querySelector("#signup-result")?.textContent ?? "",
      );
      expect(welcome).toContain("Welcome, Grace Hopper!");
    } finally {
      await session.close();
    }
  }, 60_000);
});