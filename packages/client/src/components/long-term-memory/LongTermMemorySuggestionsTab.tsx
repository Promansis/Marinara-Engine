import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Wrench,
  X,
} from "lucide-react";
import type {
  LtmDraftMutation,
  LtmExtractionDroppedCandidate,
  LtmExtractionOutcome,
  LtmNote,
} from "@marinara-engine/shared";
import { isLtmSourceLikeNote } from "@marinara-engine/shared";
import {
  useAcceptLongTermMemoryDraft,
  useDeleteLongTermMemoryDraftMutation,
  useExtractLongTermMemorySourceNote,
  useLongTermMemoryDrafts,
  useLongTermMemoryNotes,
  useSkipLongTermMemoryDraftMutations,
  type AcceptLongTermMemoryDraftResponse,
  type ExtractLongTermMemorySourceResponse,
} from "../../hooks/use-long-term-memory";
import { cn } from "../../lib/utils";
import { showConfirmDialog } from "../../lib/app-dialogs";
import {
  helperTextClassName,
  insetSectionCardClassName,
  sectionCardClassName,
} from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";
import { isTypedSuggestionDraft } from "./ltm-editor-utils";
import {
  SuggestionRow,
  type SuggestionRowModel,
  suggestionRowKeyFor,
} from "./LtmSuggestionRow";

type SuggestionGroup = "new" | "rewrite";
type BatchAction = "keep" | "skip";
export type LongTermMemoryLatestExtractionResult = Pick<ExtractLongTermMemorySourceResponse, "diagnostics" | "outcome">;

const rewriteKinds = new Set<LtmDraftMutation["kind"]>(["append_section", "update_section", "add_link", "set_keywords", "set_status"]);

function isSourceMemory(note: LtmNote) {
  return isLtmSourceLikeNote(note);
}

function mutationGroup(mutation: LtmDraftMutation): SuggestionGroup {
  return mutation.kind === "create_note" ? "new" : "rewrite";
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

function outcomeSummary(outcome: LtmExtractionOutcome) {
  const createdSuggestions = outcome.suggestionCap?.returned ?? outcome.keptUnits;
  if (outcome.state === "success") {
    return createdSuggestions === 1
      ? "Created 1 suggestion from this source."
      : `Created ${createdSuggestions} suggestions from this source.`;
  }
  if (outcome.state === "partial_success") {
    return `Kept ${outcome.keptUnits} candidate${outcome.keptUnits === 1 ? "" : "s"} and dropped ${outcome.droppedUnits}.`;
  }
  if (outcome.droppedUnits > 0) {
    return `No suggestions were created, but ${outcome.droppedUnits} dropped candidate${outcome.droppedUnits === 1 ? "" : "s"} can still be recovered manually.`;
  }
  return "No usable suggestions were created from the latest extraction.";
}

function toastForOutcome(outcome: LtmExtractionOutcome) {
  const createdSuggestions = outcome.suggestionCap?.returned ?? outcome.keptUnits;
  if (outcome.state === "success") {
    return createdSuggestions === 1
      ? "Created 1 memory stream suggestion"
      : `Created ${createdSuggestions} memory stream suggestions`;
  }
  if (outcome.state === "partial_success") {
    return `Kept ${outcome.keptUnits} candidate${outcome.keptUnits === 1 ? "" : "s"} and dropped ${outcome.droppedUnits}`;
  }
  if (outcome.droppedUnits > 0) {
    return `No suggestions created, but ${outcome.droppedUnits} dropped candidate${outcome.droppedUnits === 1 ? "" : "s"} can be reviewed`;
  }
  return "No memory streams extracted";
}

function toastForExtractionResult(result: ExtractLongTermMemorySourceResponse, applyLowRisk: boolean) {
  const base = toastForOutcome(result.outcome);
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
  latestExtractionResult,
  onLatestExtractionResultChange,
  onRecoverDroppedCandidate,
}: {
  note: LtmNote;
  latestExtractionResult: LongTermMemoryLatestExtractionResult | null;
  onLatestExtractionResultChange: (result: LongTermMemoryLatestExtractionResult | null) => void;
  onRecoverDroppedCandidate: (candidate: LtmExtractionDroppedCandidate, note: LtmNote) => void;
}) {
  const drafts = useLongTermMemoryDrafts({}, { enabled: isSourceMemory(note) });
  const notes = useLongTermMemoryNotes();
  const noteLookup = useMemo(() => new Map((notes.data ?? []).map((n) => [n.id, n])), [notes.data]);
  const acceptDraft = useAcceptLongTermMemoryDraft();
  const deleteDraftMutation = useDeleteLongTermMemoryDraftMutation();
  const extractSourceNote = useExtractLongTermMemorySourceNote();
  const skipDraftMutations = useSkipLongTermMemoryDraftMutations();
  const connectionId = "";
  const instruction = "";
  const model = "";
  const autoApplyLowRisk = false;
  const [selectMode, setSelectMode] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(() => new Set());
  const [editedMutations, setEditedMutations] = useState<Record<string, LtmDraftMutation>>({});
  const [activeBatchAction, setActiveBatchAction] = useState<BatchAction | null>(null);
  const keepSkipLockRef = useRef(false);
  const sourceMemory = isSourceMemory(note);
  const rows = useMemo<SuggestionRowModel[]>(() => {
    if (!sourceMemory) return [];
    return (drafts.data ?? [])
      .filter((draft) => draft.status === "pending")
      .filter((draft) => draft.source.sourceNoteId === note.id)
      .filter(isTypedSuggestionDraft)
      .flatMap((draft) => draft.mutations.map((mutation) => ({ draft, mutation })));
  }, [drafts.data, note.id, sourceMemory]);
  const newRows = rows.filter((row) => mutationGroup(row.mutation) === "new");
  const rewriteRows = rows.filter((row) => rewriteKinds.has(row.mutation.kind));
  const allRowKeys = useMemo(() => rows.map((row) => suggestionRowKeyFor(row)), [rows]);
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedRowKeys.has(suggestionRowKeyFor(row))),
    [rows, selectedRowKeys],
  );
  const allRowsSelected = rows.length > 0 && selectedRows.length === rows.length;
  const rowActionsDisabled =
    activeBatchAction !== null ||
    acceptDraft.isPending ||
    deleteDraftMutation.isPending ||
    extractSourceNote.isPending ||
    skipDraftMutations.isPending;

  const runExtraction = async () => {
    const confirmed = await showConfirmDialog({
      title: "Re-run extraction?",
      message:
        "This will ask the AI to read the source again and create a new batch of suggestions. Your existing pending suggestions will stay. Continue?",
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
        });
        toast.success(toastForExtractionResult(result, autoApplyLowRisk));
      })
      .catch((err: Error) => toast.error(err.message));
  };

  useEffect(() => {
    setSelectMode(false);
    setSelectedRowKeys(new Set());
    setEditedMutations({});
  }, [note.id]);

  useEffect(() => {
    const liveKeys = new Set(allRowKeys);
    setSelectedRowKeys((current) => {
      if (current.size === 0) return current;
      const next = new Set(Array.from(current).filter((key) => liveKeys.has(key)));
      return next.size === current.size ? current : next;
    });
    setEditedMutations((current) => {
      const nextEntries = Object.entries(current).filter(([key]) => liveKeys.has(key));
      if (nextEntries.length === Object.keys(current).length) return current;
      return Object.fromEntries(nextEntries);
    });
  }, [allRowKeys]);

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
  }, []);

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

  if (!sourceMemory) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-xs text-[var(--muted-foreground)]">
        Suggestions are available on source memories after extraction.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      <div className={sectionCardClassName}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              <StatusPill label="Source memory" tone="good" />
              <StatusPill label={`${rows.length} pending suggestion${rows.length === 1 ? "" : "s"}`} />
              {selectMode ? (
                <StatusPill
                  label={`${selectedRows.length} selected`}
                  tone={selectedRows.length > 0 ? "warn" : "neutral"}
                />
              ) : null}
            </div>
            <p className={helperTextClassName}>
              Extract memory streams from this source note, then keep, skip, or manually recover anything useful.
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
              <ToolButton
                onClick={runExtraction}
                disabled={rowActionsDisabled}
                tone="primary"
              >
                {extractSourceNote.isPending ? (
                  <Loader2 size="0.875rem" className="animate-spin" />
                ) : (
                  <BrainCircuit size="0.875rem" />
                )}
                Re-run extraction
              </ToolButton>
            ) : (
              <ToolButton
                onClick={runExtraction}
                disabled={rowActionsDisabled}
              >
                <MoreHorizontal size="0.875rem" />
                Re-run extraction
              </ToolButton>
            )}
          </div>
        </div>
      </div>

      {latestExtractionResult?.outcome ? (
        <ExtractionOutcomePanel
          note={note}
          outcome={latestExtractionResult.outcome}
          diagnostics={latestExtractionResult.diagnostics}
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
          <button
            type="button"
            onClick={() => setSelectedRowKeys(new Set())}
            disabled={selectedRowKeys.size === 0 || rowActionsDisabled}
            className="rounded-lg px-2 py-1.5 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <ToolButton
              onClick={() => void runBulkKeep()}
              disabled={selectedRows.length === 0 || rowActionsDisabled}
              tone="primary"
            >
              {activeBatchAction === "keep" ? (
                <Loader2 size="0.875rem" className="animate-spin" />
              ) : (
                <Check size="0.875rem" />
              )}
              Keep selected
            </ToolButton>
            <ToolButton onClick={() => void runBulkSkip()} disabled={selectedRows.length === 0 || rowActionsDisabled}>
              {activeBatchAction === "skip" ? (
                <Loader2 size="0.875rem" className="animate-spin" />
              ) : (
                <X size="0.875rem" />
              )}
              Skip selected
            </ToolButton>
          </div>
        </div>
      ) : null}

      {drafts.isLoading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
          <Loader2 className="mr-2 animate-spin" size="0.875rem" />
          Loading suggestions...
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-xs text-[var(--muted-foreground)]">
          No memory stream suggestions need review for this source.
        </p>
      ) : (
        <div className="space-y-3">
          <SuggestionDrawer
            title="New"
            rows={newRows}
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
          <SuggestionDrawer
            title="Rewrite"
            rows={rewriteRows}
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
        </div>
      )}
    </div>
  );
}

function ExtractionOutcomePanel({
  note,
  outcome,
  diagnostics,
  onClearDroppedCandidates,
  onRecoverDroppedCandidate,
}: {
  note: LtmNote;
  outcome: LtmExtractionOutcome;
  diagnostics?: ExtractLongTermMemorySourceResponse["diagnostics"];
  onClearDroppedCandidates: () => void;
  onRecoverDroppedCandidate: (candidate: LtmExtractionDroppedCandidate, note: LtmNote) => void;
}) {
  const [showAllDropped, setShowAllDropped] = useState(false);
  const suggestionCapWarning = outcome.suggestionCap?.capped
    ? `Created ${outcome.suggestionCap.returned} of ${outcome.suggestionCap.generated} suggested changes.`
    : diagnostics?.some((diagnostic) => diagnostic.code === "suggestions_capped")
      ? "Some suggestions were capped at 25."
      : null;
  const readableDropped = outcome.droppedCandidates.filter((candidate) => candidate.snippet);
  const visibleDropped = showAllDropped ? readableDropped : readableDropped.slice(0, 3);
  const hiddenCount = readableDropped.length - visibleDropped.length;
  const unreadableCount = outcome.droppedUnits - readableDropped.length;

  return (
    <section className={sectionCardClassName}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill label={outcomeLabel(outcome)} tone={outcomeTone(outcome)} />
            <StatusPill label={`${outcome.keptUnits} kept`} tone={outcome.keptUnits > 0 ? "good" : "neutral"} />
            <StatusPill
              label={`${outcome.droppedUnits} dropped`}
              tone={outcome.droppedUnits > 0 ? "warn" : "neutral"}
            />
          </div>
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{outcomeSummary(outcome)}</p>
          {suggestionCapWarning ? (
            <p className="text-xs leading-relaxed text-amber-300">{suggestionCapWarning}</p>
          ) : null}
        </div>
        {outcome.droppedUnits > 0 ? (
          <div className="text-[0.6875rem] text-[var(--muted-foreground)]">
            {outcome.totalCandidates} candidate{outcome.totalCandidates === 1 ? "" : "s"} scanned
          </div>
        ) : null}
      </div>

      {outcome.droppedUnits > 0 ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
              <AlertCircle size="0.75rem" />
              Dropped candidates
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
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs leading-relaxed text-[var(--foreground)]">{candidate.snippet}</p>
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
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
            >
              {showAllDropped ? <ChevronDown size="0.75rem" /> : <ChevronRight size="0.75rem" />}
              {showAllDropped ? "Show fewer dropped candidates" : `Show all dropped candidates (${hiddenCount} more)`}
            </button>
          ) : null}
          {unreadableCount > 0 ? (
            <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
              {unreadableCount} dropped candidate{unreadableCount === 1 ? "" : "s"} had no safe snippet to show here.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SuggestionDrawer({
  title,
  rows,
  noteLookup,
  selectMode,
  selectedRowKeys,
  editedMutations,
  busy,
  onSelectRows,
  onMutationEdited,
  onKeep,
  onSkip,
}: {
  title: "New" | "Rewrite";
  rows: SuggestionRowModel[];
  noteLookup: Map<string, LtmNote>;
  selectMode: boolean;
  selectedRowKeys: Set<string>;
  editedMutations: Record<string, LtmDraftMutation>;
  busy: boolean;
  onSelectRows: (keys: string[], selected: boolean) => void;
  onMutationEdited: (rowKey: string, mutation: LtmDraftMutation) => void;
  onKeep: (row: SuggestionRowModel) => void;
  onSkip: (row: SuggestionRowModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const rowKeys = rows.map((row) => suggestionRowKeyFor(row));
  const selectedCount = rowKeys.filter((key) => selectedRowKeys.has(key)).length;
  const allSelected = rows.length > 0 && selectedCount === rows.length;

  return (
    <section className="overflow-hidden rounded-xl bg-[var(--secondary)]/25 ring-1 ring-[var(--border)]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-[var(--foreground)]"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold text-[var(--foreground)]">
            {open ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
            <span className="truncate">{title}</span>
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
              className="rounded-lg px-2 py-1.5 text-[0.6875rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
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
              No {title.toLowerCase()} suggestions.
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
