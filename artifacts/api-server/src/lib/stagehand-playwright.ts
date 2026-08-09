export interface StagehandRecordedAction {
  type?: string;
  action?: string;
  description?: string;
  reasoning?: string;
  pageUrl?: string;
  selector?: string;
  value?: string;
  key?: string;
  url?: string;
  timeMs?: number;
  success?: boolean;
  scrolledPixels?: number;
  field?: string;
  /** Arguments from the Stagehand agent onEvidence step_finished event. */
  actionArgs?: Record<string, unknown>;
  /** Machine-readable output extracted from the run (when an output schema was set). */
  output?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StagehandTraceStep {
  stepNumber: number;
  url: string | null;
  actions: StagehandRecordedAction[];
}

export interface StagehandGeneratedScript {
  code: string;
  warnings: string[];
}

/**
 * Optional final-state assertions spliced into the generated script. `url` is
 * asserted with `waitForURL`, `text` with a `getByText(...).waitFor(...)`.
 */
export interface StagehandCompletionAssertion {
  url?: string;
  text?: string;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Read a nested string value from an action, checking direct properties first,
 * then properties nested under each of the provided object keys (e.g. actionArgs).
 */
function nestedString(action: StagehandRecordedAction, keys: string[], roots: Array<Array<keyof StagehandRecordedAction>>): string | null {
  for (const path of roots) {
    let root: unknown = action;
    let valid = true;
    for (const key of path) {
      const record = root as Record<string, unknown>;
      if (record && typeof record === "object" && key in record) root = record[key];
      else {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    const record = root as Record<string, unknown>;
    if (record && typeof record === "object") {
      for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
      for (const key of keys) {
        const value = record[key];
        if (typeof value === "number") return String(value);
      }
    }
  }
  return null;
}

const ROOT_PATHS: Array<Array<keyof StagehandRecordedAction>> = [[], ["actionArgs"], ["playwrightArguments"]];
const ARG_PATHS: Array<Array<keyof StagehandRecordedAction>> = [["actionArgs"], ["playwrightArguments"]];

function selectorValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.selector === "string" && record.selector.length > 0) return record.selector;
  }
  return null;
}

function selectorFromAction(action: StagehandRecordedAction): string | null {
  const direct = selectorValue(action.selector);
  if (direct) return direct;
  const fromArgs = nestedString(action, ["selector", "element", "target", "name"], ARG_PATHS);
  if (fromArgs) return fromArgs;
  if (typeof action.playwrightArguments === "object" && action.playwrightArguments !== null) {
    const args = action.playwrightArguments as Record<string, unknown>;
    const nested = selectorValue(args.selector) ?? selectorValue(args.element);
    if (nested) return nested;
    const single = Object.entries(args)[0];
    if (single && single[0] && !Array.isArray(single[1])) {
      const params = single[1] as Record<string, unknown>;
      if (params && typeof params === "object") {
        const nestedSel = selectorValue(params.selector);
        if (nestedSel) return nestedSel;
      }
    }
  }
  return null;
}

function actionValue(action: StagehandRecordedAction): string | null {
  return (
    nestedString(action, ["value", "text", "name", "input", "textToType", "valueToType", "textToType"], ROOT_PATHS) ??
    (typeof action.token === "string" ? action.token : null)
  );
}

function actionKey(action: StagehandRecordedAction): string | null {
  return (
    nestedString(action, ["key", "keyName", "keyboard", "keyToPress"], ARG_PATHS) ??
    (typeof action.key === "string" ? action.key : null)
  );
}

function actionOption(action: StagehandRecordedAction): string | null {
  return nestedString(action, ["option", "selectOption", "value", "label"], ARG_PATHS);
}

function actionName(action: StagehandRecordedAction): string {
  const name = String(action.action ?? action.type ?? "").toLowerCase();
  return name.split("(")[0].trim();
}

function semanticInstruction(action: StagehandRecordedAction): string {
  return String(action.description ?? action.action ?? "").trim();
}

function semanticClickLocator(instruction: string): string | null {
  const roleMatch = instruction.match(/(?:click|see)(?:\s+the)?\s+(.+?)\s+(link|button)\b/i);
  if (roleMatch?.[1]) {
    const role = roleMatch[2].toLowerCase();
    const label = roleMatch[1].trim().replace(/[.!]+$/, "");
    return `page.getByRole(${quote(role)}, { name: ${quote(label)} })`;
  }
  const match = instruction.match(/click(?:\s+the)?\s+(.+?)[.!]?$/i);
  if (!match?.[1]) return null;
  const label = match[1].trim().replace(/[.!]+$/, "");
  const role = /button/i.test(instruction) ? "button" : "link";
  return `page.getByRole(${quote(role)}, { name: ${quote(label)} })`;
}

function textboxLocator(instruction: string): string | null {
  const match = instruction.match(/(?:type|fill|enter)\s+["'](.+?)["']\s+into(?:\s+the)?\s+(.+)/i);
  if (!match?.[1] || !match[2]) return null;
  const label = match[2].trim().replace(/[.!]+$/, "");
  return `page.getByLabel(${quote(label)})`;
}

function handleAct(action: StagehandRecordedAction, locator: string | null, value: string | null, warnings: string[]): string | null {
  const instruction = semanticInstruction(action);
  const lower = instruction.toLowerCase();

  if (locator && value !== null) {
    if (/select/i.test(lower)) return `    await ${locator}.selectOption(${quote(value)});`;
    if (/choose|radio|check/i.test(lower)) return `    await ${locator}.check();`;
    return `    await ${locator}.fill(process.env.TEST_VALUE ?? ${quote(value)});`;
  }

  const typeMatch = instruction.match(/(?:type|fill|enter)\s+["'](.+?)["']\s+into(?:\s+the)?\s+(.+)/i);
  if (typeMatch?.[1] && typeMatch[2]) {
    const textbox = textboxLocator(instruction);
    if (textbox) return `    await ${textbox}.fill(process.env.TEST_VALUE ?? ${quote(typeMatch[1])});`;
  }

  const semanticClick = semanticClickLocator(instruction);
  if (semanticClick && !/(fill|type|enter)/i.test(lower)) return `    await ${semanticClick}.click();`;

  if (locator) return `    await ${locator}.click();`;

  if (/press|key/i.test(lower)) {
    const key = actionKey(action) ?? actionValue(action) ?? "Enter";
    return `    await page.keyboard.press(${quote(key)});`;
  }

  warnings.push("A Stagehand act action did not include a usable selector or value.");
  return "    // TODO: add a stable locator for the recorded action.";
}

const CONCRETE_METHODS = new Set([
  "click", "fill", "type", "input", "select", "check", "uncheck", "choose",
  "hover", "focus", "press", "keys", "scroll", "goto", "navigate", "back",
  "wait", "selectoption", "navback",
]);

function actionCode(action: StagehandRecordedAction, warnings: string[]): string {
  const name = actionName(action);
  const selector = selectorFromAction(action);
  const locator = selector ? `page.locator(${quote(selector)})` : null;
  const value = actionValue(action);
  const key = actionKey(action);
  const isAct = String(action.type).toLowerCase() === "act" || name === "act";

  // Act actions with a concrete method (click/fill/select/...) are routed to
  // the specific handlers below. Only purely-semantic act instructions use the
  // description-driven fallback so explicit content is not lost.
  if (isAct && !CONCRETE_METHODS.has(name)) {
    const code = handleAct(action, locator, value, warnings);
    if (code) return code;
  }

  // Keyboard
  if (name === "keys" || name.includes("press")) {
    const target = key ?? value ?? action.value ?? action.key ?? "Enter";
    return `    await page.keyboard.press(${quote(target)});`;
  }

  // Navigation
  if (name === "back" || name.includes("navback")) return `    await page.goBack();`;
  if (name.includes("goto") || name.includes("navigate")) {
    const url = action.url ?? action.pageUrl ?? selector;
    if (url && url.startsWith("http")) return `    await page.goto(${quote(url)});`;
  }

  // Explicit clicks
  if (name.includes("click")) {
    if (locator) return `    await ${locator}.click();`;
    const semanticClick = semanticClickLocator(semanticInstruction(action));
    if (semanticClick) return `    await ${semanticClick}.click();`;
    warnings.push("A Stagehand click action did not include a selector.");
    return "    // TODO: add a stable locator for the recorded click action.";
  }

  // Checkbox / radio
  if (name.includes("uncheck")) {
    if (locator) return `    await ${locator}.uncheck();`;
    warnings.push("A Stagehand uncheck action did not include a selector.");
    return "    // TODO: add a stable locator for the recorded uncheck action.";
  }
  if (name.includes("check")) {
    if (locator) return `    await ${locator}.check();`;
    warnings.push("A Stagehand check action did not include a selector.");
    return "    // TODO: add a stable locator for the recorded check action.";
  }

  // Select (dropdown)
  if (name.includes("select") || name.includes("choose")) {
    if (locator) {
      const option = actionOption(action) ?? value;
      if (option !== null) return `    await ${locator}.selectOption(${quote(option)});`;
      return `    await ${locator}.selectOption({ index: 0 });`;
    }
    warnings.push("A Stagehand select action did not include a selector.");
    return "    // TODO: add a stable locator for the recorded select action.";
  }

  // Hover / focus
  if (name.includes("hover")) {
    if (locator) return `    await ${locator}.hover();`;
    warnings.push("A Stagehand hover action did not include a selector.");
    return "    // TODO: add a stable locator for the recorded hover action.";
  }
  if (name.includes("focus")) {
    if (locator) return `    await ${locator}.focus();`;
    warnings.push("A Stagehand focus action did not include a selector.");
    return "    // TODO: add a stable locator for the recorded focus action.";
  }

  // Text entry
  if (name.includes("fill") || name.includes("type") || name.includes("input")) {
    if (locator && value !== null) return `    await ${locator}.fill(process.env.TEST_VALUE ?? ${quote(value)});`;
    if (value !== null) {
      warnings.push("A Stagehand input action included a value but no selector.");
      return `    // TODO: type ${quote(value)} into the target field.`;
    }
    warnings.push("A Stagehand input action did not include both a selector and value.");
    return "    // TODO: add a stable locator and test value for the recorded input action.";
  }

  // Scroll
  if (name.includes("scroll")) {
    const direction = semanticInstruction(action).toLowerCase();
    const distance = typeof action.scrolledPixels === "number" ? action.scrolledPixels : /up|top/i.test(direction) ? -600 : 600;
    return `    await page.mouse.wheel(0, ${distance});`;
  }

  // Waits
  if (name === "wait") {
    const milliseconds = typeof action.timeMs === "number" ? action.timeMs : 1000;
    return `    await page.waitForTimeout(${milliseconds});`;
  }
  if (name.includes("wait")) return `    await page.waitForLoadState("domcontentloaded");`;

  // Extract → instruct the user to assert rather than reproduce the extraction.
  if (name.includes("extract")) {
    warnings.push("An extract action was recorded; add explicit assertions over the extracted data.");
    return "    // TODO: assert the extracted data (e.g. expect(page.getByText(...)).toBeVisible()).";
  }

  warnings.push(`Unsupported Stagehand action: ${action.action ?? action.type ?? "unknown"}.`);
  return `    // TODO: implement ${String(action.action ?? action.type ?? "unknown")}.`;
}

function outputAssertions(output: Record<string, unknown> | null | undefined): string[] {
  if (!output) return [];
  const lines: string[] = [];
  const visit = (key: string, raw: unknown): void => {
    if (raw === null || raw === undefined) return;
    if (typeof raw === "string" && raw.length > 0) {
      const clean = raw.replace(/\n/g, " ");
      lines.push(`  await step(${quote(`assert ${key}`)}, async () => {`);
      lines.push(`    await page.getByText(${quote(clean)}, { exact: false }).first().waitFor({ timeout: 10_000 });`);
      lines.push("  });");
      return;
    }
    if (typeof raw === "object") {
      for (const [subKey, subRaw] of Object.entries(raw as Record<string, unknown>)) {
        visit(typeof subKey === "number" ? `${key}[${subKey}]` : `${key}.${subKey}`, subRaw);
      }
    }
  };
  for (const [key, raw] of Object.entries(output)) visit(key, raw);
  return lines;
}

function completionAssertions(completion: StagehandCompletionAssertion | null | undefined): string[] {
  if (!completion) return [];
  const lines: string[] = [];
  if (typeof completion.url === "string" && completion.url.length > 0) {
    lines.push(`  await step(${quote("Assert landed on the final URL")}, async () => {`);
    lines.push(`    await page.waitForURL((currentUrl) => currentUrl.href.includes(${quote(completion.url)}), { timeout: 10_000 });`);
    lines.push("  });");
  }
  if (typeof completion.text === "string" && completion.text.length > 0) {
    const clean = completion.text.replace(/\n/g, " ");
    lines.push(`  await step(${quote("Assert expected final content")}, async () => {`);
    lines.push(`    await page.getByText(${quote(clean)}, { exact: false }).first().waitFor({ timeout: 10_000 });`);
    lines.push("  });");
  }
  return lines;
}

export function generateStagehandPlaywrightScript(
  url: string,
  goal: string,
  trace: StagehandTraceStep[],
  output?: Record<string, unknown> | null,
  completion?: StagehandCompletionAssertion | null,
): StagehandGeneratedScript {
  const warnings: string[] = [];
  const lines: string[] = [
    "/**",
    " * Generated from a TestRadius Stagehand action trace.",
    ` * Goal: ${goal.replace(/\*\//g, "* /")}`,
    " * Review selectors and warnings before reuse.",
    " */",
    "",
    "import type { Page } from \"playwright\";",
    "",
    "export default async function run({",
    "  page,",
    "  step,",
    "}: {",
    "  page: Page;",
    "  step: (name: string, action: () => Promise<void>) => Promise<void>;",
    "}) {",
    `  await step(${quote("Open the starting page")}, async () => {`,
    `    await page.goto(${quote(url)});`,
    "  });",
  ];

  for (const traceStep of trace) {
    for (const action of traceStep.actions) {
      const name = actionName(action);
      if (["ariatree", "screenshot"].includes(name)) continue;
      lines.push("", `  await step(${quote(`Stagehand step ${traceStep.stepNumber}`)}, async () => {`);
      lines.push(actionCode(action, warnings));
      lines.push("  });");

      if (
        typeof action.pageUrl === "string" &&
        action.pageUrl !== traceStep.url &&
        action.pageUrl.startsWith("http") &&
        !name.includes("goto") &&
        !name.includes("navigate")
      ) {
        lines.push("", `  await step(${quote("Wait for navigation")}, async () => {`);
        lines.push(`    await page.waitForURL(${quote(action.pageUrl)});`);
        lines.push("  });");
      }
    }
  }

  for (const assertionLine of outputAssertions(output)) {
    lines.splice(lines.length - 1, 0, assertionLine);
  }
  for (const completionLine of completionAssertions(completion)) {
    lines.splice(lines.length - 1, 0, completionLine);
  }

  if (trace.length === 0) {
    warnings.push("No Stagehand actions were recorded.");
    lines.push("", "  // TODO: implement the requested workflow; Stagehand recorded no actions.");
  }
  lines.push("}", "");
  return { code: lines.join("\n"), warnings };
}