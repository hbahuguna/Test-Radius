/**
 * Built-in actions for the live agent (PLAN-live-agent.md Phase 1) — ports of
 * browser-use `tools/service.py`, mapped onto the existing CDP `Page`.
 *
 * Every action returns an `ActionResult`. Page-changing actions set
 * `terminatesSequence: true` so `multiAct` stops the batch after them
 * (browser-use parity).
 */
import type { Page } from "../browser/session.js";
import type { ActionResult, LiveContext, RegisteredAction } from "./types.js";
import type { ActionParamsSchema } from "./schema.js";

const MAX_EXTRACT_CHARS = 12_000;

export const NAVIGATE: RegisteredAction = {
  name: "navigate",
  description:
    "Navigate the current tab to a URL. Use this whenever you need to go to a different page. After navigation the batch ends and you see the new page state.",
  terminatesSequence: true,
  params: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Absolute URL (with scheme, e.g. https://...) to navigate to.",
      },
    },
    required: ["url"],
  },
  async execute(ctx, params: { url: string }) {
    await ctx.page.navigate(params.url);
    return { isDone: false };
  },
};

export const GO_BACK: RegisteredAction = {
  name: "go_back",
  description: "Go back to the previous page in the current tab's history.",
  terminatesSequence: true,
  params: { type: "object", properties: {} },
  async execute(ctx) {
    const before = await ctx.page.getUrl();
    await ctx.page.evaluate(() => {
      history.back();
    });
    await ctx.page
      .waitFor(
        `document.readyState === "complete" && location.href !== ${JSON.stringify(before)}`,
        { timeoutMs: 15_000, pollMs: 250, desc: "history.back() to settle" },
      )
      .catch(() => {});
    return { isDone: false };
  },
};

export const CLICK: RegisteredAction = {
  name: "click",
  description:
    "Click an interactive element by its DOM index from the browser state. Use this for buttons, links, checkboxes, radio options.",
  terminatesSequence: false,
  params: {
    type: "object",
    properties: {
      index: {
        type: "integer",
        description: "The element's index in the interactive elements list (>= 1).",
      },
    },
    required: ["index"],
  },
  async execute(ctx, params: { index: number }) {
    const selector = ctx.resolveSelector(params.index);
    await ctx.page.click(selector);
    return { isDone: false };
  },
};

export const INPUT_TEXT: RegisteredAction = {
  name: "input_text",
  description:
    "Focus an input/textarea by DOM index, select its current value, and type the given text (replaces existing content).",
  terminatesSequence: false,
  params: {
    type: "object",
    properties: {
      index: {
        type: "integer",
        description: "The element's index in the interactive elements list (>= 1).",
      },
      text: {
        type: "string",
        description: "The text to type into the field.",
      },
    },
    required: ["index", "text"],
  },
  async execute(ctx, params: { index: number; text: string }) {
    const selector = ctx.resolveSelector(params.index);
    await ctx.page.fill(selector, params.text);
    return { isDone: false };
  },
};

export const SCROLL: RegisteredAction = {
  name: "scroll",
  description:
    "Scroll the page. With an index, bring that element into view. With a direction, scroll the window up or down by one viewport step.",
  terminatesSequence: false,
  params: {
    type: "object",
    properties: {
      index: {
        type: "integer",
        description: "DOM index of an element to scroll into view (>= 1).",
      },
      direction: {
        type: "string",
        enum: ["up", "down"],
        description: "Scroll the window up or down.",
      },
    },
  },
  async execute(ctx, params: { index?: number; direction?: "up" | "down" }) {
    if (params.index !== undefined) {
      const selector = ctx.resolveSelector(params.index);
      await ctx.page.scroll(selector);
      return { isDone: false };
    }
    const delta = params.direction === "up" ? -1 : 1;
    await ctx.page.evaluate((d: number) => {
      window.scrollBy({ top: d * window.innerHeight * 0.8, behavior: "smooth" });
    }, delta);
    return { isDone: false };
  },
};

export const WAIT: RegisteredAction = {
  name: "wait",
  description: "Wait for the given number of milliseconds (e.g. for async content).",
  terminatesSequence: false,
  params: {
    type: "object",
    properties: {
      ms: {
        type: "integer",
        description: "Milliseconds to wait.",
        default: 1000,
      },
    },
  },
  async execute(_ctx, params: { ms?: number }) {
    await new Promise((r) => setTimeout(r, params.ms ?? 1000));
    return { isDone: false };
  },
};

export const OPEN_TAB: RegisteredAction = {
  name: "open_tab",
  description: "Open a new browser tab, optionally at a URL, and switch to it.",
  terminatesSequence: true,
  params: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to open in the new tab.",
      },
    },
  },
  async execute(ctx, params: { url?: string }) {
    await ctx.openTab(params.url);
    return { isDone: false };
  },
};

export const SWITCH_TAB: RegisteredAction = {
  name: "switch_tab",
  description:
    "Switch the active tab. `tab_id` is the 4-character id shown in the browser state's tab list.",
  terminatesSequence: true,
  params: {
    type: "object",
    properties: {
      tab_id: {
        type: "string",
        description: "The 4-character tab id from the browser state tab list.",
      },
    },
    required: ["tab_id"],
  },
  async execute(ctx, params: { tab_id: string }) {
    await ctx.switchTab(params.tab_id);
    return { isDone: false };
  },
};

export const CLOSE_TAB: RegisteredAction = {
  name: "close_tab",
  description:
    "Close the tab with the given 4-character tab id. The browser state updates on the next step.",
  terminatesSequence: true,
  params: {
    type: "object",
    properties: {
      tab_id: {
        type: "string",
        description: "The 4-character tab id from the browser state tab list.",
      },
    },
    required: ["tab_id"],
  },
  async execute(ctx, params: { tab_id: string }) {
    await ctx.closeTab(params.tab_id);
    return { isDone: false };
  },
};

export const EXTRACT: RegisteredAction = {
  name: "extract",
  description:
    "Extract information from the current page for a given goal. Returns the extracted text; optionally runs a focused LLM extraction.",
  terminatesSequence: false,
  params: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "What to extract, e.g. 'the email in the footer' or 'all prices'.",
      },
    },
    required: ["goal"],
  },
  async execute(ctx, params: { goal: string }): Promise<ActionResult> {
    const pageText = await pageInnerText(ctx.page);
    if (!ctx.llm) {
      return {
        isDone: false,
        extractedContent: pageText,
        includeExtractedContentOnlyOnce: true,
      };
    }
    const prompt = [
      "Extract information from the page content below.",
      `Goal: "${params.goal}"`,
      "Reply with ONLY a JSON object: {\"extracted\": \"<the extracted text>\"}",
      "",
      "Page content:",
      pageText,
    ].join("\n");
    const res = await ctx.llm.chat(
      [{ role: "user", content: prompt }],
      { temperature: 0, responseFormat: { type: "json_object" } },
    );
    const extracted = parseExtracted(res.text) ?? pageText;
    return {
      isDone: false,
      extractedContent: extracted,
      includeExtractedContentOnlyOnce: true,
    };
  },
};

export const FIND_TEXT: RegisteredAction = {
  name: "find_text",
  description:
    "Find the deepest elements on the page whose text contains the given query and list them with their DOM index (if interactive).",
  terminatesSequence: false,
  params: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to search for.",
      },
    },
    required: ["text"],
  },
  async execute(ctx, params: { text: string }): Promise<ActionResult> {
    const matches = await ctx.page.evaluate<{ tag: string; text: string }[]>(
      (needle: string) => {
        const out: { tag: string; text: string }[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const seen = new Set<Element>();
        let node = walker.nextNode();
        while (node && out.length < 10) {
          const parent = node.parentElement;
          if (parent && !seen.has(parent)) {
            const text = node.textContent?.trim() ?? "";
            if (text && text.toLowerCase().includes(needle.toLowerCase())) {
              const copy = text.slice(0, 120);
              if (!parent.closest("script,style")) {
                out.push({ tag: parent.localName, text: copy });
                seen.add(parent);
              }
            }
          }
          node = walker.nextNode();
        }
        return out;
      },
      params.text,
    );
    return {
      isDone: false,
      extractedContent:
        matches.length > 0
          ? matches.map((m) => `<${m.tag}> "${m.text}"`).join("\n")
          : `No element text contains "${params.text}" on the current page.`,
      includeExtractedContentOnlyOnce: true,
    };
  },
};

export const SCREENSHOT: RegisteredAction = {
  name: "screenshot",
  description:
    "Capture a PNG screenshot of the current page and attach it to the next message.",
  terminatesSequence: false,
  params: { type: "object", properties: {} },
  async execute(ctx): Promise<ActionResult> {
    const data = await ctx.page.screenshot();
    return { isDone: false, images: [{ name: "current-page", data }] };
  },
};

export const EVALUATE: RegisteredAction = {
  name: "evaluate",
  description:
    "Run a JavaScript expression in the page and return its serialized value. Use for inspecting state; prefer click/input_text over manipulating elements directly.",
  terminatesSequence: true,
  params: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "A JavaScript expression whose result is JSON-serializable.",
      },
    },
    required: ["code"],
  },
  async execute(ctx, params: { code: string }): Promise<ActionResult> {
    const value = await ctx.page.evaluate(params.code);
    return {
      isDone: false,
      extractedContent:
        typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2).slice(0, MAX_EXTRACT_CHARS),
      includeExtractedContentOnlyOnce: true,
    };
  },
};

export function doneAction(): RegisteredAction {
  return {
    name: "done",
    description:
      "Complete the task. `success` reflects whether the goal was achieved; `text` is the final summary shown to the user. This is the ONLY way to end the session — always finish with done.",
    terminatesSequence: true,
    params: {
      type: "object",
      properties: {
        success: {
          type: "boolean",
          description: "Whether the task was completed successfully.",
        },
        text: {
          type: "string",
          description: "A concise summary of the result for the user.",
        },
      },
      required: ["success", "text"],
    },
    async execute(_ctx, params: { success: boolean; text: string }): Promise<ActionResult> {
      return { isDone: true, success: params.success, extractedContent: params.text };
    },
  };
}

const BUILTINS: RegisteredAction[] = [
  NAVIGATE,
  GO_BACK,
  CLICK,
  INPUT_TEXT,
  SCROLL,
  WAIT,
  OPEN_TAB,
  SWITCH_TAB,
  CLOSE_TAB,
  EXTRACT,
  FIND_TEXT,
  SCREENSHOT,
  EVALUATE,
];

export function builtinActions(): RegisteredAction[] {
  return [...BUILTINS];
}

export function registerBuiltins(register: (a: RegisteredAction) => void, withDone = true): void {
  for (const action of BUILTINS) register(action);
  if (withDone) register(doneAction());
}

export function actionSchema(action: { params: ActionParamsSchema }): ActionParamsSchema {
  return action.params;
}

async function pageInnerText(page: Page): Promise<string> {
  const text = await page.evaluate<string>(() => document.body?.innerText ?? "");
  return text.slice(0, MAX_EXTRACT_CHARS);
}

function parseExtracted(text: string): string | null {
  const trimmed = text.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(first, last + 1)) as {
      extracted?: unknown;
    };
    return typeof parsed.extracted === "string" ? parsed.extracted : null;
  } catch {
    return null;
  }
}
