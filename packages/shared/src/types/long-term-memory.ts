export type {
  LtmConflict,
  LtmDebugError,
  LtmDebugEvent,
  LtmDebugPhase,
  LtmDebugStatus,
  LtmEvent,
  LtmEvidenceUnit,
  LtmEvidenceUnitBucket,
  LtmEvidenceUnitExtractionResponse,
  LtmEvidenceUnitStatus,
  LtmExtractionReasoningEffort,
  LtmExtractionDraft,
  LtmExtractionResponse,
  LtmExtractionSettings,
  LtmExtractionVerbosity,
  LtmIndexMetadata,
  LtmLink,
  LtmMode,
  LtmNote,
  LtmNoteType,
  LtmPoliciesConfig,
  LtmPolicy,
  LtmRetrievalConfig,
  LtmScope,
  LtmSection,
  LtmStatus,
  LtmDraftMutation,
  LtmDraftNoteInput,
  LtmDraftRisk,
  LtmDraftSource,
  LtmDraftStatus,
  LtmResolvedExtractionSettings,
} from "../schemas/long-term-memory.schema.js";

export interface LtmExtractionPromptTemplate {
  id: string;
  name: string;
  prompt: string;
}
