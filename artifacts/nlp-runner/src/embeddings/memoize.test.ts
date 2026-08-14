import { describe, expect, it } from "vitest";
import { createCachedEmbed } from "./memoize.js";

function fakeEmbed(record: string[]): (text: string) => Promise<Float32Array> {
  return async (text: string) => {
    record.push(text);
    const out = new Float32Array(4);
    for (let i = 0; i < text.length; i++) out[i % 4] += text.charCodeAt(i);
    return out;
  };
}

describe("createCachedEmbed", () => {
  it("hits the memo for a repeated query instead of the model", async () => {
    const calls: string[] = [];
    const { embed, stats } = createCachedEmbed(fakeEmbed(calls));
    const first = await embed("register bob@x.com");
    const second = await embed("register bob@x.com");
    expect(second).toEqual(first);
    expect(calls).toEqual(["register bob@x.com"]);
    expect(stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it("caches misses too (no repeated embedding for the same text)", async () => {
    const calls: string[] = [];
    const { embed, stats } = createCachedEmbed(fakeEmbed(calls));
    await embed("zzz unrelated");
    await embed("zzz unrelated");
    expect(calls).toEqual(["zzz unrelated"]);
    expect(stats().misses).toBe(1);
    expect(stats().hits).toBe(1);
  });

  it("evicts the least-recently-used entry past maxSize", async () => {
    const calls: string[] = [];
    const { embed, stats } = createCachedEmbed(fakeEmbed(calls), { maxSize: 2 });
    await embed("a");
    await embed("b");
    await embed("c");
    expect(stats().size).toBe(2);
    await embed("a");
    expect(calls.filter((c) => c === "a")).toHaveLength(2);
    expect(stats().hits).toBe(0);
  });
});
