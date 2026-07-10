import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LtmDraftMutation, LtmEvidenceUnit, LtmNote } from "@marinara-engine/shared";
import {
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE,
  DEFAULT_LTM_RECALL_PREAMBLE,
  isLtmSourceLikeNote,
  ltmEvidenceUnitSchema,
  ltmPoliciesConfigSchema,
  ltmScopeSchema,
  matchesLtmScope,
} from "@marinara-engine/shared";
import { buildApp } from "../../../app.js";
import { chunkNotes, type LtmMemoryChunk } from "../chunking.js";
import { buildLtmMetadataIndex } from "../metadata-index.js";
import { compileLtmEvidenceUnits } from "../evidence-unit-compiler.js";
import { applyLtmBudget } from "../budget.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import { checkLongTermMemoryIntegrity } from "../maintenance.js";
import { renameWithRetry } from "../atomic-json.js";
import { getLongTermMemoryDirectories, notePathForId } from "../paths.js";
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
import { DEFAULT_LTM_EXTRACTION_PROMPT } from "@marinara-engine/shared";
import {
  compileEvidenceUnitExtraction,
  runLongTermMemoryEvidenceUnitExtraction,
  sourceHashForEvidenceUnitExtraction,
} from "../evidence-unit-extraction.js";
import { getLtmExtractionConfig, updateLtmExtractionConfig } from "../extraction-config.js";
import { getLtmGlobalSettings, updateLtmGlobalSettings } from "../settings.js";
import { extractLongTermMemoryFromSourceNote } from "../source-extraction.js";
import { applyLtmScopeLinksToDerivedNotes } from "../scope-links.js";
import { readLtmDebugLog } from "../debug-log.js";
import type { LtmBudgetedChunk } from "../budget.js";
import type { ChatMessage } from "../../llm/base-provider.js";
import type { RetrieveLongTermMemoryInput } from "../retrieval.js";
import { assemblePrompt, type AssemblerInput } from "../../prompt/index.js";

const timestamp = "2026-06-10T00:00:00.000Z";
const sourceHash = "a".repeat(64);

async function readJsonText(path: string) {
  return readFile(path, "utf8");
}

function withKeywords<T extends Record<string, unknown>>(value: T): T & { keywords: string[] } {
  const keywords = Array.isArray((value as { keywords?: unknown }).keywords)
    ? ((value as { keywords?: string[] }).keywords ?? [])
    : [];
  return {
    ...value,
    keywords,
  };
}

async function listSourceFiles(root: URL): Promise<URL[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    if (entry.name === "__tests__") continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(child)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

test("source-like note detection uses exact summary tags only", () => {
  assert.equal(isLtmSourceLikeNote({ type: "source", tags: [] }), true);
  assert.equal(isLtmSourceLikeNote({ type: "scene", tags: ["source_summary"] }), true);
  assert.equal(isLtmSourceLikeNote({ type: "scene", tags: ["chat_summary"] }), true);
  assert.equal(isLtmSourceLikeNote({ type: "scene", tags: ["imported_chat_summary"] }), false);
  assert.equal(isLtmSourceLikeNote({ type: "scene", tags: ["chat_summary_cleanup"] }), false);
});

test("long-term memory chunks keep prompt text free of index labels", () => {
  const chunks = chunkNotes([
    {
      ...withKeywords({
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
      }),
    },
  ]);

  assert.equal(chunks[0]?.text, "A sample instruction remains available for later retrieval.");
  assert.doesNotMatch(chunks[0]?.text ?? "", /note:|type:|section:|status:|chat:|group:|characters:/);
});

test("long-term memory scope matcher includes global, chat, thread, group, and character overlaps", () => {
  const note = (id: string, type: LtmNote["type"], scope: LtmNote["scope"]) => ({ id, type, scope });
  const scopedView = {
    scope: {
      chatId: "branch_a",
      chatIds: ["branch_a"],
      groupId: "thread_alpha",
      characterIds: ["char_mara"],
    },
    characterIds: ["char_mara"],
  };

  assert.equal(matchesLtmScope(note("world_global", "world", {}), scopedView), true);
  assert.equal(matchesLtmScope(note("scene_exact_chat", "scene", { chatId: "branch_a" }), scopedView), true);
  assert.equal(matchesLtmScope(note("thread_all_branches", "thread", { groupId: "thread_alpha" }), scopedView), true);
  assert.equal(matchesLtmScope(note("world_group", "world", { groupId: "thread_alpha" }), scopedView), true);
  assert.equal(matchesLtmScope(note("char_mara", "character", { characterIds: ["char_mara"] }), scopedView), true);
  assert.equal(matchesLtmScope(note("world_elsewhere", "world", { chatId: "branch_b", characterIds: ["char_jules"] }), scopedView), false);
  assert.equal(matchesLtmScope(note("world_global", "world", {}), { ...scopedView, includeGlobal: false }), false);
});

test("long-term memory note list filters compose scope with type status and tag filters", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-list-scope-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const base = {
      modes: ["roleplay" as const],
      links: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      sections: {
        summary: {
          text: "Scoped list filter fixture.",
          updatedAt: timestamp,
        },
      },
    };
    await storage.createNote(
      {
        ...base,
        id: "world_global_scope_list",
        type: "world",
        status: "active",
        scope: {},
        tags: ["typed_memory"],
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        ...base,
        id: "thread_branch_a_scope_list",
        type: "thread",
        status: "active",
        scope: { chatId: "branch_a", groupId: "thread_alpha", characterIds: ["char_mara"] },
        tags: ["typed_memory", "story_arc"],
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        ...base,
        id: "thread_group_scope_list",
        type: "thread",
        status: "resolved",
        scope: { groupId: "thread_alpha", characterIds: ["char_mara"] },
        tags: ["typed_memory", "story_arc"],
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        ...base,
        id: "thread_elsewhere_scope_list",
        type: "thread",
        status: "active",
        scope: { chatId: "branch_b", groupId: "thread_beta", characterIds: ["char_jules"] },
        tags: ["typed_memory", "story_arc"],
      },
      { suppressEvent: true },
    );

    const scoped = await storage.listNotes({
      scope: { chatId: "branch_a", chatIds: ["branch_a"], groupId: "thread_alpha", characterIds: ["char_mara"] },
    });
    assert.deepEqual(
      scoped.map((note) => note.id),
      ["thread_branch_a_scope_list", "thread_group_scope_list", "world_global_scope_list"],
    );

    const activeThreadScoped = await storage.listNotes({
      type: "thread",
      status: "active",
      tag: "story_arc",
      scope: { chatId: "branch_a", chatIds: ["branch_a"], groupId: "thread_alpha", characterIds: ["char_mara"] },
    });
    assert.deepEqual(
      activeThreadScoped.map((note) => note.id),
      ["thread_branch_a_scope_list"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long-term memory chunks strip legacy inline evidence labels", () => {
  const chunks = chunkNotes([
    {
      ...withKeywords({
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
      }),
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
        keywords: [],
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

  assert.equal(
    block,
    "[TONE]\nA sample instruction remains available for later retrieval.",
  );
  assert.doesNotMatch(block, /<long_term_memory>|tier:|reasons:|note:|section:|chat:|group:|characters:|graph:/);
});

test("long-term memory prompt injection can include a recall preamble", () => {
  const block = formatLongTermMemoryBlock(
    [
      {
        chunk: {
          id: "sample_memory_note::social_habits",
          noteId: "sample_memory_note",
          sectionKey: "social_habits",
          text: "A sample instruction remains available for later retrieval.",
          noteType: "tone",
          status: "active",
          scope: {},
          tags: ["typed_memory"],
          keywords: [],
          updatedAt: timestamp,
          sourceHash,
        },
        score: 1,
        reasons: ["vector"],
        lanes: ["vector"],
        tier: 1,
        estimatedTokens: 42,
      } satisfies LtmBudgetedChunk,
    ],
    { preamble: DEFAULT_LTM_RECALL_PREAMBLE },
  );

  assert.equal(
    block,
    `${DEFAULT_LTM_RECALL_PREAMBLE}\n\n[TONE]\nA sample instruction remains available for later retrieval.`,
  );
});

test("long-term memory prompt injection inserts a system message before chat history", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "System prelude", contextKind: "prompt" as const },
    { role: "user", content: "Where did Mara leave the key?" },
    { role: "assistant", content: "I think it was near the archive." },
  ];

  const result = injectLongTermMemoryPromptBlock(
    messages,
    [
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
          keywords: [],
          updatedAt: timestamp,
          sourceHash,
        },
        score: 1,
        reasons: ["bm25"],
        lanes: ["bm25"],
        tier: 1,
        estimatedTokens: 16,
      } satisfies LtmBudgetedChunk,
    ],
    { preamble: "" },
  );

  assert.equal(result.inserted, true);
  assert.equal(result.insertAt, 1);
  assert.equal(result.block, "[WORLD]\nMara hid the archive key behind the clock in the tower foyer.");
  assert.deepEqual(messages.map((message) => message.role), ["system", "system", "user", "assistant"]);
  assert.equal(messages[1]?.contextKind, "injection");
  assert.equal(messages[1]?.content, result.block);
});

test("long-term memory storage reads individual notes without listing the vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-direct-lookup-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "world_direct_lookup",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The archive door only opens at moonrise.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    storage.listNotes = async () => {
      throw new Error("getNote should not list the whole vault");
    };

    const note = await storage.getNote("world_direct_lookup");
    assert.equal(note?.id, "world_direct_lookup");
    assert.equal(note?.type, "world");
    assert.equal(await storage.getNote("world_missing_lookup"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long-term memory storage batch lookup returns existing notes and skips missing ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-batch-lookup-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "world_batch_lookup",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The tower key is hidden behind the portrait.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "thread_batch_lookup",
        type: "thread",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          setup: {
            text: "Pay off the portrait key when Mara returns to the tower.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    const notes = await storage.getNotesByIds([
      "world_batch_lookup",
      "world_batch_lookup",
      "thread_batch_lookup",
      "world_missing_lookup",
    ]);

    assert.equal(notes.size, 2);
    assert.equal(notes.get("world_batch_lookup")?.type, "world");
    assert.equal(notes.get("thread_batch_lookup")?.type, "thread");
    assert.equal(notes.has("world_missing_lookup"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation long-term memory uses global retrieval settings and injects after prompt setup before history", async () => {
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
      longTermMemoryBudgetTokens: 99999,
      longTermMemoryMaxChunks: 999,
      longTermMemoryScoreThreshold: 2,
      longTermMemoryRecallContextMessages: 99,
      longTermMemoryIncludeResolved: false,
      longTermMemoryDebug: false,
    },
    globalSettings: {
      version: 1,
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 1536,
      longTermMemoryMaxChunks: 8,
      longTermMemoryScoreThreshold: 0.35,
      longTermMemoryRecallContextMessages: 3,
      longTermMemoryRecallStyle: "story",
      longTermMemorySemanticWeight: 0.2,
      longTermMemoryLexicalWeight: 0.75,
      longTermMemoryGraphWeight: 0.15,
      longTermMemoryKeywordWeight: 0.25,
      longTermMemoryIncludeResolved: true,
      longTermMemoryRecallPreamble: DEFAULT_LTM_RECALL_PREAMBLE,
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
              keywords: [],
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
  assert.equal(retrievalInput.maxTokens, 1536);
  assert.equal(retrievalInput.maxChunks, 8);
  assert.equal(retrievalInput.minScore, 0.35);
  assert.equal(retrievalInput.includeResolved, true);
  assert.equal(retrievalInput.debug, true);
  assert.equal(retrievalInput.explain, true);
  assert.equal(retrievalInput.semanticWeight, 0.2);
  assert.equal(retrievalInput.lexicalWeight, 0.75);
  assert.equal(retrievalInput.graphWeight, 0.15);
  assert.equal((retrievalInput as { metadataWeight?: unknown }).metadataWeight, undefined);
  assert.equal(retrievalInput.metadataMode, "filter_only");
  assert.equal(retrievalInput.dedupeExactText, true);
  assert.equal(retrievalInput.applyUsageCooldown, true);
  assert.equal(retrievalInput.scope?.chatId, "chat_test");
  assert.deepEqual(retrievalInput.scope?.chatIds, ["chat_test"]);
  assert.equal(retrievalInput.scope?.groupId, "group_test");
  assert.deepEqual(retrievalInput.scope?.characterIds, ["char_mara"]);
  assert.deepEqual(retrievalInput.characterIds, ["char_mara"]);
  assert.deepEqual(retrievalInput.mentionedCharacterNames, ["Mara", "Jules"]);
  assert.deepEqual(retrievalInput.recentMessages, ["Did she hide it near the tower?", "Maybe.", "Check your memory."]);
  assert.match(retrievalInput.queryText ?? "", /Active characters: Mara/);
  assert.match(retrievalInput.queryText ?? "", /Generation triggers: chat, roleplay, archive/);
  assert.match(retrievalInput.queryText ?? "", /Generation guide:\nFocus on emotional continuity\./);
  assert.equal(result.injection.inserted, true);
  assert.equal(result.injection.insertAt, 2);
  assert.equal(result.injection.insertedBeforeRole, "user");
  assert.deepEqual(finalMessages.map((message) => message.role), ["system", "system", "system", "user", "assistant"]);
  assert.equal(finalMessages[2]?.contextKind, "injection");
  assert.equal(
    finalMessages[2]?.content,
    `${DEFAULT_LTM_RECALL_PREAMBLE}\n\n[WORLD]\nMara hid the archive key behind the clock in the tower foyer.`,
  );
});

test("assembler injects long-term memory before chat summary fallback", async () => {
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
  assert.match(systemPrompt, /Summary says Mara hid the archive key behind the clock/);
  assert.deepEqual(result.messages.map((message) => message.role), ["system", "user", "assistant"]);
});

test("assembler places long-term memory at an explicit long_term_memory marker", async () => {
  const input = {
    db: {} as AssemblerInput["db"],
    preset: {
      id: "preset_test",
      name: "Test Preset",
      description: "",
      sectionOrder: JSON.stringify(["system_section", "ltm_section", "history_section"]),
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
        id: "ltm_section",
        presetId: "preset_test",
        identifier: "long_term_memory",
        name: "Long-Term Memory",
        content: "",
        role: "system",
        enabled: "true",
        isMarker: "true",
        groupId: null,
        markerConfig: JSON.stringify({ type: "long_term_memory" }),
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

  assert.deepEqual(result.messages.map((message) => message.role), ["system", "user", "assistant"]);
  assert.match(systemPrompt, /<system>\n    <persona>\n    Base system prompt\n    <\/persona>\n<\/system>/);
  assert.match(
    systemPrompt,
    /<long_term_memory>\n    \[WORLD\]\n    Mara hid the archive key behind the clock in the tower foyer\.\n<\/long_term_memory>/,
  );
  assert.ok(systemPrompt.indexOf("</system>") < systemPrompt.indexOf("<long_term_memory>"));
  assert.match(systemPrompt, /Summary says Mara hid the archive key behind the clock/);
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
    keywords: [],
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

test("long-term memory prompt and budget dedupe exact normalized chunk text", () => {
  const duplicateText = "The archive key is under the clock.";
  const chunks = new Map<string, LtmMemoryChunk>([
    [
      "world_archive_key::facts",
      {
        id: "world_archive_key::facts",
        noteId: "world_archive_key",
        sectionKey: "facts",
        text: duplicateText,
        noteType: "world",
        status: "active",
        scope: {},
        tags: ["typed_memory"],
        keywords: [],
        updatedAt: timestamp,
        sourceHash,
      },
    ],
    [
      "thread_archive_key::summary",
      {
        id: "thread_archive_key::summary",
        noteId: "thread_archive_key",
        sectionKey: "summary",
        text: ` ${duplicateText.replaceAll(" ", "  ")} `,
        noteType: "world",
        status: "active",
        scope: {},
        tags: ["typed_memory"],
        keywords: [],
        updatedAt: timestamp,
        sourceHash,
      },
    ],
  ]);

  const budgeted = applyLtmBudget(
    [
      {
        chunkId: "world_archive_key::facts",
        score: 1,
        normalizedScore: 1,
        finalNormalizedScore: 1,
        reasons: ["bm25"],
        lanes: ["bm25"],
      },
      {
        chunkId: "thread_archive_key::summary",
        score: 0.9,
        normalizedScore: 0.9,
        finalNormalizedScore: 0.9,
        reasons: ["bm25"],
        lanes: ["bm25"],
      },
    ],
    chunks,
    {
      maxChunks: 10,
      maxTokens: 1000,
      explain: true,
      dedupeExactText: true,
    },
  );

  assert.deepEqual(
    budgeted.chunks.map((chunk) => chunk.chunk.id),
    ["world_archive_key::facts"],
  );
  assert.equal(budgeted.rejected[0]?.rejectionReason, "duplicate_text");

  const block = formatLongTermMemoryBlock([
    budgeted.chunks[0]!,
    {
      ...budgeted.chunks[0]!,
      chunk: chunks.get("thread_archive_key::summary")!,
    },
  ]);
  assert.equal(block.match(/archive key is under the clock/gi)?.length, 1);
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
      keywords: [],
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

async function createDraftSourceNote(
  storage: LongTermMemoryStorage,
  id: string,
  scope: LtmNote["scope"] = {},
) {
  await storage.createNote(
    {
      id,
      type: "scene",
      status: "active",
      modes: ["roleplay"],
      scope,
      tags: ["source_summary"],
      links: [],
      sections: {
        source: {
          text: "Source text for draft application proof.",
          updatedAt: timestamp,
        },
      },
    },
    { suppressEvent: true },
  );
}

test("draft apply rejects missing create dependencies before writing any mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-apply-create-dependency-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await createDraftSourceNote(storage, "scene_apply_create_dependency");
    const createMutation = threadCreateMutation();
    const linkMutation: Extract<LtmDraftMutation, { kind: "add_link" }> = {
      id: randomUUID(),
      kind: "add_link",
      risk: "low",
      confidence: 0.95,
      summary: "Link the new thread to a missing event",
      evidence: ["source_note:scene_apply_create_dependency"],
      noteId: createMutation.note.id,
      link: { target: "timeline_missing_dependency", relation: "caused_by" },
    };
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_apply_create_dependency" },
      response: {
        summary: "Create with a missing dependency",
        mutations: [createMutation, linkMutation],
      },
    });

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, { root, actor: "test", rebuildIndexes: false }),
      /link target not found.*timeline_missing_dependency/i,
    );

    assert.equal(await storage.getNote(createMutation.note.id), null);
    assert.deepEqual((await new LongTermMemoryDraftStore(root).getDraft(draft.id))?.appliedMutationIds ?? [], []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply preflights all mutation targets before changing valid notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-apply-target-preflight-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await createDraftSourceNote(storage, "scene_apply_target_preflight");
    await storage.createNote(
      {
        id: "world_apply_target_preflight",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The archive door is closed.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    const appendMutation: Extract<LtmDraftMutation, { kind: "append_section" }> = {
      id: randomUUID(),
      kind: "append_section",
      risk: "low",
      confidence: 0.9,
      summary: "Append a valid world fact",
      evidence: ["source_note:scene_apply_target_preflight"],
      noteId: "world_apply_target_preflight",
      sectionKey: "facts",
      text: "The archive key opens it.",
    };
    const missingMutation: Extract<LtmDraftMutation, { kind: "set_status" }> = {
      id: randomUUID(),
      kind: "set_status",
      risk: "low",
      confidence: 0.9,
      summary: "Archive a missing thread",
      evidence: ["source_note:scene_apply_target_preflight"],
      noteId: "thread_apply_target_missing",
      status: "archived",
    };
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_apply_target_preflight" },
      response: {
        summary: "Mixed valid and missing targets",
        mutations: [appendMutation, missingMutation],
      },
    });

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, { root, actor: "test", rebuildIndexes: false }),
      /(?:mutation target|note) not found.*thread_apply_target_missing/i,
    );

    assert.equal(
      (await storage.getNote("world_apply_target_preflight"))?.sections.facts?.text,
      "The archive door is closed.",
    );
    assert.deepEqual((await new LongTermMemoryDraftStore(root).getDraft(draft.id))?.appliedMutationIds ?? [], []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply preflights scoped create collisions before changing valid notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-apply-create-collision-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const draftScope = { chatId: "chat_apply_collision_b", chatIds: ["chat_apply_collision_b"] };
    await createDraftSourceNote(storage, "scene_apply_create_collision", draftScope);
    await storage.createNote(
      {
        id: "world_apply_create_collision",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: draftScope,
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: { text: "The observatory is locked.", updatedAt: timestamp },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "char_apply_create_collision",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_apply_collision_a", chatIds: ["chat_apply_collision_a"] },
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: { text: "This identity belongs to chat A.", updatedAt: timestamp },
        },
      },
      { suppressEvent: true },
    );
    const appendMutation: Extract<LtmDraftMutation, { kind: "append_section" }> = {
      id: randomUUID(),
      kind: "append_section",
      risk: "low",
      confidence: 0.9,
      summary: "Append an in-scope world fact",
      evidence: ["source_note:scene_apply_create_collision"],
      noteId: "world_apply_create_collision",
      sectionKey: "facts",
      text: "The brass key opens it.",
    };
    const createMutation: Extract<LtmDraftMutation, { kind: "create_note" }> = {
      id: randomUUID(),
      kind: "create_note",
      risk: "low",
      confidence: 0.9,
      summary: "Create a colliding scoped character",
      evidence: ["source_note:scene_apply_create_collision"],
      note: {
        id: "char_apply_create_collision",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: draftScope,
        tags: ["typed_memory"],
        keywords: [],
        links: [],
        sections: {
          facts: { text: "This identity belongs to chat B.", updatedAt: timestamp },
        },
      },
    };
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: draftScope,
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_apply_create_collision" },
      response: {
        summary: "Mixed valid mutation and scoped collision",
        mutations: [appendMutation, createMutation],
      },
    });

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, { root, actor: "test", rebuildIndexes: false }),
      /existing note from another scope/i,
    );

    assert.equal(
      (await storage.getNote("world_apply_create_collision"))?.sections.facts?.text,
      "The observatory is locked.",
    );
    assert.equal(
      (await storage.getNote("char_apply_create_collision"))?.sections.facts?.text,
      "This identity belongs to chat A.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply requires its source note before changing a target", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-apply-source-preflight-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "world_apply_source_preflight",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: { text: "The north gate is sealed.", updatedAt: timestamp },
        },
      },
      { suppressEvent: true },
    );
    const mutation: Extract<LtmDraftMutation, { kind: "append_section" }> = {
      id: randomUUID(),
      kind: "append_section",
      risk: "low",
      confidence: 0.9,
      summary: "Append a fact without its source",
      evidence: ["source_note:scene_apply_source_missing"],
      noteId: "world_apply_source_preflight",
      sectionKey: "facts",
      text: "A silver seal controls it.",
    };
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_apply_source_missing" },
      response: { summary: "Missing source", mutations: [mutation] },
    });

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, { root, actor: "test", rebuildIndexes: false }),
      /source note not found.*scene_apply_source_missing/i,
    );

    assert.equal(
      (await storage.getNote("world_apply_source_preflight"))?.sections.facts?.text,
      "The north gate is sealed.",
    );

    await storage.createNote(
      {
        id: "world_apply_not_a_source",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: { text: "This is typed memory, not source material.", updatedAt: timestamp },
        },
      },
      { suppressEvent: true },
    );
    const typedSourceDraft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "world_apply_not_a_source" },
      response: {
        summary: "Typed note used as source",
        mutations: [{ ...mutation, id: randomUUID(), evidence: ["source_note:world_apply_not_a_source"] }],
      },
    });

    await assert.rejects(
      applyLongTermMemoryDraft(typedSourceDraft.id, { root, actor: "test", rebuildIndexes: false }),
      /source is not a source note.*world_apply_not_a_source/i,
    );
    assert.equal(
      (await storage.getNote("world_apply_source_preflight"))?.sections.facts?.text,
      "The north gate is sealed.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply rejects duplicate mutation ids before changing a target", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-apply-duplicate-mutation-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await createDraftSourceNote(storage, "scene_apply_duplicate_mutation");
    await storage.createNote(
      {
        id: "world_apply_duplicate_mutation",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        keywords: ["archive"],
        links: [],
        sections: {
          facts: { text: "The archive is below the clock tower.", updatedAt: timestamp },
        },
      },
      { suppressEvent: true },
    );
    const duplicateId = randomUUID();
    const appendMutation: Extract<LtmDraftMutation, { kind: "append_section" }> = {
      id: duplicateId,
      kind: "append_section",
      risk: "low",
      confidence: 0.9,
      summary: "Append an archive fact",
      evidence: ["source_note:scene_apply_duplicate_mutation"],
      noteId: "world_apply_duplicate_mutation",
      sectionKey: "facts",
      text: "A hidden stair reaches it.",
    };
    const keywordMutation: Extract<LtmDraftMutation, { kind: "set_keywords" }> = {
      id: duplicateId,
      kind: "set_keywords",
      risk: "low",
      confidence: 0.9,
      summary: "Change archive keywords",
      evidence: ["source_note:scene_apply_duplicate_mutation"],
      noteId: "world_apply_duplicate_mutation",
      keywords: ["archive", "stair"],
    };
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_apply_duplicate_mutation" },
      response: {
        summary: "Duplicate mutation ids",
        mutations: [appendMutation, keywordMutation],
      },
    });

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, { root, actor: "test", rebuildIndexes: false }),
      /duplicate mutation id/i,
    );

    const target = await storage.getNote("world_apply_duplicate_mutation");
    assert.equal(target?.sections.facts?.text, "The archive is below the clock tower.");
    assert.deepEqual(target?.keywords, ["archive"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply validates edited mutations before changing any target", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-apply-edited-mutation-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await createDraftSourceNote(storage, "scene_apply_edited_mutation");
    await storage.createNote(
      {
        id: "world_apply_edited_mutation",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        keywords: ["observatory"],
        links: [],
        sections: {
          facts: { text: "The observatory lens is cracked.", updatedAt: timestamp },
        },
      },
      { suppressEvent: true },
    );
    const appendMutation: Extract<LtmDraftMutation, { kind: "append_section" }> = {
      id: randomUUID(),
      kind: "append_section",
      risk: "low",
      confidence: 0.9,
      summary: "Append an observatory fact",
      evidence: ["source_note:scene_apply_edited_mutation"],
      noteId: "world_apply_edited_mutation",
      sectionKey: "facts",
      text: "The replacement lens is hidden below the dome.",
    };
    const keywordMutation: Extract<LtmDraftMutation, { kind: "set_keywords" }> = {
      id: randomUUID(),
      kind: "set_keywords",
      risk: "low",
      confidence: 0.9,
      summary: "Update observatory keywords",
      evidence: ["source_note:scene_apply_edited_mutation"],
      noteId: "world_apply_edited_mutation",
      keywords: ["observatory", "lens"],
    };
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_apply_edited_mutation" },
      response: {
        summary: "Edited mutation validation",
        mutations: [appendMutation, keywordMutation],
      },
    });

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, {
        root,
        actor: "test",
        rebuildIndexes: false,
        editedMutations: [{ id: appendMutation.id, text: "" }],
      }),
      /edited mutation.*invalid|String must contain at least 1 character/i,
    );

    const target = await storage.getNote("world_apply_edited_mutation");
    assert.equal(target?.sections.facts?.text, "The observatory lens is cracked.");
    assert.deepEqual(target?.keywords, ["observatory"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply checkpoints committed mutations and resumes without duplicate appends", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-apply-resume-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await createDraftSourceNote(storage, "scene_apply_resume");
    await storage.createNote(
      {
        id: "rel_apply_resume",
        type: "relationship",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory", "relationship_memory"],
        links: [],
        sections: {
          history: { text: "Mara and Jules guarded the gate.", updatedAt: timestamp },
        },
      },
      { suppressEvent: true },
    );
    const appendMutation: Extract<LtmDraftMutation, { kind: "append_section" }> = {
      id: randomUUID(),
      kind: "append_section",
      risk: "low",
      confidence: 0.9,
      summary: "Append relationship history",
      evidence: ["source_note:scene_apply_resume"],
      noteId: "rel_apply_resume",
      sectionKey: "history",
      text: "Mara entrusted Jules with the gate key.",
    };
    const editedAppendText = "Mara entrusted Jules with both gate keys.";
    const createMutation = threadCreateMutation("The gate key must be returned before dawn.");
    createMutation.note.id = "thread_apply_resume";
    createMutation.evidence = ["source_note:scene_apply_resume"];
    createMutation.note.sections.setup!.evidence = ["source_note:scene_apply_resume"];
    const draftStore = new LongTermMemoryDraftStore(root);
    const draft = await draftStore.createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_apply_resume" },
      response: {
        summary: "Interrupted apply",
        mutations: [appendMutation, createMutation],
      },
    });
    const blockedCreatePath = notePathForId(createMutation.note.id, createMutation.note.type, root);
    await mkdir(blockedCreatePath, { recursive: true });

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, {
        root,
        actor: "test",
        rebuildIndexes: false,
        editedMutations: [{ id: appendMutation.id, text: editedAppendText }],
      }),
    );
    const interruptedDraft = await draftStore.getDraft(draft.id);
    assert.deepEqual(interruptedDraft?.appliedMutationIds, [appendMutation.id]);
    assert.equal(interruptedDraft?.applyState, "applying");
    const storedAppendMutation = interruptedDraft?.mutations.find(
      (mutation) => mutation.id === appendMutation.id,
    );
    assert.equal(
      storedAppendMutation?.kind === "append_section" ? storedAppendMutation.text : null,
      editedAppendText,
    );
    const textAfterFailure = (await storage.getNote("rel_apply_resume"))?.sections.history?.text ?? "";
    assert.equal(textAfterFailure.split(editedAppendText).length - 1, 1);
    assert.equal(textAfterFailure.includes(appendMutation.text), false);

    await rm(blockedCreatePath, { recursive: true, force: true });
    const result = await applyLongTermMemoryDraft(draft.id, { root, actor: "test", rebuildIndexes: false });

    assert.deepEqual(result.appliedMutationIds, [createMutation.id]);
    assert.equal(result.draft.status, "accepted");
    assert.equal(result.draft.applyState, "complete");
    assert.deepEqual(
      new Set(result.draft.appliedMutationIds),
      new Set([appendMutation.id, createMutation.id]),
    );
    const textAfterRetry = (await storage.getNote("rel_apply_resume"))?.sections.history?.text ?? "";
    assert.equal(textAfterRetry.split(editedAppendText).length - 1, 1);
    assert.equal(textAfterRetry.includes(appendMutation.text), false);
    assert.equal((await storage.getNote(createMutation.note.id))?.sections.setup?.text, createMutation.note.sections.setup?.text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply does not return checkpointed mutations to the pending queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-apply-resume-selection-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await createDraftSourceNote(storage, "scene_apply_resume_selection");
    const checkpointedText = "The clock door opened at midnight.";
    await storage.createNote(
      {
        id: "world_apply_resume_selection",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        keywords: ["clock"],
        links: [],
        sections: {
          facts: {
            text: `The clock door is hidden.\n\n${checkpointedText}`,
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    const checkpointedMutation: Extract<LtmDraftMutation, { kind: "append_section" }> = {
      id: randomUUID(),
      kind: "append_section",
      risk: "low",
      confidence: 0.9,
      summary: "Append the midnight event",
      evidence: ["source_note:scene_apply_resume_selection"],
      noteId: "world_apply_resume_selection",
      sectionKey: "facts",
      text: checkpointedText,
    };
    const pendingMutation: Extract<LtmDraftMutation, { kind: "set_keywords" }> = {
      id: randomUUID(),
      kind: "set_keywords",
      risk: "low",
      confidence: 0.9,
      summary: "Update clock-door keywords",
      evidence: ["source_note:scene_apply_resume_selection"],
      noteId: "world_apply_resume_selection",
      keywords: ["clock", "door", "midnight"],
    };
    const draftStore = new LongTermMemoryDraftStore(root);
    const draft = await draftStore.createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_apply_resume_selection" },
      response: {
        summary: "Resume only pending selection",
        mutations: [checkpointedMutation, pendingMutation],
      },
    });
    await draftStore.updateDraft(draft.id, {
      applyState: "applying",
      appliedAt: timestamp,
      appliedMutationIds: [checkpointedMutation.id],
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      mutationIds: [pendingMutation.id],
      rebuildIndexes: false,
    });

    assert.deepEqual(result.appliedMutationIds, [pendingMutation.id]);
    assert.deepEqual(result.skippedMutationIds, []);
    assert.equal(result.draft.status, "accepted");
    assert.deepEqual(
      new Set(result.draft.appliedMutationIds),
      new Set([checkpointedMutation.id, pendingMutation.id]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply replays an uncheckpointed append idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-apply-uncheckpointed-append-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await createDraftSourceNote(storage, "scene_apply_uncheckpointed_append");
    const appendedText = "Mara entrusted Jules with the western gate key.";
    await storage.createNote(
      {
        id: "rel_apply_uncheckpointed_append",
        type: "relationship",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory", "relationship_memory"],
        links: [],
        sections: {
          history: {
            text: `Mara and Jules guarded the gate.\n\n${appendedText}`,
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    const mutation: Extract<LtmDraftMutation, { kind: "append_section" }> = {
      id: randomUUID(),
      kind: "append_section",
      risk: "low",
      confidence: 0.9,
      summary: "Replay an append after a checkpoint crash",
      evidence: ["source_note:scene_apply_uncheckpointed_append"],
      noteId: "rel_apply_uncheckpointed_append",
      sectionKey: "history",
      text: appendedText,
    };
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_apply_uncheckpointed_append" },
      response: { summary: "Uncheckpointed append", mutations: [mutation] },
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      rebuildIndexes: false,
    });

    assert.deepEqual(result.appliedMutationIds, [mutation.id]);
    const text = (await storage.getNote("rel_apply_uncheckpointed_append"))?.sections.history?.text ?? "";
    assert.equal(text.split(appendedText).length - 1, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply reports rebuild failure without hiding committed mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-apply-rebuild-failure-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await createDraftSourceNote(storage, "scene_apply_rebuild_failure");
    await storage.createNote(
      {
        id: "world_apply_rebuild_failure",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: { text: "The eastern bell is silent.", updatedAt: timestamp },
        },
      },
      { suppressEvent: true },
    );
    const mutation: Extract<LtmDraftMutation, { kind: "append_section" }> = {
      id: randomUUID(),
      kind: "append_section",
      risk: "low",
      confidence: 0.9,
      summary: "Append a bell fact",
      evidence: ["source_note:scene_apply_rebuild_failure"],
      noteId: "world_apply_rebuild_failure",
      sectionKey: "facts",
      text: "It rings only when the archive opens.",
    };
    const draftStore = new LongTermMemoryDraftStore(root);
    const draft = await draftStore.createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_apply_rebuild_failure" },
      response: { summary: "Rebuild failure", mutations: [mutation] },
    });
    const dirs = getLongTermMemoryDirectories(root);
    await mkdir(join(dirs.indexes, "embeddings.json"), { recursive: true });

    const result = await applyLongTermMemoryDraft(draft.id, { root, actor: "test", rebuildIndexes: true });

    assert.deepEqual(result.appliedMutationIds, [mutation.id]);
    assert.equal(result.draft.status, "accepted");
    assert.equal(result.indexRebuild.status, "failed");
    assert.match(result.indexRebuild.status === "failed" ? result.indexRebuild.error : "", /EISDIR|ENOTEMPTY|directory/i);
    assert.equal(
      (await storage.getNote("world_apply_rebuild_failure"))?.sections.facts?.text,
      "The eastern bell is silent.\n\nIt rings only when the archive opens.",
    );
    const storedDraft = await draftStore.getDraft(draft.id);
    assert.equal(storedDraft?.status, "accepted");
    assert.deepEqual(storedDraft?.appliedMutationIds, [mutation.id]);
    assert.equal(storedDraft?.indexRebuildStatus, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply refuses to merge a create_note into an existing note from another scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-scoped-create-guard-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await createDraftSourceNote(storage, "scene_source_second", {
      chatId: "chat_b",
      chatIds: ["chat_b"],
    });
    await storage.createNote(
      {
        id: "char_damo",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_a" },
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "Damo belongs to the first branch.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    const mutation: Extract<LtmDraftMutation, { kind: "create_note" }> = {
      id: randomUUID(),
      kind: "create_note",
      risk: "low",
      confidence: 0.95,
      summary: "Create scoped Damo",
      evidence: ["source_note:scene_source_second"],
      note: {
        id: "char_damo",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_b", chatIds: ["chat_b"] },
        tags: ["typed_memory"],
        keywords: [],
        links: [],
        sections: {
          facts: {
            text: "Damo belongs to the second branch.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_second"],
          },
        },
      },
    };
    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: { chatId: "chat_b", chatIds: ["chat_b"] },
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_second" },
      response: {
        summary: "Out-of-scope create collision",
        mutations: [mutation],
      },
    });

    await assert.rejects(
      applyLongTermMemoryDraft(draft.id, {
        root,
        actor: "test",
        rebuildIndexes: false,
      }),
      /existing note from another scope/,
    );

    const existing = await storage.getNote("char_damo");
    assert.equal(existing?.sections.facts?.text, "Damo belongs to the first branch.");
    assert.deepEqual(existing?.scope, { chatId: "chat_a", chatIds: ["chat_a"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction auto-apply still blocks source note mutations even when marked low risk", async () => {
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

test("source extraction auto-applies all low-risk typed-memory mutation kinds", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-auto-apply-low-risk-"));
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
            text: "Mara found the key, promised Jules help, and resolved the lantern thread.",
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
            text: "- Mara and Jules guarded the archive together.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_old"],
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "world_archive",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The archive has a hidden clock door.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_old"],
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
        keywords: [],
        links: [],
        sections: {
          event: {
            text: "Mara found the hidden archive key.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_test"],
          },
        },
      },
    };
    const updateMutation: Extract<LtmDraftMutation, { kind: "update_section" }> = {
      id: randomUUID(),
      kind: "update_section",
      risk: "low",
      confidence: 0.95,
      summary: "Update world fact",
      evidence: ["source_note:scene_source_test"],
      noteId: "world_archive",
      sectionKey: "facts",
      section: {
        text: "The archive has a hidden clock door opened by Mara's key.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_source_test"],
      },
    };
    const appendMutation: Extract<LtmDraftMutation, { kind: "append_section" }> = {
      id: randomUUID(),
      kind: "append_section",
      risk: "low",
      confidence: 0.95,
      summary: "Append relationship history",
      evidence: ["source_note:scene_source_test"],
      noteId: "rel_mara_jules",
      sectionKey: "history",
      text: "- Mara promised Jules help after the archive confrontation.",
    };
    const statusMutation: Extract<LtmDraftMutation, { kind: "set_status" }> = {
      id: randomUUID(),
      kind: "set_status",
      risk: "low",
      confidence: 0.95,
      summary: "Archive resolved thread",
      evidence: ["source_note:scene_source_test"],
      noteId: "thread_lantern",
      status: "archived",
    };
    const addLinkMutation: Extract<LtmDraftMutation, { kind: "add_link" }> = {
      id: randomUUID(),
      kind: "add_link",
      risk: "low",
      confidence: 0.95,
      summary: "Link relationship to timeline",
      evidence: ["source_note:scene_source_test"],
      noteId: "rel_mara_jules",
      link: { target: "timeline_archive_confrontation", relation: "occurred_in" },
    };

    const mutations = [createTimelineMutation, updateMutation, appendMutation, statusMutation, addLinkMutation];
    assert(mutations.every(isLowRiskSourceExtractionMutation));

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test" },
      response: {
        summary: "Low-risk typed memory draft",
        mutations,
      },
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      autoApplyLowRiskOnly: true,
      rebuildIndexes: false,
    });

    assert.deepEqual(new Set(result.appliedMutationIds), new Set(mutations.map((mutation) => mutation.id)));
    assert.deepEqual(result.skippedMutationIds, []);
    assert.equal(result.draft.status, "auto_applied");

    assert.equal((await storage.getNote("timeline_archive_confrontation"))?.type, "timeline_event");
    assert.equal(
      (await storage.getNote("world_archive"))?.sections.facts?.text,
      "The archive has a hidden clock door opened by Mara's key.",
    );
    assert.equal(
      (await storage.getNote("rel_mara_jules"))?.sections.history?.text.includes("promised Jules help"),
      true,
    );
    assert.equal((await storage.getNote("thread_lantern"))?.status, "archived");
    assert.equal(
      (await storage.getNote("rel_mara_jules"))?.links.some(
        (link) => link.target === "timeline_archive_confrontation" && link.relation === "occurred_in",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction auto-apply keeps medium-risk mutations pending in mixed drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-auto-apply-mixed-risk-"));
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
            text: "Mara found the key and her relationship with Jules changed.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const lowMutation = threadCreateMutation();
    const mediumMutation: Extract<LtmDraftMutation, { kind: "create_note" }> = {
      ...threadCreateMutation("Mara and Jules are cautious allies after the archive."),
      risk: "medium",
      note: {
        ...threadCreateMutation().note,
        id: "rel_mara_jules",
        type: "relationship",
        tags: ["typed_memory", "relationship_memory"],
        sections: {
          state: {
            text: "Mara and Jules are cautious allies after the archive.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_test"],
          },
        },
      },
    };

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test" },
      response: {
        summary: "Mixed risk draft",
        mutations: [lowMutation, mediumMutation],
      },
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      autoApplyLowRiskOnly: true,
      rebuildIndexes: false,
    });

    assert.deepEqual(result.appliedMutationIds, [lowMutation.id]);
    assert.deepEqual(result.skippedMutationIds, [mediumMutation.id]);
    assert.equal(result.draft.status, "pending");
    assert.equal(result.draft.applyState, "not_started");
    assert.deepEqual(result.draft.mutations.map((mutation) => mutation.id), [mediumMutation.id]);
    assert.equal((await storage.getNote(lowMutation.note.id))?.type, "thread");
    assert.equal(await storage.getNote("rel_mara_jules"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction auto-apply skips low-risk creates with embedded links to missing targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-auto-apply-missing-create-link-"));
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
            text: "Mara remembered the key and an absent event.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const baseMutation = threadCreateMutation("Mara remembered the key during the absent event.");
    const mutation: Extract<LtmDraftMutation, { kind: "create_note" }> = {
      ...baseMutation,
      note: {
        ...baseMutation.note,
        id: "thread_missing_link_target",
        links: [{ target: "timeline_absent_event", relation: "occurred_in" }],
        sections: {
          setup: {
            text: "Mara remembered the key during the absent event.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_test"],
          },
        },
      },
    };

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test" },
      response: {
        summary: "Missing embedded link target draft",
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
    assert.equal(await storage.getNote("thread_missing_link_target"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction auto-apply allows low-risk creates with embedded links to same-draft creates", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-auto-apply-same-draft-create-link-"));
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
            text: "Mara remembered the key during the archive confrontation.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const timelineMutation: Extract<LtmDraftMutation, { kind: "create_note" }> = {
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
        keywords: [],
        links: [],
        sections: {
          event: {
            text: "Mara remembered the key during the archive confrontation.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_test"],
          },
        },
      },
    };
    const baseThreadMutation = threadCreateMutation("Mara should follow up on the archive key.");
    const threadMutation: Extract<LtmDraftMutation, { kind: "create_note" }> = {
      ...baseThreadMutation,
      note: {
        ...baseThreadMutation.note,
        id: "thread_archive_key",
        links: [{ target: "timeline_archive_confrontation", relation: "triggered_by" }],
        sections: {
          setup: {
            text: "Mara should follow up on the archive key.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_source_test"],
          },
        },
      },
    };

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test" },
      response: {
        summary: "Same-draft embedded link target draft",
        mutations: [timelineMutation, threadMutation],
      },
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      autoApplyLowRiskOnly: true,
      rebuildIndexes: false,
    });

    assert.deepEqual(new Set(result.appliedMutationIds), new Set([timelineMutation.id, threadMutation.id]));
    assert.deepEqual(result.skippedMutationIds, []);
    assert.equal(result.draft.status, "auto_applied");
    assert.equal((await storage.getNote("timeline_archive_confrontation"))?.type, "timeline_event");
    assert.equal(
      (await storage.getNote("thread_archive_key"))?.links.some(
        (link) => link.target === "timeline_archive_confrontation" && link.relation === "triggered_by",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction accepts duplicate new note drafts by merging into the created note", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-duplicate-new-note-"));
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
            text: "Mara has a silver scar and senses old magic as a hum.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const firstResponse = compileLtmEvidenceUnits({
      units: [
        evidenceUnit("character_fact", {
          subjectId: "mara",
          sectionKey: "facts",
          text: "Mara has a silver scar.",
        }),
      ],
      existingNotes: [],
      scope: {},
      modes: ["roleplay"],
      createdAt: timestamp,
    });
    const secondResponse = compileLtmEvidenceUnits({
      units: [
        evidenceUnit("character_fact", {
          subjectId: "mara",
          sectionKey: "facts",
          text: "Mara senses old magic as a hum.",
        }),
      ],
      existingNotes: [],
      scope: {},
      modes: ["roleplay"],
      createdAt: timestamp,
    });

    const store = new LongTermMemoryDraftStore(root);
    const firstDraft = await store.createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test", sourceHash },
      response: firstResponse,
    });
    const secondDraft = await store.createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test", sourceHash },
      response: secondResponse,
    });

    const firstResult = await applyLongTermMemoryDraft(firstDraft.id, {
      root,
      actor: "test",
      rebuildIndexes: false,
    });
    const secondResult = await applyLongTermMemoryDraft(secondDraft.id, {
      root,
      actor: "test",
      rebuildIndexes: false,
    });

    const note = await storage.getNote("char_mara");
    assert.equal(firstResult.appliedMutationIds.length, 1);
    assert.equal(firstResult.draft.status, "accepted");
    assert.equal(secondResult.appliedMutationIds.length, 1);
    assert.equal(secondResult.draft.status, "accepted");
    assert.equal(note?.sections.facts?.text, "Mara senses old magic as a hum.");
    assert.equal(note?.sections.facts?.evidence?.includes("source_note:scene_source_test"), true);
    assert(note?.links.some((link) => link.target === "scene_source_test" && link.relation === "extracted_from"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction duplicate new state drafts refuse cross-scope create merges", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-duplicate-state-scope-"));
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
            text: "Mara is wounded, then steadies herself.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const firstResponse = compileLtmEvidenceUnits({
      units: [
        evidenceUnit("character_fact", {
          subjectId: "mara",
          text: "Mara is wounded.",
        }),
      ],
      existingNotes: [],
      scope: { chatId: "chat_a", characterIds: ["char_a"] },
      modes: ["roleplay"],
      createdAt: timestamp,
    });
    const secondResponse = compileLtmEvidenceUnits({
      units: [
        evidenceUnit("character_fact", {
          subjectId: "mara",
          text: "Mara steadies herself.",
        }),
      ],
      existingNotes: [],
      scope: { chatId: "chat_b", characterIds: ["char_b"] },
      modes: ["roleplay"],
      createdAt: timestamp,
    });

    const store = new LongTermMemoryDraftStore(root);
    const firstDraft = await store.createDraft({
      scope: { chatId: "chat_a", characterIds: ["char_a"] },
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test", sourceHash },
      response: firstResponse,
    });
    const secondDraft = await store.createDraft({
      scope: { chatId: "chat_b", characterIds: ["char_b"] },
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test", sourceHash },
      response: secondResponse,
    });

    await applyLongTermMemoryDraft(firstDraft.id, {
      root,
      actor: "test",
      rebuildIndexes: false,
    });
    await assert.rejects(
      applyLongTermMemoryDraft(secondDraft.id, {
        root,
        actor: "test",
        rebuildIndexes: false,
      }),
      /existing note from another scope/,
    );

    const note = await storage.getNote("char_mara");
    assert.equal(note?.sections.facts?.text, "Mara is wounded.");
    assert.deepEqual(note?.scope.chatIds, ["chat_a"]);
    assert.equal(note?.scope.chatId, "chat_a");
    assert.deepEqual(note?.scope.characterIds, ["char_a"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction auto-applies low-risk archived resolved memory status with content update", async () => {
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
    assert.equal(isLowRiskSourceExtractionMutation(statusMutation), true);

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

    assert.deepEqual(new Set(result.appliedMutationIds), new Set(response.mutations.map((mutation) => mutation.id)));
    assert.deepEqual(result.skippedMutationIds, []);
    assert.equal(result.draft.status, "auto_applied");

    const thread = await storage.getNote("thread_lantern");
    assert.equal(thread?.status, "archived");
    assert.equal(thread?.sections.summary?.text, "The lantern hum paid off when it revealed the archive door.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-thread resolved unit coerces to active and self-heals stuck resolved notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-coerce-resolved-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "rel_mara_jules",
        type: "relationship",
        status: "resolved",
        modes: ["roleplay"] as const,
        scope: {},
        tags: ["typed_memory", "relationship_memory"],
        links: [],
        sections: { history: { text: "Mara and Jules had a falling out.", updatedAt: timestamp } },
      },
      { suppressEvent: true },
    );

    const response = compileLtmEvidenceUnits({
      units: [
        evidenceUnit("relationship_state", {
          subjectId: "rel_mara_jules",
          sectionKey: "state",
          text: "Mara and Jules remain steady allies after the ordeal.",
          status: "active",
        }),
      ],
      existingNotes: [(await storage.getNote("rel_mara_jules"))!],
      scope: {},
      modes: ["roleplay"],
      createdAt: timestamp,
    });

    const statusMutation = response.mutations.find((m) => m.kind === "set_status") as
      | { kind: "set_status"; status: string }
      | undefined;
    assert(statusMutation, "Expected a set_status mutation to flip back to active");
    assert.equal(statusMutation.status, "active");

    const resolvedMutations = response.mutations.filter(
      (m) => m.kind === "set_status" && (m as { status: string }).status === "resolved",
    );
    assert.equal(resolvedMutations.length, 0, "No mutation should have resolved status");

    const sectionMutation = response.mutations.find(
      (m) => m.kind === "update_section" || m.kind === "append_section",
    );
    assert(sectionMutation, "Expected a section mutation to preserve the content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("net-new non-thread note from resolved unit starts as active", async () => {
  const response = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("world_fact", {
        subjectId: "sg_artifact",
        text: "The artifact glows when truth is spoken nearby.",
        status: "resolved",
      }),
    ],
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    createdAt: timestamp,
  });

  const createMutation = response.mutations.find((m) => m.kind === "create_note") as
    | { kind: "create_note"; note: { status: string } }
    | undefined;
  assert(createMutation, "Expected a create_note mutation");
  assert.equal(createMutation.note.status, "active", "Net-new non-thread note should be active, not resolved");
});

test("archived notes stay archived when targeted by active units", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-archived-sticky-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "char_test",
        type: "character",
        status: "archived" as const,
        modes: ["roleplay"] as const,
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: { facts: { text: "Test fact.", updatedAt: timestamp } },
      },
      { suppressEvent: true },
    );

    const response = compileLtmEvidenceUnits({
      units: [
        evidenceUnit("character_fact", {
          subjectId: "test",
          text: "Test fact updated.",
          status: "active",
        }),
      ],
      existingNotes: [(await storage.getNote("char_test"))!],
      scope: {},
      modes: ["roleplay"],
      createdAt: timestamp,
    });

    const statusMutation = response.mutations.find((m) => m.kind === "set_status");
    assert(
      !statusMutation,
      "Archived note should not emit a set_status mutation (archived is sticky)",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source extraction auto-apply includes low-risk link targets created in the same draft", async () => {
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
        keywords: [],
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

    assert.deepEqual(
      new Set(result.appliedMutationIds),
      new Set([createTimelineMutation.id, addTimelineLinkMutation.id]),
    );
    assert.deepEqual(result.skippedMutationIds, []);
    assert.equal(result.draft.status, "auto_applied");
    assert.equal((await storage.getNote("timeline_archive_confrontation"))?.type, "timeline_event");

    const relationship = await storage.getNote("rel_mara_jules");
    assert(
      relationship?.links.some(
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
    withKeywords({
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
    }),
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
        links: [{ target: "scene_source_links", relation: "evidenced_by" }],
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
    assert.equal(defaults.maxSourceTokens, DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS);
    assert.equal(defaults.maxExistingNoteTokens, DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS);
    assert.deepEqual(defaults.promptTemplates, []);
    assert.equal(defaults.activePromptTemplateId, null);

    await assert.rejects(() => updateLtmExtractionConfig({ extraInstruction: "Legacy instruction" }, root), /unrecognized/i);

    const updated = await updateLtmExtractionConfig(
      {
        reasoningEffort: "medium",
        verbosity: "high",
        maxOutputTokens: 4096,
        temperature: 0.25,
        maxSourceTokens: 3_000,
        maxExistingNoteTokens: 1_500,
        existingNoteMaxChunks: 8,
        existingNoteMaxTokens: 1600,
        promptTemplates: [
          {
            id: "compact",
            name: "Compact",
            prompt: "Use a compact extraction prompt.",
          },
        ],
        activePromptTemplateIdsByMode: {
          roleplay: "compact",
          conversation: "compact",
          game: "compact",
        },
      },
      root,
    );
    assert.equal(updated.reasoningEffort, "medium");
    assert.equal(updated.verbosity, "high");
    assert.equal(updated.maxOutputTokens, 4096);
    assert.equal(updated.temperature, 0.25);
    assert.equal(updated.maxSourceTokens, 3_000);
    assert.equal(updated.maxExistingNoteTokens, 1_500);
    assert.equal(updated.existingNoteMaxChunks, 8);
    assert.equal(updated.existingNoteMaxTokens, 1600);
    assert.equal(updated.systemPrompt, "Use a compact extraction prompt.");
    assert.equal(updated.promptTemplates.length, 1);
    assert.equal(updated.activePromptTemplateId, "compact");

    const dirs = getLongTermMemoryDirectories(root);
    const persisted = JSON.parse(await readFile(join(dirs.config, "extraction.json"), "utf8"));
    assert.equal(persisted.systemPrompt, undefined);
    assert.equal(persisted.maxSourceTokens, 3_000);
    assert.equal(persisted.maxExistingNoteTokens, 1_500);
    assert.deepEqual(persisted.promptTemplates, [
      {
        id: "compact",
        name: "Compact",
        prompt: "Use a compact extraction prompt.",
      },
    ]);
    assert.deepEqual(persisted.activePromptTemplateIdsByMode, {
      roleplay: "compact",
      conversation: "compact",
      game: "compact",
    });

    const reset = await updateLtmExtractionConfig({}, root);
    assert.equal(reset.reasoningEffort, "low");
    assert.equal(reset.verbosity, "low");
    assert.equal(reset.maxOutputTokens, DEFAULT_LTM_EXTRACTION_MAX_TOKENS);
    assert.equal(reset.activePromptTemplateId, null);
    assert.deepEqual(reset.promptTemplates, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ltm extraction config resolves prompts and active named options per mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-extraction-config-modes-"));
  try {
    const roleplayDefault = await getLtmExtractionConfig(root, "roleplay");
    const conversationDefault = await getLtmExtractionConfig(root, "conversation");
    const gameDefault = await getLtmExtractionConfig(root, "game");

    assert.equal(roleplayDefault.systemPrompt, DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE.roleplay);
    assert.equal(conversationDefault.systemPrompt, DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE.conversation);
    assert.equal(gameDefault.systemPrompt, DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE.game);
    assert.notEqual(roleplayDefault.systemPrompt, conversationDefault.systemPrompt);
    assert.notEqual(gameDefault.systemPrompt, conversationDefault.systemPrompt);

    await updateLtmExtractionConfig(
      {
        promptTemplates: [
          {
            id: "roleplay_template",
            name: "Roleplay template",
            prompt: "Roleplay template prompt.",
          },
          {
            id: "conversation_template",
            name: "Conversation template",
            prompt: "Conversation template prompt.",
          },
          {
            id: "game_template",
            name: "Game template",
            prompt: "Game template prompt.",
          },
        ],
        activePromptTemplateIdsByMode: {
          roleplay: "roleplay_template",
          conversation: "conversation_template",
          game: "game_template",
        },
      },
      root,
    );

    const roleplay = await getLtmExtractionConfig(root, "roleplay");
    const conversation = await getLtmExtractionConfig(root, "conversation");
    const game = await getLtmExtractionConfig(root, "game");

    assert.equal(roleplay.systemPrompt, "Roleplay template prompt.");
    assert.equal(conversation.systemPrompt, "Conversation template prompt.");
    assert.equal(game.systemPrompt, "Game template prompt.");
    assert.equal(roleplay.activePromptTemplateId, "roleplay_template");
    assert.equal(conversation.activePromptTemplateId, "conversation_template");
    assert.equal(game.activePromptTemplateId, "game_template");
    assert.deepEqual(game.activePromptTemplateIdsByMode, {
      roleplay: "roleplay_template",
      conversation: "conversation_template",
      game: "game_template",
    });

    await updateLtmExtractionConfig(
      {
        promptTemplates: [
          {
            id: "game_template",
            name: "Game template",
            prompt: "Game template prompt.",
          },
        ],
        activePromptTemplateIdsByMode: {
          conversation: "missing_template",
        },
      },
      root,
    );

    const stale = await getLtmExtractionConfig(root, "conversation");
    assert.equal(stale.systemPrompt, DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE.conversation);
    assert.equal(stale.activePromptTemplateId, null);
    assert.deepEqual(stale.activePromptTemplateIdsByMode, {});

    const dirs = getLongTermMemoryDirectories(root);
    const persisted = JSON.parse(await readFile(join(dirs.config, "extraction.json"), "utf8"));
    assert.equal(persisted.activePromptTemplateIdsByMode, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ltm extraction config migrates legacy prompts and active options safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-extraction-config-legacy-"));
  const legacyConfig = {
    version: 1,
    systemPrompt: "Legacy global extraction prompt.",
    systemPromptsByMode: {
      conversation: "Legacy conversation extraction prompt.",
    },
    promptTemplates: [
      {
        id: "game_only",
        name: "Game only",
        prompt: "Legacy game template prompt.",
        mode: "game",
      },
    ],
    activePromptTemplateId: "game_only",
  };

  try {
    const dirs = getLongTermMemoryDirectories(root);
    await mkdir(dirs.config, { recursive: true });
    await writeFile(join(dirs.config, "extraction.json"), JSON.stringify(legacyConfig), "utf8");

    const roleplay = await getLtmExtractionConfig(root, "roleplay");
    const conversation = await getLtmExtractionConfig(root, "conversation");
    const game = await getLtmExtractionConfig(root, "game");

    assert.equal(roleplay.systemPrompt, "Legacy global extraction prompt.");
    assert.equal(conversation.systemPrompt, "Legacy conversation extraction prompt.");
    assert.equal(game.systemPrompt, "Legacy game template prompt.");
    assert.equal(roleplay.activePromptTemplateId, "legacy_roleplay_system_prompt");
    assert.equal(conversation.activePromptTemplateId, "legacy_conversation_system_prompt");
    assert.equal(game.activePromptTemplateId, "game_only");
    assert.deepEqual(game.promptTemplates.find((template) => template.id === "game_only"), {
      id: "game_only",
      name: "Game only",
      prompt: "Legacy game template prompt.",
    });
    assert.deepEqual(game.activePromptTemplateIdsByMode, {
      roleplay: "legacy_roleplay_system_prompt",
      conversation: "legacy_conversation_system_prompt",
      game: "game_only",
    });

    await updateLtmExtractionConfig(legacyConfig, root);
    const persisted = JSON.parse(await readFile(join(dirs.config, "extraction.json"), "utf8"));
    assert.equal(persisted.systemPrompt, undefined);
    assert.equal(persisted.systemPromptsByMode, undefined);
    assert.equal(persisted.activePromptTemplateId, undefined);
    assert.equal(persisted.promptTemplates.some((template: Record<string, unknown>) => "mode" in template), false);
    assert.deepEqual(persisted.activePromptTemplateIdsByMode, {
      roleplay: "legacy_roleplay_system_prompt",
      conversation: "legacy_conversation_system_prompt",
      game: "game_only",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renameWithRetry retries transient rename failures", async () => {
  const attempts: string[] = [];
  const transientError = Object.assign(new Error("busy"), { code: "EPERM" });
  let callCount = 0;
  await renameWithRetry("draft.tmp", "draft.json", async (fromPath: string, toPath: string) => {
    attempts.push(`${fromPath}->${toPath}`);
    callCount += 1;
    if (callCount < 3) throw transientError;
  });

  assert.equal(callCount, 3);
  assert.deepEqual(attempts, [
    "draft.tmp->draft.json",
    "draft.tmp->draft.json",
    "draft.tmp->draft.json",
  ]);
});

test("renameWithRetry does not retry non-transient rename failures", async () => {
  let callCount = 0;
  const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });

  await assert.rejects(
    () =>
      renameWithRetry("draft.tmp", "draft.json", async () => {
        callCount += 1;
        throw missingError;
      }),
    missingError,
  );

  assert.equal(callCount, 1);
});

test("ltm global settings change recall styles without pinning old style weights", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-global-settings-"));
  try {
    const defaults = await getLtmGlobalSettings(root);
    assert.equal(defaults.enableLongTermMemory, true);
    assert.equal(defaults.longTermMemoryRecallStyle, "balanced");
    assert.equal(defaults.longTermMemorySemanticWeight, 0.6);
    assert.equal(defaults.longTermMemoryLexicalWeight, 0.3);
    assert.equal(defaults.longTermMemoryGraphWeight, 0.1);
    assert.equal(defaults.longTermMemoryKeywordWeight, 0.2);

    const story = await updateLtmGlobalSettings({ version: 1, longTermMemoryRecallStyle: "story" }, root);
    assert.equal(story.longTermMemoryRecallStyle, "story");
    assert.equal(story.longTermMemorySemanticWeight, 0.45);
    assert.equal(story.longTermMemoryLexicalWeight, 0.25);
    assert.equal(story.longTermMemoryGraphWeight, 0.35);
    assert.equal(story.longTermMemoryKeywordWeight, 0.25);

    const exact = await updateLtmGlobalSettings({ version: 1, longTermMemoryRecallStyle: "exact" }, root);
    assert.equal(exact.longTermMemoryRecallStyle, "exact");
    assert.equal(exact.longTermMemorySemanticWeight, 0.15);
    assert.equal(exact.longTermMemoryLexicalWeight, 1);
    assert.equal(exact.longTermMemoryGraphWeight, 0);
    assert.equal(exact.longTermMemoryKeywordWeight, 0.8);

    const overridden = await updateLtmGlobalSettings({ version: 1, longTermMemorySemanticWeight: 0.4 }, root);
    assert.equal(overridden.longTermMemoryRecallStyle, "exact");
    assert.equal(overridden.longTermMemorySemanticWeight, 0.4);
    assert.equal(overridden.longTermMemoryLexicalWeight, 1);

    const broad = await updateLtmGlobalSettings({ version: 1, longTermMemoryRecallStyle: "broad" }, root);
    assert.equal(broad.longTermMemoryRecallStyle, "broad");
    assert.equal(broad.longTermMemorySemanticWeight, 0.55);
    assert.equal(broad.longTermMemoryLexicalWeight, 0.2);
    assert.equal(broad.longTermMemoryGraphWeight, 0.8);
    assert.equal(broad.longTermMemoryKeywordWeight, 0.15);

    const broadOverride = await updateLtmGlobalSettings(
      { version: 1, longTermMemoryRecallStyle: "broad", longTermMemorySemanticWeight: 0.4 },
      root,
    );
    assert.equal(broadOverride.longTermMemoryRecallStyle, "broad");
    assert.equal(broadOverride.longTermMemorySemanticWeight, 0.4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ltm extraction config accepts reasoning effort none", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-extraction-config-none-"));
  try {
    const updated = await updateLtmExtractionConfig({ reasoningEffort: "none" }, root);
    assert.equal(updated.reasoningEffort, "none");

    const dirs = getLongTermMemoryDirectories(root);
    const persisted = JSON.parse(await readFile(join(dirs.config, "extraction.json"), "utf8"));
    assert.equal(persisted.reasoningEffort, "none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source note extraction sends the resolved prompt for the source mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-extraction-config-source-mode-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "source_conversation_mode",
        type: "source",
        status: "active",
        modes: ["conversation"],
        scope: {},
        tags: [],
        links: [],
        sections: {
          source: {
            text: "The user says they prefer slow weekend planning and remembers old cafe names.".repeat(10),
            updatedAt: timestamp,
            evidence: ["chat:conversation_test"],
          },
        },
      },
      { suppressEvent: true },
    );
    await updateLtmExtractionConfig(
      {
        promptTemplates: [
          {
            id: "conversation_source",
            name: "Conversation source",
            prompt: "Conversation source prompt.",
          },
        ],
        activePromptTemplateIdsByMode: {
          conversation: "conversation_source",
        },
      },
      root,
    );

    let systemPrompt = "";
    const provider = {
      maxTokensOverrideValue: 9999,
      chatComplete: async (messages: Array<{ role: string; content: string }>) => {
        systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
        return {
          content: JSON.stringify({ summary: "No units", units: [] }),
        };
      },
    } as any;

    await extractLongTermMemoryFromSourceNote({
      noteId: "source_conversation_mode",
      provider,
      model: "test-model",
      root,
      operationId: randomUUID(),
    });

    assert.equal(systemPrompt, "Conversation source prompt.");
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
        reasoningEffort: "high",
        verbosity: "medium",
        maxOutputTokens: 1024,
        temperature: 0.5,
        maxSourceTokens: 250,
        maxExistingNoteTokens: 250,
        promptTemplates: [
          {
            id: "template_compact",
            name: "Compact test template",
            prompt: "Return JSON with compact test units only.",
          },
        ],
        activePromptTemplateIdsByMode: {
          roleplay: "template_compact",
        },
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
    assert.equal(Object.prototype.hasOwnProperty.call(userPayload, "extraInstruction"), false);
    assert.equal(userPayload.sourceText, sourceText.trim());
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
  const sourceNote: LtmNote = withKeywords({
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
  });

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
  const sourceNote: LtmNote = withKeywords({
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
  });

  let userPayload: any;
  let chatOptions: any;
  let systemPrompt = "";
  const provider = {
    maxTokensOverrideValue: undefined,
    chatComplete: async (messages: Array<{ role: string; content: string }>, options: any) => {
      systemPrompt = messages.find((message) => message.role === "system")!.content;
      userPayload = JSON.parse(messages.find((message) => message.role === "user")!.content);
      chatOptions = options;
      return {
        content: JSON.stringify({
          summary: "One compact unit",
          units: [
            {
              id: randomUUID(),
              bucket: "timeline_event",
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
    units: "array of evidence unit objects, bounded by the completion token budget",
  });
  assert.equal(userPayload.unitFields.bucket, "one allowed stream value from allowedStreams");
  assert.equal(userPayload.unitFields.links, "real links only, otherwise []");
  assert.equal(userPayload.unitFields.sourceHash, sourceHash);
  assert.deepEqual(userPayload.streamScanOrder.slice(0, 4), [
    "timeline_event",
    "relationship_state",
    "thread",
    "character_fact",
  ]);
  assert.deepEqual(userPayload.allowedTimelineRelations, [
    "occurred_in",
    "triggered_by",
    "resolved_in",
    "evidenced_by",
    "caused_by",
    "affects_relationship",
    "affects_character",
  ]);
  assert.deepEqual(userPayload.requiredEvidence, ["source_note:scene_source_test", "chat:chat_test"]);
  assert.deepEqual(userPayload.allowedStreams, [
    "timeline_event",
    "character_fact",
    "relationship_state",
    "world_fact",
    "thread",
    "tone",
    "anchor",
  ]);
  assert.deepEqual(userPayload.streamDescriptions, {
    timeline_event: "source-summary scene/plot pivot, decision, action, discovery, fight outcome, promise, arrival, or departure; not the live current scene",
    character_fact: "durable character identity/trait/role/affiliation/backstory/belief/permanent status/development/ability/item/exact voice quote; not ordinary scene action or transient condition",
    relationship_state: "relationship state or dimension change backed by a caused_by event link or existing relationship note",
    world_fact: "stable world/lore fact",
    thread: "unresolved situation, question, tension, or goal with a clear future resolver",
    tone: "durable world/session atmospheric register or recurring style only",
    anchor: "recurring motif, planted callback, or continuity anchor",
  });
  const payloadJson = JSON.stringify(userPayload);
  assert(!payloadJson.includes("allowedBuckets"));
  assert(!payloadJson.includes("bucketScanOrder"));
  assert(!payloadJson.includes("\"buckets\""));
  assert(!payloadJson.includes("relationship_arc"));
  assert(!payloadJson.includes("current_scene"));
  assert(!payloadJson.includes("current_state"));
  assert(!payloadJson.includes("boundary"));
  assert(!payloadJson.includes("preference"));
  assert(!payloadJson.includes("550e8400-e29b-41d4-a716-446655440000"));
  assert(!payloadJson.includes("lowercase_snake_case_scope_id"));
  assert(!payloadJson.includes("target_note_id"));
  assert(!payloadJson.includes("optional note for deterministic compiler"));
  assert(
    systemPrompt.includes("Do not include thinking, analysis, markdown, or <think> tags. Output JSON object only."),
  );
  assert.equal(chatOptions.maxTokens, DEFAULT_LTM_EXTRACTION_MAX_TOKENS);
  assert.equal(chatOptions.reasoningEffort, "low");
  assert.equal(chatOptions.verbosity, "low");
  assert.equal(chatOptions.stream, true);
});

test("default ltm extraction prompt forbids thinking and non-json wrapper text", () => {
  assert(
    DEFAULT_LTM_EXTRACTION_PROMPT.includes(
      "Do not include thinking, analysis, markdown, or <think> tags. Output JSON object only.",
    ),
  );
  assert(DEFAULT_LTM_EXTRACTION_PROMPT.includes("Extract every distinct durable memory stream supported by the source."));
});

test("evidence unit extraction retries reasoning none with low when provider rejects it", async () => {
  const sourceNote: LtmNote = withKeywords({
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
        text: "Mara kept the archive key as a future problem.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  });
  const reasoningEfforts: string[] = [];
  const provider = {
    maxTokensOverrideValue: undefined,
    chatComplete: async (_messages: ChatMessage[], options: any) => {
      reasoningEfforts.push(options.reasoningEffort);
      if (options.reasoningEffort === "none") {
        throw new Error("OpenAI API error 400: unsupported reasoning_effort none");
      }
      return {
        content: JSON.stringify({ summary: "No units", units: [] }),
      };
    },
  } as any;

  const parsed = await runLongTermMemoryEvidenceUnitExtraction({
    sourceNote,
    sourceText: sourceNote.sections.source!.text,
    existingNotes: [],
    provider,
    model: "test-model",
    scope: {},
    modes: ["roleplay"],
    sourceHash,
    reasoningEffort: "none",
    operationId: randomUUID(),
  });

  assert.deepEqual(reasoningEfforts, ["none", "low"]);
  assert.deepEqual(parsed.response.units, []);
});

test("evidence unit extraction accepts and compiles multiple typed buckets", async () => {
  const sourceNote: LtmNote = withKeywords({
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
  });

  const provider = {
    maxTokensOverrideValue: undefined,
    chatComplete: async () => ({
      content: JSON.stringify({
        summary: "Three compact units across relationship, thread, and world buckets",
        units: [
          {
            id: randomUUID(),
            bucket: "timeline_event",
            subjectId: "tower_key_trust",
            sectionKey: "event",
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
  assert.deepEqual(new Set(createdTypes), new Set(["timeline_event", "thread", "world"]));
});

test("evidence unit extraction recovers a truncated json response", async () => {
  const sourceNote: LtmNote = withKeywords({
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
  });

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
  const sourceNote: LtmNote = withKeywords({
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
  });

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
  assert.notEqual(result.response.units[0]?.id, recoveredUnitId);
  assert.match(
    result.response.units[0]?.id ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(result.response.units[0]?.bucket, "thread");
  assert.equal(result.response.units[0]?.text, "The lantern hum should pay off later.");
});

test("evidence unit extraction throws on empty/garbage response", async () => {
  const sourceNote: LtmNote = withKeywords({
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
  });

  const provider = {
    maxTokensOverrideValue: undefined,
    chatComplete: async () => ({ content: "```json\n{\n  \ngarbage not even close to json\n" }),
  } as any;

  await assert.rejects(
    () =>
      runLongTermMemoryEvidenceUnitExtraction({
        sourceNote,
        sourceText: sourceNote.sections.source!.text,
        existingNotes: [],
        provider,
        model: "test-model",
        scope: {},
        modes: ["roleplay"],
        sourceHash,
      }),
  );
});

test("evidence unit extraction validation rejects copied placeholder values", () => {
  const sourceNote: LtmNote = withKeywords({
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
  });
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
        links: [{ target: "target_note_id", relation: "involves" }],
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

test("source-summary extraction validation drops transient character state candidates", () => {
  const sourceNote: LtmNote = withKeywords({
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
        text: "Mara is wounded but steadies herself before entering the archive.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  });

  const compiled = compileEvidenceUnitExtraction({
    unitResponse: {
      summary: "Transient condition",
      units: [
        evidenceUnit("character_fact", {
          subjectId: "mara",
          sectionKey: "current_state",
          text: "Mara is wounded but steadies herself before entering the archive.",
          evidence: ["source_note:scene_source_test"],
        }),
      ],
    },
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });

  assert.equal(compiled.compiledResponse.mutations.length, 0);
  assert.deepEqual(compiled.outcome.droppedCandidates.map((candidate) => candidate.reason), ["unsupported_bucket"]);
  assert(
    compiled.diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" && diagnostic.code === "candidate_dropped_unsupported_bucket",
    ),
  );
});

test("source-summary extraction validation drops event-shaped character facts but keeps developments", () => {
  const sourceNote: LtmNote = withKeywords({
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
        text: "Mara entered the archive. Mara permanently lost her left eye.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  });

  const compiled = compileEvidenceUnitExtraction({
    unitResponse: {
      summary: "Action and development",
      units: [
        evidenceUnit("character_fact", {
          subjectId: "mara",
          sectionKey: "facts",
          text: "Mara entered the archive.",
          evidence: ["source_note:scene_source_test"],
        }),
        evidenceUnit("character_fact", {
          subjectId: "mara",
          sectionKey: "developments",
          text: "Mara permanently lost her left eye.",
          evidence: ["source_note:scene_source_test"],
        }),
      ],
    },
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });

  assert.deepEqual(compiled.outcome.droppedCandidates.map((candidate) => candidate.reason), ["unsupported_bucket"]);
  const droppedDiagnostic = compiled.diagnostics.find(
    (diagnostic) => diagnostic.code === "candidate_dropped_unsupported_bucket",
  );
  assert.equal(droppedDiagnostic?.details?.validatorCode, "event_shaped_character_fact");
  const createCharacter = compiled.compiledResponse.mutations.find(
    (mutation) => mutation.kind === "create_note" && mutation.note.id === "char_mara",
  );
  assert(createCharacter?.kind === "create_note");
  assert.equal(createCharacter.note.sections.developments?.text, "Mara permanently lost her left eye.");
  assert.equal(createCharacter.note.sections.facts, undefined);
});

test("relationship state candidates require relationship history support", () => {
  const sourceNote: LtmNote = withKeywords({
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
        text: "Mara trusts Jules after he returns the archive key.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  });

  const unsupported = compileEvidenceUnitExtraction({
    unitResponse: {
      summary: "Unsupported state",
      units: [
        evidenceUnit("relationship_state", {
          subjectId: "mara_jules",
          sectionKey: "state",
          text: "Mara and Jules are rebuilding trust.",
          evidence: ["source_note:scene_source_test"],
        }),
      ],
    },
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });
  assert.equal(unsupported.compiledResponse.mutations.length, 0);
  assert.deepEqual(unsupported.outcome.droppedCandidates.map((candidate) => candidate.reason), ["unsupported_bucket"]);

  const supported = compileEvidenceUnitExtraction({
    unitResponse: {
      summary: "Supported state",
      units: [
        evidenceUnit("timeline_event", {
          subjectId: "archive_key_returned",
          sectionKey: "event",
          text: "Mara trusted Jules after he returned the archive key.",
          evidence: ["source_note:scene_source_test"],
        }),
        evidenceUnit("relationship_state", {
          subjectId: "mara_jules",
          sectionKey: "state",
          text: "Mara and Jules are rebuilding trust.",
          evidence: ["source_note:scene_source_test"],
          links: [{ target: "timeline_archive_key_returned", relation: "caused_by" }],
        }),
      ],
    },
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });
  assert.deepEqual(supported.outcome.droppedCandidates, []);
  const createRelationship = supported.compiledResponse.mutations.find(
    (mutation) => mutation.kind === "create_note" && mutation.note.id === "rel_mara_jules",
  );
  assert(createRelationship?.kind === "create_note");
  assert.equal(createRelationship.note.sections.state?.text, "Mara and Jules are rebuilding trust.");
});

test("relationship state support ignores same-pass events dropped during validation", () => {
  const sourceNote: LtmNote = withKeywords({
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
        text: "Mara trusts Jules after he returns the archive key.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  });

  const compiled = compileEvidenceUnitExtraction({
    unitResponse: {
      summary: "Invalid support",
      units: [
        evidenceUnit("timeline_event", {
          subjectId: "archive_key_returned",
          sectionKey: "event",
          text: "Mara trusted Jules after he returned the archive key.",
          evidence: ["source_note:wrong_source"],
        }),
        evidenceUnit("relationship_state", {
          subjectId: "mara_jules",
          sectionKey: "state",
          text: "Mara and Jules are rebuilding trust.",
          evidence: ["source_note:scene_source_test"],
          links: [{ target: "timeline_archive_key_returned", relation: "caused_by" }],
        }),
      ],
    },
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });

  assert.equal(compiled.compiledResponse.mutations.length, 0);
  assert.deepEqual(compiled.outcome.droppedCandidates.map((candidate) => candidate.reason), [
    "missing_source_evidence",
    "unsupported_bucket",
  ]);
});

test("source-summary thread validation accepts explicit resolver phrasing", () => {
  const sourceNote: LtmNote = withKeywords({
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
          "The standing next-week library date still needed a follow-up; the resolver was the repeat meeting.",
          "Rika's emotional fixation on Damo kept intensifying; the resolver was the fallout cooling or a confession.",
          "The hallway gossip chain about Rika and Damo was still spreading; the resolver was the rumor being confronted or dying down.",
          "Mika's barrage of texts could keep amplifying the social fallout; the resolver was a calmer explanation or update.",
        ].join(" "),
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  });

  const compiled = compileEvidenceUnitExtraction({
    unitResponse: {
      summary: "Callbacks",
      units: [
        evidenceUnit("thread", {
          subjectId: "damo_rika",
          sectionKey: "next_week_date",
          text: "[CALLBACK] The standing next-week library date still needed a follow-up; the resolver was the repeat meeting.",
          evidence: ["source_note:scene_source_test"],
        }),
        evidenceUnit("thread", {
          subjectId: "rika_mika_fallout",
          sectionKey: "emotional_fallout",
          text: "[CALLBACK] Rika's emotional fixation on Damo kept intensifying; the resolver was the fallout cooling or a confession.",
          evidence: ["source_note:scene_source_test"],
        }),
        evidenceUnit("thread", {
          subjectId: "hallway_gossip",
          sectionKey: "rumor_chain",
          text: "[CALLBACK] The hallway gossip chain about Rika and Damo was still spreading; the resolver was the rumor being confronted or dying down.",
          evidence: ["source_note:scene_source_test"],
        }),
        evidenceUnit("thread", {
          subjectId: "mika_texts",
          sectionKey: "text_barrage",
          text: "[CALLBACK] Mika's barrage of texts could keep amplifying the social fallout; the resolver was a calmer explanation or update.",
          evidence: ["source_note:scene_source_test"],
        }),
      ],
    },
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });

  assert.deepEqual(compiled.outcome.droppedCandidates, []);
  assert.equal(compiled.compiledResponse.mutations.length, 4);
});

test("source-summary thread validation still drops unresolved threads without a resolver", () => {
  const sourceNote: LtmNote = withKeywords({
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
        text: "The library date lingered.",
        updatedAt: timestamp,
        evidence: ["chat:chat_test"],
      },
    },
    version: 1,
  });

  const compiled = compileEvidenceUnitExtraction({
    unitResponse: {
      summary: "Vague thread",
      units: [
        evidenceUnit("thread", {
          subjectId: "damo_rika",
          sectionKey: "next_week_date",
          text: "The library date lingered.",
          evidence: ["source_note:scene_source_test"],
        }),
      ],
    },
    sourceText: sourceNote.sections.source!.text,
    sourceNote,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    sourceHash,
  });

  assert.equal(compiled.compiledResponse.mutations.length, 0);
  assert.deepEqual(compiled.outcome.droppedCandidates.map((candidate) => candidate.reason), ["unsupported_bucket"]);
});

test("evidence unit compiler returns all suggested changes without a draft cap", () => {
  const units = Array.from({ length: 30 }, (_, index) =>
    evidenceUnit("world_fact", {
      subjectId: `cap_test_${index + 1}`,
      sectionKey: "facts",
      text: `Memory fact ${index + 1} is durable.`,
      evidence: ["source_note:scene_source_test"],
      sourceHash,
    }),
  );

  const compiled = compileLtmEvidenceUnits({
    units,
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    mode: "roleplay",
    summary: "Many durable facts",
  });

  assert.equal(compiled.mutations.length, 30);
  assert.equal(compiled.suggestions.generated, 30);
  assert.equal(compiled.suggestions.returned, 30);
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
              links: [{ target: "target_note_id", relation: "involves" }],
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
  const sourceNote: LtmNote = withKeywords({
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
  });
  const typedNote: LtmNote = withKeywords({
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
  });

  assert.deepEqual(
    chunkNotes([sourceNote, typedNote]).map((chunk) => chunk.noteId),
    ["char_mara"],
  );
  assert.deepEqual(
    chunkNotes([sourceNote, typedNote], { sourceNotesOnly: true }).map((chunk) => chunk.noteId),
    ["scene_source_test"],
  );
});

test("typed rebuild updates typed indexes without rewriting source audit indexes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-typed-rebuild-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "char_typed_rebuild",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "Typed rebuild seed.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "scene_source_rebuild",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary", "chat_summary"],
        links: [],
        sections: {
          source: {
            text: "Source rebuild seed.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    const sourceBefore = await readJsonText(join(dirs.indexes, "source-metadata.json"));

    await storage.updateNote(
      "char_typed_rebuild",
      {
        sections: {
          facts: {
            text: "Typed rebuild seed updated.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    await rebuildLongTermMemoryIndexes({ root, scope: "typed", localEmbedder: async (texts) => texts.map(() => []) });
    const sourceAfter = await readJsonText(join(dirs.indexes, "source-metadata.json"));
    const typedAfter = JSON.parse(await readJsonText(join(dirs.indexes, "metadata.json"))) as {
      chunks: Record<string, { noteId: string }>;
    };

    assert.equal(sourceAfter, sourceBefore);
    assert(Object.values(typedAfter.chunks).some((chunk) => chunk.noteId === "char_typed_rebuild"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source rebuild refreshes source audit indexes without changing typed metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-source-rebuild-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "char_source_rebuild",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "Typed source rebuild seed.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "scene_source_refresh",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary", "chat_summary"],
        links: [],
        sections: {
          source: {
            text: "Source refresh seed.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    const typedBefore = await readJsonText(join(dirs.indexes, "metadata.json"));

    await storage.updateNote(
      "scene_source_refresh",
      {
        sections: {
          source: {
            text: "Source refresh seed updated.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    await rebuildLongTermMemoryIndexes({ root, scope: "source", localEmbedder: async (texts) => texts.map(() => []) });
    const typedAfter = await readJsonText(join(dirs.indexes, "metadata.json"));
    const sourceAfter = JSON.parse(await readJsonText(join(dirs.indexes, "source-metadata.json"))) as {
      chunks: Record<string, { noteId: string }>;
    };

    assert.equal(typedAfter, typedBefore);
    assert(Object.values(sourceAfter.chunks).some((chunk) => chunk.noteId === "scene_source_refresh"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archived notes remain chunked regardless of status", () => {
  const archivedNote: LtmNote = withKeywords({
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
  });

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
        links: [{ target: "world_active_neighbor", relation: "involves" }],
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
        links: [{ target: "world_archive_sealed", relation: "involves" }],
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

test("typed note type changes move vault file and preserve display title", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-type-move-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "world_poppy_promise",
        title: "Poppy chapel promise",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The promise matters later.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    const updated = await storage.updateNote(
      "world_poppy_promise",
      { type: "thread" },
      { suppressEvent: true },
    );

    assert.equal(updated.id, "thread_poppy_promise");
    assert.equal(updated.type, "thread");
    assert.equal(updated.title, "Poppy chapel promise");
    assert.equal(updated.version, 2);
    assert.equal(await storage.getNote("world_poppy_promise"), null);
    assert.equal((await storage.getNote("thread_poppy_promise"))?.sections.facts?.text, "The promise matters later.");
    const dirs = getLongTermMemoryDirectories(root);
    assert.rejects(() => readFile(join(dirs.vault, "world", "world_poppy_promise.json"), "utf8"));
    assert(JSON.parse(await readFile(join(dirs.vault, "threads", "thread_poppy_promise.json"), "utf8")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed note type changes derive valid ids for special world ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-type-rules-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "rules",
        title: "Table rules",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "Use table rules.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    const updated = await storage.updateNote("rules", { type: "thread" }, { suppressEvent: true });

    assert.equal(updated.id, "thread_rules");
    assert.equal(updated.type, "thread");
    assert.equal(await storage.getNote("rules"), null);
    assert.equal((await storage.getNote("thread_rules"))?.title, "Table rules");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed note type changes rewrite note links and pending draft references", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-type-reference-move-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const draftStore = new LongTermMemoryDraftStore(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary", "chat_summary"],
        links: [],
        sections: {
          source: {
            text: "Source note for pending draft.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "world_reference_target",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The reference target.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "char_reference_holder",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [{ target: "world_reference_target", relation: "involves" }],
        sections: {
          facts: {
            text: "Holds a link.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    const draft = await draftStore.createDraft({
      source: { sourceNoteId: "scene_source_test" },
      modes: ["roleplay"],
      response: {
        summary: "Pending mutation references the target.",
        mutations: [
          {
            id: randomUUID(),
            kind: "append_section",
            noteId: "world_reference_target",
            sectionKey: "facts",
            text: "Pending text.",
            risk: "medium",
            confidence: 0.7,
            summary: "Append target",
            evidence: ["source_note:scene_source_test"],
          },
          {
            id: randomUUID(),
            kind: "add_link",
            noteId: "char_reference_holder",
            link: { target: "world_reference_target", relation: "involves" },
            risk: "medium",
            confidence: 0.7,
            summary: "Link target",
            evidence: ["source_note:scene_source_test"],
          },
        ],
      },
    });

    await storage.updateNote("world_reference_target", { type: "thread" }, { suppressEvent: true });

    const holder = await storage.getNote("char_reference_holder");
    assert.deepEqual(holder?.links, [{ target: "thread_reference_target", relation: "involves" }]);
    const rewrittenDraft = await draftStore.getDraft(draft.id);
    assert.equal(rewrittenDraft?.mutations[0]?.kind, "append_section");
    assert.equal(
      rewrittenDraft?.mutations[0]?.kind === "append_section" ? rewrittenDraft.mutations[0].noteId : null,
      "thread_reference_target",
    );
    assert.equal(rewrittenDraft?.mutations[1]?.kind, "add_link");
    assert.equal(
      rewrittenDraft?.mutations[1]?.kind === "add_link" ? rewrittenDraft.mutations[1].link.target : null,
      "thread_reference_target",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk skip removes only selected pending draft mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-bulk-skip-subset-"));
  try {
    const draftStore = new LongTermMemoryDraftStore(root);
    const draft = await draftStore.createDraft({
      source: { sourceNoteId: "scene_source_test" },
      modes: ["roleplay"],
      response: {
        summary: "Pending suggestions",
        mutations: [
          {
            id: randomUUID(),
            kind: "create_note",
            risk: "medium",
            confidence: 0.85,
            summary: "Create Mara note",
            evidence: ["source_note:scene_source_test"],
            note: {
              id: "char_mara",
              type: "character",
              status: "active",
              modes: ["roleplay"],
              scope: {},
              tags: ["typed_memory"],
              keywords: [],
              links: [],
              sections: {
                facts: {
                  text: "Mara keeps a wax-sealed notebook.",
                  updatedAt: timestamp,
                  evidence: ["source_note:scene_source_test"],
                },
              },
            },
          },
          {
            id: randomUUID(),
            kind: "append_section",
            noteId: "thread_watchtower",
            sectionKey: "facts",
            text: "The watchtower bell cracked at dusk.",
            risk: "medium",
            confidence: 0.8,
            summary: "Append tower detail",
            evidence: ["source_note:scene_source_test"],
          },
        ],
      },
    });

    const skippedId = draft.mutations[0]!.id;
    const keptId = draft.mutations[1]!.id;
    const result = await draftStore.withDraftLock(draft.id, () => draftStore.deleteDraftMutations(draft.id, [skippedId]));

    assert.equal(result.deleted, true);
    assert.equal(result.draft?.status, "pending");
    assert.deepEqual(result.draft?.mutations.map((mutation) => mutation.id), [keptId]);

    const persisted = await draftStore.getDraft(draft.id);
    assert.deepEqual(persisted?.mutations.map((mutation) => mutation.id), [keptId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk skip deletes draft when all pending mutations are removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-bulk-skip-all-"));
  try {
    const draftStore = new LongTermMemoryDraftStore(root);
    const draft = await draftStore.createDraft({
      source: { sourceNoteId: "scene_source_test" },
      modes: ["roleplay"],
      response: {
        summary: "Pending suggestions",
        mutations: [
          {
            id: randomUUID(),
            kind: "append_section",
            noteId: "thread_watchtower",
            sectionKey: "facts",
            text: "The bell rope frayed long ago.",
            risk: "medium",
            confidence: 0.8,
            summary: "Append tower detail",
            evidence: ["source_note:scene_source_test"],
          },
        ],
      },
    });

    const result = await draftStore.withDraftLock(draft.id, () =>
      draftStore.deleteDraftMutations(
        draft.id,
        draft.mutations.map((mutation) => mutation.id),
      ),
    );

    assert.equal(result.deleted, true);
    assert.equal(result.draft, null);
    assert.equal(await draftStore.getDraft(draft.id), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk skip reports the same not-pending conflict reason as single skip", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-bulk-skip-conflict-"));
  try {
    const draftStore = new LongTermMemoryDraftStore(root);
    const draft = await draftStore.createDraft({
      source: { sourceNoteId: "scene_source_test" },
      modes: ["roleplay"],
      response: {
        summary: "Pending suggestions",
        mutations: [
          {
            id: randomUUID(),
            kind: "append_section",
            noteId: "thread_watchtower",
            sectionKey: "facts",
            text: "The bell rope frayed long ago.",
            risk: "medium",
            confidence: 0.8,
            summary: "Append tower detail",
            evidence: ["source_note:scene_source_test"],
          },
        ],
      },
    });

    await draftStore.updateDraftStatus(draft.id, "accepted");

    const singleSkip = await draftStore.withDraftLock(draft.id, () =>
      draftStore.deleteDraftMutation(draft.id, draft.mutations[0]!.id),
    );
    const bulkSkip = await draftStore.withDraftLock(draft.id, () =>
      draftStore.deleteDraftMutations(draft.id, [draft.mutations[0]!.id]),
    );

    assert.equal(singleSkip.deleted, false);
    assert.equal(singleSkip.reason, "not_pending");
    assert.equal(bulkSkip.deleted, false);
    assert.equal(bulkSkip.reason, "not_pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk skip route validates payloads and preserves route conflict behavior", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-bulk-skip-route-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousBasicAuthUser = process.env.BASIC_AUTH_USER;
  const previousBasicAuthPass = process.env.BASIC_AUTH_PASS;
  const previousAdminSecret = process.env.ADMIN_SECRET;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;

  try {
    app = await buildApp();
    const draftStore = new LongTermMemoryDraftStore(join(dataDir, "long-term-memory"));
    const draft = await draftStore.createDraft({
      source: { sourceNoteId: "scene_source_test" },
      modes: ["roleplay"],
      response: {
        summary: "Pending suggestions",
        mutations: [
          {
            id: randomUUID(),
            kind: "append_section",
            noteId: "thread_watchtower",
            sectionKey: "facts",
            text: "The bell rope frayed long ago.",
            risk: "medium",
            confidence: 0.8,
            summary: "Append tower detail",
            evidence: ["source_note:scene_source_test"],
          },
          {
            id: randomUUID(),
            kind: "set_status",
            noteId: "thread_watchtower",
            status: "resolved",
            risk: "medium",
            confidence: 0.75,
            summary: "Resolve tower detail",
            evidence: ["source_note:scene_source_test"],
          },
        ],
      },
    });

    const malformed = await app.inject({
      method: "POST",
      url: `/api/long-term-memory/drafts/${draft.id}/skip`,
      payload: {},
      remoteAddress: "127.0.0.1",
    });
    assert.equal(malformed.statusCode, 400);

    const unknown = await app.inject({
      method: "POST",
      url: `/api/long-term-memory/drafts/${draft.id}/skip`,
      payload: { mutationIds: [randomUUID()] },
      remoteAddress: "127.0.0.1",
    });
    assert.equal(unknown.statusCode, 404);

    const success = await app.inject({
      method: "POST",
      url: `/api/long-term-memory/drafts/${draft.id}/skip`,
      payload: { mutationIds: [draft.mutations[0]!.id] },
      remoteAddress: "127.0.0.1",
    });
    assert.equal(success.statusCode, 200);
    const successBody = JSON.parse(success.body) as {
      deleted: boolean;
      draftId: string;
      mutationIds: string[];
      draft: { status: string; mutations: Array<{ id: string }> } | null;
    };
    assert.equal(successBody.deleted, true);
    assert.equal(successBody.draftId, draft.id);
    assert.deepEqual(successBody.mutationIds, [draft.mutations[0]!.id]);
    assert.equal(successBody.draft?.status, "pending");
    assert.deepEqual(successBody.draft?.mutations.map((mutation) => mutation.id), [draft.mutations[1]!.id]);

    await draftStore.updateDraftStatus(draft.id, "accepted");
    const conflict = await app.inject({
      method: "POST",
      url: `/api/long-term-memory/drafts/${draft.id}/skip`,
      payload: { mutationIds: [draft.mutations[1]!.id] },
      remoteAddress: "127.0.0.1",
    });
    assert.equal(conflict.statusCode, 409);
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousBasicAuthUser === undefined) delete process.env.BASIC_AUTH_USER;
    else process.env.BASIC_AUTH_USER = previousBasicAuthUser;
    if (previousBasicAuthPass === undefined) delete process.env.BASIC_AUTH_PASS;
    else process.env.BASIC_AUTH_PASS = previousBasicAuthPass;
    if (previousAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = previousAdminSecret;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("typed note type change preflights affected drafts before moving files", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-type-draft-preflight-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const dirs = getLongTermMemoryDirectories(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary", "chat_summary"],
        links: [],
        sections: {
          source: {
            text: "Source note for malformed pending draft.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "world_preflight_target",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The target should not move.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await writeFile(
      join(dirs.drafts, `${randomUUID()}.json`),
      JSON.stringify({
        id: randomUUID(),
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
        source: { sourceNoteId: "scene_source_test" },
        scope: {},
        modes: ["roleplay"],
        summary: "Malformed affected draft",
        mutations: [
          {
            id: randomUUID(),
            kind: "append_section",
            noteId: "world_preflight_target",
            sectionKey: "facts",
            text: "Would be rewritten.",
            risk: "medium",
            confidence: 0.7,
            summary: "Append target",
            evidence: [],
          },
        ],
      }),
    );

    await assert.rejects(
      () => storage.updateNote("world_preflight_target", { type: "thread" }, { suppressEvent: true }),
      /evidence/i,
    );
    assert.equal((await storage.getNote("world_preflight_target"))?.type, "world");
    assert.equal(await storage.getNote("thread_preflight_target"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-like notes reject type changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-source-type-reject-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_locked",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary", "chat_summary"],
        links: [],
        sections: {
          source: {
            text: "Source-like memory.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    await assert.rejects(
      () => storage.updateNote("scene_source_locked", { type: "thread" }, { suppressEvent: true }),
      /source notes cannot change type/,
    );
    assert.equal((await storage.getNote("scene_source_locked"))?.type, "scene");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("imported chat summary scene notes remain editable typed memories", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-imported-chat-summary-type-editable-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_imported_chat_summary_locked",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["imported_chat_summary"],
        links: [],
        sections: {
          source: {
            text: "Imported chat summary.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    const updated = await storage.updateNote(
      "scene_imported_chat_summary_locked",
      { type: "thread" },
      { suppressEvent: true },
    );
    assert.equal(updated.id, "thread_imported_chat_summary_locked");
    assert.equal(updated.type, "thread");
    assert.equal(await storage.getNote("scene_imported_chat_summary_locked"), null);
    assert.equal((await storage.getNote("thread_imported_chat_summary_locked"))?.type, "thread");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft apply rebuilds typed indexes and keeps source audit indexes intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-draft-typed-rebuild-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "thread_typed_rebuild",
        type: "thread",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          setup: {
            text: "Typed draft seed.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "scene_source_rebuild_draft",
        type: "scene",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary", "chat_summary"],
        links: [],
        sections: {
          source: {
            text: "Draft source seed.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    await retrieveLongTermMemory({
      root,
      queryText: "Typed draft seed.",
      localEmbedder: async (texts) => texts.map(() => []),
    });
    const dirs = getLongTermMemoryDirectories(root);
    const sourceBefore = await readJsonText(join(dirs.indexes, "source-metadata.json"));

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_rebuild_draft" },
      response: {
        summary: "Typed draft apply",
        mutations: [
          {
            id: randomUUID(),
            kind: "update_section",
            noteId: "thread_typed_rebuild",
            sectionKey: "setup",
            section: {
              text: "Typed draft seed updated.",
              updatedAt: timestamp,
            },
            evidence: ["source_note:scene_source_rebuild_draft"],
            confidence: 0.9,
            risk: "low",
            summary: "Update typed draft seed",
          } satisfies Extract<LtmDraftMutation, { kind: "update_section" }>,
        ],
      },
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      rebuildIndexes: true,
    });

    const sourceAfter = await readJsonText(join(dirs.indexes, "source-metadata.json"));
    const typedSearch = await retrieveLongTermMemory({
      root,
      queryText: "Typed draft seed updated.",
      localEmbedder: async (texts) => texts.map(() => []),
    });

    assert.deepEqual(result.appliedMutationIds.length, 1);
    assert.equal(result.indexRebuild.status, "succeeded");
    assert.equal(result.draft.indexRebuildStatus, "succeeded");
    assert.equal(sourceAfter, sourceBefore);
    assert(typedSearch.chunks.some((chunk) => chunk.chunk.noteId === "thread_typed_rebuild"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence unit compiler maps buckets to typed memory draft mutations", () => {
  const cases: Array<[LtmEvidenceUnit["bucket"], string, string]> = [
    ["timeline_event", "timeline_mara_jules_archive", "timeline_event"],
    ["character_fact", "char_mara", "character"],
    ["relationship_state", "rel_mara_jules", "relationship"],
    ["world_fact", "world_veil", "world"],
    ["thread", "thread_missing_key", "thread"],
    ["tone", "tone_chat", "tone"],
    ["anchor", "world_red_thread", "world"],
  ];

  for (const [bucket, expectedNoteId, expectedType] of cases) {
    const unit = evidenceUnit(bucket, {
      subjectId: expectedNoteId.replace(/^(char|rel|world|thread|timeline|scene|tone)_/, ""),
      sectionKey:
        bucket === "timeline_event"
          ? "event"
          : bucket === "relationship_state"
            ? "state"
            : bucket === "thread"
              ? "summary"
              : bucket === "tone"
                ? "observations"
                : bucket === "anchor"
                  ? "world_anchor"
                  : "facts",
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

test("evidence unit compiler gates low-risk typed-memory suggestions by confidence and bucket risk", () => {
  const lowConfidence = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("world_fact", {
        subjectId: "veil",
        confidence: 0.84,
      }),
    ],
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    createdAt: timestamp,
  });
  assert.equal(lowConfidence.mutations[0]?.risk, "medium");

  const relationshipState = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("relationship_state", {
        subjectId: "mara_jules",
        sectionKey: "state",
        text: "Mara and Jules trust one another.",
        confidence: 0.95,
      }),
    ],
    existingNotes: [],
    scope: {},
    modes: ["roleplay"],
    createdAt: timestamp,
  });
  assert.equal(relationshipState.mutations[0]?.risk, "medium");

  const sourceBackedUpdate = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("world_fact", {
        subjectId: "veil",
        text: "The veil opens only under moonlight.",
        confidence: 0.9,
      }),
    ],
    existingNotes: [
      withKeywords({
        id: "world_veil",
        type: "world",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The veil opens under old magic.",
            updatedAt: timestamp,
            evidence: ["source_note:scene_old"],
          },
        },
      }),
    ],
    scope: {},
    modes: ["roleplay"],
    createdAt: timestamp,
  });
  assert.equal(sourceBackedUpdate.mutations[0]?.kind, "update_section");
  assert.equal(sourceBackedUpdate.mutations[0]?.risk, "low");
});

test("timeline events create historical notes and relationship state links to them", async () => {
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
      evidenceUnit("relationship_state", {
        subjectId: "mara_jules",
        sectionKey: "state",
        text: "Mara and Jules now share guarded trust after the archive confrontation.",
        links: [{ target: "timeline_archive_confrontation", relation: "caused_by" }],
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
            (link) => link.target === "timeline_archive_confrontation" && link.relation === "caused_by",
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
        (link) => link.target === "timeline_archive_confrontation" && link.relation === "caused_by",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence unit compiler applies explicit bucket lifecycle rules", () => {
  const existingRelationship: LtmNote = withKeywords({
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
  });
  const existingCharacter: LtmNote = withKeywords({
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
        text: "Mara cannot navigate a sealed archive without a map.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_old"],
      },
    },
    version: 1,
  });
  const existingThread: LtmNote = withKeywords({
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
      summary: {
        text: "The lantern hum should pay off later.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_old"],
      },
    },
    version: 1,
  });

  const response = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("timeline_event", {
        subjectId: "tower_archive_key_returned",
        sectionKey: "event",
        text: "Mara trusts Jules again when he returns the tower archive key.",
      }),
      evidenceUnit("character_fact", {
        subjectId: "mara",
        sectionKey: "facts",
        text: "Mara can navigate sealed archives by touch.",
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
        mutation.kind === "create_note" &&
        mutation.note.id === "timeline_tower_archive_key_returned" &&
        mutation.note.type === "timeline_event",
    ),
  );
  assert(
    response.mutations.some(
      (mutation) =>
        mutation.kind === "update_section" &&
        mutation.noteId === "char_mara" &&
        mutation.sectionKey === "facts" &&
        mutation.section.text === "Mara can navigate sealed archives by touch.",
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
  const existingRelationship: LtmNote = withKeywords({
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
  });

  const response = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("timeline_event", {
        subjectId: "tower_archive_key_returned",
        sectionKey: "event",
        text: "Mara trusts Jules again when he protects her and returns the tower archive key.",
        salience: 1,
      }),
    ],
    existingNotes: [existingRelationship],
    scope: {},
    modes: ["roleplay"],
    createdAt: timestamp,
  });

  assert(
    response.mutations.some(
      (mutation) =>
        mutation.kind === "create_note" && mutation.note.id === "timeline_tower_archive_key_returned",
    ),
  );
  assert.equal(
    response.mutations.some(
      (mutation) =>
        mutation.kind !== "create_note" && mutation.noteId === "rel_mara_jules",
    ),
    false,
  );
});

test("evidence unit compiler skips duplicate timeline events from overlapping summaries", () => {
  const existingTimeline: LtmNote = withKeywords({
    id: "timeline_archive_key_returned",
    type: "timeline_event",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: ["typed_memory", "timeline_event"],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      event: {
        text: "- Mara trusted Jules after he returned the archive key.",
        updatedAt: timestamp,
        evidence: ["source_note:scene_source_1"],
      },
    },
    version: 1,
  });

  const response = compileLtmEvidenceUnits({
    units: [
      evidenceUnit("timeline_event", {
        subjectId: "archive_key_returned",
        sectionKey: "event",
        text: "mara trusted jules after he returned the archive key",
        evidence: ["source_note:scene_source_2", "message_range:50-100"],
      }),
    ],
    existingNotes: [existingTimeline],
    scope: {},
    modes: ["roleplay"],
    createdAt: timestamp,
  });

  assert.deepEqual(response.mutations, []);
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
  assert.match(longTermMemoryRouteSource, /function rebuildScopeForNote\(note: LtmNote\)/);
  assert.match(longTermMemoryRouteSource, /rebuildLongTermMemoryIndexes\(\{ scope: rebuildScopeForNote\(note\) \}\)/);
});

test("long-term memory diagnostics stay out of process console", async () => {
  const serviceFiles = await listSourceFiles(new URL("../", import.meta.url));
  for (const file of serviceFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\bconsole\./, `${file.pathname} should not write to the console`);
  }

  const clientFiles = [
    ...(await listSourceFiles(new URL("../../../../../client/src/components/long-term-memory/", import.meta.url))),
    new URL("../../../../../client/src/hooks/use-long-term-memory.ts", import.meta.url),
  ];
  for (const file of clientFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\bconsole\./, `${file.pathname} should not write to the console`);
  }

  const generateRouteSource = await readFile(new URL("../../../routes/generate.routes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(generateRouteSource, /logger\.\w+\([\s\S]*?\[ltm\][\s\S]*?\)/);
  assert.doesNotMatch(generateRouteSource, /logger\.debug\([^\n]*Long-term memory retrieval[^\n]*\)/);
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
    const secondSourceText = "Mara and Jules share steady mutual trust at the tower archive.";
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
        scope: { chatId: "chat_a" },
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
          evidenceUnit("relationship_state", {
            subjectId: "mara_jules",
            sectionKey: "state",
            text: secondSourceText,
            evidence: ["source_note:scene_source_second"],
            sourceHash: sourceHashForEvidenceUnitExtraction(sourceNote),
          }),
        ],
      },
      sourceText: secondSourceText,
      sourceNote,
      existingNotes: [(await storage.getNote("rel_mara_jules"))!],
      scope: { chatId: "chat_a" },
      modes: ["roleplay"],
      sourceHash: sourceHashForEvidenceUnitExtraction(sourceNote),
    });
    assert.deepEqual(
      compiled.compiledResponse.mutations.map((mutation) => mutation.kind),
      ["update_section"],
    );

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      scope: { chatId: "chat_a" },
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
    assert.equal(updated?.sections.state?.text, secondSourceText);
    assert(updated?.links.some((link) => link.target === "scene_source_first" && link.relation === "extracted_from"));
    assert(updated?.links.some((link) => link.target === "scene_source_second" && link.relation === "extracted_from"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source note extraction creates a scoped relationship variant across source notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-target-lookup-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const secondSourceText = "Mara and Jules share steady mutual trust at the tower archive.";
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
              bucket: "relationship_state",
              subjectId: "mara_jules",
              sectionKey: "state",
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
    const create = result.draft.mutations.find((mutation) => mutation.kind === "create_note");
    assert.equal(create?.kind, "create_note");
    assert.match(create.note.id, /^rel_mara_jules_[a-f0-9]{10}$/);
    assert.deepEqual(create.note.scope, { chatId: "chat_b", chatIds: ["chat_b"] });
    assert(
      result.diagnostics.some(
        (diagnostic) => diagnostic.severity === "warning" && diagnostic.code === "target_note_scoped_variant",
      ),
    );
    assert.equal(result.outcome.state, "success");
    assert.deepEqual(result.outcome.droppedCandidates, []);
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
              bucket: "relationship_state",
              subjectId: "mara_jules",
              sectionKey: "state",
              text: "Mara and Jules share steady mutual trust at the tower archive.",
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
        (mutation) => mutation.kind === "update_section" && mutation.noteId === "rel_mara_jules",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source note extraction updates in-scope targets and creates scoped variants in the same pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-target-lookup-mixed-scope-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const sourceText = "Mara and Jules share steady mutual trust, and the old city archive still floats above the lantern river.";
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
              bucket: "relationship_state",
              subjectId: "mara_jules",
              sectionKey: "state",
              text: "Mara and Jules share steady mutual trust.",
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
    assert.equal(result.outcome.state, "success");
    assert.deepEqual(result.outcome.droppedCandidates, []);
    assert(
      result.diagnostics.some(
        (diagnostic) => diagnostic.severity === "warning" && diagnostic.code === "target_note_scoped_variant",
      ),
    );
    assert(
      result.draft.mutations.some(
        (mutation) => mutation.kind === "update_section" && mutation.noteId === "rel_mara_jules",
      ),
    );
    assert(
      result.draft.mutations.some(
        (mutation) => mutation.kind === "create_note" && /^world_old_city_archive_[a-f0-9]{10}$/.test(mutation.note.id),
      ),
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

test("retrieval uses character scope metadata only as a filter", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-retrieval-character-metadata-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();

    await storage.createNote(
      {
        id: "char_rika",
        type: "character",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_a", groupId: "group_x", characterIds: ["rika"] },
        tags: ["typed_memory"],
        links: [],
        sections: {
          current_state: {
            text: "Rika is waiting at the night train platform with a brass ticket.",
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

    const result = await retrieveLongTermMemory({
      root,
      queryText: "night train platform brass ticket",
      scope: { chatId: "chat_a", groupId: "group_x", characterIds: ["rika"] },
      characterIds: ["rika"],
      maxChunks: 1,
      maxTokens: 1000,
      debug: true,
      localEmbedder: async (texts) => texts.map(() => []),
    });

    const selected = result.debug?.selected.find((candidate) => candidate.chunkId === "char_rika::current_state");
    assert(selected);
    assert.equal(selected.rawLaneScores?.metadata, undefined);
    assert(!selected.lanes.includes("metadata"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation retrieval allows old-chat memories with matching group and character scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-generation-cross-chat-scope-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();

    await storage.createNote(
      {
        id: "thread_practice_room",
        type: "thread",
        status: "active",
        modes: ["roleplay"],
        scope: {
          chatId: "old_chat",
          chatIds: ["old_chat"],
          groupId: "group_rika",
          characterIds: ["char_rika"],
        },
        tags: ["typed_memory"],
        links: [],
        sections: {
          summary: {
            text: "Rika and Damo have a Tuesday practice-room plan around the three-note mystery.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "thread_other_group",
        type: "thread",
        status: "active",
        modes: ["roleplay"],
        scope: {
          chatId: "old_chat",
          chatIds: ["old_chat"],
          groupId: "group_elsewhere",
          characterIds: ["char_elsewhere"],
        },
        tags: ["typed_memory"],
        links: [],
        sections: {
          summary: {
            text: "An unrelated Tuesday practice-room rumor from a different group.",
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

    const result = await retrieveLongTermMemory({
      root,
      queryText: "Tuesday practice-room three-note mystery",
      scope: {
        chatId: "new_chat",
        chatIds: ["new_chat"],
        groupId: "group_rika",
        characterIds: ["char_rika"],
      },
      characterIds: ["char_rika"],
      maxChunks: 10,
      maxTokens: 1000,
      semanticWeight: 0,
      lexicalWeight: 1,
      graphWeight: 0,
      metadataMode: "filter_only",
      debug: true,
      localEmbedder: async () => {
        throw new Error("semantic lane should not run when disabled");
      },
    });

    assert.equal(result.debug?.funnel.scopeFiltered, 1);
    assert.deepEqual(
      result.chunks.map((chunk) => chunk.chunk.id),
      ["thread_practice_room::summary"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation retrieval treats metadata as filter only and honors zero-weight lanes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-generation-filter-only-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();

    await storage.createNote(
      {
        id: "world_scope_only",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_filter_only" },
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "A scoped but unrelated memory about blue porcelain cups.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "world_relevant_lantern",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_filter_only" },
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The red lantern opens the archive gate.",
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

    const allZero = await retrieveLongTermMemory({
      root,
      queryText: "red lantern archive gate",
      scope: { chatId: "chat_filter_only" },
      maxChunks: 10,
      maxTokens: 1000,
      semanticWeight: 0,
      lexicalWeight: 0,
      graphWeight: 0,
      keywordWeight: 0,
      metadataMode: "filter_only",
      debug: true,
      localEmbedder: async () => {
        throw new Error("semantic lane should not run when disabled");
      },
    });

    assert.deepEqual(allZero.chunks, []);
    assert.deepEqual(allZero.debug?.activeLanes, []);
    assert.deepEqual(allZero.debug?.skippedLanes.sort(), [
      "bm25:zero_weight",
      "graph:zero_weight",
      "keyword:zero_weight",
      "vector:zero_weight",
    ]);
    assert.equal(allZero.debug?.metadataMode, "filter_only");

    const lexicalOnly = await retrieveLongTermMemory({
      root,
      queryText: "red lantern archive gate",
      scope: { chatId: "chat_filter_only" },
      maxChunks: 10,
      maxTokens: 1000,
      semanticWeight: 0,
      lexicalWeight: 1,
      graphWeight: 0,
      keywordWeight: 0,
      metadataMode: "filter_only",
      debug: true,
      localEmbedder: async () => {
        throw new Error("semantic lane should not run when disabled");
      },
    });

    assert.deepEqual(
      lexicalOnly.chunks.map((chunk) => chunk.chunk.id),
      ["world_relevant_lantern::facts"],
    );
    assert.equal(lexicalOnly.debug?.funnel.metadataCandidates ?? 0, 0);
    assert.equal(lexicalOnly.debug?.funnel.vectorCandidates ?? 0, 0);
    assert.equal(lexicalOnly.debug?.funnel.graphCandidates ?? 0, 0);
    assert.equal(lexicalOnly.debug?.funnel.bm25Candidates, 1);
    assert.deepEqual(lexicalOnly.debug?.activeLanes, ["bm25"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation graph recall is not seeded by scope-only metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-generation-graph-scope-seed-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();

    await storage.createNote(
      {
        id: "world_scope_anchor",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_graph_filter_only" },
        tags: ["typed_memory"],
        links: [{ target: "world_graph_neighbor", relation: "involves" }],
        sections: {
          facts: {
            text: "A scoped anchor about porcelain cups.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );
    await storage.createNote(
      {
        id: "world_graph_neighbor",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_graph_filter_only" },
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "A neighboring graph memory about blue ceramic shelves.",
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

    const result = await retrieveLongTermMemory({
      root,
      queryText: "unrelated search text",
      scope: { chatId: "chat_graph_filter_only" },
      maxChunks: 10,
      maxTokens: 1000,
      semanticWeight: 0,
      lexicalWeight: 0,
      graphWeight: 1,
      keywordWeight: 0,
      metadataMode: "filter_only",
      debug: true,
      localEmbedder: async () => {
        throw new Error("semantic lane should not run when disabled");
      },
    });

    assert.deepEqual(result.chunks, []);
    assert.equal(result.debug?.funnel.metadataCandidates ?? 0, 0);
    assert.equal(result.debug?.funnel.graphCandidates ?? 0, 0);
    assert.deepEqual(result.debug?.activeLanes, ["graph"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retrieval score threshold excludes weak vector-only candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-retrieval-vector-threshold-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();

    await storage.createNote(
      {
        id: "world_needle_archive",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: { chatId: "chat_vector_threshold" },
        tags: ["typed_memory"],
        links: [],
        sections: {
          facts: {
            text: "The silver needle is sealed inside the archive reliquary.",
            updatedAt: timestamp,
          },
        },
      },
      { suppressEvent: true },
    );

    for (const index of [1, 2, 3]) {
      await storage.createNote(
        {
          id: `world_soft_positive_${index}`,
          type: "world",
          status: "active",
          modes: ["roleplay"],
          scope: { chatId: "chat_vector_threshold" },
          tags: ["typed_memory"],
          links: [],
          sections: {
            facts: {
              text: `A background memory about market weather and old lanterns ${index}.`,
              updatedAt: timestamp,
            },
          },
        },
        { suppressEvent: true },
      );
    }

    const embedder = async (texts: string[]) =>
      texts.map((text) => {
        if (text.includes("silver needle") || text.includes("needle archive")) return [1, 0];
        return [0.1, Math.sqrt(0.99)];
      });

    await rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: embedder,
    });

    const result = await retrieveLongTermMemory({
      root,
      queryText: "needle archive",
      scope: { chatId: "chat_vector_threshold" },
      maxChunks: 10,
      maxTokens: 1000,
      minScore: 0.2,
      semanticWeight: 1,
      lexicalWeight: 0,
      graphWeight: 0,
      debug: true,
      localEmbedder: embedder,
    });

    assert.deepEqual(
      result.chunks.map((chunk) => chunk.chunk.id),
      ["world_needle_archive::facts"],
    );
    assert.equal(result.debug?.funnel.vectorCandidates, 4);
    assert.equal(result.debug?.funnel.scoreThresholdSkippedCandidates, 3);
    assert(result.debug?.rejected.every((candidate) => (candidate.finalNormalizedScore ?? 1) < 0.2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
