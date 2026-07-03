import test from "node:test";
import assert from "node:assert/strict";
import { buildLtmGraphIndex, expandLtmGraph } from "../graph.js";
import type { LtmLink, LtmNote } from "@marinara-engine/shared";
import type { LtmMemoryChunk } from "../chunking.js";

function note(id: string, links: LtmLink[] = []): LtmNote {
  return { id, type: "character", status: "active", tags: [], keywords: [], links, sections: {}, scope: {}, modes: ["roleplay"], version: 1, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" };
}

function chunk(noteId: string, chunkId = `${noteId}_chunk`): LtmMemoryChunk {
  return { id: chunkId, noteId, sectionKey: "section", text: "text", sourceHash: "hash", noteType: "character", status: "active", tags: [], keywords: [], scope: {}, updatedAt: "2024-01-01T00:00:00.000Z" };
}

test("buildLtmGraphIndex — correct edges from note links", () => {
  const notes = [note("a", [{ target: "b", relation: "involves" }]), note("b")];
  const result = buildLtmGraphIndex(notes, [chunk("a", "a_chunk"), chunk("b", "b_chunk")]);
  const aNode = result.nodes.a!;
  const bNode = result.nodes.b!;
  assert.equal(aNode.outgoing.length, 1);
  assert.equal(aNode.outgoing[0]!.target, "b");
});

test("buildLtmGraphIndex — bidirectional adjacency", () => {
  const notes = [
    note("a", [{ target: "b", relation: "involves" }]),
    note("b", [{ target: "a", relation: "involves" }]),
  ];
  const result = buildLtmGraphIndex(notes, [chunk("a"), chunk("b")]);
  assert.equal(result.nodes.a?.outgoing.length, 1);
  assert.equal(result.nodes.b?.outgoing.length, 1);
  const aIncomingFromB = result.nodes.a?.incoming.filter((e) => e.source === "b").length ?? 0;
  assert.equal(aIncomingFromB, 1);
});

test("expandLtmGraph — BFS returns correct nodes at distance 1", () => {
  const notes = [
    note("a", [{ target: "b", relation: "involves" }, { target: "c", relation: "involves" }]),
    note("b"),
    note("c"),
  ];
  const graph = buildLtmGraphIndex(notes, [chunk("a"), chunk("b"), chunk("c")]);
  const results = expandLtmGraph(graph, ["a"], { maxHops: 1 });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.distance === 1));
});

test("expandLtmGraph — respects max distance", () => {
  const notes = [
    note("a", [{ target: "b", relation: "involves" }]),
    note("b", [{ target: "c", relation: "involves" }]),
    note("c"),
  ];
  const graph = buildLtmGraphIndex(notes, [chunk("a"), chunk("b"), chunk("c")]);
  const results = expandLtmGraph(graph, ["a"], { maxHops: 1 });
  assert.ok(results.every((r) => r.distance <= 1));
  const results2 = expandLtmGraph(graph, ["a"], { maxHops: 2 });
  const distance2 = results2.filter((r) => r.distance === 2);
  assert.ok(distance2.length > 0);
});

test("expandLtmGraph — handles cycles without infinite loop", () => {
  const notes = [
    note("a", [{ target: "b", relation: "involves" }]),
    note("b", [{ target: "a", relation: "involves" }]),
  ];
  const graph = buildLtmGraphIndex(notes, [chunk("a"), chunk("b")]);
  const results = expandLtmGraph(graph, ["a"], { maxHops: 3 });
  assert.ok(results.length > 0);
});

test("expandLtmGraph — empty seed list returns []", () => {
  const graph = buildLtmGraphIndex([], []);
  assert.deepEqual(expandLtmGraph(graph, []), []);
});

test("expandLtmGraph — seed not in graph returns []", () => {
  const graph = buildLtmGraphIndex([note("a")], [chunk("a")]);
  assert.deepEqual(expandLtmGraph(graph, ["nonexistent"]), []);
});

test("expandLtmGraph — score decreases with distance", () => {
  const notes = [
    note("a", [{ target: "b", relation: "involves" }]),
    note("b", [{ target: "c", relation: "involves" }]),
    note("c"),
  ];
  const graph = buildLtmGraphIndex(notes, [chunk("a"), chunk("b"), chunk("c")]);
  const results = expandLtmGraph(graph, ["a"], { maxHops: 2 });
  const distance1 = results.filter((r) => r.distance === 1);
  const distance2 = results.filter((r) => r.distance === 2);
  assert.ok(distance1.length > 0);
  assert.ok(distance2.length > 0);
  assert.ok(distance1[0]!.score > distance2[0]!.score);
});
