export type LtmExtractionDiagnostic = {
  severity: "warning" | "error";
  code: string;
  candidateIndex?: number;
  mutationId?: string;
  noteId?: string;
  message: string;
  details?: Record<string, unknown>;
};
