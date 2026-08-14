/**
 * Action loop detector (PLAN-live-agent.md Phase 3) — port of browser-use
 * `agent/views.py::ActionLoopDetector`. Soft detection: it produces context
 * nudges for the LLM but never blocks actions.
 */
import { createHash } from "node:crypto";
import type { ActionCall } from "./types.js";

/** Lightweight fingerprint of the browser page state. */
export class PageFingerprint {
  constructor(
    readonly url: string,
    readonly elementCount: number,
    readonly textHash: string,
  ) {}

  static fromBrowserState(url: string, domText: string, elementCount: number): PageFingerprint {
    const textHash = createHash("sha256").update(domText, "utf8").digest("hex").slice(0, 16);
    return new PageFingerprint(url, elementCount, textHash);
  }

  equals(other: PageFingerprint): boolean {
    return (
      this.url === other.url &&
      this.elementCount === other.elementCount &&
      this.textHash === other.textHash
    );
  }
}

/** Normalize an action's params to a stable similarity key before hashing. */
function normalizeActionForHash(name: string, params: Record<string, unknown>): string {
  if (name === "navigate") {
    return `navigate|${String(params.url ?? "")}`;
  }
  if (name === "click") {
    return `click|${params.index ?? ""}`;
  }
  if (name === "input_text") {
    return `input|${params.index ?? ""}|${String(params.text ?? "").trim().toLowerCase()}`;
  }
  if (name === "scroll") {
    const dir = params.direction === "up" ? "up" : "down";
    return `scroll|${dir}|${params.index ?? ""}`;
  }
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params).sort()) {
    if (v !== undefined && v !== null) filtered[k] = v;
  }
  return `${name}|${JSON.stringify(filtered)}`;
}

function computeActionHash(name: string, params: Record<string, unknown>): string {
  return createHash("sha256").update(normalizeActionForHash(name, params), "utf8").digest("hex").slice(0, 12);
}

/** Actions exempt from loop recording: wait is a constant no-op, done is terminal, go_back is recovery. */
const LOOP_EXEMPT_ACTIONS = new Set(["wait", "done", "go_back"]);

export class ActionLoopDetector {
  readonly windowSize: number;
  private recentActionHashes: string[] = [];
  private recentPageFingerprints: PageFingerprint[] = [];
  maxRepetitionCount = 0;
  mostRepeatedHash: string | null = null;
  consecutiveStagnantPages = 0;

  constructor(windowSize = 20) {
    this.windowSize = windowSize;
  }

  recordActions(actions: ActionCall[]): void {
    for (const a of actions) {
      if (LOOP_EXEMPT_ACTIONS.has(a.name)) continue;
      const h = computeActionHash(a.name, a.params ?? {});
      this.recentActionHashes.push(h);
    }
    if (this.recentActionHashes.length > this.windowSize) {
      this.recentActionHashes = this.recentActionHashes.slice(-this.windowSize);
    }
    this.updateRepetitionStats();
  }

  recordPageState(url: string, domText: string, elementCount: number): void {
    const fp = PageFingerprint.fromBrowserState(url, domText, elementCount);
    if (this.recentPageFingerprints.length > 0 && this.recentPageFingerprints[this.recentPageFingerprints.length - 1].equals(fp)) {
      this.consecutiveStagnantPages += 1;
    } else {
      this.consecutiveStagnantPages = 0;
    }
    this.recentPageFingerprints.push(fp);
    if (this.recentPageFingerprints.length > 5) {
      this.recentPageFingerprints = this.recentPageFingerprints.slice(-5);
    }
  }

  private updateRepetitionStats(): void {
    if (this.recentActionHashes.length === 0) {
      this.maxRepetitionCount = 0;
      this.mostRepeatedHash = null;
      return;
    }
    const counts: Record<string, number> = {};
    for (const h of this.recentActionHashes) counts[h] = (counts[h] ?? 0) + 1;
    let best = "";
    for (const [h, c] of Object.entries(counts)) if (c > (counts[best] ?? 0)) best = h;
    this.mostRepeatedHash = best || null;
    this.maxRepetitionCount = best ? counts[best] : 0;
  }

  /** Escalating awareness nudge, or null when no loop is detected. */
  getNudgeMessage(): string | null {
    const messages: string[] = [];
    const total = this.recentActionHashes.length;
    if (this.maxRepetitionCount >= 12) {
      messages.push(
        `Heads up: you have repeated a similar action ${this.maxRepetitionCount} times in the last ${total} actions. If you are making progress with each repetition, keep going. If not, a different approach might get you there faster.`,
      );
    } else if (this.maxRepetitionCount >= 8) {
      messages.push(
        `Heads up: you have repeated a similar action ${this.maxRepetitionCount} times in the last ${total} actions. Are you still making progress with each attempt? If so, carry on. Otherwise, it might be worth trying a different approach.`,
      );
    } else if (this.maxRepetitionCount >= 5) {
      messages.push(
        `Heads up: you have repeated a similar action ${this.maxRepetitionCount} times in the last ${total} actions. If this is intentional and making progress, carry on. If not, reconsider your approach.`,
      );
    }
    if (this.consecutiveStagnantPages >= 5) {
      messages.push(
        `The page content has not changed across ${this.consecutiveStagnantPages} consecutive actions. Your actions might not be having the intended effect. Try a different element or approach.`,
      );
    }
    return messages.length > 0 ? messages.join("\n\n") : null;
  }
}