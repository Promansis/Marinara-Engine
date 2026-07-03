import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LtmEvidenceUnit, LtmNote } from "@marinara-engine/shared";
import { deduplicateUnits } from "../dedup.js";
import { validateLtmEvidenceUnits } from "../evidence-unit-validation.js";

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
