/**
 * Step executor: executes a single planned step using the small model.
 *
 * Unlike the reactive executor which gives the LLM the full goal + all elements,
 * the step executor gives the model ONLY:
 *   1. The single step instruction
 *   2. A filtered list of relevant elements
 *
 * This dramatically reduces cognitive load on small (3B-active) models.
 */

import type { LLMFactory } from "./reasoning/llmFactory.js";
import type { SnapshotElement } from "./tools/browserTools.js";
import { appendFileSync } from "fs";
import { join } from "path";

const LOG_FILE = join(process.cwd(), "logs", "agent-debug.log");
function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
}

export interface StepResult {
  action: string;
  target?: string;
  value?: string;
  thought?: string;
}

/**
 * Filter elements to only those relevant to the current step.
 * Uses the targetHint to find elements whose name/description matches.
 */
export function filterElements(
  elements: SnapshotElement[],
  targetHint: string,
  action: string,
): SnapshotElement[] {
  if (!targetHint) return elements.slice(0, 10); // no hint → top 10

  const hint = targetHint.toLowerCase();
  const scored = elements.map((el) => {
    const name = (el.name || "").toLowerCase();
    const desc = (el.description || "").toLowerCase();
    let score = 0;

    // Exact match in name
    if (name.includes(hint) || hint.includes(name)) score += 10;
    // Partial word match
    const hintWords = hint.split(/\s+/);
    for (const word of hintWords) {
      if (word.length > 2 && (name.includes(word) || desc.includes(word))) score += 3;
    }
    // Role bonus: prefer matching element types
    if (action === "click" && (el.role === "button" || el.role === "link" || el.role === "combobox")) score += 2;
    if (action === "type" && el.editable) score += 5;
    if (action === "type" && el.role === "combobox") score += 3;
    if (action === "selectOption" && el.role === "option") score += 5;

    return { element: el, score };
  });

  // Sort by score descending, take top matches
  scored.sort((a, b) => b.score - a.score);

  // Always include top-scoring elements, plus any with score > 0
  const filtered = scored
    .filter((s) => s.score > 0)
    .slice(0, 8)
    .map((s) => s.element);

  // If nothing matched, fall back to top 8 by rank (original order)
  if (filtered.length === 0) {
    return elements.slice(0, 8);
  }

  return filtered;
}

/**
 * Ask the small model to identify which element to interact with for a step.
 * Returns a parsed action (click/type/etc) with the element ref.
 */
export async function executeStep(
  llm: LLMFactory,
  stepInstruction: string,
  stepAction: string,
  targetHint: string,
  value: string | undefined,
  elements: SnapshotElement[],
  emit: (event: string, data: Record<string, any>) => void,
): Promise<StepResult | null> {
  const filtered = filterElements(elements, targetHint, stepAction);

  const elemLines = filtered
    .map((e) => {
      let extra = "";
      if (e.role === "option") extra = " *** OPTION — click to select ***";
      else if (e.role === "combobox") extra = " [combobox — click to open, then type]";
      else if (e.editable) extra = " [EDITABLE]";
      return `- ${e.ref} ${e.role}|${e.name}${extra}`;
    })
    .join("\n") || "(no interactive elements visible)";

  const prompt = `Pick the element number for this step. Output ONLY a JSON object.

STEP: ${stepInstruction}
ACTION: ${stepAction}
${value ? `VALUE: "${value}"` : ""}

ELEMENTS:
${elemLines}

OUTPUT FORMAT: {"action":"click","target":"[3]"}
For type: {"action":"type","target":"[1]","value":"text"}

DO NOT explain. DO NOT analyze. Output ONLY the JSON.`;

  const sysPrompt = 'Output ONLY a JSON object. No explanation, no analysis, no text before or after.';

  const [name, out] = await llm.streamInfer(
    prompt,
    { onDelta: () => {} }, // silent — don't stream model's analysis
    512,
    0,
    sysPrompt,
  );

  debugLog(`StepExecutor raw: ${out.slice(0, 300)}`);

  const result = parseStepOutput(out);
  if (result) {
    debugLog(`StepExecutor parsed: action=${result.action} target=${result.target} value=${result.value}`);
  } else {
    debugLog("StepExecutor: failed to parse output");
  }

  return result;
}

/**
 * Parse the step executor's JSON output.
 */
function parseStepOutput(text: string): StepResult | null {
  const cleaned = text
    .replace(/```(?:json|typescript|js)?/gi, "")
    .replace(/```/g, "")
    .trim();

  // Strategy: find balanced braces, try from last { backwards
  const openBraces: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "{") openBraces.push(i);
  }

  for (let s = openBraces.length - 1; s >= 0; s--) {
    const start = openBraces[s];
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = cleaned.slice(start, i + 1);
          try {
            const obj = JSON.parse(slice);
            if (obj && typeof obj.action === "string") {
              return {
                action: obj.action,
                target: typeof obj.target === "string" ? obj.target : undefined,
                value: typeof obj.value === "string" ? obj.value : undefined,
                thought: typeof obj.thought === "string" ? obj.thought : undefined,
              };
            }
          } catch {}
          break;
        }
      }
    }
  }

  // Fallback: regex extraction
  const actionMatch = text.match(/"action"\s*:\s*"(click|type|scroll|navigate|wait|dismiss|done|selectOption)"/);
  if (actionMatch) {
    const targetMatch = text.match(/"target"\s*:\s*"([^"]*)"/);
    const valueMatch = text.match(/"value"\s*:\s*"([^"]*)"/);
    return {
      action: actionMatch[1],
      target: targetMatch?.[1] || undefined,
      value: valueMatch?.[1] || undefined,
    };
  }

  return null;
}
