export interface LtmRankedCandidate {
  chunkId: string;
  score: number;
  reasons: string[];
  lanes: string[];
}

export interface LtmRankLaneItem {
  chunkId: string;
  reason: string;
  rawScore?: number;
}

export interface LtmRankLane {
  name: string;
  weight: number;
  items: LtmRankLaneItem[];
}

const RRF_K = 60;

export function reciprocalRankFuse(lanes: LtmRankLane[]) {
  const candidates = new Map<string, LtmRankedCandidate>();

  for (const lane of lanes) {
    lane.items.forEach((item, index) => {
      const rank = index + 1;
      const score = lane.weight * (1 / (RRF_K + rank));
      const candidate =
        candidates.get(item.chunkId) ?? ({ chunkId: item.chunkId, score: 0, reasons: [], lanes: [] } satisfies LtmRankedCandidate);
      candidate.score += score + (item.rawScore ?? 0) * 0.001 * lane.weight;
      candidate.reasons.push(item.reason);
      if (!candidate.lanes.includes(lane.name)) candidate.lanes.push(lane.name);
      candidates.set(item.chunkId, candidate);
    });
  }

  return Array.from(candidates.values()).sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
}
