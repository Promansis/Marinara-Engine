import { isManagedAgentType } from "@marinara-engine/shared";

function readNumber(value: unknown, fallback?: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readBoolean(value: unknown, fallback?: boolean): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return fallback;
}

function readString(value: unknown, fallback?: string): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return fallback;
}

/**
 * Apply per-chat long-term-memory metadata overrides onto the agent's settings.
 *
 * This mirrors applyKnowledgeAgentChatSettings (knowledge-agent-settings.ts).
 * When a chat has per-chat LTM overrides in its metadata (budget tokens, weights,
 * recall style, etc.), those are laid over the agent's base settings so the
 * per-turn pipeline sees the customised values without mutating the stored config.
 */
export function applyLtmAgentChatSettings(
  agentType: string,
  settings: Record<string, unknown>,
  chatMetadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!isManagedAgentType(agentType)) return settings;
  if (!chatMetadata || typeof chatMetadata !== "object") return settings;

  const next = { ...settings };

  const budgetTokens = readNumber(chatMetadata.longTermMemoryBudgetTokens);
  if (budgetTokens !== undefined) next.longTermMemoryBudgetTokens = budgetTokens;

  const maxChunks = readNumber(chatMetadata.longTermMemoryMaxChunks);
  if (maxChunks !== undefined) next.longTermMemoryMaxChunks = maxChunks;

  const scoreThreshold = readNumber(chatMetadata.longTermMemoryScoreThreshold);
  if (scoreThreshold !== undefined) next.longTermMemoryScoreThreshold = scoreThreshold;

  const contextMessages = readNumber(chatMetadata.longTermMemoryRecallContextMessages);
  if (contextMessages !== undefined) next.longTermMemoryRecallContextMessages = contextMessages;

  const recallStyle = readString(chatMetadata.longTermMemoryRecallStyle);
  if (recallStyle !== undefined) next.longTermMemoryRecallStyle = recallStyle;

  const semanticWeight = readNumber(chatMetadata.longTermMemorySemanticWeight);
  if (semanticWeight !== undefined) next.longTermMemorySemanticWeight = semanticWeight;

  const lexicalWeight = readNumber(chatMetadata.longTermMemoryLexicalWeight);
  if (lexicalWeight !== undefined) next.longTermMemoryLexicalWeight = lexicalWeight;

  const graphWeight = readNumber(chatMetadata.longTermMemoryGraphWeight);
  if (graphWeight !== undefined) next.longTermMemoryGraphWeight = graphWeight;

  const metadataWeight = readNumber(chatMetadata.longTermMemoryMetadataWeight);
  if (metadataWeight !== undefined) next.longTermMemoryMetadataWeight = metadataWeight;

  const keywordWeight = readNumber(chatMetadata.longTermMemoryKeywordWeight);
  if (keywordWeight !== undefined) next.longTermMemoryKeywordWeight = keywordWeight;

  const includeResolved = readBoolean(chatMetadata.longTermMemoryIncludeResolved);
  if (includeResolved !== undefined) next.longTermMemoryIncludeResolved = includeResolved;

  const debug = readBoolean(chatMetadata.longTermMemoryDebug);
  if (debug !== undefined) next.longTermMemoryDebug = debug;

  return next;
}
