import { useCallback, useEffect, useId, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { AlertCircle, BrainCircuit, Check, ListChecks, Loader2, MoreHorizontal, Trash2, Wrench, X } from "lucide-react";
import { DisclosureChevron } from "./ltm-panel-shared";
import type {
  LtmDraftMutation,
  LtmDraftReviewDraft,
  LtmDraftReviewSource,
  LtmDraftReviewTarget,
  LtmExtractionAccounting,
  LtmExtractionDiagnostic,
  LtmExtractionDroppedCandidate,
  LtmExtractionOutcome,
  LtmNote,
} from "@marinara-engine/shared";
import { isLtmSourceLikeNote } from "@marinara-engine/shared";
import {
  useAcceptLongTermMemoryDraft,
  useDeleteLongTermMemoryDraft,
  useDeleteLongTermMemoryDraftMutation,
  useExtractLongTermMemorySourceNote,
  useLongTermMemoryDraftReview,
  useLongTermMemoryNotes,
  useSkipLongTermMemoryDraftMutations,
  type AcceptLongTermMemoryDraftResponse,
  type ExtractLongTermMemorySourceResponse,
} from "../../hooks/use-long-term-memory";
import type { LongTermMemoryLatestExtractionResult } from "../../hooks/use-long-term-memory";
import { cn } from "../../lib/utils";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { helperTextClassName, insetSectionCardClassName, sectionCardClassName } from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";
import { friendlyIdentifier, friendlyNoteType } from "./ltm-editor-utils";
import { SuggestionRow, type SuggestionRowModel, suggestionRowKeyFor } from "./LtmSuggestionRow";
import { type LtmManagedExtractionPrefs } from "./ltm-managed-extraction-prefs";
import { SelectionActionBar, type SelectionActionBarAction } from "../ui/SelectionActionBar";

type BatchAction = "keep" | "skip";

function isSourceMemory(note: LtmNote) {
  return isLtmSourceLikeNote(note);
}

function outcomeTone(outcome: LtmExtractionOutcome) {
  if (outcome.state === "success") return "good";
  if (outcome.state === "partial_success") return "warn";
  return "neutral";
}

function outcomeLabel(outcome: LtmExtractionOutcome) {
  if (outcome.state === "success") return "Success";
  if (outcome.state === "partial_success") return "Partial success";
  return "No suggestions created";
}

function clearDroppedCandidatesOutcome(outcome: LtmExtractionOutcome): LtmExtractionOutcome {
  if (outcome.droppedUnits === 0 && outcome.droppedCandidates.length === 0) {
    return outcome;
  }
  return {
    ...outcome,
    state: outcome.keptUnits > 0 ? "success" : "no_suggestions_created",
    droppedUnits: 0,
    droppedCandidates: [],
  };
}

function outcomeSummary(outcome: LtmExtractionOutcome, mutationCount?: number, accounting?: LtmExtractionAccounting) {
  if (outcome.state === "success") {
    const createdSuggestions = mutationCount ?? outcome.keptUnits;
    return createdSuggestions === 1
      ? "Created 1 suggestion from this source."
      : `Created ${createdSuggestions} suggestions from this source.`;
  }
  if (outcome.state === "partial_success") {
    if (accounting) {
      const created = mutationCount ?? accounting.keptUnits;
      const rejected = accounting.parserRejections + accounting.validationRejections;
      return `Created ${created} suggestion${created === 1 ? "" : "s"}; ${rejected} rejected and ${accounting.deduplications} deduplicated.`;
    }
    if (mutationCount !== undefined) {
      return `Created ${mutationCount} suggestion${mutationCount === 1 ? "" : "s"}, kept ${outcome.keptUnits} candidate${outcome.keptUnits === 1 ? "" : "s"}, and dropped ${outcome.droppedUnits}.`;
    }
    return `Kept ${outcome.keptUnits} candidate${outcome.keptUnits === 1 ? "" : "s"} and dropped ${outcome.droppedUnits}.`;
  }
  if (outcome.droppedUnits === 0) {
    return "No usable suggestions were created from the latest extraction.";
  }
  if (accounting) {
    const rejected = accounting.parserRejections + accounting.validationRejections;
    if (rejected > 0) {
      return `No suggestions were created; ${rejected} candidate${rejected === 1 ? " was" : "s were"} rejected and ${accounting.deduplications} deduplicated.`;
    }
  }
  if (outcome.droppedUnits > 0) {
    return `No suggestions were created, but ${outcome.droppedUnits} dropped candidate${outcome.droppedUnits === 1 ? "" : "s"} can still be recovered manually.`;
  }
  return "No usable suggestions were created from the latest extraction.";
}

function toastForOutcome(outcome: LtmExtractionOutcome, mutationCount?: number, accounting?: LtmExtractionAccounting) {
  if (outcome.state === "success") {
    const createdSuggestions = mutationCount ?? outcome.keptUnits;
    return createdSuggestions === 1
      ? "Created 1 memory suggestion"
      : `Created ${createdSuggestions} memory suggestions`;
  }
  if (outcome.state === "partial_success") {
    if (accounting) {
      const created = mutationCount ?? accounting.keptUnits;
      const rejected = accounting.parserRejections + accounting.validationRejections;
      return `Created ${created} memory suggestion${created === 1 ? "" : "s"}; ${rejected} rejected and ${accounting.deduplications} deduplicated`;
    }
    if (mutationCount !== undefined) {
      return `Created ${mutationCount} memory suggestion${mutationCount === 1 ? "" : "s"} and dropped ${outcome.droppedUnits}`;
    }
    return `Kept ${outcome.keptUnits} candidate${outcome.keptUnits === 1 ? "" : "s"} and dropped ${outcome.droppedUnits}`;
  }
  if (accounting) {
    const rejected = accounting.parserRejections + accounting.validationRejections;
    if (rejected > 0) {
      return `No suggestions created; ${rejected} candidate${rejected === 1 ? " was" : "s were"} rejected and ${accounting.deduplications} deduplicated`;
    }
  }
  if (outcome.droppedUnits > 0) {
    return `No suggestions created, but ${outcome.droppedUnits} dropped candidate${outcome.droppedUnits === 1 ? "" : "s"} can be reviewed`;
  }
  return "No memories extracted";
}

function toastForExtractionResult(result: ExtractLongTermMemorySourceResponse, applyLowRisk: boolean) {
  const base = toastForOutcome(result.outcome, result.response.mutations.length, result.accounting);
  if (!applyLowRisk) return base;
  const applied = result.appliedMutationIds.length;
  const skipped = result.skippedMutationIds.length;
  return `${base}; ${applied} low-risk change${applied === 1 ? "" : "s"} applied, ${skipped} change${
    skipped === 1 ? "" : "s"
  } left for review`;
}

function summarizeBulkKeep(keptCount: number, failedDraftCount: number, autoIncludedCount: number) {
  const summary = `Kept ${keptCount} suggestion${keptCount === 1 ? "" : "s"}`;
  const dependencySummary = autoIncludedCount
    ? ` Included ${autoIncludedCount} dependency create${autoIncludedCount === 1 ? "" : "s"}.`
    : "";
  if (failedDraftCount === 0) return { tone: "success" as const, message: `${summary}.${dependencySummary}`.trim() };
  return {
    tone: "error" as const,
    message:
      `${summary}; ${failedDraftCount} suggestion${failedDraftCount === 1 ? "" : "s"} failed.${dependencySummary}`.trim(),
  };
}

function summarizeBulkSkip(skippedCount: number, failedDraftCount: number) {
  const summary = `Skipped ${skippedCount} suggestion${skippedCount === 1 ? "" : "s"}`;
  if (failedDraftCount === 0) return { tone: "success" as const, message: `${summary}.` };
  return {
    tone: "error" as const,
    message: `${summary}; ${failedDraftCount} suggestion${failedDraftCount === 1 ? "" : "s"} failed.`,
  };
}

export function LongTermMemorySuggestionsTab({
  note,
  reviewSource: providedReviewSource,
  embedded = false,
  editedMutationsState,
  extractionPrefs,
  latestExtractionResult,
  onLatestExtractionResultChange,
  onRecoverDroppedCandidate,
}: {
  note: LtmNote;
  reviewSource?: LtmDraftReviewSource;
  embedded?: boolean;
  editedMutationsState?: [Record<string, LtmDraftMutation>, Dispatch<SetStateAction<Record<string, LtmDraftMutation>>>];
  extractionPrefs?: LtmManagedExtractionPrefs;
  latestExtractionResult: LongTermMemoryLatestExtractionResult | null;
  onLatestExtractionResultChange: (result: LongTermMemoryLatestExtractionResult | null) => void;
  onRecoverDroppedCandidate: (candidate: LtmExtractionDroppedCandidate, note: LtmNote) => void;
}) {
  const review = useLongTermMemoryDraftReview(
    { sourceNoteId: note.id, status: "pending" },
    { enabled: isSourceMemory(note) && !providedReviewSource },
  );
  const notes = useLongTermMemoryNotes();
  const noteLookup = useMemo(() => new Map((notes.data ?? []).map((n) => [n.id, n])), [notes.data]);
  const acceptDraft = useAcceptLongTermMemoryDraft();
  const deleteDraft = useDeleteLongTermMemoryDraft();
  const deleteDraftMutation = useDeleteLongTermMemoryDraftMutation();
  const extractSourceNote = useExtractLongTermMemorySourceNote();
  const skipDraftMutations = useSkipLongTermMemoryDraftMutations();
  const connectionId = extractionPrefs?.connectionId ?? "";
  const instruction = extractionPrefs?.instruction ?? "";
  const model = extractionPrefs?.model ?? "";
  const autoApplyLowRisk = extractionPrefs?.autoApplyLowRisk ?? false;
  const [selectMode, setSelectMode] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(() => new Set());
  const [localEditedMutations, setLocalEditedMutations] = useState<Record<string, LtmDraftMutation>>({});
  const hasExternalEditedMutations = Boolean(editedMutationsState);
  const editedMutations = editedMutationsState?.[0] ?? localEditedMutations;
  const setEditedMutations = editedMutationsState?.[1] ?? setLocalEditedMutations;
  const [activeBatchAction, setActiveBatchAction] = useState<BatchAction | null>(null);
  const keepSkipLockRef = useRef(false);
  const sourceMemory = isSourceMemory(note);
  const reviewSource = providedReviewSource ?? review.data?.sources.find((source) => source.sourceNoteId === note.id);
  const reviewDrafts = useMemo(() => reviewSource?.drafts ?? [], [reviewSource?.drafts]);
  const draftReviewById = useMemo(
    () => new Map(reviewDrafts.map((draftReview) => [draftReview.draft.id, draftReview])),
    [reviewDrafts],
  );
  const rows = useMemo<SuggestionRowModel[]>(() => {
    if (!sourceMemory) return [];
    return (reviewSource?.targets ?? []).flatMap((target) =>
      target.rows.flatMap((reviewRow) => {
        const draftReview = draftReviewById.get(reviewRow.draftId);
        if (!draftReview) return [];
        return [
          {
            draft: draftReview.draft,
            mutation: reviewRow.mutation,
            disposition: reviewRow.disposition,
            diagnostics: reviewRow.diagnostics,
            changes: reviewRow.changes,
            blocked: draftReview.blockReasons.length > 0,
          } satisfies SuggestionRowModel,
        ];
      }),
    );
  }, [draftReviewById, reviewSource?.targets, sourceMemory]);
  const targetGroups = useMemo(
    () =>
      (reviewSource?.targets ?? []).map((target) => ({
        target,
        rows: rows.filter((row) => target.rows.some((targetRow) => targetRow.mutation.id === row.mutation.id)),
      })),
    [reviewSource?.targets, rows],
  );
  const allRowKeys = useMemo(() => rows.map((row) => suggestionRowKeyFor(row)), [rows]);
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedRowKeys.has(suggestionRowKeyFor(row))),
    [rows, selectedRowKeys],
  );
  const allRowsSelected = rows.length > 0 && selectedRows.length === rows.length;
  const selectedRowsIncludeBlocker = selectedRows.some((row) => row.blocked);
  const rowActionsDisabled =
    activeBatchAction !== null ||
    acceptDraft.isPending ||
    deleteDraft.isPending ||
    deleteDraftMutation.isPending ||
    extractSourceNote.isPending ||
    skipDraftMutations.isPending;

  const runExtraction = async () => {
    const confirmed = await showConfirmDialog({
      title: "Re-run extraction?",
      message:
        "This will ask the AI to read the source again and replace its current pending review with a new extraction. Continue?",
      confirmLabel: "Re-run",
    });
    if (!confirmed) return;
    extractSourceNote
      .mutateAsync({
        noteId: note.id,
        applyLowRisk: autoApplyLowRisk,
        connectionId: connectionId.trim() || undefined,
        instruction: instruction.trim() || undefined,
        model: model.trim() || undefined,
      })
      .then((result) => {
        onLatestExtractionResultChange({
          outcome: result.outcome,
          diagnostics: result.diagnostics,
          accounting: result.accounting,
          operationId: result.operationId,
          mutationCount: result.response.mutations.length,
        });
        toast.success(toastForExtractionResult(result, autoApplyLowRisk));
      })
      .catch((err: Error) => toast.error(err.message));
  };

  useEffect(() => {
    setSelectMode(false);
    setSelectedRowKeys(new Set());
    if (!hasExternalEditedMutations) setEditedMutations({});
  }, [hasExternalEditedMutations, note.id, setEditedMutations]);

  useEffect(() => {
    const liveKeys = new Set(allRowKeys);
    setSelectedRowKeys((current) => {
      if (current.size === 0) return current;
      const next = new Set(Array.from(current).filter((key) => liveKeys.has(key)));
      return next.size === current.size ? current : next;
    });
    if (!hasExternalEditedMutations) {
      setEditedMutations((current) => {
        const nextEntries = Object.entries(current).filter(([key]) => liveKeys.has(key));
        if (nextEntries.length === Object.keys(current).length) return current;
        return Object.fromEntries(nextEntries);
      });
    }
  }, [allRowKeys, hasExternalEditedMutations, setEditedMutations]);

  const setRowsSelected = useCallback((keys: string[], selected: boolean) => {
    setSelectedRowKeys((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (selected) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }, []);

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
  }, [setEditedMutations]);

  const withKeepSkipLock = useCallback(async <T,>(action: () => Promise<T>) => {
    if (keepSkipLockRef.current) return null;
    keepSkipLockRef.current = true;
    try {
      return await action();
    } finally {
      keepSkipLockRef.current = false;
    }
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
          setSelectedRowKeys((current) => {
            if (!current.has(rowKey)) return current;
            const next = new Set(current);
            next.delete(rowKey);
            return next;
          });
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
          setSelectedRowKeys((current) => {
            if (!current.has(rowKey)) return current;
            const next = new Set(current);
            next.delete(rowKey);
            return next;
          });
        } catch (err) {
          toast.error((err as Error).message);
        }
      });
    },
    [clearEditedMutations, deleteDraftMutation, withKeepSkipLock],
  );

  const dismissDiagnosticDraft = useCallback(
    async (draftReview: LtmDraftReviewDraft) => {
      if (draftReview.draft.mutations.length > 0) return;
      const confirmed = await showConfirmDialog({
        title: "Dismiss extraction report?",
        message: "This removes the persisted extraction diagnostics from Review. It does not change any memory notes.",
        confirmLabel: "Dismiss",
      });
      if (!confirmed) return;
      try {
        await deleteDraft.mutateAsync(draftReview.draft.id);
        toast.success("Extraction report dismissed");
      } catch (err) {
        toast.error((err as Error).message);
      }
    },
    [deleteDraft],
  );

  const runBulkKeep = useCallback(async () => {
    const snapshot = rows.filter((row) => selectedRowKeys.has(suggestionRowKeyFor(row)));
    if (snapshot.length === 0) return;

    const groups = new Map<string, SuggestionRowModel[]>();
    for (const row of snapshot) {
      const existing = groups.get(row.draft.id);
      if (existing) existing.push(row);
      else groups.set(row.draft.id, [row]);
    }

    let keptCount = 0;
    let failedDraftCount = 0;
    let autoIncludedCount = 0;
    const successfulKeys: string[] = [];
    const failedKeys: string[] = [];

    const completed = await withKeepSkipLock(async () => {
      setActiveBatchAction("keep");
      try {
        for (const [draftId, draftRows] of groups) {
          const mutationIds = draftRows.map((row) => row.mutation.id);
          const rowKeys = draftRows.map((row) => suggestionRowKeyFor(row));
          const savedEdits = draftRows
            .map((row) => editedMutations[suggestionRowKeyFor(row)])
            .filter((mutation): mutation is LtmDraftMutation => Boolean(mutation));
          try {
            const result: AcceptLongTermMemoryDraftResponse = await acceptDraft.mutateAsync({
              id: draftId,
              mutationIds,
              editedMutations: savedEdits.length > 0 ? savedEdits : undefined,
            });
            keptCount += draftRows.length;
            autoIncludedCount += result.autoIncludedMutationIds.length;
            successfulKeys.push(...rowKeys);
          } catch (err) {
            failedDraftCount += 1;
            failedKeys.push(...rowKeys);
            void err;
          }
        }
      } finally {
        setActiveBatchAction(null);
      }
    });
    if (completed === null) return;

    clearEditedMutations(successfulKeys);
    setSelectedRowKeys(new Set(failedKeys));

    const summary = summarizeBulkKeep(keptCount, failedDraftCount, autoIncludedCount);
    if (summary.tone === "success") toast.success(summary.message);
    else toast.error(summary.message);
  }, [acceptDraft, clearEditedMutations, editedMutations, rows, selectedRowKeys, withKeepSkipLock]);

  const runBulkSkip = useCallback(async () => {
    const snapshot = rows.filter((row) => selectedRowKeys.has(suggestionRowKeyFor(row)));
    if (snapshot.length === 0) return;

    const groups = new Map<string, SuggestionRowModel[]>();
    for (const row of snapshot) {
      const existing = groups.get(row.draft.id);
      if (existing) existing.push(row);
      else groups.set(row.draft.id, [row]);
    }

    let skippedCount = 0;
    let failedDraftCount = 0;
    const successfulKeys: string[] = [];
    const failedKeys: string[] = [];

    const completed = await withKeepSkipLock(async () => {
      setActiveBatchAction("skip");
      try {
        for (const [draftId, draftRows] of groups) {
          const mutationIds = draftRows.map((row) => row.mutation.id);
          const rowKeys = draftRows.map((row) => suggestionRowKeyFor(row));
          try {
            await skipDraftMutations.mutateAsync({ id: draftId, mutationIds });
            skippedCount += draftRows.length;
            successfulKeys.push(...rowKeys);
          } catch (err) {
            failedDraftCount += 1;
            failedKeys.push(...rowKeys);
            void err;
          }
        }
      } finally {
        setActiveBatchAction(null);
      }
    });
    if (completed === null) return;

    clearEditedMutations(successfulKeys);
    setSelectedRowKeys(new Set(failedKeys));

    const summary = summarizeBulkSkip(skippedCount, failedDraftCount);
    if (summary.tone === "success") toast.success(summary.message);
    else toast.error(summary.message);
  }, [clearEditedMutations, rows, selectedRowKeys, skipDraftMutations, withKeepSkipLock]);

  const selectionActions = useMemo<SelectionActionBarAction[]>(
    () => [
      {
        id: "keep",
        label: "Keep selected",
        icon:
          activeBatchAction === "keep" ? <Loader2 size="0.75rem" className="animate-spin" /> : <Check size="0.75rem" />,
        onClick: () => void runBulkKeep(),
        disabled: selectedRows.length === 0 || selectedRowsIncludeBlocker || rowActionsDisabled,
        tone: "primary",
      },
      {
        id: "skip",
        label: "Skip selected",
        icon: activeBatchAction === "skip" ? <Loader2 size="0.75rem" className="animate-spin" /> : <X size="0.75rem" />,
        onClick: () => void runBulkSkip(),
        disabled: selectedRows.length === 0 || rowActionsDisabled,
      },
      {
        id: "clear",
        label: "Clear",
        icon: <X size="0.75rem" />,
        onClick: () => setSelectedRowKeys(new Set()),
        disabled: selectedRowKeys.size === 0 || rowActionsDisabled,
      },
    ],
    [
      activeBatchAction,
      rowActionsDisabled,
      runBulkKeep,
      runBulkSkip,
      selectedRows.length,
      selectedRowsIncludeBlocker,
      selectedRowKeys.size,
    ],
  );

  if (!sourceMemory) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-xs text-[var(--muted-foreground)]">
        Suggestions are available on source notes after extraction.
      </p>
    );
  }

  if (embedded) {
    return (
      <div className="space-y-3">
        {targetGroups.map(({ target, rows: targetRows }) => (
          <SuggestionTargetDrawer
            key={target.noteId}
            target={target}
            rows={targetRows}
            noteLookup={noteLookup}
            selectMode={false}
            selectedRowKeys={selectedRowKeys}
            editedMutations={editedMutations}
            busy={rowActionsDisabled}
            initialOpen
            onSelectRows={setRowsSelected}
            onMutationEdited={(rowKey, mutation) =>
              setEditedMutations((current) => ({ ...current, [rowKey]: mutation }))
            }
            onKeep={keepOne}
            onSkip={skipOne}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className={sectionCardClassName}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              <StatusPill label="Source note" tone="good" />
              <StatusPill label={`${rows.length} pending suggestion${rows.length === 1 ? "" : "s"}`} />
              {reviewDrafts.some((draftReview) => draftReview.blockReasons.length > 0) ? (
                <StatusPill
                  label={`${reviewDrafts.filter((draftReview) => draftReview.blockReasons.length > 0).length} blocked`}
                  tone="bad"
                />
              ) : null}
              {selectMode ? (
                <StatusPill
                  label={`${selectedRows.length} selected`}
                  tone={selectedRows.length > 0 ? "warn" : "neutral"}
                />
              ) : null}
            </div>
            <p className={helperTextClassName}>
              Extract memory suggestions from this source note, then keep, skip, or manually recover anything useful.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <ToolButton
              onClick={() => {
                if (selectMode) {
                  setSelectMode(false);
                  setSelectedRowKeys(new Set());
                  return;
                }
                setSelectMode(true);
              }}
              disabled={(!selectMode && rows.length === 0) || rowActionsDisabled}
            >
              {selectMode ? <X size="0.875rem" /> : <ListChecks size="0.875rem" />}
              {selectMode ? "Cancel" : "Select"}
            </ToolButton>
            {rows.length === 0 ? (
              <ToolButton onClick={runExtraction} disabled={rowActionsDisabled} tone="primary">
                {extractSourceNote.isPending ? (
                  <Loader2 size="0.875rem" className="animate-spin" />
                ) : (
                  <BrainCircuit size="0.875rem" />
                )}
                Re-run extraction
              </ToolButton>
            ) : (
              <ToolButton onClick={runExtraction} disabled={rowActionsDisabled}>
                <MoreHorizontal size="0.875rem" />
                Re-run extraction
              </ToolButton>
            )}
          </div>
        </div>
      </div>

      {review.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--destructive)]/5 px-3 py-2 ring-1 ring-[var(--destructive)]/25"
        >
          <div className="flex min-w-0 items-start gap-2 text-xs text-[var(--foreground)]">
            <AlertCircle size="0.875rem" className="mt-0.5 shrink-0 text-[var(--destructive)]" />
            <span>
              Review details could not refresh.{" "}
              {review.error instanceof Error ? review.error.message : "The request failed."}
            </span>
          </div>
          <ToolButton onClick={() => void review.refetch()}>
            <Loader2 size="0.75rem" className={review.isFetching ? "animate-spin" : undefined} />
            Retry
          </ToolButton>
        </div>
      ) : null}

      {reviewDrafts.map((draftReview) => (
        <DraftReviewReport
          key={draftReview.draft.id}
          review={draftReview}
          note={note}
          busy={rowActionsDisabled}
          onDismiss={() => void dismissDiagnosticDraft(draftReview)}
          onRecoverDroppedCandidate={onRecoverDroppedCandidate}
        />
      ))}

      {!review.isLoading && reviewDrafts.length === 0 && latestExtractionResult?.outcome ? (
        <ExtractionOutcomePanel
          note={note}
          outcome={latestExtractionResult.outcome}
          accounting={latestExtractionResult.accounting}
          mutationCount={latestExtractionResult.mutationCount}
          onClearDroppedCandidates={() =>
            onLatestExtractionResultChange({
              ...latestExtractionResult,
              outcome: clearDroppedCandidatesOutcome(latestExtractionResult.outcome),
            })
          }
          onRecoverDroppedCandidate={onRecoverDroppedCandidate}
        />
      ) : null}

      {selectMode ? (
        <div className={cn(sectionCardClassName, "flex flex-wrap items-center gap-2")}>
          <label className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-xs text-[var(--foreground)]">
            <input
              type="checkbox"
              checked={allRowsSelected}
              disabled={rows.length === 0 || rowActionsDisabled}
              onChange={(event) => setRowsSelected(allRowKeys, event.target.checked)}
              className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
            />
            Select all
          </label>
          <StatusPill label={`${selectedRows.length} selected`} tone={selectedRows.length > 0 ? "warn" : "neutral"} />
        </div>
      ) : null}

      {review.isLoading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
          <Loader2 className="mr-2 animate-spin" size="0.875rem" />
          Loading suggestions...
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-xs text-[var(--muted-foreground)]">
          No memory suggestions need review for this source note.
        </p>
      ) : (
        <div className="space-y-3">
          {targetGroups.map(({ target, rows: targetRows }) => (
            <SuggestionTargetDrawer
              key={target.noteId}
              target={target}
              rows={targetRows}
              noteLookup={noteLookup}
              selectMode={selectMode}
              selectedRowKeys={selectedRowKeys}
              editedMutations={editedMutations}
              busy={rowActionsDisabled}
              onSelectRows={setRowsSelected}
              onMutationEdited={(rowKey, mutation) =>
                setEditedMutations((current) => ({ ...current, [rowKey]: mutation }))
              }
              onKeep={keepOne}
              onSkip={skipOne}
            />
          ))}
        </div>
      )}
      {selectMode && selectedRows.length > 0 ? (
        <SelectionActionBar selectedCount={selectedRows.length} actions={selectionActions} placement="sticky" />
      ) : null}
    </div>
  );
}

function freshnessLabel(freshness: LtmDraftReviewDraft["freshness"]) {
  if (freshness === "fresh") return "Source current";
  if (freshness === "hashless") return "Re-extraction required";
  if (freshness === "stale") return "Source changed";
  if (freshness === "missing") return "Source missing";
  if (freshness === "invalid") return "Source invalid";
  if (freshness === "superseded") return "Superseded";
  return "No longer pending";
}

function freshnessTone(freshness: LtmDraftReviewDraft["freshness"]) {
  if (freshness === "fresh") return "good" as const;
  if (freshness === "hashless") return "warn" as const;
  return "bad" as const;
}

function DraftReviewReport({
  review,
  note,
  busy,
  onDismiss,
  onRecoverDroppedCandidate,
}: {
  review: LtmDraftReviewDraft;
  note: LtmNote;
  busy: boolean;
  onDismiss: () => void;
  onRecoverDroppedCandidate: (candidate: LtmExtractionDroppedCandidate, note: LtmNote) => void;
}) {
  const headingId = useId();
  const diagnosticOnly = review.draft.mutations.length === 0;
  const outcome = review.draft.extractionOutcome;

  return (
    <section className={sectionCardClassName} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 id={headingId} className="text-xs font-semibold text-[var(--foreground)]">
              Extraction report
            </h3>
            <StatusPill label={freshnessLabel(review.freshness)} tone={freshnessTone(review.freshness)} />
            {outcome ? <StatusPill label={outcomeLabel(outcome)} tone={outcomeTone(outcome)} /> : null}
            {diagnosticOnly ? <StatusPill label="Diagnostics only" tone="warn" /> : null}
          </div>
          {review.draft.summary ? (
            <p className="break-words text-xs leading-relaxed text-[var(--muted-foreground)]">{review.draft.summary}</p>
          ) : null}
        </div>
        {diagnosticOnly ? (
          <ToolButton onClick={onDismiss} disabled={busy}>
            <Trash2 size="0.875rem" />
            Dismiss
          </ToolButton>
        ) : null}
      </div>

      {review.blockReasons.length > 0 ? (
        <div className="mt-3 space-y-1.5" aria-label="Apply blockers">
          {review.blockReasons.map((reason) => (
            <div
              key={reason.code}
              role="alert"
              className="flex gap-2 rounded-lg bg-[var(--destructive)]/5 px-2.5 py-2 text-xs ring-1 ring-[var(--destructive)]/20"
            >
              <AlertCircle size="0.875rem" className="mt-0.5 shrink-0 text-[var(--destructive)]" />
              <div className="min-w-0">
                <p className="break-words text-[var(--foreground)]">{reason.message}</p>
                <code className="mt-0.5 block break-all text-[0.6875rem] text-[var(--muted-foreground)]">
                  {reason.code}
                </code>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {review.draft.accounting ||
      review.diagnostics.length > 0 ||
      review.candidateRejections.length > 0 ||
      review.deduplications.length > 0 ? (
        <details className="mt-3 rounded-lg bg-[var(--background)]/35 px-2.5 py-2 ring-1 ring-[var(--border)]/60">
          <summary className="cursor-pointer text-xs font-medium text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60">
            Technical details
          </summary>
          <div className="mt-2 border-t border-[var(--border)]/55 pt-2">
            {review.draft.accounting ? <ExtractionAccountingLine accounting={review.draft.accounting} /> : null}
            {review.diagnostics.length > 0 ? (
              <DraftDiagnosticList title="Extraction diagnostics" diagnostics={review.diagnostics} />
            ) : null}
            {review.candidateRejections.length > 0 ? (
              <div className="mt-3 space-y-2">
                <h4 className="text-[0.6875rem] font-semibold text-[var(--muted-foreground)]">Candidate rejections</h4>
                {review.candidateRejections.map((candidate) => (
                  <div
                    key={`${candidate.index}-${candidate.reason}`}
                    className="flex flex-col gap-2 rounded-lg bg-[var(--background)]/45 px-2.5 py-2 ring-1 ring-[var(--border)]/60 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0">
                      {candidate.snippet ? (
                        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--foreground)]">
                          {candidate.snippet}
                        </p>
                      ) : null}
                      <p className="mt-1 break-words text-[0.6875rem] text-[var(--muted-foreground)]">
                        {candidate.message}
                      </p>
                      <code className="mt-0.5 block break-all text-[0.6875rem] text-[var(--muted-foreground)]">
                        {candidate.reason}
                      </code>
                    </div>
                    {candidate.snippet ? (
                      <ToolButton onClick={() => onRecoverDroppedCandidate(candidate, note)}>
                        <Wrench size="0.875rem" />
                        Create manual memory
                      </ToolButton>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {review.deduplications.length > 0 ? (
              <DraftDiagnosticList title="Deduplicated candidates" diagnostics={review.deduplications} />
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function DraftDiagnosticList({ title, diagnostics }: { title: string; diagnostics: LtmExtractionDiagnostic[] }) {
  return (
    <div className="mt-3 space-y-1.5">
      <h4 className="text-[0.6875rem] font-semibold text-[var(--muted-foreground)]">{title}</h4>
      {diagnostics.map((diagnostic, index) => (
        <div
          key={`${diagnostic.code}-${diagnostic.candidateIndex ?? "draft"}-${index}`}
          role={diagnostic.severity === "error" ? "alert" : "status"}
          className="flex gap-2 rounded-lg bg-[var(--background)]/45 px-2.5 py-2 text-xs ring-1 ring-[var(--border)]/60"
        >
          <AlertCircle
            size="0.875rem"
            className={cn(
              "mt-0.5 shrink-0",
              diagnostic.severity === "error" ? "text-[var(--destructive)]" : "text-[var(--muted-foreground)]",
            )}
          />
          <div className="min-w-0">
            <p className="break-words text-[var(--foreground)]">{diagnostic.message}</p>
            <code className="mt-0.5 block break-all text-[0.6875rem] text-[var(--muted-foreground)]">
              {diagnostic.code}
            </code>
          </div>
        </div>
      ))}
    </div>
  );
}

function ExtractionAccountingLine({ accounting }: { accounting: LtmExtractionAccounting }) {
  return (
    <div className="mt-3 rounded-lg bg-[var(--background)]/45 px-2.5 py-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)] ring-1 ring-[var(--border)]/60">
      <span className="font-semibold text-[var(--foreground)]">{accounting.providerCandidates}</span> provider candidate
      {accounting.providerCandidates === 1 ? "" : "s"} +{" "}
      <span className="font-semibold text-[var(--foreground)]">{accounting.normalizedAdditions}</span> normalized
      addition
      {accounting.normalizedAdditions === 1 ? "" : "s"} ={" "}
      <span className="font-semibold text-[var(--foreground)]">{accounting.parserRejections}</span> parser rejection
      {accounting.parserRejections === 1 ? "" : "s"} +{" "}
      <span className="font-semibold text-[var(--foreground)]">{accounting.validationRejections}</span> validation
      rejection
      {accounting.validationRejections === 1 ? "" : "s"} +{" "}
      <span className="font-semibold text-[var(--foreground)]">{accounting.deduplications}</span> deduplication
      {accounting.deduplications === 1 ? "" : "s"} +{" "}
      <span className="font-semibold text-[var(--foreground)]">{accounting.keptUnits}</span> kept
    </div>
  );
}

function ExtractionOutcomePanel({
  note,
  outcome,
  accounting,
  mutationCount,
  onClearDroppedCandidates,
  onRecoverDroppedCandidate,
}: {
  note: LtmNote;
  outcome: LtmExtractionOutcome;
  accounting?: LtmExtractionAccounting;
  mutationCount?: number;
  onClearDroppedCandidates: () => void;
  onRecoverDroppedCandidate: (candidate: LtmExtractionDroppedCandidate, note: LtmNote) => void;
}) {
  const [showAllDropped, setShowAllDropped] = useState(false);
  const readableDropped = outcome.droppedCandidates.filter((candidate) => candidate.snippet);
  const visibleDropped = showAllDropped ? readableDropped : readableDropped.slice(0, 3);
  const hiddenCount = readableDropped.length - visibleDropped.length;
  const rejectedCount = outcome.droppedUnits;
  const historicalRejectedCount = accounting
    ? accounting.parserRejections + accounting.validationRejections
    : rejectedCount;
  const unreadableCount = Math.max(0, rejectedCount - readableDropped.length);

  return (
    <section className={sectionCardClassName}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill label={outcomeLabel(outcome)} tone={outcomeTone(outcome)} />
            <StatusPill
              label={`${accounting?.keptUnits ?? outcome.keptUnits} kept`}
              tone={(accounting?.keptUnits ?? outcome.keptUnits) > 0 ? "good" : "neutral"}
            />
            <StatusPill
              label={`${historicalRejectedCount} rejected`}
              tone={historicalRejectedCount > 0 ? "warn" : "neutral"}
            />
            {accounting ? <StatusPill label={`${accounting.deduplications} deduplicated`} /> : null}
          </div>
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
            {outcomeSummary(outcome, mutationCount, accounting)}
          </p>
        </div>
      </div>

      {accounting || rejectedCount > 0 ? (
        <details className="mt-3 rounded-lg bg-[var(--background)]/35 px-2.5 py-2 ring-1 ring-[var(--border)]/60">
          <summary className="cursor-pointer text-xs font-medium text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60">
            Technical details
          </summary>
          <div className="mt-2 border-t border-[var(--border)]/55 pt-2">
            {accounting ? <ExtractionAccountingLine accounting={accounting} /> : null}
            {rejectedCount > 0 ? (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
                    <AlertCircle size="0.75rem" />
                    Candidate rejections
                  </div>
                  <ToolButton onClick={onClearDroppedCandidates}>
                    <X size="0.875rem" />
                    Remove all
                  </ToolButton>
                </div>
                {visibleDropped.map((candidate) => (
                  <article
                    key={`${candidate.index}-${candidate.reason}-${candidate.snippet}`}
                    className={insetSectionCardClassName}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--foreground)]">
                          {candidate.snippet}
                        </p>
                        <p className="mt-1 text-[0.6875rem] text-[var(--muted-foreground)]">{candidate.message}</p>
                      </div>
                      <ToolButton onClick={() => onRecoverDroppedCandidate(candidate, note)}>
                        <Wrench size="0.875rem" />
                        Create manual memory
                      </ToolButton>
                    </div>
                  </article>
                ))}
                {hiddenCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowAllDropped((current) => !current)}
                    aria-expanded={showAllDropped}
                    className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  >
                    <DisclosureChevron open={showAllDropped} size={12} />
                    {showAllDropped
                      ? "Show fewer dropped candidates"
                      : `Show all dropped candidates (${hiddenCount} more)`}
                  </button>
                ) : null}
                {unreadableCount > 0 ? (
                  <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
                    {unreadableCount} dropped candidate{unreadableCount === 1 ? "" : "s"} had no safe snippet to show
                    here.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function SuggestionTargetDrawer({
  target,
  rows,
  noteLookup,
  selectMode,
  selectedRowKeys,
  editedMutations,
  busy,
  initialOpen = false,
  onSelectRows,
  onMutationEdited,
  onKeep,
  onSkip,
}: {
  target: LtmDraftReviewTarget;
  rows: SuggestionRowModel[];
  noteLookup: Map<string, LtmNote>;
  selectMode: boolean;
  selectedRowKeys: Set<string>;
  editedMutations: Record<string, LtmDraftMutation>;
  busy: boolean;
  initialOpen?: boolean;
  onSelectRows: (keys: string[], selected: boolean) => void;
  onMutationEdited: (rowKey: string, mutation: LtmDraftMutation) => void;
  onKeep: (row: SuggestionRowModel) => void;
  onSkip: (row: SuggestionRowModel) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const rowKeys = rows.map((row) => suggestionRowKeyFor(row));
  const selectedCount = rowKeys.filter((key) => selectedRowKeys.has(key)).length;
  const allSelected = rows.length > 0 && selectedCount === rows.length;
  const title = target.title ?? friendlyIdentifier(target.noteId);

  return (
    <section className="overflow-hidden rounded-xl bg-[var(--secondary)]/25 ring-1 ring-[var(--border)]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-[var(--foreground)]"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold text-[var(--foreground)]">
            <DisclosureChevron open={open} />
            <span className="truncate">{title}</span>
            <StatusPill label={friendlyNoteType(target.noteType)} />
          </span>
        </button>
        {selectMode ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="flex min-h-8 items-center gap-2 rounded-lg bg-[var(--background)]/45 px-2 text-[0.6875rem] text-[var(--foreground)] ring-1 ring-[var(--border)]">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={rows.length === 0 || busy}
                onChange={(event) => onSelectRows(rowKeys, event.target.checked)}
                className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
              />
              Select all
            </label>
            <button
              type="button"
              onClick={() => onSelectRows(rowKeys, false)}
              disabled={selectedCount === 0 || busy}
              className="inline-flex min-h-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-2.5 py-1.5 text-[0.6875rem] font-semibold text-[var(--secondary-foreground)] shadow-sm transition-[background-color,color,transform] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 max-md:min-h-10"
            >
              Clear
            </button>
          </div>
        ) : null}
        <StatusPill
          label={selectMode ? `${selectedCount}/${rows.length}` : `${rows.length}`}
          tone={rows.length ? "warn" : "neutral"}
        />
      </div>
      {open ? (
        <div className="space-y-2 border-t border-[var(--border)]/45 p-3">
          {rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--background)]/45 p-3 text-xs text-[var(--muted-foreground)]">
              No suggestions target this memory.
            </p>
          ) : (
            rows.map((row) => {
              const rowKey = suggestionRowKeyFor(row);
              return (
                <SuggestionRow
                  key={rowKey}
                  row={row}
                  noteLookup={noteLookup}
                  selectMode={selectMode}
                  selected={selectedRowKeys.has(rowKey)}
                  editedMutation={editedMutations[rowKey]}
                  busy={busy}
                  onSelect={(selected) => onSelectRows([rowKey], selected)}
                  onMutationEdited={(mutation) => onMutationEdited(rowKey, mutation)}
                  onKeep={() => onKeep(row)}
                  onSkip={() => onSkip(row)}
                />
              );
            })
          )}
        </div>
      ) : null}
    </section>
  );
}
