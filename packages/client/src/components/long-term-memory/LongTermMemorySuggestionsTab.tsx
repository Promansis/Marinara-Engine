import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Save,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type {
  LtmDraftMutation,
  LtmExtractionDraft,
  LtmExtractionDroppedCandidate,
  LtmExtractionOutcome,
  LtmNote,
} from "@marinara-engine/shared";
import {
  useAcceptLongTermMemoryDraft,
  useDeleteLongTermMemoryDraft,
  useExtractLongTermMemorySourceNote,
  useLongTermMemoryDrafts,
  useLongTermMemoryNotes,
  useRejectLongTermMemoryDraft,
  type ExtractLongTermMemorySourceResponse,
  type LtmSourceExtractionMode,
} from "../../hooks/use-long-term-memory";
import { cn } from "../../lib/utils";
import { actionRowClassName, helperTextClassName, insetSectionCardClassName, sectionCardClassName } from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";
import {
  friendlyIdentifier,
  friendlyNoteTitle,
  friendlyStatus,
  isTypedSuggestionDraft,
} from "./ltm-editor-utils";

type SuggestionRowModel = {
  draft: LtmExtractionDraft;
  mutation: LtmDraftMutation;
};

type SuggestionGroup = "new" | "rewrite";

type LatestExtractionResult = Pick<ExtractLongTermMemorySourceResponse, "diagnostics" | "draft" | "outcome">;

const rewriteKinds = new Set<LtmDraftMutation["kind"]>([
  "append_section",
  "update_section",
  "add_link",
  "set_status",
]);

function isSourceMemory(note: LtmNote) {
  return (
    note.type === "source" ||
    (note.type === "scene" && note.tags.some((tag) => tag === "source_summary" || tag === "chat_summary"))
  );
}

function mutationGroup(mutation: LtmDraftMutation): SuggestionGroup {
  return mutation.kind === "create_note" ? "new" : "rewrite";
}

function mutationKindLabel(kind: LtmDraftMutation["kind"]) {
  switch (kind) {
    case "create_note":
      return "New memory";
    case "append_section":
      return "Add detail";
    case "update_section":
      return "Rewrite detail";
    case "add_link":
      return "Related memory";
    case "set_status":
      return "Status change";
  }
}

function mutationRiskLabel(risk: LtmDraftMutation["risk"]) {
  if (risk === "low") return "Low risk";
  if (risk === "medium") return "Review";
  return "Careful";
}

function mutationRiskTone(risk: LtmDraftMutation["risk"]) {
  if (risk === "low") return "good";
  if (risk === "medium") return "warn";
  return "bad";
}

function draftStatusLabel(statusId: LtmExtractionDraft["status"]) {
  if (statusId === "pending") return "Needs review";
  if (statusId === "accepted") return "Kept";
  if (statusId === "auto_applied") return "Kept automatically";
  return "Skipped";
}

function referenceLabel(count: number) {
  return `${count} reference${count === 1 ? "" : "s"}`;
}

function firstSectionEntry(mutation: LtmDraftMutation) {
  if (mutation.kind !== "create_note") return null;
  return Object.entries(mutation.note.sections)[0] ?? null;
}

function mutationTargetTitle(mutation: LtmDraftMutation) {
  if (mutation.kind === "create_note") return friendlyNoteTitle(mutation.note);
  return friendlyIdentifier(mutation.noteId);
}

function compactMutationText(mutation: LtmDraftMutation, noteLookup: Map<string, LtmNote>) {
  if (mutation.kind === "create_note") {
    const first = firstSectionEntry(mutation);
    return first?.[1].text ?? "";
  }
  if (mutation.kind === "append_section") return mutation.text;
  if (mutation.kind === "update_section") return mutation.section.text;
  if (mutation.kind === "add_link") {
    const targetNote = noteLookup.get(mutation.link.target);
    const targetLabel = targetNote ? friendlyNoteTitle(targetNote) : friendlyIdentifier(mutation.link.target);
    return `${friendlyIdentifier(mutation.link.relation)}: ${targetLabel}`;
  }
  if (mutation.kind === "set_status") return friendlyStatus(mutation.status);
  return "Unknown mutation";
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
      ? "Created 1 typed memory suggestion"
      : `Created ${createdSuggestions} typed memory suggestions`;
  }
  if (outcome.state === "partial_success") {
    return `Kept ${outcome.keptUnits} candidate${outcome.keptUnits === 1 ? "" : "s"} and dropped ${outcome.droppedUnits}`;
  }
  if (outcome.droppedUnits > 0) {
    return `No suggestions created, but ${outcome.droppedUnits} dropped candidate${outcome.droppedUnits === 1 ? "" : "s"} can be reviewed`;
  }
  return "No typed memories extracted";
}

export function LongTermMemorySuggestionsTab({
  note,
  onRecoverDroppedCandidate,
}: {
  note: LtmNote;
  onRecoverDroppedCandidate: (candidate: LtmExtractionDroppedCandidate, note: LtmNote) => void;
}) {
  const drafts = useLongTermMemoryDrafts({}, { enabled: isSourceMemory(note) });
  const notes = useLongTermMemoryNotes();
  const noteLookup = useMemo(() => new Map((notes.data ?? []).map((n) => [n.id, n])), [notes.data]);
  const extractSourceNote = useExtractLongTermMemorySourceNote();
  const [autoApplySafeChanges, setAutoApplySafeChanges] = useState(false);
  const [extractionMode, setExtractionMode] = useState<LtmSourceExtractionMode>("balanced");
  const [latestResult, setLatestResult] = useState<LatestExtractionResult | null>(null);
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
            </div>
            <p className={helperTextClassName}>
              Extract typed memories from this source note, then keep, skip, or manually recover anything useful.
            </p>
          </div>
          <ToolButton
            onClick={() =>
              extractSourceNote
                .mutateAsync({
                  noteId: note.id,
                  applyLowRisk: autoApplySafeChanges,
                  extractionMode,
                })
                .then((result) => {
                  setLatestResult({
                    draft: result.draft,
                    outcome: result.outcome,
                    diagnostics: result.diagnostics,
                  });
                  toast.success(toastForOutcome(result.outcome));
                })
                .catch((err: Error) => toast.error(err.message))
            }
            disabled={extractSourceNote.isPending}
            tone="primary"
          >
            {extractSourceNote.isPending ? (
              <Loader2 size="0.875rem" className="animate-spin" />
            ) : (
              <BrainCircuit size="0.875rem" />
            )}
            Extract typed memories
          </ToolButton>
        </div>
        <div className="mt-3 grid gap-2">
          <label
            className={cn(
              "grid gap-1 rounded-lg p-2 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--accent)]/60",
              extractSourceNote.isPending && "pointer-events-none opacity-45",
            )}
          >
            <span className="font-medium">Extraction mode</span>
            <select
              value={extractionMode}
              disabled={extractSourceNote.isPending}
              onChange={(event) => setExtractionMode(event.target.value as LtmSourceExtractionMode)}
              className="min-h-8 rounded-md bg-[var(--card)] px-2 text-xs text-[var(--foreground)] ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            >
              <option value="balanced">Balanced - merge-aware</option>
              <option value="fast">Fast - skip memory lookup</option>
            </select>
          </label>
          <label
            className={cn(
              "flex items-center gap-2 rounded-lg p-2 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--accent)]/60",
              extractSourceNote.isPending && "pointer-events-none opacity-45",
            )}
          >
            <input
              type="checkbox"
              checked={autoApplySafeChanges}
              disabled={extractSourceNote.isPending}
              onChange={(event) => setAutoApplySafeChanges(event.target.checked)}
              className="h-3.5 w-3.5 shrink-0 rounded border-[var(--border)] accent-[var(--primary)]"
            />
            <span className="min-w-0 flex-1">Auto-apply safe changes</span>
          </label>
        </div>
      </div>

      {latestResult?.outcome ? (
        <ExtractionOutcomePanel
          note={note}
          outcome={latestResult.outcome}
          diagnostics={latestResult.diagnostics}
          onRecoverDroppedCandidate={onRecoverDroppedCandidate}
        />
      ) : null}

      {drafts.isLoading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
          <Loader2 className="mr-2 animate-spin" size="0.875rem" />
          Loading suggestions...
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-xs text-[var(--muted-foreground)]">
          No typed-memory suggestions need review for this source.
        </p>
      ) : (
        <div className="space-y-3">
          <SuggestionDrawer title="New" rows={newRows} noteLookup={noteLookup} />
          <SuggestionDrawer title="Rewrite" rows={rewriteRows} noteLookup={noteLookup} />
        </div>
      )}
    </div>
  );
}

function ExtractionOutcomePanel({
  note,
  outcome,
  diagnostics,
  onRecoverDroppedCandidate,
}: {
  note: LtmNote;
  outcome: LtmExtractionOutcome;
  diagnostics?: ExtractLongTermMemorySourceResponse["diagnostics"];
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
            <StatusPill label={`${outcome.droppedUnits} dropped`} tone={outcome.droppedUnits > 0 ? "warn" : "neutral"} />
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
          <div className="flex items-center gap-2 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
            <AlertCircle size="0.75rem" />
            Dropped candidates
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
}: {
  title: "New" | "Rewrite";
  rows: SuggestionRowModel[];
  noteLookup: Map<string, LtmNote>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="overflow-hidden rounded-xl bg-[var(--secondary)]/25 ring-1 ring-[var(--border)]">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--accent)]/45"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold text-[var(--foreground)]">
          {open ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
          <span className="truncate">{title}</span>
        </span>
        <StatusPill label={`${rows.length}`} tone={rows.length ? "warn" : "neutral"} />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-[var(--border)]/45 p-3">
          {rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--background)]/45 p-3 text-xs text-[var(--muted-foreground)]">
              No {title.toLowerCase()} suggestions.
            </p>
          ) : (
            rows.map((row) => <SuggestionRow key={`${row.draft.id}:${row.mutation.id}`} row={row} noteLookup={noteLookup} />)
          )}
        </div>
      ) : null}
    </section>
  );
}

function SuggestionRow({ row, noteLookup }: { row: SuggestionRowModel; noteLookup: Map<string, LtmNote> }) {
  const { draft, mutation } = row;
  const accept = useAcceptLongTermMemoryDraft();
  const reject = useRejectLongTermMemoryDraft();
  const deleteDraft = useDeleteLongTermMemoryDraft();
  const [editing, setEditing] = useState(false);
  const [editedMutation, setEditedMutation] = useState<LtmDraftMutation | null>(null);
  const busy = accept.isPending || reject.isPending || deleteDraft.isPending;

  const deleteOne = async () => {
    if (!confirm("Delete this suggestion?")) return;
    try {
      await deleteDraft.mutateAsync(draft.id);
      toast.success("Suggestion deleted");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handleAccept = () => {
    accept
      .mutateAsync({
        id: draft.id,
        mutationIds: [mutation.id],
        editedMutations: editedMutation ? [editedMutation] : undefined,
      })
      .then((result: any) => {
        const autoCount: number = result?.autoIncludedMutationIds?.length ?? 0;
        const suffix = autoCount
          ? ` (also created ${autoCount} note${autoCount > 1 ? "s" : ""} to support this change)`
          : "";
        toast.success(editedMutation ? `Edited suggestion kept${suffix}` : `Suggestion kept${suffix}`);
        setEditedMutation(null);
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const handleToggleEdit = () => {
    if (!editing && !editedMutation) setEditedMutation(mutation);
    setEditing((current) => !current);
  };

  const handleSave = (saved: LtmDraftMutation) => {
    setEditedMutation(saved);
    setEditing(false);
  };

  const hasEdits = editedMutation !== null && !editing;

  return (
    <article className="rounded-xl bg-[var(--card)] p-3 ring-1 ring-[var(--border)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill label={mutationKindLabel(mutation.kind)} />
            <StatusPill label={mutationRiskLabel(mutation.risk)} tone={mutationRiskTone(mutation.risk)} />
            <StatusPill label={`Confidence ${Math.round(mutation.confidence * 100)}%`} />
            <StatusPill label={referenceLabel(mutation.evidence.length)} />
            <StatusPill label={draftStatusLabel(draft.status)} />
            {hasEdits ? <StatusPill label="edited" /> : null}
          </div>
          <h4 className="mt-2 text-sm font-medium text-[var(--foreground)]">{mutationTargetTitle(mutation)}</h4>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[var(--muted-foreground)]">
            {compactMutationText(editedMutation ?? mutation, noteLookup)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ToolButton onClick={handleToggleEdit} disabled={busy}>
            <Save size="0.875rem" />
            {editing ? "Cancel edit" : hasEdits ? "Edit again" : "Edit"}
          </ToolButton>
          <ToolButton onClick={handleAccept} disabled={busy} tone="primary">
            <Check size="0.875rem" />
            Keep
          </ToolButton>
          <ToolButton
            onClick={() =>
              reject
                .mutateAsync({ id: draft.id, reason: "Rejected from suggestions panel" })
                .then(() => toast.success("Suggestion skipped"))
                .catch((err: Error) => toast.error(err.message))
            }
            disabled={busy}
          >
            <X size="0.875rem" />
            Skip
          </ToolButton>
          <ToolButton onClick={deleteOne} disabled={busy} tone="danger">
            <Trash2 size="0.875rem" />
            Delete
          </ToolButton>
        </div>
      </div>
      {editing && editedMutation ? (
        <SuggestionMutationEditor mutation={editedMutation} onSave={handleSave} onCancel={() => setEditing(false)} />
      ) : null}
    </article>
  );
}

function SuggestionMutationEditor({
  mutation,
  onSave,
  onCancel,
}: {
  mutation: LtmDraftMutation;
  onSave: (mutation: LtmDraftMutation) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(
    mutation.kind === "create_note"
      ? Object.values(mutation.note.sections)[0]?.text ?? ""
      : mutation.kind === "append_section"
        ? mutation.text
        : mutation.kind === "update_section"
          ? mutation.section.text
          : "",
  );

  if (mutation.kind !== "create_note" && mutation.kind !== "append_section" && mutation.kind !== "update_section") {
    return (
      <div className="mt-3 flex justify-end">
        <ToolButton onClick={onCancel}>Close</ToolButton>
      </div>
    );
  }

  return (
    <div className={cn("mt-3 space-y-2", insetSectionCardClassName)}>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="min-h-24 w-full resize-y rounded-lg bg-[var(--background)] px-3 py-2 text-xs leading-relaxed text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] focus:ring-[var(--primary)]"
      />
      <div className={cn(actionRowClassName, "justify-end border-t-0 pt-0")}>
        <ToolButton onClick={onCancel}>Cancel</ToolButton>
        <ToolButton
          onClick={() => {
            if (mutation.kind === "create_note") {
              const [firstSectionKey] = Object.keys(mutation.note.sections);
              onSave({
                ...mutation,
                note: {
                  ...mutation.note,
                  sections: {
                    ...mutation.note.sections,
                    [firstSectionKey]: {
                      ...mutation.note.sections[firstSectionKey]!,
                      text,
                    },
                  },
                },
              });
              return;
            }
            if (mutation.kind === "append_section") {
              onSave({ ...mutation, text });
              return;
            }
            onSave({
              ...mutation,
              section: {
                ...mutation.section,
                text,
              },
            });
          }}
          tone="primary"
        >
          Save edit
        </ToolButton>
      </div>
    </div>
  );
}
