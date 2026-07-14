export type LtmManagedExtractionPrefs = {
  autoApplyLowRisk: boolean;
  connectionId: string;
  instruction: string;
  model: string;
};

export function readLtmManagedExtractionPrefs(settings: Record<string, unknown>): LtmManagedExtractionPrefs {
  return {
    autoApplyLowRisk: settings.autoApplyLowRisk === true,
    connectionId: typeof settings.connectionId === "string" ? settings.connectionId : "",
    instruction: typeof settings.instruction === "string" ? settings.instruction : "",
    model: typeof settings.model === "string" ? settings.model : "",
  };
}
