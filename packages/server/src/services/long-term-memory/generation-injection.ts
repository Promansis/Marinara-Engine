import {
  resolveLongTermMemoryRecallSettings,
  withMergedLtmScopeLinks,
  type LtmResolvedGlobalSettings,
  type LongTermMemoryRecallStyle,
  type LtmRecallWeights,
  type LtmScope,
  type WrapFormat,
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
import { getLtmGlobalSettings } from "./settings.js";
import {
  createLongTermMemoryPromptArtifact,
  injectLongTermMemoryPromptArtifact,
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
  signal?: AbortSignal;
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

export interface PrepareGenerationLongTermMemoryInput extends BuildGenerationLongTermMemoryPlanInput {
  agentsEnabled: boolean;
  activeAgentIds: string[];
  retrieveLongTermMemoryFn?: (input: RetrieveLongTermMemoryInput) => Promise<RetrieveLongTermMemoryResult>;
  recordInjection?: RecordGenerationLongTermMemoryDispatchInput["recordInjection"];
}

export interface GenerationLongTermMemoryPlacementOptions {
  wrapFormat?: WrapFormat;
  wrapperName?: string;
}

export interface GenerationLongTermMemory {
  readonly plan: GenerationLongTermMemoryPlan;
  readonly retrieval: RetrieveLongTermMemoryResult | null;
  readonly artifact: LtmPromptArtifact | null;
  acceptAssembledArtifact(artifact?: LtmSerializedPromptArtifact | null): void;
  ensurePlaced(messages: ChatMessage[], options?: GenerationLongTermMemoryPlacementOptions): ChatMessage[];
  recordAccepted(messages: ReadonlyArray<Pick<ChatMessage, "content">>): Promise<boolean>;
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

function resolveGenerationLongTermMemoryScope(chat: {
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

function longTermMemoryRecallAbortError() {
  const error = new Error("Long-term memory recall was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfLongTermMemoryRecallAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw longTermMemoryRecallAbortError();
}

function resolveGenerationLongTermMemoryChatMeta(input: PrepareGenerationLongTermMemoryInput) {
  return {
    ...input.chatMeta,
    enableLongTermMemory:
      input.agentsEnabled &&
      input.activeAgentIds.includes("long-term-memory") &&
      input.chatMeta.enableLongTermMemory !== false,
  };
}

function createGenerationLongTermMemory(input: {
  chatId: string;
  plan: GenerationLongTermMemoryPlan;
  retrieval: RetrieveLongTermMemoryResult | null;
  artifact: LtmPromptArtifact | null;
  recordInjection?: RecordGenerationLongTermMemoryDispatchInput["recordInjection"];
}): GenerationLongTermMemory {
  let serializedArtifact: LtmSerializedPromptArtifact | null = null;
  let dispatchAccountingAttempted = false;

  return {
    plan: input.plan,
    retrieval: input.retrieval,
    artifact: input.artifact,
    acceptAssembledArtifact(artifact) {
      serializedArtifact = artifact ?? null;
    },
    ensurePlaced(messages, options) {
      if (!serializedArtifact && input.artifact) {
        serializedArtifact = injectLongTermMemoryPromptArtifact(messages, input.artifact, options).artifact;
      }
      return messages;
    },
    async recordAccepted(messages) {
      if (
        dispatchAccountingAttempted ||
        !serializedArtifact ||
        !isLongTermMemoryPromptArtifactPresent(messages, serializedArtifact)
      ) {
        return false;
      }

      dispatchAccountingAttempted = true;
      return recordGenerationLongTermMemoryDispatch({
        chatId: input.chatId,
        artifact: serializedArtifact,
        finalMessages: messages,
        recordInjection: input.recordInjection,
      });
    },
  };
}

export function loadGenerationLongTermMemorySettings() {
  return getLtmGlobalSettings();
}

export function buildGenerationLongTermMemoryPlan(
  input: BuildGenerationLongTermMemoryPlanInput,
): GenerationLongTermMemoryPlan {
  const settings = resolveLongTermMemoryRecallSettings({
    chatMode: input.chatMode,
    chatMetadata: input.chatMeta,
    globalSettings: input.globalSettings,
    requestDebug: input.requestDebug,
  });
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
      ...(input.embeddingSource ? { embeddingSource: input.embeddingSource } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      debug: settings.debugEnabled,
      explain: settings.debugEnabled,
    },
    activeCharacterNames: input.activeCharacterNames,
    generationTriggerCount: input.lorebookGenerationTriggers.length,
    hasGenerationGuide: Boolean(generationGuideText),
    hasGameState: Boolean(gameStateQuery),
  };
}

export async function prepareGenerationLongTermMemory(
  input: PrepareGenerationLongTermMemoryInput,
): Promise<GenerationLongTermMemory> {
  throwIfLongTermMemoryRecallAborted(input.signal);

  const plan = buildGenerationLongTermMemoryPlan({
    ...input,
    chatMeta: resolveGenerationLongTermMemoryChatMeta(input),
  });
  if (!plan.enabled) {
    return createGenerationLongTermMemory({
      chatId: input.chatId,
      plan,
      retrieval: null,
      artifact: null,
      recordInjection: input.recordInjection,
    });
  }

  const retrieval = await (input.retrieveLongTermMemoryFn ?? retrieveLongTermMemory)(plan.retrievalInput);
  const artifact = createLongTermMemoryPromptArtifact(retrieval.chunks, {
    preamble: plan.recallPreamble,
    maxTokens: retrieval.maxTokens,
  });
  throwIfLongTermMemoryRecallAborted(input.signal);

  return createGenerationLongTermMemory({
    chatId: input.chatId,
    plan,
    retrieval,
    artifact,
    recordInjection: input.recordInjection,
  });
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
