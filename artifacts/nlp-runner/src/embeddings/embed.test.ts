import { describe, expect, it } from "vitest";
import { bytesToEmbedding, embed, embeddingToBytes, EMBEDDING_DIM } from "./embed.js";
import { cosine } from "./matcher.js";

async function probeModel(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await embed("warmup");
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
    }
  }
  return false;
}

const modelReady = await probeModel();

describe("embed (real model)", () => {
  it.runIf(modelReady)("returns a Float32Array of the expected dim", async () => {
    const vector = await embed("hello");
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector).toHaveLength(EMBEDDING_DIM);
  });

  it.runIf(modelReady)("embeds two similar sentences with cosine > 0.8", async () => {
    const a = await embed("How are you doing today?");
    const b = await embed("How are you feeling today?");
    expect(cosine(a, b)).toBeGreaterThan(0.8);
  });

  it.runIf(modelReady)("embeds unrelated sentences with a low cosine", async () => {
    const a = await embed("the sky is blue today");
    const b = await embed("please reset my password");
    expect(cosine(a, b)).toBeLessThan(0.6);
  });

  it("round-trips an embedding through bytes", () => {
    const vector = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) vector[i] = i * 0.5;
    const bytes = embeddingToBytes(vector);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(EMBEDDING_DIM * 4);
    const back = bytesToEmbedding(bytes);
    expect(Array.from(back)).toEqual(Array.from(vector));
  });
});
