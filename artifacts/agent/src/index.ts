/**
 * Public API for the TypeScript agent. The Test-Radius api-server imports
 * this package directly (no separate Python :8006 service) and streams the
 * NDJSON events back to the browser.
 */

import { AgenticExecutor, requestStop, clearStop, type AgenticRunOptions, type EventSink } from "./executor.js";
import * as bt from "./tools/browserTools.js";

export interface RunStreamInput extends AgenticRunOptions {}

/**
 * Run an agentic test and yield one NDJSON string per event. Mirrors the old
 * Python `/v1/agentic-stream` endpoint shape so the api-server/frontend are
 * unchanged.
 */
export async function* runStream(input: RunStreamInput): AsyncGenerator<string, void, unknown> {
  const sink: Record<string, any>[] = [];
  const executor = new AgenticExecutor({ byok: input.byok, model: input.model });
  const emit: EventSink = (event, data) => {
    const payload: Record<string, any> = { event, ts: Date.now() / 1000 };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) payload[k] = v;
    sink.push(payload);
  };

  let finished = false;
  const runPromise = executor.run(input, emit).finally(() => {
    finished = true;
  });

  while (true) {
    if (sink.length > 0) {
      const item = sink.shift()!;
      yield JSON.stringify(item) + "\n";
      if (item.event === "done") break;
    } else if (finished) {
      while (sink.length > 0) {
        yield JSON.stringify(sink.shift()) + "\n";
      }
      break;
    } else {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await runPromise;
}

export async function getScreenshot(): Promise<{ screenshot?: string } | null> {
  const r = await bt.browserScreenshot();
  if (!r.ok) return null;
  return { screenshot: r.screenshot };
}

export function stopRun(): void {
  requestStop();
}

export { clearStop };
export * from "./executor.js";
export * from "./reasoning/byokClient.js";
