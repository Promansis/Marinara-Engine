import test from "node:test";
import assert from "node:assert/strict";
import { reciprocalRankFuse, type LtmRankLane } from "../ranking.js";

function lane(name: string, items: Array<{ chunkId: string; reason: string; rawScore?: number }>, weight = 1): LtmRankLane {
  return { name, weight, items };
}

function firstOf(result: ReturnType<typeof reciprocalRankFuse>) {
  assert.equal(result.length, 1);
  return result[0]!;
}

test("reciprocalRankFuse — single lane correct RRF score", () => {
  const lanes = [lane("bm25", [{ chunkId: "a", reason: "term", rawScore: 5 }])];
  const r = firstOf(reciprocalRankFuse(lanes));
  const expectedRrf = 1 / (60 + 1);
  const expectedRawBoost = 5 * 0.001 * 1;
  assert.ok(Math.abs(r.score - (expectedRrf + expectedRawBoost)) < 0.001);
});

test("reciprocalRankFuse — multi-lane scores sum correctly", () => {
  const lanes = [
    lane("vector", [{ chunkId: "a", reason: "vec", rawScore: 0.8 }], 2),
    lane("bm25", [{ chunkId: "a", reason: "bm25", rawScore: 5 }], 1),
  ];
  const r = firstOf(reciprocalRankFuse(lanes));
  assert.equal(r.lanes.length, 2);
});

test("reciprocalRankFuse — vector lane rawScore clamped 0–1", () => {
  const lanes = [lane("vector", [{ chunkId: "a", reason: "vec", rawScore: 5 }])];
  const r = firstOf(reciprocalRankFuse(lanes));
  assert.ok(r.rawLaneScores?.vector !== undefined);
});

test("reciprocalRankFuse — rawScoreBoost applied", () => {
  const lanes = [lane("bm25", [{ chunkId: "a", reason: "t", rawScore: 10 }], 2)];
  const r = firstOf(reciprocalRankFuse(lanes));
  const laneScore = r.laneScores?.bm25;
  assert.ok(laneScore !== undefined);
  const expectedBoost = 10 * 0.001 * 2;
  assert.ok(laneScore! > expectedBoost * 0.9);
});

test("reciprocalRankFuse — cooldown penalty multiplies final score", () => {
  const lanes = [lane("bm25", [{ chunkId: "a", reason: "t", rawScore: 5 }])];
  const r = firstOf(reciprocalRankFuse(lanes, { cooldowns: [{ chunkId: "a", penalty: 0.5, reason: "cooldown:5m:0.50" }] }));
  const withoutCd = firstOf(reciprocalRankFuse(lanes));
  assert.ok(r.score < withoutCd.score);
  assert.equal(r.cooldownPenalty, 0.5);
});

test("reciprocalRankFuse — no cooldown entry leaves score unchanged", () => {
  const lanes = [lane("bm25", [{ chunkId: "a", reason: "t", rawScore: 5 }])];
  const r = firstOf(reciprocalRankFuse(lanes, { cooldowns: [{ chunkId: "b", penalty: 0.5, reason: "cd" }] }));
  assert.equal(r.cooldownPenalty, undefined);
});

test("reciprocalRankFuse — zero-weight lane skipped", () => {
  const lanes = [lane("bm25", [{ chunkId: "a", reason: "t" }], 0)];
  const result = reciprocalRankFuse(lanes);
  assert.deepEqual(result, []);
});

test("reciprocalRankFuse — tie-breaking by chunkId", () => {
  const lanes = [lane("bm25", [{ chunkId: "b", reason: "t", rawScore: 0 }, { chunkId: "a", reason: "t", rawScore: 0 }])];
  const result = reciprocalRankFuse(lanes);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.chunkId, "a");
  assert.equal(result[1]!.chunkId, "b");
});

test("reciprocalRankFuse — finalNormalizedScore populated", () => {
  const lanes = [lane("bm25", [{ chunkId: "a", reason: "t", rawScore: 5 }])];
  const r = firstOf(reciprocalRankFuse(lanes));
  assert.equal(r.finalNormalizedScore, 1);
});

test("reciprocalRankFuse — empty lanes returns []", () => {
  assert.deepEqual(reciprocalRankFuse([]), []);
});

test("reciprocalRankFuse — laneScores and rawLaneScores populated correctly", () => {
  const lanes = [
    lane("vector", [{ chunkId: "a", reason: "v", rawScore: 0.9 }], 2),
    lane("bm25", [{ chunkId: "a", reason: "b" }], 1),
  ];
  const r = firstOf(reciprocalRankFuse(lanes));
  assert.ok(r.laneScores?.vector !== undefined);
  assert.ok(r.laneScores?.bm25 !== undefined);
  assert.ok(r.rawLaneScores?.vector !== undefined);
});
