import { useMemo, useState } from "react";
import { toast } from "sonner";
import { BrainCircuit, Check, ChevronDown, ChevronRight, Loader2, Save, Trash2, X } from "lucide-react";
import type { LtmDraftMutation, LtmExtractionDraft, LtmMode, LtmNote, LtmNoteType } from "@marinara-engine/shared";
import {
  useAcceptLongTermMemoryDraft,
  useDeleteLongTermMemoryDraft,
  useExtractLongTermMemorySourceNote,
  useLongTermMemoryDrafts,
  useLongTermMemoryNotes,
  useRejectLongTermMemoryDraft,
  type LtmExtractionDiagnostic,
} from "../../hooks/use-long-term-memory";
import { cn } from "../../lib/utils";
import { compactInputClassName, SettingField, textareaClassName } from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";
import {
  allowedIdPrefixesByType,
  friendlyIdentifier,
  friendlyMode,
  friendlyNoteTitle,
  friendlyNoteType,
  friendlySectionKey,
  friendlyStatus,
  isTypedSuggestionDraft,
  modeOptions,
  normalizeIdentifier,
  normalizeTagsInput,
  noteTypeOptions,
  statusOptions,
} from "./ltm-editor-utils";

type SuggestionRowModel = {
  draft: LtmExtractionDraft;
  mutation: LtmDraftMutation;
};

type SuggestionGroup = "new" | "rewrite";

const rewriteKinds = new Set<LtmDraftMutation["kind"]>([
  "append_section",
  "update_section",
  "add_link",
  "set_status",
]);
function visibleExtractionDiagnostics(diagnostics: LtmExtractionDiagnostic[]) {
  return diagnostics.filter(
    (diagnostic) => !(diagnostic.code === "missing_gate" && diagnostic.message === "Potential nsfw content is not gated."),
  );
}

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

function SettingToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2 rounded-lg p-1.5 text-xs text-[var(--foreground)] hover:bg-[var(--secondary)]/55",
        disabled && "pointer-events-none opacity-45",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 shrink-0 rounded border-[var(--border)] accent-[var(--primary)]"
      />
      <span className="min-w-0 flex-1">{label}</span>
    </label>
  );
}

function ExtractionDiagnosticsList({ diagnostics }: { diagnostics: LtmExtractionDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Last extraction diagnostics</div>
      {diagnostics.map((diagnostic, index) => (
        <div
          key={`${diagnostic.severity}-${diagnostic.code}-${diagnostic.mutationId ?? diagnostic.noteId ?? index}`}
          className={cn(
            "rounded-lg p-3 text-xs ring-1",
            diagnostic.severity === "error"
              ? "bg-rose-500/10 text-rose-100 ring-rose-400/30"
              : "bg-amber-500/10 text-amber-100 ring-amber-400/30",
          )}
        >
          <div className="flex flex-wrap items-center gap-1.5 font-medium">
            <StatusPill
              label={diagnostic.severity === "error" ? "Error" : "Warning"}
              tone={diagnostic.severity === "error" ? "bad" : "warn"}
            />
            <span>{diagnostic.code}</span>
          </div>
          <p className="mt-1 leading-relaxed opacity-90">{diagnostic.message}</p>
        </div>
      ))}
    </div>
  );
}

export function LongTermMemorySuggestionsTab({ note }: { note: LtmNote }) {
  const drafts = useLongTermMemoryDrafts({}, { enabled: isSourceMemory(note) });
  const notes = useLongTermMemoryNotes();
  const noteLookup = useMemo(() => new Map((notes.data ?? []).map((n) => [n.id, n])), [notes.data]);
  const extractSourceNote = useExtractLongTermMemorySourceNote();
  const [autoApplySafeChanges, setAutoApplySafeChanges] = useState(false);
  const [diagnostics, setDiagnostics] = useState<LtmExtractionDiagnostic[]>([]);
  const sourceMemory = isSourceMemory(note);
  const visibleDiagnostics = useMemo(() => visibleExtractionDiagnostics(diagnostics), [diagnostics]);
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
      <div className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            <StatusPill label="Source memory" tone="good" />
            <StatusPill label={`${rows.length} pending suggestion${rows.length === 1 ? "" : "s"}`} />
          </div>
          <ToolButton
            onClick={() =>
              extractSourceNote
                .mutateAsync({
                  noteId: note.id,
                  applyLowRisk: autoApplySafeChanges,
                })
                .then((result) => {
                  const visibleResultDiagnostics = visibleExtractionDiagnostics(result.diagnostics);
                  setDiagnostics(visibleResultDiagnostics);
                  const count = result.draft?.mutations.length ?? 0;
                  const issueCount = visibleResultDiagnostics.length;
                  toast.success(
                    count
                      ? `Created ${count} typed memory suggestion${count === 1 ? "" : "s"}${
                          issueCount ? ` with ${issueCount} diagnostic${issueCount === 1 ? "" : "s"}` : ""
                        }`
                      : issueCount
                        ? `No typed memories extracted, ${issueCount} diagnostic${issueCount === 1 ? "" : "s"}`
                        : "No typed memories extracted",
                  );
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
          <SettingToggle
            label="Auto-apply safe changes"
            checked={autoApplySafeChanges}
            disabled={extractSourceNote.isPending}
            onChange={setAutoApplySafeChanges}
          />
        </div>
      </div>

      <ExtractionDiagnosticsList diagnostics={visibleDiagnostics} />

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

function SuggestionDrawer({ title, rows, noteLookup }: { title: "New" | "Rewrite"; rows: SuggestionRowModel[]; noteLookup: Map<string, LtmNote> }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="rounded-lg bg-[var(--secondary)]/25 ring-1 ring-[var(--border)]">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-[var(--foreground)]">
          {open ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
          {title}
        </span>
        <StatusPill label={`${rows.length}`} tone={rows.length ? "warn" : "neutral"} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-[var(--border)]/45 p-2">
          {rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--background)]/45 p-3 text-xs text-[var(--muted-foreground)]">
              No {title.toLowerCase()} suggestions.
            </p>
          ) : (
            rows.map((row) => <SuggestionRow key={`${row.draft.id}:${row.mutation.id}`} row={row} noteLookup={noteLookup} />)
          )}
        </div>
      )}
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
        toast.success(
          editedMutation ? `Edited suggestion kept${suffix}` : `Suggestion kept${suffix}`,
        );
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
    <article className="rounded-lg bg-[var(--card)] p-3 ring-1 ring-[var(--border)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill label={mutationKindLabel(mutation.kind)} />
            <StatusPill label={mutationRiskLabel(mutation.risk)} tone={mutationRiskTone(mutation.risk)} />
            <StatusPill label={`Confidence ${Math.round(mutation.confidence * 100)}%`} />
            <StatusPill label={referenceLabel(mutation.evidence.length)} />
            <StatusPill label={draftStatusLabel(draft.status)} />
            {hasEdits && <StatusPill label="edited" />}
          </div>
          <h4 className="mt-2 text-xs font-semibold text-[var(--foreground)]">{mutation.summary}</h4>
          <div className="mt-1 text-[0.6875rem] text-[var(--muted-foreground)]">
            {mutationTargetTitle(mutation)}
          </div>
          <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">
            {compactMutationText(mutation, noteLookup)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ToolButton
            onClick={handleAccept}
            disabled={busy}
            tone="primary"
          >
            {accept.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Check size="0.875rem" />}
            Accept
          </ToolButton>
          <ToolButton onClick={handleToggleEdit} disabled={busy}>
            {editing ? <X size="0.875rem" /> : <Save size="0.875rem" />}
            {editing ? "Close" : hasEdits ? "Edit" : "Edit"}
          </ToolButton>
          <ToolButton onClick={deleteOne} disabled={busy} tone="danger">
            <Trash2 size="0.875rem" />
            Delete
          </ToolButton>
        </div>
      </div>
      {editing && <SuggestionMutationEditor mutation={editedMutation ?? mutation} onSave={handleSave} saving={false} noteLookup={noteLookup} />}
    </article>
  );
}

function SuggestionMutationEditor({
  mutation,
  onSave,
  saving,
  noteLookup,
}: {
  mutation: LtmDraftMutation;
  onSave: (mutation: LtmDraftMutation) => void;
  saving?: boolean;
  noteLookup: Map<string, LtmNote>;
}) {
  const [draft, setDraft] = useState(mutation);
  const setCommon = (patch: Partial<Pick<LtmDraftMutation, "summary" | "risk" | "confidence" | "evidence">>) => {
    setDraft((current) => ({ ...current, ...patch }) as LtmDraftMutation);
  };
  return (
    <div className="mt-3 grid gap-3 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
      <div className="grid gap-2 sm:grid-cols-[1fr_8rem_8rem]">
        <SettingField label="Summary">
          <input
            value={draft.summary}
            onChange={(event) => setCommon({ summary: event.target.value })}
            className={compactInputClassName}
          />
        </SettingField>
        <SettingField label="Risk">
          <select
            value={draft.risk}
            onChange={(event) => setCommon({ risk: event.target.value as LtmDraftMutation["risk"] })}
            className={compactInputClassName}
          >
            <option value="low">Low risk</option>
            <option value="medium">Review</option>
            <option value="high">Careful</option>
          </select>
        </SettingField>
        <SettingField label="Confidence">
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={draft.confidence}
            onChange={(event) => setCommon({ confidence: Math.max(0, Math.min(1, Number(event.target.value) || 0)) })}
            className={compactInputClassName}
          />
        </SettingField>
      </div>
      <SettingField label="References">
        <textarea
          value={draft.evidence.join("\n")}
          onChange={(event) =>
            setCommon({
              evidence: event.target.value
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            })
          }
          className={cn(textareaClassName, "min-h-16")}
        />
      </SettingField>
      <MutationSpecificFields mutation={draft} onChange={setDraft} noteLookup={noteLookup} />
      <div className="flex justify-end">
        <ToolButton onClick={() => onSave(draft)} disabled={saving} tone="primary">
          {saving ? <Loader2 size="0.875rem" className="animate-spin" /> : <Save size="0.875rem" />}
          Save Suggestion
        </ToolButton>
      </div>
    </div>
  );
}

function MutationSpecificFields({
  mutation,
  onChange,
  noteLookup,
}: {
  mutation: LtmDraftMutation;
  onChange: (mutation: LtmDraftMutation) => void;
  noteLookup: Map<string, LtmNote>;
}) {
  if (mutation.kind === "create_note") {
    const firstSection = firstSectionEntry(mutation);
    const sectionKey = firstSection?.[0] ?? "core";
    const section = firstSection?.[1] ?? { text: "", updatedAt: new Date().toISOString() };
    const prefix = allowedIdPrefixesByType[mutation.note.type][0] ?? "note_";
    const setNote = (patch: Partial<typeof mutation.note>) => onChange({ ...mutation, note: { ...mutation.note, ...patch } });
    return (
      <div className="grid gap-2">
        <div className="grid gap-2 sm:grid-cols-[1fr_10rem_10rem]">
          <SettingField label="Friendly title">
            <input
              value={friendlyIdentifier(mutation.note.id)}
              onChange={(event) => setNote({ id: `${prefix}${normalizeIdentifier(event.target.value, "memory")}` })}
              className={compactInputClassName}
            />
          </SettingField>
          <SettingField label="Type">
            <select
              value={mutation.note.type}
              onChange={(event) => {
                const nextType = event.target.value as LtmNoteType;
                const nextPrefix = allowedIdPrefixesByType[nextType][0] ?? "note_";
                setNote({ type: nextType, id: `${nextPrefix}${normalizeIdentifier(friendlyIdentifier(mutation.note.id), "memory")}` });
              }}
              className={compactInputClassName}
            >
              {noteTypeOptions.map((type) => (
                <option key={type} value={type}>
                  {friendlyNoteType(type)}
                </option>
              ))}
            </select>
          </SettingField>
          <SettingField label="Status">
            <select
              value={mutation.note.status}
              onChange={(event) => setNote({ status: event.target.value as LtmNote["status"] })}
              className={compactInputClassName}
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {friendlyStatus(status)}
                </option>
              ))}
            </select>
          </SettingField>
        </div>
        <SettingField label="Modes">
          <div className="grid gap-1 sm:grid-cols-2">
            {modeOptions.map((mode) => (
              <label key={mode} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-[var(--secondary)]">
                <input
                  type="checkbox"
                  checked={mutation.note.modes.includes(mode)}
                  onChange={(event) =>
                    setNote({
                      modes: event.target.checked
                        ? [...mutation.note.modes, mode]
                        : mutation.note.modes.filter((item: LtmMode) => item !== mode),
                    })
                  }
                  className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                />
                {friendlyMode(mode)}
              </label>
            ))}
          </div>
        </SettingField>
        <SettingField label="Tags">
          <input
            value={mutation.note.tags.map(friendlyIdentifier).join(", ")}
            onChange={(event) => setNote({ tags: normalizeTagsInput(event.target.value) })}
            className={compactInputClassName}
          />
        </SettingField>
        <SettingField label={friendlySectionKey(sectionKey)}>
          <textarea
            value={section.text}
            onChange={(event) =>
              setNote({
                sections: {
                  ...mutation.note.sections,
                  [sectionKey]: { ...section, text: event.target.value, updatedAt: new Date().toISOString() },
                },
              })
            }
            className={textareaClassName}
          />
        </SettingField>
      </div>
    );
  }

  if (mutation.kind === "append_section") {
    return (
      <div className="grid gap-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <SettingField label="Target memory">
            <input value={friendlyIdentifier(mutation.noteId)} readOnly className={compactInputClassName} />
          </SettingField>
          <SettingField label="Section">
            <input
              value={friendlySectionKey(mutation.sectionKey)}
              onChange={(event) =>
                onChange({ ...mutation, sectionKey: normalizeIdentifier(event.target.value, "section") })
              }
              className={compactInputClassName}
            />
          </SettingField>
        </div>
        <SettingField label="Proposed text">
          <textarea
            value={mutation.text}
            onChange={(event) => onChange({ ...mutation, text: event.target.value })}
            className={textareaClassName}
          />
        </SettingField>
      </div>
    );
  }

  if (mutation.kind === "update_section") {
    return (
      <div className="grid gap-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <SettingField label="Target memory">
            <input value={friendlyIdentifier(mutation.noteId)} readOnly className={compactInputClassName} />
          </SettingField>
          <SettingField label="Section">
            <input value={friendlySectionKey(mutation.sectionKey)} readOnly className={compactInputClassName} />
          </SettingField>
        </div>
        <SettingField label="Proposed text">
          <textarea
            value={mutation.section.text}
            onChange={(event) =>
              onChange({
                ...mutation,
                section: { ...mutation.section, text: event.target.value, updatedAt: new Date().toISOString() },
              })
            }
            className={textareaClassName}
          />
        </SettingField>
      </div>
    );
  }

  if (mutation.kind === "add_link") {
    const targetNote = noteLookup.get(mutation.link.target);
    const targetLabel = targetNote ? friendlyNoteTitle(targetNote) : friendlyIdentifier(mutation.link.target);
    const sourceNote = noteLookup.get(mutation.noteId);
    const sourceLabel = sourceNote ? friendlyNoteTitle(sourceNote) : friendlyIdentifier(mutation.noteId);

    return (
      <div className="grid gap-2 sm:grid-cols-3">
        <SettingField label="Target memory">
          <input value={sourceLabel} readOnly className={compactInputClassName} title={mutation.noteId} />
        </SettingField>
        <SettingField label="Relation">
          <input
            value={friendlyIdentifier(mutation.link.relation)}
            onChange={(event) =>
              onChange({ ...mutation, link: { ...mutation.link, relation: normalizeIdentifier(event.target.value, "relation") } })
            }
            className={compactInputClassName}
          />
        </SettingField>
        <SettingField label="Related memory">
          <input
            value={targetLabel}
            onChange={(event) =>
              onChange({ ...mutation, link: { ...mutation.link, target: normalizeIdentifier(event.target.value, "note") } })
            }
            className={compactInputClassName}
            title={mutation.link.target}
          />
        </SettingField>
      </div>
    );
  }

  if (mutation.kind === "set_status") {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <SettingField label="Target memory">
          <input value={friendlyIdentifier(mutation.noteId)} readOnly className={compactInputClassName} />
        </SettingField>
        <SettingField label="Status">
          <select
            value={mutation.status}
            onChange={(event) => onChange({ ...mutation, status: event.target.value as LtmNote["status"] })}
            className={compactInputClassName}
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {friendlyStatus(status)}
              </option>
            ))}
          </select>
        </SettingField>
      </div>
    );
  }

  return (
    <div className="p-3 text-xs text-[var(--foreground)]/60">
      This mutation kind is not editable.
    </div>
  );
}
