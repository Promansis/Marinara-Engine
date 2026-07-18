import type { ChatMode } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { getCapabilityService } from "../capability-packages/capability-service-registry.service.js";

const SERVICE_KEY = "long-term-memory:runtime";
const MAX_RECALL_CHARACTERS = 100_000;

export type LongTermMemoryRecallReceipt = unknown;

export interface LongTermMemoryRuntimeService {
  recall(input: {
    chatId: string;
    chatMode: ChatMode;
    characterIds: string[];
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    signal?: AbortSignal;
    debugMode: boolean;
  }): Promise<{ text: string; receipt?: LongTermMemoryRecallReceipt } | null>;
  recordPromptAccepted(input: {
    chatId: string;
    receipt: LongTermMemoryRecallReceipt;
    messages: Array<{ role: string; content: string }>;
  }): Promise<void>;
  onTurnFinalized?(input: {
    chatId: string;
    chatMode: ChatMode;
    messageId: string;
    swipeIndex: number;
    content: string;
    characterId: string | null;
    regenerate: boolean;
    continuation: boolean;
  }): Promise<void>;
}

function runtimeService() {
  return getCapabilityService<LongTermMemoryRuntimeService>(SERVICE_KEY);
}

export async function recallLongTermMemory(
  input: Parameters<LongTermMemoryRuntimeService["recall"]>[0],
): Promise<{ text: string; receipt?: LongTermMemoryRecallReceipt } | null> {
  const service = runtimeService();
  if (!service) return null;
  try {
    const recall = await service.recall(input);
    const text = recall?.text.trim().slice(0, MAX_RECALL_CHARACTERS) ?? "";
    return text ? { text, receipt: recall?.receipt ?? null } : null;
  } catch (error) {
    if (input.signal?.aborted) return null;
    logger.warn(error, "Long-term memory recall failed; continuing without recalled context");
    return null;
  }
}

export async function recordLongTermMemoryPromptAccepted(
  input: Parameters<LongTermMemoryRuntimeService["recordPromptAccepted"]>[0],
): Promise<void> {
  const service = runtimeService();
  if (!service) return;
  try {
    await service.recordPromptAccepted(input);
  } catch (error) {
    logger.warn(error, "Long-term memory prompt accounting failed");
  }
}

export async function notifyLongTermMemoryTurnFinalized(
  input: Parameters<NonNullable<LongTermMemoryRuntimeService["onTurnFinalized"]>>[0],
): Promise<void> {
  const service = runtimeService();
  if (!service) return;
  try {
    await service.onTurnFinalized?.(input);
  } catch (error) {
    logger.warn(error, "Long-term memory finalized-turn capture failed");
  }
}
