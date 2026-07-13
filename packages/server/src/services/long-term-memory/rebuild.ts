import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  LtmEmbeddingIndex,
  LtmEmbeddingIndexEntry,
  LtmIndexGenerationManifest,
  LtmIndexMetadata,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { isEnoent } from "./ltm-utils.js";
import { embedMemoryRecallTexts, type MemoryRecallEmbeddingOptions } from "../memory-recall.js";
import { buildLtmBm25Index } from "./bm25.js";
import { CURRENT_LTM_CHUNK_FORMAT_VERSION, chunkNotes, stableJsonHash, type LtmMemoryChunk } from "./chunking.js";
import { buildLtmGraphIndex } from "./graph.js";
import {
  loadLtmIndexGeneration,
  pruneLtmIndexGenerations,
  publishLtmIndexGeneration,
  removeLtmIndexGeneration,
  writeLtmIndexFamilyGeneration,
  writeLtmIndexGenerationManifest,
  type LtmIndexFamilyBundle,
} from "./index-generation.js";
import { buildLtmKeywordIndex } from "./keyword-index.js";
import {
  beginLtmIndexRebuild,
  completeLtmIndexRebuild,
  failLtmIndexRebuild,
  markLtmIndexesDirty,
  readLtmIndexState,
  withLtmIndexRebuildLock,
} from "./index-state.js";
import { buildLtmMetadataIndex } from "./metadata-index.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot } from "./paths.js";
import { invalidateLongTermMemoryRetrievalCache } from "./retrieval.js";
import { LongTermMemoryStorage } from "./storage.js";

export type { LtmEmbeddingIndex, LtmEmbeddingIndexEntry } from "@marinara-engine/shared";

export interface LtmRebuildResult {
  root: string;
  generatedAt: string;
  noteCount: number;
  chunkCount: number;
  sourceChunkCount: number;
  embeddedChunkCount: number;
  embeddingsAvailable: boolean;
  manifest: LtmIndexMetadata;
  generation: LtmIndexGenerationManifest;
}

export interface LtmRebuildOptions extends MemoryRecallEmbeddingOptions {
  root?: string;
  generatedAt?: string;
  scope?: LtmRebuildScope;
}

export type LtmRebuildScope = "all" | "typed" | "source";

const MAX_REBUILD_ATTEMPTS = 3;

class LtmIndexSnapshotChangedError extends Error {}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((err) => {
    if (isEnoent(err)) return [];
    logger.warn(err, "[ltm] Failed to list files in %s", root);
    throw err;
  });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

export async function hashLongTermMemoryVaultFiles(root: string) {
  const dirs = getLongTermMemoryDirectories(root);
  const files = (await listFiles(dirs.vault)).sort((a, b) => a.localeCompare(b));

  const hashes: Record<string, string> = {};
  for (const file of files) {
    const relativePath = relative(root, file)
      .split(/[\\/]+/)
      .join("/");
    try {
      hashes[relativePath] = stableJsonHash(await readFile(file, "utf8"));
    } catch (err) {
      if (isEnoent(err)) continue;
      logger.warn(err, "[ltm] Failed to hash source file %s", file);
      throw err;
    }
  }
  return hashes;
}

function embeddingModelLabel(options: MemoryRecallEmbeddingOptions) {
  return options.embeddingSource?.label ?? "Xenova/all-MiniLM-L6-v2";
}

async function embedIndexChunks(chunks: LtmMemoryChunk[], options: MemoryRecallEmbeddingOptions) {
  if (chunks.length === 0) return [] as number[][];
  try {
    return await embedMemoryRecallTexts(
      chunks.map((chunk) => chunk.text),
      options,
    );
  } catch (err) {
    logger.warn(err, "[ltm] Embedding failed for %d chunks", chunks.length);
    throw err;
  }
}

function reusableVectorsBySourceHash(previous: LtmEmbeddingIndex | undefined, model: string) {
  if (!previous || previous.model !== model || !previous.dimension) return new Map<string, number[]>();
  const reusable = new Map<string, number[]>();
  for (const entry of previous.chunks) {
    if (!entry.vector || entry.vector.length !== previous.dimension || reusable.has(entry.sourceHash)) continue;
    reusable.set(entry.sourceHash, entry.vector);
  }
  return reusable;
}

async function buildEmbeddingIndex(
  chunks: LtmMemoryChunk[],
  options: MemoryRecallEmbeddingOptions,
  previous?: LtmEmbeddingIndex,
) {
  const model = embeddingModelLabel(options);
  const reusable = reusableVectorsBySourceHash(previous, model);
  let entries = chunks.map((chunk) => {
    const vector = reusable.get(chunk.sourceHash);
    return vector
      ? { chunkId: chunk.id, sourceHash: chunk.sourceHash, vector: [...vector] }
      : { chunkId: chunk.id, sourceHash: chunk.sourceHash };
  });
  const missingChunkIndexes = entries.flatMap((entry, index) => (entry.vector ? [] : [index]));

  if (missingChunkIndexes.length > 0) {
    const vectors = await embedIndexChunks(
      missingChunkIndexes.map((index) => chunks[index]!),
      options,
    );
    for (const [vectorIndex, chunkIndex] of missingChunkIndexes.entries()) {
      const vector = vectors[vectorIndex];
      if (vector && vector.length > 0) {
        entries[chunkIndex] = { ...entries[chunkIndex]!, vector };
      }
    }
  }

  const vectorDimensions = Array.from(
    new Set(entries.flatMap((entry) => (entry.vector && entry.vector.length > 0 ? [entry.vector.length] : []))),
  );
  if (vectorDimensions.length > 1) {
    // A provider with the same label returned a new dimension. Rebuild this
    // family coherently rather than mixing vectors from different models.
    const vectors = await embedIndexChunks(chunks, options);
    entries = chunks.map((chunk, index) => {
      const vector = vectors[index];
      return vector && vector.length > 0
        ? { chunkId: chunk.id, sourceHash: chunk.sourceHash, vector }
        : { chunkId: chunk.id, sourceHash: chunk.sourceHash };
    });
  }

  const dimension = entries.find((entry) => entry.vector && entry.vector.length > 0)?.vector?.length ?? null;
  const embeddedChunkCount = entries.filter((entry) => entry.vector && entry.vector.length > 0).length;

  return {
    version: 1,
    model,
    dimension,
    embeddedChunkCount,
    chunks: entries,
    byChunkId: Object.fromEntries(entries.map((entry, index) => [entry.chunkId, index])),
  } satisfies LtmEmbeddingIndex;
}

function includesTypedIndexes(scope: LtmRebuildScope) {
  return scope === "all" || scope === "typed";
}

function includesSourceIndexes(scope: LtmRebuildScope) {
  return scope === "all" || scope === "source";
}

async function buildTypedIndexes(
  notes: Awaited<ReturnType<LongTermMemoryStorage["listNotes"]>>,
  options: MemoryRecallEmbeddingOptions,
  previousEmbeddings?: LtmEmbeddingIndex,
) {
  const chunks = chunkNotes(notes);
  const embeddings = await buildEmbeddingIndex(chunks, options, previousEmbeddings);
  return { chunks, bundle: { ...buildDeterministicIndexes(notes, chunks), embeddings } satisfies LtmIndexFamilyBundle };
}

async function buildSourceIndexes(
  notes: Awaited<ReturnType<LongTermMemoryStorage["listNotes"]>>,
  options: MemoryRecallEmbeddingOptions,
  previousEmbeddings?: LtmEmbeddingIndex,
) {
  const chunks = chunkNotes(notes, { sourceNotesOnly: true });
  const embeddings = await buildEmbeddingIndex(chunks, options, previousEmbeddings);
  return { chunks, bundle: { ...buildDeterministicIndexes(notes, chunks), embeddings } satisfies LtmIndexFamilyBundle };
}

function buildDeterministicIndexes(
  notes: Awaited<ReturnType<LongTermMemoryStorage["listNotes"]>>,
  chunks: LtmMemoryChunk[],
) {
  const bm25 = buildLtmBm25Index(chunks);
  const graph = buildLtmGraphIndex(notes, chunks);
  const metadata = buildLtmMetadataIndex(chunks);
  const keywords = buildLtmKeywordIndex(chunks);
  return { metadata, bm25, graph, keywords };
}

function indexFamilyMatchesSnapshot(
  bundle: LtmIndexFamilyBundle,
  notes: Awaited<ReturnType<LongTermMemoryStorage["listNotes"]>>,
  chunks: LtmMemoryChunk[],
) {
  const expected = buildDeterministicIndexes(notes, chunks);
  return (
    stableJsonHash(expected) ===
    stableJsonHash({
      metadata: bundle.metadata,
      bm25: bundle.bm25,
      graph: bundle.graph,
      keywords: bundle.keywords,
    })
  );
}

export async function rebuildLongTermMemoryIndexes(options: LtmRebuildOptions = {}): Promise<LtmRebuildResult> {
  const root = options.root ?? getLongTermMemoryRoot();
  return withLtmIndexRebuildLock(root, async () => {
    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();
    let lastSnapshotError: unknown = null;
    for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt += 1) {
      const state = await beginLtmIndexRebuild(root);
      try {
        return await rebuildLongTermMemoryIndexesAttempt(options, root, storage, state.revision);
      } catch (err) {
        if (err instanceof LtmIndexSnapshotChangedError) {
          lastSnapshotError = err;
          continue;
        }
        await failLtmIndexRebuild(root, err);
        throw err;
      }
    }
    const error = lastSnapshotError ?? new Error("Long-term memory vault kept changing during index rebuild.");
    await failLtmIndexRebuild(root, error);
    throw error;
  });
}

async function rebuildLongTermMemoryIndexesAttempt(
  options: LtmRebuildOptions,
  root: string,
  storage: LongTermMemoryStorage,
  expectedRevision: number,
): Promise<LtmRebuildResult> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope ?? "all";
  const beforeSnapshotFiles = await hashLongTermMemoryVaultFiles(root);
  const notes = await storage.listNotes();
  const sourceFiles = await hashLongTermMemoryVaultFiles(root);
  if (stableJsonHash(beforeSnapshotFiles) !== stableJsonHash(sourceFiles)) {
    throw new LtmIndexSnapshotChangedError("Long-term memory vault changed while taking the rebuild snapshot.");
  }

  const typedChunks = chunkNotes(notes);
  const sourceChunks = chunkNotes(notes, { sourceNotesOnly: true });
  // A partial rebuild can reuse only a fully validated generation. Reusing
  // individual families would let a damaged generation become a mixed one.
  const previousGeneration = await loadLtmIndexGeneration(root);
  const previousTyped = previousGeneration.bundles.typed ?? null;
  const previousSource = previousGeneration.bundles.source ?? null;
  let typedResult = includesTypedIndexes(scope)
    ? await buildTypedIndexes(notes, options, previousTyped?.embeddings)
    : null;
  let sourceResult = includesSourceIndexes(scope)
    ? await buildSourceIndexes(notes, options, previousSource?.embeddings)
    : null;
  if (!typedResult && (!previousTyped || !indexFamilyMatchesSnapshot(previousTyped, notes, typedChunks))) {
    typedResult = await buildTypedIndexes(notes, options, previousTyped?.embeddings);
  }
  if (
    !sourceResult &&
    ((previousSource && !indexFamilyMatchesSnapshot(previousSource, notes, sourceChunks)) ||
      (!previousSource && sourceChunks.length > 0))
  ) {
    sourceResult = await buildSourceIndexes(notes, options, previousSource?.embeddings);
  }
  const typedBundle = typedResult?.bundle ?? previousTyped;
  const sourceBundle = sourceResult?.bundle ?? previousSource;
  if (!typedBundle) {
    throw new Error("Long-term memory rebuild could not produce the required typed index family.");
  }
  const generationId = randomUUID();
  const sourceHash = stableJsonHash(sourceFiles);
  const manifest: LtmIndexMetadata = {
    version: 1,
    chunkFormatVersion: CURRENT_LTM_CHUNK_FORMAT_VERSION,
    generatedAt,
    sourceHash,
    noteCount: notes.length,
    chunkCount: typedChunks.length,
    files: sourceFiles,
  };
  const generationFamilies: Partial<LtmIndexGenerationManifest["families"]> = {};
  let published = false;

  try {
    await assertLtmSnapshotCurrent(root, sourceHash, expectedRevision);
    generationFamilies.typed = {
      chunkCount: Object.keys(typedBundle.metadata.chunks).length,
      embeddedChunkCount: typedBundle.embeddings.embeddedChunkCount,
      files: await writeLtmIndexFamilyGeneration(root, generationId, "typed", typedBundle),
    };
    if (sourceBundle) {
      generationFamilies.source = {
        chunkCount: Object.keys(sourceBundle.metadata.chunks).length,
        embeddedChunkCount: sourceBundle.embeddings.embeddedChunkCount,
        files: await writeLtmIndexFamilyGeneration(root, generationId, "source", sourceBundle),
      };
    }

    const generation = await writeLtmIndexGenerationManifest(root, {
      version: 2,
      generationId,
      generatedAt,
      chunkFormatVersion: CURRENT_LTM_CHUNK_FORMAT_VERSION,
      sourceHash,
      noteCount: notes.length,
      chunkCount: typedChunks.length,
      sourceChunkCount: sourceChunks.length,
      sourceFiles,
      families: {
        typed: generationFamilies.typed,
        ...(generationFamilies.source ? { source: generationFamilies.source } : {}),
      },
    });

    await assertLtmSnapshotCurrent(root, sourceHash, expectedRevision);
    await publishLtmIndexGeneration(root, {
      version: 1,
      generationId,
      publishedAt: new Date().toISOString(),
    });
    published = true;
    const currentSourceHash = stableJsonHash(await hashLongTermMemoryVaultFiles(root));
    if (currentSourceHash !== sourceHash) {
      await markLtmIndexesDirty(root);
      throw new LtmIndexSnapshotChangedError("Long-term memory vault changed during index publication.");
    }
    const completedState = await completeLtmIndexRebuild(root, expectedRevision, generationId);
    if (completedState.dirty) {
      throw new LtmIndexSnapshotChangedError("Long-term memory vault changed during index publication.");
    }

    if (scope === "all") {
      invalidateLongTermMemoryRetrievalCache(root);
    } else {
      invalidateLongTermMemoryRetrievalCache(root, scope === "source");
    }
    await pruneLtmIndexGenerations(root).catch((err) => {
      logger.warn(err, "[ltm] Failed to prune old index generations");
    });

    return {
      root,
      generatedAt,
      noteCount: notes.length,
      chunkCount: typedChunks.length,
      sourceChunkCount: sourceChunks.length,
      embeddedChunkCount: typedBundle.embeddings.embeddedChunkCount,
      embeddingsAvailable: Boolean(typedBundle.embeddings.embeddedChunkCount),
      manifest,
      generation,
    };
  } catch (err) {
    if (!published) await removeLtmIndexGeneration(root, generationId).catch(() => {});
    throw err;
  }
}

async function assertLtmSnapshotCurrent(root: string, sourceHash: string, expectedRevision: number) {
  const [currentFiles, state] = await Promise.all([hashLongTermMemoryVaultFiles(root), readLtmIndexState(root)]);
  if (state.revision !== expectedRevision || stableJsonHash(currentFiles) !== sourceHash) {
    throw new LtmIndexSnapshotChangedError("Long-term memory vault changed during index rebuild.");
  }
}
