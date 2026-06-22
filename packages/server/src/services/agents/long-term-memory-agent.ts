import {
  type AgentContext,
  type AgentResult,
  isConnectionlessAgentType,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { buildGenerationLongTermMemoryPlan } from "../long-term-memory/generation-injection.js";
import { retrieveGenerationLongTermMemoryBlock } from "../long-term-memory/generation-injection.js";
import { recordLongTermMemoryInjection } from "../long-term-memory/usage.js";
import { recordLtmDebugEvent } from "../long-term-memory/debug-log.js";
import type { AgentExecConfig } from "./agent-executor.js";

/**
 * Connectionless agent executor function.
 * Unlike executeAgent, this does not require an LLM provider or model.
 */
export type ConnectionlessAgentExecutor = (
  config: AgentExecConfig,
  context: AgentContext,
) => Promise<AgentResult>;

const connectionlessExecutors = new Map<string, ConnectionlessAgentExecutor>();

export function registerConnectionlessAgentExecutor(
  agentType: string,
  executor: ConnectionlessAgentExecutor,
): void {
  connectionlessExecutors.set(agentType, executor);
}

export function getConnectionlessAgentExecutor(
  config: AgentExecConfig,
): ConnectionlessAgentExecutor | null {
  return connectionlessExecutors.get(config.type) ?? null;
}

export function isConnectionlessExecutionSupported(config: AgentExecConfig): boolean {
  return isConnectionlessAgentType(config.type) && connectionlessExecutors.has(config.type);
}

/**
 * Execute the long-term-memory agent — a connectionless retrieval agent that
 * queries the LTM vault for relevant memories and returns them as a
 * context_injection result for the pre-generation pipeline.
 */
export async function executeLongTermMemoryAgent(
  config: AgentExecConfig,
  context: AgentContext,
): Promise<AgentResult> {
  const startTime = Date.now();
  const agentId = config.id;
  const agentType = config.type;

  try {
    const chatMeta: Record<string, unknown> = {
      ...(config.settings ?? {}),
    };
    const plan = buildGenerationLongTermMemoryPlan({
      chatId: context.chatId,
      chatMode: context.chatMode,
      promptCharacterIds: context.characters?.map((c) => c.id) ?? [],
      activeCharacterNames: context.characters?.map((c) => c.name) ?? [],
      inputMessages: (context.recentMessages ?? []).map((m) => ({
        role: m.role as "system" | "user" | "assistant" | "tool",
        content: m.content,
      })),
      chatMeta,
      lorebookGenerationTriggers: [],
      ...(context.chatSummary ? { generationGuide: context.chatSummary } : {}),
    });

    if (!plan.enabled) {
      logger.debug("[ltm-agent] LTM disabled, skipping retrieval");
      return {
        agentId,
        agentType,
        type: "context_injection",
        data: null as unknown as Record<string, never>,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
        success: true,
        error: null,
      };
    }

    const { retrieval, block } = await retrieveGenerationLongTermMemoryBlock({ plan });

    if (retrieval.chunks.length > 0) {
      await recordLongTermMemoryInjection(retrieval.chunks);
    }

    logger.debug(
      "[ltm-agent] Retrieved %d chunks (%d tokens) — block length %d",
      retrieval.chunks.length,
      retrieval.usedTokens,
      block.length,
    );

    if (plan.debugEnabled && retrieval.debug) {
      const uiSummary = JSON.stringify({
        memoryCount: new Set(retrieval.chunks.map((c) => c.chunk?.noteId).filter(Boolean)).size,
        tokenCount: retrieval.usedTokens,
        memories: Object.entries(
          retrieval.chunks.reduce<Record<string, { noteId: string; title: string; tokenCount: number }>>(
            (acc, c) => {
              const noteId = c.chunk?.noteId;
              if (!noteId) return acc;
              if (!acc[noteId]) acc[noteId] = { noteId, title: noteId, tokenCount: 0 };
              acc[noteId].tokenCount += c.estimatedTokens ?? 0;
              return acc;
            },
            {},
          ),
        )
          .map(([, v]) => v)
          .sort((a, b) => b.tokenCount - a.tokenCount)
          .slice(0, 5),
      });
      await recordLtmDebugEvent({
        operationId: crypto.randomUUID(),
        phase: "injection",
        action: "ltm-agent-retrieval",
        status: "ok",
        message: `LTM agent retrieved ${retrieval.chunks.length} chunks (${retrieval.usedTokens} tokens)`,
        durationMs: Date.now() - startTime,
        counts: { chunks: retrieval.chunks.length, tokens: retrieval.usedTokens },
        diagnostics: [retrieval.debug as unknown as Record<string, unknown>],
        chatId: context.chatId,
        uiSummary,
      });
    }

    return {
      agentId,
      agentType,
      type: "context_injection",
      data: { text: block },
      tokensUsed: retrieval.usedTokens,
      durationMs: Date.now() - startTime,
      success: true,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(err, "[ltm-agent] Retrieval failed: %s", message);
    return {
      agentId,
      agentType,
      type: "context_injection",
      data: null as unknown as Record<string, never>,
      tokensUsed: 0,
      durationMs: Date.now() - startTime,
      success: false,
      error: message,
    };
  }
}
