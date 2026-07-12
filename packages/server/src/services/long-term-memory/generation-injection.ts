import {
  LTM_RECALL_STYLE_WEIGHTS,
  parseLongTermMemoryRecallStyle,
  DEFAULT_LTM_RECALL_STYLE_BY_MODE,
  withMergedLtmScopeLinks,
  type LtmResolvedGlobalSettings,
  type LongTermMemoryRecallStyle,
  type LtmRecallWeights,
  type LtmScope,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import type { ChatMessage } from "../llm/base-provider.js";
import type { MemoryRecallEmbeddingSource } from "../memory-recall.js";
import { ltmModeForChatMode } from "./chat-scope.js";
import {
  retrieveLongTermMemory,
  type RetrieveLongTermMemoryInput,
  type RetrieveLongTermMemoryResult,
} from "./retrieval.js";
import {
  createLongTermMemoryPromptArtifact,
  injectLongTermMemoryPromptBlock,
  isLongTermMemoryPromptArtifactPresent,
  type LtmPromptArtifact,
  type LtmSerializedPromptArtifact,
} from "./prompt.js";
import { recordLongTermMemoryInjection } from "./usage.js";

type GenerationPromptInputMessage = Pick<ChatMessage, "role" | "content">;

export interface BuildGenerationLongTermMemoryPlanInput {
  chatId: string;
  chatMode: string;
  groupId?: string | null;
  promptCharacterIds: string[];
  activeCharacterNames: string[];
  inputMessages: GenerationPromptInputMessage[];
  chatMeta: Record<string, unknown>;
  globalSettings?: LtmResolvedGlobalSettings;
  userMessage?: string;
  generationGuide?: string;
  lorebookGenerationTriggers: string[];
  gameState?: unknown;
  requestDebug?: boolean;
  mentionedCharacterNames?: string[];
  embeddingSource?: MemoryRecallEmbeddingSource;
}

export interface GenerationLongTermMemoryPlan {
  enabled: boolean;
  budgetTokens?: number;
  maxChunks?: number;
  scoreThreshold?: number;
  recallStyle: LongTermMemoryRecallStyle;
  weights: LtmRecallWeights;
  debugEnabled: boolean;
  contextMessages: number;
  includeResolved: boolean;
  recallPreamble: string;
  scope: LtmScope;
  queryText: string;
  lastUserMessageText: string;
  retrievalInput: RetrieveLongTermMemoryInput;
  activeCharacterNames: string[];
  generationTriggerCount: number;
  hasGenerationGuide: boolean;
  hasGameState: boolean;
}

export interface ApplyGenerationLongTermMemoryInjectionInput {
  plan: GenerationLongTermMemoryPlan;
  finalMessages: ChatMessage[];
  retrieveLongTermMemoryFn?: (input: RetrieveLongTermMemoryInput) => Promise<RetrieveLongTermMemoryResult>;
}

export interface ApplyGenerationLongTermMemoryInjectionResult {
  retrieval: RetrieveLongTermMemoryResult;
  injection: {
    block: string;
    inserted: boolean;
    insertAt: number | null;
    insertedBeforeRole: ChatMessage["role"] | null;
  };
}

export interface RetrieveGenerationLongTermMemoryBlockInput {
  plan: GenerationLongTermMemoryPlan;
  retrieveLongTermMemoryFn?: (input: RetrieveLongTermMemoryInput) => Promise<RetrieveLongTermMemoryResult>;
}

export interface RetrieveGenerationLongTermMemoryBlockResult {
  retrieval: RetrieveLongTermMemoryResult;
  artifact: LtmPromptArtifact | null;
}

export interface RecordGenerationLongTermMemoryDispatchInput {
  chatId: string;
  artifact: LtmSerializedPromptArtifact | null | undefined;
  finalMessages: ReadonlyArray<Pick<ChatMessage, "content">>;
  recordInjection?: (input: {
    chatId: string;
    chunks: LtmSerializedPromptArtifact["chunks"];
    serializedTokenCount: number;
  }) => Promise<unknown>;
}

export function resolveGenerationLongTermMemoryScope(chat: {
  id: string;
  groupId?: string | null;
  characterIds?: string[];
}): LtmScope {
  return withMergedLtmScopeLinks(
    {
      chatId: chat.id,
      ...(chat.groupId ? { groupId: chat.groupId } : {}),
      ...(chat.characterIds?.length ? { characterIds: chat.characterIds } : {}),
    },
    { chatIds: [chat.id] },
  );
}

export function parseLongTermMemoryBudgetTokens(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(128, Math.min(16_384, Math.floor(value)));
}

export function parseLongTermMemoryMaxChunks(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

export function parseLongTermMemoryScoreThreshold(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

export function parseLongTermMemoryContextMessages(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 4;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function parseSparseChatNumber(value: unknown, min: number, max: number, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (integer && !Number.isInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function parseSparseChatBudgetTokens(value: unknown) {
  return parseSparseChatNumber(value, 128, 16_384, true);
}

function parseSparseChatMaxChunks(value: unknown) {
  return parseSparseChatNumber(value, 1, 100, true);
}

function parseSparseChatScoreThreshold(value: unknown) {
  return parseSparseChatNumber(value, 0, 1);
}

function parseSparseChatContextMessages(value: unknown) {
  return parseSparseChatNumber(value, 1, 20, true);
}

function readLongTermMemoryBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readLongTermMemoryRecallStyle(value: unknown): LongTermMemoryRecallStyle | undefined {
  return value === "balanced" || value === "exact" || value === "broad" || value === "story" ? value : undefined;
}

function readLongTermMemoryRecallPreamble(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function readSparseChatRecallWeight(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function resolveSparseChatRecallWeights(chatMeta: Record<string, unknown>, fallback: LtmRecallWeights): LtmRecallWeights {
  return {
    semanticWeight: readSparseChatRecallWeight(chatMeta.longTermMemorySemanticWeight, fallback.semanticWeight),
    lexicalWeight: readSparseChatRecallWeight(chatMeta.longTermMemoryLexicalWeight, fallback.lexicalWeight),
    graphWeight: readSparseChatRecallWeight(chatMeta.longTermMemoryGraphWeight, fallback.graphWeight),
    keywordWeight: readSparseChatRecallWeight(chatMeta.longTermMemoryKeywordWeight, fallback.keywordWeight),
  };
}

export interface ResolvedGenerationLongTermMemorySettings {
  enabled: boolean;
  budgetTokens?: number;
  maxChunks?: number;
  scoreThreshold?: number;
  recallStyle: LongTermMemoryRecallStyle;
  weights: LtmRecallWeights;
  debugEnabled: boolean;
  contextMessages: number;
  includeResolved: boolean;
  recallPreamble: string;
}

/**
 * Global settings are the durable default. Chat metadata only supplies sparse
 * overrides, including an optional style-specific weight profile.
 */
export function resolveGenerationLongTermMemorySettings(input: {
  chatMode: string;
  chatMeta: Record<string, unknown>;
  globalSettings?: LtmResolvedGlobalSettings;
  requestDebug?: boolean;
}): ResolvedGenerationLongTermMemorySettings {
  const { chatMeta, globalSettings } = input;
  const modeFallback = DEFAULT_LTM_RECALL_STYLE_BY_MODE[ltmModeForChatMode(input.chatMode)];
  const chatRecallStyle = readLongTermMemoryRecallStyle(chatMeta.longTermMemoryRecallStyle);
  const globalRecallStyle = globalSettings
    ? parseLongTermMemoryRecallStyle(globalSettings.longTermMemoryRecallStyle)
    : modeFallback;
  const recallStyle = chatRecallStyle ?? globalRecallStyle;
  const styleWeights = LTM_RECALL_STYLE_WEIGHTS[recallStyle];
  const globalWeights: LtmRecallWeights = globalSettings
    ? {
        semanticWeight: globalSettings.longTermMemorySemanticWeight,
        lexicalWeight: globalSettings.longTermMemoryLexicalWeight,
        graphWeight: globalSettings.longTermMemoryGraphWeight,
        keywordWeight: globalSettings.longTermMemoryKeywordWeight,
      }
    : styleWeights;

  return {
    enabled: readLongTermMemoryBoolean(chatMeta.enableLongTermMemory) ?? globalSettings?.enableLongTermMemory ?? false,
    budgetTokens:
      parseSparseChatBudgetTokens(chatMeta.longTermMemoryBudgetTokens) ??
      parseLongTermMemoryBudgetTokens(globalSettings?.longTermMemoryBudgetTokens),
    maxChunks:
      parseSparseChatMaxChunks(chatMeta.longTermMemoryMaxChunks) ??
      parseLongTermMemoryMaxChunks(globalSettings?.longTermMemoryMaxChunks),
    scoreThreshold:
      parseSparseChatScoreThreshold(chatMeta.longTermMemoryScoreThreshold) ??
      parseLongTermMemoryScoreThreshold(globalSettings?.longTermMemoryScoreThreshold),
    recallStyle,
    weights: resolveSparseChatRecallWeights(chatMeta, chatRecallStyle ? styleWeights : globalWeights),
    debugEnabled:
      (readLongTermMemoryBoolean(chatMeta.longTermMemoryDebug) ?? globalSettings?.longTermMemoryDebug ?? false) ||
      input.requestDebug === true,
    contextMessages:
      parseSparseChatContextMessages(chatMeta.longTermMemoryRecallContextMessages) ??
      parseLongTermMemoryContextMessages(globalSettings?.longTermMemoryRecallContextMessages),
    includeResolved:
      readLongTermMemoryBoolean(chatMeta.longTermMemoryIncludeResolved) ??
      globalSettings?.longTermMemoryIncludeResolved ??
      false,
    recallPreamble:
      readLongTermMemoryRecallPreamble(chatMeta.longTermMemoryRecallPreamble) ??
      globalSettings?.longTermMemoryRecallPreamble ??
      "",
  };
}

export function buildGenerationLongTermMemoryPlan(
  input: BuildGenerationLongTermMemoryPlanInput,
): GenerationLongTermMemoryPlan {
  const settings = resolveGenerationLongTermMemorySettings(input);
  const scope = resolveGenerationLongTermMemoryScope({
    id: input.chatId,
    groupId: input.groupId,
    characterIds: input.promptCharacterIds,
  });
  const lastUserMessageText =
    [...input.inputMessages].reverse().find((message) => message.role === "user")?.content ?? input.userMessage ?? "";
  const generationGuideText =
    typeof input.generationGuide === "string" && input.generationGuide.trim()
      ? `Generation guide:\n${input.generationGuide.trim()}`
      : "";
  const gameStateQuery =
    input.chatMode === "game" && input.gameState
      ? `Game state:\n${JSON.stringify(input.gameState).slice(0, 4_000)}`
      : "";
  const queryText = [
    lastUserMessageText,
    input.activeCharacterNames.length > 0 ? `Active characters: ${input.activeCharacterNames.join(", ")}` : "",
    input.lorebookGenerationTriggers.length > 0
      ? `Generation triggers: ${input.lorebookGenerationTriggers.join(", ")}`
      : "",
    generationGuideText,
    gameStateQuery,
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

  return {
    enabled: settings.enabled,
    budgetTokens: settings.budgetTokens,
    maxChunks: settings.maxChunks,
    scoreThreshold: settings.scoreThreshold,
    recallStyle: settings.recallStyle,
    weights: settings.weights,
    debugEnabled: settings.debugEnabled,
    contextMessages: settings.contextMessages,
    includeResolved: settings.includeResolved,
    recallPreamble: settings.recallPreamble,
    scope,
    queryText,
    lastUserMessageText,
    retrievalInput: {
      mode: ltmModeForChatMode(input.chatMode),
      queryText,
      recentUserMessage: lastUserMessageText || undefined,
      recentMessages: input.inputMessages
        .slice(-settings.contextMessages)
        .map((message) => message.content)
        .filter(Boolean),
      mentionedCharacterNames: [
        ...input.activeCharacterNames,
        ...((input.mentionedCharacterNames as string[] | undefined) ?? []),
      ],
      scope,
      characterIds: input.promptCharacterIds,
      includeResolved: settings.includeResolved,
      maxChunks: settings.maxChunks,
      maxTokens: settings.budgetTokens,
      minScore: settings.scoreThreshold,
      ...settings.weights,
      metadataMode: "direct_matches",
      dedupeExactText: true,
      applyUsageCooldown: true,
      embeddingSource: input.embeddingSource ?? undefined,
      debug: settings.debugEnabled,
      explain: settings.debugEnabled,
    },
    activeCharacterNames: input.activeCharacterNames,
    generationTriggerCount: input.lorebookGenerationTriggers.length,
    hasGenerationGuide: Boolean(generationGuideText),
    hasGameState: Boolean(gameStateQuery),
  };
}

export async function applyGenerationLongTermMemoryInjection(
  input: ApplyGenerationLongTermMemoryInjectionInput,
): Promise<ApplyGenerationLongTermMemoryInjectionResult> {
  const { retrieval, artifact } = await retrieveGenerationLongTermMemoryBlock({
    plan: input.plan,
    retrieveLongTermMemoryFn: input.retrieveLongTermMemoryFn,
  });
  if (!artifact) {
    logger.debug("[ltm] No chunks retrieved for generation injection");
    return {
      retrieval,
      injection: {
        block: "",
        inserted: false,
        insertAt: null,
        insertedBeforeRole: null,
      },
    };
  }

  const injection = injectLongTermMemoryPromptBlock(input.finalMessages, retrieval.chunks, {
    preamble: input.plan.recallPreamble,
    maxTokens: artifact.maxTokens,
  });
  return {
    retrieval,
    injection: {
      block: injection.block,
      inserted: injection.inserted,
      insertAt: injection.insertAt,
      insertedBeforeRole: input.finalMessages[injection.insertAt + 1]?.role ?? null,
    },
  };
}

export async function retrieveGenerationLongTermMemoryBlock(
  input: RetrieveGenerationLongTermMemoryBlockInput,
): Promise<RetrieveGenerationLongTermMemoryBlockResult> {
  const retrieval = await (input.retrieveLongTermMemoryFn ?? retrieveLongTermMemory)(input.plan.retrievalInput);
  return {
    retrieval,
    artifact: createLongTermMemoryPromptArtifact(retrieval.chunks, {
      preamble: input.plan.recallPreamble,
      maxTokens: retrieval.maxTokens,
    }),
  };
}

/**
 * Persist accounting only once a provider has accepted a payload containing
 * the complete serialized LTM artifact. Telemetry must never make generation
 * fail after dispatch succeeds.
 */
export async function recordGenerationLongTermMemoryDispatch(
  input: RecordGenerationLongTermMemoryDispatchInput,
): Promise<boolean> {
  if (!input.artifact || !isLongTermMemoryPromptArtifactPresent(input.finalMessages, input.artifact)) return false;

  try {
    await (input.recordInjection ?? recordLongTermMemoryInjection)({
      chatId: input.chatId,
      chunks: input.artifact.chunks,
      serializedTokenCount: input.artifact.estimatedTokens,
    });
    return true;
  } catch (err) {
    logger.warn(err, "[ltm] Failed to persist post-dispatch injection accounting");
    return false;
  }
}
