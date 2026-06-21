import type { ManagedAgentType } from "../../types/agent.js";

/**
 * Feature panel ID for each managed agent type.
 * The client uses this to render a custom detail section inside AgentEditor
 * instead of the generic prompt/settings editor.
 */
export type ManagedAgentFeaturePanelId = "ltm-vault-manager";

export const MANAGED_AGENT_FEATURE_PANELS: Record<ManagedAgentType, ManagedAgentFeaturePanelId> = {
  "long-term-memory": "ltm-vault-manager",
};
