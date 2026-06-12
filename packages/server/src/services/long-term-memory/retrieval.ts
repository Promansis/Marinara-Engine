import { readFile } from "node:fs/promises";
import {
  ltmPoliciesConfigSchema,
  ltmRetrievalConfigSchema,
  getLtmScopeChatIds,
  type LtmGate,
  type LtmPoliciesConfig,
  type LtmRetrievalConfig,
  type LtmScope,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { embedMemoryRecallTexts, type MemoryRecallEmbeddingOptions } from "../memory-recall.js";
import { DEFAULT_LTM_POLICIES, DEFAULT_LTM_RETRIEVAL_CONFIG } from "./default-config.js";
import type { LtmBm25Index } from "./bm25.js";
import { searchLtmBm25 } from "./bm25.js";
import type { LtmMemoryChunk } from "./chunking.js";
import type { LtmGraphIndex } from "./graph.js";
import { expandLtmGraph } from "./graph.js";
import type { LtmEmbeddingIndex } from "./rebuild.js";
import type { LtmMetadataIndex } from "./metadata-index.js";
import { getLtmMetadataMatches } from "./metadata-index.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";
import { applyLtmBudget, type LtmBudgetedChunk } from "./budget.js";
import { reciprocalRankFuse, type LtmRankLane } from "./ranking.js";

export interface RetrieveLongTermMemoryInput extends MemoryRecallEmbeddingOptions {
  root?: string;
  queryText?: string;
  recentUserMessage?: string;
  mentionedCharacterNames?: string[];
  noteIds?: string[];
  tags?: string[];
  scope?: LtmScope;
  characterIds?: string[];
  includeGates?: LtmGate[];
  includeArchived?: boolean;
  includeResolved?: boolean;
  includeSourceNotes?: boolean;
  debug?: boolean;
  maxChunks?: number;
  maxTokens?: number;
}

export interface RetrieveLongTermMemoryResult {
  chunks: LtmBudgetedChunk[];
  usedTokens: number;
  maxTokens: number;
  embeddingsAvailable: boolean;
  warnings: string[];
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index]! * b[index]!;
    magA += a[index]! * a[index]!;
    magB += b[index]! * b[index]!;
  }
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}

async function readIndexFile<T>(path: string, warnings: string[]): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      warnings.push(`Missing index ${path}`);
      return null;
    }
    logger.warn(err, "[ltm] Failed to read long-term memory index %s", path);
    warnings.push(`Failed to read index ${path}`);
    return null;
  }
}

async function readConfig<T>(path: string, fallback: T, parse: (value: unknown) => T) {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(err, "[ltm] Falling back to default long-term memory config for %s", path);
    }
    return fallback;
  }
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function extractQuerySignals(input: RetrieveLongTermMemoryInput) {
  const queryParts = [
    input.queryText ?? "",
    input.recentUserMessage ?? "",
    ...(input.mentionedCharacterNames ?? []),
  ].filter(Boolean);
  const queryText = queryParts.join("\n");
  const noteIds = uniqueSorted([
    ...(input.noteIds ?? []),
    ...Array.from(
      queryText.matchAll(
        /\b(?:source|char|rel|scene|thread|cb|world|faction|location|rule|voice|tone)_[a-z0-9_]+\b/g,
      ),
      (match) => match[0],
    ),
  ]);
  const tags = uniqueSorted([
    ...(input.tags ?? []),
    ...Array.from(queryText.matchAll(/#([a-z][a-z0-9_]+)/g), (match) => match[1]!),
  ]);
  const characterIds = uniqueSorted([...(input.characterIds ?? []), ...(input.scope?.characterIds ?? [])]);
  return { queryText, noteIds, tags, characterIds };
}

function scopeMatches(chunk: LtmMemoryChunk, scope: LtmScope | undefined, characterIds: string[]) {
  const activeCharacters = new Set(characterIds);
  const activeChatIds = new Set(getLtmScopeChatIds(scope));
  const chunkChatIds = getLtmScopeChatIds(chunk.scope);
  const hasCallerScope =
    Boolean(activeChatIds.size || scope?.groupId || scope?.rpId || scope?.universe || scope?.characterIds?.length) ||
    activeCharacters.size > 0;
  const chunkHasScope = Boolean(
    chunkChatIds.length ||
    chunk.scope.groupId ||
    chunk.scope.rpId ||
    chunk.scope.universe ||
    chunk.scope.characterIds?.length,
  );

  if (!hasCallerScope) return !chunkHasScope;

  if (chunkChatIds.length) return chunkChatIds.some((chatId) => activeChatIds.has(chatId));
  if (chunk.scope.groupId) return chunk.scope.groupId === scope?.groupId;
  if (chunk.scope.characterIds?.length) return chunk.scope.characterIds.some((id) => activeCharacters.has(id));
  if (chunk.noteType === "character" && activeCharacters.has(chunk.noteId)) return true;
  if (chunk.scope.rpId) return chunk.scope.rpId === scope?.rpId;
  if (chunk.scope.universe) return chunk.scope.universe === scope?.universe;
  return true;
}

function gateAllows(chunk: LtmMemoryChunk, includeGates: Set<LtmGate>) {
  return chunk.gates.length === 0 || chunk.gates.every((gate) => includeGates.has(gate));
}

function isSourceSummaryChunk(chunk: LtmMemoryChunk) {
  return chunk.tags.includes("source_summary") || chunk.tags.includes("chat_summary");
}

function candidateAllowed(
  chunk: LtmMemoryChunk,
  input: RetrieveLongTermMemoryInput,
  config: LtmRetrievalConfig,
  characterIds: string[],
) {
  const includeGates = new Set([...(config.includeGates ?? []), ...(input.includeGates ?? [])]);
  if (!input.includeSourceNotes && isSourceSummaryChunk(chunk)) return false;
  if (!input.includeArchived && chunk.status === "archived") return false;
  if (!input.includeResolved && chunk.status === "resolved" && chunk.noteType === "thread") return false;
  if (!gateAllows(chunk, includeGates)) return false;
  return scopeMatches(chunk, input.scope, characterIds);
}

function alwaysLane(
  metadata: LtmMetadataIndex,
  policies: LtmPoliciesConfig,
  input: RetrieveLongTermMemoryInput,
  config: LtmRetrievalConfig,
  characterIds: string[],
) {
  const items = [];
  const activeCharacters = new Set(characterIds);
  for (const policy of policies.policies) {
    if (policy.injection !== "always_for_active_characters") continue;
    for (const chunkId of metadata.byType[policy.type] ?? []) {
      const chunk = metadata.chunks[chunkId];
      if (!chunk) continue;
      if (
        policy.type === "character" &&
        !activeCharacters.has(chunk.noteId) &&
        !chunk.scope.characterIds?.some((characterId) => activeCharacters.has(characterId))
      ) {
        continue;
      }
      if (!policy.sectionsAlways.includes(chunk.sectionKey)) continue;
      if (!candidateAllowed(chunk, input, config, characterIds)) continue;
      items.push({ chunkId, reason: `always:${policy.type}.${chunk.sectionKey}`, rawScore: 1 });
    }
  }

  for (const chunk of Object.values(metadata.chunks)) {
    if (
      (chunk.noteType === "tone" ||
        chunk.noteType === "voice" ||
        (chunk.noteType === "scene" && chunk.tags.includes("current_scene"))) &&
      candidateAllowed(chunk, input, config, characterIds)
    ) {
      items.push({ chunkId: chunk.id, reason: `always:${chunk.noteType}`, rawScore: 0.8 });
    }
  }

  return items.sort((a, b) => b.rawScore - a.rawScore || a.chunkId.localeCompare(b.chunkId));
}

function typedPriorityLane(
  metadata: LtmMetadataIndex,
  input: RetrieveLongTermMemoryInput,
  config: LtmRetrievalConfig,
  characterIds: string[],
) {
  return Object.values(metadata.chunks)
    .flatMap((chunk) => {
      if (!candidateAllowed(chunk, input, config, characterIds)) return [];
      if (chunk.noteType === "relationship" && chunk.sectionKey === "state") {
        return [{ chunkId: chunk.id, reason: "priority:relationship_state", rawScore: 0.95 }];
      }
      if (chunk.noteType === "relationship" && chunk.sectionKey === "arc") {
        return [{ chunkId: chunk.id, reason: "priority:relationship_arc", rawScore: 0.9 }];
      }
      if (chunk.noteType === "scene" && chunk.tags.includes("current_scene")) {
        return [{ chunkId: chunk.id, reason: "priority:current_scene", rawScore: 0.9 }];
      }
      return [];
    })
    .sort((a, b) => b.rawScore - a.rawScore || a.chunkId.localeCompare(b.chunkId));
}

async function vectorLane(
  embeddings: LtmEmbeddingIndex | null,
  queryText: string,
  input: RetrieveLongTermMemoryInput,
  config: LtmRetrievalConfig,
  chunksById: Map<string, LtmMemoryChunk>,
  characterIds: string[],
) {
  if (!embeddings || !embeddings.dimension || queryText.trim().length === 0) return { items: [], available: false };

  const queryEmbedding = (await embedMemoryRecallTexts([queryText], input))[0];
  if (!queryEmbedding || queryEmbedding.length === 0) return { items: [], available: false };

  let dimensionMismatchLogged = false;
  const items = embeddings.chunks
    .flatMap((entry) => {
      const chunk = chunksById.get(entry.chunkId);
      if (!entry.vector || !chunk || !candidateAllowed(chunk, input, config, characterIds)) return [];
      if (entry.vector.length !== queryEmbedding.length) {
        if (!dimensionMismatchLogged) {
          dimensionMismatchLogged = true;
          logger.warn(
            "[ltm] Skipping long-term memory vectors with dimensions that do not match query vector (%d vs %d)",
            entry.vector.length,
            queryEmbedding.length,
          );
        }
        return [];
      }
      const score = cosineSimilarity(queryEmbedding, entry.vector);
      return score > 0 ? [{ chunkId: entry.chunkId, reason: "vector", rawScore: score }] : [];
    })
    .sort((a, b) => b.rawScore - a.rawScore || a.chunkId.localeCompare(b.chunkId))
    .slice(0, 50);

  return { items, available: items.length > 0 };
}

export async function retrieveLongTermMemory(
  input: RetrieveLongTermMemoryInput = {},
): Promise<RetrieveLongTermMemoryResult> {
  const root = input.root ?? getLongTermMemoryRoot();
  const dirs = getLongTermMemoryDirectories(root);
  const warnings: string[] = [];
  const indexPrefix = input.includeSourceNotes ? "source-" : "";
  const [metadata, bm25, graph, embeddings, config, policies] = await Promise.all([
    readIndexFile<LtmMetadataIndex>(safeJoin(dirs.indexes, `${indexPrefix}metadata.json`), warnings),
    readIndexFile<LtmBm25Index>(safeJoin(dirs.indexes, `${indexPrefix}bm25.json`), warnings),
    readIndexFile<LtmGraphIndex>(safeJoin(dirs.indexes, `${indexPrefix}graph.json`), warnings),
    readIndexFile<LtmEmbeddingIndex>(safeJoin(dirs.indexes, `${indexPrefix}embeddings.json`), warnings),
    readConfig(safeJoin(dirs.config, "retrieval.json"), DEFAULT_LTM_RETRIEVAL_CONFIG, (value) =>
      ltmRetrievalConfigSchema.parse(value),
    ),
    readConfig(safeJoin(dirs.config, "policies.json"), DEFAULT_LTM_POLICIES, (value) =>
      ltmPoliciesConfigSchema.parse(value),
    ),
  ]);

  if (!metadata) {
    return {
      chunks: [],
      usedTokens: 0,
      maxTokens: input.maxTokens ?? config.maxTokens,
      embeddingsAvailable: false,
      warnings,
    };
  }

  const signals = extractQuerySignals(input);
  const characterIds = uniqueSorted(signals.characterIds);
  const chunksById = new Map(Object.entries(metadata.chunks));
  if (!input.includeSourceNotes && input.debug) {
    const skippedSourceChunks = Object.values(metadata.chunks).filter(isSourceSummaryChunk).length;
    if (skippedSourceChunks > 0) {
      warnings.push(
        `Skipped ${skippedSourceChunks} source summary chunk(s); set includeSourceNotes to search source audit indexes.`,
      );
    }
  } else if (input.includeSourceNotes && input.debug) {
    warnings.push("Searching source audit indexes; normal typed-memory indexes are not included.");
  }
  const metadataMatches = getLtmMetadataMatches(metadata, {
    noteIds: signals.noteIds,
    tags: signals.tags,
    scope: input.scope,
    characterIds,
  }).filter((candidate) => {
    const chunk = chunksById.get(candidate.chunkId);
    return chunk ? candidateAllowed(chunk, input, config, characterIds) : false;
  });

  const graphSeeds = uniqueSorted([
    ...signals.noteIds,
    ...metadataMatches.slice(0, 10).map((candidate) => chunksById.get(candidate.chunkId)?.noteId ?? ""),
  ]);

  const vector = await vectorLane(embeddings, signals.queryText, input, config, chunksById, characterIds);
  const lanes: LtmRankLane[] = [
    {
      name: "always",
      weight: 2,
      items: alwaysLane(metadata, policies, input, config, characterIds),
    },
    {
      name: "metadata",
      weight: 1,
      items: metadataMatches.map((match) => ({
        chunkId: match.chunkId,
        reason: match.reasons.join(","),
        rawScore: match.score,
      })),
    },
    {
      name: "typed_priority",
      weight: 1.5,
      items: typedPriorityLane(metadata, input, config, characterIds),
    },
  ];

  if (vector.items.length > 0) {
    lanes.push({ name: "vector", weight: config.semanticWeight, items: vector.items });
  }

  if (bm25 && signals.queryText.trim().length > 0) {
    lanes.push({
      name: "bm25",
      weight: config.lexicalWeight,
      items: searchLtmBm25(bm25, signals.queryText).flatMap((match) => {
        const chunk = chunksById.get(match.chunkId);
        return chunk && candidateAllowed(chunk, input, config, characterIds)
          ? [{ chunkId: match.chunkId, reason: "bm25", rawScore: match.score }]
          : [];
      }),
    });
  }

  if (graph && graphSeeds.length > 0) {
    lanes.push({
      name: "graph",
      weight: config.graphWeight,
      items: expandLtmGraph(graph, graphSeeds).flatMap((match) => {
        const chunk = chunksById.get(match.chunkId);
        return chunk && candidateAllowed(chunk, input, config, characterIds)
          ? [{ chunkId: match.chunkId, reason: `graph:${match.viaNoteId}:${match.distance}`, rawScore: match.score }]
          : [];
      }),
    });
  }

  const ranked = reciprocalRankFuse(lanes);
  const budgeted = applyLtmBudget(ranked, chunksById, {
    maxChunks: input.maxChunks ?? config.maxChunks,
    maxTokens: input.maxTokens ?? config.maxTokens,
  });

  return {
    chunks: budgeted.chunks,
    usedTokens: budgeted.usedTokens,
    maxTokens: budgeted.maxTokens,
    embeddingsAvailable: vector.available,
    warnings,
  };
}
