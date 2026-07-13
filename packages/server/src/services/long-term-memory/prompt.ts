import type { WrapFormat } from "@marinara-engine/shared";
import type { ChatMessage } from "../llm/base-provider.js";
import { wrapContent } from "../prompt/format-engine.js";
import { escapeXmlText } from "../prompt/prompt-escaping.js";
import type { LtmBudgetedChunk } from "./budget.js";
import { formatLtmChunkPromptText } from "./prompt-text.js";

interface FormatLongTermMemoryBlockOptions {
  preamble?: string;
  maxTokens?: number;
  wrapFormat?: WrapFormat;
  wrapperName?: string;
}

export interface LtmPromptArtifact {
  kind: "long_term_memory";
  chunks: LtmBudgetedChunk[];
  preamble: string;
  maxTokens: number;
}

export interface LtmSerializedPromptArtifact {
  kind: "long_term_memory";
  chunks: LtmBudgetedChunk[];
  content: string;
  estimatedTokens: number;
}

const NOTE_TYPE_LABELS: Record<string, string> = {
  character: "CHARACTERS",
  relationship: "RELATIONSHIPS",
  world: "WORLD",
  timeline_event: "TIMELINE",
  thread: "THREADS",
  tone: "TONE",
};

const UNBOUNDED_LTM_PROMPT_TOKENS = Number.MAX_SAFE_INTEGER;
const LTM_PROMPT_MESSAGE_OVERHEAD_TOKENS = 6;

function normalizedPromptText(text: string) {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function normalizedBudget(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return UNBOUNDED_LTM_PROMPT_TOKENS;
  return Math.max(1, Math.floor(value));
}

function serializeLongTermMemoryBody(chunks: LtmBudgetedChunk[], preamble: string) {
  const groups = new Map<string, string[]>();
  const seenText = new Set<string>();

  for (const item of chunks) {
    const rawText = formatLtmChunkPromptText(item.chunk);
    const comparable = normalizedPromptText(rawText);
    if (!comparable || seenText.has(comparable)) continue;
    seenText.add(comparable);

    const label = NOTE_TYPE_LABELS[item.chunk.noteType] ?? item.chunk.noteType.toUpperCase();
    const group = groups.get(label);
    const escapedText = escapeXmlText(rawText);
    if (group) {
      group.push(escapedText);
    } else {
      groups.set(label, [escapedText]);
    }
  }

  const sections = Array.from(groups, ([label, items]) => `[${label}]\n${items.join("\n")}`);
  const body = sections.join("\n\n");
  if (!body) return "";

  const normalizedPreamble = preamble.trim();
  return normalizedPreamble ? `${escapeXmlText(normalizedPreamble)}\n\n${body}` : body;
}

function serializeLongTermMemoryArtifactContent(
  chunks: LtmBudgetedChunk[],
  artifact: LtmPromptArtifact,
  options?: Pick<FormatLongTermMemoryBlockOptions, "wrapFormat" | "wrapperName">,
) {
  const body = serializeLongTermMemoryBody(chunks, artifact.preamble);
  if (!body) return "";
  if (!options?.wrapperName) return body;
  return wrapContent(body, options.wrapperName, options.wrapFormat ?? "none");
}

export function estimateLongTermMemoryPromptArtifactTokens(content: string) {
  return Math.ceil(Array.from(content).length / 4) + LTM_PROMPT_MESSAGE_OVERHEAD_TOKENS;
}

export function createLongTermMemoryPromptArtifact(
  chunks: LtmBudgetedChunk[],
  options?: Pick<FormatLongTermMemoryBlockOptions, "preamble" | "maxTokens">,
): LtmPromptArtifact | null {
  if (chunks.length === 0) return null;
  return {
    kind: "long_term_memory",
    chunks: [...chunks],
    preamble: options?.preamble?.trim() ?? "",
    maxTokens: normalizedBudget(options?.maxTokens),
  };
}

/**
 * Serializes whole chunks greedily in retrieval order. The estimate is taken
 * from the finished text, including the preamble, grouping separators, outer
 * wrapper, and ChatML message overhead.
 */
export function serializeLongTermMemoryPromptArtifact(
  artifact: LtmPromptArtifact | null | undefined,
  options?: Pick<FormatLongTermMemoryBlockOptions, "wrapFormat" | "wrapperName">,
): LtmSerializedPromptArtifact | null {
  if (!artifact) return null;

  const selected: LtmBudgetedChunk[] = [];
  const seenText = new Set<string>();
  for (const item of artifact.chunks) {
    const comparable = normalizedPromptText(formatLtmChunkPromptText(item.chunk));
    if (!comparable || seenText.has(comparable)) continue;
    seenText.add(comparable);

    const candidate = [...selected, item];
    const content = serializeLongTermMemoryArtifactContent(candidate, artifact, options);
    if (!content || estimateLongTermMemoryPromptArtifactTokens(content) > artifact.maxTokens) continue;
    selected.push(item);
  }

  if (selected.length === 0) return null;
  const content = serializeLongTermMemoryArtifactContent(selected, artifact, options);
  if (!content) return null;
  const estimatedTokens = estimateLongTermMemoryPromptArtifactTokens(content);
  if (estimatedTokens > artifact.maxTokens) return null;

  return {
    kind: "long_term_memory",
    chunks: selected,
    content,
    estimatedTokens,
  };
}

export function formatLongTermMemoryBlock(chunks: LtmBudgetedChunk[], options?: FormatLongTermMemoryBlockOptions) {
  const artifact = createLongTermMemoryPromptArtifact(chunks, options);
  return serializeLongTermMemoryPromptArtifact(artifact, options)?.content ?? "";
}

export function isLongTermMemoryPromptArtifactPresent(
  messages: ReadonlyArray<Pick<ChatMessage, "content">>,
  artifact: LtmSerializedPromptArtifact | null | undefined,
) {
  if (!artifact?.content) return false;
  return messages.some((message) => message.content.includes(artifact.content));
}

export function injectLongTermMemoryPromptArtifact(
  messages: ChatMessage[],
  artifact: LtmPromptArtifact | null | undefined,
  options?: Pick<FormatLongTermMemoryBlockOptions, "wrapFormat" | "wrapperName">,
): { artifact: LtmSerializedPromptArtifact | null; insertAt: number | null; inserted: boolean } {
  const serializedArtifact = serializeLongTermMemoryPromptArtifact(artifact, options);
  if (!serializedArtifact) {
    return { artifact: null, insertAt: null, inserted: false };
  }

  const firstChatIdx = messages.findIndex((message) => message.role === "user" || message.role === "assistant");
  const insertAt = firstChatIdx >= 0 ? firstChatIdx : messages.length;
  messages.splice(insertAt, 0, {
    role: "system",
    content: serializedArtifact.content,
    contextKind: "long_term_memory",
  });
  return { artifact: serializedArtifact, insertAt, inserted: true };
}
