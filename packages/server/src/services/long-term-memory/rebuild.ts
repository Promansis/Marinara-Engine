import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { LtmIndexMetadata } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { embedMemoryRecallTexts, type MemoryRecallEmbeddingOptions } from "../memory-recall.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { buildLtmBm25Index, type LtmBm25Index } from "./bm25.js";
import { chunkNotes, stableJsonHash, type LtmMemoryChunk } from "./chunking.js";
import { buildLtmGraphIndex, type LtmGraphIndex } from "./graph.js";
import { buildLtmMetadataIndex, type LtmMetadataIndex } from "./metadata-index.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";
import { invalidateLongTermMemoryRetrievalCache } from "./retrieval.js";
import { LongTermMemoryStorage } from "./storage.js";

export interface LtmEmbeddingIndexEntry {
  chunkId: string;
  sourceHash: string;
  vector?: number[];
}

export interface LtmEmbeddingIndex {
  version: 1;
  model: string;
  dimension: number | null;
  embeddedChunkCount: number;
  chunks: LtmEmbeddingIndexEntry[];
}

export interface LtmRebuildResult {
  root: string;
  generatedAt: string;
  noteCount: number;
  chunkCount: number;
  sourceChunkCount: number;
  embeddedChunkCount: number;
  embeddingsAvailable: boolean;
  manifest: LtmIndexMetadata;
}

export interface LtmRebuildOptions extends MemoryRecallEmbeddingOptions {
  root?: string;
  generatedAt?: string;
  scope?: LtmRebuildScope;
}

export type LtmRebuildScope = "all" | "typed" | "source";

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    logger.warn(err, "Failed to list files in %s", root);
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

async function hashSourceFiles(root: string) {
  const dirs = getLongTermMemoryDirectories(root);
  const files = [...(await listFiles(dirs.vault)), ...(await listFiles(dirs.config))].sort((a, b) =>
    a.localeCompare(b),
  );

  const hashes: Record<string, string> = {};
  for (const file of files) {
    const relativePath = relative(root, file).split(/[\\/]+/).join("/");
    hashes[relativePath] = stableJsonHash(await readFile(file, "utf8"));
  }
  return hashes;
}

async function buildEmbeddingIndex(chunks: LtmMemoryChunk[], options: MemoryRecallEmbeddingOptions) {
  let vectors: number[][] = [];
  if (chunks.length > 0) {
    try {
      vectors = await embedMemoryRecallTexts(
        chunks.map((chunk) => chunk.text),
        options,
      );
    } catch (err) {
      logger.warn(err, "Embedding failed for %d chunks", chunks.length);
      throw err;
    }
  }

  const dimension = vectors.find((vector) => vector.length > 0)?.length ?? null;
  const entries = chunks.map((chunk, index) => {
    const vector = vectors[index];
    return vector && vector.length > 0
      ? { chunkId: chunk.id, sourceHash: chunk.sourceHash, vector }
      : { chunkId: chunk.id, sourceHash: chunk.sourceHash };
  });

  const embeddedChunkCount = entries.filter((entry) => entry.vector && entry.vector.length > 0).length;

  return {
    version: 1,
    model: options.embeddingSource?.label ?? "Xenova/all-MiniLM-L6-v2",
    dimension,
    embeddedChunkCount,
    chunks: entries,
  } satisfies LtmEmbeddingIndex;
}

function includesTypedIndexes(scope: LtmRebuildScope) {
  return scope === "all" || scope === "typed";
}

function includesSourceIndexes(scope: LtmRebuildScope) {
  return scope === "all" || scope === "source";
}

async function writeTypedIndexes(root: string, notes: Awaited<ReturnType<LongTermMemoryStorage["listNotes"]>>, options: MemoryRecallEmbeddingOptions) {
  const chunks = chunkNotes(notes);
  const embeddings = await buildEmbeddingIndex(chunks, options);
  const bm25 = buildLtmBm25Index(chunks);
  const graph = buildLtmGraphIndex(notes, chunks);
  const metadata = buildLtmMetadataIndex(chunks);
  const dirs = getLongTermMemoryDirectories(root);

  await writeJsonAtomic(safeJoin(dirs.indexes, "embeddings.json"), embeddings);
  await writeJsonAtomic(safeJoin(dirs.indexes, "bm25.json"), bm25 satisfies LtmBm25Index);
  await writeJsonAtomic(safeJoin(dirs.indexes, "graph.json"), graph satisfies LtmGraphIndex);
  await writeJsonAtomic(safeJoin(dirs.indexes, "metadata.json"), metadata satisfies LtmMetadataIndex);

  return { chunks, embeddings };
}

async function writeSourceIndexes(
  root: string,
  notes: Awaited<ReturnType<LongTermMemoryStorage["listNotes"]>>,
  options: MemoryRecallEmbeddingOptions,
) {
  const chunks = chunkNotes(notes, { sourceNotesOnly: true });
  const embeddings = await buildEmbeddingIndex(chunks, options);
  const bm25 = buildLtmBm25Index(chunks);
  const graph = buildLtmGraphIndex(notes, chunks);
  const metadata = buildLtmMetadataIndex(chunks);
  const dirs = getLongTermMemoryDirectories(root);

  await writeJsonAtomic(safeJoin(dirs.indexes, "source-embeddings.json"), embeddings);
  await writeJsonAtomic(safeJoin(dirs.indexes, "source-bm25.json"), bm25 satisfies LtmBm25Index);
  await writeJsonAtomic(safeJoin(dirs.indexes, "source-graph.json"), graph satisfies LtmGraphIndex);
  await writeJsonAtomic(safeJoin(dirs.indexes, "source-metadata.json"), metadata satisfies LtmMetadataIndex);

  return { chunks, embeddings };
}

export async function rebuildLongTermMemoryIndexes(options: LtmRebuildOptions = {}): Promise<LtmRebuildResult> {
  const root = options.root ?? getLongTermMemoryRoot();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope ?? "all";
  const storage = new LongTermMemoryStorage(root);
  await storage.initializeLtmStore();

  const notes = await storage.listNotes();
  const typedChunks = chunkNotes(notes);
  const sourceChunks = chunkNotes(notes, { sourceNotesOnly: true });
  const typedResult = includesTypedIndexes(scope) ? await writeTypedIndexes(root, notes, options) : null;
  if (includesSourceIndexes(scope)) {
    await writeSourceIndexes(root, notes, options);
  }
  const sourceFiles = await hashSourceFiles(root);
  const sourceHash = stableJsonHash(sourceFiles);
  const manifest: LtmIndexMetadata = {
    version: 1,
    generatedAt,
    sourceHash,
    noteCount: notes.length,
    chunkCount: typedChunks.length,
    files: sourceFiles,
  };

  const dirs = getLongTermMemoryDirectories(root);
  await writeJsonAtomic(safeJoin(dirs.indexes, "manifest.json"), manifest);
  if (scope === "all") {
    invalidateLongTermMemoryRetrievalCache(root);
  } else {
    invalidateLongTermMemoryRetrievalCache(root, scope === "source");
  }

  return {
    root,
    generatedAt,
    noteCount: notes.length,
    chunkCount: typedChunks.length,
    sourceChunkCount: sourceChunks.length,
    embeddedChunkCount: typedResult?.embeddings.embeddedChunkCount ?? 0,
    embeddingsAvailable: Boolean(typedResult?.embeddings.embeddedChunkCount),
    manifest,
  };
}
