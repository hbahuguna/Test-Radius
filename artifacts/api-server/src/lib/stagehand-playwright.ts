export interface StagehandRecordedAction {
  type?: string;
  action?: string;
  description?: string;
  reasoning?: string;
  pageUrl?: string;
  playwrightArguments?: unknown;
  [key: string]: unknown;
}

export interface StagehandTraceStep {
  stepNumber: number;
  url: string | null;
  actions: StagehandRecordedAction[];
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function selectorFromAction(action: StagehandRecordedAction): string | null {
  const candidates = [
    action.selector,
    action.playwrightSelector,
    typeof action.playwrightArguments === "object" && action.playwrightArguments !== null
      ? (action.playwrightArguments as Record<string, unknown>).selector
      : null,
  ];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0) ?? null;
}

function actionValue(action: StagehandRecordedAction): string | null {
  for (const key of ["value", "text", "input", "textToType"]) {
    if (typeof action[key] === "string") return action[key] as string;
  }
  return null;
}

function actionName(action: StagehandRecordedAction): string {
  return String(action.action ?? action.type ?? "").toLowerCase();
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
  const role = match[2]?.toLowerCase() === "button" || /button/i.test(instruction) ? "button" : "link";
  return `page.getByRole(${quote(role)}, { name: ${quote(label)} })`;
}

function actionCode(action: StagehandRecordedAction, warnings: string[]): string {
  const name = actionName(action);
  const selector = selectorFromAction(action);
  const value = actionValue(action);
  const locator = selector ? `page.locator(${quote(selector)})` : null;

  if (name === "keys" || name.includes("key")) {
    const key = typeof action.value === "string" ? action.value : typeof action.key === "string" ? action.key : null;
    if (key) return `    await page.keyboard.press(${quote(key)});`;
  }

  if (String(action.type).toLowerCase() === "act" && typeof action.action === "string") {
    const instruction = semanticInstruction(action);
    const semanticClick = semanticClickLocator(instruction);
    if (semanticClick) return `    await ${semanticClick}.click();`;
    const typeMatch = instruction.match(/(?:type|fill)\s+["'](.+?)["']\s+into\s+(.+)/i);
    if (typeMatch?.[1] && typeMatch[2]) {
      return `    await page.getByText(${quote(typeMatch[2].trim())}).fill(${quote(typeMatch[1])});`;
    }
  }

  if (name.includes("goto") || name.includes("navigate") || name.includes("url")) {
    const url = typeof action.url === "string" ? action.url : action.pageUrl;
    if (url) return `    await page.goto(${quote(url)});`;
  }
  if (name.includes("click")) {
    if (locator) return `    await ${locator}.click();`;
    const semanticClick = semanticClickLocator(semanticInstruction(action));
    if (semanticClick) return `    await ${semanticClick}.click();`;
    warnings.push("A Stagehand click action did not include a selector.");
    return "    // TODO: add a stable locator for the recorded click action.";
  }
  if (name.includes("fill") || name.includes("type") || name.includes("input")) {
    if (locator && value !== null) {
      return `    await ${locator}.fill(process.env.TEST_VALUE ?? ${quote(value)});`;
    }
    warnings.push("A Stagehand input action did not include both a selector and value.");
    return "    // TODO: add a stable locator and test value for the recorded input action.";
  }
  if (name.includes("scroll")) return "    await page.mouse.wheel(0, 600);";
  if (name === "wait") {
    const milliseconds = typeof action.timeMs === "number" ? action.timeMs : 1000;
    return `    await page.waitForTimeout(${milliseconds});`;
  }
  if (name.includes("wait")) return "    await page.waitForLoadState(\"domcontentloaded\");";

  warnings.push(`Unsupported Stagehand action: ${action.action ?? action.type ?? "unknown"}.`);
  return `    // TODO: implement ${String(action.action ?? action.type ?? "unknown")}.`;
}

export function generateStagehandPlaywrightScript(
  url: string,
  goal: string,
  trace: StagehandTraceStep[],
): { code: string; warnings: string[] } {
  const warnings: string[] = [];
  const lines = [
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
      if (["ariatree", "screenshot", "extract"].includes(actionName(action))) continue;
      lines.push("", `  await step(${quote(`Stagehand step ${traceStep.stepNumber}`)}, async () => {`);
      lines.push(actionCode(action, warnings));
      lines.push("  });");

      if (typeof action.pageUrl === "string" && action.pageUrl !== traceStep.url && action.pageUrl.startsWith("http")) {
        lines.push("", `  await step(${quote("Wait for navigation")}, async () => {`);
        lines.push(`    await page.waitForURL(${quote(action.pageUrl)});`);
        lines.push("  });");
      }
    }
  }

  if (trace.length === 0) {
    warnings.push("No Stagehand actions were recorded.");
    lines.push("", "  // TODO: implement the requested workflow; Stagehand recorded no actions.");
  }
  lines.push("}", "");
  return { code: lines.join("\n"), warnings };
}
