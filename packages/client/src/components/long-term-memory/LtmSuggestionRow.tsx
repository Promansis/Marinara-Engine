import { useState } from "react";
import { Check, Save, X } from "lucide-react";
import type { LtmDraftMutation, LtmExtractionDraft, LtmNote } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import {
  actionRowClassName,
  insetSectionCardClassName,
  selectedListRowClassName,
} from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";
import { compactMutationText, mutationTargetTitle, suggestionRowKey } from "./ltm-panel-shared";

export type SuggestionRowModel = {
  draft: LtmExtractionDraft;
  mutation: LtmDraftMutation;
};

export function mutationKindLabel(kind: LtmDraftMutation["kind"]) {
  switch (kind) {
    case "create_note":
      return "New";
    case "append_section":
      return "Add to existing";
    case "update_section":
      return "Update existing";
    case "add_link":
      return "Link";
    case "set_keywords":
      return "Keywords";
    case "set_status":
      return "Status";
  }
}

export function mutationRiskLabel(risk: LtmDraftMutation["risk"]) {
  if (risk === "low") return "Low risk";
  if (risk === "medium") return "Check first";
  return "Major change";
}

export function mutationRiskTone(risk: LtmDraftMutation["risk"]) {
  if (risk === "low") return "good";
  if (risk === "medium") return "warn";
  return "bad";
}

function draftStatusLabel(statusId: LtmExtractionDraft["status"]) {
  if (statusId === "pending") return "Needs review";
  if (statusId === "accepted") return "Kept";
  return "Kept automatically";
}

function referenceLabel(count: number) {
  return `${count} reference${count === 1 ? "" : "s"}`;
}

export function suggestionRowKeyFor(row: SuggestionRowModel) {
  return suggestionRowKey(row.draft.id, row.mutation.id);
}

export function SuggestionRow({
  row,
  noteLookup,
  selectMode,
  selected,
  editedMutation,
  busy,
  onSelect,
  onMutationEdited,
  onKeep,
  onSkip,
}: {
  row: SuggestionRowModel;
  noteLookup: Map<string, LtmNote>;
  selectMode: boolean;
  selected: boolean;
  editedMutation?: LtmDraftMutation;
  busy: boolean;
  onSelect: (selected: boolean) => void;
  onMutationEdited: (mutation: LtmDraftMutation) => void;
  onKeep: () => void;
  onSkip: () => void;
}) {
  const { draft, mutation } = row;
  const [editing, setEditing] = useState(false);
  const [draftEdit, setDraftEdit] = useState<LtmDraftMutation | null>(null);
  const hasEdits = Boolean(editedMutation) && !editing;

  const openEditor = () => {
    setDraftEdit(editedMutation ?? mutation);
    setEditing(true);
  };

  const closeEditor = () => {
    setEditing(false);
    setDraftEdit(null);
  };

  return (
    <article
      className={cn(
        "rounded-xl bg-[var(--card)] p-3 ring-1 ring-[var(--border)]",
        selectMode && selected && selectedListRowClassName,
      )}
    >
      <div className={cn("grid gap-3", selectMode && "grid-cols-[auto_minmax(0,1fr)]")}>
        {selectMode ? (
          <label className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--background)]/55 ring-1 ring-[var(--border)]">
            <input
              type="checkbox"
              checked={selected}
              disabled={busy}
              onChange={(event) => onSelect(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
              aria-label={`Select ${mutationTargetTitle(mutation)}`}
            />
          </label>
        ) : null}
        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusPill label={mutationKindLabel(mutation.kind)} />
                <StatusPill label={mutationRiskLabel(mutation.risk)} tone={mutationRiskTone(mutation.risk)} />
                <StatusPill label="AI confident" title={`AI is ${Math.round(mutation.confidence * 100)}% confident`} />
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
              <ToolButton onClick={editing ? closeEditor : openEditor} disabled={busy}>
                <Save size="0.875rem" />
                {editing ? "Cancel edit" : hasEdits ? "Edit again" : "Edit"}
              </ToolButton>
              <ToolButton onClick={onKeep} disabled={busy} tone="primary">
                <Check size="0.875rem" />
                Keep
              </ToolButton>
              <ToolButton onClick={onSkip} disabled={busy}>
                <X size="0.875rem" />
                Skip
              </ToolButton>
            </div>
          </div>
          {editing && draftEdit ? (
            <SuggestionMutationEditor
              mutation={draftEdit}
              onSave={(saved) => {
                onMutationEdited(saved);
                closeEditor();
              }}
              onCancel={closeEditor}
            />
          ) : null}
        </div>
      </div>
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
      ? (Object.values(mutation.note.sections)[0]?.text ?? "")
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
