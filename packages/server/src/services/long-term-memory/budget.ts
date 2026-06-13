import { cleanLongTermMemoryChunkText, type LtmMemoryChunk } from "./chunking.js";
import type { LtmRankedCandidate } from "./ranking.js";

export interface LtmBudgetedChunk {
  chunk: LtmMemoryChunk;
  score: number;
  reasons: string[];
  lanes: string[];
  laneScores?: Record<string, number>;
  rawLaneScores?: Record<string, number>;
  tier: 1 | 2 | 3;
  estimatedTokens: number;
}

export interface LtmBudgetOptions {
  maxChunks: number;
  maxTokens: number;
  normalizedScoreThreshold?: number;
  explain?: boolean;
  rejectedLimit?: number;
}

export interface LtmBudgetRejectedCandidate {
  chunkId: string;
  noteId?: string;
  sectionKey?: string;
  score: number;
  reasons: string[];
  lanes: string[];
  laneScores?: Record<string, number>;
  rawLaneScores?: Record<string, number>;
  estimatedTokens?: number;
  rejectionReason: "budget" | "lower_rank" | "missing_chunk" | "score_threshold";
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function tierFor(chunk: LtmMemoryChunk, candidate: LtmRankedCandidate): 1 | 2 | 3 {
  if (
    candidate.lanes.includes("always") ||
    chunk.noteType === "tone" ||
    chunk.noteType === "voice" ||
    (chunk.noteType === "character" && ["core", "current_state", "voice"].includes(chunk.sectionKey))
  ) {
    return 1;
  }

  if (chunk.noteType === "callback" || (chunk.noteType === "thread" && chunk.status !== "resolved")) {
    return 2;
  }

  return 3;
}

export function applyLtmBudget(
  candidates: LtmRankedCandidate[],
  chunksById: Map<string, LtmMemoryChunk>,
  options: LtmBudgetOptions,
) {
  const selected: LtmBudgetedChunk[] = [];
  const selectedIds = new Set<string>();
  const rejected: LtmBudgetRejectedCandidate[] = [];
  const rejectedLimit = Math.max(0, options.rejectedLimit ?? 20);
  const scoreThreshold = Math.max(0, Math.min(1, options.normalizedScoreThreshold ?? 0));
  const topScore = candidates[0]?.score ?? 0;
  let usedTokens = 0;

  for (const candidate of candidates) {
    if (scoreThreshold > 0 && topScore > 0 && candidate.score / topScore < scoreThreshold) {
      if (options.explain && rejected.length < rejectedLimit) {
        const chunk = chunksById.get(candidate.chunkId);
        rejected.push({
          chunkId: candidate.chunkId,
          noteId: chunk?.noteId,
          sectionKey: chunk?.sectionKey,
          score: candidate.score,
          reasons: candidate.reasons,
          lanes: candidate.lanes,
          laneScores: candidate.laneScores,
          rawLaneScores: candidate.rawLaneScores,
          estimatedTokens: chunk ? estimateTokens(cleanLongTermMemoryChunkText(chunk.text)) : undefined,
          rejectionReason: chunk ? "score_threshold" : "missing_chunk",
        });
      }
      continue;
    }

    if (selected.length >= options.maxChunks) {
      if (options.explain && rejected.length < rejectedLimit) {
        const chunk = chunksById.get(candidate.chunkId);
        rejected.push({
          chunkId: candidate.chunkId,
          noteId: chunk?.noteId,
          sectionKey: chunk?.sectionKey,
          score: candidate.score,
          reasons: candidate.reasons,
          lanes: candidate.lanes,
          laneScores: candidate.laneScores,
          rawLaneScores: candidate.rawLaneScores,
          estimatedTokens: chunk ? estimateTokens(cleanLongTermMemoryChunkText(chunk.text)) : undefined,
          rejectionReason: chunk ? "lower_rank" : "missing_chunk",
        });
      }
      continue;
    }

    const chunk = chunksById.get(candidate.chunkId);
    if (!chunk) {
      if (options.explain && rejected.length < rejectedLimit) {
        rejected.push({
          chunkId: candidate.chunkId,
          score: candidate.score,
          reasons: candidate.reasons,
          lanes: candidate.lanes,
          laneScores: candidate.laneScores,
          rawLaneScores: candidate.rawLaneScores,
          rejectionReason: "missing_chunk",
        });
      }
      continue;
    }

    const estimatedTokens = estimateTokens(cleanLongTermMemoryChunkText(chunk.text));
    if (usedTokens + estimatedTokens > options.maxTokens) {
      if (options.explain && rejected.length < rejectedLimit) {
        rejected.push({
          chunkId: candidate.chunkId,
          noteId: chunk.noteId,
          sectionKey: chunk.sectionKey,
          score: candidate.score,
          reasons: candidate.reasons,
          lanes: candidate.lanes,
          laneScores: candidate.laneScores,
          rawLaneScores: candidate.rawLaneScores,
          estimatedTokens,
          rejectionReason: "budget",
        });
      }
      continue;
    }

    selected.push({
      chunk,
      score: candidate.score,
      reasons: candidate.reasons,
      lanes: candidate.lanes,
      laneScores: candidate.laneScores,
      rawLaneScores: candidate.rawLaneScores,
      tier: tierFor(chunk, candidate),
      estimatedTokens,
    });
    selectedIds.add(candidate.chunkId);
    usedTokens += estimatedTokens;
  }

  if (options.explain && rejected.length < rejectedLimit) {
    for (const candidate of candidates) {
      if (rejected.length >= rejectedLimit) break;
      if (selectedIds.has(candidate.chunkId)) continue;
      if (rejected.some((item) => item.chunkId === candidate.chunkId)) continue;
      const chunk = chunksById.get(candidate.chunkId);
      rejected.push({
        chunkId: candidate.chunkId,
        noteId: chunk?.noteId,
        sectionKey: chunk?.sectionKey,
        score: candidate.score,
        reasons: candidate.reasons,
        lanes: candidate.lanes,
        laneScores: candidate.laneScores,
        rawLaneScores: candidate.rawLaneScores,
        estimatedTokens: chunk ? estimateTokens(cleanLongTermMemoryChunkText(chunk.text)) : undefined,
        rejectionReason: chunk ? "lower_rank" : "missing_chunk",
      });
    }
  }

  return {
    chunks: selected.sort((a, b) => a.tier - b.tier || b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)),
    usedTokens,
    maxTokens: options.maxTokens,
    rejected,
  };
}
