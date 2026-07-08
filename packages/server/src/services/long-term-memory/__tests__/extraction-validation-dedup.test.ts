import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LtmDraftMutation, LtmEvidenceUnit, LtmNote, SessionSummary } from "@marinara-engine/shared";
import {
  ltmExtractionDraftSchema,
  ltmEvidenceUnitExtractionResponseSchema,
} from "@marinara-engine/shared";
import {
  BaseLLMProvider,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../../llm/base-provider.js";
import { deduplicateUnits } from "../dedup.js";
import { compileLtmEvidenceUnits } from "../evidence-unit-compiler.js";
import { validateLtmEvidenceUnits } from "../evidence-unit-validation.js";
import {
  compileEvidenceUnitExtraction,
  evidenceUnitMessages,
  evidenceUnitResponseFormat,
  parseEvidenceUnitPayload,
  runLongTermMemoryEvidenceUnitExtraction,
  sourceHashForEvidenceUnitExtraction,
} from "../evidence-unit-extraction.js";
import { mapGameJournalToEvidenceUnits, renderGameSourceText } from "../game-journal-mapper.js";
import { applyLongTermMemoryDraft } from "../reconciliation.js";
import { extractLongTermMemoryFromSourceNote } from "../source-extraction.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
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

class RecordingProvider extends BaseLLMProvider {
  public observedMaxTokens: number | undefined;

  constructor(maxContext: number) {
    super("", "", maxContext);
  }

  async *chat(_messages: ChatMessage[], _options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
    return;
  }

  override async chatComplete(_messages: ChatMessage[], options: ChatOptions): Promise<ChatCompletionResult> {
    this.observedMaxTokens = options.maxTokens;
    return {
      content: JSON.stringify({ summary: "Budget reduced", units: [] }),
      toolCalls: [],
      finishReason: "stop",
    };
  }
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
  assert.equal("maxItems" in jsonSchema.schema.properties.units, false);
});

test("evidence unit payload accepts more than forty valid units", () => {
  const units = Array.from({ length: 45 }, (_, index) =>
    unit("timeline_event", {
      subjectId: `event_${index + 1}`,
      text: `Durable continuity event ${index + 1} changed the source timeline.`,
    }),
  );

  const parsed = parseEvidenceUnitPayload({ summary: "Many events", units }, sourceHash);

  assert.equal(parsed.response.units.length, 45);
  assert.equal(parsed.totalCandidates, 45);
  assert.equal(parsed.droppedCandidates.length, 0);
  assert.equal(ltmEvidenceUnitExtractionResponseSchema.parse({ summary: "Many events", units }).units.length, 45);
});

test("evidence unit compiler returns every generated draft mutation", () => {
  const units = Array.from({ length: 30 }, (_, index) =>
    unit("timeline_event", {
      subjectId: `event_${index + 1}`,
      text: `Durable continuity event ${index + 1} changed the source timeline.`,
    }),
  );

  const result = compileLtmEvidenceUnits({
    units,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    mode: "roleplay",
    summary: "Many events",
  });

  assert.equal(result.mutations.length, 30);
  assert.equal(result.suggestions.generated, 30);
  assert.equal(result.suggestions.returned, 30);
});

test("draft schemas and partial apply support more than twenty-five mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-large-draft-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();
    const mutations: LtmDraftMutation[] = Array.from({ length: 30 }, (_, index) => ({
      id: randomUUID(),
      kind: "create_note",
      risk: "low",
      confidence: 0.9,
      summary: `Create timeline memory ${index + 1}`,
      evidence: ["source_note:source_test"],
      note: {
        id: `timeline_event_${index + 1}`,
        type: "timeline_event",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory", "timeline_event"],
        keywords: [],
        links: [],
        sections: {
          event: {
            text: `Durable continuity event ${index + 1} changed the source timeline.`,
            updatedAt: timestamp,
            evidence: ["source_note:source_test"],
          },
        },
      },
    }));

    assert.equal(
      ltmExtractionDraftSchema.parse({
        id: randomUUID(),
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
        source: { sourceNoteId: "source_test", sourceHash },
        scope: {},
        modes: ["roleplay"],
        summary: "Large draft",
        mutations,
      }).mutations.length,
      30,
    );

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      source: { sourceNoteId: "source_test", sourceHash },
      scope: {},
      modes: ["roleplay"],
      response: { summary: "Large draft", mutations },
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      mutationIds: [draft.mutations[0]!.id],
      rebuildIndexes: false,
      operationId: randomUUID(),
    });

    assert.equal(result.appliedMutationIds.length, 1);
    assert.equal(result.skippedMutationIds.length, 29);
    assert.equal(result.draft.status, "pending");
    assert.equal(result.draft.mutations.length, 29);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence extraction reduces completion budget instead of failing when prompt still fits context", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-context-preflight-"));
  try {
    const sourceNote = note("source_test", {
      source: {
        text: "Alice told Bob the truth about the stolen map.",
        updatedAt: timestamp,
      },
    });
    const provider = new RecordingProvider(8_819);

    const result = await runLongTermMemoryEvidenceUnitExtraction({
      sourceNote,
      sourceText: sourceNote.sections.source!.text,
      existingNotes: [],
      provider,
      model: "test-model",
      root,
      scope: {},
      modes: ["roleplay"],
      sourceHash,
      maxOutputTokens: 8_192,
      operationId: randomUUID(),
    });

    assert.equal(result.response.summary, "Budget reduced");
    assert.equal(result.response.units.length, 0);
    assert.equal(typeof provider.observedMaxTokens, "number");
    assert.ok(provider.observedMaxTokens! < 8_192);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("evidence unit payload repairs bare and display link targets before schema parsing", () => {
  const parsed = parseEvidenceUnitPayload(
    {
      summary: "Relationship update",
      units: [
        unit("timeline_event", {
          subjectId: "reunion_foundry",
          text: "Damo and Lisa reunited at The Foundry after seven years.",
        }),
        {
          ...unit("relationship_state", {
            subjectId: "lisa_damo",
            text: "Lisa and Damo's affection grew after the reunion at The Foundry.",
            dimensions: { affection: 95 },
            dimensionChanges: { affection: 30 },
          }),
          links: [
            { target: "reunion_foundry", relation: "caused_by" },
            { target: "Lisa Imai", relation: "affects_character" },
            { target: "not a real relation", relation: "invalid relation" },
          ],
        },
        unit("character_fact", {
          subjectId: "lisa_imai",
          sectionKey: "facts",
          text: "Lisa Imai is Damo's reunited childhood best friend.",
        }),
      ],
    },
    sourceHash,
  );

  assert.equal(parsed.response.units.length, 3);
  assert.equal(parsed.droppedCandidates.length, 0);
  const relationship = parsed.response.units.find((candidate) => candidate.bucket === "relationship_state");
  assert.ok(relationship);
  assert.deepEqual(relationship.links, [
    { target: "timeline_reunion_foundry", relation: "caused_by" },
    { target: "char_lisa_imai", relation: "affects_character" },
  ]);
});

test("compiled extraction keeps relationship changes with repaired bare caused_by links", () => {
  const sourceText = [
    "### timeline_event",
    "- `[CRITICAL] damo_korvak | reunion_foundry: Damo performed at The Foundry; Lisa recognized him and reunited physically after seven years.`",
    "### relationship_state",
    "- `[CRITICAL] lisa_imai: lisa_damo | sectionKey: state | Reunited childhood best friends with restored affection. | dimensions: affection 95 | changes: affection +30 | caused_by: reunion_foundry`",
  ].join("\n");
  const sourceNote = note("source_test", {
    source: {
      text: sourceText,
      updatedAt: timestamp,
    },
  });
  const parsed = parseEvidenceUnitPayload(
    {
      summary: "Relationship update",
      units: [
        unit("timeline_event", {
          subjectId: "reunion_foundry",
          text: "Damo performed at The Foundry; Lisa recognized him and reunited physically after seven years.",
        }),
        unit("relationship_state", {
          subjectId: "lisa_damo",
          text: "Lisa and Damo's affection grew after the reunion at The Foundry.",
          dimensions: { affection: 95 },
          dimensionChanges: { affection: 30 },
          links: [{ target: "reunion_foundry", relation: "caused_by" }],
        }),
      ],
    },
    sourceHash,
  );

  const compiled = compileEvidenceUnitExtraction({
    unitResponse: parsed.response,
    parserDroppedCandidates: parsed.droppedCandidates,
    totalCandidates: parsed.totalCandidates,
    sourceText,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    mode: "roleplay",
    sourceHash,
  });

  assert.equal(compiled.outcome.droppedUnits, 0);
  assert.equal(compiled.compiledResponse.mutations.length, 2);
  assert.ok(
    compiled.compiledResponse.mutations.some(
      (mutation) => mutation.kind === "create_note" && mutation.note.id === "rel_lisa_damo",
    ),
  );
});

test("compiled extraction keeps display-case caused_by links to existing timeline notes", () => {
  const sourceText = "Lisa and Damo's affection grew after the Reunion Foundry event.";
  const sourceNote = note("source_test", {
    source: {
      text: sourceText,
      updatedAt: timestamp,
    },
  });
  const existingTimeline = note("timeline_reunion_foundry", {
    event: {
      text: "Damo and Lisa reunited at The Foundry after seven years.",
      updatedAt: timestamp,
      evidence: ["source_note:older_source"],
    },
  });
  const parsed = parseEvidenceUnitPayload(
    {
      summary: "Relationship update",
      units: [
        unit("relationship_state", {
          subjectId: "lisa_damo",
          text: "Lisa and Damo's affection grew after the Reunion Foundry event.",
          dimensions: { affection: 95 },
          dimensionChanges: { affection: 30 },
          links: [{ target: "Reunion Foundry", relation: "caused_by" }],
        }),
      ],
    },
    sourceHash,
  );

  const compiled = compileEvidenceUnitExtraction({
    unitResponse: parsed.response,
    parserDroppedCandidates: parsed.droppedCandidates,
    totalCandidates: parsed.totalCandidates,
    sourceText,
    sourceNote,
    existingNotes: [existingTimeline],
    scope: {},
    modes: ["roleplay"],
    mode: "roleplay",
    sourceHash,
  });

  assert.equal(parsed.response.units[0]?.links[0]?.target, "timeline_reunion_foundry");
  assert.equal(compiled.outcome.droppedUnits, 0);
  assert.ok(
    compiled.compiledResponse.mutations.some(
      (mutation) => mutation.kind === "create_note" && mutation.note.id === "rel_lisa_damo",
    ),
  );
});

test("structured normalizer folds character, world, and anchor section suffixes into target sections", () => {
  const sourceText = [
    "### character_fact",
    "- `[CRITICAL] damo_korvak | abilities: Conservatory-level piano and jazz improvisation.`",
    "### world_fact",
    "- `[MODERATE] the_foundry | facts | Converted warehouse venue near campus.`",
    "### anchor",
    "- `[CRITICAL] friendship_bracelets | motif | Matching childhood friendship bracelets worn by Lisa and Damo.`",
  ].join("\n");
  const sourceNote = note("source_test", {
    source: {
      text: sourceText,
      updatedAt: timestamp,
    },
  });
  const units = [
    unit("character_fact", {
      subjectId: "damo_korvak_abilities",
      sectionKey: "abilities",
      text: "Damo has conservatory-level piano and jazz improvisation ability.",
    }),
    unit("world_fact", {
      subjectId: "the_foundry_facts",
      sectionKey: "facts",
      text: "The Foundry is a converted warehouse venue near campus.",
      links: [{ target: "char_damo_korvak_abilities", relation: "involves" }],
    }),
    unit("anchor", {
      subjectId: "friendship_bracelets_motif",
      sectionKey: "motif",
      text: "Matching childhood friendship bracelets recur as Lisa and Damo's bond symbol.",
    }),
  ];

  const compiled = compileEvidenceUnitExtraction({
    unitResponse: { summary: "Canonical targets", units },
    totalCandidates: units.length,
    sourceText,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    mode: "roleplay",
    sourceHash,
  });

  assert.equal(compiled.outcome.droppedUnits, 0);
  const creates = compiled.compiledResponse.mutations.filter(
    (mutation): mutation is Extract<LtmDraftMutation, { kind: "create_note" }> => mutation.kind === "create_note",
  );
  assert.deepEqual(
    creates.map((mutation) => mutation.note.id).sort(),
    ["char_damo_korvak", "world_friendship_bracelets", "world_the_foundry"],
  );
  assert.ok(creates.find((mutation) => mutation.note.id === "char_damo_korvak")?.note.sections.abilities);
  const worldFoundry = creates.find((mutation) => mutation.note.id === "world_the_foundry")?.note;
  assert.ok(worldFoundry?.sections.facts);
  assert.ok(worldFoundry.links.some((link) => link.target === "char_damo_korvak"));
  assert.ok(!worldFoundry.links.some((link) => link.target === "char_damo_korvak_abilities"));
  assert.ok(creates.find((mutation) => mutation.note.id === "world_friendship_bracelets")?.note.sections.motif);
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

test("source extraction canonicalizes character section suffix before scoped variant resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-scoped-canonical-character-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const sourceText = [
      "### character_fact",
      "- `[MAJOR] damo_korvak | abilities: Damo plays conservatory-level piano with jazz voicings.`",
    ].join("\n");
    await storage.createNote(
      {
        id: "scene_source_scoped_character",
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
        id: "char_damo_korvak",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_b" },
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "Damo Korvak exists in another story.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    const sourceNote = await storage.getNote("scene_source_scoped_character");
    assert.ok(sourceNote);
    const provider = {
      maxTokensOverrideValue: undefined,
      chatComplete: async () => ({
        content: JSON.stringify({
          summary: "Canonical scoped character",
          units: [
            {
              id: randomUUID(),
              bucket: "character_fact",
              subjectId: "damo_korvak_abilities",
              sectionKey: "abilities",
              text: "Damo plays conservatory-level piano with jazz voicings.",
              importance: "major",
              evidence: ["source_note:scene_source_scoped_character"],
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
      noteId: "scene_source_scoped_character",
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
    assert.match(create.note.id, /^char_damo_korvak_[a-f0-9]{10}$/);
    assert.ok(create.note.sections.abilities);
    assert.ok(!create.note.id.includes("_abilities_"));
    const diagnostic = result.diagnostics.find((entry) => entry.code === "target_note_scoped_variant");
    assert.equal(diagnostic?.details?.originalNoteId, "char_damo_korvak");
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
