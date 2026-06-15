import { readFile } from "node:fs/promises";
import {
  ltmRetrievalConfigSchema,
  getLtmScopeChatIds,
  type LtmRetrievalConfig,
  type LtmScope,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { embedMemoryRecallTexts, type MemoryRecallEmbeddingOptions } from "../memory-recall.js";
import { DEFAULT_LTM_RETRIEVAL_CONFIG } from "./default-config.js";
import type { LtmBm25Index } from "./bm25.js";
import { searchLtmBm25 } from "./bm25.js";
import type { LtmMemoryChunk } from "./chunking.js";
import type { LtmGraphIndex } from "./graph.js";
import { expandLtmGraph } from "./graph.js";
import type { LtmEmbeddingIndex } from "./rebuild.js";
import type { LtmMetadataIndex } from "./metadata-index.js";
import { getLtmMetadataMatches } from "./metadata-index.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";
import { applyLtmBudget, type LtmBudgetedChunk, type LtmBudgetRejectedCandidate } from "./budget.js";
import { reciprocalRankFuse, type LtmRankLane } from "./ranking.js";

export interface RetrieveLongTermMemoryInput extends MemoryRecallEmbeddingOptions {
  root?: string;
  queryText?: string;
  recentUserMessage?: string;
  recentMessages?: string[];
  mentionedCharacterNames?: string[];
  noteIds?: string[];
  tags?: string[];
  scope?: LtmScope;
  characterIds?: string[];
  includeResolved?: boolean;
  includeSourceNotes?: boolean;
  debug?: boolean;
  explain?: boolean;
  maxChunks?: number;
  maxTokens?: number;
  minScore?: number;
  semanticWeight?: number;
  lexicalWeight?: number;
  graphWeight?: number;
  metadataWeight?: number;
}

export interface LtmRetrievalDebugCandidate {
  chunkId: string;
  noteId?: string;
  sectionKey?: string;
  noteType?: string;
  status?: string;
  score: number;
  lanes: string[];
  reasons: string[];
  laneScores?: Record<string, number>;
  rawLaneScores?: Record<string, number>;
  tier?: 1 | 2 | 3;
  estimatedTokens?: number;
  budgetIncluded?: boolean;
  rejectionReason?: string;
}

export interface LtmRetrievalDebugInfo {
  querySummary: {
    queryCharacters: number;
    recentUserMessageCharacters: number;
    mentionedCharacterCount: number;
    noteIdCount: number;
    tagCount: number;
    characterIdCount: number;
    scopeKeys: string[];
  };
  embeddingsAvailable: boolean;
  weights: {
    semantic: number;
    lexical: number;
    graph: number;
    metadata: number;
  };
  funnel: Record<string, number>;
  selected: LtmRetrievalDebugCandidate[];
  rejected: LtmRetrievalDebugCandidate[];
}

export interface RetrieveLongTermMemoryResult {
  chunks: LtmBudgetedChunk[];
  usedTokens: number;
  maxTokens: number;
  embeddingsAvailable: boolean;
  warnings: string[];
  debug?: LtmRetrievalDebugInfo;
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

type LtmRetrievalBundle = {
  metadata: LtmMetadataIndex | null;
  bm25: LtmBm25Index | null;
  graph: LtmGraphIndex | null;
  embeddings: LtmEmbeddingIndex | null;
  config: LtmRetrievalConfig;
  warnings: string[];
};

const retrievalBundleCache = new Map<string, Promise<LtmRetrievalBundle>>();

function retrievalBundleCacheKey(root: string, includeSourceNotes: boolean) {
  return `${root}\0${includeSourceNotes ? "source" : "typed"}`;
}

export function invalidateLongTermMemoryRetrievalCache(root?: string) {
  if (!root) {
    retrievalBundleCache.clear();
    return;
  }
  for (const key of retrievalBundleCache.keys()) {
    if (key.startsWith(`${root}\0`)) retrievalBundleCache.delete(key);
  }
}

async function loadRetrievalBundle(root: string, includeSourceNotes: boolean): Promise<LtmRetrievalBundle> {
  const key = retrievalBundleCacheKey(root, includeSourceNotes);
  const cached = retrievalBundleCache.get(key);
  if (cached) return cached;

  const load = (async () => {
    const dirs = getLongTermMemoryDirectories(root);
    const warnings: string[] = [];
    const indexPrefix = includeSourceNotes ? "source-" : "";
    const [metadata, bm25, graph, embeddings, config] = await Promise.all([
      readIndexFile<LtmMetadataIndex>(safeJoin(dirs.indexes, `${indexPrefix}metadata.json`), warnings),
      readIndexFile<LtmBm25Index>(safeJoin(dirs.indexes, `${indexPrefix}bm25.json`), warnings),
      readIndexFile<LtmGraphIndex>(safeJoin(dirs.indexes, `${indexPrefix}graph.json`), warnings),
      readIndexFile<LtmEmbeddingIndex>(safeJoin(dirs.indexes, `${indexPrefix}embeddings.json`), warnings),
      readConfig(safeJoin(dirs.config, "retrieval.json"), DEFAULT_LTM_RETRIEVAL_CONFIG, (value) =>
        ltmRetrievalConfigSchema.parse(value),
      ),
    ]);
    return { metadata, bm25, graph, embeddings, config, warnings };
  })();

  retrievalBundleCache.set(key, load);
  try {
    return await load;
  } catch (err) {
    retrievalBundleCache.delete(key);
    throw err;
  }
}

function resolveRetrievalWeights(config: LtmRetrievalConfig, input: RetrieveLongTermMemoryInput) {
  const semantic = input.semanticWeight ?? config.semanticWeight;
  const lexical = input.lexicalWeight ?? config.lexicalWeight;
  const graph = input.graphWeight ?? config.graphWeight;
  const metadata = input.metadataWeight ?? 1;
  if (semantic + lexical + graph + metadata <= 0) {
    return {
      semantic: config.semanticWeight,
      lexical: config.lexicalWeight,
      graph: config.graphWeight,
      metadata: 1,
    };
  }
  return { semantic, lexical, graph, metadata };
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function extractQuerySignals(input: RetrieveLongTermMemoryInput) {
  const recentMessagesText = input.recentMessages?.length
    ? input.recentMessages.filter(Boolean).join("\n")
    : "";
  const queryParts = [
    input.queryText ?? "",
    recentMessagesText || (input.recentUserMessage ?? ""),
    ...(input.mentionedCharacterNames ?? []),
  ].filter(Boolean);
  const queryText = queryParts.join("\n");
  const noteIds = uniqueSorted([
    ...(input.noteIds ?? []),
    ...Array.from(
      queryText.matchAll(/\b(?:source|char|rel|scene|thread|world|faction|location|rule|tone)_[a-z0-9_]+\b/g),
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
    Boolean(activeChatIds.size || scope?.groupId || scope?.characterIds?.length) ||
    activeCharacters.size > 0;
  const chunkHasScope = Boolean(
    chunkChatIds.length ||
    chunk.scope.groupId ||
    chunk.scope.characterIds?.length,
  );

  if (!hasCallerScope) return !chunkHasScope;

  if (chunkChatIds.length) return chunkChatIds.some((chatId) => activeChatIds.has(chatId));
  if (chunk.scope.groupId) return chunk.scope.groupId === scope?.groupId;
  if (chunk.scope.characterIds?.length) return chunk.scope.characterIds.some((id) => activeCharacters.has(id));
  if (chunk.noteType === "character" && activeCharacters.has(chunk.noteId)) return true;
  return true;
}

function isSourceSummaryChunk(chunk: LtmMemoryChunk) {
  return chunk.noteType === "source" || chunk.tags.includes("source_summary") || chunk.tags.includes("chat_summary");
}

function shouldFilterResolvedChunk(chunk: LtmMemoryChunk, input: RetrieveLongTermMemoryInput) {
  if (input.includeResolved || chunk.status !== "resolved") return false;
  return chunk.noteType === "thread";
}

function summarizeCandidateFilters(
  chunks: LtmMemoryChunk[],
  input: RetrieveLongTermMemoryInput,
  config: LtmRetrievalConfig,
  characterIds: string[],
) {
  const counts = {
    sourceSummariesSkipped: 0,
    resolvedFiltered: 0,
    scopeFiltered: 0,
  };

  for (const chunk of chunks) {
    if (!input.includeSourceNotes && isSourceSummaryChunk(chunk)) {
      counts.sourceSummariesSkipped++;
      continue;
    }
    if (shouldFilterResolvedChunk(chunk, input)) {
      counts.resolvedFiltered++;
      continue;
    }
    if (!scopeMatches(chunk, input.scope, characterIds)) {
      counts.scopeFiltered++;
    }
  }

  return counts;
}

function candidateAllowed(
  chunk: LtmMemoryChunk,
  input: RetrieveLongTermMemoryInput,
  config: LtmRetrievalConfig,
  characterIds: string[],
) {
  if (!input.includeSourceNotes && isSourceSummaryChunk(chunk)) return false;
  if (shouldFilterResolvedChunk(chunk, input)) return false;
  return scopeMatches(chunk, input.scope, characterIds);
}

function compactScoreMap(scores: Record<string, number> | undefined) {
  if (!scores) return undefined;
  return Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(6))]));
}

function formatSelectedCandidate(candidate: LtmBudgetedChunk): LtmRetrievalDebugCandidate {
  return {
    chunkId: candidate.chunk.id,
    noteId: candidate.chunk.noteId,
    sectionKey: candidate.chunk.sectionKey,
    noteType: candidate.chunk.noteType,
    status: candidate.chunk.status,
    score: Number(candidate.score.toFixed(6)),
    lanes: candidate.lanes,
    reasons: candidate.reasons,
    laneScores: compactScoreMap(candidate.laneScores),
    rawLaneScores: compactScoreMap(candidate.rawLaneScores),
    tier: candidate.tier,
    estimatedTokens: candidate.estimatedTokens,
    budgetIncluded: true,
  };
}

function formatRejectedCandidate(
  candidate: LtmBudgetRejectedCandidate,
  chunksById: Map<string, LtmMemoryChunk>,
): LtmRetrievalDebugCandidate {
  const chunk = chunksById.get(candidate.chunkId);
  return {
    chunkId: candidate.chunkId,
    noteId: candidate.noteId ?? chunk?.noteId,
    sectionKey: candidate.sectionKey ?? chunk?.sectionKey,
    noteType: chunk?.noteType,
    status: chunk?.status,
    score: Number(candidate.score.toFixed(6)),
    lanes: candidate.lanes,
    reasons: candidate.reasons,
    laneScores: compactScoreMap(candidate.laneScores),
    rawLaneScores: compactScoreMap(candidate.rawLaneScores),
    estimatedTokens: candidate.estimatedTokens,
    budgetIncluded: false,
    rejectionReason: candidate.rejectionReason,
  };
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
  const includeDebug = input.debug === true || input.explain === true;
  const bundle = await loadRetrievalBundle(root, input.includeSourceNotes === true);
  const { metadata, bm25, graph, embeddings, config } = bundle;
  const warnings = [...bundle.warnings];
  const weights = resolveRetrievalWeights(config, input);

  if (!metadata) {
    const maxTokens = input.maxTokens ?? config.maxTokens;
    return {
      chunks: [],
      usedTokens: 0,
      maxTokens,
      embeddingsAvailable: false,
      warnings,
      ...(includeDebug
        ? {
            debug: {
              querySummary: {
                queryCharacters: (input.queryText ?? "").length,
                recentUserMessageCharacters: (input.recentUserMessage ?? "").length,
                mentionedCharacterCount: input.mentionedCharacterNames?.length ?? 0,
                noteIdCount: input.noteIds?.length ?? 0,
                tagCount: input.tags?.length ?? 0,
                characterIdCount: input.characterIds?.length ?? 0,
                scopeKeys: Object.keys(input.scope ?? {}).sort(),
              },
              embeddingsAvailable: false,
              weights: {
                semantic: weights.semantic,
                lexical: weights.lexical,
                graph: weights.graph,
                metadata: weights.metadata,
              },
              funnel: {
                totalChunks: 0,
                sourceSummariesSkipped: 0,
                scopeFiltered: 0,
                statusFiltered: 0,
                metadataCandidates: 0,
                vectorCandidates: 0,
                bm25Candidates: 0,
                graphCandidates: 0,
                rankedCandidates: 0,
                selectedCandidates: 0,
                tokenBudgetSkippedCandidates: 0,
                scoreThresholdSkippedCandidates: 0,
              },
              selected: [],
              rejected: [],
            },
          }
        : {}),
    };
  }

  const signals = extractQuerySignals(input);
  const characterIds = uniqueSorted(signals.characterIds);
  const chunksById = new Map(Object.entries(metadata.chunks));
  const allChunks = Object.values(metadata.chunks);
  const filterCounts = includeDebug ? summarizeCandidateFilters(allChunks, input, config, characterIds) : null;
  if (!input.includeSourceNotes && input.debug) {
    const skippedSourceChunks = filterCounts?.sourceSummariesSkipped ?? allChunks.filter(isSourceSummaryChunk).length;
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
  const lanes: LtmRankLane[] = [];

  if (weights.metadata > 0) {
    lanes.push({
      name: "metadata",
      weight: weights.metadata,
      items: metadataMatches.map((match) => ({
        chunkId: match.chunkId,
        reason: match.reasons.join(","),
        rawScore: match.score,
      })),
    });
  }

  if (vector.items.length > 0) {
    lanes.push({ name: "vector", weight: weights.semantic, items: vector.items });
  }

  if (bm25 && signals.queryText.trim().length > 0) {
    lanes.push({
      name: "bm25",
      weight: weights.lexical,
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
      weight: weights.graph,
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
    normalizedScoreThreshold: input.minScore,
    explain: includeDebug,
    rejectedLimit: 20,
  });
  const laneCount = (name: string) => lanes.find((lane) => lane.name === name)?.items.length ?? 0;
  const debug: LtmRetrievalDebugInfo | undefined = includeDebug
    ? {
        querySummary: {
          queryCharacters: signals.queryText.length,
          recentUserMessageCharacters: (input.recentUserMessage ?? "").length,
          mentionedCharacterCount: input.mentionedCharacterNames?.length ?? 0,
          noteIdCount: signals.noteIds.length,
          tagCount: signals.tags.length,
          characterIdCount: characterIds.length,
          scopeKeys: Object.keys(input.scope ?? {}).sort(),
        },
        embeddingsAvailable: vector.available,
        weights: {
          semantic: weights.semantic,
          lexical: weights.lexical,
          graph: weights.graph,
          metadata: weights.metadata,
        },
        funnel: {
          totalChunks: allChunks.length,
          sourceSummariesSkipped: filterCounts?.sourceSummariesSkipped ?? 0,
          scopeFiltered: filterCounts?.scopeFiltered ?? 0,
          statusFiltered:
            filterCounts?.resolvedFiltered ?? 0,
          metadataCandidates: laneCount("metadata"),
          vectorCandidates: laneCount("vector"),
          bm25Candidates: laneCount("bm25"),
          graphCandidates: laneCount("graph"),
          rankedCandidates: ranked.length,
          selectedCandidates: budgeted.chunks.length,
          tokenBudgetSkippedCandidates: budgeted.rejected.filter((candidate) => candidate.rejectionReason === "budget")
            .length,
          scoreThresholdSkippedCandidates: budgeted.rejected.filter(
            (candidate) => candidate.rejectionReason === "score_threshold",
          ).length,
        },
        selected: budgeted.chunks.map(formatSelectedCandidate),
        rejected: budgeted.rejected.map((candidate) => formatRejectedCandidate(candidate, chunksById)),
      }
    : undefined;

  return {
    chunks: budgeted.chunks,
    usedTokens: budgeted.usedTokens,
    maxTokens: budgeted.maxTokens,
    embeddingsAvailable: vector.available,
    warnings,
    ...(debug ? { debug } : {}),
  };
}
