/**
 * Agentic chat: takes a user message, uses the browser to execute actions,
 * and reports back what happened. This is the "conversational agent" mode
 * where the user can give feedback and the agent acts on it.
 */

import type { LLMFactory } from "./reasoning/llmFactory.js";
import { ByokClient, type StreamCallbacks } from "./reasoning/byokClient.js";
import * as bt from "./tools/browserTools.js";
import { appendFileSync } from "fs";
import { join } from "path";

const LOG_FILE = join(process.cwd(), "logs", "agent-debug.log");
function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
}

export interface ChatContext {
  url: string;
  /** The goal/description from the original test run */
  goal: string;
  /** Previous chat messages for continuity */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

interface ChatAction {
  action: "click" | "type" | "navigate" | "wait" | "done";
  target?: string;
  value?: string;
  reasoning?: string;
  answer?: string;
}

/**
 * Parse the LLM response to extract an action.
 * The LLM returns JSON like: {"action":"click","target":"0","reasoning":"..."}
 */
function parseAction(text: string): ChatAction | null {
  // Try to find JSON in the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

/**
 * Build a snapshot string from browser elements for the LLM.
 */
function snapshotString(elements: import("./tools/browserTools.js").SnapshotElement[]): string {
  if (elements.length === 0) return "(no interactive elements found)";
  return elements
    .map((e) => {
      let extra = "";
      if (e.editable) extra = " [EDITABLE]";
      if (e.role === "button" || e.role === "link") extra = " [CLICKABLE]";
      if (e.role === "combobox") extra = " [DROPDOWN]";
      return `[${e.index}] <${e.role}> "${e.name}"${extra}`;
    })
    .join("\n");
}

/**
 * Execute an agentic chat turn: snapshot → LLM decides action → execute → report.
 * Returns the agent's text response and whether it performed an action.
 */
export async function* chatAgentTurn(
  message: string,
  context: ChatContext,
  client: ByokClient,
): AsyncGenerator<string, void, unknown> {
  debugLog(`[chat] Turn: "${message}" (URL: ${context.url})`);

  // Ensure browser is running
  const started = await bt.browserStart(true);
  if (started.status !== "ok") {
    yield `Failed to start browser: ${started.error}`;
    return;
  }

  // Recover if page is dead
  const alive = await bt.browserIsAlive();
  if (!alive) {
    await bt.browserRecover(context.url, true);
    // Navigate to URL after recovery
    await bt.browserNavigate(context.url);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Take snapshot
  const snap = await bt.browserSnapshot();
  const elements = snap.interactive_elements || [];

  // Build context for LLM
  const chatHistory = context.messages
    .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${m.content}`)
    .join("\n");

  const sysPrompt = `You are a browser test agent with hands-on control of a web page.
The user just ran a test and is chatting with you to give feedback or ask you to do things.

CURRENT PAGE URL: ${context.url}
TEST GOAL: ${context.goal}

AVAILABLE INTERACTIVE ELEMENTS ON THE PAGE:
${snapshotString(elements)}

YOU CAN PERFORM ACTIONS. To perform an action, respond with ONLY a JSON object (no other text):
- To click an element: {"action":"click","target":"<index>","reasoning":"why"}
- To type in a field: {"action":"type","target":"<index>","value":"<text>","reasoning":"why"}
- To navigate to a URL: {"action":"navigate","target":"<url>","reasoning":"why"}
- To wait for the page: {"action":"wait","reasoning":"why"}
- To just answer without acting: {"action":"done","answer":"<your response>"}

RULES:
- The "target" for click/type must be the index number [N] from the element list
- Always include "reasoning" explaining what you're doing
- If the user just wants to talk (not control the browser), use {"action":"done","answer":"..."}
- After performing an action, describe what you did in the "answer" field`;

  const userMsg = chatHistory
    ? `Previous conversation:\n${chatHistory}\n\nUser: ${message}`
    : `User: ${message}`;

  // Collect full response
  let fullResponse = "";
  const tokens: string[] = [];

  await client.streamInfer(
    userMsg,
    {
      onDelta: (kind: string, text: string) => {
        if (kind === "content" && text) {
          tokens.push(text);
        }
      },
    },
    1024,
    0.3,
    sysPrompt,
  );

  fullResponse = tokens.join("");

  // Parse the LLM's response for an action
  const action = parseAction(fullResponse);

  if (!action) {
    // No valid action found — just return the text
    debugLog(`[chat] No action parsed, returning text`);
    yield fullResponse || "I'm not sure what to do. Could you be more specific?";
    return;
  }

  // Execute the action
  debugLog(`[chat] Executing action: ${JSON.stringify(action)}`);

  switch (action.action) {
    case "click": {
      const target = action.target || "";
      if (!target) {
        yield "No target specified for click.";
        return;
      }
      const clickResult = await bt.browserClick(target);
      if (!clickResult.ok) {
        yield `Click failed: ${clickResult.error}`;
        return;
      }
      await new Promise((r) => setTimeout(r, 1000)); // wait for page update
      // Take new snapshot after action
      const newSnap = await bt.browserSnapshot();
      const newElements = newSnap.interactive_elements || [];
      const answer = action.answer || action.reasoning || `Clicked element ${target}`;
      yield `${answer}\n\nPage updated. ${newElements.length} interactive elements now visible.`;
      break;
    }
    case "type": {
      const target = action.target || "";
      if (!target) {
        yield "No target specified for type.";
        return;
      }
      const typeResult = await bt.browserType(target, action.value || "");
      if (!typeResult.ok) {
        yield `Type failed: ${typeResult.error}`;
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
      const answer = action.answer || action.reasoning || `Typed "${action.value}" into element ${target}`;
      yield answer;
      break;
    }
    case "navigate": {
      const navResult = await bt.browserNavigate(action.target || context.url);
      if (!navResult.ok) {
        yield `Navigation failed: ${navResult.error}`;
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
      const answer = action.answer || action.reasoning || `Navigated to ${action.target}`;
      yield answer;
      break;
    }
    case "wait": {
      await new Promise((r) => setTimeout(r, 2000));
      const snap2 = await bt.browserSnapshot();
      const elems2 = snap2.interactive_elements || [];
      yield action.answer || action.reasoning || `Waited. Page now has ${elems2.length} interactive elements.`;
      break;
    }
    case "done":
    default: {
      yield action.answer || fullResponse;
      break;
    }
  }
}
