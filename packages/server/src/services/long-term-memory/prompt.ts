import type { LtmBudgetedChunk } from "./budget.js";
import { cleanLongTermMemoryChunkText } from "./chunking.js";
import type { ChatMessage } from "../llm/base-provider.js";

interface FormatLongTermMemoryBlockOptions {
  preamble?: string;
}

const NOTE_TYPE_LABELS: Record<string, string> = {
  character: "CHARACTERS",
  relationship: "RELATIONSHIPS",
  world: "WORLD",
  timeline_event: "TIMELINE",
  thread: "THREADS",
  tone: "TONE",
};

function normalizedPromptText(text: string) {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function formatLongTermMemoryBlock(chunks: LtmBudgetedChunk[], options?: FormatLongTermMemoryBlockOptions) {
  const groups = new Map<string, LtmBudgetedChunk[]>();
  const seenText = new Set<string>();
  for (const c of chunks) {
    const text = cleanLongTermMemoryChunkText(c.chunk.text);
    const comparable = normalizedPromptText(text);
    if (!comparable || seenText.has(comparable)) continue;
    seenText.add(comparable);
    const label = NOTE_TYPE_LABELS[c.chunk.noteType] ?? c.chunk.noteType.toUpperCase();
    const group = groups.get(label);
    if (group) {
      group.push(c);
    } else {
      groups.set(label, [c]);
    }
  }

  const sections: string[] = [];
  for (const [label, items] of groups) {
    const lines = items
      .map((c) => {
        const text = cleanLongTermMemoryChunkText(c.chunk.text);
        if (!text) return "";
        if (c.chunk.noteType === "thread") {
          const tags = c.chunk.tags ?? [];
          const questTag = tags.includes("quest") ? " quest" : "";
          return `${text} [${c.chunk.status}${questTag}]`;
        }
        return text;
      })
      .filter(Boolean);
    if (lines.length > 0) {
      sections.push(`[${label}]\n${lines.join("\n")}`);
    }
  }

  const body = sections.join("\n\n");
  if (!body) return "";
  const preamble = options?.preamble?.trim();
  return preamble ? `${preamble}\n\n${body}` : body;
}

export function injectLongTermMemoryPromptBlock(
  messages: ChatMessage[],
  chunks: LtmBudgetedChunk[],
  options?: FormatLongTermMemoryBlockOptions,
): { block: string; insertAt: number; inserted: boolean } {
  const block = formatLongTermMemoryBlock(chunks, options);
  if (!block) {
    return { block, insertAt: messages.length, inserted: false };
  }

  const firstChatIdx = messages.findIndex((message) => message.role === "user" || message.role === "assistant");
  const insertAt = firstChatIdx >= 0 ? firstChatIdx : messages.length;
  messages.splice(insertAt, 0, {
    role: "system",
    content: block,
    contextKind: "injection",
  });
  return { block, insertAt, inserted: true };
}
