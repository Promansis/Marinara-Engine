import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LtmDraftStatus, LtmExtractionDraft, LtmNote, LtmNoteType, LtmStatus } from "@marinara-engine/shared";
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
  samples: Array<{ sourceId: string; title: string; mutationCount: number; summary: string }>;
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

export type CreateLongTermMemoryNoteInput = Omit<
  LtmNote,
  "createdAt" | "updatedAt" | "version" | "previousHash"
> &
  Partial<Pick<LtmNote, "createdAt" | "updatedAt" | "version" | "previousHash">>;

export type UpdateLongTermMemoryNoteInput = Partial<
  Omit<LtmNote, "id" | "type" | "createdAt" | "updatedAt" | "version" | "previousHash">
>;

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

export function useLongTermMemoryNotes(filter: LtmNoteFilter = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.notes(filter),
    queryFn: () => api.get<LtmNote[]>(`/long-term-memory/notes${qs(filter)}`),
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

export function useArchiveLongTermMemoryNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ archived: true; note: LtmNote }>(`/long-term-memory/notes/${id}`),
    onSuccess: (result) => {
      qc.setQueryData(longTermMemoryKeys.note(result.note.id), result.note);
      qc.invalidateQueries({ queryKey: longTermMemoryKeys.all });
    },
  });
}

export function useLongTermMemoryDrafts(filter: LtmDraftFilter = {}) {
  return useQuery({
    queryKey: longTermMemoryKeys.drafts(filter),
    queryFn: () => api.get<LtmExtractionDraft[]>(`/long-term-memory/drafts${qs(filter)}`),
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

export function useCreateLongTermMemoryImportDrafts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ source, limit }: { source: LtmInteropSource; limit: number }) =>
      api.post<{ source: LtmInteropSource; created: LtmExtractionDraft[] }>("/long-term-memory/import/drafts", {
        source,
        limit,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: longTermMemoryKeys.all }),
  });
}

export function useAcceptLongTermMemoryDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/long-term-memory/drafts/${id}/accept`, {}),
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
