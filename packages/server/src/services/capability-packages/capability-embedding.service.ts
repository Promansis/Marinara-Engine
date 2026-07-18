import type { CapabilityEmbeddingHost } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { resolveMemoryRecallEmbeddingSource } from "../memory-recall-embedding.js";

const MAX_EMBEDDING_TEXTS = 128;
const MAX_EMBEDDING_CHARACTERS = 200_000;

export function createCapabilityEmbeddingHost(db: DB): CapabilityEmbeddingHost {
  return Object.freeze({
    label: "Configured memory recall embeddings",
    async embed(texts: string[], signal?: AbortSignal): Promise<number[][] | null> {
      if (texts.length === 0 || texts.length > MAX_EMBEDDING_TEXTS) return null;
      if (texts.some((text: string) => text.length > MAX_EMBEDDING_CHARACTERS)) return null;
      const source = await resolveMemoryRecallEmbeddingSource(db, {});
      return source?.embed(texts, signal) ?? null;
    },
  });
}
