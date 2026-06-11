import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LtmDraftMutation, LtmEvidenceUnit, LtmNote } from "@marinara-engine/shared";
import { ltmEvidenceUnitSchema } from "../../../../../shared/src/schemas/long-term-memory.schema.js";
import { chunkNotes } from "../chunking.js";
import { compileLtmEvidenceUnits } from "../evidence-unit-compiler.js";
import { reduceRelationshipEvidenceUnits } from "../relationship-reducer.js";
import { LongTermMemoryDraftStore } from "../extraction.js";
import { checkLongTermMemoryIntegrity } from "../maintenance.js";
import { getLongTermMemoryDirectories } from "../paths.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import {
  applyLongTermMemoryDraft,
  isLowRiskSourceExtractionMutation,
  isLowRiskTurnMutation,
} from "../reconciliation.js";
import { retrieveLongTermMemory } from "../retrieval.js";
import { LongTermMemoryStorage } from "../storage.js";
import { runLongTermMemoryEvidenceUnitExtraction } from "../evidence-unit-extraction.js";

const timestamp = "2026-06-10T00:00:00.000Z";
const sourceHash = "a".repeat(64);

function sceneAppendMutation(): Extract<LtmDraftMutation, { kind: "append_section" }> {
  return {
    id: randomUUID(),
    kind: "append_section",
    risk: "low",
    confidence: 0.95,
    summary: "Append source scene detail",
    evidence: ["source_note:scene_source_test"],
    noteId: "scene_source_test",
    sectionKey: "summary",
    text: "New scene detail that must stay pending.",
    salience: 0.6,
  };
}

function callbackCreateMutation(
  text = "When the lantern is found, remember the old promise.",
): Extract<LtmDraftMutation, { kind: "create_note" }> {
  return {
    id: randomUUID(),
    kind: "create_note",
    risk: "low",
    confidence: 0.95,
    summary: "Create callback",
    evidence: ["source_note:scene_source_test"],
    note: {
      id: "cb_lantern_promise",
      type: "callback",
      status: "active",
      modes: ["roleplay"],
      scope: {},
      tags: [],
      links: [],
      sections: {
        setup: {
          text,
          updatedAt: timestamp,
          confidence: 0.95,
          evidence: ["source_note:scene_source_test"],
        },
      },
    },
  };
}

test("source extraction low-risk policy blocks scene append auto-apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-reconciliation-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "dormant",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Original source text.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
          summary: {
            text: "Original summary.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const mutation = sceneAppendMutation();
    assert.equal(isLowRiskTurnMutation(mutation), true);
    assert.equal(isLowRiskSourceExtractionMutation(mutation), false);

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      userMessage: "",
      assistantReply: "",
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test" },
      response: {
        summary: "Scene append draft",
        mutations: [mutation],
      },
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      autoApplyLowRiskOnly: true,
      autoApplyPolicy: "source_extraction",
      rebuildIndexes: false,
    });

    assert.deepEqual(result.appliedMutationIds, []);
    assert.deepEqual(result.skippedMutationIds, [mutation.id]);
    assert.equal(result.draft.status, "pending");

    const sourceNote = await storage.getNote("scene_source_test");
    assert.equal(sourceNote?.sections.summary?.text, "Original summary.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction low-risk policy blocks secret callback auto-apply", () => {
  assert.equal(isLowRiskSourceExtractionMutation(callbackCreateMutation()), true);
  assert.equal(
    isLowRiskSourceExtractionMutation(
      callbackCreateMutation("When the lantern is found, reveal Mira's private secret."),
    ),
    false,
  );
});

test("integrity reports malformed event log rows instead of throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-integrity-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();
    const dirs = getLongTermMemoryDirectories(root);
    await writeFile(dirs.eventLog, '{"id":"not-enough-fields"}\nnot json\n', "utf8");

    const result = await checkLongTermMemoryIntegrity(root);

    assert.equal(result.ok, false);
    assert.equal(result.eventCount, 0);
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["malformed_event", "malformed_event"],
    );
    assert(result.issues.every((issue) => issue.path === "events/log.jsonl"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeLtmStore is idempotent across concurrent calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-init-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await Promise.all(Array.from({ length: 8 }, () => storage.initializeLtmStore()));

    const dirs = getLongTermMemoryDirectories(root);
    const policiesBefore = await readFile(join(dirs.config, "policies.json"), "utf8");
    await Promise.all(Array.from({ length: 8 }, () => storage.initializeLtmStore()));
    const policiesAfter = await readFile(join(dirs.config, "policies.json"), "utf8");

    assert.equal(policiesAfter, policiesBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence unit extraction normalizes non-uuid model ids", async () => {
  const sourceNote: LtmNote = {
    id: "scene_source_test",
    type: "scene",
    status: "dormant",
    modes: ["roleplay"],
    scope: {},
    tags: ["source_summary"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      source: {
        text: "Mara keeps old promises and notices the lantern hum.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  };

  const provider = {
    maxTokensOverrideValue: undefined,
    chatComplete: async () => ({
      content: JSON.stringify({
        summary: "Two compact units",
        units: [
          {
            id: "uuid",
            bucket: "character_fact",
            subjectId: "mara",
            sectionKey: "facts",
            text: "Mara keeps old promises.",
            evidence: ["source_note:scene_source_test"],
            confidence: 0.9,
            salience: 0.7,
            status: "active",
            gates: [],
            links: [],
            sourceHash,
          },
          {
            id: "",
            bucket: "callback",
            subjectId: "lantern_hum",
            sectionKey: "setup",
            text: "Lantern hum should pay off later.",
            evidence: ["source_note:scene_source_test"],
            confidence: 0.88,
            salience: 0.66,
            status: "active",
            gates: [],
            links: [],
            sourceHash,
          },
        ],
      }),
    }),
  } as any;

  const result = await runLongTermMemoryEvidenceUnitExtraction({
    sourceNote,
    sourceText: sourceNote.sections.source!.text,
    existingNotes: [],
    provider,
    model: "test-model",
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });

  assert.equal(result.units.length, 2);
  for (const unit of result.units) {
    assert.match(unit.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  }
});

test("evidence unit extraction prompt uses single enum examples instead of pipe-joined bucket values", async () => {
  const sourceNote: LtmNote = {
    id: "scene_source_test",
    type: "scene",
    status: "dormant",
    modes: ["roleplay"],
    scope: {},
    tags: ["source_summary"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      source: {
        text: "Rika and Damo study together in the library.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  };

  let userPayload: any;
  const provider = {
    maxTokensOverrideValue: undefined,
    chatComplete: async (messages: Array<{ role: string; content: string }>) => {
      userPayload = JSON.parse(messages.find((message) => message.role === "user")!.content);
      return {
        content: JSON.stringify({
          summary: "One compact unit",
          units: [
            {
              id: randomUUID(),
              bucket: "relationship_event",
              subjectId: "rika_damo",
              sectionKey: "history",
              text: "Rika and Damo study together in the library.",
              evidence: ["source_note:scene_source_test"],
              confidence: 0.9,
              salience: 0.7,
              status: "active",
              gates: [],
              links: [],
              sourceHash,
            },
          ],
        }),
      };
    },
  } as any;

  await runLongTermMemoryEvidenceUnitExtraction({
    sourceNote,
    sourceText: sourceNote.sections.source!.text,
    existingNotes: [],
    provider,
    model: "test-model",
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });

  assert.equal(userPayload.outputShape.units[0].bucket, "relationship_event");
  assert.equal(userPayload.outputShape.units[0].status, "active");
  assert.deepEqual(userPayload.outputShape.units[0].gates, ["private"]);
  assert.deepEqual(userPayload.allowedBuckets, [
    "character_fact",
    "character_state",
    "relationship_event",
    "relationship_state",
    "relationship_arc",
    "relationship_conflict",
    "world_fact",
    "thread",
    "callback",
    "current_scene",
    "voice",
    "tone",
    "anchor",
    "boundary",
    "preference",
  ]);
  assert(!userPayload.outputShape.units[0].bucket.includes("|"));
  assert(!userPayload.outputShape.units[0].status.includes("|"));
  assert(userPayload.outputShape.units[0].gates.every((gate: string) => !gate.includes("|")));
});

function evidenceUnit(bucket: LtmEvidenceUnit["bucket"], patch: Partial<LtmEvidenceUnit> = {}): LtmEvidenceUnit {
  return ltmEvidenceUnitSchema.parse({
    id: randomUUID(),
    bucket,
    subjectId: "mara",
    sectionKey: "facts",
    text: "Mara senses magic as a hum under her skin.",
    evidence: ["source_note:scene_source_test"],
    confidence: 0.9,
    salience: 0.7,
    status: "active",
    gates: [],
    links: [],
    sourceHash,
    ...patch,
  });
}

test("evidence unit schema rejects invalid bucket and empty evidence", () => {
  assert.equal(
    ltmEvidenceUnitSchema.safeParse({
      id: randomUUID(),
      bucket: "raw_summary",
      subjectId: "mara",
      sectionKey: "facts",
      text: "Mara senses magic.",
      evidence: ["source_note:scene_source_test"],
      confidence: 0.9,
      salience: 0.7,
      status: "active",
      gates: [],
      links: [],
      sourceHash,
    }).success,
    false,
  );
  assert.equal(
    ltmEvidenceUnitSchema.safeParse({
      id: randomUUID(),
      bucket: "character_fact",
      subjectId: "mara",
      sectionKey: "facts",
      text: "Mara senses magic.",
      evidence: [],
      confidence: 0.9,
      salience: 0.7,
      status: "active",
      gates: [],
      links: [],
      sourceHash,
    }).success,
    false,
  );
});

test("source notes are excluded from normal chunks and kept for source audit chunks", () => {
  const sourceNote: LtmNote = {
    id: "scene_source_test",
    type: "scene",
    status: "dormant",
    modes: ["roleplay"],
    scope: {},
    tags: ["source_summary", "chat_summary"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      source: {
        text: "Transcript-like source summary that should not enter normal recall.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  };
  const typedNote: LtmNote = {
    id: "char_mara",
    type: "character",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["typed_memory"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      facts: {
        text: "Mara senses magic as a hum under her skin.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_source_test"],
      },
    },
    version: 1,
  };

  assert.deepEqual(
    chunkNotes([sourceNote, typedNote]).map((chunk) => chunk.noteId),
    ["char_mara"],
  );
  assert.deepEqual(
    chunkNotes([sourceNote, typedNote], { sourceNotesOnly: true }).map((chunk) => chunk.noteId),
    ["scene_source_test"],
  );
});

test("evidence unit compiler maps buckets to typed memory draft mutations", () => {
  const cases: Array<[LtmEvidenceUnit["bucket"], string, string]> = [
    ["character_fact", "char_mara", "character"],
    ["character_state", "char_mara", "character"],
    ["relationship_event", "rel_mara_jules", "relationship"],
    ["relationship_state", "rel_mara_jules", "relationship"],
    ["relationship_arc", "rel_mara_jules", "relationship"],
    ["world_fact", "world_veil", "world"],
    ["thread", "thread_missing_key", "thread"],
    ["callback", "cb_lantern", "callback"],
    ["current_scene", "scene_current_chat", "scene"],
    ["voice", "voice_mara", "voice"],
    ["tone", "tone_chat", "tone"],
    ["anchor", "world_red_thread", "world"],
    ["boundary", "tone_chat", "tone"],
    ["preference", "tone_chat", "tone"],
  ];

  for (const [bucket, expectedNoteId, expectedType] of cases) {
    const unit = evidenceUnit(bucket, {
      subjectId: expectedNoteId.replace(/^(char|rel|world|thread|cb|scene|voice|tone)_/, ""),
      sectionKey: bucket === "anchor" ? "world_anchor" : "facts",
    });
    const response = compileLtmEvidenceUnits({
      units: [unit],
      existingNotes: [],
      scope: {},
      modes: ["roleplay"],
      createdAt: timestamp,
    });
    const mutation = response.mutations[0];
    assert.equal(mutation?.kind, "create_note");
    if (mutation?.kind === "create_note") {
      assert.equal(mutation.note.id, expectedNoteId);
      assert.equal(mutation.note.type, expectedType);
    }
  }
});

test("relationship reducer accumulates events into qualitative current state", () => {
  const reduction = reduceRelationshipEvidenceUnits([
    evidenceUnit("relationship_event", {
      subjectId: "mara_jules",
      sectionKey: "event_001",
      text: "Mara chooses to trust Jules with the hidden key.",
    }),
    evidenceUnit("relationship_event", {
      subjectId: "mara_jules",
      sectionKey: "event_002",
      text: "Jules protects Mara during a tense argument.",
    }),
  ]);

  assert.equal(reduction.facets.trust, "medium");
  assert.equal(reduction.facets.protectiveness, "medium");
  assert.equal(reduction.trajectory, "warming_trust_with_remaining_secrets");
  assert.deepEqual(reduction.supportingEvents, [
    "event_001:source_note:scene_source_test",
    "event_002:source_note:scene_source_test",
  ]);
});

test("current scene evidence units replace current state instead of appending", () => {
  const existing: LtmNote = {
    id: "scene_current_chat",
    type: "scene",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["typed_memory", "current_scene"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      current_state: {
        text: "Mara waits outside the tower.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_old"],
      },
    },
    version: 1,
  };
  const response = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("current_scene", {
        subjectId: "current_chat",
        sectionKey: "current_state",
        text: "Mara and Jules stand inside the tower archive.",
      }),
    ],
    existingNotes: [existing],
    scope: {},
    modes: ["roleplay"],
    createdAt: timestamp,
  });

  assert.equal(response.mutations.length, 1);
  assert.equal(response.mutations[0]?.kind, "update_section");
  if (response.mutations[0]?.kind === "update_section") {
    assert.equal(response.mutations[0].section.text, "Mara and Jules stand inside the tower archive.");
  }
});

test("source extraction drafts can apply typed current scene updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-current-scene-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "dormant",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Mara and Jules stand inside the tower archive.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "scene_current_chat",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory", "current_scene"],
        links: [],
        sections: {
          current_state: {
            text: "Mara waits outside the tower.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_old"],
          },
        },
      },
      { suppressEvent: true },
    );

    const response = compileLtmEvidenceUnits({
      units: [
        evidenceUnit("current_scene", {
          subjectId: "current_chat",
          sectionKey: "current_state",
          text: "Mara and Jules stand inside the tower archive.",
        }),
      ],
      existingNotes: [(await storage.getNote("scene_current_chat"))!],
      scope: {},
      modes: ["roleplay"],
      createdAt: timestamp,
    });
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      userMessage: "Mara and Jules stand inside the tower archive.",
      assistantReply: "",
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test", sourceHash },
      response,
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      rebuildIndexes: false,
    });

    assert.deepEqual(result.appliedMutationIds, response.mutations.map((mutation) => mutation.id));
    const updated = await storage.getNote("scene_current_chat");
    assert.equal(updated?.sections.current_state?.text, "Mara and Jules stand inside the tower archive.");
    assert(updated?.links.some((link) => link.target === "scene_source_test" && link.relation === "extracted_from"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction drafts can create typed current scene notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-current-scene-create-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "dormant",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Mara and Jules stand inside the tower archive.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const response = compileLtmEvidenceUnits({
      units: [
        evidenceUnit("current_scene", {
          subjectId: "current_chat",
          sectionKey: "current_state",
          text: "Mara and Jules stand inside the tower archive.",
        }),
      ],
      existingNotes: [],
      scope: {},
      modes: ["roleplay"],
      createdAt: timestamp,
    });
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      userMessage: "Mara and Jules stand inside the tower archive.",
      assistantReply: "",
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test", sourceHash },
      response,
    });

    await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      rebuildIndexes: false,
    });

    const created = await storage.getNote("scene_current_chat");
    assert.equal(created?.type, "scene");
    assert.deepEqual(created?.tags, ["typed_memory", "current_scene"]);
    assert.equal(created?.sections.current_state?.text, "Mara and Jules stand inside the tower archive.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retrieval excludes source notes by default and prioritizes relationship state before history", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-retrieval-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "dormant",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Raw transcript says Mara trusts Jules at the tower archive.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "rel_mara_jules",
        type: "relationship",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory", "relationship_memory"],
        links: [],
        sections: {
          history: {
            text: "- Mara trusted Jules with the key at the tower archive.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_test"],
          },
          state: {
            text: "Current relationship state: trust: medium; tension: low. Trajectory: warming_trust_with_remaining_secrets.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_test"],
          },
          arc: {
            text: "Their relationship is warming through repeated acts of trust.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    await rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: async (texts) => texts.map(() => []),
    });

    const normal = await retrieveLongTermMemory({
      root,
      queryText: "Mara trusts Jules tower archive",
      maxChunks: 4,
      maxTokens: 1000,
      localEmbedder: async (texts) => texts.map(() => []),
    });
    assert.deepEqual(
      normal.chunks.map((chunk) => chunk.chunk.id),
      ["rel_mara_jules::state", "rel_mara_jules::arc", "rel_mara_jules::history"],
    );

    const audit = await retrieveLongTermMemory({
      root,
      queryText: "Mara trusts Jules tower archive",
      includeSourceNotes: true,
      maxChunks: 4,
      maxTokens: 1000,
      localEmbedder: async (texts) => texts.map(() => []),
    });
    assert.deepEqual(
      audit.chunks.map((chunk) => chunk.chunk.noteId),
      ["scene_source_test"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
