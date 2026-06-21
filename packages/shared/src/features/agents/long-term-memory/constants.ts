import type { LtmExtractionReasoningEffort, LtmExtractionVerbosity } from "./schema.js";
import type { LongTermMemoryRecallStyle } from "../../../types/chat.js";

export const DEFAULT_LTM_EXTRACTION_REASONING_EFFORT = "low" satisfies LtmExtractionReasoningEffort;
export const DEFAULT_LTM_EXTRACTION_VERBOSITY = "low" satisfies LtmExtractionVerbosity;
export const DEFAULT_LTM_EXTRACTION_MAX_TOKENS = 8192;
export const DEFAULT_LTM_EXTRACTION_TEMPERATURE = 0;
export const DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS = 6_000;
export const DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS = 3_000;
export const DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS = 12;
export const DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS = 2_400;
export const LTM_DRAFT_MUTATION_LIMIT = 25;

export const DEFAULT_LTM_RECALL_STYLE = "balanced" satisfies LongTermMemoryRecallStyle;
export const DEFAULT_LTM_RECALL_PREAMBLE = "Relevant long-term memories for this reply:";

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

export const DEFAULT_LTM_RECALL_STYLE_WEIGHTS = LTM_RECALL_STYLE_WEIGHTS[DEFAULT_LTM_RECALL_STYLE];

export type LtmRecallWeights = {
  semanticWeight: number;
  lexicalWeight: number;
  graphWeight: number;
  metadataWeight: number;
};

export function clampLtmRecallWeight(value: unknown, fallback: number, min = 0, max = 2) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function readLtmRecallWeightOverrides(
  metadata: Record<string, unknown>,
  fallback: LtmRecallWeights,
): LtmRecallWeights {
  const read = (value: unknown, defaultValue: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : defaultValue;
  return {
    semanticWeight: read(metadata.longTermMemorySemanticWeight, fallback.semanticWeight, 0, 1),
    lexicalWeight: read(metadata.longTermMemoryLexicalWeight, fallback.lexicalWeight, 0, 1),
    graphWeight: read(metadata.longTermMemoryGraphWeight, fallback.graphWeight, 0, 1),
    metadataWeight: read(metadata.longTermMemoryMetadataWeight, fallback.metadataWeight, 0, 2),
  };
}

export function parseLongTermMemoryRecallStyle(value: unknown): LongTermMemoryRecallStyle {
  return value === "exact" || value === "broad" || value === "story" ? value : DEFAULT_LTM_RECALL_STYLE;
}
