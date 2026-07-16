// ──────────────────────────────────────────────
// LTM Recall, Prompt & Dispatch Contracts
// ──────────────────────────────────────────────
import assert from "node:assert/strict";
import test from "node:test";
import { resolveLongTermMemoryRecallSettings } from "@marinara-engine/shared";
import { ltmAgentSettingsSchema } from "@marinara-engine/shared";
import type { AssemblerInput } from "../../prompt/assembler.js";
import { assemblePrompt } from "../../prompt/assembler.js";
import { fitMessagesToContext, type ChatMessage } from "../../llm/base-provider.js";
import type { LtmBudgetedChunk } from "../budget.js";
import {
  buildGenerationLongTermMemoryPlan,
  prepareGenerationLongTermMemory,
  recordGenerationLongTermMemoryDispatch,
} from "../generation-injection.js";
import {
  createLongTermMemoryPromptArtifact,
  serializeLongTermMemoryPromptArtifact,
  isLongTermMemoryPromptArtifactPresent,
  estimateLongTermMemoryPromptArtifactTokens,
  injectLongTermMemoryPromptArtifact,
} from "../prompt.js";
import { LongTermMemoryStorage } from "../storage.js";
import {
  withTempRoot,
  worldNote,
  REFERENCE_TS,
} from "./fixtures/ltm-test-harness.js";

function promptChunk(id: string, text: string): LtmBudgetedChunk {
  return {
    chunk: {
      id,
      noteId: id.split("::", 1)[0] ?? id,
      sectionKey: "facts",
      text,
      sourceHash: "a".repeat(64),
      noteType: "world" as const,
      status: "active" as const,
      tags: [],
      keywords: [],
      scope: {},
      updatedAt: REFERENCE_TS,
    },
    score: 1,
    reasons: ["direct"],
    lanes: ["direct"],
    tier: 1,
    estimatedTokens: Math.ceil(text.length / 4),
  };
}

function promptAssemblerInput(
  artifact: NonNullable<ReturnType<typeof createLongTermMemoryPromptArtifact>>,
  parameters: Record<string, unknown>,
): AssemblerInput {
  const sections: AssemblerInput["sections"] = [
    {
      id: "base_prompt",
      presetId: "preset_test",
      identifier: "base_prompt",
      name: "Base Prompt",
      content: "Base system prompt",
      role: "system",
      enabled: "true",
      isMarker: "false",
      groupId: null,
      markerConfig: null,
      injectionPosition: "ordered",
      injectionDepth: 0,
      injectionOrder: 10,
      forbidOverrides: "false",
    },
    {
      id: "ltm_marker",
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
      injectionOrder: 20,
      forbidOverrides: "false",
    },
  ];
  return {
    db: {} as AssemblerInput["db"],
    preset: {
      id: "preset_test",
      name: "Test Preset",
      sectionOrder: JSON.stringify(sections.map((section) => section.id)),
      groupOrder: "[]",
      variableGroups: "[]",
      variableValues: "{}",
      parameters: JSON.stringify(parameters),
      wrapFormat: "xml",
    },
    sections,
    groups: [],
    choiceBlocks: [],
    chatChoices: {},
    chatId: "chat_test",
    characterIds: [],
    personaName: "User",
    personaDescription: "",
    chatMessages: [{ role: "user", content: "Where is the key?", contextKind: "history" }],
    chatSummary: "The prior chapter ended at the archive.",
    longTermMemoryArtifact: artifact,
    enableAgents: false,
    activeAgentIds: [],
    activeLorebookIds: [],
  };
}

// ═══════════════════════════════════════════════
//  Settings resolution (pure functions)
// ═══════════════════════════════════════════════

test("resolve settings defaults enabled=false when nothing configured", () => {
  const resolved = resolveLongTermMemoryRecallSettings({
    chatMode: "roleplay",
    chatMetadata: {},
  });
  assert.equal(resolved.enabled, false);
});

test("resolve settings global defaults apply", () => {
  const resolved = resolveLongTermMemoryRecallSettings({
    chatMode: "roleplay",
    chatMetadata: {},
    globalSettings: {
      version: 1,
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 2048,
      longTermMemoryMaxChunks: 10,
      longTermMemoryScoreThreshold: 0.1,
      longTermMemoryRecallContextMessages: 6,
      longTermMemoryRecallStyle: "broad",
      longTermMemorySemanticWeight: 0.4,
      longTermMemoryLexicalWeight: 0.3,
      longTermMemoryGraphWeight: 0.2,
      longTermMemoryKeywordWeight: 0.1,
      longTermMemoryIncludeResolved: false,
      longTermMemoryRecallPreamble: "Default preamble.",
      longTermMemoryDebug: false,
    },
  });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.budgetTokens, 2048);
  assert.equal(resolved.maxChunks, 10);
  assert.equal(resolved.recallStyle, "broad");
});

test("resolve settings chat metadata overrides global", () => {
  const resolved = resolveLongTermMemoryRecallSettings({
    chatMode: "roleplay",
    chatMetadata: {
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 1024,
      longTermMemoryMaxChunks: 5,
      longTermMemoryRecallStyle: "exact",
    },
    globalSettings: {
      version: 1,
      enableLongTermMemory: false,
      longTermMemoryBudgetTokens: 4096,
      longTermMemoryMaxChunks: 20,
      longTermMemoryScoreThreshold: 0,
      longTermMemoryRecallContextMessages: 4,
      longTermMemoryRecallStyle: "balanced",
      longTermMemorySemanticWeight: 0.35,
      longTermMemoryLexicalWeight: 0.35,
      longTermMemoryGraphWeight: 0.15,
      longTermMemoryKeywordWeight: 0.15,
      longTermMemoryIncludeResolved: false,
      longTermMemoryRecallPreamble: "",
      longTermMemoryDebug: false,
    },
  });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.budgetTokens, 1024);
  assert.equal(resolved.maxChunks, 5);
  assert.equal(resolved.recallStyle, "exact");
});

// ═══════════════════════════════════════════════
//  Generation plan (pure function)
// ═══════════════════════════════════════════════

test("build plan returns disabled plan when disabled", () => {
  const plan = buildGenerationLongTermMemoryPlan({
    chatId: "chat_disabled",
    chatMode: "roleplay",
    promptCharacterIds: [],
    activeCharacterNames: [],
    inputMessages: [],
    chatMeta: {},
    lorebookGenerationTriggers: [],
    globalSettings: {
      version: 1,
      enableLongTermMemory: false,
      longTermMemoryBudgetTokens: 4096,
      longTermMemoryMaxChunks: 20,
      longTermMemoryScoreThreshold: 0,
      longTermMemoryRecallContextMessages: 4,
      longTermMemoryRecallStyle: "balanced",
      longTermMemorySemanticWeight: 0.35,
      longTermMemoryLexicalWeight: 0.35,
      longTermMemoryGraphWeight: 0.15,
      longTermMemoryKeywordWeight: 0.15,
      longTermMemoryIncludeResolved: false,
      longTermMemoryRecallPreamble: "",
      longTermMemoryDebug: false,
    },
  });
  assert.equal(plan.enabled, false);
});

test("build plan includes scope and query in retrieval input", () => {
  const plan = buildGenerationLongTermMemoryPlan({
    chatId: "chat_plan",
    chatMode: "roleplay",
    promptCharacterIds: ["char_a"],
    activeCharacterNames: ["Alice"],
    inputMessages: [{ role: "user", content: "Tell me about the cobalt key." }],
    chatMeta: { enableLongTermMemory: true },
    lorebookGenerationTriggers: ["trigger_1"],
    globalSettings: {
      version: 1,
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 2048,
      longTermMemoryMaxChunks: 10,
      longTermMemoryScoreThreshold: 0,
      longTermMemoryRecallContextMessages: 4,
      longTermMemoryRecallStyle: "balanced",
      longTermMemorySemanticWeight: 0.35,
      longTermMemoryLexicalWeight: 0.35,
      longTermMemoryGraphWeight: 0.15,
      longTermMemoryKeywordWeight: 0.15,
      longTermMemoryIncludeResolved: false,
      longTermMemoryRecallPreamble: "",
      longTermMemoryDebug: false,
    },
  });
  assert.equal(plan.enabled, true);
  assert.ok(plan.queryText.includes("Tell me about the cobalt key"));
  assert.ok(plan.queryText.includes("Alice"));
  assert.equal(plan.retrievalInput.characterIds?.[0], "char_a");
});

test("generation preparation requires the LTM agent to be active", async () => {
  let retrievalCalls = 0;
  const memory = await prepareGenerationLongTermMemory({
    chatId: "chat_inactive",
    chatMode: "roleplay",
    promptCharacterIds: [],
    activeCharacterNames: [],
    inputMessages: [{ role: "user", content: "Where is the key?" }],
    chatMeta: { enableLongTermMemory: true },
    globalSettings: {
      version: 1,
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 2048,
      longTermMemoryMaxChunks: 10,
      longTermMemoryScoreThreshold: 0,
      longTermMemoryRecallContextMessages: 4,
      longTermMemoryRecallStyle: "balanced",
      longTermMemorySemanticWeight: 0.35,
      longTermMemoryLexicalWeight: 0.35,
      longTermMemoryGraphWeight: 0.15,
      longTermMemoryKeywordWeight: 0.15,
      longTermMemoryIncludeResolved: false,
      longTermMemoryRecallPreamble: "",
      longTermMemoryDebug: false,
    },
    agentsEnabled: true,
    activeAgentIds: [],
    lorebookGenerationTriggers: [],
    retrieveLongTermMemoryFn: async () => {
      retrievalCalls += 1;
      return { chunks: [], usedTokens: 0, maxTokens: 2048, embeddingsAvailable: false, warnings: [] };
    },
  });

  assert.equal(memory.plan.enabled, false);
  assert.equal(memory.artifact, null);
  assert.equal(retrievalCalls, 0);
});

test("generation memory preserves assembled placement and accounts once", async () => {
  const chunk = promptChunk("world_generation::facts", "The cobalt key opens the archive.");
  const accountingInputs: Array<{ chatId: string; serializedTokenCount: number }> = [];
  const memory = await prepareGenerationLongTermMemory({
    chatId: "chat_generation",
    chatMode: "roleplay",
    promptCharacterIds: [],
    activeCharacterNames: [],
    inputMessages: [{ role: "user", content: "Where is the key?" }],
    chatMeta: { enableLongTermMemory: true },
    agentsEnabled: true,
    activeAgentIds: ["long-term-memory"],
    lorebookGenerationTriggers: [],
    retrieveLongTermMemoryFn: async () => ({
      chunks: [chunk],
      usedTokens: chunk.estimatedTokens,
      maxTokens: 4096,
      embeddingsAvailable: false,
      warnings: [],
    }),
    recordInjection: async (input) => {
      accountingInputs.push({ chatId: input.chatId, serializedTokenCount: input.serializedTokenCount });
    },
  });
  assert.ok(memory.artifact);
  const assembledArtifact = serializeLongTermMemoryPromptArtifact(memory.artifact, {
    wrapFormat: "xml",
    wrapperName: "Custom Memory Marker",
  });
  assert.ok(assembledArtifact);
  const messages = [
    { role: "system" as const, content: assembledArtifact.content, contextKind: "long_term_memory" as const },
    { role: "user" as const, content: "Where is the key?" },
  ];

  memory.acceptAssembledArtifact(assembledArtifact);
  assert.equal(memory.ensurePlaced(messages, { wrapFormat: "xml", wrapperName: "Fallback Memory" }), messages);
  assert.equal(messages.length, 2);
  assert.equal(await memory.recordAccepted([{ content: "Artifact was removed by context fitting." }]), false);
  assert.equal(accountingInputs.length, 0);
  assert.equal(await memory.recordAccepted(messages), true);
  assert.equal(await memory.recordAccepted(messages), false);
  assert.deepEqual(accountingInputs, [
    { chatId: "chat_generation", serializedTokenCount: assembledArtifact.estimatedTokens },
  ]);
});

test("generation memory injects a fallback artifact when assembly did not place one", async () => {
  const chunk = promptChunk("world_fallback::facts", "The fallback key opens the archive.");
  const memory = await prepareGenerationLongTermMemory({
    chatId: "chat_fallback",
    chatMode: "conversation",
    promptCharacterIds: [],
    activeCharacterNames: [],
    inputMessages: [{ role: "user", content: "Where is the key?" }],
    chatMeta: { enableLongTermMemory: true },
    agentsEnabled: true,
    activeAgentIds: ["long-term-memory"],
    lorebookGenerationTriggers: [],
    retrieveLongTermMemoryFn: async () => ({
      chunks: [chunk],
      usedTokens: chunk.estimatedTokens,
      maxTokens: 4096,
      embeddingsAvailable: false,
      warnings: [],
    }),
  });
  const messages: ChatMessage[] = [{ role: "user", content: "Where is the key?" }];

  memory.ensurePlaced(messages, { wrapFormat: "xml", wrapperName: "Long Term Memory" });
  memory.ensurePlaced(messages, { wrapFormat: "xml", wrapperName: "Long Term Memory" });

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.contextKind, "long_term_memory");
  assert.match(messages[0]?.content ?? "", /fallback key opens the archive/);
});

// ═══════════════════════════════════════════════
//  Prompt artifacts (pure functions)
// ═══════════════════════════════════════════════

test("create artifact returns null for empty chunks", () => {
  const artifact = createLongTermMemoryPromptArtifact([], {
    preamble: "Recall:",
    maxTokens: 4096,
  });
  assert.equal(artifact, null);
});

test("create artifact with one chunk returns artifact", () => {
  const chunk: LtmBudgetedChunk = {
    chunk: {
      id: "world_test::facts",
      noteId: "world_test",
      sectionKey: "facts",
      text: "A test fact.",
      sourceHash: "a".repeat(64),
      noteType: "world" as const,
      status: "active" as const,
      tags: [],
      keywords: [],
      scope: { chatId: "chat_test" },
      updatedAt: REFERENCE_TS,
    },
    score: 1,
    reasons: ["direct"],
    lanes: ["direct"],
    tier: 1,
    estimatedTokens: 4,
  };
  const artifact = createLongTermMemoryPromptArtifact([chunk], {
    preamble: "Recall:",
    maxTokens: 4096,
  });
  assert.ok(artifact);
  assert.equal(artifact.chunks.length, 1);
});

test("serialize returns null for null artifact", () => {
  const serialized = serializeLongTermMemoryPromptArtifact(null, {
    wrapFormat: "xml",
    wrapperName: "Memory",
  });
  assert.equal(serialized, null);
});

test("serialize with chunk produces content", () => {
  const chunk: LtmBudgetedChunk = {
    chunk: {
      id: "world_ser::facts",
      noteId: "world_ser",
      sectionKey: "facts",
      text: "Serialized fact.",
      sourceHash: "a".repeat(64),
      noteType: "world" as const,
      status: "active" as const,
      tags: [],
      keywords: [],
      scope: { chatId: "chat_test" },
      updatedAt: REFERENCE_TS,
    },
    score: 1,
    reasons: ["direct"],
    lanes: ["direct"],
    tier: 1,
    estimatedTokens: 4,
  };
  const artifact = createLongTermMemoryPromptArtifact([chunk], { maxTokens: 4096 });
  assert.ok(artifact);
  const serialized = serializeLongTermMemoryPromptArtifact(artifact, {
    wrapFormat: "xml",
    wrapperName: "Memory",
  });
  assert.ok(serialized);
  assert.ok(serialized.content.length > 0);
  assert.ok(serialized.estimatedTokens > 0);
});

test("is artifact present detects artifact in messages", () => {
  const chunk: LtmBudgetedChunk = {
    chunk: {
      id: "world_pres::facts",
      noteId: "world_pres",
      sectionKey: "facts",
      text: "Present fact.",
      sourceHash: "a".repeat(64),
      noteType: "world" as const,
      status: "active" as const,
      tags: [],
      keywords: [],
      scope: { chatId: "chat_test" },
      updatedAt: REFERENCE_TS,
    },
    score: 1,
    reasons: ["direct"],
    lanes: ["direct"],
    tier: 1,
    estimatedTokens: 4,
  };
  const artifact = createLongTermMemoryPromptArtifact([chunk], { maxTokens: 4096 });
  const serialized = serializeLongTermMemoryPromptArtifact(artifact, {
    wrapFormat: "xml",
    wrapperName: "Memory",
  });
  assert.ok(serialized);
  assert.equal(
    isLongTermMemoryPromptArtifactPresent(
      [{ content: serialized!.content }],
      serialized,
    ),
    true,
  );
  assert.equal(
    isLongTermMemoryPromptArtifactPresent(
      [{ content: "Unrelated." }],
      serialized,
    ),
    false,
  );
});

test("inject artifact inserts message before user content", () => {
  const chunk: LtmBudgetedChunk = {
    chunk: {
      id: "world_inj::facts",
      noteId: "world_inj",
      sectionKey: "facts",
      text: "Injected fact.",
      sourceHash: "a".repeat(64),
      noteType: "world" as const,
      status: "active" as const,
      tags: [],
      keywords: [],
      scope: { chatId: "chat_test" },
      updatedAt: REFERENCE_TS,
    },
    score: 1,
    reasons: ["direct"],
    lanes: ["direct"],
    tier: 1,
    estimatedTokens: 4,
  };
  const artifact = createLongTermMemoryPromptArtifact([chunk], { maxTokens: 4096 });
  assert.ok(artifact);
  const messages = [
    { role: "system" as const, content: "First system." },
    { role: "user" as const, content: "User message." },
  ];
  const result = injectLongTermMemoryPromptArtifact(messages, artifact, {
    wrapFormat: "xml",
    wrapperName: "Memory",
  });
  assert.ok(result.artifact);
  assert.ok(result.inserted);
  assert.ok(messages.length >= 3);
});

test("estimate tokens > 0 for content", () => {
  const tokens = estimateLongTermMemoryPromptArtifactTokens(
    "The cobalt key opens the archive. The phase is eleven.",
  );
  assert.ok(tokens > 0);
});

for (const parameters of [
  { strictRoleFormatting: true },
  { strictRoleFormatting: true, singleUserMessage: true },
]) {
  test(`prompt formatting preserves a dedicated LTM artifact (${JSON.stringify(parameters)})`, async () => {
    const artifact = createLongTermMemoryPromptArtifact(
      [promptChunk("world_format::facts", "The cobalt key opens the archive.")],
      { maxTokens: 4096 },
    );
    assert.ok(artifact);

    const assembled = await assemblePrompt(promptAssemblerInput(artifact, parameters));
    const memoryMessages = assembled.messages.filter((message) => message.contextKind === "long_term_memory");
    assert.equal(memoryMessages.length, 1);
    assert.ok(assembled.longTermMemoryArtifact);
    assert.equal(memoryMessages[0]!.content, assembled.longTermMemoryArtifact.content);
    assert.doesNotMatch(memoryMessages[0]!.content, /Base system prompt|prior chapter/);
    assert.equal(
      isLongTermMemoryPromptArtifactPresent(assembled.messages, assembled.longTermMemoryArtifact),
      true,
    );
  });
}

test("context fitting removes the whole LTM artifact before unrelated system content", () => {
  const artifact = serializeLongTermMemoryPromptArtifact(
    createLongTermMemoryPromptArtifact(
      [promptChunk("world_large::facts", `ltm-unique-${"x".repeat(1_800)}`)],
      { maxTokens: 4096 },
    ),
    { wrapFormat: "xml", wrapperName: "Long-Term Memory" },
  );
  assert.ok(artifact);

  const fitted = fitMessagesToContext(
    [
      { role: "system", content: "Base system prompt", contextKind: "prompt" },
      { role: "system", content: artifact.content, contextKind: "long_term_memory" },
      { role: "user", content: `recent-${"y".repeat(800)}`, contextKind: "history" },
    ],
    { maxContext: 1_200, maxTokens: 128 },
  );

  assert.equal(fitted.messages.some((message) => message.contextKind === "long_term_memory"), false);
  assert.equal(fitted.messages.some((message) => message.content.includes("ltm-unique-")), false);
  assert.equal(fitted.messages.some((message) => message.content.includes("Base system prompt")), true);
});

// ═══════════════════════════════════════════════
//  Dispatch accounting (storage-backed)
// ═══════════════════════════════════════════════

await test("record dispatch with missing artifact returns false", async () => {
  const result = await recordGenerationLongTermMemoryDispatch({
    chatId: "chat_no_artifact",
    artifact: null,
    finalMessages: [],
  });
  assert.equal(result, false);
});

await test("record dispatch with artifact present persists receipt", async () => {
  await withTempRoot(async (root) => {
    const s = new LongTermMemoryStorage(root);
    await s.createNote(worldNote("world_receipt", "Receipt world fact."));

    const chunk: LtmBudgetedChunk = {
      chunk: {
        id: "world_receipt::facts",
        noteId: "world_receipt",
        sectionKey: "facts",
        text: "Receipt world fact.",
        sourceHash: "a".repeat(64),
        noteType: "world" as const,
        status: "active" as const,
        tags: [],
        keywords: [],
        scope: { chatId: "chat_receipt" },
        updatedAt: REFERENCE_TS,
      },
      score: 1,
      reasons: ["direct"],
      lanes: ["direct"],
      tier: 1,
      estimatedTokens: 8,
    };
    const artifact = createLongTermMemoryPromptArtifact([chunk], {
      preamble: "",
      maxTokens: 4096,
    });
    assert.ok(artifact);
    const serialized = serializeLongTermMemoryPromptArtifact(artifact!, {
      wrapFormat: "xml",
      wrapperName: "Memory",
    });
    assert.ok(serialized);

    const result = await recordGenerationLongTermMemoryDispatch({
      chatId: "chat_receipt",
      artifact: serialized,
      finalMessages: [{ content: serialized!.content }],
    });
    assert.equal(result, true);
  });
});

// ──────────────────────────────────────────────
//  Settings authority contracts
// ──────────────────────────────────────────────
// Recall precedence: per-chat metadata > global settings > mode defaults.
// Agent-config recall fields are legacy and must be stripped on read.
test("settings authority: disabled by default when no global or chat settings", () => {
  const resolved = resolveLongTermMemoryRecallSettings({
    chatMode: "roleplay",
    chatMetadata: {},
    globalSettings: undefined,
  });
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.recallStyle, "story");
});

test("settings authority: global settings provide defaults", () => {
  const resolved = resolveLongTermMemoryRecallSettings({
    chatMode: "roleplay",
    chatMetadata: {},
    globalSettings: {
      version: 1,
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 2048,
      longTermMemoryMaxChunks: 10,
      longTermMemoryScoreThreshold: 0.2,
      longTermMemoryRecallContextMessages: 6,
      longTermMemoryRecallStyle: "story",
      longTermMemorySemanticWeight: 0.4,
      longTermMemoryLexicalWeight: 0.3,
      longTermMemoryGraphWeight: 0.2,
      longTermMemoryKeywordWeight: 0.1,
      longTermMemoryIncludeResolved: true,
      longTermMemoryRecallPreamble: "Custom preamble",
      longTermMemoryDebug: true,
    },
  });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.budgetTokens, 2048);
  assert.equal(resolved.maxChunks, 10);
  assert.equal(resolved.recallStyle, "story");
  assert.equal(resolved.includeResolved, true);
  assert.equal(resolved.recallPreamble, "Custom preamble");
  assert.equal(resolved.debugEnabled, true);
});

test("settings authority: chat metadata overrides global", () => {
  const resolved = resolveLongTermMemoryRecallSettings({
    chatMode: "roleplay",
    chatMetadata: {
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 1024,
      longTermMemoryRecallStyle: "exact",
    },
    globalSettings: {
      version: 1,
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 2048,
      longTermMemoryMaxChunks: 10,
      longTermMemoryScoreThreshold: 0.2,
      longTermMemoryRecallContextMessages: 6,
      longTermMemoryRecallStyle: "story",
      longTermMemorySemanticWeight: 0.4,
      longTermMemoryLexicalWeight: 0.3,
      longTermMemoryGraphWeight: 0.2,
      longTermMemoryKeywordWeight: 0.1,
      longTermMemoryIncludeResolved: true,
      longTermMemoryRecallPreamble: "Global preamble",
      longTermMemoryDebug: false,
    },
  });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.budgetTokens, 1024);
  assert.equal(resolved.recallStyle, "exact");
  assert.equal(resolved.recallPreamble, "Global preamble");
});

test("settings authority: invalid chat metadata values fall back to global", () => {
  const resolved = resolveLongTermMemoryRecallSettings({
    chatMode: "roleplay",
    chatMetadata: {
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: "not a number",
      longTermMemoryRecallStyle: "invalid_style",
      longTermMemoryMaxChunks: -5,
    },
    globalSettings: {
      version: 1,
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 2048,
      longTermMemoryMaxChunks: 10,
      longTermMemoryScoreThreshold: 0,
      longTermMemoryRecallContextMessages: 4,
      longTermMemoryRecallStyle: "story",
      longTermMemorySemanticWeight: 0.4,
      longTermMemoryLexicalWeight: 0.3,
      longTermMemoryGraphWeight: 0.2,
      longTermMemoryKeywordWeight: 0.1,
      longTermMemoryIncludeResolved: false,
      longTermMemoryRecallPreamble: "",
      longTermMemoryDebug: false,
    },
  });
  assert.equal(resolved.budgetTokens, 2048);
  assert.equal(resolved.maxChunks, 10);
  assert.equal(resolved.recallStyle, "story");
});

test("settings authority: legacy agent recall fields are stripped on parse", () => {
  const legacy = {
    author: "Promansis",
    connectionId: "conn-1",
    model: "gpt-4",
    instruction: "Extract carefully",
    importConcurrency: 3,
    autoApplyLowRisk: true,
    longTermMemoryBudgetTokens: 8192,
    longTermMemoryMaxChunks: 50,
    longTermMemoryRecallStyle: "broad",
    longTermMemoryDebug: true,
    longTermMemoryIncludeResolved: true,
    longTermMemoryRecallPreamble: "Legacy preamble",
  };
  const parsed = ltmAgentSettingsSchema.parse(legacy);
  assert.equal(parsed.connectionId, "conn-1");
  assert.equal(parsed.model, "gpt-4");
  assert.equal(parsed.autoApplyLowRisk, true);
  assert.equal("longTermMemoryBudgetTokens" in parsed, false);
  assert.equal("longTermMemoryMaxChunks" in parsed, false);
  assert.equal("longTermMemoryRecallStyle" in parsed, false);
  assert.equal("longTermMemoryDebug" in parsed, false);
  assert.equal("longTermMemoryIncludeResolved" in parsed, false);
  assert.equal("longTermMemoryRecallPreamble" in parsed, false);
});

test("settings authority: unknown keys in agent settings are rejected", () => {
  assert.throws(
    () => ltmAgentSettingsSchema.parse({ unknownKey: "value" }),
    /Unrecognized key/,
  );
});

test("settings authority: conversation mode defaults to balanced", () => {
  const resolved = resolveLongTermMemoryRecallSettings({
    chatMode: "conversation",
    chatMetadata: {},
    globalSettings: undefined,
  });
  assert.equal(resolved.recallStyle, "balanced");
});

test("settings authority: game mode defaults to exact", () => {
  const resolved = resolveLongTermMemoryRecallSettings({
    chatMode: "game",
    chatMetadata: {},
    globalSettings: undefined,
  });
  assert.equal(resolved.recallStyle, "exact");
});

test("settings authority: visual_novel maps to roleplay mode defaults", () => {
  const resolvedRoleplay = resolveLongTermMemoryRecallSettings({
    chatMode: "roleplay",
    chatMetadata: {},
    globalSettings: undefined,
  });
  const resolvedVn = resolveLongTermMemoryRecallSettings({
    chatMode: "visual_novel",
    chatMetadata: {},
    globalSettings: undefined,
  });
  assert.equal(resolvedVn.recallStyle, resolvedRoleplay.recallStyle);
});
