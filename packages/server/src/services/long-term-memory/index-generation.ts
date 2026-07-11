import { readdir, readFile, rm } from "node:fs/promises";
import {
  ltmBm25IndexSchema,
  ltmEmbeddingIndexSchema,
  ltmGraphIndexSchema,
  ltmIndexGenerationManifestSchema,
  ltmIndexPointerSchema,
  ltmKeywordIndexSchema,
  ltmMetadataIndexSchema,
  type LtmBm25Index,
  type LtmEmbeddingIndex,
  type LtmGraphIndex,
  type LtmIndexFamily,
  type LtmIndexGenerationManifest,
  type LtmIndexPointer,
  type LtmKeywordIndex,
  type LtmMetadataIndex,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { stableJsonHash } from "./chunking.js";
import { quarantineLtmIndexArtifact } from "./index-quarantine.js";
import { isEnoent } from "./ltm-utils.js";
import { getLongTermMemoryDirectories, safeJoin } from "./paths.js";

export type LtmIndexFamilyBundle = {
  metadata: LtmMetadataIndex;
  bm25: LtmBm25Index;
  graph: LtmGraphIndex;
  keywords: LtmKeywordIndex;
  embeddings: LtmEmbeddingIndex;
};

export type LtmIndexGenerationBundle = Partial<Record<LtmIndexFamily, LtmIndexFamilyBundle>>;

export type LtmIndexGenerationLoadResult = {
  pointer: LtmIndexPointer | null;
  pointerStatus: "missing" | "valid" | "invalid";
  currentManifest: LtmIndexGenerationManifest | null;
  manifest: LtmIndexGenerationManifest | null;
  bundles: LtmIndexGenerationBundle;
  recovered: boolean;
  warnings: string[];
};

const FAMILY_FILE_NAMES = {
  typed: {
    metadata: "metadata.json",
    bm25: "bm25.json",
    graph: "graph.json",
    keywords: "keywords.json",
    embeddings: "embeddings.json",
  },
  source: {
    metadata: "source-metadata.json",
    bm25: "source-bm25.json",
    graph: "source-graph.json",
    keywords: "source-keywords.json",
    embeddings: "source-embeddings.json",
  },
} as const;

const FILE_SCHEMAS = {
  metadata: ltmMetadataIndexSchema,
  bm25: ltmBm25IndexSchema,
  graph: ltmGraphIndexSchema,
  keywords: ltmKeywordIndexSchema,
  embeddings: ltmEmbeddingIndexSchema,
} as const;

function generationDirectory(root: string, generationId: string) {
  return safeJoin(getLongTermMemoryDirectories(root).indexes, `generations/${generationId}`);
}

export function ltmIndexPointerPath(root: string) {
  return safeJoin(getLongTermMemoryDirectories(root).indexes, "current.json");
}

export function ltmIndexGenerationManifestPath(root: string, generationId: string) {
  return safeJoin(generationDirectory(root, generationId), "manifest.json");
}

function familyFilePath(root: string, generationId: string, family: LtmIndexFamily, fileName: string) {
  return safeJoin(generationDirectory(root, generationId), fileName);
}

async function readValidatedJson<T>(path: string, parse: (value: unknown) => T) {
  return parse(JSON.parse(await readFile(path, "utf8")));
}

async function fileHash(path: string) {
  return stableJsonHash(await readFile(path, "utf8"));
}

function assertSameIds(label: string, expected: string[], actual: string[]) {
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new Error(`Long-term memory ${label} chunk ids do not match metadata.`);
  }
}

function assertChunkBucketReferences(
  label: string,
  buckets: Record<string, string[]>,
  chunkIds: Set<string>,
) {
  for (const [key, values] of Object.entries(buckets)) {
    const seen = new Set<string>();
    for (const chunkId of values) {
      if (!chunkIds.has(chunkId)) {
        throw new Error(`Long-term memory ${label} bucket ${key} references missing chunk ${chunkId}.`);
      }
      if (seen.has(chunkId)) {
        throw new Error(`Long-term memory ${label} bucket ${key} repeats chunk ${chunkId}.`);
      }
      seen.add(chunkId);
    }
  }
}

function validateFamilyCoherence(bundle: LtmIndexFamilyBundle) {
  const chunkIds = Object.keys(bundle.metadata.chunks).sort((a, b) => a.localeCompare(b));
  const chunkIdSet = new Set(chunkIds);
  for (const [chunkId, chunk] of Object.entries(bundle.metadata.chunks)) {
    if (chunk.id !== chunkId) {
      throw new Error(`Long-term memory metadata key ${chunkId} does not match chunk id ${chunk.id}.`);
    }
  }
  assertChunkBucketReferences("metadata note", bundle.metadata.byNoteId, chunkIdSet);
  assertChunkBucketReferences("metadata type", bundle.metadata.byType, chunkIdSet);
  assertChunkBucketReferences("metadata status", bundle.metadata.byStatus, chunkIdSet);
  assertChunkBucketReferences("metadata tag", bundle.metadata.byTag, chunkIdSet);
  assertChunkBucketReferences("metadata chat scope", bundle.metadata.byScope.chatId, chunkIdSet);
  assertChunkBucketReferences("metadata group scope", bundle.metadata.byScope.groupId, chunkIdSet);
  assertChunkBucketReferences("metadata character scope", bundle.metadata.byScope.characterId, chunkIdSet);
  if (bundle.bm25.chunkCount !== chunkIds.length) {
    throw new Error("Long-term memory BM25 chunk count does not match metadata.");
  }
  assertSameIds(
    "BM25",
    chunkIds,
    Object.keys(bundle.bm25.documents).sort((a, b) => a.localeCompare(b)),
  );
  for (const [term, entry] of Object.entries(bundle.bm25.terms)) {
    if (entry.documentFrequency !== entry.postings.length) {
      throw new Error(`Long-term memory BM25 term ${term} has an inconsistent document frequency.`);
    }
    const seen = new Set<string>();
    for (const posting of entry.postings) {
      if (!chunkIdSet.has(posting.chunkId)) {
        throw new Error(`Long-term memory BM25 posting references missing chunk ${posting.chunkId}.`);
      }
      if (seen.has(posting.chunkId)) {
        throw new Error(`Long-term memory BM25 term ${term} repeats chunk ${posting.chunkId}.`);
      }
      seen.add(posting.chunkId);
      const documentLength = bundle.bm25.documents[posting.chunkId]?.length ?? 0;
      if (posting.count > documentLength) {
        throw new Error(`Long-term memory BM25 term ${term} exceeds chunk ${posting.chunkId} length.`);
      }
    }
  }
  assertSameIds(
    "embedding",
    chunkIds,
    bundle.embeddings.chunks.map((entry) => entry.chunkId).sort((a, b) => a.localeCompare(b)),
  );
  for (const entry of bundle.embeddings.chunks) {
    if (entry.sourceHash !== bundle.metadata.chunks[entry.chunkId]?.sourceHash) {
      throw new Error(`Long-term memory embedding source hash does not match chunk ${entry.chunkId}.`);
    }
  }
  assertSameIds(
    "keyword",
    chunkIds,
    Object.keys(bundle.keywords.byChunkId).sort((a, b) => a.localeCompare(b)),
  );
  assertChunkBucketReferences("keyword", bundle.keywords.byKeyword, chunkIdSet);
  for (const [chunkId, keywords] of Object.entries(bundle.keywords.byChunkId)) {
    for (const keyword of keywords) {
      if (!bundle.keywords.byKeyword[keyword]?.includes(chunkId)) {
        throw new Error(`Long-term memory keyword ${keyword} is missing reverse chunk ${chunkId}.`);
      }
    }
  }
  for (const [keyword, keywordChunkIds] of Object.entries(bundle.keywords.byKeyword)) {
    for (const chunkId of keywordChunkIds) {
      if (!bundle.keywords.byChunkId[chunkId]?.includes(keyword)) {
        throw new Error(`Long-term memory keyword chunk ${chunkId} is missing reverse keyword ${keyword}.`);
      }
    }
  }
  for (const [noteId, node] of Object.entries(bundle.graph.nodes)) {
    for (const chunkId of node.chunkIds) {
      const chunk = bundle.metadata.chunks[chunkId];
      if (!chunk) {
        throw new Error(`Long-term memory graph references missing chunk ${chunkId}.`);
      }
      if (chunk.noteId !== noteId) {
        throw new Error(`Long-term memory graph node ${noteId} contains chunk from note ${chunk.noteId}.`);
      }
    }
    for (const edge of node.outgoing) {
      if (edge.source !== noteId || !bundle.graph.nodes[edge.target]) {
        throw new Error(`Long-term memory graph has an invalid outgoing edge from ${noteId}.`);
      }
    }
    for (const edge of node.incoming) {
      if (edge.target !== noteId || !bundle.graph.nodes[edge.source]) {
        throw new Error(`Long-term memory graph has an invalid incoming edge to ${noteId}.`);
      }
    }
  }
}

export async function writeLtmIndexFamilyGeneration(
  root: string,
  generationId: string,
  family: LtmIndexFamily,
  bundle: LtmIndexFamilyBundle,
) {
  const parsedBundle: LtmIndexFamilyBundle = {
    metadata: ltmMetadataIndexSchema.parse(bundle.metadata),
    bm25: ltmBm25IndexSchema.parse(bundle.bm25),
    graph: ltmGraphIndexSchema.parse(bundle.graph),
    keywords: ltmKeywordIndexSchema.parse(bundle.keywords),
    embeddings: ltmEmbeddingIndexSchema.parse(bundle.embeddings),
  };
  validateFamilyCoherence(parsedBundle);
  const names = FAMILY_FILE_NAMES[family];
  const hashes: Record<string, string> = {};
  for (const key of Object.keys(names) as Array<keyof typeof names>) {
    const name = names[key];
    const path = familyFilePath(root, generationId, family, name);
    await writeJsonAtomic(path, parsedBundle[key]);
    hashes[name] = await fileHash(path);
  }
  return hashes;
}

export async function writeLtmIndexGenerationManifest(root: string, manifest: LtmIndexGenerationManifest) {
  const parsed = ltmIndexGenerationManifestSchema.parse(manifest);
  await writeJsonAtomic(ltmIndexGenerationManifestPath(root, parsed.generationId), parsed);
  return parsed;
}

export async function publishLtmIndexGeneration(root: string, pointer: LtmIndexPointer) {
  const requested = ltmIndexPointerSchema.parse(pointer);
  await readCompleteLtmIndexGeneration(root, requested.generationId);
  const previous = await readLtmIndexPointer(root).catch(async (err) => {
    logger.warn(err, "[ltm] Quarantining malformed current index pointer before publication");
    await quarantineLtmIndexArtifact(root, ltmIndexPointerPath(root));
    return null;
  });
  const fallbackGenerationIds = Array.from(
    new Set([
      ...(previous ? [previous.generationId] : []),
      ...(previous?.fallbackGenerationIds ?? []),
      ...(requested.fallbackGenerationIds ?? []),
    ]),
  )
    .filter((generationId) => generationId !== requested.generationId)
    .slice(0, 2);
  const parsed = ltmIndexPointerSchema.parse({ ...requested, fallbackGenerationIds });
  await writeJsonAtomic(ltmIndexPointerPath(root), parsed);
  return parsed;
}

export async function readLtmIndexPointer(root: string) {
  try {
    return await readValidatedJson(ltmIndexPointerPath(root), (value) => ltmIndexPointerSchema.parse(value));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function readLtmIndexGenerationManifest(root: string, generationId: string) {
  const manifest = await readValidatedJson(ltmIndexGenerationManifestPath(root, generationId), (value) =>
    ltmIndexGenerationManifestSchema.parse(value),
  );
  if (manifest.generationId !== generationId) {
    throw new Error(`Long-term memory generation manifest id mismatch: ${generationId}.`);
  }
  if (stableJsonHash(manifest.sourceFiles) !== manifest.sourceHash) {
    throw new Error(`Long-term memory generation ${generationId} source hash does not match its source file inventory.`);
  }
  return manifest;
}

export async function readLtmIndexFamilyGeneration(
  root: string,
  generationId: string,
  family: LtmIndexFamily,
) {
  const manifest = await readLtmIndexGenerationManifest(root, generationId);
  const summary = manifest.families[family];
  if (!summary) return null;
  const names = FAMILY_FILE_NAMES[family];
  const bundle = {} as LtmIndexFamilyBundle;
  for (const key of Object.keys(names) as Array<keyof typeof names>) {
    const name = names[key];
    const path = familyFilePath(root, generationId, family, name);
    const expectedHash = summary.files[name];
    if (!expectedHash || (await fileHash(path)) !== expectedHash) {
      throw new Error(`Long-term memory generation ${generationId} has an invalid ${name} hash.`);
    }
    bundle[key] = await readValidatedJson(path, (value) => FILE_SCHEMAS[key].parse(value)) as never;
  }
  validateFamilyCoherence(bundle);
  if (Object.keys(bundle.metadata.chunks).length !== summary.chunkCount) {
    throw new Error(`Long-term memory generation ${generationId} ${family} chunk count is inconsistent.`);
  }
  if (bundle.embeddings.embeddedChunkCount !== summary.embeddedChunkCount) {
    throw new Error(`Long-term memory generation ${generationId} ${family} embedding count is inconsistent.`);
  }
  return { manifest, bundle };
}

async function listGenerationManifests(root: string) {
  const generationsRoot = safeJoin(getLongTermMemoryDirectories(root).indexes, "generations");
  const entries = await readdir(generationsRoot, { withFileTypes: true }).catch((err) => {
    if (isEnoent(err)) return [];
    throw err;
  });
  const manifests: LtmIndexGenerationManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(await readLtmIndexGenerationManifest(root, entry.name));
    } catch (err) {
      logger.warn(err, "[ltm] Ignoring invalid index generation %s", entry.name);
    }
  }
  return manifests.sort(
    (left, right) => right.generatedAt.localeCompare(left.generatedAt) || right.generationId.localeCompare(left.generationId),
  );
}

async function readCompleteLtmIndexGeneration(
  root: string,
  generationId: string,
  knownManifest?: LtmIndexGenerationManifest,
) {
  const manifest = knownManifest ?? (await readLtmIndexGenerationManifest(root, generationId));
  if (!manifest.families.typed) {
    throw new Error(`Long-term memory generation ${generationId} has no typed index family.`);
  }

  const bundles: LtmIndexGenerationBundle = {};
  for (const family of ["typed", "source"] as const) {
    if (!manifest.families[family]) continue;
    const loaded = await readLtmIndexFamilyGeneration(root, generationId, family);
    if (!loaded) {
      throw new Error(`Long-term memory generation ${generationId} has no ${family} index family.`);
    }
    bundles[family] = loaded.bundle;
  }

  if (manifest.chunkCount !== manifest.families.typed.chunkCount) {
    throw new Error(`Long-term memory generation ${generationId} typed chunk count is inconsistent.`);
  }
  if (manifest.families.source) {
    if (manifest.sourceChunkCount !== manifest.families.source.chunkCount) {
      throw new Error(`Long-term memory generation ${generationId} source chunk count is inconsistent.`);
    }
  } else if (manifest.sourceChunkCount !== 0) {
    throw new Error(`Long-term memory generation ${generationId} is missing its source index family.`);
  }

  return { manifest, bundles };
}

async function quarantineInvalidIndexGeneration(root: string, generationId: string, err: unknown) {
  const quarantined = await quarantineLtmIndexArtifact(root, generationDirectory(root, generationId));
  if (quarantined) {
    logger.warn(err, "[ltm] Quarantining invalid index generation %s", generationId);
  }
}

export async function loadLtmIndexGeneration(root: string): Promise<LtmIndexGenerationLoadResult> {
  const warnings: string[] = [];
  let pointer: LtmIndexPointer | null = null;
  let currentManifest: LtmIndexGenerationManifest | null = null;
  let pointerStatus: LtmIndexGenerationLoadResult["pointerStatus"] = "missing";
  try {
    pointer = await readLtmIndexPointer(root);
    pointerStatus = pointer ? "valid" : "missing";
  } catch (err) {
    pointerStatus = "invalid";
    logger.warn(err, "[ltm] Current index pointer is invalid");
    await quarantineLtmIndexArtifact(root, ltmIndexPointerPath(root)).catch((quarantineErr) => {
      logger.warn(quarantineErr, "[ltm] Failed to quarantine invalid current index pointer");
    });
    warnings.push("Current long-term memory index pointer is invalid.");
  }

  if (pointer) {
    try {
      const current = await readCompleteLtmIndexGeneration(root, pointer.generationId);
      currentManifest = current.manifest;
      return { ...current, pointer, pointerStatus, currentManifest, recovered: false, warnings };
    } catch (err) {
      await quarantineInvalidIndexGeneration(root, pointer.generationId, err).catch((quarantineErr) => {
        logger.warn(quarantineErr, "[ltm] Failed to quarantine invalid current index generation");
      });
      warnings.push("Current long-term memory index generation is invalid.");
    }
  } else if (pointerStatus === "missing") {
    warnings.push("Long-term memory indexes are not built.");
    return { pointer, pointerStatus, currentManifest, manifest: null, bundles: {}, recovered: false, warnings };
  }

  if (!pointer) {
    return { pointer, pointerStatus, currentManifest, manifest: null, bundles: {}, recovered: false, warnings };
  }

  for (const generationId of pointer.fallbackGenerationIds ?? []) {
    try {
      const candidate = await readCompleteLtmIndexGeneration(root, generationId);
      warnings.push(`Recovered indexes from generation ${generationId}.`);
      return { ...candidate, pointer, pointerStatus, currentManifest, recovered: true, warnings };
    } catch (err) {
      await quarantineInvalidIndexGeneration(root, generationId, err).catch((quarantineErr) => {
        logger.warn(quarantineErr, "[ltm] Failed to quarantine invalid fallback index generation");
      });
      continue;
    }
  }

  return { pointer, pointerStatus, currentManifest, manifest: null, bundles: {}, recovered: false, warnings };
}

export async function loadLtmIndexFamily(root: string, family: LtmIndexFamily) {
  const generation = await loadLtmIndexGeneration(root);
  const bundle = generation.bundles[family] ?? null;
  const warnings = [...generation.warnings];
  if (generation.manifest && !bundle) {
    warnings.push(`Current long-term memory generation has no ${family} index family.`);
  }
  return {
    manifest: generation.manifest,
    bundle,
    pointer: generation.pointer,
    recovered: generation.recovered,
    warnings,
  };
}

export async function removeLtmIndexGeneration(root: string, generationId: string) {
  await rm(generationDirectory(root, generationId), { recursive: true, force: true });
}

export async function pruneLtmIndexGenerations(root: string, keep = 3) {
  const pointer = await readLtmIndexPointer(root).catch(() => null);
  const manifests = await listGenerationManifests(root);
  const retained = new Set(
    pointer ? [pointer.generationId, ...(pointer.fallbackGenerationIds ?? [])].slice(0, Math.max(1, keep)) : [],
  );
  await Promise.all(
    manifests
      .filter((manifest) => !retained.has(manifest.generationId))
      .map((manifest) => removeLtmIndexGeneration(root, manifest.generationId)),
  );
}
