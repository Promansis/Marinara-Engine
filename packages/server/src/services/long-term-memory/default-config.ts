import type { LtmPoliciesConfig, LtmRetrievalConfig } from "@marinara-engine/shared";

export const DEFAULT_LTM_POLICIES: LtmPoliciesConfig = {
  version: 1,
  policies: [
    {
      type: "character",
      injection: "always_for_active_characters",
      sectionsAlways: ["core", "current_state"],
      sectionsOnRelevance: ["personality", "history", "secrets"],
      updateBehavior: "superseding",
      summarization: "none",
      pinAgainstSummarization: false,
    },
    {
      type: "relationship",
      injection: "on_relevance",
      sectionsAlways: [],
      sectionsOnRelevance: ["*"],
      updateBehavior: "cumulative_reconciled",
      reconcileEvery: 5,
      summarization: "reconcile_into_current_dynamic",
      pinAgainstSummarization: false,
    },
    {
      type: "thread",
      injection: "on_relevance",
      sectionsAlways: [],
      sectionsOnRelevance: ["*"],
      updateBehavior: "cumulative_until_resolved",
      summarization: "compact_when_resolved",
      pinAgainstSummarization: true,
      autoArchiveOn: "status=resolved",
    },
  ],
};

export const DEFAULT_LTM_RETRIEVAL_CONFIG: LtmRetrievalConfig = {
  version: 1,
  maxChunks: 12,
  maxTokens: 2_048,
  semanticWeight: 0.6,
  lexicalWeight: 0.3,
  graphWeight: 0.1,
  includeGates: [],
};
