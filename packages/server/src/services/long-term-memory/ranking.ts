export interface LtmRankedCandidate {
  chunkId: string;
  score: number;
  reasons: string[];
  lanes: string[];
  laneScores?: Record<string, number>;
  rawLaneScores?: Record<string, number>;
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
      const rawScoreBoost = (item.rawScore ?? 0) * 0.001 * lane.weight;
      const candidate =
        candidates.get(item.chunkId) ??
        ({
          chunkId: item.chunkId,
          score: 0,
          reasons: [],
          lanes: [],
          laneScores: {},
          rawLaneScores: {},
        } satisfies LtmRankedCandidate);
      candidate.score += score + rawScoreBoost;
      candidate.laneScores ??= {};
      candidate.rawLaneScores ??= {};
      candidate.laneScores[lane.name] = (candidate.laneScores[lane.name] ?? 0) + score + rawScoreBoost;
      if (typeof item.rawScore === "number") {
        candidate.rawLaneScores[lane.name] = Math.max(candidate.rawLaneScores[lane.name] ?? 0, item.rawScore);
      }
      candidate.reasons.push(item.reason);
      if (!candidate.lanes.includes(lane.name)) candidate.lanes.push(lane.name);
      candidates.set(item.chunkId, candidate);
    });
  }

  return Array.from(candidates.values()).sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
}
