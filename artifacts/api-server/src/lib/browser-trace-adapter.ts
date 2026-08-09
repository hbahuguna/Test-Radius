import {
  generateStagehandPlaywrightScript,
  type StagehandCompletionAssertion,
  type StagehandGeneratedScript,
  type StagehandRecordedAction,
  type StagehandTraceStep,
} from "./stagehand-playwright";
import type { GeneratedAction, GeneratedTraceStep } from "./playwright-script";

/**
 * Adapts a browser-use action trace (GeneratedTraceStep[]) into the input format
 * consumed by Stagehand's Playwright generator, then reuses that generator so
 * browser-use runs get Stagehand-quality Playwright code.
 *
 * Design decisions:
 *  - Interaction verbs are derived from the browser-use action class names and
 *    normalized to Stagehand's action vocabulary (click / fill / keys / goto /
 *    select / check / uncheck / scroll / wait).
 *  - Locators prefer semantic keys: when an `element` carries an accessible name
 *    or aria-label, we hand Stagehand a natural-language `description` so it
 *    emits getByRole/getByLabel. Only when no accessible name exists do we fall
 *    back to the exact XPath (`element.x_path`), which Stagehand wraps in
 *    `page.locator(...)`.
 *  - Redacted browser-use input values (`{{TEST_VALUE}}`) are carried through as
 *    `value`; the Stagehand generator fills with `process.env.TEST_VALUE`.
 */

interface ElementInfo {
  name: string;
  node: string;
  ariaLabel: string;
  placeholder: string;
  xpath: string;
}

function elementInfo(element: Record<string, unknown> | null): ElementInfo {
  const attributes = element && typeof element.attributes === "object"
    ? element.attributes as Record<string, unknown>
    : {};
  return {
    name: typeof element?.ax_name === "string" ? String(element.ax_name).trim() : "",
    node: typeof element?.node_name === "string" ? String(element.node_name).toLowerCase() : "",
    ariaLabel: typeof attributes["aria-label"] === "string" ? String(attributes["aria-label"]).trim() : "",
    placeholder: typeof attributes.placeholder === "string" ? String(attributes.placeholder).trim() : "",
    xpath: typeof element?.x_path === "string" && String(element.x_path).startsWith("/") ? String(element.x_path) : "",
  };
}

function singleParams(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length === 1 && entries[0][1] && typeof entries[0][1] === "object" && !Array.isArray(entries[0][1])) {
      return entries[0][1] as Record<string, unknown>;
    }
    return raw as Record<string, unknown>;
  }
  return {};
}

function firstString(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function normalizeVerb(action: GeneratedAction): string {
  const cls = String(action.action ?? "").split("(")[0].trim().toLowerCase();
  let rawKey = "";
  if (action.raw && typeof action.raw === "object" && !Array.isArray(action.raw)) {
    const entries = Object.entries(action.raw as Record<string, unknown>);
    if (entries.length === 1) rawKey = String(entries[0][0]).toLowerCase();
  }
  const hay = `${cls} ${rawKey}`;
  if (/uncheck/.test(hay)) return "uncheck";
  if (/(?:click|tap)/.test(hay) && !/press_key|send_enter/.test(hay)) return "click";
  if (/(?:go_to_url|goto|navigate|open_url)/.test(hay)) return "goto";
  if (/select_option/.test(hay) || /\bselect\b/.test(hay)) return "select";
  if (/(?:input_text|type|fill|send_text)/.test(hay)) return "input";
  if (/(?:send_keys|send_key|press_key|keyboard|send_enter)/.test(hay)) return "keys";
  if (/scroll/.test(hay)) return "scroll";
  if (/checkbox|check\b/.test(hay)) return "check";
  if (/(?:wait|delay)/.test(hay)) return "wait";
  if (/(?:done|stop)/.test(hay)) return "done";
  return "act";
}

interface ClickLocator {
  description?: string;
  selector?: string;
}

function clickLocator(element: Record<string, unknown> | null): ClickLocator {
  const info = elementInfo(element);
  const role = info.node === "a" ? "link" : info.node === "button" ? "button" : "";
  const label = info.name || info.ariaLabel;
  if (role && label) return { description: `click the ${label} ${role}` };
  if (label) return { description: `click the ${label}` };
  if (info.xpath) return { selector: `xpath=${info.xpath}` };
  if (info.placeholder) return { description: `click the ${info.placeholder} button` };
  return {};
}

interface InputLocator {
  label?: string;
  selector?: string;
}

function inputLocator(element: Record<string, unknown> | null): InputLocator {
  const info = elementInfo(element);
  const label = info.ariaLabel || info.placeholder || info.name;
  if (label) return { label };
  if (info.xpath) return { selector: `xpath=${info.xpath}` };
  return {};
}

function toStagehandAction(stepUrl: string | null, action: GeneratedAction): StagehandRecordedAction | null {
  const verb = normalizeVerb(action);
  const params = singleParams(action.raw);
  const base: StagehandRecordedAction = { pageUrl: stepUrl ?? undefined };

  switch (verb) {
    case "done":
      return null;

    case "click": {
      const loc = clickLocator(action.element);
      return { ...base, type: "act", action: loc.description ?? "click", description: loc.description, selector: loc.selector };
    }

    case "input": {
      const value = firstString(params, ["text", "value", "input"]) ?? "";
      const loc = inputLocator(action.element);
      if (loc.label) {
        const description = `type ${JSON.stringify(value)} into ${loc.label}`;
        return { ...base, type: "act", action: description, description, value };
      }
      return { ...base, type: "fill", action: "fill", value: value || undefined, selector: loc.selector };
    }

    case "keys": {
      const key = firstString(params, ["key", "keyToPress", "value"]) ?? "Enter";
      return { ...base, type: "keys", action: "keys", key };
    }

    case "goto": {
      const url = firstString(params, ["url", "new_url", "href"]);
      if (url) return { ...base, type: "goto", action: "goto", url };
      return { ...base, type: "wait", action: "wait" };
    }

    case "select": {
      const option = firstString(params, ["option", "value", "label"]) ?? "";
      const selector = elementInfo(action.element).xpath
        ? `xpath=${elementInfo(action.element).xpath}` : undefined;
      return { ...base, type: "select", action: "select", selector, value: option || undefined };
    }

    case "scroll": {
      const amount = params["amount"] ?? params["scroll_amount"] ?? params["distance"];
      const distance = typeof amount === "number" ? amount : /up|top/i.test(String(params["direction"] ?? "")) ? -600 : 600;
      return { ...base, type: "scroll", action: "scroll", scrolledPixels: distance };
    }

    case "check": {
      const selector = elementInfo(action.element).xpath ? `xpath=${elementInfo(action.element).xpath}` : undefined;
      return { ...base, type: "check", action: "check", selector };
    }

    case "uncheck": {
      const selector = elementInfo(action.element).xpath ? `xpath=${elementInfo(action.element).xpath}` : undefined;
      return { ...base, type: "uncheck", action: "uncheck", selector };
    }

    case "wait": {
      const timeMs = typeof params["time_ms"] === "number" ? params["time_ms"] as number : undefined;
      return { ...base, type: "wait", action: "wait", timeMs };
    }

    default: {
      const info = elementInfo(action.element);
      const description = `click ${info.name || info.ariaLabel || info.placeholder}`.trim();
      return { ...base, type: "act", action: description || "interact", description: description || undefined, selector: info.xpath ? `xpath=${info.xpath}` : undefined };
    }
  }
}

export function toStagehandTrace(steps: GeneratedTraceStep[]): StagehandTraceStep[] {
  const result: StagehandTraceStep[] = [];
  for (const step of steps) {
    const actions = (step.actions ?? [])
      .map((action) => toStagehandAction(step.url, action))
      .filter((action): action is StagehandRecordedAction => Boolean(action));
    if (actions.length === 0) continue;
    result.push({ stepNumber: step.stepNumber, url: step.url, actions });
  }
  return result;
}

function finalCompletion(steps: GeneratedTraceStep[]): StagehandCompletionAssertion | undefined {
  const urls = steps
    .map((s) => s.url)
    .filter((url): url is string => typeof url === "string" && /^https?:/i.test(url));
  const url = urls[urls.length - 1];
  if (!url) return undefined;
  const completion: StagehandCompletionAssertion = { url };
  const finalTitle = steps[steps.length - 1]?.title;
  if (typeof finalTitle === "string" && finalTitle.trim().length >= 4) {
    completion.text = finalTitle.trim();
  }
  return completion;
}

export function browserGenerateStagehandScript(
  url: string,
  goal: string,
  steps: GeneratedTraceStep[],
): StagehandGeneratedScript {
  const trace = toStagehandTrace(steps);
  const completion = finalCompletion(steps);
  return generateStagehandPlaywrightScript(url, goal, trace, null, completion);
}