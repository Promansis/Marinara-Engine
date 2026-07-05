import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LtmDraftMutation, LtmEvidenceUnit, LtmNote, SessionSummary } from "@marinara-engine/shared";
import { deduplicateUnits } from "../dedup.js";
import { validateLtmEvidenceUnits } from "../evidence-unit-validation.js";
import {
  evidenceUnitMessages,
  evidenceUnitResponseFormat,
  parseEvidenceUnitPayload,
  sourceHashForEvidenceUnitExtraction,
} from "../evidence-unit-extraction.js";
import { mapGameJournalToEvidenceUnits, renderGameSourceText } from "../game-journal-mapper.js";
import { extractLongTermMemoryFromSourceNote } from "../source-extraction.js";
import { LongTermMemoryStorage } from "../storage.js";

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

test("prompt contract advertises schema-critical relationship and target rules", () => {
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
  const parsed = JSON.parse(userMsg.content) as {
    unitFields: Record<string, unknown>;
    allowedRelationshipDimensions: string[];
    targetNoteRules: string[];
  };

  assert.equal(parsed.unitFields.importance, "one of critical, major, moderate, minor");
  assert.ok(String(parsed.unitFields.dimensions).includes("allowedRelationshipDimensions"));
  assert.ok(parsed.allowedRelationshipDimensions.includes("trust"));
  assert.ok(parsed.allowedRelationshipDimensions.includes("protectiveness"));
  assert.ok(parsed.targetNoteRules.some((rule) => rule.includes("timeline_<subjectId>")));
  assert.ok(parsed.targetNoteRules.some((rule) => rule.includes("specific event or beat")));
});

test("evidence unit response format constrains target shape and relationship dimensions", () => {
  const responseFormat = evidenceUnitResponseFormat({
    allowedBuckets: ["timeline_event", "relationship_state"],
    sourceHash,
  });
  const jsonSchema = responseFormat.json_schema as {
    schema: {
      properties: {
        units: {
          items: {
            required: string[];
            properties: Record<string, any>;
          };
        };
      };
    };
  };
  const unitSchema = jsonSchema.schema.properties.units.items;

  assert.equal(responseFormat.type, "json_schema");
  assert.ok(unitSchema.required.includes("importance"));
  assert.deepEqual(unitSchema.properties.bucket.enum, ["timeline_event", "relationship_state"]);
  assert.deepEqual(unitSchema.properties.sourceHash.enum, [sourceHash]);
  assert.equal(unitSchema.properties.dimensions.additionalProperties, false);
  assert.ok(unitSchema.properties.dimensions.properties.trust);
  assert.ok(unitSchema.properties.dimensionChanges.properties.tension);
});

test("malformed evidence unit drops include actionable schema issues", () => {
  const parsed = parseEvidenceUnitPayload(
    {
      summary: "Relationship update",
      units: [
        {
          id: randomUUID(),
          bucket: "relationship_state",
          subjectId: "alice_bob",
          sectionKey: "state",
          text: "Alice and Bob's professional curiosity rose after the confession.",
          importance: "major",
          evidence: ["source_note:source_test"],
          confidence: 0.9,
          salience: 0.8,
          status: "active",
          links: [],
          sourceHash,
          dimensions: { professional_curiosity: 70 },
        },
      ],
    },
    sourceHash,
  );

  assert.equal(parsed.response.units.length, 0);
  assert.equal(parsed.droppedCandidates[0]?.reason, "invalid_format");
  assert.ok(parsed.droppedCandidates[0]?.issues?.some((issue) => issue.includes("professional_curiosity")));
});

test("source extraction creates a scoped variant for out-of-scope target collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-out-of-scope-target-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const sourceText = "Mara trusted Jules again after he returned the tower archive key.";
    await storage.createNote(
      {
        id: "scene_source_second",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_a" },
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: sourceText,
            updatedAt: timestamp,
            evidence: ["chat:chat_a"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "timeline_mara_jules",
        type: "timeline_event",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_b" },
        tags: ["typed_memory", "timeline_event"],
        links: [],
        sections: {
          event: {
            text: "Mara first trusted Jules with the hidden key.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_first"],
          },
        },
      },
      { suppressEvent: true },
    );

    const sourceNote = await storage.getNote("scene_source_second");
    assert.ok(sourceNote);
    const provider = {
      maxTokensOverrideValue: undefined,
      chatComplete: async () => ({
        content: JSON.stringify({
          summary: "Out-of-scope target collision",
          units: [
            {
              id: randomUUID(),
              bucket: "timeline_event",
              subjectId: "mara_jules",
              sectionKey: "event",
              text: sourceText,
              importance: "major",
              evidence: ["source_note:scene_source_second"],
              confidence: 0.9,
              salience: 0.8,
              status: "active",
              links: [],
              sourceHash: sourceHashForEvidenceUnitExtraction(sourceNote),
            },
          ],
        }),
      }),
    } as any;

    const result = await extractLongTermMemoryFromSourceNote({
      noteId: "scene_source_second",
      provider,
      model: "test-model",
      root,
      operationId: randomUUID(),
      embeddingSource: {
        label: "test",
        embed: async (texts) => texts.map(() => []),
      },
    });

    assert(result.draft);
    const create = result.draft.mutations.find((mutation) => mutation.kind === "create_note");
    assert.equal(create?.kind, "create_note");
    assert.match(create.note.id, /^timeline_mara_jules_[a-f0-9]{10}$/);
    assert.deepEqual(create.note.scope, { chatId: "chat_a", chatIds: ["chat_a"] });
    assert.equal(result.outcome.droppedCandidates.length, 0);
    const diagnostic = result.diagnostics.find((entry) => entry.code === "target_note_scoped_variant");
    assert.equal(diagnostic?.severity, "warning");
    assert.deepEqual(diagnostic?.details?.sourceScope, { chatId: "chat_a", chatIds: ["chat_a"] });
    assert.deepEqual(diagnostic?.details?.targetScope, { chatId: "chat_b", chatIds: ["chat_b"] });
    assert.equal(diagnostic?.details?.originalNoteId, "timeline_mara_jules");
    assert.equal(diagnostic?.details?.resolvedNoteId, create.note.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction creates scoped variants for every typed bucket and rewrites remapped links", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-all-scoped-targets-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const sourceText = [
      "Damo has a silver key tattoo linked to the archive.",
      "Lisa returns the archive key before dawn.",
      "Damo and Lisa's trust improved after Lisa returned the archive key.",
      "The old city archive floats above the lantern river.",
      "Open thread: Damo must recover the missing key before the archive door will resolve.",
      "Noir banter remains sharp and intimate around the archive.",
      "The silver key symbol marks promises around the archive.",
    ].join(" ");
    await storage.createNote(
      {
        id: "scene_source_all_scoped",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_a" },
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: sourceText,
            updatedAt: timestamp,
            evidence: ["chat:chat_a"],
          },
        },
      },
      { suppressEvent: true },
    );

    const createExisting = async (id: string, type: LtmNote["type"], sectionKey: string) => {
      await storage.createNote(
        {
          id,
          type,
          status: "active",
          modes: ["roleplay"],
          scope: { chatId: "chat_b" },
          tags: type === "relationship" ? ["typed_memory", "relationship_memory"] : ["typed_memory"],
          links: [],
          sections: {
            [sectionKey]: {
              text: `Existing out-of-scope ${id}.`,
              updatedAt: timestamp,
              evidence: ["source_note:scene_source_elsewhere"],
            },
          },
        },
        { suppressEvent: true },
      );
    };

    await createExisting("char_damo", "character", "facts");
    await createExisting("timeline_archive_return", "timeline_event", "event");
    await createExisting("rel_damo_lisa", "relationship", "state");
    await createExisting("world_old_city_archive", "world", "facts");
    await createExisting("thread_missing_key", "thread", "summary");
    await createExisting("tone_noir", "tone", "observations");
    await createExisting("world_anchor_symbol", "world", "motif");

    const sourceNote = await storage.getNote("scene_source_all_scoped");
    assert.ok(sourceNote);
    const unitSourceHash = sourceHashForEvidenceUnitExtraction(sourceNote);
    const provider = {
      maxTokensOverrideValue: undefined,
      chatComplete: async () => ({
        content: JSON.stringify({
          summary: "All scoped targets",
          units: [
            {
              id: randomUUID(),
              bucket: "character_fact",
              subjectId: "damo",
              sectionKey: "facts",
              text: "Damo has a silver key tattoo linked to the archive.",
              importance: "major",
              evidence: ["source_note:scene_source_all_scoped"],
              confidence: 0.9,
              salience: 0.8,
              status: "active",
              links: [],
              sourceHash: unitSourceHash,
            },
            {
              id: randomUUID(),
              bucket: "timeline_event",
              subjectId: "archive_return",
              sectionKey: "event",
              text: "Lisa returns the archive key before dawn.",
              importance: "major",
              evidence: ["source_note:scene_source_all_scoped"],
              confidence: 0.9,
              salience: 0.8,
              status: "active",
              links: [],
              sourceHash: unitSourceHash,
            },
            {
              id: randomUUID(),
              bucket: "relationship_state",
              subjectId: "damo_lisa",
              sectionKey: "state",
              text: "Damo and Lisa's trust improved after Lisa returned the archive key.",
              importance: "major",
              evidence: ["source_note:scene_source_all_scoped"],
              confidence: 0.9,
              salience: 0.8,
              status: "active",
              links: [{ target: "timeline_archive_return", relation: "caused_by" }],
              sourceHash: unitSourceHash,
              dimensions: { trust: 70 },
              dimensionChanges: { trust: 20 },
            },
            {
              id: randomUUID(),
              bucket: "world_fact",
              subjectId: "old_city_archive",
              sectionKey: "facts",
              text: "The old city archive floats above the lantern river.",
              importance: "major",
              evidence: ["source_note:scene_source_all_scoped"],
              confidence: 0.9,
              salience: 0.8,
              status: "active",
              links: [],
              sourceHash: unitSourceHash,
            },
            {
              id: randomUUID(),
              bucket: "thread",
              subjectId: "missing_key",
              sectionKey: "summary",
              text: "Open thread: Damo must recover the missing key before the archive door will resolve.",
              importance: "major",
              evidence: ["source_note:scene_source_all_scoped"],
              confidence: 0.9,
              salience: 0.8,
              status: "active",
              links: [],
              sourceHash: unitSourceHash,
            },
            {
              id: randomUUID(),
              bucket: "tone",
              subjectId: "noir",
              sectionKey: "observations",
              text: "Noir banter remains sharp and intimate around the archive.",
              importance: "major",
              evidence: ["source_note:scene_source_all_scoped"],
              confidence: 0.9,
              salience: 0.8,
              status: "active",
              links: [],
              sourceHash: unitSourceHash,
            },
            {
              id: randomUUID(),
              bucket: "anchor",
              subjectId: "anchor_symbol",
              sectionKey: "motif",
              text: "The silver key symbol marks promises around the archive.",
              importance: "major",
              evidence: ["source_note:scene_source_all_scoped"],
              confidence: 0.9,
              salience: 0.8,
              status: "active",
              links: [],
              sourceHash: unitSourceHash,
            },
          ],
        }),
      }),
    } as any;

    const result = await extractLongTermMemoryFromSourceNote({
      noteId: "scene_source_all_scoped",
      provider,
      model: "test-model",
      root,
      operationId: randomUUID(),
      embeddingSource: {
        label: "test",
        embed: async (texts) => texts.map(() => []),
      },
    });

    assert(result.draft);
    const creates = result.draft.mutations.filter(
      (mutation): mutation is Extract<LtmDraftMutation, { kind: "create_note" }> => mutation.kind === "create_note",
    );
    assert.equal(creates.length, 7);
    const ids = creates.map((mutation) => mutation.note.id).sort();
    for (const prefix of [
      "char_damo",
      "rel_damo_lisa",
      "thread_missing_key",
      "timeline_archive_return",
      "tone_noir",
      "world_anchor_symbol",
      "world_old_city_archive",
    ]) {
      assert(ids.some((id) => new RegExp(`^${prefix}_[a-f0-9]{10}$`).test(id)), `missing ${prefix} variant`);
    }
    const timelineCreate = creates.find((mutation) => mutation.note.id.startsWith("timeline_archive_return_"));
    const relationshipCreate = creates.find((mutation) => mutation.note.id.startsWith("rel_damo_lisa_"));
    assert(timelineCreate);
    assert(relationshipCreate);
    assert(
      relationshipCreate.note.links.some(
        (link) => link.relation === "caused_by" && link.target === timelineCreate.note.id,
      ),
    );
    assert(!relationshipCreate.note.links.some((link) => link.target === "timeline_archive_return"));
    assert.equal(result.outcome.droppedCandidates.length, 0);
    assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "target_note_scoped_variant").length, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction treats a global same-id note as a scoped collision", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-global-target-collision-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const sourceText = "Damo keeps a silver compass hidden inside his coat.";
    await storage.createNote(
      {
        id: "scene_source_global_collision",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_a" },
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: sourceText,
            updatedAt: timestamp,
            evidence: ["chat:chat_a"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "char_damo",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "A global Damo note from another setup.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    const sourceNote = await storage.getNote("scene_source_global_collision");
    assert.ok(sourceNote);
    const provider = {
      maxTokensOverrideValue: undefined,
      chatComplete: async () => ({
        content: JSON.stringify({
          summary: "Global collision",
          units: [
            {
              id: randomUUID(),
              bucket: "character_fact",
              subjectId: "damo",
              sectionKey: "facts",
              text: sourceText,
              importance: "major",
              evidence: ["source_note:scene_source_global_collision"],
              confidence: 0.9,
              salience: 0.8,
              status: "active",
              links: [],
              sourceHash: sourceHashForEvidenceUnitExtraction(sourceNote),
            },
          ],
        }),
      }),
    } as any;

    const result = await extractLongTermMemoryFromSourceNote({
      noteId: "scene_source_global_collision",
      provider,
      model: "test-model",
      root,
      operationId: randomUUID(),
      embeddingSource: {
        label: "test",
        embed: async (texts) => texts.map(() => []),
      },
    });

    assert(result.draft);
    const create = result.draft.mutations.find((mutation) => mutation.kind === "create_note");
    assert.equal(create?.kind, "create_note");
    assert.match(create.note.id, /^char_damo_[a-f0-9]{10}$/);
    assert.deepEqual(create.note.scope, { chatId: "chat_a", chatIds: ["chat_a"] });
    const diagnostic = result.diagnostics.find((entry) => entry.code === "target_note_scoped_variant");
    assert.deepEqual(diagnostic?.details?.targetScope, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
