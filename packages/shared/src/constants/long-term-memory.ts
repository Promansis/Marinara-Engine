import type { LtmExtractionReasoningEffort, LtmExtractionVerbosity } from "../schemas/long-term-memory.schema.js";

export const DEFAULT_LTM_EXTRACTION_REASONING_EFFORT = "low" satisfies LtmExtractionReasoningEffort;
export const DEFAULT_LTM_EXTRACTION_VERBOSITY = "low" satisfies LtmExtractionVerbosity;
export const DEFAULT_LTM_EXTRACTION_MAX_TOKENS = 8192;
export const DEFAULT_LTM_EXTRACTION_TEMPERATURE = 0;
export const DEFAULT_LTM_EXTRACTION_MAX_SOURCE_CHARS = 24_000;
export const DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_CHARS = 12_000;
export const DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS = 12;
export const DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS = 2_400;
export const LTM_DRAFT_MUTATION_LIMIT = 25;
