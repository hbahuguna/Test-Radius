/**
 * Goal planner: decomposes a natural language goal into ordered micro-steps
 * that a small language model can execute one at a time.
 *
 * The planner uses the same LLM but with a much simpler prompt — no page
 * state, no element list — just the goal, URL, and assertions. This works
 * even with 3B-active models because the task is pure text planning.
 */

import type { LLMFactory } from "./reasoning/llmFactory.js";
import { appendFileSync } from "fs";
import { join } from "path";

const LOG_FILE = join(process.cwd(), "logs", "agent-debug.log");
function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
}

export interface PlannedStep {
  id: number;
  instruction: string;
  action: "click" | "type" | "selectOption" | "scroll" | "wait" | "dismiss" | "verify";
  /** Keywords to match elements against (e.g. "Where from?", "Dehradun") */
  targetHint: string;
  /** Value for type actions */
  value?: string;
}

/**
 * Ask the LLM to break down a goal into ordered micro-steps.
 * No page state is provided — the planner focuses purely on strategy.
 */
export async function planGoal(
  llm: LLMFactory,
  goal: string,
  url: string,
  assertions: Array<Record<string, any>>,
): Promise<PlannedStep[]> {
  const assertLines = assertions.map((a) => `- ${a.type}: ${a.target ?? ""} ${a.value ?? ""}`).join("\n") || "(none)";

  const prompt = `You are a browser test planner. Break down this goal into ordered, atomic steps.

RULES:
- Each step must be a SINGLE action (click one element, type one field, etc.)
- Be SPECIFIC about what to click: use the element's visible text/label
- targetHint must be a substring of the element's name/label (e.g. "Quick search", "venv", "submit")
- Include a final verification step that checks the goal requirements are met
- After typing in a search box, always include a "click search/submit" step
- After clicking a link, include a "wait for page to load" step
- End with verification steps for each assertion

GOAL: ${goal}
URL: ${url}
ASSERTIONS:
${assertLines}

Output ONLY a JSON array. Each step:
{"id":1,"instruction":"Click the search box","action":"click","targetHint":"Quick search"}

The targetHint is CRITICAL — it must match text visible on the element. Use the element's label, placeholder, or visible text.

Output format: [{"id":1,"instruction":"...","action":"click","targetHint":"..."}, ...]`;

  const sysPrompt = "Output ONLY a JSON array. No prose, no markdown, no explanation. Start with [ and end with ].";

  const [name, out] = await llm.streamInfer(
    prompt,
    { onDelta: () => {} },
    2048,
    0,
    sysPrompt,
  );

  debugLog(`Planner raw output (${out.length} chars): ${out.slice(0, 800)}`);

  const steps = parsePlannerOutput(out);
  debugLog(`Planner parsed ${steps.length} steps`);
  for (const s of steps) {
    debugLog(`  Step ${s.id}: [${s.action}] ${s.instruction} (hint: ${s.targetHint})`);
  }

  return steps;
}

/**
 * Parse the planner's JSON array output into PlannedStep objects.
 * Handles common LLM quirks: code fences, trailing commas, partial JSON.
 */
function parsePlannerOutput(text: string): PlannedStep[] {
  // Strip code fences
  const cleaned = text
    .replace(/```(?:json|typescript|js)?/gi, "")
    .replace(/```/g, "")
    .trim();

  // Try to find a JSON array
  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");
  if (arrStart === -1 || arrEnd === -1 || arrEnd <= arrStart) {
    debugLog("Planner: no JSON array found in output");
    return [];
  }

  let jsonStr = cleaned.slice(arrStart, arrEnd + 1);
  // Fix trailing commas
  jsonStr = jsonStr.replace(/,\s*([\]}])/g, "$1");

  try {
    const raw = JSON.parse(jsonStr) as any[];
    return raw
      .filter((s) => s && typeof s.instruction === "string" && typeof s.action === "string")
      .map((s, i) => ({
        id: typeof s.id === "number" ? s.id : i + 1,
        instruction: String(s.instruction),
        action: normalizeAction(s.action),
        targetHint: String(s.targetHint || s.target || ""),
        value: typeof s.value === "string" ? s.value : undefined,
      }));
  } catch (e) {
    debugLog(`Planner: JSON parse failed: ${e}`);
    // Fallback: try to extract steps line by line
    return fallbackParse(cleaned);
  }
}

function normalizeAction(action: string): PlannedStep["action"] {
  const lower = action.toLowerCase().trim();
  if (lower === "click" || lower === "tap") return "click";
  if (lower === "type" || lower === "fill" || lower === "enter") return "type";
  if (lower === "select" || lower === "choose" || lower === "selectoption") return "selectOption";
  if (lower === "scroll") return "scroll";
  if (lower === "wait" || lower === "pause") return "wait";
  if (lower === "dismiss" || lower === "close") return "dismiss";
  if (lower === "verify" || lower === "check" || lower === "assert") return "verify";
  return "click"; // default
}

/**
 * Fallback parser: extracts steps from numbered lines when JSON fails.
 * Handles output like:
 *   1. Click the "Where from?" textbox
 *   2. Type "Dehradun"
 */
function fallbackParse(text: string): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const lines = text.split("\n");
  let id = 1;

  for (const line of lines) {
    const match = line.match(/^\d+[\.\)]\s*(.+)/);
    if (!match) continue;
    const instruction = match[1].trim();
    if (!instruction) continue;

    // Guess action from instruction
    let action: PlannedStep["action"] = "click";
    const lower = instruction.toLowerCase();
    if (lower.startsWith("type") || lower.includes("enter ") || lower.includes("fill ")) {
      action = "type";
    } else if (lower.startsWith("wait") || lower.includes("wait for")) {
      action = "wait";
    } else if (lower.startsWith("scroll")) {
      action = "scroll";
    } else if (lower.startsWith("dismiss") || lower.startsWith("close")) {
      action = "dismiss";
    } else if (lower.startsWith("verify") || lower.startsWith("check") || lower.startsWith("assert")) {
      action = "verify";
    } else if (lower.startsWith("select") || lower.startsWith("choose")) {
      action = "selectOption";
    }

    // Extract target hint: look for quoted text or label-like patterns
    const quoteMatch = instruction.match(/['""]([^'""]+)['""]/);
    const targetHint = quoteMatch?.[1] || instruction.slice(0, 40);

    // Extract value for type actions
    let value: string | undefined;
    if (action === "type") {
      const typeMatch = instruction.match(/(?:type|enter|fill)\s+['""]([^'""]+)['""]/i);
      value = typeMatch?.[1];
    }

    steps.push({ id: id++, instruction, action, targetHint, value });
  }

  return steps;
}
