import { describe, expect, it } from "vitest";
import { cosine } from "./matcher.js";

describe("cosine", () => {
  it("is 1 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3, 4]);
    expect(cosine(a, a)).toBeCloseTo(1, 5);
  });

  it("is 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 5);
  });

  it("is higher for more similar vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0.9, 0.1, 0, 0]);
    const c = new Float32Array([-1, 0, 0, 0]);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });

  it("returns 0 for vectors of different lengths", () => {
    expect(cosine(new Float32Array([1]), new Float32Array([1, 2]))).toBe(0);
  });
});
