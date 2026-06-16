import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LtmDraftMutation, LtmEvidenceUnit, LtmNote } from "@marinara-engine/shared";
import {
  ltmEvidenceUnitSchema,
  ltmPoliciesConfigSchema,
  ltmScopeSchema,
} from "../../../../../shared/src/schemas/long-term-memory.schema.js";
import { chunkNotes } from "../chunking.js";
import { buildLtmMetadataIndex } from "../metadata-index.js";
import { compileLtmEvidenceUnits } from "../evidence-unit-compiler.js";
import { applyLtmBudget } from "../budget.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import { checkLongTermMemoryIntegrity } from "../maintenance.js";
import { getLongTermMemoryDirectories } from "../paths.js";
import { formatLongTermMemoryBlock, injectLongTermMemoryPromptBlock } from "../prompt.js";
import {
  applyGenerationLongTermMemoryInjection,
  buildGenerationLongTermMemoryPlan,
} from "../generation-injection.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import {
  applyLongTermMemoryDraft,
  isLowRiskSourceExtractionMutation,
} from "../reconciliation.js";
import { retrieveLongTermMemory } from "../retrieval.js";
import { LongTermMemoryStorage } from "../storage.js";
import {
  compileEvidenceUnitExtraction,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  runLongTermMemoryEvidenceUnitExtraction,
  sourceHashForEvidenceUnitExtraction,
} from "../evidence-unit-extraction.js";
import { getLtmExtractionConfig, updateLtmExtractionConfig } from "../extraction-config.js";
import { extractLongTermMemoryFromSourceNote } from "../source-extraction.js";
import { applyLtmScopeLinksToDerivedNotes } from "../scope-links.js";
import type { LtmBudgetedChunk } from "../budget.js";
import type { ChatMessage } from "../../llm/base-provider.js";
import type { RetrieveLongTermMemoryInput } from "../retrieval.js";
import { assemblePrompt, type AssemblerInput } from "../../prompt/index.js";

const timestamp = "2026-06-10T00:00:00.000Z";
const sourceHash = "a".repeat(64);

test("long-term memory chunks keep prompt text free of index labels", () => {
  const chunks = chunkNotes([
    {
      id: "sample_memory_note",
      type: "world",
      status: "active",
      modes: ["conversation"],
      scope: {
        chatId: "sample_chat",
        groupId: "sample_group",
        characterIds: ["sample_character"],
      },
      tags: ["typed_memory"],
      links: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      sections: {
        facts: {
          text: "A sample instruction remains available for later retrieval.",
          updatedAt: timestamp,
        },
      },
    },
  ]);

  assert.equal(chunks[0]?.text, "A sample instruction remains available for later retrieval.");
  assert.doesNotMatch(chunks[0]?.text ?? "", /note:|type:|section:|status:|chat:|group:|characters:/);
});

test("long-term memory chunks strip legacy inline evidence labels", () => {
  const chunks = chunkNotes([
    {
      id: "sample_memory_note",
      type: "relationship",
      status: "active",
      modes: ["roleplay"],
      scope: { chatId: "sample_chat" },
      tags: ["typed_memory"],
      links: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      sections: {
        history: {
          text: "- Rika softened after the bridge argument. [evidence:source_note:source_import_chat_rika_rp_f3c3957d08,chat:v5bijiUY6rB_cVcQ7Q_DT]",
          updatedAt: timestamp,
          evidence: ["source_note:source_import_chat_rika_rp_f3c3957d08", "chat:v5bijiUY6rB_cVcQ7Q_DT"],
        },
      },
    },
  ]);

  assert.equal(chunks[0]?.text, "- Rika softened after the bridge argument.");
  assert.doesNotMatch(chunks[0]?.text ?? "", /evidence:|source_note:|chat:/);
});

test("long-term memory prompt injection contains prose only", () => {
  const block = formatLongTermMemoryBlock([
    {
      chunk: {
        id: "sample_memory_note::social_habits",
        noteId: "sample_memory_note",
        sectionKey: "social_habits",
        text: "A sample instruction remains available for later retrieval.\n\n[note:sample_memory_note type:tone section:social_habits status:active tags:typed_memory chat:sample_chat group:sample_group characters:sample_character]",
        noteType: "tone",
        status: "active",
        scope: {},
        tags: ["typed_memory"],
        updatedAt: timestamp,
        sourceHash,
      },
      score: 1,
      reasons: ["vector", "bm25", "graph:sample_memory_note:2"],
      lanes: ["vector", "bm25", "graph"],
      tier: 1,
      estimatedTokens: 42,
    } satisfies LtmBudgetedChunk,
  ]);

  assert.equal(block, "[TONE]\nA sample instruction remains available for later retrieval.");
  assert.doesNotMatch(block, /<long_term_memory>|tier:|reasons:|note:|section:|chat:|group:|characters:|graph:/);
});

test("long-term memory prompt injection inserts a system message before chat history", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "System prelude", contextKind: "prompt" as const },
    { role: "user", content: "Where did Mara leave the key?" },
    { role: "assistant", content: "I think it was near the archive." },
  ];

  const result = injectLongTermMemoryPromptBlock(messages, [
    {
      chunk: {
        id: "world_archive_key::facts",
        noteId: "world_archive_key",
        sectionKey: "facts",
        text: "Mara hid the archive key behind the clock in the tower foyer.",
        noteType: "world",
        status: "active",
        scope: {},
        tags: ["typed_memory"],
        updatedAt: timestamp,
        sourceHash,
      },
      score: 1,
      reasons: ["bm25"],
      lanes: ["bm25"],
      tier: 1,
      estimatedTokens: 16,
    } satisfies LtmBudgetedChunk,
  ]);

  assert.equal(result.inserted, true);
  assert.equal(result.insertAt, 1);
  assert.equal(result.block, "[WORLD]\nMara hid the archive key behind the clock in the tower foyer.");
  assert.deepEqual(messages.map((message) => message.role), ["system", "system", "user", "assistant"]);
  assert.equal(messages[1]?.contextKind, "injection");
  assert.equal(messages[1]?.content, result.block);
});

test("generation long-term memory uses chat retrieval settings and injects after prompt setup before history", async () => {
  const finalMessages: ChatMessage[] = [
    { role: "system", content: "<persona>\nMara persona setup\n</persona>", contextKind: "prompt" as const },
    { role: "system", content: "<output_format>\nReply richly.\n</output_format>", contextKind: "prompt" as const },
    { role: "user", content: "Where is the archive key?", contextKind: "history" as const },
    { role: "assistant", content: "I need to think about Mara's habits.", contextKind: "history" as const },
  ];

  const plan = buildGenerationLongTermMemoryPlan({
    chatId: "chat_test",
    chatMode: "roleplay",
    groupId: "group_test",
    promptCharacterIds: ["char_mara"],
    activeCharacterNames: ["Mara"],
    inputMessages: [
      { role: "assistant", content: "Earlier archive discussion." },
      { role: "user", content: "Where is the archive key?" },
      { role: "assistant", content: "I need to think about Mara's habits." },
      { role: "user", content: "Did she hide it near the tower?" },
      { role: "assistant", content: "Maybe." },
      { role: "user", content: "Check your memory." },
    ],
    chatMeta: {
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 99999,
      longTermMemoryMaxChunks: 999,
      longTermMemoryScoreThreshold: 2,
      longTermMemoryRecallStyle: "story",
      longTermMemoryRecallContextMessages: 99,
      longTermMemoryIncludeResolved: true,
      longTermMemoryDebug: true,
    },
    userMessage: "Check your memory.",
    generationGuide: "Focus on emotional continuity.",
    lorebookGenerationTriggers: ["chat", "roleplay", "archive"],
    requestDebug: false,
    mentionedCharacterNames: ["Jules"],
  });

  const captured = { current: null as RetrieveLongTermMemoryInput | null };
  const result = await applyGenerationLongTermMemoryInjection({
    plan,
    finalMessages,
    retrieveLongTermMemoryFn: async (input) => {
      captured.current = input;
      return {
        chunks: [
          {
            chunk: {
              id: "world_archive_key::facts",
              noteId: "world_archive_key",
              sectionKey: "facts",
              text: "Mara hid the archive key behind the clock in the tower foyer.",
              noteType: "world",
              status: "active",
              scope: {},
              tags: ["typed_memory"],
              updatedAt: timestamp,
              sourceHash,
            },
            score: 1,
            reasons: ["bm25"],
            lanes: ["bm25"],
            tier: 1,
            estimatedTokens: 16,
          },
        ],
        usedTokens: 16,
        maxTokens: 16_384,
        embeddingsAvailable: false,
        warnings: [],
      };
    },
  });

  if (!captured.current) {
    throw new Error("Expected retrieval input to be captured");
  }
  const retrievalInput = captured.current;
  assert.equal(retrievalInput.maxTokens, 16_384);
  assert.equal(retrievalInput.maxChunks, 100);
  assert.equal(retrievalInput.minScore, 1);
  assert.equal(retrievalInput.includeResolved, true);
  assert.equal(retrievalInput.debug, true);
  assert.equal(retrievalInput.explain, true);
  assert.equal(retrievalInput.semanticWeight, 0.45);
  assert.equal(retrievalInput.lexicalWeight, 0.25);
  assert.equal(retrievalInput.graphWeight, 0.35);
  assert.equal(retrievalInput.metadataWeight, 0.8);
  assert.equal(retrievalInput.scope?.chatId, "chat_test");
  assert.deepEqual(retrievalInput.scope?.chatIds, ["chat_test"]);
  assert.equal(retrievalInput.scope?.groupId, "group_test");
  assert.deepEqual(retrievalInput.scope?.characterIds, ["char_mara"]);
  assert.deepEqual(retrievalInput.characterIds, ["char_mara"]);
  assert.deepEqual(retrievalInput.mentionedCharacterNames, ["Mara", "Jules"]);
  assert.deepEqual(retrievalInput.recentMessages, [
    "Earlier archive discussion.",
    "Where is the archive key?",
    "I need to think about Mara's habits.",
    "Did she hide it near the tower?",
    "Maybe.",
    "Check your memory.",
  ]);
  assert.match(retrievalInput.queryText ?? "", /Active characters: Mara/);
  assert.match(retrievalInput.queryText ?? "", /Generation triggers: chat, roleplay, archive/);
  assert.match(retrievalInput.queryText ?? "", /Generation guide:\nFocus on emotional continuity\./);
  assert.equal(result.injection.inserted, true);
  assert.equal(result.injection.insertAt, 2);
  assert.equal(result.injection.insertedBeforeRole, "user");
  assert.deepEqual(finalMessages.map((message) => message.role), ["system", "system", "system", "user", "assistant"]);
  assert.equal(finalMessages[2]?.contextKind, "injection");
  assert.equal(finalMessages[2]?.content, "[WORLD]\nMara hid the archive key behind the clock in the tower foyer.");
});

test("assembler injects long-term memory before chat summary fallback to avoid duplicate context", async () => {
  const input = {
    db: {} as AssemblerInput["db"],
    preset: {
      id: "preset_test",
      name: "Test Preset",
      description: "",
      sectionOrder: JSON.stringify(["system_section", "history_section"]),
      groupOrder: JSON.stringify([]),
      variableGroups: JSON.stringify([]),
      variableValues: JSON.stringify({}),
      parameters: JSON.stringify({}),
      wrapFormat: "xml",
      defaultChoices: JSON.stringify({}),
      isDefault: "false",
      author: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    } as AssemblerInput["preset"],
    sections: [
      {
        id: "system_section",
        presetId: "preset_test",
        identifier: "system",
        name: "System",
        content: "<persona>\nBase system prompt\n</persona>",
        role: "system",
        enabled: "true",
        isMarker: "false",
        groupId: null,
        markerConfig: null,
        injectionPosition: "ordered",
        injectionDepth: 0,
        injectionOrder: 100,
        forbidOverrides: "false",
      },
      {
        id: "history_section",
        presetId: "preset_test",
        identifier: "history",
        name: "History",
        content: "",
        role: "user",
        enabled: "true",
        isMarker: "true",
        groupId: null,
        markerConfig: JSON.stringify({ type: "chat_history" }),
        injectionPosition: "ordered",
        injectionDepth: 0,
        injectionOrder: 100,
        forbidOverrides: "false",
      },
    ] as AssemblerInput["sections"],
    groups: [],
    choiceBlocks: [],
    chatChoices: {},
    chatId: "chat_test",
    characterIds: [],
    personaId: null,
    personaName: "User",
    personaDescription: "",
    personaFields: {},
    chatMessages: [
      { role: "user", content: "Where is the archive key?" },
      { role: "assistant", content: "Let me think." },
    ],
    lorebookScanMessages: [],
    chatSummary: "Summary says Mara hid the archive key behind the clock.",
    longTermMemoryBlock: "[WORLD]\nMara hid the archive key behind the clock in the tower foyer.",
    suppressChatSummary: true,
    enableAgents: false,
    activeAgentIds: [],
    activeLorebookIds: [],
    excludedLorebookIds: [],
    excludedLorebookSourceAgentIds: [],
    generationTriggers: ["chat"],
  } satisfies AssemblerInput & {
    longTermMemoryBlock: string;
    suppressChatSummary: boolean;
  };

  const result = await assemblePrompt(input);
  const systemPrompt = result.messages.find((message) => message.role === "system")?.content ?? "";

  assert.match(systemPrompt, /\[WORLD\]\nMara hid the archive key behind the clock in the tower foyer\./);
  assert.doesNotMatch(systemPrompt, /Summary says Mara hid the archive key behind the clock/);
  assert.deepEqual(result.messages.map((message) => message.role), ["system", "user", "assistant"]);
});

test("long-term memory budget uses prompt-clean text for legacy chunks", () => {
  const chunk = {
    id: "sample_memory_note::social_habits",
    noteId: "sample_memory_note",
    sectionKey: "social_habits",
    text: `Sample memory.\n\n[note:sample_memory_note type:tone section:social_habits status:active tags:${"typed_memory,".repeat(80)} chat:sample_chat group:sample_group characters:sample_character]`,
    noteType: "tone",
    status: "active",
    scope: {},
    tags: ["typed_memory"],
    updatedAt: timestamp,
    sourceHash,
  } satisfies LtmBudgetedChunk["chunk"];

  const result = applyLtmBudget(
    [{ chunkId: chunk.id, score: 1, reasons: ["vector"], lanes: ["vector"] }],
    new Map([[chunk.id, chunk]]),
    { maxChunks: 1, maxTokens: 8 },
  );

  assert.equal(result.chunks.length, 1);
  assert.equal(result.usedTokens, 4);
  assert.equal(result.chunks[0]?.estimatedTokens, 4);
});

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

function threadCreateMutation(
  text = "When the lantern is found, remember the old promise.",
): Extract<LtmDraftMutation, { kind: "create_note" }> {
  return {
    id: randomUUID(),
    kind: "create_note",
    risk: "low",
    confidence: 0.95,
    summary: "Create thread",
    evidence: ["source_note:scene_source_test"],
    note: {
      id: "thread_lantern_promise",
      type: "thread",
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
        status: "active",
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
    assert.equal(isLowRiskSourceExtractionMutation(mutation), false);

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
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

test("source extraction low-risk policy blocks conflicted thread auto-apply", () => {
  assert.equal(isLowRiskSourceExtractionMutation(threadCreateMutation()), true);
  const conflicted = threadCreateMutation();
  conflicted.note.conflicts = [
    {
      field: "sections.setup",
      existing: "When the lantern is found, remember the old promise.",
      proposed: "When the lantern is found, reveal Mira's private secret.",
      resolution: "pending",
      policy: "manual_review",
    },
  ];
  assert.equal(isLowRiskSourceExtractionMutation(conflicted), false);
});

test("source extraction auto-apply leaves archived resolved memory status pending with content update", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-resolved-status-pending-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "The lantern hum paid off when it revealed the archive door.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "thread_lantern",
        type: "thread",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          setup: {
            text: "The lantern hum should pay off later.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_old"],
          },
        },
      },
      { suppressEvent: true },
    );

    const response = compileLtmEvidenceUnits({
      units: [
        evidenceUnit("thread", {
          subjectId: "lantern",
          sectionKey: "setup",
          text: "The lantern hum paid off when it revealed the archive door.",
          status: "resolved",
          confidence: 0.95,
        }),
      ],
      existingNotes: [(await storage.getNote("thread_lantern"))!],
      scope: {},
      modes: ["roleplay"],
      createdAt: timestamp,
    });
    const statusMutation = response.mutations.find((mutation) => mutation.kind === "set_status");
    assert(statusMutation);
    assert.equal(statusMutation.kind === "set_status" ? statusMutation.status : undefined, "archived");
    assert.equal(isLowRiskSourceExtractionMutation(statusMutation), false);

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test" },
      response,
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      autoApplyLowRiskOnly: true,
      rebuildIndexes: false,
    });

    assert.deepEqual(result.appliedMutationIds, []);
    assert.deepEqual(new Set(result.skippedMutationIds), new Set(response.mutations.map((mutation) => mutation.id)));
    assert.equal(result.draft.status, "pending");

    const thread = await storage.getNote("thread_lantern");
    assert.equal(thread?.status, "active");
    assert.equal(thread?.sections.setup?.text, "The lantern hum should pay off later.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction auto-apply skips links to pending timeline notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-pending-timeline-link-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Mara confronts Jules in the archive.",
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
          state: {
            text: "Mara and Jules are guarded allies.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const createTimelineMutation: Extract<LtmDraftMutation, { kind: "create_note" }> = {
      id: randomUUID(),
      kind: "create_note",
      risk: "low",
      confidence: 0.95,
      summary: "Create timeline event",
      evidence: ["source_note:scene_source_test"],
      note: {
        id: "timeline_archive_confrontation",
        type: "timeline_event",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory", "timeline_event"],
        links: [],
        sections: {
          event: {
            text: "Mara confronts Jules in the archive.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_test"],
          },
        },
      },
    };
    const addTimelineLinkMutation: Extract<LtmDraftMutation, { kind: "add_link" }> = {
      id: randomUUID(),
      kind: "add_link",
      risk: "low",
      confidence: 0.95,
      summary: "Link relationship to timeline event",
      evidence: ["source_note:scene_source_test"],
      noteId: "rel_mara_jules",
      link: { target: "timeline_archive_confrontation", relation: "occurred_in" },
    };

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test" },
      response: {
        summary: "Timeline link draft",
        mutations: [createTimelineMutation, addTimelineLinkMutation],
      },
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      autoApplyLowRiskOnly: true,
      rebuildIndexes: false,
    });

    assert.deepEqual(result.appliedMutationIds, []);
    assert.deepEqual(
      new Set(result.skippedMutationIds),
      new Set([createTimelineMutation.id, addTimelineLinkMutation.id]),
    );
    assert.equal(result.draft.status, "pending");
    assert.equal(await storage.getNote("timeline_archive_confrontation"), null);

    const relationship = await storage.getNote("rel_mara_jules");
    assert(
      !relationship?.links.some(
        (link) => link.target === "timeline_archive_confrontation" && link.relation === "occurred_in",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("policy config hides unenforced lifecycle knobs while accepting legacy files", () => {
  const parsed = ltmPoliciesConfigSchema.parse({
    version: 1,
    policies: [
      {
        type: "thread",
        injection: "on_relevance",
        sectionsAlways: [],
        sectionsOnRelevance: ["*"],
        updateBehavior: "cumulative_until_resolved",
        reconcileEvery: 5,
        summarization: "compact_when_resolved",
        pinAgainstSummarization: true,
        autoArchiveOn: "status=resolved",
      },
    ],
  });

  assert.deepEqual(parsed, {
    version: 1,
    policies: [
      {
        type: "thread",
        injection: "on_relevance",
        sectionsAlways: [],
        sectionsOnRelevance: ["*"],
      },
    ],
  });
});

test("ltm scope ignores removed legacy scope keys", () => {
  assert.deepEqual(ltmScopeSchema.parse({ chatId: "chat_legacy" }), { chatId: "chat_legacy" });
  assert.deepEqual(ltmScopeSchema.parse({ chatIds: ["chat_a", "chat_b"] }), {
    chatIds: ["chat_a", "chat_b"],
  });
  assert.throws(() => ltmScopeSchema.parse({ universe: "legacy_universe" }), /unrecognized_keys/i);
  assert.throws(() => ltmScopeSchema.parse({ rpId: "legacy_rp" }), /unrecognized_keys/i);
});

test("ltm metadata index buckets legacy chatId and every chatIds entry", () => {
  const chunks = chunkNotes([
    {
      id: "scene_scope_index",
      type: "scene",
      status: "active",
      modes: ["roleplay"],
      scope: { chatId: "chat_legacy", chatIds: ["chat_a", "chat_b"], characterIds: ["char_mara"] },
      tags: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      links: [],
      sections: {
        summary: {
          text: "Mara remembers the sapphire clue.",
          updatedAt: timestamp,
        },
      },
      version: 1,
    },
  ]);
  const index = buildLtmMetadataIndex(chunks);

  assert.deepEqual(index.byScope.chatId.chat_legacy, ["scene_scope_index::summary"]);
  assert.deepEqual(index.byScope.chatId.chat_a, ["scene_scope_index::summary"]);
  assert.deepEqual(index.byScope.chatId.chat_b, ["scene_scope_index::summary"]);
  assert.deepEqual(index.byScope.characterId.char_mara, ["scene_scope_index::summary"]);
});

test("ltm retrieval matches any overlapping chatIds entry and keeps legacy chatId working", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-chatids-retrieval-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_sapphire_clue",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_legacy", chatIds: ["chat_a", "chat_b"] },
        tags: [],
        links: [],
        sections: {
          summary: {
            text: "The sapphire clue belongs to this shared conversation.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async () => [] });

    const fromArrayScope = await retrieveLongTermMemory({
      root,
      queryText: "sapphire clue",
      scope: { chatIds: ["chat_b"] },
      maxChunks: 5,
      localEmbedder: async () => [],
    });
    assert.deepEqual(
      fromArrayScope.chunks.map((item) => item.chunk.noteId),
      ["scene_sapphire_clue"],
    );

    const fromLegacyScope = await retrieveLongTermMemory({
      root,
      queryText: "sapphire clue",
      scope: { chatId: "chat_legacy" },
      maxChunks: 5,
      localEmbedder: async () => [],
    });
    assert.deepEqual(
      fromLegacyScope.chunks.map((item) => item.chunk.noteId),
      ["scene_sapphire_clue"],
    );

    const fromWrongChat = await retrieveLongTermMemory({
      root,
      queryText: "sapphire clue",
      scope: { chatIds: ["chat_other"] },
      maxChunks: 5,
      localEmbedder: async () => [],
    });
    assert.deepEqual(fromWrongChat.chunks, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derived scope apply merges only extracted_from children", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-derived-scope-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_links",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_source" },
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Source summary.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "thread_derived_scope",
        type: "thread",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_old", characterIds: ["char_old"] },
        tags: [],
        links: [{ target: "scene_source_links", relation: "extracted_from" }],
        sections: {
          setup: {
            text: "Derived thread.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "thread_unrelated_scope",
        type: "thread",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_old" },
        tags: [],
        links: [{ target: "scene_source_links", relation: "mentioned_in" }],
        sections: {
          setup: {
            text: "Unrelated thread.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    const result = await applyLtmScopeLinksToDerivedNotes(
      "scene_source_links",
      { chatIds: ["chat_new"], characterIds: ["char_new"] },
      { root, rebuildIndexes: false },
    );
    assert.deepEqual(result?.affectedNoteIds, ["thread_derived_scope"]);
    assert.equal(result?.count, 1);

    const derived = await storage.getNote("thread_derived_scope");
    assert.equal(derived?.scope.chatId, "chat_old");
    assert.deepEqual(derived?.scope.chatIds, ["chat_old", "chat_new"]);
    assert.deepEqual(derived?.scope.characterIds, ["char_old", "char_new"]);

    const unrelated = await storage.getNote("thread_unrelated_scope");
    assert.deepEqual(unrelated?.scope.chatIds, ["chat_old"]);
    assert.deepEqual(unrelated?.scope.characterIds, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ltm extraction config reads defaults, writes overrides, and resets", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-extraction-config-"));
  try {
    const defaults = await getLtmExtractionConfig(root);
    assert.equal(defaults.version, 1);
    assert.equal(defaults.reasoningEffort, "low");
    assert.equal(defaults.verbosity, "low");
    assert.equal(defaults.maxOutputTokens, DEFAULT_LTM_EXTRACTION_MAX_TOKENS);
    assert.equal(defaults.maxSourceChars, 24_000);
    assert.deepEqual(defaults.promptTemplates, []);
    assert.equal(defaults.activePromptTemplateId, null);

    const updated = await updateLtmExtractionConfig(
      {
        extraInstruction: "Prefer threads when source text sets up later payoff.",
        reasoningEffort: "medium",
        verbosity: "high",
        maxOutputTokens: 4096,
        temperature: 0.25,
        maxSourceChars: 12_000,
        existingNoteMaxChunks: 8,
        existingNoteMaxTokens: 1600,
        promptTemplates: [
          {
            id: "compact",
            name: "Compact",
            prompt: "Use a compact extraction prompt.",
          },
        ],
        activePromptTemplateId: "compact",
      },
      root,
    );
    assert.equal(updated.extraInstruction, "Prefer threads when source text sets up later payoff.");
    assert.equal(updated.reasoningEffort, "medium");
    assert.equal(updated.verbosity, "high");
    assert.equal(updated.maxOutputTokens, 4096);
    assert.equal(updated.temperature, 0.25);
    assert.equal(updated.maxSourceChars, 12_000);
    assert.equal(updated.existingNoteMaxChunks, 8);
    assert.equal(updated.existingNoteMaxTokens, 1600);
    assert.equal(updated.systemPrompt, "Use a compact extraction prompt.");
    assert.equal(updated.promptTemplates.length, 1);
    assert.equal(updated.activePromptTemplateId, "compact");

    const dirs = getLongTermMemoryDirectories(root);
    const persisted = JSON.parse(await readFile(join(dirs.config, "extraction.json"), "utf8"));
    assert.equal(persisted.systemPrompt, undefined);
    assert.equal(persisted.extraInstruction, "Prefer threads when source text sets up later payoff.");
    assert.deepEqual(persisted.promptTemplates, [
      {
        id: "compact",
        name: "Compact",
        prompt: "Use a compact extraction prompt.",
      },
    ]);
    assert.equal(persisted.activePromptTemplateId, "compact");

    const reset = await updateLtmExtractionConfig({}, root);
    assert.equal(reset.reasoningEffort, "low");
    assert.equal(reset.verbosity, "low");
    assert.equal(reset.maxOutputTokens, DEFAULT_LTM_EXTRACTION_MAX_TOKENS);
    assert.equal(reset.extraInstruction, "");
    assert.equal(reset.activePromptTemplateId, null);
    assert.deepEqual(reset.promptTemplates, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source note extraction applies saved extraction config to llm request", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-extraction-config-wire-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const sourceText = "Mara hears the lantern hum again while Jules hides the tower key for later payoff. ".repeat(20);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: sourceText,
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );
    await updateLtmExtractionConfig(
      {
        systemPrompt: "Fallback extraction prompt.",
        extraInstruction: "Treat lantern hum as a thread.",
        reasoningEffort: "high",
        verbosity: "medium",
        maxOutputTokens: 1024,
        temperature: 0.5,
        maxSourceChars: 1000,
        maxExistingNoteChars: 1000,
        promptTemplates: [
          {
            id: "template_compact",
            name: "Compact test template",
            prompt: "Return JSON with compact test units only.",
          },
        ],
        activePromptTemplateId: "template_compact",
      },
      root,
    );

    let messages: Array<{ role: string; content: string }> = [];
    let chatOptions: any;
    const provider = {
      maxTokensOverrideValue: 9999,
      chatComplete: async (nextMessages: Array<{ role: string; content: string }>, options: any) => {
        messages = nextMessages;
        chatOptions = options;
        return {
          content: JSON.stringify({ summary: "No units", units: [] }),
        };
      },
    } as any;

    await extractLongTermMemoryFromSourceNote({
      noteId: "scene_source_test",
      provider,
      model: "test-model",
      root,
      operationId: randomUUID(),
    });

    const userPayload = JSON.parse(messages.find((message) => message.role === "user")!.content);
    assert.equal(
      messages.find((message) => message.role === "system")!.content,
      "Return JSON with compact test units only.",
    );
    assert.equal(userPayload.extraInstruction, "Treat lantern hum as a thread.");
    assert.equal(userPayload.sourceText, sourceText.slice(0, 1000));
    assert.equal(chatOptions.maxTokens, 1024);
    assert.equal(chatOptions.temperature, 0.5);
    assert.equal(chatOptions.reasoningEffort, "high");
    assert.equal(chatOptions.verbosity, "medium");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source note extraction includes relevant typed notes from other source notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-source-reimport-filter-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const sourceText = "Kiseki Academy floats above the old city and keeps moonlit archives.";
    await storage.createNote(
      {
        id: "scene_source_original",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: sourceText,
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "scene_source_reimport",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: sourceText,
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "world_kiseki_academy",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [{ target: "scene_source_original", relation: "extracted_from" }],
        sections: {
          facts: {
            text: "Kiseki Academy is a floating school with moonlit archives.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_original"],
          },
        },
      },
      { suppressEvent: true },
    );
    await rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: async (texts) => texts.map(() => [1]),
    });

    let messages: Array<{ role: string; content: string }> = [];
    const provider = {
      maxTokensOverrideValue: undefined,
      chatComplete: async (nextMessages: Array<{ role: string; content: string }>) => {
        messages = nextMessages;
        return { content: JSON.stringify({ summary: "No units", units: [] }) };
      },
    } as any;

    await extractLongTermMemoryFromSourceNote({
      noteId: "scene_source_reimport",
      provider,
      model: "test-model",
      root,
      operationId: randomUUID(),
      embeddingSource: {
        label: "test",
        embed: async (texts) => texts.map(() => [1]),
      },
    });

    const userPayload = JSON.parse(messages.find((message) => message.role === "user")!.content);
    assert.match(userPayload.existingTypedNotes, /id: world_kiseki_academy/);
    assert.match(userPayload.existingTypedNotes, /Kiseki Academy is a floating school with moonlit archives/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence unit extraction normalizes model-owned ids and source hashes", async () => {
  const sourceNote: LtmNote = {
    id: "scene_source_test",
    type: "scene",
    status: "active",
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
            links: [],
            sourceHash,
          },
          {
            id: "",
            bucket: "thread",
            subjectId: "lantern_hum",
            sectionKey: "setup",
            text: "Lantern hum should pay off later.",
            evidence: ["source_note:scene_source_test"],
            confidence: 0.88,
            salience: 0.66,
            status: "active",
            links: [],
            sourceHash: "exact supplied sourceHash",
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

  assert.equal(result.response.units.length, 2);
  for (const unit of result.response.units) {
    assert.match(unit.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(unit.sourceHash, sourceHash);
  }
});

test("evidence unit extraction prompt uses a non-copyable response contract", async () => {
  const sourceNote: LtmNote = {
    id: "scene_source_test",
    type: "scene",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["source_summary"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      source: {
        text: "Alex and Casey study together in the library.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  };

  let userPayload: any;
  let chatOptions: any;
  const provider = {
    maxTokensOverrideValue: undefined,
    chatComplete: async (messages: Array<{ role: string; content: string }>, options: any) => {
      userPayload = JSON.parse(messages.find((message) => message.role === "user")!.content);
      chatOptions = options;
      return {
        content: JSON.stringify({
          summary: "One compact unit",
          units: [
            {
              id: randomUUID(),
              bucket: "relationship_event",
              subjectId: "rika_damo",
              sectionKey: "history",
              text: "Alex and Casey study together in the library.",
              evidence: ["source_note:scene_source_test"],
              confidence: 0.9,
              salience: 0.7,
              status: "active",
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

  assert.equal(userPayload.outputShape, undefined);
  assert.deepEqual(userPayload.responseContract, {
    summary: "string, short",
    units: "array of 0..40 evidence unit objects",
  });
  assert.equal(userPayload.unitFields.bucket, "one allowedBuckets value");
  assert.equal(userPayload.unitFields.links, "real links only, otherwise []");
  assert.equal(userPayload.unitFields.sourceHash, sourceHash);
  assert.deepEqual(userPayload.bucketScanOrder.slice(0, 4), [
    "timeline_event",
    "relationship_event",
    "relationship_state",
    "relationship_conflict",
  ]);
  assert.deepEqual(userPayload.allowedTimelineRelations, [
    "occurred_in",
    "triggered_by",
    "resolved_in",
    "evidenced_by",
  ]);
  assert.deepEqual(userPayload.requiredEvidence, ["source_note:scene_source_test", "chat:chat_test"]);
  assert.deepEqual(userPayload.allowedBuckets, [
    "timeline_event",
    "character_fact",
    "character_state",
    "relationship_event",
    "relationship_state",
    "relationship_conflict",
    "world_fact",
    "thread",
    "tone",
    "anchor",
  ]);
  const payloadJson = JSON.stringify(userPayload);
  assert(!payloadJson.includes("relationship_arc"));
  assert(!payloadJson.includes("current_scene"));
  assert(!payloadJson.includes("boundary"));
  assert(!payloadJson.includes("preference"));
  assert(!payloadJson.includes("550e8400-e29b-41d4-a716-446655440000"));
  assert(!payloadJson.includes("lowercase_snake_case_scope_id"));
  assert(!payloadJson.includes("target_note_id"));
  assert(!payloadJson.includes("optional note for deterministic compiler"));
  assert.equal(chatOptions.maxTokens, DEFAULT_LTM_EXTRACTION_MAX_TOKENS);
  assert.equal(chatOptions.reasoningEffort, "low");
  assert.equal(chatOptions.verbosity, "low");
  assert.equal(chatOptions.stream, true);
});

test("evidence unit extraction accepts and compiles multiple typed buckets", async () => {
  const sourceNote: LtmNote = {
    id: "scene_source_test",
    type: "scene",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["source_summary"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      source: {
        text: [
          "Mara trusts Jules with the tower key.",
          "The lantern hum should pay off later.",
          "Arken forbids skyglass inside the city walls.",
        ].join(" "),
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
        summary: "Three compact units across relationship, thread, and world buckets",
        units: [
          {
            id: randomUUID(),
            bucket: "relationship_event",
            subjectId: "mara_jules",
            sectionKey: "history",
            text: "Mara trusts Jules with the tower key.",
            evidence: ["source_note:scene_source_test"],
            confidence: 0.92,
            salience: 0.75,
            status: "active",
            links: [],
            sourceHash,
          },
          {
            id: randomUUID(),
            bucket: "thread",
            subjectId: "lantern_hum",
            sectionKey: "setup",
            text: "The lantern hum should pay off later.",
            evidence: ["source_note:scene_source_test"],
            confidence: 0.86,
            salience: 0.7,
            status: "active",
            links: [],
            sourceHash,
          },
          {
            id: randomUUID(),
            bucket: "world_fact",
            subjectId: "arken",
            sectionKey: "laws",
            text: "Arken forbids skyglass inside the city walls.",
            evidence: ["source_note:scene_source_test"],
            confidence: 0.9,
            salience: 0.65,
            status: "active",
            links: [],
            sourceHash,
          },
        ],
      }),
    }),
  } as any;

  const unitResponse = await runLongTermMemoryEvidenceUnitExtraction({
    sourceNote,
    sourceText: sourceNote.sections.source!.text,
    existingNotes: [],
    provider,
    model: "test-model",
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });

  assert.equal(unitResponse.response.units.length, 3);
  for (const unit of unitResponse.response.units) {
    assert.equal(ltmEvidenceUnitSchema.safeParse(unit).success, true);
  }

  const compiled = compileEvidenceUnitExtraction({
    unitResponse: unitResponse.response,
    totalCandidates: unitResponse.totalCandidates,
    parserDroppedCandidates: unitResponse.droppedCandidates,
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });
  assert.deepEqual(
    compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );

  const createdTypes = compiled.compiledResponse.mutations.flatMap((mutation) =>
    mutation.kind === "create_note" ? [mutation.note.type] : [],
  );
  assert.deepEqual(new Set(createdTypes), new Set(["relationship", "thread", "world"]));
});

test("evidence unit extraction recovers a truncated json response", async () => {
  const sourceNote: LtmNote = {
    id: "scene_source_test",
    type: "scene",
    status: "active",
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
      content:
        `{"summary":"One compact unit","units":[{"id":"${randomUUID()}","bucket":"character_fact","subjectId":"mara","sectionKey":"facts","text":"Mara keeps old promises.","evidence":["source_note:scene_source_test"],"confidence":0.9,"salience":0.7,"status":"active","links":[],"sourceHash":"${sourceHash}"}`,
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

  assert.equal(result.totalCandidates, 1);
  assert.deepEqual(result.droppedCandidates, []);
  assert.equal(result.response.summary, "One compact unit");
  assert.equal(result.response.units.length, 1);
  assert.equal(result.response.units[0]?.text, "Mara keeps old promises.");
  assert.equal(result.response.units[0]?.sourceHash, sourceHash);
});

test("evidence unit extraction recovers valid units from malformed partial json", async () => {
  const sourceNote: LtmNote = {
    id: "scene_source_test",
    type: "scene",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["source_summary"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      source: {
        text: "Mara keeps old promises and the lantern hum should pay off later.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  };

  const recoveredUnitId = randomUUID();
  const provider = {
    maxTokensOverrideValue: undefined,
    chatComplete: async () => ({
      content: [
        "```json\n",
        '{"summary":"Broken response","units":[,',
        "\n```\n",
        `{"id":"${recoveredUnitId}","bucket":"thread","subjectId":"lantern_hum","sectionKey":"setup","text":"The lantern hum should pay off later.","evidence":["source_note:scene_source_test"],"confidence":0.86,"salience":0.7,"status":"active","links":[],"sourceHash":"${sourceHash}"}`,
      ].join(""),
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

  assert.equal(result.totalCandidates, 1);
  assert.deepEqual(result.droppedCandidates, []);
  assert.equal(result.response.summary, "");
  assert.equal(result.response.units.length, 1);
  assert.equal(result.response.units[0]?.id, recoveredUnitId);
  assert.equal(result.response.units[0]?.bucket, "thread");
  assert.equal(result.response.units[0]?.text, "The lantern hum should pay off later.");
});

test("evidence unit extraction validation rejects copied placeholder values", () => {
  const sourceNote: LtmNote = {
    id: "scene_source_test",
    type: "scene",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["source_summary"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      source: {
        text: "Mara keeps old promises.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  };
  const unitResponse = {
    summary: "Placeholder leak",
    units: [
      ltmEvidenceUnitSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        bucket: "character_fact",
        subjectId: "lowercase_snake_case_scope_id",
        sectionKey: "lowercase_snake_case",
        text: "Mara keeps old promises.",
        evidence: ["source_note:scene_source_test"],
        confidence: 0.9,
        salience: 0.7,
        status: "active",
        links: [{ target: "target_note_id", relation: "related_to" }],
        mergeHint: "optional note for deterministic compiler",
        sourceHash,
      }),
    ],
  };

  const compiled = compileEvidenceUnitExtraction({
    unitResponse,
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });

  assert.equal(compiled.compiledResponse.mutations.length, 0);
  assert.deepEqual(
    compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.code),
    ["candidate_dropped_placeholder_output"],
  );
  assert.deepEqual(compiled.outcome.droppedCandidates.map((candidate) => candidate.reason), ["placeholder_output"]);
});

test("source note extraction skips draft creation when every candidate is dropped", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-dropped-candidates-only-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Mara keeps old promises.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const provider = {
      maxTokensOverrideValue: undefined,
      chatComplete: async () => ({
        content: JSON.stringify({
          summary: "Placeholder leak",
          units: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              bucket: "character_fact",
              subjectId: "lowercase_snake_case_scope_id",
              sectionKey: "lowercase_snake_case",
              text: "Mara keeps old promises.",
              evidence: ["source_note:scene_source_test"],
              confidence: 0.9,
              salience: 0.7,
              status: "active",
              links: [{ target: "target_note_id", relation: "related_to" }],
              sourceHash: sourceHashForEvidenceUnitExtraction((await storage.getNote("scene_source_test"))!),
            },
          ],
        }),
      }),
    } as any;

    const result = await extractLongTermMemoryFromSourceNote({
      noteId: "scene_source_test",
      provider,
      model: "test-model",
      root,
      operationId: randomUUID(),
    });

    assert.equal(result.draft, null);
    assert.equal(result.response.mutations.length, 0);
    assert.equal(result.outcome.state, "no_suggestions_created");
    assert.deepEqual(result.outcome.droppedCandidates.map((candidate) => candidate.reason), ["placeholder_output"]);
    assert(
      result.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error" && diagnostic.code === "candidate_dropped_placeholder_output",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    status: "active",
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

test("archived notes remain chunked regardless of status", () => {
  const archivedNote: LtmNote = {
    id: "world_kiseki_academy",
    type: "world",
    status: "archived",
    modes: ["roleplay"],
    scope: {},
    tags: ["typed_memory"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      facts: {
        text: "Archived academy lore remains chunked.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_old"],
      },
    },
    version: 1,
  };

  assert.equal(chunkNotes([archivedNote]).length, 1);
});

test("archived notes stay in the vault and remain indexed", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-archive-isolated-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "world_archive_sealed",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [{ target: "world_active_neighbor", relation: "related_to" }],
        sections: {
          facts: {
            text: "Archived lore stays visible.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "world_active_neighbor",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [{ target: "world_archive_sealed", relation: "related_to" }],
        sections: {
          facts: {
            text: "Live lore remains visible.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    await storage.archiveNote("world_archive_sealed", { suppressEvent: true });
    const archived = await storage.getNote("world_archive_sealed");
    assert(archived);
    assert.equal(archived.status, "archived");

    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    const graph = JSON.parse(await readFile(join(dirs.indexes, "graph.json"), "utf8")) as {
      nodes: Record<string, unknown>;
    };
    const metadata = JSON.parse(await readFile(join(dirs.indexes, "metadata.json"), "utf8")) as {
      chunks: Record<string, { noteId: string }>;
    };

    assert("world_archive_sealed" in graph.nodes);
    assert(Object.values(metadata.chunks).some((chunk) => chunk.noteId === "world_archive_sealed"));
    assert(await storage.getNote("world_active_neighbor"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archived notes are retrievable via normal list/get and can be reactivated", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-archive-display-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "world_archive_display",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "Archived lore stays in vault.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    await storage.archiveNote("world_archive_display", { suppressEvent: true });

    const note = await storage.getNote("world_archive_display");
    assert(note);
    assert.equal(note.status, "archived");
    assert.deepEqual(
      (await storage.listNotes({ status: "archived" })).map((n) => n.id),
      ["world_archive_display"],
    );

    const restored = await storage.updateNote(
      "world_archive_display",
      { status: "active" },
      { suppressEvent: true },
    );
    assert.equal(restored.status, "active");
    assert.equal((await storage.getNote("world_archive_display"))?.status, "active");
    assert.deepEqual(
      (await storage.listNotes({ status: "archived" })).map((n) => n.id),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence unit compiler maps buckets to typed memory draft mutations", () => {
  const cases: Array<[LtmEvidenceUnit["bucket"], string, string]> = [
    ["timeline_event", "timeline_mara_jules_archive", "timeline_event"],
    ["character_fact", "char_mara", "character"],
    ["character_state", "char_mara", "character"],
    ["relationship_event", "rel_mara_jules", "relationship"],
    ["relationship_state", "rel_mara_jules", "relationship"],
    ["world_fact", "world_veil", "world"],
    ["thread", "thread_missing_key", "thread"],
    ["tone", "tone_chat", "tone"],
    ["anchor", "world_red_thread", "world"],
  ];

  for (const [bucket, expectedNoteId, expectedType] of cases) {
    const unit = evidenceUnit(bucket, {
      subjectId: expectedNoteId.replace(/^(char|rel|world|thread|timeline|scene|tone)_/, ""),
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

test("timeline event units create historical notes and typed memories link to them", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-timeline-layer-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Mara confronts Jules in the archive and trusts him with the hidden key.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const units = [
      evidenceUnit("timeline_event", {
        subjectId: "archive_confrontation",
        sectionKey: "event",
        text: "Mara confronts Jules in the archive.",
      }),
      evidenceUnit("relationship_event", {
        subjectId: "mara_jules",
        sectionKey: "history",
        text: "Mara trusts Jules with the hidden key during the archive confrontation.",
        links: [{ target: "timeline_archive_confrontation", relation: "occurred_in" }],
      }),
    ];
    const response = compileLtmEvidenceUnits({
      units,
      existingNotes: [],
      scope: {},
      modes: ["roleplay"],
      createdAt: timestamp,
    });

    const created = response.mutations.filter((mutation) => mutation.kind === "create_note");
    assert.equal(created.length, 2);
    assert(
      created.some(
        (mutation) =>
          mutation.kind === "create_note" &&
          mutation.note.id === "timeline_archive_confrontation" &&
          mutation.note.type === "timeline_event",
      ),
    );
    assert(
      created.some(
        (mutation) =>
          mutation.kind === "create_note" &&
          mutation.note.id === "rel_mara_jules" &&
          mutation.note.links.some(
            (link) => link.target === "timeline_archive_confrontation" && link.relation === "occurred_in",
          ),
      ),
    );

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
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

    const timeline = await storage.getNote("timeline_archive_confrontation");
    const relationship = await storage.getNote("rel_mara_jules");
    assert.equal(timeline?.type, "timeline_event");
    assert(timeline?.links.some((link) => link.target === "scene_source_test" && link.relation === "extracted_from"));
    assert(
      relationship?.links.some((link) => link.target === "scene_source_test" && link.relation === "extracted_from"),
    );
    assert(
      relationship?.links.some(
        (link) => link.target === "timeline_archive_confrontation" && link.relation === "occurred_in",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence unit compiler applies explicit bucket lifecycle rules", () => {
  const existingRelationship: LtmNote = {
    id: "rel_mara_jules",
    type: "relationship",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["typed_memory", "relationship_memory"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      history: {
        text: "- Mara first trusted Jules with the hidden key.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_source_test"],
      },
    },
    version: 1,
  };
  const existingCharacter: LtmNote = {
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
      current_state: {
        text: "Mara is cautious around Jules.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_old"],
      },
    },
    version: 1,
  };
  const existingThread: LtmNote = {
    id: "thread_lantern",
    type: "thread",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["typed_memory"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      setup: {
        text: "The lantern hum should pay off later.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_old"],
      },
    },
    version: 1,
  };

  const response = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("relationship_event", {
        subjectId: "mara_jules",
        sectionKey: "history",
        text: "Mara trusts Jules again when he returns the tower archive key.",
      }),
      evidenceUnit("character_state", {
        subjectId: "mara",
        sectionKey: "current_state",
        text: "Mara is openly relieved around Jules.",
      }),
      evidenceUnit("thread", {
        subjectId: "lantern",
        sectionKey: "setup",
        text: "The lantern hum paid off when it revealed the archive door.",
        status: "resolved",
      }),
    ],
    existingNotes: [existingRelationship, existingCharacter, existingThread],
    scope: {},
    modes: ["roleplay"],
    createdAt: timestamp,
  });

  assert(
    response.mutations.some(
      (mutation) =>
        mutation.kind === "append_section" && mutation.noteId === "rel_mara_jules" && mutation.sectionKey === "history",
    ),
  );
  assert(
    response.mutations.some(
      (mutation) =>
        mutation.kind === "update_section" &&
        mutation.noteId === "char_mara" &&
        mutation.sectionKey === "current_state" &&
        mutation.section.text === "Mara is openly relieved around Jules.",
    ),
  );
  assert(
    response.mutations.some(
      (mutation) =>
        mutation.kind === "update_section" &&
        mutation.noteId === "thread_lantern" &&
        mutation.sectionKey === "summary" &&
        mutation.section.text === "The lantern hum paid off when it revealed the archive door.",
    ),
  );
  assert(
    response.mutations.some(
      (mutation) =>
        mutation.kind === "set_status" && mutation.noteId === "thread_lantern" && mutation.status === "archived",
    ),
  );
});

test("evidence unit compiler keeps relationship state unchanged when only new events arrive", () => {
  const existingRelationship: LtmNote = {
    id: "rel_mara_jules",
    type: "relationship",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["typed_memory", "relationship_memory"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      history: {
        text: "- Mara argued with Jules after the archive betrayal.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_old"],
        confidence: 0.9,
        salience: 1,
      },
      state: {
        text: "Current relationship state: trust: low; tension: medium. Trajectory: strained_with_unresolved_conflict.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_old"],
      },
    },
    version: 1,
  };

  const response = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("relationship_event", {
        subjectId: "mara_jules",
        sectionKey: "history",
        text: "Mara trusts Jules again when he protects her and returns the tower archive key.",
        salience: 1,
      }),
    ],
    existingNotes: [existingRelationship],
    scope: {},
    modes: ["roleplay"],
    createdAt: timestamp,
  });

  const history = response.mutations.find(
    (mutation) =>
      mutation.kind === "append_section" && mutation.noteId === "rel_mara_jules" && mutation.sectionKey === "history",
  );
  assert(history?.kind === "append_section");
  assert.match(history.text, /Mara trusts Jules again when he protects her and returns the tower archive key/);
  assert.equal(
    response.mutations.some(
      (mutation) =>
        mutation.kind === "update_section" && mutation.noteId === "rel_mara_jules" && mutation.sectionKey === "state",
    ),
    false,
  );
});

test("generate route no longer creates live-turn long-term memory drafts", async () => {
  const generateRouteSource = await readFile(new URL("../../../routes/generate.routes.ts", import.meta.url), "utf8");
  const longTermMemoryRouteSource = await readFile(new URL("../../../routes/long-term-memory.routes.ts", import.meta.url), "utf8");
  const sourceExtractionSource = await readFile(new URL("../source-extraction.ts", import.meta.url), "utf8");

  assert.doesNotMatch(
    generateRouteSource,
    /LongTermMemoryDraftStore|runLongTermMemoryExtraction|applyLongTermMemoryDraft|createDraft\s*\(/,
  );
  assert.doesNotMatch(
    longTermMemoryRouteSource,
    /app\.post<\{ Body: unknown \}>\("\/drafts"|createDraftBodySchema|Long-term memory draft creation/,
  );
  assert.match(sourceExtractionSource, /LongTermMemoryDraftStore/);
  assert.match(sourceExtractionSource, /createDraft\s*\(/);
});

test("draft store rejects drafts that are not tied to a source note", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-source-note-required-"));
  try {
    await assert.rejects(
      new LongTermMemoryDraftStore(root).createDraft({
        scope: {},
        modes: ["roleplay"],
        source: { chatId: "chat_test" },
        response: {
          summary: "Invalid draft",
          mutations: [threadCreateMutation()],
        },
      }),
      /Long-term memory drafts must be tied to a source note/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence unit compiler derives tone profiles from raw observations", () => {
  const toneResponse = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("tone", {
        subjectId: "chat",
        sectionKey: "observations",
        text: "Domestic warmth is balanced with low-key suspense around the archive.",
      }),
    ],
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    createdAt: timestamp,
  });
  const createdTone = toneResponse.mutations.find(
    (mutation) => mutation.kind === "create_note" && mutation.note.id === "tone_chat",
  );
  assert(createdTone?.kind === "create_note");
  assert.match(createdTone.note.sections.observations?.text ?? "", /Domestic warmth/);
  assert.match(createdTone.note.sections.profile?.text ?? "", /^Tone profile:/);
});

test("evidence unit schema rejects removed source-summary buckets", () => {
  for (const bucket of ["relationship_arc", "current_scene", "boundary", "preference"]) {
    assert.equal(
      ltmEvidenceUnitSchema.safeParse({
        id: randomUUID(),
        bucket,
        subjectId: "mara",
        sectionKey: "facts",
        text: "Mara senses magic.",
        evidence: ["source_note:scene_source_test"],
        confidence: 0.9,
        salience: 0.7,
        status: "active",
        links: [],
        sourceHash,
      }).success,
      false,
      bucket,
    );
  }
});

test("source extraction drafts reject scene note mutations from source summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-scene-mutation-reject-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "active",
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

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test", sourceHash },
      response: {
        summary: "Invalid scene update",
        mutations: [
          {
            id: randomUUID(),
            kind: "update_section",
            risk: "medium",
            confidence: 0.8,
            summary: "Update scene current state",
            evidence: ["source_note:scene_source_test"],
            noteId: "scene_current_chat",
            sectionKey: "current_state",
            section: {
              text: "Mara and Jules stand inside the tower archive.",
              updatedAt: timestamp,
              evidence: ["source_note:scene_source_test"],
            },
          },
        ],
      },
    });

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, {
        root,
        actor: "test",
        rebuildIndexes: false,
      }),
      /cannot mutate scene\/source notes: scene_current_chat/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction drafts target existing notes regardless of status", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-archived-isolated-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Kiseki Academy is a floating school above the old city.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const response = compileLtmEvidenceUnits({
      units: [
        evidenceUnit("world_fact", {
          subjectId: "kiseki_academy",
          sectionKey: "facts",
          text: "Kiseki Academy is a floating school above the old city.",
        }),
      ],
      existingNotes: [],
      scope: {},
      modes: ["roleplay"],
      createdAt: timestamp,
    });
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
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

    const created = await storage.getNote("world_kiseki_academy");
    assert(created);
    assert.equal(created.status, "active");
    assert.equal(created.sections.facts?.text, "Kiseki Academy is a floating school above the old city.");
    assert(created.links.some((link) => link.target === "scene_source_test" && link.relation === "extracted_from"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction updates existing typed note from another source instead of creating duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-cross-source-update-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const secondSourceText = "Mara trusts Jules again when he returns the tower archive key.";
    await storage.createNote(
      {
        id: "scene_source_first",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_a" },
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Mara first trusted Jules with the hidden key.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "scene_source_second",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_b" },
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: secondSourceText,
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
        scope: { chatId: "chat_a" },
        tags: ["typed_memory", "relationship_memory"],
        links: [{ target: "scene_source_first", relation: "extracted_from" }],
        sections: {
          history: {
            text: "- Mara first trusted Jules with the hidden key.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_first"],
          },
          state: {
            text: "Current relationship state: trust: medium; tension: low. Trajectory: warming_trust_with_remaining_secrets.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_first"],
          },
        },
      },
      { suppressEvent: true },
    );

    const sourceNote = (await storage.getNote("scene_source_second"))!;
    const compiled = compileEvidenceUnitExtraction({
      unitResponse: {
        summary: "Second relationship event",
        units: [
          evidenceUnit("relationship_event", {
            subjectId: "mara_jules",
            sectionKey: "history",
            text: secondSourceText,
            evidence: ["source_note:scene_source_second"],
            sourceHash: sourceHashForEvidenceUnitExtraction(sourceNote),
          }),
        ],
      },
      sourceText: secondSourceText,
      sourceNote,
      existingNotes: [(await storage.getNote("rel_mara_jules"))!],
      scope: {},
      modes: ["roleplay"],
      sourceHash: sourceHashForEvidenceUnitExtraction(sourceNote),
    });
    assert.deepEqual(
      compiled.compiledResponse.mutations.map((mutation) => mutation.kind),
      ["append_section"],
    );

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: {
        sourceNoteId: sourceNote.id,
        sourceHash: sourceHashForEvidenceUnitExtraction(sourceNote),
      },
      response: compiled.compiledResponse,
    });

    await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      rebuildIndexes: false,
    });

    const updated = await storage.getNote("rel_mara_jules");
    assert.match(updated?.sections.history?.text ?? "", /Mara first trusted Jules with the hidden key/);
    assert.match(
      updated?.sections.history?.text ?? "",
      /Mara trusts Jules again when he returns the tower archive key/,
    );
    assert(updated?.links.some((link) => link.target === "scene_source_first" && link.relation === "extracted_from"));
    assert(updated?.links.some((link) => link.target === "scene_source_second" && link.relation === "extracted_from"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source note extraction target lookup prevents duplicate creates across source notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-target-lookup-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const secondSourceText = "Mara trusts Jules again when he returns the tower archive key.";
    await storage.createNote(
      {
        id: "scene_source_first",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_a" },
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Mara first trusted Jules with the hidden key.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "scene_source_second",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_b" },
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: secondSourceText,
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
        scope: { chatId: "chat_a" },
        tags: ["typed_memory", "relationship_memory"],
        links: [{ target: "scene_source_first", relation: "extracted_from" }],
        sections: {
          history: {
            text: "- Mara first trusted Jules with the hidden key.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_first"],
          },
        },
      },
      { suppressEvent: true },
    );
    await rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: async (texts) => texts.map(() => []),
    });

    const provider = {
      maxTokensOverrideValue: undefined,
      chatComplete: async () => ({
        content: JSON.stringify({
          summary: "Second relationship event",
          units: [
            {
              id: randomUUID(),
              bucket: "relationship_event",
              subjectId: "mara_jules",
              sectionKey: "history",
              text: secondSourceText,
              evidence: ["source_note:scene_source_second"],
              confidence: 0.9,
              salience: 0.7,
              status: "active",
              links: [],
              sourceHash: sourceHashForEvidenceUnitExtraction((await storage.getNote("scene_source_second"))!),
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

    assert.equal(result.draft, null);
    assert(
      result.diagnostics.some(
        (diagnostic) => diagnostic.severity === "warning" && diagnostic.code === "target_note_scope_mismatch",
      ),
    );
    assert.equal(result.outcome.state, "no_suggestions_created");
    assert.deepEqual(result.outcome.droppedCandidates.map((candidate) => candidate.reason), ["target_note_outside_scope"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source note extraction target lookup updates matching scoped notes only", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-target-lookup-scoped-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const secondSourceText = "Mara trusts Jules again when he returns the tower archive key.";
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
            text: secondSourceText,
            updatedAt: timestamp,
            evidence: ["chat:chat_a"],
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
        scope: { chatId: "chat_a" },
        tags: ["typed_memory", "relationship_memory"],
        links: [{ target: "scene_source_first", relation: "extracted_from" }],
        sections: {
          history: {
            text: "- Mara first trusted Jules with the hidden key.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_first"],
          },
        },
      },
      { suppressEvent: true },
    );
    await rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: async (texts) => texts.map(() => []),
    });

    const provider = {
      maxTokensOverrideValue: undefined,
      chatComplete: async () => ({
        content: JSON.stringify({
          summary: "Second relationship event",
          units: [
            {
              id: randomUUID(),
              bucket: "relationship_event",
              subjectId: "mara_jules",
              sectionKey: "history",
              text: secondSourceText,
              evidence: ["source_note:scene_source_second"],
              confidence: 0.9,
              salience: 0.7,
              status: "active",
              links: [],
              sourceHash: sourceHashForEvidenceUnitExtraction((await storage.getNote("scene_source_second"))!),
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
    assert(!result.draft.mutations.some((mutation) => mutation.kind === "create_note"));
    assert(
      result.draft.mutations.some(
        (mutation) => mutation.kind === "append_section" && mutation.noteId === "rel_mara_jules",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source note extraction keeps in-scope targets and drops out-of-scope targets in the same pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-target-lookup-mixed-scope-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const sourceText = "Mara trusts Jules again, and the old city archive still floats above the lantern river.";
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
        id: "rel_mara_jules",
        type: "relationship",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_a" },
        tags: ["typed_memory", "relationship_memory"],
        links: [],
        sections: {
          history: {
            text: "- Mara first trusted Jules with the hidden key.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_first"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "world_old_city_archive",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_b" },
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The old city archive once stood on the riverbank.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_first"],
          },
        },
      },
      { suppressEvent: true },
    );
    await rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: async (texts) => texts.map(() => []),
    });

    const provider = {
      maxTokensOverrideValue: undefined,
      chatComplete: async () => ({
        content: JSON.stringify({
          summary: "Mixed scope update",
          units: [
            {
              id: randomUUID(),
              bucket: "relationship_event",
              subjectId: "mara_jules",
              sectionKey: "history",
              text: "Mara trusts Jules again.",
              evidence: ["source_note:scene_source_second"],
              confidence: 0.9,
              salience: 0.7,
              status: "active",
              links: [],
              sourceHash: sourceHashForEvidenceUnitExtraction((await storage.getNote("scene_source_second"))!),
            },
            {
              id: randomUUID(),
              bucket: "world_fact",
              subjectId: "old_city_archive",
              sectionKey: "facts",
              text: "The old city archive still floats above the lantern river.",
              evidence: ["source_note:scene_source_second"],
              confidence: 0.85,
              salience: 0.6,
              status: "active",
              links: [],
              sourceHash: sourceHashForEvidenceUnitExtraction((await storage.getNote("scene_source_second"))!),
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
    assert.equal(result.outcome.state, "partial_success");
    assert.deepEqual(result.outcome.droppedCandidates.map((candidate) => candidate.reason), ["target_note_outside_scope"]);
    assert(
      result.diagnostics.some(
        (diagnostic) => diagnostic.severity === "warning" && diagnostic.code === "target_note_scope_mismatch",
      ),
    );
    assert(
      result.draft.mutations.some(
        (mutation) => mutation.kind === "append_section" && mutation.noteId === "rel_mara_jules",
      ),
    );
    assert(
      !result.draft.mutations.some((mutation) => {
        if (mutation.kind === "create_note") return mutation.note.id === "world_old_city_archive";
        return mutation.noteId === "world_old_city_archive";
      }),
    );
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
        status: "active",
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
        id: "source_audit_test",
        type: "source",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: [],
        links: [],
        sections: {
          source: {
            text: "Dormant source audit note about the tower archive key.",
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
    await storage.createNote(
      {
        id: "world_dormant_archive_key",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "Dormant typed archive key lore should not enter normal recall.",
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
    const normalIds = normal.chunks.map((chunk) => chunk.chunk.id);
    assert(normalIds.includes("rel_mara_jules::history"));

    const exactStyle = await retrieveLongTermMemory({
      root,
      queryText: "Mara trusts Jules tower archive",
      maxChunks: 3,
      maxTokens: 1000,
      semanticWeight: 0.15,
      lexicalWeight: 1,
      graphWeight: 0,
      metadataWeight: 0.3,
      localEmbedder: async (texts) => texts.map(() => []),
    });
    assert.equal(exactStyle.chunks[0]?.chunk.id, "rel_mara_jules::history");

    const storyStyle = await retrieveLongTermMemory({
      root,
      queryText: "Mara trusts Jules tower archive",
      maxChunks: 3,
      maxTokens: 1000,
      semanticWeight: 0.45,
      lexicalWeight: 0.25,
      graphWeight: 0.35,
      metadataWeight: 0.8,
      localEmbedder: async (texts) => texts.map(() => []),
    });
    assert.equal(storyStyle.chunks[0]?.chunk.id, "rel_mara_jules::history");

    const thresholded = await retrieveLongTermMemory({
      root,
      queryText: "Mara trusts Jules tower archive",
      maxChunks: 3,
      maxTokens: 1000,
      minScore: 1,
      debug: true,
      localEmbedder: async (texts) => texts.map(() => []),
    });
    assert.equal(thresholded.chunks.length, 1);
    assert((thresholded.debug?.funnel.scoreThresholdSkippedCandidates ?? 0) > 0);

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
      ["scene_source_test", "source_audit_test"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retrieval accepts legacy enabled config, per-chat weights, chunk limits, and resolved memories", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-retrieval-preferences-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();
    const dirs = getLongTermMemoryDirectories(root);
    await writeFile(
      join(dirs.config, "retrieval.json"),
      JSON.stringify({
        version: 1,
        enabled: false,
        maxChunks: 12,
        maxTokens: 2048,
        semanticWeight: 0.6,
        lexicalWeight: 0.3,
        graphWeight: 0.1,
      }),
    );

    await storage.createNote(
      {
        id: "char_mara",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: { characterIds: ["mara"] },
        tags: ["typed_memory"],
        links: [],
        sections: {
          core: {
            text: "Mara carries a silver key from the tower archive.",
            updatedAt: timestamp,
          },
          current_state: {
            text: "Mara is currently wary but willing to revisit the archive.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "thread_archive_key",
        type: "thread",
        status: "resolved",
        modes: ["roleplay"],
        scope: { characterIds: ["mara"] },
        tags: ["typed_memory"],
        links: [],
        sections: {
          summary: {
            text: "Resolved thread: the tower archive key was returned.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    await rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: async (texts) => texts.map(() => []),
    });

    const exact = await retrieveLongTermMemory({
      root,
      queryText: "tower archive key",
      characterIds: ["mara"],
      maxChunks: 1,
      maxTokens: 1000,
      semanticWeight: 0.25,
      lexicalWeight: 0.7,
      graphWeight: 0.05,
      debug: true,
      localEmbedder: async (texts) => texts.map(() => []),
    });
    assert.equal(exact.debug?.weights.lexical, 0.7);
    assert.equal(exact.chunks.length, 1);
    assert(exact.chunks.some((chunk) => chunk.chunk.id === "char_mara::core"));
    assert(!exact.chunks.some((chunk) => chunk.chunk.noteId === "thread_archive_key"));
    assert.equal(exact.debug?.selected.length, 1);

    const withAdvanced = await retrieveLongTermMemory({
      root,
      queryText: "tower archive key",
      characterIds: ["mara"],
      includeResolved: true,
      maxChunks: 4,
      maxTokens: 1000,
      debug: false,
      localEmbedder: async (texts) => texts.map(() => []),
    });
    const ids = withAdvanced.chunks.map((chunk) => chunk.chunk.id);
    assert(ids.includes("char_mara::core"));
    assert(ids.includes("thread_archive_key::summary"));
    assert.equal(withAdvanced.debug, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
