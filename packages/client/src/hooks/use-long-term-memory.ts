import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
  LtmGlobalSettings as SharedLtmGlobalSettings,
  LtmMode,
  LtmNote,
  LtmNoteTransferApplyResponse,
  LtmNoteTransferMode,
  LtmNoteTransferPreviewRequest,
  LtmNoteTransferPreviewResponse,
  LtmNoteType,
  LtmResolvedExtractionSettings as SharedLtmResolvedExtractionSettings,
  LtmResolvedGlobalSettings as SharedLtmResolvedGlobalSettings,
  LtmScope,
  LtmStatus,
  LtmLastInjectionResponse,
  LtmPendingDraftsCountResponse,
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

export type LtmExtractionSettings = SharedLtmExtractionSettings;
export type LtmResolvedExtractionSettings = SharedLtmResolvedExtractionSettings;
export type LtmGlobalSettings = SharedLtmGlobalSettings;
export type LtmResolvedGlobalSettings = SharedLtmResolvedGlobalSettings;

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
  importedCount: number;
  samples: Array<{
    sourceId: string;
    title: string;
    mutationCount: number;
    summary: string;
    snippet: string;
    status: "pending" | "imported";
    existingNoteId?: string;
    existingNoteTitle?: string;
  }>;
};

export type LtmSearchInput = {
  queryText?: string;
  recentUserMessage?: string;
  recentMessages?: string[];
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
  keywordWeight?: number;
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
      metadata: number;
      keyword: number;
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
  candidateIndex?: number;
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
  mode?: LtmMode;
};

export type ImportLongTermMemorySourceNotesInput = {
  source: LtmInteropSource;
  sourceIds: string[];
  limit: number;
  scope?: LtmScope;
  connectionId?: string;
  model?: string;
  instruction?: string;
  applyLowRisk?: boolean;
  importConcurrency?: number;
  mode?: LtmMode;
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

export type AcceptLongTermMemoryDraftInput = {
  id: string;
  mutationIds?: string[];
  lowRiskOnly?: boolean;
  editedMutations?: LtmDraftMutation[];
};

export type AcceptLongTermMemoryDraftResponse = {
  draft: LtmExtractionDraft;
  appliedMutationIds: string[];
  skippedMutationIds: string[];
  autoIncludedMutationIds: string[];
};

export type SkipLongTermMemoryDraftInput = {
  id: string;
  mutationIds: string[];
};

export type SkipLongTermMemoryDraftResponse = {
  deleted: true;
  draftId: string;
  mutationIds: string[];
  draft: LtmExtractionDraft | null;
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
  importPreview: (source: LtmInteropSource, limit: number, scope?: LtmScope) =>
    [...longTermMemoryKeys.all, "import-preview", source, limit, scope ?? {}] as const,
  extractionSettings: () => [...longTermMemoryKeys.all, "extraction-settings"] as const,
  settings: () => [...longTermMemoryKeys.all, "settings"] as const,
  debugLogs: () => [...longTermMemoryKeys.all, "debug-log"] as const,
  debugLog: (filter?: LtmDebugLogFilter) => [...longTermMemoryKeys.all, "debug-log", filter ?? {}] as const,
  lastInjection: (chatId: string) => ["long-term-memory", "last-injection", chatId] as const,
  pendingDraftsCount: (chatId?: string | null) =>
    ["long-term-memory", "drafts", "pending-count", { chatId: chatId ?? null }] as const,
};

export type LtmNoteFilter = {
  type?: LtmNoteType;
  status?: LtmStatus;
  tag?: string;
  scopeChatIds?: string[];
  scopeGroupId?: string;
  scopeCharacterIds?: string[];
  includeGlobal?: boolean;
};

export type LtmDraftFilter = {
  status?: LtmDraftStatus;
  chatId?: string;
};

export type CreateLongTermMemoryNoteInput = Omit<LtmNote, "createdAt" | "updatedAt" | "version"> &
  Partial<Pick<LtmNote, "createdAt" | "updatedAt" | "version">>;

export type CreateLongTermMemoryNoteDraft = Pick<LtmNote, "id" | "type" | "modes" | "scope" | "sections" | "links" | "tags"> &
  Omit<LtmNote, "id" | "title" | "createdAt" | "updatedAt" | "version"> & { title?: string | null };

export type UpdateLongTermMemoryNoteInput = {
  title?: string | null;
  type?: LtmNote["type"];
  status?: LtmNote["status"];
  modes?: LtmNote["modes"];
  scope?: LtmNote["scope"];
  tags?: LtmNote["tags"];
  keywords?: LtmNote["keywords"];
  links?: LtmNote["links"];
  sections?: LtmNote["sections"];
  conflicts?: LtmNote["conflicts"];
};

export type DeleteLongTermMemoryNotesResponse = {
  deletedIds: string[];
  failedIds: string[];
};

const PERMANENT_DELETE_NOTES_BATCH_SIZE = 100;

function chunkLongTermMemoryNoteIds(ids: string[]) {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += PERMANENT_DELETE_NOTES_BATCH_SIZE) {
    batches.push(ids.slice(index, index + PERMANENT_DELETE_NOTES_BATCH_SIZE));
  }
  return batches;
}

function pruneNotesFromListCaches(qc: QueryClient, ids: string[]) {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  qc.setQueriesData<LtmNote[]>(
    {
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey[0] === longTermMemoryKeys.all[0] &&
        query.queryKey[1] === "notes" &&
        typeof query.queryKey[2] === "object",
    },
    (current) => (Array.isArray(current) ? current.filter((note) => !idSet.has(note.id)) : current),
  );
}

export type PreviewLongTermMemoryNoteTransferInput = LtmNoteTransferPreviewRequest;

export type ApplyLongTermMemoryNoteTransferInput = {
  noteIds: string[];
  mode: LtmNoteTransferMode;
  destinationChatId: string;
  includeDerived?: boolean;
};

function qs(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function noteFilterQuery(filter: LtmNoteFilter) {
  return qs({
    type: filter.type,
    status: filter.status,
    tag: filter.tag,
    scopeChatIds: filter.scopeChatIds?.length ? filter.scopeChatIds.join(",") : undefined,
    scopeGroupId: filter.scopeGroupId,
    scopeCharacterIds: filter.scopeCharacterIds?.length ? filter.scopeCharacterIds.join(",") : undefined,
    includeGlobal: filter.includeGlobal === false ? "false" : undefined,
  });
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
    queryFn: () => api.get<LtmNote[]>(`/long-term-memory/notes${noteFilterQuery(filter)}`),
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
      pruneNotesFromListCaches(qc, [id]);
      qc.invalidateQueries({ queryKey: longTermMemoryKeys.all });
    },
  });
}

export function useDeleteLongTermMemoryNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return { deletedIds: [], failedIds: [] } satisfies DeleteLongTermMemoryNotesResponse;
      const deletedIds: string[] = [];
      const failedIds: string[] = [];

      for (const batchIds of chunkLongTermMemoryNoteIds(ids)) {
        try {
          const result = await api.post<DeleteLongTermMemoryNotesResponse>(
            "/long-term-memory/notes/permanent-delete",
            { ids: batchIds },
          );
          deletedIds.push(...result.deletedIds);
          failedIds.push(...result.failedIds);
        } catch {
          failedIds.push(...batchIds);
        }
      }

      return { deletedIds, failedIds } satisfies DeleteLongTermMemoryNotesResponse;
    },
    onSuccess: (result) => {
      for (const id of result.deletedIds) {
        qc.removeQueries({ queryKey: longTermMemoryKeys.note(id) });
      }
      pruneNotesFromListCaches(qc, result.deletedIds);
      qc.invalidateQueries({ queryKey: longTermMemoryKeys.all });
    },
  });
}

export type RemoveLongTermMemoryNotesFromScopeResponse = {
  removedIds: string[];
  deletedIds: string[];
  unchangedIds: string[];
  failedIds: string[];
  notes: LtmNote[];
};

export type RemoveLongTermMemoryNoteScopeInput = {
  chatIds?: string[];
  groupId?: string;
  characterIds?: string[];
};

/**
 * Remove notes from a specific chat scope instead of permanently deleting them.
 * If a note has no remaining scope after removal, the server permanently
 * deletes it (reported in `deletedIds`).
 */
export function useRemoveLongTermMemoryNotesFromScope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ids: string[]; scope: RemoveLongTermMemoryNoteScopeInput }) => {
      const results = await Promise.allSettled(
        input.ids.map((id) =>
          api.delete<{ deleted: boolean; unscoped: boolean; id: string; note?: LtmNote }>(
            `/long-term-memory/notes/${id}/scope`,
            input.scope,
          ),
        ),
      );
      const removedIds: string[] = [];
      const deletedIds: string[] = [];
      const unchangedIds: string[] = [];
      const failedIds: string[] = [];
      const notes: LtmNote[] = [];
      results.forEach((result, index) => {
        const id = input.ids[index]!;
        if (result.status === "fulfilled") {
          if (result.value.deleted) deletedIds.push(id);
          else if (result.value.unscoped) {
            removedIds.push(id);
            if (result.value.note) notes.push(result.value.note);
          } else {
            unchangedIds.push(id);
            if (result.value.note) notes.push(result.value.note);
          }
        } else {
          failedIds.push(id);
        }
      });
      return { removedIds, deletedIds, unchangedIds, failedIds, notes } satisfies RemoveLongTermMemoryNotesFromScopeResponse;
    },
    onSuccess: (result) => {
      for (const id of result.deletedIds) {
        qc.removeQueries({ queryKey: longTermMemoryKeys.note(id) });
      }
      for (const note of result.notes) {
        qc.setQueryData(longTermMemoryKeys.note(note.id), note);
      }
      pruneNotesFromListCaches(qc, [...result.removedIds, ...result.deletedIds]);
      qc.invalidateQueries({ queryKey: longTermMemoryKeys.all });
    },
  });
}

export function usePreviewLongTermMemoryNoteTransfer() {
  return useMutation({
    mutationFn: (input: PreviewLongTermMemoryNoteTransferInput) =>
      api.post<LtmNoteTransferPreviewResponse>("/long-term-memory/notes/transfer-preview", input),
  });
}

export function useApplyLongTermMemoryNoteTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ApplyLongTermMemoryNoteTransferInput) =>
      api.post<LtmNoteTransferApplyResponse>("/long-term-memory/notes/transfer", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
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

export function useLongTermMemoryImportPreview(source: LtmInteropSource, limit: number, scope?: LtmScope) {
  return useQuery({
    queryKey: longTermMemoryKeys.importPreview(source, limit, scope),
    queryFn: () => api.post<LtmInteropPreview>("/long-term-memory/import/preview", { source, limit, scope }),
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
  return useMutation({
    mutationFn: (data: LtmExtractionSettings) =>
      api.put<LtmResolvedExtractionSettings>("/long-term-memory/extraction-settings", data),
  });
}

export function useLongTermMemorySettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.settings(),
    queryFn: () => api.get<LtmResolvedGlobalSettings>("/long-term-memory/settings"),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useUpdateLongTermMemorySettings() {
  return useMutation({
    mutationFn: (data: LtmGlobalSettings) => api.put<LtmResolvedGlobalSettings>("/long-term-memory/settings", data),
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

export function useRepairLongTermMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (actions: Array<"rebuild_indexes" | "quarantine_malformed_notes" | "backfill_imported_source_titles">) =>
      api.post<LtmRepairResponse>("/long-term-memory/repair", { actions }),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useImportLongTermMemorySourceNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      source,
      sourceIds,
      limit,
      scope,
      connectionId,
      model,
      instruction,
      applyLowRisk,
      importConcurrency,
      mode,
    }: ImportLongTermMemorySourceNotesInput) =>
      api.post<ImportLongTermMemorySourceNotesResponse>("/long-term-memory/import/source-notes", {
        source,
        sourceIds,
        limit,
        scope,
        connectionId,
        model,
        instruction,
        applyLowRisk,
        importConcurrency,
        mode,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useAcceptLongTermMemoryDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mutationIds, lowRiskOnly, editedMutations }: AcceptLongTermMemoryDraftInput) =>
      api.post<AcceptLongTermMemoryDraftResponse>(`/long-term-memory/drafts/${id}/accept`, {
        mutationIds,
        lowRiskOnly,
        editedMutations,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useSkipLongTermMemoryDraftMutations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mutationIds }: SkipLongTermMemoryDraftInput) =>
      api.post<SkipLongTermMemoryDraftResponse>(`/long-term-memory/drafts/${id}/skip`, { mutationIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useExtractLongTermMemorySourceNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, ...body }: ExtractLongTermMemorySourceInput) =>
      api.post<ExtractLongTermMemorySourceResponse>(`/long-term-memory/notes/${noteId}/extract`, {
        ...body,
        mode: body.mode,
      }),
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

export function useDeleteLongTermMemoryDraftMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mutationId }: { id: string; mutationId: string }) =>
      api.delete<{ deleted: true; draftId: string; mutationId: string; draft: LtmExtractionDraft | null }>(
        `/long-term-memory/drafts/${id}/mutations/${mutationId}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useLastInjection(chatId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.lastInjection(chatId ?? ""),
    queryFn: () => api.get<LtmLastInjectionResponse>(`/long-term-memory/last-injection/${chatId}`),
    enabled: !!chatId && (options.enabled ?? true),
    staleTime: 10_000,
  });
}

export function usePendingDraftsCount(options: { chatId?: string | null; enabled?: boolean } = {}) {
  const chatId = options.chatId ?? undefined;
  return useQuery({
    queryKey: longTermMemoryKeys.pendingDraftsCount(chatId),
    queryFn: () => api.get<LtmPendingDraftsCountResponse>(`/long-term-memory/drafts/pending-count${qs({ chatId })}`),
    enabled: options.enabled ?? true,
    staleTime: 15_000,
  });
}
