import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  ltmExtractSourceNoteRequestSchema,
  ltmExtractSourceNoteResponseSchema,
  ltmDraftReviewResponseSchema,
  ltmImportSourceNotesRequestSchema,
  ltmImportSourceNotesResponseSchema,
  ltmIdentityRepairApplyRequestSchema,
  ltmIdentityRepairApplyResponseSchema,
  ltmIdentityRepairPreviewRequestSchema,
  ltmIdentityRepairPreviewResponseSchema,
  ltmIntegrityResponseSchema,
  ltmInteropPreviewRequestSchema,
  ltmInteropPreviewResponseSchema,
  ltmRepairRequestSchema,
  ltmRepairResponseSchema,
  ltmStatusResponseSchema,
  type LtmExtractSourceNoteRequest as SharedLtmExtractSourceNoteRequest,
  type LtmExtractSourceNoteResponse as SharedLtmExtractSourceNoteResponse,
  type LtmExtractionDiagnostic as SharedLtmExtractionDiagnostic,
  type LtmDraftReviewResponse as SharedLtmDraftReviewResponse,
  type LtmImportSourceNotesRequest as SharedLtmImportSourceNotesRequest,
  type LtmImportSourceNotesResponse as SharedLtmImportSourceNotesResponse,
  type LtmIntegrityIssue as SharedLtmIntegrityIssue,
  type LtmIntegrityResponse as SharedLtmIntegrityResponse,
  type LtmIdentityRepairApplyRequest as SharedLtmIdentityRepairApplyRequest,
  type LtmIdentityRepairApplyResponse as SharedLtmIdentityRepairApplyResponse,
  type LtmIdentityRepairPreviewResponse as SharedLtmIdentityRepairPreviewResponse,
  type LtmInteropPreviewResponse as SharedLtmInteropPreviewResponse,
  type LtmInteropSource as SharedLtmInteropSource,
  type LtmRepairAction as SharedLtmRepairAction,
  type LtmRepairResponse as SharedLtmRepairResponse,
  type LtmStatusResponse as SharedLtmStatusResponse,
  LtmDraftMutation,
  LtmDraftStatus,
  LtmDebugEvent,
  LtmDebugPhase,
  LtmDebugStatus,
  LtmExtractionDraft,
  LtmExtractionSettings as SharedLtmExtractionSettings,
  LtmGlobalSettings as SharedLtmGlobalSettings,
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
  LtmMode,
  LtmPendingDraftsCountResponse,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";

export type LtmStatusResponse = SharedLtmStatusResponse;
export type LtmIntegrityIssue = SharedLtmIntegrityIssue;
export type LtmIntegrityResponse = SharedLtmIntegrityResponse;
export type LtmIdentityRepairApplyInput = SharedLtmIdentityRepairApplyRequest;
export type LtmIdentityRepairApplyResponse = SharedLtmIdentityRepairApplyResponse;
export type LtmIdentityRepairPreview = SharedLtmIdentityRepairPreviewResponse;

export type LtmExtractionSettings = SharedLtmExtractionSettings;
export type LtmResolvedExtractionSettings = SharedLtmResolvedExtractionSettings;
export type LtmGlobalSettings = SharedLtmGlobalSettings;
export type LtmResolvedGlobalSettings = SharedLtmResolvedGlobalSettings;

export type LtmRepairResponse = SharedLtmRepairResponse;
export type LtmInteropSource = SharedLtmInteropSource;
export type LtmInteropPreview = SharedLtmInteropPreviewResponse;

export type LtmSearchInput = {
  queryText?: string;
  recentUserMessage?: string;
  recentMessages?: string[];
  mentionedCharacterNames?: string[];
  noteIds?: string[];
  tags?: string[];
  mode?: LtmMode;
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

export type LtmExtractionDiagnostic = SharedLtmExtractionDiagnostic;
export type LtmDraftReviewResponse = SharedLtmDraftReviewResponse;

export type ExtractLongTermMemorySourceInput = SharedLtmExtractSourceNoteRequest & {
  noteId: string;
};

export type ImportLongTermMemorySourceNotesInput = SharedLtmImportSourceNotesRequest & {
  signal?: AbortSignal;
};

export type ExtractLongTermMemorySourceResponse = SharedLtmExtractSourceNoteResponse;

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

export type ImportLongTermMemorySourceNotesResponse = SharedLtmImportSourceNotesResponse;

export type LongTermMemoryLatestExtractionResult = Pick<
  ExtractLongTermMemorySourceResponse,
  "accounting" | "diagnostics" | "operationId" | "outcome"
> & {
  mutationCount?: number;
};

export const longTermMemoryKeys = {
  all: ["long-term-memory"] as const,
  status: () => [...longTermMemoryKeys.all, "status"] as const,
  integrity: () => [...longTermMemoryKeys.all, "integrity"] as const,
  identityRepairPreview: (scope: LtmScope) => [...longTermMemoryKeys.all, "identity-repair-preview", scope] as const,
  notes: (filter?: LtmNoteFilter) => [...longTermMemoryKeys.all, "notes", filter ?? {}] as const,
  note: (id: string) => [...longTermMemoryKeys.all, "notes", id] as const,
  drafts: (filter?: LtmDraftFilter) => [...longTermMemoryKeys.all, "drafts", filter ?? {}] as const,
  draftReview: (filter?: LtmDraftReviewFilter) =>
    [...longTermMemoryKeys.all, "drafts", "review", filter ?? {}] as const,
  importPreview: (source: LtmInteropSource, limit: number, scope?: LtmScope, mode?: LtmMode) =>
    [...longTermMemoryKeys.all, "import-preview", source, limit, scope ?? {}, mode ?? null] as const,
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

export type LtmDraftReviewFilter = LtmDraftFilter & {
  sourceNoteId?: string;
};

export type CreateLongTermMemoryNoteInput = Omit<LtmNote, "createdAt" | "updatedAt" | "version"> &
  Partial<Pick<LtmNote, "createdAt" | "updatedAt" | "version">>;

export type CreateLongTermMemoryNoteDraft = Pick<
  LtmNote,
  "id" | "type" | "modes" | "scope" | "sections" | "links" | "tags"
> &
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
  subjects?: LtmNote["subjects"];
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

export function useLongTermMemoryStatus(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.status(),
    queryFn: async () => ltmStatusResponseSchema.parse(await api.get<unknown>("/long-term-memory/status")),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useLongTermMemoryIntegrity(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.integrity(),
    queryFn: async () => ltmIntegrityResponseSchema.parse(await api.get<unknown>("/long-term-memory/integrity")),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useLongTermMemoryIdentityRepairPreview(scope: LtmScope, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.identityRepairPreview(scope),
    queryFn: async () => {
      const body = ltmIdentityRepairPreviewRequestSchema.parse({ scope });
      return ltmIdentityRepairPreviewResponseSchema.parse(
        await api.post<unknown>("/long-term-memory/identity-repair/preview", body),
      );
    },
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useLongTermMemoryNotes(filter: LtmNoteFilter = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.notes(filter),
    queryFn: () => api.get<LtmNote[]>(`/long-term-memory/notes${noteFilterQuery(filter)}`),
    enabled: options.enabled ?? true,
    placeholderData: (previousData) => previousData,
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
          const result = await api.post<DeleteLongTermMemoryNotesResponse>("/long-term-memory/notes/permanent-delete", {
            ids: batchIds,
          });
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
      return {
        removedIds,
        deletedIds,
        unchangedIds,
        failedIds,
        notes,
      } satisfies RemoveLongTermMemoryNotesFromScopeResponse;
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
    placeholderData: (previousData) => previousData,
    staleTime: 30_000,
  });
}

export function useLongTermMemoryDraftReview(filter: LtmDraftReviewFilter = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.draftReview(filter),
    queryFn: async () =>
      ltmDraftReviewResponseSchema.parse(await api.get<unknown>(`/long-term-memory/drafts/review${qs(filter)}`)),
    enabled: options.enabled ?? true,
    placeholderData: (previousData) => previousData,
    staleTime: 15_000,
  });
}

export function useLongTermMemoryImportPreview(
  source: LtmInteropSource,
  limit: number,
  scope?: LtmScope,
  mode?: LtmMode,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: longTermMemoryKeys.importPreview(source, limit, scope, mode),
    queryFn: async ({ signal }) => {
      const body = ltmInteropPreviewRequestSchema.parse({ source, limit, scope, mode });
      return ltmInteropPreviewResponseSchema.parse(
        await api.post<unknown>("/long-term-memory/import/preview", body, { signal }),
      );
    },
    enabled: options.enabled ?? true,
    placeholderData: (previousData) => previousData,
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
    mutationFn: async (actions: SharedLtmRepairAction[]) => {
      const body = ltmRepairRequestSchema.parse({ actions });
      return ltmRepairResponseSchema.parse(await api.post<unknown>("/long-term-memory/repair", body));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useApplyLongTermMemoryIdentityRepairs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LtmIdentityRepairApplyInput) => {
      const body = ltmIdentityRepairApplyRequestSchema.parse(input);
      return ltmIdentityRepairApplyResponseSchema.parse(
        await api.post<unknown>("/long-term-memory/identity-repair/apply", body),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useImportLongTermMemorySourceNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ signal, ...input }: ImportLongTermMemorySourceNotesInput) => {
      const body = ltmImportSourceNotesRequestSchema.parse(input);
      return ltmImportSourceNotesResponseSchema.parse(
        await api.post<unknown>("/long-term-memory/import/source-notes", body, { signal }),
      );
    },
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
    onSettled: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
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

export function useDeleteLongTermMemoryDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: true; id: string }>(`/long-term-memory/drafts/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useExtractLongTermMemorySourceNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ noteId, ...input }: ExtractLongTermMemorySourceInput) => {
      const body = ltmExtractSourceNoteRequestSchema.parse(input);
      return ltmExtractSourceNoteResponseSchema.parse(
        await api.post<unknown>(`/long-term-memory/notes/${noteId}/extract`, body),
      );
    },
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
