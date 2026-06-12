import type { LtmBudgetedChunk } from "./budget.js";
import { cleanLongTermMemoryChunkText } from "./chunking.js";

export function formatLongTermMemoryBlock(chunks: LtmBudgetedChunk[]) {
  return chunks
    .map((item) => cleanLongTermMemoryChunkText(item.chunk.text))
    .filter((text) => text.length > 0)
    .join("\n\n");
}
