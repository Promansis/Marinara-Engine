import { readFile } from "node:fs/promises";
import { logger } from "../../lib/logger.js";
import { isEnoent } from "./ltm-utils.js";
import {
  isLtmSourceLikeNote,
  ltmPoliciesConfigSchema,
  ltmRetrievalConfigSchema,
  isGlobalLtmScope,
  matchesLtmScope,
  jaccardSimilarity,
  tokenize,
  type LtmBm25Index,
  type LtmEmbeddingIndex,
  type LtmGraphIndex,
  type LtmKeywordIndex,
  type LtmMetadataIndex,
  type LtmRetrievalConfig,
  type LtmMode,
  type LtmPoliciesConfig,
  type LtmScope,
} from "@marinara-engine/shared";
import { embedMemoryRecallTexts, type MemoryRecallEmbeddingOptions } from "../memory-recall.js";
import { DEFAULT_LTM_POLICIES, DEFAULT_LTM_RETRIEVAL_CONFIG } from "./default-config.js";
import { searchLtmBm25 } from "./bm25.js";
import type { LtmMemoryChunk } from "./chunking.js";
import { expandLtmGraph } from "./graph.js";
import { loadLtmIndexGeneration } from "./index-generation.js";
import { searchLtmKeywordIndex } from "./keyword-index.js";
import { normalizeKeywordTerms } from "./keyword-extract.js";
import { getLtmMetadataMatches } from "./metadata-index.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";
import { applyLtmBudget, type LtmBudgetedChunk, type LtmBudgetRejectedCandidate } from "./budget.js";
import { readLtmIndexState } from "./index-state.js";
import { LongTermMemoryStorage } from "./storage.js";

const COOLDOWN_MAX_AGE_MINUTES = 30;
const COOLDOWN_TIER_1_MINUTES = 5;
const COOLDOWN_TIER_2_MINUTES = 15;
const COOLDOWN_PENALTY_TIER_1 = 0.65;
const COOLDOWN_PENALTY_TIER_2 = 0.8;
const COOLDOWN_PENALTY_TIER_3 = 0.9;
const IMPORTANCE_SCORE_MULTIPLIER = {
  critical: 1.3,
  major: 1.15,
  moderate: 1,
  minor: 0.85,
} as const;
const ACTIVE_CONTEXT_DEDUP_THRESHOLD = 0.85;
import { reciprocalRankFuse, type LtmRankedCandidate, type LtmRankLane } from "./ranking.js";
import { readLongTermMemoryUsage } from "./usage.js";

export interface RetrieveLongTermMemoryInput extends MemoryRecallEmbeddingOptions {
  root?: string;
  mode?: LtmMode;
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
  keywordWeight?: number;
  /** "filter_only" remains accepted for stored clients; explicit IDs and tags now form direct candidate lanes. */
  metadataMode?: "filter_only" | "direct_matches";
  dedupeExactText?: boolean;
  dedupeAgainstRecentContext?: boolean;
  applyUsageCooldown?: boolean;
}

export interface LtmRetrievalDebugCandidate {
  chunkId: string;
  noteId?: string;
  sectionKey?: string;
  noteType?: string;
  status?: string;
  score: number;
  normalizedScore?: number;
  finalNormalizedScore?: number;
  lanes: string[];
  reasons: string[];
  laneScores?: Record<string, number>;
  rawLaneScores?: Record<string, number>;
  cooldownPenalty?: number;
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
    keyword: number;
  };
  activeLanes: string[];
  skippedLanes: string[];
  metadataMode: "direct_matches";
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

async function readConfig<T>(path: string, fallback: T, parse: (value: unknown) => T, warnings: string[]) {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch (err) {
    if (!isEnoent(err)) {
      logger.warn(err, "[ltm] Failed to read retrieval config %s; using defaults", path);
      warnings.push(`Failed to read retrieval config ${path}; using defaults`);
    }
    return fallback;
  }
}

type LtmRetrievalBundle = {
  metadata: LtmMetadataIndex | null;
  bm25: LtmBm25Index | null;
  graph: LtmGraphIndex | null;
  keywords: LtmKeywordIndex | null;
  embeddings: LtmEmbeddingIndex | null;
  config: LtmRetrievalConfig;
  policies: LtmPoliciesConfig;
  revision: number;
  dirty: boolean;
  warnings: string[];
};

const retrievalBundleCache = new Map<string, Promise<LtmRetrievalBundle>>();

function retrievalBundleCacheKey(root: string, includeSourceNotes: boolean, revision: number, generationId: string | null) {
  return `${root}\0${includeSourceNotes ? "source" : "typed"}\0${revision}\0${generationId ?? "none"}`;
}

function retrievalBundleCachePrefix(root: string, includeSourceNotes: boolean) {
  return `${root}\0${includeSourceNotes ? "source" : "typed"}\0`;
}

export function invalidateLongTermMemoryRetrievalCache(root?: string, includeSourceNotes?: boolean) {
  if (!root) {
    retrievalBundleCache.clear();
    return;
  }
  if (typeof includeSourceNotes === "boolean") {
    const prefix = retrievalBundleCachePrefix(root, includeSourceNotes);
    for (const key of retrievalBundleCache.keys()) {
      if (key.startsWith(prefix)) retrievalBundleCache.delete(key);
    }
    return;
  }
  for (const key of retrievalBundleCache.keys()) {
    if (key.startsWith(`${root}\0`)) retrievalBundleCache.delete(key);
  }
}

async function loadRetrievalBundle(root: string, includeSourceNotes: boolean): Promise<LtmRetrievalBundle> {
  // Validate the active generation before returning a cached bundle. This
  // keeps a warm process from serving a now-corrupt generation indefinitely.
  const [state, generation] = await Promise.all([readLtmIndexState(root), loadLtmIndexGeneration(root)]);
  const generationId = generation.manifest?.generationId ?? null;
  const key = retrievalBundleCacheKey(root, includeSourceNotes, state.revision, generationId);
  const cached = retrievalBundleCache.get(key);
  if (cached) return cached;

  const prefix = retrievalBundleCachePrefix(root, includeSourceNotes);
  for (const cachedKey of retrievalBundleCache.keys()) {
    if (cachedKey.startsWith(prefix) && cachedKey !== key) retrievalBundleCache.delete(cachedKey);
  }

  const load = (async () => {
    const dirs = getLongTermMemoryDirectories(root);
    const warnings: string[] = [];
    const config = await readConfig(
      safeJoin(dirs.config, "retrieval.json"),
      DEFAULT_LTM_RETRIEVAL_CONFIG,
      (value) => ltmRetrievalConfigSchema.parse(value),
      warnings,
    );
    const policies = await readConfig(
      safeJoin(dirs.config, "policies.json"),
      DEFAULT_LTM_POLICIES,
      (value) => ltmPoliciesConfigSchema.parse(value),
      warnings,
    );
    warnings.push(...generation.warnings);
    const family = generation.bundles[includeSourceNotes ? "source" : "typed"] ?? null;
    if (generation.manifest && !family) {
      warnings.push(`Current long-term memory generation has no ${includeSourceNotes ? "source" : "typed"} index family.`);
    }
    const metadata = family?.metadata ?? null;
    const bm25 = family?.bm25 ?? null;
    const graph = family?.graph ?? null;
    const keywords = family?.keywords ?? null;
    const embeddings = family?.embeddings ?? null;
    return {
      metadata,
      bm25,
      graph,
      keywords,
      embeddings,
      config,
      policies,
      revision: state.revision,
      dirty: state.dirty,
      warnings,
    };
  })();

  retrievalBundleCache.set(key, load);
  try {
    return await load;
  } catch (err) {
    retrievalBundleCache.delete(key);
    throw err;
  }
}

async function excludeMissingVaultChunks(root: string, chunks: LtmMemoryChunk[], warnings: string[]) {
  if (chunks.length === 0) return chunks;
  const noteIds = Array.from(new Set(chunks.map((chunk) => chunk.noteId)));
  const notes = await new LongTermMemoryStorage(root).getNotesByIds(noteIds);
  const present = chunks.filter((chunk) => notes.has(chunk.noteId));
  const excluded = chunks.length - present.length;
  if (excluded > 0) {
    warnings.push(`Excluded ${excluded} stale index chunk(s) whose vault notes no longer exist.`);
  }
  return present;
}

function resolveRetrievalWeights(config: LtmRetrievalConfig, input: RetrieveLongTermMemoryInput) {
  const semantic = input.semanticWeight ?? config.semanticWeight;
  const lexical = input.lexicalWeight ?? config.lexicalWeight;
  const graph = input.graphWeight ?? config.graphWeight;
  const keyword = input.keywordWeight ?? config.keywordWeight;
  return { semantic, lexical, graph, keyword };
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function extractQuerySignals(input: RetrieveLongTermMemoryInput) {
  const recentMessagesText = input.recentMessages?.length ? input.recentMessages.filter(Boolean).join("\n") : "";
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
  // Group-scoped memories must never escape through a shared character or a
  // prior chat link. Global and non-group-scoped memories still use the normal
  // overlap matcher below.
  if (chunk.scope.groupId && chunk.scope.groupId !== scope?.groupId) return false;
  const hasCallerScope = !isGlobalLtmScope(scope) || characterIds.length > 0;
  return matchesLtmScope(
    { id: chunk.noteId, type: chunk.noteType, scope: chunk.scope },
    hasCallerScope ? { scope, characterIds, includeGlobal: true } : { scope: {}, includeGlobal: true },
  );
}

function isSourceSummaryChunk(chunk: LtmMemoryChunk) {
  return isLtmSourceLikeNote({ type: chunk.noteType, tags: chunk.tags });
}

function shouldFilterResolvedChunk(chunk: LtmMemoryChunk, input: RetrieveLongTermMemoryInput) {
  if (input.includeResolved || chunk.status !== "resolved") return false;
  return chunk.noteType === "thread";
}

type LtmPolicyDecision = {
  allowed: boolean;
  mandatory: boolean;
};

function includesPolicySection(sections: string[], sectionKey: string) {
  return sections.includes("*") || sections.includes(sectionKey);
}

function resolveLtmPolicyDecision(
  chunk: LtmMemoryChunk,
  policies: LtmPoliciesConfig,
  characterIds: string[],
): LtmPolicyDecision {
  const policy = policies.policies.find((candidate) => candidate.type === chunk.noteType);
  if (!policy) return { allowed: true, mandatory: false };
  if (policy.injection === "never") return { allowed: false, mandatory: false };

  const isActiveCharacter =
    characterIds.includes(chunk.noteId) ||
    chunk.scope.characterIds?.some((characterId) => characterIds.includes(characterId)) === true;
  const mandatory =
    policy.injection === "always_for_active_characters" &&
    isActiveCharacter &&
    policy.sectionsAlways.includes(chunk.sectionKey);
  const allowedOnRelevance = includesPolicySection(policy.sectionsOnRelevance, chunk.sectionKey);
  return { allowed: mandatory || allowedOnRelevance, mandatory };
}

function summarizeCandidateFilters(
  chunks: LtmMemoryChunk[],
  input: RetrieveLongTermMemoryInput,
  characterIds: string[],
  policies: LtmPoliciesConfig,
) {
  const counts = {
    sourceSummariesSkipped: 0,
    archivedFiltered: 0,
    resolvedFiltered: 0,
    scopeFiltered: 0,
    modeFiltered: 0,
    policyFiltered: 0,
  };

  for (const chunk of chunks) {
    if (!input.includeSourceNotes && isSourceSummaryChunk(chunk)) {
      counts.sourceSummariesSkipped++;
      continue;
    }
    if (chunk.status === "archived") {
      counts.archivedFiltered++;
      continue;
    }
    if (shouldFilterResolvedChunk(chunk, input)) {
      counts.resolvedFiltered++;
      continue;
    }
    if (input.mode && !chunk.modes?.includes(input.mode)) {
      counts.modeFiltered++;
      continue;
    }
    if (!scopeMatches(chunk, input.scope, characterIds)) {
      counts.scopeFiltered++;
      continue;
    }
    if (!resolveLtmPolicyDecision(chunk, policies, characterIds).allowed) {
      counts.policyFiltered++;
    }
  }

  return counts;
}

function candidateAllowed(
  chunk: LtmMemoryChunk,
  input: RetrieveLongTermMemoryInput,
  characterIds: string[],
  policies: LtmPoliciesConfig,
) {
  if (!input.includeSourceNotes && isSourceSummaryChunk(chunk)) return false;
  if (chunk.status === "archived") return false;
  if (shouldFilterResolvedChunk(chunk, input)) return false;
  if (input.mode && !chunk.modes?.includes(input.mode)) return false;
  if (!scopeMatches(chunk, input.scope, characterIds)) return false;
  return resolveLtmPolicyDecision(chunk, policies, characterIds).allowed;
}

function mandatoryPolicyItems(
  chunks: LtmMemoryChunk[],
  allowedChunkIds: Set<string>,
  policies: LtmPoliciesConfig,
  characterIds: string[],
) {
  return chunks.flatMap((chunk) => {
    if (!allowedChunkIds.has(chunk.id)) return [];
    const decision = resolveLtmPolicyDecision(chunk, policies, characterIds);
    return decision.mandatory
      ? [{ chunkId: chunk.id, reason: `policy:${chunk.noteType}:always`, rawScore: 1 }]
      : [];
  });
}

function normalizeKeywordRelevance(score: number, queryText: string) {
  // An exact keyword contributes 3 in the keyword index. Normalize against
  // the full query term set so one generic match cannot satisfy a high
  // relevance threshold by itself.
  const queryTermCount = Math.max(1, normalizeKeywordTerms(queryText).length);
  return Math.max(0, Math.min(1, score / (3 * queryTermCount)));
}

function filterLanesByAbsoluteRelevance(lanes: LtmRankLane[], minScore: number | undefined) {
  const threshold = Math.max(0, Math.min(1, minScore ?? 0));
  if (threshold === 0) return { lanes, skippedCandidateIds: new Set<string>() };

  const candidateIds = new Set<string>();
  const eligibleIds = new Set<string>();
  for (const lane of lanes) {
    for (const item of lane.items) {
      candidateIds.add(item.chunkId);
      if (lane.name === "direct" || lane.name === "mandatory") {
        eligibleIds.add(item.chunkId);
        continue;
      }
      if ((lane.name === "vector" || lane.name === "keyword") && (item.rawScore ?? 0) >= threshold) {
        eligibleIds.add(item.chunkId);
      }
    }
  }

  return {
    lanes: lanes.map((lane) => ({ ...lane, items: lane.items.filter((item) => eligibleIds.has(item.chunkId)) })),
    skippedCandidateIds: new Set([...candidateIds].filter((chunkId) => !eligibleIds.has(chunkId))),
  };
}

function compactScoreMap(scores: Record<string, number> | undefined) {
  if (!scores) return undefined;
  return Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(6))]));
}

function activeRelevanceLanes(weights: { semantic: number; lexical: number; graph: number; keyword: number }) {
  return [
    ...(weights.semantic > 0 ? ["vector"] : []),
    ...(weights.lexical > 0 ? ["bm25"] : []),
    ...(weights.graph > 0 ? ["graph"] : []),
    ...(weights.keyword > 0 ? ["keyword"] : []),
  ];
}

function skippedRelevanceLanes(weights: { semantic: number; lexical: number; graph: number; keyword: number }) {
  return [
    ...(weights.semantic <= 0 ? ["vector:zero_weight"] : []),
    ...(weights.lexical <= 0 ? ["bm25:zero_weight"] : []),
    ...(weights.graph <= 0 ? ["graph:zero_weight"] : []),
    ...(weights.keyword <= 0 ? ["keyword:zero_weight"] : []),
  ];
}

function formatSelectedCandidate(candidate: LtmBudgetedChunk): LtmRetrievalDebugCandidate {
  return {
    chunkId: candidate.chunk.id,
    noteId: candidate.chunk.noteId,
    sectionKey: candidate.chunk.sectionKey,
    noteType: candidate.chunk.noteType,
    status: candidate.chunk.status,
    score: Number(candidate.score.toFixed(6)),
    normalizedScore: candidate.normalizedScore === undefined ? undefined : Number(candidate.normalizedScore.toFixed(6)),
    finalNormalizedScore:
      candidate.finalNormalizedScore === undefined ? undefined : Number(candidate.finalNormalizedScore.toFixed(6)),
    lanes: candidate.lanes,
    reasons: candidate.reasons,
    laneScores: compactScoreMap(candidate.laneScores),
    rawLaneScores: compactScoreMap(candidate.rawLaneScores),
    cooldownPenalty: candidate.cooldownPenalty === undefined ? undefined : Number(candidate.cooldownPenalty.toFixed(6)),
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
    normalizedScore: candidate.normalizedScore === undefined ? undefined : Number(candidate.normalizedScore.toFixed(6)),
    finalNormalizedScore:
      candidate.finalNormalizedScore === undefined ? undefined : Number(candidate.finalNormalizedScore.toFixed(6)),
    lanes: candidate.lanes,
    reasons: candidate.reasons,
    laneScores: compactScoreMap(candidate.laneScores),
    rawLaneScores: compactScoreMap(candidate.rawLaneScores),
    cooldownPenalty: candidate.cooldownPenalty === undefined ? undefined : Number(candidate.cooldownPenalty.toFixed(6)),
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
  allowedChunkIds: Set<string>,
) {
  if (!embeddings || !embeddings.dimension || queryText.trim().length === 0) return { items: [], available: false };

  const queryEmbedding = (await embedMemoryRecallTexts([queryText], input))[0];
  if (!queryEmbedding || queryEmbedding.length === 0) return { items: [], available: false };

  const items = embeddings.chunks
    .flatMap((entry) => {
      const chunk = chunksById.get(entry.chunkId);
      if (!entry.vector || !chunk || !allowedChunkIds.has(chunk.id)) return [];
      if (entry.vector.length !== queryEmbedding.length) {
        return [];
      }
      const score = cosineSimilarity(queryEmbedding, entry.vector);
      return score > 0 ? [{ chunkId: entry.chunkId, reason: "vector", rawScore: score }] : [];
    })
    .sort((a, b) => b.rawScore - a.rawScore || a.chunkId.localeCompare(b.chunkId))
    .slice(0, 50);

  return { items, available: items.length > 0 };
}

function applyImportanceMultiplier(
  ranked: LtmRankedCandidate[],
  chunksById: Map<string, LtmMemoryChunk>,
): LtmRankedCandidate[] {
  const boosted = ranked.map((candidate) => {
    const importance = chunksById.get(candidate.chunkId)?.importance;
    if (!importance) return candidate;
    const multiplier = IMPORTANCE_SCORE_MULTIPLIER[importance];
    if (multiplier === 1) return candidate;
    return {
      ...candidate,
      score: candidate.score * multiplier,
      reasons: [...candidate.reasons, `importance:${importance}:${multiplier.toFixed(2)}`],
    };
  });
  const sorted = boosted.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
  const topScore = sorted[0]?.score ?? 0;
  return sorted.map((candidate) => ({
    ...candidate,
    normalizedScore: topScore > 0 ? candidate.score / topScore : 0,
    finalNormalizedScore: topScore > 0 ? candidate.score / topScore : 0,
  }));
}

function filterRecentContextDuplicates(
  ranked: LtmRankedCandidate[],
  chunksById: Map<string, LtmMemoryChunk>,
  input: RetrieveLongTermMemoryInput,
) {
  if (input.dedupeAgainstRecentContext === false) return { ranked, skipped: 0 };
  const messages = [...(input.recentMessages ?? []), input.recentUserMessage ?? ""]
    .map((message) => message.trim())
    .filter(Boolean);
  if (messages.length === 0) return { ranked, skipped: 0 };
  const recentTokens = messages.map((message) => tokenize(message));
  const filtered = ranked.filter((candidate) => {
    const chunk = chunksById.get(candidate.chunkId);
    if (!chunk) return true;
    const chunkTokens = tokenize(chunk.text);
    if (chunkTokens.size === 0) return true;
    return !recentTokens.some(
      (messageTokens) => jaccardSimilarity(chunkTokens, messageTokens) > ACTIVE_CONTEXT_DEDUP_THRESHOLD,
    );
  });
  return { ranked: filtered, skipped: ranked.length - filtered.length };
}

export async function retrieveLongTermMemory(
  input: RetrieveLongTermMemoryInput = {},
): Promise<RetrieveLongTermMemoryResult> {
  const root = input.root ?? getLongTermMemoryRoot();
  logger.debug({ root, queryLength: input.queryText?.length }, "[ltm] Retrieval started");
  const includeDebug = input.debug === true || input.explain === true;
  const metadataMode: "direct_matches" = "direct_matches";
  const bundle = await loadRetrievalBundle(root, input.includeSourceNotes === true);
  const { metadata, bm25, graph, keywords, embeddings, config, policies } = bundle;
  const warnings = [...bundle.warnings];
  const weights = resolveRetrievalWeights(config, input);
  const configuredActiveLanes = activeRelevanceLanes(weights);
  const skippedLanes = skippedRelevanceLanes(weights);
  const generationLanesDisabled = configuredActiveLanes.length === 0;

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
                keyword: weights.keyword,
              },
              activeLanes: configuredActiveLanes,
              skippedLanes,
              metadataMode,
              funnel: {
                totalChunks: 0,
                sourceSummariesSkipped: 0,
                archivedFiltered: 0,
                modeFiltered: 0,
                scopeFiltered: 0,
                statusFiltered: 0,
                policyFiltered: 0,
                metadataCandidates: 0,
                directCandidates: 0,
                mandatoryCandidates: 0,
                keywordCandidates: 0,
                vectorCandidates: 0,
                bm25Candidates: 0,
                graphCandidates: 0,
                rankedCandidates: 0,
                selectedCandidates: 0,
                tokenBudgetSkippedCandidates: 0,
                scoreThresholdSkippedCandidates: 0,
                absoluteRelevanceSkippedCandidates: 0,
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
  const indexedChunks = Object.values(metadata.chunks);
  const allChunks = bundle.dirty ? await excludeMissingVaultChunks(root, indexedChunks, warnings) : indexedChunks;
  const chunksById = new Map(allChunks.map((chunk) => [chunk.id, chunk]));
  const allowedChunkIds = new Set(
    allChunks.filter((chunk) => candidateAllowed(chunk, input, characterIds, policies)).map((chunk) => chunk.id),
  );
  const filterCounts = includeDebug ? summarizeCandidateFilters(allChunks, input, characterIds, policies) : null;
  const metadataMatches = getLtmMetadataMatches(metadata, {
    noteIds: signals.noteIds,
    tags: signals.tags,
    scope: input.scope,
    characterIds,
  }).filter((candidate) => {
    const chunk = chunksById.get(candidate.chunkId);
    return chunk ? allowedChunkIds.has(chunk.id) : false;
  });
  const directItems = metadataMatches.flatMap((match) => {
    const reasons = match.reasons.filter((reason) => reason.startsWith("note:") || reason.startsWith("tag:"));
    return reasons.length > 0 ? [{ chunkId: match.chunkId, reason: reasons.join(","), rawScore: 1 }] : [];
  });
  const mandatoryItems = mandatoryPolicyItems(allChunks, allowedChunkIds, policies, characterIds);

  if (generationLanesDisabled && directItems.length === 0 && mandatoryItems.length === 0) {
    warnings.push("No active long-term memory relevance lanes; retrieval returned no chunks.");
    return {
      chunks: [],
      usedTokens: 0,
      maxTokens: input.maxTokens ?? config.maxTokens,
      embeddingsAvailable: false,
      warnings,
      ...(includeDebug
        ? {
            debug: {
              querySummary: {
                queryCharacters: signals.queryText.length,
                recentUserMessageCharacters: (input.recentUserMessage ?? "").length,
                mentionedCharacterCount: input.mentionedCharacterNames?.length ?? 0,
                noteIdCount: signals.noteIds.length,
                tagCount: signals.tags.length,
                characterIdCount: characterIds.length,
                scopeKeys: Object.keys(input.scope ?? {}).sort(),
              },
              embeddingsAvailable: false,
              weights: {
                semantic: weights.semantic,
                lexical: weights.lexical,
                graph: weights.graph,
                keyword: weights.keyword,
              },
              activeLanes: configuredActiveLanes,
              skippedLanes,
              metadataMode,
              funnel: {
                totalChunks: allChunks.length,
                sourceSummariesSkipped: filterCounts?.sourceSummariesSkipped ?? 0,
                archivedFiltered: filterCounts?.archivedFiltered ?? 0,
                modeFiltered: filterCounts?.modeFiltered ?? 0,
                scopeFiltered: filterCounts?.scopeFiltered ?? 0,
                statusFiltered: (filterCounts?.archivedFiltered ?? 0) + (filterCounts?.resolvedFiltered ?? 0),
                policyFiltered: filterCounts?.policyFiltered ?? 0,
                metadataCandidates: 0,
                directCandidates: 0,
                mandatoryCandidates: 0,
                keywordCandidates: 0,
                vectorCandidates: 0,
                bm25Candidates: 0,
                graphCandidates: 0,
                rankedCandidates: 0,
                selectedCandidates: 0,
                tokenBudgetSkippedCandidates: 0,
                scoreThresholdSkippedCandidates: 0,
                absoluteRelevanceSkippedCandidates: 0,
                duplicateTextSkippedCandidates: 0,
                cooldownPenalizedCandidates: 0,
              },
              selected: [],
              rejected: [],
            },
          }
        : {}),
    };
  }
  if (!input.includeSourceNotes && input.debug) {
    const skippedSourceChunks = filterCounts?.sourceSummariesSkipped ?? allChunks.filter(isSourceSummaryChunk).length;
    if (skippedSourceChunks > 0) {
      warnings.push(
        `Skipped ${skippedSourceChunks} source summary chunk(s); set includeSourceNotes to search source audit indexes.`,
      );
    }
  } else if (input.includeSourceNotes && input.debug) {
    warnings.push("Searching source audit indexes; normal memory stream indexes are not included.");
  }
  const vector =
    weights.semantic > 0
      ? await vectorLane(embeddings, signals.queryText, input, config, chunksById, characterIds, allowedChunkIds)
      : { items: [], available: Boolean(embeddings?.embeddedChunkCount) };
  const bm25Items =
    bm25 && signals.queryText.trim().length > 0
      ? searchLtmBm25(bm25, signals.queryText).flatMap((match) => {
          const chunk = chunksById.get(match.chunkId);
          return chunk && allowedChunkIds.has(chunk.id)
            ? [{ chunkId: match.chunkId, reason: "bm25", rawScore: match.score }]
            : [];
        })
      : [];
  const keywordItems =
    keywords && weights.keyword > 0 && signals.queryText.trim().length > 0
      ? searchLtmKeywordIndex(keywords, signals.queryText).flatMap((match) => {
          const chunk = chunksById.get(match.chunkId);
          return chunk && allowedChunkIds.has(chunk.id)
            ? [
                {
                  chunkId: match.chunkId,
                  reason: match.reasons.join(","),
                  rawScore: normalizeKeywordRelevance(match.score, signals.queryText),
                },
              ]
            : [];
        })
      : [];
  const metadataGraphSeedMatches = metadataMatches.filter((match) =>
    match.reasons.some((reason) => reason.startsWith("note:") || reason.startsWith("tag:")),
  );
  const graphSeeds = uniqueSorted([
    ...signals.noteIds,
    ...metadataGraphSeedMatches.slice(0, 10).map((candidate) => chunksById.get(candidate.chunkId)?.noteId ?? ""),
    ...vector.items.slice(0, 10).map((candidate) => chunksById.get(candidate.chunkId)?.noteId ?? ""),
    ...bm25Items.slice(0, 10).map((candidate) => chunksById.get(candidate.chunkId)?.noteId ?? ""),
    ...keywordItems.slice(0, 10).map((candidate) => chunksById.get(candidate.chunkId)?.noteId ?? ""),
  ]);
  const lanes: LtmRankLane[] = [];

  if (directItems.length > 0) {
    lanes.push({ name: "direct", weight: 1, items: directItems });
  }

  if (mandatoryItems.length > 0) {
    lanes.push({ name: "mandatory", weight: 1, items: mandatoryItems });
  }

  if (weights.semantic > 0 && vector.items.length > 0) {
    lanes.push({ name: "vector", weight: weights.semantic, items: vector.items });
  }

  if (weights.lexical > 0 && bm25 && signals.queryText.trim().length > 0) {
    lanes.push({
      name: "bm25",
      weight: weights.lexical,
      items: bm25Items,
    });
  }

  if (weights.keyword > 0 && keywordItems.length > 0) {
    lanes.push({
      name: "keyword",
      weight: weights.keyword,
      items: keywordItems,
    });
  }

  if (weights.graph > 0 && graph && graphSeeds.length > 0) {
    lanes.push({
      name: "graph",
      weight: weights.graph,
      items: expandLtmGraph(graph, graphSeeds).flatMap((match) => {
        const chunk = chunksById.get(match.chunkId);
        return chunk && allowedChunkIds.has(chunk.id)
          ? [{ chunkId: match.chunkId, reason: `graph:${match.viaNoteId}:${match.distance}`, rawScore: match.score }]
          : [];
      }),
    });
  }

  const usage =
    input.applyUsageCooldown === true
      ? await readLongTermMemoryUsage(root).catch((err) => {
          logger.warn(err, "[ltm] Failed to read usage data for cooldown");
          return null;
        })
      : null;
  const now = Date.now();
  const cooldowns = usage
    ? Object.values(usage.chunks).flatMap((entry) => {
        const injectedAt = Date.parse(entry.lastInjectedAt);
        if (!Number.isFinite(injectedAt)) return [];
        const ageMinutes = (now - injectedAt) / 60_000;
        if (ageMinutes < 0 || ageMinutes > COOLDOWN_MAX_AGE_MINUTES) return [];
        const penalty =
          ageMinutes < COOLDOWN_TIER_1_MINUTES
            ? COOLDOWN_PENALTY_TIER_1
            : ageMinutes < COOLDOWN_TIER_2_MINUTES
              ? COOLDOWN_PENALTY_TIER_2
              : COOLDOWN_PENALTY_TIER_3;
        return [
          {
            chunkId: entry.chunkId,
            penalty,
            reason: `cooldown:${Math.round(ageMinutes)}m:${penalty.toFixed(2)}`,
          },
        ];
      })
    : [];
  const relevanceFiltered = filterLanesByAbsoluteRelevance(lanes, input.minScore);
  const eligibleLanes = relevanceFiltered.lanes.filter((lane) => lane.items.length > 0);
  const activeLanes = [
    ...(directItems.length > 0 ? ["direct"] : []),
    ...(mandatoryItems.length > 0 ? ["mandatory"] : []),
    ...configuredActiveLanes,
  ];
  const ranked = applyImportanceMultiplier(reciprocalRankFuse(eligibleLanes, { cooldowns }), chunksById);
  const activeContextDedup = filterRecentContextDuplicates(ranked, chunksById, input);
  logger.debug(
    { laneCount: eligibleLanes.length, rankedCount: activeContextDedup.ranked.length },
    "[ltm] Retrieval lanes fused",
  );
  const budgeted = applyLtmBudget(activeContextDedup.ranked, chunksById, {
    maxChunks: input.maxChunks ?? config.maxChunks,
    maxTokens: input.maxTokens ?? config.maxTokens,
    explain: includeDebug,
    rejectedLimit: 20,
    dedupeExactText: input.dedupeExactText === true,
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
          keyword: weights.keyword,
        },
        activeLanes,
        skippedLanes,
        metadataMode,
        funnel: {
          totalChunks: allChunks.length,
          sourceSummariesSkipped: filterCounts?.sourceSummariesSkipped ?? 0,
          archivedFiltered: filterCounts?.archivedFiltered ?? 0,
          modeFiltered: filterCounts?.modeFiltered ?? 0,
          scopeFiltered: filterCounts?.scopeFiltered ?? 0,
          statusFiltered: (filterCounts?.archivedFiltered ?? 0) + (filterCounts?.resolvedFiltered ?? 0),
          policyFiltered: filterCounts?.policyFiltered ?? 0,
          metadataCandidates: laneCount("direct"),
          directCandidates: laneCount("direct"),
          mandatoryCandidates: laneCount("mandatory"),
          keywordCandidates: laneCount("keyword"),
          vectorCandidates: laneCount("vector"),
          bm25Candidates: laneCount("bm25"),
          graphCandidates: laneCount("graph"),
          rankedCandidates: activeContextDedup.ranked.length,
          selectedCandidates: budgeted.chunks.length,
          tokenBudgetSkippedCandidates: budgeted.rejected.filter((candidate) => candidate.rejectionReason === "budget")
            .length,
          scoreThresholdSkippedCandidates: relevanceFiltered.skippedCandidateIds.size,
          absoluteRelevanceSkippedCandidates: relevanceFiltered.skippedCandidateIds.size,
          duplicateTextSkippedCandidates: budgeted.rejected.filter(
            (candidate) => candidate.rejectionReason === "duplicate_text",
          ).length,
          cooldownPenalizedCandidates: ranked.filter((candidate) => candidate.cooldownPenalty !== undefined).length,
          activeContextDuplicateSkippedCandidates: activeContextDedup.skipped,
        },
        selected: budgeted.chunks.map(formatSelectedCandidate),
        rejected: budgeted.rejected.map((candidate) => formatRejectedCandidate(candidate, chunksById)),
      }
    : undefined;

  logger.debug({ selectedCount: budgeted.chunks.length, totalChunks: allChunks.length }, "[ltm] Retrieval completed");

  return {
    chunks: budgeted.chunks,
    usedTokens: budgeted.usedTokens,
    maxTokens: budgeted.maxTokens,
    embeddingsAvailable: vector.available,
    warnings,
    ...(debug ? { debug } : {}),
  };
}
