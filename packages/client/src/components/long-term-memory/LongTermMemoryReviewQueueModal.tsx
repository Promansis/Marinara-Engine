import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, Check, Eye, Loader2, X } from "lucide-react";
import type { Chat, LtmDraftMutation, LtmExtractionDraft } from "@marinara-engine/shared";
import {
  useAcceptLongTermMemoryDraft,
  useDeleteLongTermMemoryDraftMutation,
  useLongTermMemoryDrafts,
  useLongTermMemoryNotes,
  useSkipLongTermMemoryDraftMutations,
  type AcceptLongTermMemoryDraftResponse,
} from "../../hooks/use-long-term-memory";
import { useChats } from "../../hooks/use-chats";
import { Modal } from "../ui/Modal";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { buildNoteLookup, memoryRowTitle } from "./ltm-panel-shared";
import { friendlyIdentifier, isTypedSuggestionDraft } from "./ltm-editor-utils";
import { emptyStateClassName, helperTextClassName, sectionCardClassName } from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";
import { SuggestionRow, type SuggestionRowModel, suggestionRowKeyFor } from "./LtmSuggestionRow";

export function LongTermMemoryReviewQueueModal({
  open,
  onClose,
  onOpenSource,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSource?: (sourceNoteId: string) => void;
}) {
  const drafts = useLongTermMemoryDrafts({ status: "pending" });
  const notes = useLongTermMemoryNotes();
  const noteLookup = useMemo(() => buildNoteLookup(notes.data ?? []), [notes.data]);
  const { data: chats } = useChats();
  const chatLookup = useMemo(() => new Map((chats as Chat[] | undefined)?.map((c) => [c.id, c])), [chats]);

  const acceptDraft = useAcceptLongTermMemoryDraft();
  const deleteDraftMutation = useDeleteLongTermMemoryDraftMutation();
  const skipDraftMutations = useSkipLongTermMemoryDraftMutations();

  const [editedMutations, setEditedMutations] = useState<Record<string, LtmDraftMutation>>({});
  const [activeBatchAction, setActiveBatchAction] = useState<"keep-low" | "skip-all" | null>(null);
  const keepSkipLockRef = useRef(false);

  const withKeepSkipLock = useCallback(async <T,>(action: () => Promise<T>) => {
    if (keepSkipLockRef.current) return null;
    keepSkipLockRef.current = true;
    try {
      return await action();
    } finally {
      keepSkipLockRef.current = false;
    }
  }, []);

  const busy =
    activeBatchAction !== null ||
    acceptDraft.isPending ||
    deleteDraftMutation.isPending ||
    skipDraftMutations.isPending;

  const rows = useMemo<SuggestionRowModel[]>(() => {
    return (drafts.data ?? [])
      .filter((draft) => draft.status === "pending")
      .filter(isTypedSuggestionDraft)
      .flatMap((draft) => draft.mutations.map((mutation) => ({ draft, mutation })));
  }, [drafts.data]);

  const reviewGroups = useMemo(() => {
    const groups = new Map<string, { drafts: LtmExtractionDraft[]; totalMutations: number }>();
    for (const draft of drafts.data ?? []) {
      const sourceNoteId = draft.source.sourceNoteId;
      if (!sourceNoteId) continue;
      const existing = groups.get(sourceNoteId);
      if (existing) {
        existing.drafts.push(draft);
        existing.totalMutations += draft.mutations.length;
      } else {
        groups.set(sourceNoteId, { drafts: [draft], totalMutations: draft.mutations.length });
      }
    }
    return Array.from(groups.entries()).map(([sourceNoteId, group]) => ({
      sourceNoteId,
      sourceNote: noteLookup.get(sourceNoteId),
      ...group,
    }));
  }, [drafts.data, noteLookup]);

  const clearEditedMutations = useCallback((keys: string[]) => {
    setEditedMutations((current) => {
      const next = { ...current };
      let changed = false;
      for (const key of keys) {
        if (!(key in next)) continue;
        changed = true;
        delete next[key];
      }
      return changed ? next : current;
    });
  }, []);

  const keepOne = useCallback(
    async (row: SuggestionRowModel) => {
      const rowKey = suggestionRowKeyFor(row);
      const editedMutation = editedMutations[rowKey];
      await withKeepSkipLock(async () => {
        try {
          const result = await acceptDraft.mutateAsync({
            id: row.draft.id,
            mutationIds: [row.mutation.id],
            editedMutations: editedMutation ? [editedMutation] : undefined,
          });
          const autoCount = result.autoIncludedMutationIds.length;
          const suffix = autoCount
            ? ` (also created ${autoCount} note${autoCount > 1 ? "s" : ""} to support this change)`
            : "";
          toast.success(editedMutation ? `Edited suggestion kept${suffix}` : `Suggestion kept${suffix}`);
          clearEditedMutations([rowKey]);
        } catch (err) {
          toast.error((err as Error).message);
        }
      });
    },
    [acceptDraft, clearEditedMutations, editedMutations, withKeepSkipLock],
  );

  const skipOne = useCallback(
    async (row: SuggestionRowModel) => {
      const rowKey = suggestionRowKeyFor(row);
      await withKeepSkipLock(async () => {
        try {
          await deleteDraftMutation.mutateAsync({ id: row.draft.id, mutationId: row.mutation.id });
          toast.success("Suggestion skipped");
          clearEditedMutations([rowKey]);
        } catch (err) {
          toast.error((err as Error).message);
        }
      });
    },
    [clearEditedMutations, deleteDraftMutation, withKeepSkipLock],
  );

  const runBulkKeepLowRisk = useCallback(async () => {
    const lowRiskByDraft = new Map<
      string,
      { mutations: LtmDraftMutation[]; rowKeys: string[]; savedEdits: LtmDraftMutation[] }
    >();
    for (const row of rows) {
      if (row.mutation.risk !== "low") continue;
      const rowKey = suggestionRowKeyFor(row);
      const savedEdit = editedMutations[rowKey];
      const existing = lowRiskByDraft.get(row.draft.id);
      if (existing) {
        existing.mutations.push(row.mutation);
        existing.rowKeys.push(rowKey);
        if (savedEdit) existing.savedEdits.push(savedEdit);
      } else {
        lowRiskByDraft.set(row.draft.id, {
          mutations: [row.mutation],
          rowKeys: [rowKey],
          savedEdits: savedEdit ? [savedEdit] : [],
        });
      }
    }
    if (lowRiskByDraft.size === 0) {
      toast.info("No low-risk suggestions to keep.");
      return;
    }

    const completed = await withKeepSkipLock(async () => {
      setActiveBatchAction("keep-low");
      let keptCount = 0;
      let failedDraftCount = 0;
      let autoIncludedCount = 0;
      const successfulKeys: string[] = [];
      try {
        for (const [draftId, group] of lowRiskByDraft) {
          try {
            const result: AcceptLongTermMemoryDraftResponse = await acceptDraft.mutateAsync({
              id: draftId,
              mutationIds: group.mutations.map((m) => m.id),
              lowRiskOnly: true,
              editedMutations: group.savedEdits.length > 0 ? group.savedEdits : undefined,
            });
            keptCount += group.mutations.length;
            autoIncludedCount += result.autoIncludedMutationIds.length;
            successfulKeys.push(...group.rowKeys);
          } catch {
            failedDraftCount += 1;
          }
        }
      } finally {
        setActiveBatchAction(null);
      }
      return { keptCount, failedDraftCount, autoIncludedCount, successfulKeys };
    });

    if (!completed) return;
    clearEditedMutations(completed.successfulKeys);
    if (completed.failedDraftCount > 0) {
      toast.error(
        `Kept ${completed.keptCount} suggestion${completed.keptCount === 1 ? "" : "s"}; ${completed.failedDraftCount} draft${completed.failedDraftCount === 1 ? "" : "s"} failed.`,
      );
    } else {
      const summary = `Kept ${completed.keptCount} low-risk suggestion${completed.keptCount === 1 ? "" : "s"}.`;
      const depNote = completed.autoIncludedCount
        ? ` Also created ${completed.autoIncludedCount} note${completed.autoIncludedCount === 1 ? "" : "s"} to support changes.`
        : "";
      toast.success(summary + depNote);
    }
  }, [acceptDraft, clearEditedMutations, editedMutations, rows, withKeepSkipLock]);

  const runBulkSkipAll = useCallback(async () => {
    const confirmed = await showConfirmDialog({
      title: "Skip all suggestions?",
      message: `This will skip all ${rows.length} pending suggestion${rows.length === 1 ? "" : "s"}. This cannot be undone.`,
      confirmLabel: "Skip all",
      tone: "destructive",
    });
    if (!confirmed) return;

    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const existing = groups.get(row.draft.id);
      if (existing) existing.push(row.mutation.id);
      else groups.set(row.draft.id, [row.mutation.id]);
    }
    const allRowKeys = rows.map((row) => suggestionRowKeyFor(row));

    const completed = await withKeepSkipLock(async () => {
      setActiveBatchAction("skip-all");
      let skippedCount = 0;
      let failedDraftCount = 0;
      try {
        for (const [draftId, mutationIds] of groups) {
          try {
            await skipDraftMutations.mutateAsync({ id: draftId, mutationIds });
            skippedCount += mutationIds.length;
          } catch {
            failedDraftCount += 1;
          }
        }
      } finally {
        setActiveBatchAction(null);
      }
      return { skippedCount, failedDraftCount };
    });

    if (!completed) return;
    clearEditedMutations(allRowKeys);
    if (completed.failedDraftCount > 0) {
      toast.error(
        `Skipped ${completed.skippedCount} suggestion${completed.skippedCount === 1 ? "" : "s"}; ${completed.failedDraftCount} draft${completed.failedDraftCount === 1 ? "" : "s"} failed.`,
      );
    } else {
      toast.success(`Skipped ${completed.skippedCount} suggestion${completed.skippedCount === 1 ? "" : "s"}.`);
    }
  }, [clearEditedMutations, rows, skipDraftMutations, withKeepSkipLock]);

  const totalPending = rows.length;
  const totalSources = reviewGroups.length;

  return (
    <Modal open={open} onClose={onClose} title="Review Memory Suggestions" width="max-w-3xl">
      <div className="flex flex-col gap-4">
        {drafts.isLoading ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-6">
            <Loader2 className="mr-2 animate-spin" size="0.875rem" />
            <span className="text-xs text-[var(--muted-foreground)]">Loading suggestions...</span>
          </div>
        ) : totalPending === 0 ? (
          <p className={emptyStateClassName}>No pending suggestions to review.</p>
        ) : (
          <>
            {/* Toolbar */}
            <div className={sectionCardClassName}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={helperTextClassName}>
                  <span className="font-semibold text-[var(--foreground)]">{totalPending}</span> pending suggestion
                  {totalPending === 1 ? "" : "s"} across{" "}
                  <span className="font-semibold text-[var(--foreground)]">{totalSources}</span> source
                  {totalSources === 1 ? "" : "s"}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <ToolButton
                    onClick={() => void runBulkKeepLowRisk()}
                    disabled={busy || totalPending === 0}
                    tone="primary"
                  >
                    {activeBatchAction === "keep-low" ? (
                      <Loader2 size="0.875rem" className="animate-spin" />
                    ) : (
                      <Check size="0.875rem" />
                    )}
                    Keep all low-risk
                  </ToolButton>
                  <ToolButton
                    onClick={() => void runBulkSkipAll()}
                    disabled={busy || totalPending === 0}
                    tone="danger"
                  >
                    {activeBatchAction === "skip-all" ? (
                      <Loader2 size="0.875rem" className="animate-spin" />
                    ) : (
                      <X size="0.875rem" />
                    )}
                    Skip all
                  </ToolButton>
                </div>
              </div>
            </div>

            {/* Groups */}
            <div className="space-y-3">
              {reviewGroups.map(({ sourceNoteId, sourceNote, drafts: groupDrafts, totalMutations }) => (
                <section
                  key={sourceNoteId}
                  className="overflow-hidden rounded-xl bg-[var(--secondary)]/25 ring-1 ring-[var(--border)]"
                >
                  {/* Source header */}
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--border)]/45 px-3 py-2.5">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {sourceNote ? (
                        <>
                          <StatusPill label="Source" tone="good" />
                          <span className="min-w-0 truncate text-xs font-semibold text-[var(--foreground)]">
                            {memoryRowTitle(sourceNote, chatLookup)}
                          </span>
                        </>
                      ) : (
                        <>
                          <AlertCircle size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
                          <span className="min-w-0 truncate text-xs font-semibold text-[var(--foreground)]">
                            {friendlyIdentifier(sourceNoteId)}
                          </span>
                          <StatusPill label="Source deleted" tone="warn" />
                        </>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusPill label={`${totalMutations} pending`} tone="warn" />
                      {sourceNote && onOpenSource ? (
                        <ToolButton onClick={() => onOpenSource(sourceNoteId)}>
                          <Eye size="0.875rem" />
                          Open source
                        </ToolButton>
                      ) : null}
                    </div>
                  </div>
                  {/* Rows */}
                  <div className="space-y-2 p-3">
                    {groupDrafts.flatMap((draft) =>
                      draft.mutations.map((mutation) => {
                        const row: SuggestionRowModel = { draft, mutation };
                        const rowKey = suggestionRowKeyFor(row);
                        return (
                          <SuggestionRow
                            key={rowKey}
                            row={row}
                            noteLookup={noteLookup}
                            selectMode={false}
                            selected={false}
                            editedMutation={editedMutations[rowKey]}
                            busy={busy}
                            onSelect={() => {}}
                            onMutationEdited={(m) =>
                              setEditedMutations((prev) => ({ ...prev, [rowKey]: m }))
                            }
                            onKeep={() => void keepOne(row)}
                            onSkip={() => void skipOne(row)}
                          />
                        );
                      }),
                    )}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
