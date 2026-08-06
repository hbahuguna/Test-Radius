export interface GeneratedAction {
  action: string;
  raw: unknown;
  element: Record<string, unknown> | null;
}

export interface GeneratedTraceStep {
  stepNumber: number;
  url: string | null;
  title: string | null;
  actions: GeneratedAction[];
}

export interface GeneratedScriptResult {
  code: string;
  warnings: string[];
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function rawAction(action: GeneratedAction): { name: string; params: Record<string, unknown> } {
  if (action.raw && typeof action.raw === "object" && !Array.isArray(action.raw)) {
    const entries = Object.entries(action.raw as Record<string, unknown>);
    if (entries.length === 1) {
      const [name, params] = entries[0];
      if (params && typeof params === "object" && !Array.isArray(params)) {
        return { name, params: params as Record<string, unknown> };
      }
    }
    return { name: action.action.split("(")[0], params: action.raw as Record<string, unknown> };
  }
  return { name: action.action.split("(")[0], params: {} };
}

function locatorFor(element: Record<string, unknown> | null): string | null {
  if (!element) return null;
  const attributes = element.attributes && typeof element.attributes === "object"
    ? element.attributes as Record<string, unknown>
    : {};
  const name = typeof element.ax_name === "string" ? element.ax_name.trim() : "";
  const node = typeof element.node_name === "string" ? element.node_name.toLowerCase() : "";

  if (typeof attributes.id === "string" && attributes.id.trim()) {
    return `page.locator(${quote(`#${attributes.id}`)})`;
  }
  if ((node === "button" || node === "a") && name) {
    return `page.getByRole(${quote(node === "a" ? "link" : "button")}, { name: ${quote(name)} })`;
  }
  if (typeof attributes["aria-label"] === "string" && attributes["aria-label"].trim()) {
    return `page.getByLabel(${quote(attributes["aria-label"] as string)})`;
  }
  if (typeof attributes.placeholder === "string" && attributes.placeholder.trim()) {
    return `page.getByPlaceholder(${quote(attributes.placeholder as string)})`;
  }
  if (name) return `page.getByText(${quote(name)})`;
  if (typeof element.x_path === "string" && element.x_path.startsWith("/")) {
    return `page.locator(${quote(`xpath=${element.x_path}`)})`;
  }
  return null;
}

function actionParams(action: GeneratedAction): { name: string; params: Record<string, unknown> } {
  return rawAction(action);
}

export function generatePlaywrightScript(
  url: string,
  goal: string,
  trace: GeneratedTraceStep[],
): GeneratedScriptResult {
  const warnings: string[] = [];
  const lines: string[] = [
    "/**",
    " * Generated from a successful TestRadius Browser Agent trace.",
    ` * Goal: ${goal.replace(/\*\//g, "* /")}`,
    " * Review locator warnings before using this in production.",
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
    `  await step(${quote("Open the starting page")}, async () => {` ,
    `    await page.goto(${quote(url)});`,
    "  });",
  ];

  if (trace.length === 0) {
    const goalLower = goal.toLowerCase();
    lines.push("");
    lines.push(`  await step(${quote("Goal-focused interaction")}, async () => {`);
    if (goalLower.includes("click") || goalLower.includes("sign in") || goalLower.includes("submit")) {
      lines.push("    // TODO: Locate and click the target element (e.g., a button or link).");
      lines.push("    // Consider using page.getByRole('button', { name: /.../ }) for robust matching.");
    } else if (goalLower.includes("fill") || goalLower.includes("enter") || goalLower.includes("type")) {
      lines.push("    // TODO: Locate the input field and fill it with the desired value.");
      lines.push("    // Consider using page.getByLabel(...) or page.getByPlaceholder(...) for form fields.");
    } else if (goalLower.includes("extract") || goalLower.includes("get") || goalLower.includes("find") || goalLower.includes("collect") || goalLower.includes("scrape")) {
      lines.push("    // TODO: Extract the target information from the page.");
      lines.push("    // Use page.textContent(...), page.locator(...).allTextContents(), or page.evaluate(...)");
    } else if (goalLower.includes("search") || goalLower.includes("navigate") || goalLower.includes("go to")) {
      lines.push("    // TODO: Perform the search or navigation action described in the goal.");
    } else if (goalLower.includes("verify") || goalLower.includes("assert") || goalLower.includes("check")) {
      lines.push("    // TODO: Assert the expected condition on the page.");
      lines.push("    // Use expect(page.locator(...)).toBeVisible() or similar Playwright assertions.");
    } else {
      lines.push("    // TODO: Implement the action described in the goal.");
    }
    lines.push("    // Placeholder: no recorded actions were available for this step.");
    lines.push("    await page.waitForLoadState(\"domcontentloaded\");");
    lines.push("  });");

    lines.push("");
    lines.push("  await step(\"Wait for page to load\", async () => {");
    lines.push("    await page.waitForLoadState(\"networkidle\");");
    lines.push("  });");
  }

  for (const traceStep of trace) {
    for (const action of traceStep.actions) {
      const { name, params } = actionParams(action);
      const label = action.action || name;
      const locator = locatorFor(action.element);
      const lower = name.toLowerCase();
      const value = params.text ?? params.value ?? params.input;
      const targetUrl = params.url ?? params.new_url ?? params.href;
      lines.push("", `  await step(${quote(`Step ${traceStep.stepNumber}: ${label}`)}, async () => {`);

      if (lower.includes("go_to_url") || lower === "navigate" || lower === "open_tab") {
        if (typeof targetUrl === "string" && targetUrl) {
          lines.push(`    await page.goto(${quote(targetUrl)});`);
        } else {
          warnings.push(`Step ${traceStep.stepNumber}: navigation URL was not captured.`);
          lines.push("    // TODO: add the target URL for this navigation.");
        }
      } else if (lower.includes("input_text") || lower.includes("type") || lower.includes("fill")) {
        if (locator && typeof value === "string") {
          lines.push(`    await ${locator}.fill(process.env.TEST_VALUE ?? ${quote(value)});`);
        } else {
          warnings.push(`Step ${traceStep.stepNumber}: input action has no stable locator or value.`);
          lines.push("    // TODO: replace this action with a stable locator and value.");
        }
      } else if (lower.includes("click") || lower.includes("press") || lower.includes("select")) {
        if (locator) {
          lines.push(`    await ${locator}.${lower.includes("press") ? `press(${quote(String(value ?? "Enter"))})` : "click()"};`);
        } else {
          warnings.push(`Step ${traceStep.stepNumber}: ${name} has no stable locator.`);
          lines.push("    // TODO: replace this action with a stable locator.");
        }
      } else if (lower.includes("scroll")) {
        lines.push("    await page.mouse.wheel(0, 600);");
      } else if (lower.includes("wait")) {
        lines.push("    await page.waitForLoadState(\"domcontentloaded\");");
      } else if (lower.includes("done") || lower.includes("extract")) {
        lines.push(`    // ${label.replace(/\n/g, " ")}`);
      } else {
        warnings.push(`Step ${traceStep.stepNumber}: unsupported action ${name}.`);
        lines.push(`    // TODO: implement ${label.replace(/\n/g, " ")}.`);
      }
      lines.push("  });");
    }
  }

  lines.push("}", "");
  return { code: lines.join("\n"), warnings };
}
