import { cleanLongTermMemoryChunkText, type LtmMemoryChunk } from "./chunking.js";
import type { LtmRankedCandidate } from "./ranking.js";

export interface LtmBudgetedChunk {
  chunk: LtmMemoryChunk;
  score: number;
  reasons: string[];
  lanes: string[];
  tier: 1 | 2 | 3;
  estimatedTokens: number;
}

export interface LtmBudgetOptions {
  maxChunks: number;
  maxTokens: number;
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
  let usedTokens = 0;

  for (const candidate of candidates) {
    if (selected.length >= options.maxChunks) break;

    const chunk = chunksById.get(candidate.chunkId);
    if (!chunk) continue;

    const estimatedTokens = estimateTokens(cleanLongTermMemoryChunkText(chunk.text));
    if (usedTokens + estimatedTokens > options.maxTokens) continue;

    selected.push({
      chunk,
      score: candidate.score,
      reasons: candidate.reasons,
      lanes: candidate.lanes,
      tier: tierFor(chunk, candidate),
      estimatedTokens,
    });
    usedTokens += estimatedTokens;
  }

  return {
    chunks: selected.sort((a, b) => a.tier - b.tier || b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)),
    usedTokens,
    maxTokens: options.maxTokens,
  };
}
