import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LtmEvidenceUnit, LtmNote, SessionSummary } from "@marinara-engine/shared";
import { deduplicateUnits } from "../dedup.js";
import { validateLtmEvidenceUnits } from "../evidence-unit-validation.js";
import { evidenceUnitMessages } from "../evidence-unit-extraction.js";
import { mapGameJournalToEvidenceUnits, renderGameSourceText } from "../game-journal-mapper.js";

const timestamp = "2024-01-01T00:00:00.000Z";
const sourceHash = "a".repeat(64);

function note(id: string, sections: LtmNote["sections"] = {}): LtmNote {
  return {
    id,
    type: id.startsWith("source_") ? "source" : id.startsWith("timeline_") ? "timeline_event" : "relationship",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: id.startsWith("source_") ? ["source_summary"] : ["typed_memory"],
    keywords: [],
    links: [],
    sections,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function unit(bucket: LtmEvidenceUnit["bucket"], patch: Partial<LtmEvidenceUnit> = {}): LtmEvidenceUnit {
  return {
    id: randomUUID(),
    bucket,
    subjectId: "alice_bob",
    sectionKey: bucket === "timeline_event" ? "event" : "state",
    text: "Alice told Bob the truth about the stolen map.",
    importance: "major",
    keywords: [],
    evidence: ["source_note:source_test"],
    confidence: 0.95,
    salience: 0.8,
    status: "active",
    links: [],
    sourceHash,
    ...patch,
  };
}

test("relationship_state with dimension changes requires caused_by support", () => {
  const sourceNote = note("source_test", {
    source: {
      text: "Alice told Bob the truth about the stolen map, changing their trust.",
      updatedAt: timestamp,
    },
  });

  const result = validateLtmEvidenceUnits({
    units: [
      unit("relationship_state", {
        text: "Alice and Bob's trust shifted after the stolen map confession.",
        dimensions: { trust: 35, tension: 72 },
        dimensionChanges: { trust: -20, tension: 18 },
      }),
    ],
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    expectedSourceHash: sourceHash,
  });

  assert.equal(result.keptUnits.length, 0);
  assert.equal(result.droppedCandidates[0]?.reason, "unsupported_bucket");
});

test("relationship_state with caused_by timeline link is kept", () => {
  const timeline = unit("timeline_event", {
    subjectId: "map_confession",
    text: "Alice confessed the truth about the stolen map to Bob.",
  });
  const relationship = unit("relationship_state", {
    text: "Alice and Bob's trust shifted after the stolen map confession.",
    dimensions: { trust: 35, tension: 72 },
    dimensionChanges: { trust: -20, tension: 18 },
    links: [{ target: "timeline_map_confession", relation: "caused_by" }],
  });
  const sourceNote = note("source_test", {
    source: {
      text: "Alice confessed the truth about the stolen map to Bob. Their trust shifted after the confession.",
      updatedAt: timestamp,
    },
  });

  const result = validateLtmEvidenceUnits({
    units: [timeline, relationship],
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    expectedSourceHash: sourceHash,
  });

  assert.equal(result.keptUnits.length, 2);
});

test("deduplicateUnits drops exact duplicates against existing sections", () => {
  const existing = note("timeline_map_confession", {
    event: {
      text: "Alice told Bob the truth about the stolen map.",
      updatedAt: timestamp,
    },
  });

  const result = deduplicateUnits({
    units: [unit("timeline_event", { subjectId: "map_confession" })],
    existingNotes: [existing],
  });

  assert.equal(result.deduplicated.length, 0);
  assert.equal(result.diagnostics[0]?.code, "deduplicated_evidence_unit");
});

test("static relationship_state without caused_by is kept (no change described)", () => {
  const sourceNote = note("source_test", {
    source: {
      text: "Alice and Bob have been steady allies for months.",
      updatedAt: timestamp,
    },
  });

  const result = validateLtmEvidenceUnits({
    units: [
      unit("relationship_state", {
        text: "Alice and Bob are steady allies with mutual trust.",
        dimensions: { trust: 78, tension: 12 },
      }),
    ],
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    expectedSourceHash: sourceHash,
  });

  assert.equal(result.keptUnits.length, 1);
  assert.equal(result.droppedCandidates.length, 0);
  assert.equal(result.keptUnits[0]!.bucket, "relationship_state");
});

test("game journal relationship change without session recap is dropped by validation", () => {
  const summary: SessionSummary = {
    sessionNumber: 1,
    summary: "",
    resumePoint: "Standing at the entrance of the hidden chamber.",
    partyDynamics: "Tension between Alice and Bob softened after working together to solve the puzzle.",
    partyState: "Party is healthy and well-supplied.",
    keyDiscoveries: ["Hidden chamber"],
    characterMoments: [],
    littleDetails: [],
    statsSnapshot: {},
    npcUpdates: [],
    timestamp,
  };
  const sourceText = renderGameSourceText(null, [summary]);
  const sourceNote = note("source_test", {
    source: {
      text: sourceText,
      updatedAt: timestamp,
    },
  });
  const sourceEvidence = `source_note:${sourceNote.id}`;
  const units = mapGameJournalToEvidenceUnits(null, [summary], {
    chatId: "test-chat",
    scope: {},
    sourceHash,
  }).map((mappedUnit) => ({
    ...mappedUnit,
    evidence: mappedUnit.evidence.includes(sourceEvidence)
      ? mappedUnit.evidence
      : [...mappedUnit.evidence, sourceEvidence],
  }));

  const result = validateLtmEvidenceUnits({
    units,
    sourceText,
    sourceNote,
    existingNotes: [],
    expectedSourceHash: sourceHash,
  });

  assert.equal(
    result.keptUnits.some((keptUnit) => keptUnit.bucket === "relationship_state" && keptUnit.subjectId === "party"),
    false,
  );
  assert.ok(
    result.droppedCandidates.some(
      (candidate) =>
        candidate.reason === "unsupported_bucket" &&
        candidate.message.includes("missing a caused_by link"),
    ),
  );
});

test("prompt contract advertises caused_by in allowedTimelineRelations", () => {
  const sourceNote = note("source_test", {
    source: {
      text: "Alice told Bob the truth about the stolen map.",
      updatedAt: timestamp,
    },
  });

  const messages = evidenceUnitMessages({
    sourceNote,
    sourceText: sourceNote.sections.source!.text,
    existingNotes: [],
    provider: null as never,
    model: "test-model",
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });

  const userMsg = messages.find((m) => m.role === "user")!;
  const parsed = JSON.parse(userMsg.content) as Record<string, unknown>;
  const relations = parsed.allowedTimelineRelations as string[];

  assert.ok(relations.includes("caused_by"), "allowedTimelineRelations should include caused_by");
  assert.ok(relations.includes("affects_relationship"), "allowedTimelineRelations should include affects_relationship");
  assert.ok(relations.includes("affects_character"), "allowedTimelineRelations should include affects_character");
  assert.ok(relations.includes("occurred_in"), "allowedTimelineRelations should include occurred_in");
});
