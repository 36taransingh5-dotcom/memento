import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { env } from "@/lib/env";

/**
 * Embeddings for semantic memory.
 *
 * Primary path is Amazon Bedrock — Titan Text Embeddings V2, which emits 1024
 * normalised dimensions matching the `VECTOR(1024)` column.
 *
 * When Bedrock is unreachable (no credentials in a local checkout, a network
 * partition in production) we fall back to a deterministic lexical embedding so
 * the memory system keeps working. The fallback is NOT semantic — it matches on
 * shared vocabulary, not meaning — so every memory records which model produced
 * its vector in `agent_memories.embedding_model`, and the UI shows it. Degrading
 * quietly into a worse retrieval model without saying so would be dishonest.
 */

export type EmbeddingProvider = "bedrock" | "local-lexical";

export interface EmbeddingResult {
  vector: number[];
  model: string;
  provider: EmbeddingProvider;
}

export const LOCAL_EMBEDDING_MODEL = "local-lexical-hash-v1";

let bedrockRuntime: BedrockRuntimeClient | null = null;

function runtimeClient(): BedrockRuntimeClient {
  bedrockRuntime ??= new BedrockRuntimeClient({ region: env().AWS_REGION });
  return bedrockRuntime;
}

/** Remembers a Bedrock failure so we do not re-attempt on every memory write. */
let bedrockEmbeddingsDisabledUntil = 0;
const EMBEDDING_COOLDOWN_MS = 60_000;

export async function embed(text: string): Promise<EmbeddingResult> {
  const dimensions = env().EMBEDDING_DIMENSIONS;
  const normalized = text.trim();

  if (!normalized) {
    return {
      vector: new Array<number>(dimensions).fill(0),
      model: LOCAL_EMBEDDING_MODEL,
      provider: "local-lexical",
    };
  }

  if (Date.now() >= bedrockEmbeddingsDisabledUntil) {
    try {
      const vector = await embedWithBedrock(normalized, dimensions);
      return {
        vector,
        model: env().BEDROCK_EMBEDDING_MODEL_ID,
        provider: "bedrock",
      };
    } catch (err) {
      if (!env().ALLOW_DEGRADED_AI) throw err;
      bedrockEmbeddingsDisabledUntil = Date.now() + EMBEDDING_COOLDOWN_MS;
      console.warn(
        `[embeddings] Bedrock unavailable, falling back to ${LOCAL_EMBEDDING_MODEL} ` +
          `for ${EMBEDDING_COOLDOWN_MS / 1000}s: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return {
    vector: localLexicalEmbedding(normalized, dimensions),
    model: LOCAL_EMBEDDING_MODEL,
    provider: "local-lexical",
  };
}

/** Embed many texts, preserving order. Bedrock has no batch embedding API. */
export async function embedAll(texts: string[]): Promise<EmbeddingResult[]> {
  const results: EmbeddingResult[] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

async function embedWithBedrock(
  text: string,
  dimensions: number,
): Promise<number[]> {
  const response = await runtimeClient().send(
    new InvokeModelCommand({
      modelId: env().BEDROCK_EMBEDDING_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text,
        dimensions,
        // Titan returns unit vectors when normalised, which is what cosine
        // distance in CockroachDB expects.
        normalize: true,
      }),
    }),
  );

  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    embedding?: number[];
  };

  if (!Array.isArray(payload.embedding)) {
    throw new Error("Bedrock embedding response did not contain an embedding");
  }
  if (payload.embedding.length !== dimensions) {
    throw new Error(
      `Bedrock returned ${payload.embedding.length} dimensions, expected ${dimensions}. ` +
        `Check BEDROCK_EMBEDDING_MODEL_ID and EMBEDDING_DIMENSIONS.`,
    );
  }
  return payload.embedding;
}

// --- Local lexical fallback -------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "do",
  "for", "from", "had", "has", "have", "if", "in", "is", "it", "its", "of",
  "on", "or", "our", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "to", "was", "we", "were", "what", "when", "which",
  "who", "will", "with", "would", "you", "your",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** FNV-1a, 32-bit. Stable across processes so vectors stay comparable. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Hashed bag-of-ngrams with a signed hash trick, sub-linear term weighting, and
 * L2 normalisation — so cosine similarity behaves sensibly. Unigrams and
 * bigrams both contribute, which is enough to connect "another GPU for the ML
 * team" to "GPU allocation for the computer vision experiment".
 */
export function localLexicalEmbedding(
  text: string,
  dimensions: number,
): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vector;

  const counts = new Map<string, number>();
  const bump = (term: string, weight: number) => {
    counts.set(term, (counts.get(term) ?? 0) + weight);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    bump(token, 1);
    const next = tokens[i + 1];
    // Bigrams carry more signal than unigrams, hence the higher weight.
    if (next) bump(`${token}_${next}`, 1.5);
  }

  for (const [term, count] of counts) {
    const hash = fnv1a(term);
    const bucket = hash % dimensions;
    // Signed hashing keeps collisions from systematically inflating magnitude.
    const sign = (hash >>> 31) & 1 ? -1 : 1;
    const current = vector[bucket] ?? 0;
    vector[bucket] = current + sign * (1 + Math.log(count));
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;

  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = (vector[i] ?? 0) / norm;
  }
  return vector;
}

/** Cosine similarity of two equal-length vectors. Used in tests. */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
