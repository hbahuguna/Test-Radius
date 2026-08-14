import type { Step } from "../cache/types.js";

export function describeLocator(
  step: Pick<Step, "locators" | "selector">,
): string {
  const locators = step.locators ?? [];
  const textLoc = locators.find((l) => l.startsWith('text="'));
  if (textLoc) return `"${textLoc.slice(6, -1)}"`;
  return locators[0] ?? step.selector ?? "?";
}

export function stepToEnglish(step: Step): string {
  switch (step.action) {
    case "navigate":
      return `Navigate to ${step.value}`;
    case "click":
      return `Click ${describeLocator(step)}`;
    case "fill":
      return `Fill ${describeLocator(step)} with "${step.value ?? ""}"`;
    case "select":
      return `Select "${step.value ?? ""}" in ${describeLocator(step)}`;
    case "scroll":
      return `Scroll ${describeLocator(step)} into view`;
    case "extract":
      return `Extract value from ${describeLocator(step)}`;
    case "assert": {
      const assertion = step.assertion;
      if (assertion?.op === "visible") {
        return `Assert ${step.selector ?? "?"} is visible`;
      }
      if (assertion?.op === "text") {
        return `Assert ${step.selector ?? "?"} contains text "${String(assertion.expected ?? "")}"`;
      }
      if (assertion?.op === "url") {
        return `Assert URL contains "${String(assertion.expected ?? "")}"`;
      }
      return `Assert ${String(assertion?.op)}`;
    }
    default:
      return `Perform "${String(step.action)}"`;
  }
}

export function renderChecklist(steps: Step[]): string {
  if (steps.length === 0) return "  (no steps)";
  return steps.map((s, i) => `  ${i + 1}. ${stepToEnglish(s)}`).join("\n");
}
