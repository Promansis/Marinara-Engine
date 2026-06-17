import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  LtmDraftMutation,
  LtmDraftStatus,
  LtmDebugEvent,
  LtmDebugPhase,
  LtmDebugStatus,
  LtmExtractionDraft,
  LtmExtractionOutcome,
  LtmExtractionResponse,
  LtmExtractionSettings as SharedLtmExtractionSettings,
  LtmNote,
  LtmNoteType,
  LtmResolvedExtractionSettings as SharedLtmResolvedExtractionSettings,
  LtmScope,
  LtmStatus,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";

export type LtmStatusResponse = {
  initialized: boolean;
  directory: string;
  notes: {
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
  };
  events: {
    logAvailable: boolean;
    bytes: number | null;
  };
  indexes: {
    manifestAvailable: boolean;
    errors: Array<{ index: string; code: string }>;
    generatedAt: string | null;
    sourceHash: string | null;
    noteCount: number | null;
    chunkCount: number | null;
    embeddingsAvailable: boolean;
    embeddedChunkCount: number;
  };
};

export type LtmIntegrityIssue = {
  severity: "info" | "warning" | "error";
  code: string;
  path?: string;
  noteId?: string;
  message: string;
};

export type LtmIntegrityResponse = {
  ok: boolean;
  checkedAt: string;
  noteCount: number;
  eventCount: number;
  issues: LtmIntegrityIssue[];
};

export type LtmReplayResponse = {
  replayable: boolean;
  checkedAt: string;
  eventCount: number;
  unsupportedEventCount: number;
  messages: string[];
};

export type LtmExtractionSettings = SharedLtmExtractionSettings;
export type LtmResolvedExtractionSettings = SharedLtmResolvedExtractionSettings;

export type LtmRepairResponse = {
  repairedAt: string;
  actions: Array<{ action: string; result: string; count?: number }>;
  integrity: LtmIntegrityResponse;
};

export type LtmInteropSource = "characters" | "lorebooks" | "chats";

export type LtmInteropPreview = {
  source: LtmInteropSource;
  scanned: number;
  draftable: number;
  samples: Array<{ sourceId: string; title: string; mutationCount: number; summary: string; snippet: string }>;
};

export type LtmSearchInput = {
  queryText?: string;
  recentUserMessage?: string;
  mentionedCharacterNames?: string[];
  noteIds?: string[];
  tags?: string[];
  scope?: LtmScope;
  characterIds?: string[];
  includeResolved?: boolean;
  includeSourceNotes?: boolean;
  debug?: boolean;
  maxChunks?: number;
  maxTokens?: number;
  minScore?: number;
  semanticWeight?: number;
  lexicalWeight?: number;
  graphWeight?: number;
  metadataWeight?: number;
};

export type LtmSearchChunk = {
  chunk?: {
    id?: string;
    noteId?: string;
    sectionKey?: string;
    text?: string;
    noteType?: string;
    status?: string;
  };
  score?: number;
  reasons?: string[];
  lanes?: string[];
  tier?: number;
  estimatedTokens?: number;
};

export type LtmSearchDebugCandidate = {
  chunkId: string;
  noteId?: string;
  sectionKey?: string;
  score: number;
  lanes: string[];
  reasons: string[];
  estimatedTokens?: number;
  rejectionReason?: string;
};

export type LtmSearchResponse = {
  chunks: LtmSearchChunk[];
  usedTokens: number;
  maxTokens: number;
  embeddingsAvailable: boolean;
  warnings: string[];
  debug?: {
    weights?: {
      semantic: number;
      lexical: number;
      graph: number;
      always?: number;
      metadata?: number;
      typedPriority?: number;
    };
    funnel?: Record<string, number>;
    selected?: LtmSearchDebugCandidate[];
    rejected?: LtmSearchDebugCandidate[];
  };
};

export type LtmDebugLogFilter = {
  limit?: number;
  operationId?: string;
  sourceNoteId?: string;
  draftId?: string;
  status?: LtmDebugStatus;
  phase?: LtmDebugPhase;
};

export type LtmDebugLogResponse = {
  events: LtmDebugEvent[];
};

export type LtmExtractionDiagnostic = {
  severity: "warning" | "error";
  code: string;
  mutationId?: string;
  noteId?: string;
  message: string;
};

export type ExtractLongTermMemorySourceInput = {
  noteId: string;
  chatId?: string;
  connectionId?: string;
  model?: string;
  instruction?: string;
  applyLowRisk?: boolean;
};

export type ExtractLongTermMemorySourceResponse = {
  draft: LtmExtractionDraft | null;
  diagnostics: LtmExtractionDiagnostic[];
  outcome: LtmExtractionOutcome;
  response: LtmExtractionResponse;
  appliedMutationIds: string[];
  skippedMutationIds: string[];
};

export type ApplyLongTermMemoryScopeToDerivedInput = {
  noteId: string;
  chatIds?: string[];
  characterIds?: string[];
};

export type ApplyLongTermMemoryScopeToDerivedResponse = {
  sourceNoteId: string;
  count: number;
  affectedNoteIds: string[];
  rebuild: unknown | null;
};

export type ImportLongTermMemorySourceNotesResponse = {
  source: LtmInteropSource;
  imported: Array<{
    sourceId: string;
    title: string;
    note: LtmNote;
    created: boolean;
    draft: LtmExtractionDraft | null;
    diagnostics: LtmExtractionDiagnostic[];
    outcome: LtmExtractionOutcome;
    appliedMutationIds: string[];
    skippedMutationIds: string[];
  }>;
  missingSourceIds: string[];
};

export const longTermMemoryKeys = {
  all: ["long-term-memory"] as const,
  status: () => [...longTermMemoryKeys.all, "status"] as const,
  integrity: () => [...longTermMemoryKeys.all, "integrity"] as const,
  notes: (filter?: LtmNoteFilter) => [...longTermMemoryKeys.all, "notes", filter ?? {}] as const,
  note: (id: string) => [...longTermMemoryKeys.all, "notes", id] as const,
  drafts: (filter?: LtmDraftFilter) => [...longTermMemoryKeys.all, "drafts", filter ?? {}] as const,
  importPreview: (source: LtmInteropSource, limit: number) =>
    [...longTermMemoryKeys.all, "import-preview", source, limit] as const,
  extractionSettings: () => [...longTermMemoryKeys.all, "extraction-settings"] as const,
  debugLogs: () => [...longTermMemoryKeys.all, "debug-log"] as const,
  debugLog: (filter?: LtmDebugLogFilter) => [...longTermMemoryKeys.all, "debug-log", filter ?? {}] as const,
};

export type LtmNoteFilter = {
  type?: LtmNoteType;
  status?: LtmStatus;
  tag?: string;
};

export type LtmDraftFilter = {
  status?: LtmDraftStatus;
  chatId?: string;
};

export type CreateLongTermMemoryNoteInput = Omit<LtmNote, "createdAt" | "updatedAt" | "version" | "previousHash"> &
  Partial<Pick<LtmNote, "createdAt" | "updatedAt" | "version" | "previousHash">>;

export type UpdateLongTermMemoryNoteInput = Partial<
  Omit<LtmNote, "id" | "type" | "createdAt" | "updatedAt" | "version" | "previousHash">
>;

export type DeleteLongTermMemoryNotesResponse = {
  deletedIds: string[];
  failedIds: string[];
};

function qs(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function useLongTermMemoryStatus() {
  return useQuery({
    queryKey: longTermMemoryKeys.status(),
    queryFn: () => api.get<LtmStatusResponse>("/long-term-memory/status"),
    staleTime: 30_000,
  });
}

export function useLongTermMemoryIntegrity() {
  return useQuery({
    queryKey: longTermMemoryKeys.integrity(),
    queryFn: () => api.get<LtmIntegrityResponse>("/long-term-memory/integrity"),
    staleTime: 30_000,
  });
}

export function useLongTermMemoryNotes(filter: LtmNoteFilter = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.notes(filter),
    queryFn: () => api.get<LtmNote[]>(`/long-term-memory/notes${qs(filter)}`),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useLongTermMemoryNote(id?: string) {
  return useQuery({
    queryKey: longTermMemoryKeys.note(id ?? ""),
    queryFn: () => api.get<LtmNote>(`/long-term-memory/notes/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateLongTermMemoryNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateLongTermMemoryNoteInput) => api.post<LtmNote>("/long-term-memory/notes", data),
    onSuccess: (note) => {
      qc.setQueryData(longTermMemoryKeys.note(note.id), note);
      qc.invalidateQueries({ queryKey: longTermMemoryKeys.all });
    },
  });
}

export function useUpdateLongTermMemoryNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateLongTermMemoryNoteInput }) =>
      api.patch<LtmNote>(`/long-term-memory/notes/${id}`, patch),
    onSuccess: (note) => {
      qc.setQueryData(longTermMemoryKeys.note(note.id), note);
      qc.invalidateQueries({ queryKey: longTermMemoryKeys.all });
    },
  });
}

export function useDeleteLongTermMemoryNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: true; id: string }>(`/long-term-memory/notes/${id}/permanent`),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: longTermMemoryKeys.note(id) });
      qc.invalidateQueries({ queryKey: longTermMemoryKeys.all });
    },
  });
}

export function useDeleteLongTermMemoryNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => api.delete<{ deleted: true; id: string }>(`/long-term-memory/notes/${id}/permanent`)),
      );
      const deletedIds: string[] = [];
      const failedIds: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          deletedIds.push(result.value.id);
        } else {
          failedIds.push(ids[index]);
        }
      });
      return { deletedIds, failedIds } satisfies DeleteLongTermMemoryNotesResponse;
    },
    onSuccess: (result) => {
      for (const id of result.deletedIds) {
        qc.removeQueries({ queryKey: longTermMemoryKeys.note(id) });
      }
      qc.invalidateQueries({ queryKey: longTermMemoryKeys.all });
    },
  });
}

export function useLongTermMemoryDrafts(filter: LtmDraftFilter = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.drafts(filter),
    queryFn: () => api.get<LtmExtractionDraft[]>(`/long-term-memory/drafts${qs(filter)}`),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useLongTermMemoryImportPreview(source: LtmInteropSource, limit: number) {
  return useQuery({
    queryKey: longTermMemoryKeys.importPreview(source, limit),
    queryFn: () => api.post<LtmInteropPreview>("/long-term-memory/import/preview", { source, limit }),
    staleTime: 30_000,
  });
}

export function useLongTermMemoryExtractionSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.extractionSettings(),
    queryFn: () => api.get<LtmResolvedExtractionSettings>("/long-term-memory/extraction-settings"),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useUpdateLongTermMemoryExtractionSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LtmExtractionSettings) =>
      api.put<LtmResolvedExtractionSettings>("/long-term-memory/extraction-settings", data),
    onSuccess: (settings) => {
      qc.setQueryData(longTermMemoryKeys.extractionSettings(), settings);
      qc.invalidateQueries({ queryKey: longTermMemoryKeys.extractionSettings() });
    },
  });
}

export function useSearchLongTermMemory() {
  return useMutation({
    mutationFn: (input: LtmSearchInput) => api.post<LtmSearchResponse>("/long-term-memory/search", input),
  });
}

export function useLongTermMemoryDebugLog(filter: LtmDebugLogFilter = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.debugLog(filter),
    queryFn: () =>
      api.get<LtmDebugLogResponse>(
        `/long-term-memory/debug-log${qs({
          limit: filter.limit ? String(filter.limit) : undefined,
          operationId: filter.operationId,
          sourceNoteId: filter.sourceNoteId,
          draftId: filter.draftId,
          status: filter.status,
          phase: filter.phase,
        })}`,
      ),
    enabled: options.enabled ?? true,
    staleTime: 10_000,
  });
}

export function useClearLongTermMemoryDebugLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ cleared: true }>("/long-term-memory/debug-log"),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.debugLogs() }),
  });
}

export function useExportLongTermMemoryDebugLog() {
  return useMutation({
    mutationFn: () => api.download("/long-term-memory/debug-log/export", "ltm-debug-log.jsonl"),
  });
}

export function useRebuildLongTermMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/long-term-memory/rebuild", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useReplayLongTermMemory() {
  return useMutation({
    mutationFn: () => api.post<LtmReplayResponse>("/long-term-memory/replay", {}),
  });
}

export function useRepairLongTermMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (actions: Array<"rebuild_indexes" | "quarantine_malformed_notes">) =>
      api.post<LtmRepairResponse>("/long-term-memory/repair", { actions }),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useImportLongTermMemorySourceNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ source, sourceIds, limit }: { source: LtmInteropSource; sourceIds: string[]; limit: number }) =>
      api.post<ImportLongTermMemorySourceNotesResponse>("/long-term-memory/import/source-notes", {
        source,
        sourceIds,
        limit,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useAcceptLongTermMemoryDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mutationIds, lowRiskOnly, editedMutations }: { id: string; mutationIds?: string[]; lowRiskOnly?: boolean; editedMutations?: LtmDraftMutation[] }) =>
      api.post(`/long-term-memory/drafts/${id}/accept`, { mutationIds, lowRiskOnly, editedMutations }),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useExtractLongTermMemorySourceNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, ...body }: ExtractLongTermMemorySourceInput) =>
      api.post<ExtractLongTermMemorySourceResponse>(`/long-term-memory/notes/${noteId}/extract`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useApplyLongTermMemoryScopeToDerived() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, chatIds, characterIds }: ApplyLongTermMemoryScopeToDerivedInput) =>
      api.post<ApplyLongTermMemoryScopeToDerivedResponse>(`/long-term-memory/notes/${noteId}/scope/apply-to-derived`, {
        chatIds,
        characterIds,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useRejectLongTermMemoryDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post(`/long-term-memory/drafts/${id}/reject`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useRestoreLongTermMemoryDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<LtmExtractionDraft>(`/long-term-memory/drafts/${id}/restore`),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useDeleteLongTermMemoryDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: true; id: string }>(`/long-term-memory/drafts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}
