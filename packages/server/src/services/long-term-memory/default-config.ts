import type { LtmPoliciesConfig, LtmRetrievalConfig } from "@marinara-engine/shared";

export const DEFAULT_LTM_POLICIES: LtmPoliciesConfig = {
  version: 1,
  policies: [
    {
      type: "character",
      injection: "always_for_active_characters",
      sectionsAlways: ["core", "current_state"],
      sectionsOnRelevance: ["personality", "history", "secrets"],
    },
    {
      type: "relationship",
      injection: "on_relevance",
      sectionsAlways: [],
      sectionsOnRelevance: ["*"],
    },
    {
      type: "thread",
      injection: "on_relevance",
      sectionsAlways: [],
      sectionsOnRelevance: ["*"],
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
  metadataWeight: 1,
  keywordWeight: 0.2,
};
