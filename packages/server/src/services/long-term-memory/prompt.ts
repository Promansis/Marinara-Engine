import type { LtmBudgetedChunk } from "./budget.js";
import { cleanLongTermMemoryChunkText } from "./chunking.js";

const NOTE_TYPE_LABELS: Record<string, string> = {
  character: "CHARACTERS",
  relationship: "RELATIONSHIPS",
  world: "WORLD",
  timeline_event: "TIMELINE",
  thread: "THREADS",
  tone: "TONE",
};

export function formatLongTermMemoryBlock(chunks: LtmBudgetedChunk[]) {
  const groups = new Map<string, LtmBudgetedChunk[]>();
  for (const c of chunks) {
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
          return `${text} [${c.chunk.status}]`;
        }
        return text;
      })
      .filter(Boolean);
    if (lines.length > 0) {
      sections.push(`[${label}]\n${lines.join("\n")}`);
    }
  }

  return sections.join("\n\n");
}
