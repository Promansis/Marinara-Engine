export type LtmExtractionDiagnostic = {
  severity: "warning" | "error";
  code: string;
  mutationId?: string;
  noteId?: string;
  message: string;
};
