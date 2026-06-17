import type { LtmExtractionReasoningEffort, LtmExtractionVerbosity } from "../schemas/long-term-memory.schema.js";
import type { LongTermMemoryRecallStyle } from "../types/chat.js";

export const DEFAULT_LTM_EXTRACTION_REASONING_EFFORT = "low" satisfies LtmExtractionReasoningEffort;
export const DEFAULT_LTM_EXTRACTION_VERBOSITY = "low" satisfies LtmExtractionVerbosity;
export const DEFAULT_LTM_EXTRACTION_MAX_TOKENS = 8192;
export const DEFAULT_LTM_EXTRACTION_TEMPERATURE = 0;
export const DEFAULT_LTM_EXTRACTION_MAX_SOURCE_CHARS = 24_000;
export const DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_CHARS = 12_000;
export const DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS = 12;
export const DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS = 2_400;
export const LTM_DRAFT_MUTATION_LIMIT = 25;

export const DEFAULT_LTM_RECALL_STYLE = "balanced" satisfies LongTermMemoryRecallStyle;

export const LTM_RECALL_STYLE_WEIGHTS = {
  balanced: {
    semanticWeight: 0.6,
    lexicalWeight: 0.3,
    graphWeight: 0.1,
    metadataWeight: 1,
  },
  exact: {
    semanticWeight: 0.15,
    lexicalWeight: 1,
    graphWeight: 0,
    metadataWeight: 0.3,
  },
  broad: {
    semanticWeight: 0.55,
    lexicalWeight: 0.2,
    graphWeight: 0.8,
    metadataWeight: 0.8,
  },
  story: {
    semanticWeight: 0.45,
    lexicalWeight: 0.25,
    graphWeight: 0.35,
    metadataWeight: 0.8,
  },
} as const satisfies Record<
  LongTermMemoryRecallStyle,
  {
    semanticWeight: number;
    lexicalWeight: number;
    graphWeight: number;
    metadataWeight: number;
  }
>;

export function parseLongTermMemoryRecallStyle(value: unknown): LongTermMemoryRecallStyle {
  return value === "exact" || value === "broad" || value === "story" ? value : DEFAULT_LTM_RECALL_STYLE;
}
