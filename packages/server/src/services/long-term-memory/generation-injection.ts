import {
  LTM_RECALL_STYLE_WEIGHTS,
  readLtmRecallWeightOverrides,
  parseLongTermMemoryRecallStyle,
  withMergedLtmScopeLinks,
  type LongTermMemoryRecallStyle,
  type LtmRecallWeights,
  type LtmScope,
} from "@marinara-engine/shared";
import type { ChatMessage } from "../llm/base-provider.js";
import type { MemoryRecallEmbeddingSource } from "../memory-recall.js";
import {
  retrieveLongTermMemory,
  type RetrieveLongTermMemoryInput,
  type RetrieveLongTermMemoryResult,
} from "./retrieval.js";
import { formatLongTermMemoryBlock, injectLongTermMemoryPromptBlock } from "./prompt.js";

type GenerationPromptInputMessage = Pick<ChatMessage, "role" | "content">;

export interface BuildGenerationLongTermMemoryPlanInput {
  chatId: string;
  chatMode: string;
  groupId?: string | null;
  promptCharacterIds: string[];
  activeCharacterNames: string[];
  inputMessages: GenerationPromptInputMessage[];
  chatMeta: Record<string, unknown>;
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
  block: string;
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

export function buildGenerationLongTermMemoryPlan(
  input: BuildGenerationLongTermMemoryPlanInput,
): GenerationLongTermMemoryPlan {
  const budgetTokens = parseLongTermMemoryBudgetTokens(input.chatMeta.longTermMemoryBudgetTokens);
  const maxChunks = parseLongTermMemoryMaxChunks(input.chatMeta.longTermMemoryMaxChunks);
  const scoreThreshold = parseLongTermMemoryScoreThreshold(input.chatMeta.longTermMemoryScoreThreshold);
  const recallStyle = parseLongTermMemoryRecallStyle(input.chatMeta.longTermMemoryRecallStyle);
  const weights = readLtmRecallWeightOverrides(input.chatMeta, LTM_RECALL_STYLE_WEIGHTS[recallStyle]);
  const debugEnabled = input.chatMeta.longTermMemoryDebug === true || input.requestDebug === true;
  const contextMessages = parseLongTermMemoryContextMessages(input.chatMeta.longTermMemoryRecallContextMessages);
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
    enabled: input.chatMeta.enableLongTermMemory === true,
    budgetTokens,
    maxChunks,
    scoreThreshold,
    recallStyle,
    weights,
    debugEnabled,
    contextMessages,
    includeResolved: input.chatMeta.longTermMemoryIncludeResolved === true,
    scope,
    queryText,
    lastUserMessageText,
    retrievalInput: {
      queryText,
      recentUserMessage: lastUserMessageText || undefined,
      recentMessages: input.inputMessages
        .slice(-contextMessages)
        .map((message) => message.content)
        .filter(Boolean),
      mentionedCharacterNames: [
        ...input.activeCharacterNames,
        ...((input.mentionedCharacterNames as string[] | undefined) ?? []),
      ],
      scope,
      characterIds: input.promptCharacterIds,
      includeResolved: input.chatMeta.longTermMemoryIncludeResolved === true,
      maxChunks,
      maxTokens: budgetTokens,
      minScore: scoreThreshold,
      ...weights,
      metadataMode: "filter_only",
      dedupeExactText: true,
      applyUsageCooldown: true,
      embeddingSource: input.embeddingSource ?? undefined,
      debug: debugEnabled,
      explain: debugEnabled,
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
  const { retrieval, block } = await retrieveGenerationLongTermMemoryBlock({
    plan: input.plan,
    retrieveLongTermMemoryFn: input.retrieveLongTermMemoryFn,
  });
  if (retrieval.chunks.length === 0) {
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

  const injection = injectLongTermMemoryPromptBlock(input.finalMessages, retrieval.chunks);
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
    block: retrieval.chunks.length > 0 ? formatLongTermMemoryBlock(retrieval.chunks) : "",
  };
}
