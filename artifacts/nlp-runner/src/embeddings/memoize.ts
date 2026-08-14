import { fnv1a } from "../util/hash.js";

export interface CachedEmbedOptions {
  maxSize?: number;
}

export interface EmbedCacheStats {
  hits: number;
  misses: number;
  size: number;
  maxSize: number;
}

export function createCachedEmbed(
  fn: (text: string) => Promise<Float32Array>,
  options: CachedEmbedOptions = {},
): { embed: (text: string) => Promise<Float32Array>; stats: () => EmbedCacheStats } {
  const maxSize = options.maxSize ?? 512;
  const map = new Map<string, Float32Array>();
  let hits = 0;
  let misses = 0;

  async function embed(text: string): Promise<Float32Array> {
    const key = fnv1a(text);
    const cached = map.get(key);
    if (cached) {
      hits++;
      if (map.size > 1) {
        map.delete(key);
        map.set(key, cached);
      }
      return cached;
    }
    misses++;
    const value = await fn(text);
    if (map.size >= maxSize) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
    return value;
  }

  return {
    embed,
    stats: () => ({ hits, misses, size: map.size, maxSize }),
  };
}
