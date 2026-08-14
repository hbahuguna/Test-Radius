import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { loadConfig } from "../config.js";
import { createCachedEmbed, type EmbedCacheStats } from "./memoize.js";

export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

interface EmbedOptions {
  model?: string;
  cacheDir?: string;
}

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;
let resolvedModel = DEFAULT_EMBED_MODEL;

async function getExtractor(options: EmbedOptions = {}): Promise<FeatureExtractionPipeline> {
  if (extractorPromise) return extractorPromise;

  resolvedModel = options.model ?? DEFAULT_EMBED_MODEL;
  const cacheDir =
    options.cacheDir ?? join(loadConfig().dataDir, "models");
  mkdirSync(cacheDir, { recursive: true });
  env.cacheDir = cacheDir;

  extractorPromise = pipeline("feature-extraction", resolvedModel, {
    dtype: "fp32",
    device: "cpu",
  });
  try {
    await extractorPromise;
  } catch (err) {
    extractorPromise = undefined;
    throw err;
  }
  return extractorPromise;
}

export async function embed(text: string, options: EmbedOptions = {}): Promise<Float32Array> {
  const extractor = await getExtractor(options);
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as Float32Array);
}

export async function embedMany(
  texts: string[],
  options: EmbedOptions = {},
): Promise<Float32Array[]> {
  const extractor = await getExtractor(options);
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const width = output.dims.at(-1) ?? 0;
  const data = new Float32Array(output.data as Float32Array);
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(new Float32Array(data.buffer as ArrayBuffer, i * width * 4, width));
  }
  return vectors;
}

export async function embeddingDim(options: EmbedOptions = {}): Promise<number> {
  await getExtractor(options);
  return EMBEDDING_DIM;
}

export function embeddingToBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bytesToEmbedding(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

const cached = createCachedEmbed(embed);

export const embedCached = cached.embed;
export function embedStats(): EmbedCacheStats {
  return cached.stats();
}
