/**
 * Real `RecordingDriver` adapter (Story QF-48).
 *
 * Wires the `RecordAgent` to a real headless browser: action methods delegate to
 * a `Recorder` (so locators/fingerprints/wait-conditions/slots are captured for
 * replay), and `snapshot()`/`signature()` read from the underlying `Page`.
 */
import type { DataStore, SaveTestResult } from "../cache/queries.js";
import { Recorder, type RecordedStep, type RecordedSlot } from "../recorder/recorder.js";
import type { Page } from "../browser/session.js";
import { formatSnapshot, type SnapshotPayload } from "./snapshot.js";
import type { RecordingDriver } from "./agent.js";

export class RecorderDriver implements RecordingDriver {
  private readonly recorder: Recorder;

  constructor(private readonly page: Page, private readonly store: DataStore) {
    this.recorder = new Recorder(page);
  }

  getRecorder(): Recorder {
    return this.recorder;
  }

  async snapshot(): Promise<SnapshotPayload> {
    const nodes = await this.page.getAccessibilitySnapshot();
    const [url, title] = await Promise.all([
      this.page.getUrl(),
      this.page.evaluate<string>(() => document.title),
    ]);
    return formatSnapshot(url, title, nodes);
  }

  async signature(): Promise<string> {
    return this.page.pageSignature();
  }

  navigate(url: string): Promise<void> {
    return this.recorder.navigate(url);
  }
  click(selector: string): Promise<void> {
    return this.recorder.click(selector);
  }
  fill(selector: string, value: string): Promise<void> {
    return this.recorder.fill(selector, value);
  }
  select(selector: string, value: string): Promise<void> {
    return this.recorder.select(selector, value);
  }
  scroll(selector?: string): Promise<void> {
    return selector
      ? this.recorder.scroll(selector)
      : Promise.resolve();
  }
  assertVisible(selector: string): Promise<void> {
    return this.recorder.assertVisible(selector);
  }
  assertText(selector: string, expected: string): Promise<void> {
    return this.recorder.assertText(selector, expected);
  }
  assertUrl(contains: string): Promise<void> {
    return this.recorder.assertUrl(contains);
  }
  async extract(selector: string, name: string): Promise<string | undefined> {
    return (await this.recorder.extract(selector, name)) ?? undefined;
  }
  async wait(ms?: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms ?? 0));
  }
  getSteps(): RecordedStep[] {
    return this.recorder.getSteps();
  }
  getSlots(): RecordedSlot[] {
    return this.recorder.getSlots();
  }
  saveTest(
    name: string,
    opts: { query?: string | null; normalizedQuery?: string | null; description?: string | null; extraSlots?: RecordedSlot[] },
  ): Promise<SaveTestResult> {
    return this.recorder.saveTest(this.store, name, {
      query: opts.query ?? null,
      normalizedQuery: opts.normalizedQuery ?? null,
      description: opts.description ?? null,
      extraSlots: opts.extraSlots,
    });
  }
}
