import { BUILT_IN_AGENTS, isManagedAgentType, type AgentCategory } from "@marinara-engine/shared";

export type AgentUiCategory = AgentCategory | "custom";

export function getAgentUiCategory(agentType: string): AgentUiCategory {
  const builtIn = BUILT_IN_AGENTS.find((agent) => agent.id === agentType);
  if (builtIn) return builtIn.category;
  if (isManagedAgentType(agentType)) return "misc";
  return "custom";
}

export function isUserCustomAgentType(agentType: string): boolean {
  return getAgentUiCategory(agentType) === "custom";
}
