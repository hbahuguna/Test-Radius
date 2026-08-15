import { describe, expect, it } from "vitest";
import { mapWithConcurrency, Semaphore } from "./concurrency.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("returns results in input order", async () => {
    const results = await mapWithConcurrency([10, 20, 30], 2, async (n) => {
      await delay(30 - n); // completion order intentionally reversed
      return n * 2;
    });
    expect(results).toEqual([
      { status: "fulfilled", value: 20 },
      { status: "fulfilled", value: 40 },
      { status: "fulfilled", value: 60 },
    ]);
  });

  it("caps the number of in-flight promises", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(20);
      inFlight--;
      return true;
    });
    expect(peak).toBe(2);
  });

  it("collects per-item rejections instead of failing the batch", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error(`boom ${n}`);
      return n;
    });
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]).toEqual({ status: "rejected", reason: new Error("boom 2") });
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("handles empty input and limit 0", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n)).toHaveLength(2);
  });
});

describe("Semaphore", () => {
  it("caps concurrent access at the configured limit", async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        sem.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await delay(20);
          inFlight--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("can serialize a chain while other permits run concurrently", async () => {
    const sem = new Semaphore(3);
    let seqInFlight = 0;
    let seqPeak = 0;
    let totalInFlight = 0;
    let totalPeak = 0;
    const delay2 = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const parJobs = Array.from({ length: 2 }, () =>
      sem.run(async () => {
        totalInFlight++;
        totalPeak = Math.max(totalPeak, totalInFlight);
        await delay2(40);
        totalInFlight--;
        return "par";
      }),
    );

    // A sequential chain of two jobs (must not overlap each other)
    let seqTail: Promise<unknown> = Promise.resolve();
    const seqJobs = ["A", "B"].map((label) => {
      seqTail = seqTail.then(() =>
        sem.run(async () => {
          seqInFlight++;
          seqPeak = Math.max(seqPeak, seqInFlight);
          totalInFlight++;
          totalPeak = Math.max(totalPeak, totalInFlight);
          await delay2(30);
          seqInFlight--;
          totalInFlight--;
          return label;
        }),
      );
      return seqTail;
    });

    await Promise.all([...parJobs, ...seqJobs]);
    expect(seqPeak).toBe(1);
    expect(totalPeak).toBeGreaterThan(1);
  });
});
