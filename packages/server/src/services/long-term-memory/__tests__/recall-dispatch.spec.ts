// ──────────────────────────────────────────────
// LTM Recall, Prompt & Dispatch Contracts
// ──────────────────────────────────────────────
import assert from "node:assert/strict";
import test from "node:test";
import { resolveLongTermMemoryRecallSettings } from "@marinara-engine/shared";
import {
  buildGenerationLongTermMemoryPlan,
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
  const chunk = {
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
  const chunk = {
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
  const chunk = {
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
      [{ role: "system" as const, content: serialized!.content }],
      serialized,
    ),
    true,
  );
  assert.equal(
    isLongTermMemoryPromptArtifactPresent(
      [{ role: "user" as const, content: "Unrelated." }],
      serialized,
    ),
    false,
  );
});

test("inject artifact inserts message before user content", () => {
  const chunk = {
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

    const chunk = {
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
      finalMessages: [{ role: "system", content: serialized!.content }],
    });
    assert.equal(result, true);
  });
});
