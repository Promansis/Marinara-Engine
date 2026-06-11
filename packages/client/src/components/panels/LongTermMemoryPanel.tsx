import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  BrainCircuit,
  Check,
  Eye,
  EyeOff,
  FileJson,
  Hammer,
  History,
  Import,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type {
  LtmDraftMutation,
  LtmExtractionDraft,
  LtmLink,
  LtmNote,
  LtmNoteType,
  LtmStatus,
} from "@marinara-engine/shared";
import {
  useAcceptLongTermMemoryDraft,
  useArchiveLongTermMemoryNote,
  useDeleteLongTermMemoryNote,
  useExtractLongTermMemorySourceNote,
  useImportLongTermMemorySourceNotes,
  useDeleteLongTermMemoryDraft,
  useLongTermMemoryDrafts,
  useLongTermMemoryImportPreview,
  useLongTermMemoryIntegrity,
  useLongTermMemoryNote,
  useLongTermMemoryNotes,
  useLongTermMemoryStatus,
  useRebuildLongTermMemory,
  useRejectLongTermMemoryDraft,
  useRepairLongTermMemory,
  useReplayLongTermMemory,
  useUpdateLongTermMemoryDraft,
  useUpdateLongTermMemoryNote,
  type LtmExtractionDiagnostic,
  type UpdateLongTermMemoryDraftInput,
  type LtmInteropSource,
} from "../../hooks/use-long-term-memory";
import { useChatStore } from "../../stores/chat.store";
import { useChat, useUpdateChatMetadata } from "../../hooks/use-chats";
import { cn } from "../../lib/utils";
import {
  CreateLongTermMemoryNoteForm,
  type CreateLongTermMemoryNoteDraft,
} from "../long-term-memory/CreateLongTermMemoryNoteForm";
import { LongTermMemoryDebugLogModal } from "../long-term-memory/LongTermMemoryDebugLogModal";
import { LongTermMemoryExtractionSettingsModal } from "../long-term-memory/LongTermMemoryExtractionSettingsModal";
import { LongTermMemoryNoteEditor } from "../long-term-memory/LongTermMemoryNoteEditor";
import {
  friendlyIdentifier,
  friendlyMode,
  friendlyNoteTitle,
  friendlyNoteType,
  friendlySectionKey,
  friendlyStatus,
  sentenceCaseIdentifier,
} from "../long-term-memory/ltm-editor-utils";
import { SettingField } from "../long-term-memory/LtmFields";
import { StatusPill, ToolButton } from "../long-term-memory/LtmPills";
import { Modal } from "../ui/Modal";

const NOTE_TYPES: Array<"all" | LtmNoteType> = [
  "all",
  "character",
  "relationship",
  "scene",
  "thread",
  "callback",
  "world",
  "voice",
  "tone",
];
const NOTE_STATUSES: Array<"all" | Exclude<LtmStatus, "archived">> = ["all", "active", "dormant", "resolved"];
const NOTE_TYPE_ORDER = new Map<LtmNoteType, number>(
  NOTE_TYPES.filter((type) => type !== "all").map((type, index) => [type, index]),
);
const NOTE_STATUS_ORDER = new Map<LtmStatus, number>(
  ["active", "dormant", "resolved", "archived"].map((status, index) => [status as LtmStatus, index]),
);
const IMPORT_SOURCES: Array<{ id: LtmInteropSource; label: string }> = [
  { id: "chats", label: "Chat summaries" },
  { id: "characters", label: "Characters" },
  { id: "lorebooks", label: "Lorebooks" },
];

const TAB_LABELS: Record<TabId, string> = {
  notes: "Memories",
  drafts: "Drafts",
  tools: "Tools",
  import: "Import",
};

type TabId = "notes" | "drafts" | "tools" | "import";
type ImportPreviewRow = NonNullable<ReturnType<typeof useLongTermMemoryImportPreview>["data"]>["samples"][number];

const rowActionPillClassName =
  "absolute right-2 top-1/2 flex shrink-0 -translate-y-1/2 items-center gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 max-md:opacity-100";

const rowActionButtonClassName =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-all hover:bg-[var(--accent)] hover:text-[var(--foreground)] active:scale-90 disabled:cursor-not-allowed disabled:opacity-45";

const hiddenImportRowCache = new Set<string>();

function importRowKey(source: LtmInteropSource, sourceId: string) {
  return `${source}:${sourceId}`;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
        "flex items-center gap-2.5 rounded-lg p-1 transition-colors hover:bg-[var(--secondary)]/50",
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
      <span className="min-w-0 flex-1 text-xs text-[var(--foreground)]">{label}</span>
    </label>
  );
}

function normalizeScopeIdentifier(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!normalized) return "";
  return /^[a-z]/.test(normalized) ? normalized : `scope_${normalized}`;
}

function readScopeValue(metadata: Record<string, unknown>, key: "universe" | "rpId") {
  const scope = metadata.longTermMemoryScope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return "";
  const value = (scope as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="px-1 text-[0.6875rem] font-semibold uppercase text-[var(--muted-foreground)]">
        {title}
      </h3>
      {children}
    </section>
  );
}

function NoteRow({
  note,
  viewing,
  editing,
  onView,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
  bulkSelected,
  onSelect,
}: {
  note: LtmNote;
  viewing: boolean;
  editing: boolean;
  onView: () => void;
  onEdit: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  bulkSelected?: boolean;
  onSelect?: (selected: boolean) => void;
}) {
  const sectionCount = Object.keys(note.sections).length;
  const primaryText =
    note.sections.summary?.text.trim() ||
    note.sections.core?.text.trim() ||
    Object.values(note.sections)[0]?.text.trim() ||
    "";
  return (
    <article
      className={cn(
        "group relative rounded-lg bg-[var(--secondary)]/45 p-2.5 ring-1 ring-[var(--border)] transition-colors",
        "hover:bg-[var(--accent)]/45 hover:ring-rose-300/25",
        (editing || bulkSelected) && "bg-rose-300/10 ring-rose-300/35",
      )}
    >
      {onSelect && (
        <label className="absolute left-2 top-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--background)]/55 ring-1 ring-[var(--border)]">
          <input
            type="checkbox"
            checked={bulkSelected ?? false}
            onChange={(event) => onSelect(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
            aria-label={`Select ${friendlyNoteTitle(note)}`}
          />
        </label>
      )}
      <div
        className={cn(
          "min-w-0 transition-[padding] group-hover:pr-28 max-md:pr-28",
          onDelete && "group-hover:pr-36 max-md:pr-36",
          onSelect && "pl-10",
        )}
      >
        <div className="truncate text-xs font-semibold text-[var(--foreground)]" title={friendlyNoteTitle(note)}>
          {friendlyNoteTitle(note)}
        </div>
        {primaryText && (
          <div className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
            {primaryText}
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-1.5">
          <StatusPill label={friendlyNoteType(note.type)} />
          <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
          {sectionCount > 1 && <StatusPill label={`${sectionCount} details`} />}
        </div>
      </div>
      <div className={rowActionPillClassName}>
        <button
          type="button"
          onClick={onView}
          className={cn(rowActionButtonClassName, viewing && "bg-[var(--accent)] text-[var(--foreground)]")}
          aria-label={`View ${friendlyNoteTitle(note)}`}
          title="View memory"
        >
          <Eye size="0.875rem" />
        </button>
        {onRestore ? (
          <button
            type="button"
            onClick={onRestore}
            className={cn(rowActionButtonClassName, "hover:bg-emerald-500/10 hover:text-emerald-200")}
            aria-label={`Restore ${friendlyNoteTitle(note)}`}
            title="Restore memory"
          >
            <RotateCcw size="0.875rem" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onArchive}
            disabled={note.status === "archived"}
            className={cn(rowActionButtonClassName, "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]")}
            aria-label={`Archive ${friendlyNoteTitle(note)}`}
            title="Archive memory"
          >
            <Archive size="0.875rem" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className={cn(rowActionButtonClassName, "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]")}
            aria-label={`Delete ${friendlyNoteTitle(note)}`}
            title="Delete memory"
          >
            <Trash2 size="0.875rem" />
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className={cn(rowActionButtonClassName, editing && "bg-[var(--accent)] text-[var(--foreground)]")}
          aria-label={`Edit ${friendlyNoteTitle(note)}`}
          title="Edit memory"
        >
          <Pencil size="0.875rem" />
        </button>
      </div>
      {note.tags.length > 0 && (
        <div className="mt-2 truncate text-[0.625rem] text-[var(--muted-foreground)]" title={note.id}>
          {note.tags.map(friendlyIdentifier).join(", ")}
        </div>
      )}
    </article>
  );
}

function compactScope(note: LtmNote) {
  const scopeEntries = Object.entries(note.scope).flatMap(([key, value]) => {
    if (Array.isArray(value)) return value.length ? [[key, value.join(", ")]] : [];
    return typeof value === "string" && value.trim() ? [[key, value]] : [];
  });
  return scopeEntries.length
    ? scopeEntries.map(([key, value]) => `${sentenceCaseIdentifier(key)}: ${friendlyIdentifier(value)}`).join(" · ")
    : "Available everywhere";
}

function mutationTarget(mutation: LtmDraftMutation) {
  if (mutation.kind === "create_note") return friendlyNoteTitle(mutation.note);
  if (mutation.kind === "add_link") {
    return `${friendlyIdentifier(mutation.noteId)} is related to ${friendlyIdentifier(mutation.link.target)}`;
  }
  return friendlyIdentifier(mutation.noteId);
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
    case "flag_conflict":
      return "Needs review";
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

function draftRiskSummary(draft: LtmExtractionDraft) {
  const riskRank: Record<LtmDraftMutation["risk"], number> = { low: 0, medium: 1, high: 2 };
  const highestRisk =
    draft.mutations.reduce<LtmDraftMutation["risk"] | null>((highest, mutation) => {
      if (!highest) return mutation.risk;
      return riskRank[mutation.risk] > riskRank[highest] ? mutation.risk : highest;
    }, null) ?? "medium";
  const averageConfidence =
    draft.mutations.length > 0
      ? draft.mutations.reduce((total, mutation) => total + mutation.confidence, 0) / draft.mutations.length
      : 0;
  const evidenceCount = new Set(draft.mutations.flatMap((mutation) => mutation.evidence)).size;
  return { highestRisk, averageConfidence, evidenceCount };
}

function isSourceSummaryNote(note: LtmNote) {
  return (
    note.type === "scene" && note.tags.some((tag) => tag.includes("source_summary") || tag.includes("chat_summary"))
  );
}

function isDerivedFromSource(note: LtmNote, sourceNoteId: string) {
  return note.links.some((link) => link.relation === "extracted_from" && link.target === sourceNoteId);
}

function derivedSourceGroups(notes: LtmNote[]) {
  const groups = new Map<string, { type: LtmNoteType; status: LtmStatus; notes: LtmNote[] }>();
  for (const note of notes) {
    const key = `${note.type}:${note.status}`;
    const group = groups.get(key) ?? { type: note.type, status: note.status, notes: [] };
    group.notes.push(note);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      notes: group.notes.sort((left, right) => friendlyNoteTitle(left).localeCompare(friendlyNoteTitle(right))),
    }))
    .sort(
      (left, right) =>
        (NOTE_TYPE_ORDER.get(left.type) ?? Number.MAX_SAFE_INTEGER) -
          (NOTE_TYPE_ORDER.get(right.type) ?? Number.MAX_SAFE_INTEGER) ||
        (NOTE_STATUS_ORDER.get(left.status) ?? Number.MAX_SAFE_INTEGER) -
          (NOTE_STATUS_ORDER.get(right.status) ?? Number.MAX_SAFE_INTEGER) ||
        friendlyNoteType(left.type).localeCompare(friendlyNoteType(right.type)),
    );
}

function mutationText(mutation: LtmDraftMutation) {
  switch (mutation.kind) {
    case "create_note":
      return Object.entries(mutation.note.sections)
        .map(([key, section]) => `${friendlySectionKey(key)}: ${section.text}`)
        .join("\n\n");
    case "append_section":
      return `${friendlySectionKey(mutation.sectionKey)}: ${mutation.text}`;
    case "update_section":
      return `${friendlySectionKey(mutation.sectionKey)}: ${mutation.section.text}`;
    case "add_link":
      return `${friendlyIdentifier(mutation.noteId)} ${friendlyIdentifier(mutation.link.relation).toLowerCase()} ${friendlyIdentifier(
        mutation.link.target,
      )}`;
    case "set_status":
      return `Mark ${friendlyIdentifier(mutation.noteId)} as ${friendlyStatus(mutation.status).toLowerCase()}`;
    case "flag_conflict":
      return `${mutation.conflict.field}\nExisting: ${mutation.conflict.existing}\nProposed: ${mutation.conflict.proposed}`;
  }
}

function MutationPreview({ mutation }: { mutation: LtmDraftMutation }) {
  return (
    <article className="rounded-lg bg-[var(--secondary)]/45 p-3 ring-1 ring-[var(--border)]">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill label={mutationKindLabel(mutation.kind)} />
          <StatusPill label={mutationRiskLabel(mutation.risk)} tone={mutationRiskTone(mutation.risk)} />
        </div>
        <div className="flex flex-wrap gap-1.5 sm:justify-end">
          <StatusPill label={`Risk ${mutationRiskLabel(mutation.risk)}`} tone={mutationRiskTone(mutation.risk)} />
          <StatusPill label={`Confidence ${Math.round(mutation.confidence * 100)}%`} />
          <StatusPill label={`${mutation.evidence.length} evidence`} />
        </div>
      </div>
      <div className="mt-2 text-xs font-medium text-[var(--foreground)]">{mutation.summary}</div>
      <div className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">Applies to: {mutationTarget(mutation)}</div>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--background)] p-2 text-[0.6875rem] leading-relaxed text-[var(--foreground)] ring-1 ring-[var(--border)]">
        {mutationText(mutation)}
      </pre>
      {mutation.evidence.length > 0 && (
        <div className="mt-2 rounded-md bg-[var(--background)]/70 p-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
          <span className="font-medium text-[var(--foreground)]">Evidence:</span> {mutation.evidence.join(", ")}
        </div>
      )}
    </article>
  );
}

function SourceNoteReference({
  sourceNoteId,
  onOpenSourceNote,
}: {
  sourceNoteId?: string;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  if (!sourceNoteId) return null;
  if (onOpenSourceNote) {
    return (
      <button
        type="button"
        onClick={() => onOpenSourceNote(sourceNoteId)}
        className="min-w-0 truncate rounded-md bg-[var(--muted)]/40 px-1.5 py-0.5 text-left text-[0.625rem] font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
        title={`Open source memory ${sourceNoteId}`}
      >
        Source memory: {sourceNoteId}
      </button>
    );
  }
  return <StatusPill label={`Source memory ${sourceNoteId}`} />;
}

function DraftMetadataPills({
  draft,
  onOpenSourceNote,
}: {
  draft: LtmExtractionDraft;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  const { highestRisk, averageConfidence, evidenceCount } = draftRiskSummary(draft);
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      <StatusPill label={`Mutation risk ${mutationRiskLabel(highestRisk)}`} tone={mutationRiskTone(highestRisk)} />
      <StatusPill label={`Confidence ${Math.round(averageConfidence * 100)}%`} />
      <StatusPill label={`${evidenceCount} evidence`} />
      <SourceNoteReference sourceNoteId={draft.source.sourceNoteId} onOpenSourceNote={onOpenSourceNote} />
    </div>
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
            {diagnostic.mutationId && (
              <span className="text-[0.625rem] opacity-80">Mutation {diagnostic.mutationId}</span>
            )}
            {diagnostic.noteId && <span className="text-[0.625rem] opacity-80">Note {diagnostic.noteId}</span>}
          </div>
          <p className="mt-1 leading-relaxed opacity-90">{diagnostic.message}</p>
        </div>
      ))}
    </div>
  );
}

function GraphLinks({ links }: { links: LtmLink[] }) {
  if (links.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
        No related memories yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {links.map((link, index) => (
        <div
          key={`${link.relation}-${link.target}-${index}`}
          className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--secondary)]/45 px-3 py-2 text-xs ring-1 ring-[var(--border)]"
        >
          <span className="shrink-0 rounded-md bg-[var(--muted)]/50 px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
            {friendlyIdentifier(link.relation)}
          </span>
          <span className="min-w-0 truncate text-[var(--foreground)]">{friendlyIdentifier(link.target)}</span>
          <span className="truncate text-[0.625rem] text-[var(--muted-foreground)]">Internal ID: {link.target}</span>
        </div>
      ))}
    </div>
  );
}

function DerivedActiveMemories({
  sourceNote,
  activeNotes,
  loading,
  onOpenNote,
}: {
  sourceNote: LtmNote;
  activeNotes: LtmNote[];
  loading: boolean;
  onOpenNote?: (noteId: string) => void;
}) {
  const derivedNotes = useMemo(
    () =>
      activeNotes.filter(
        (candidate) =>
          candidate.id !== sourceNote.id &&
          candidate.status === "active" &&
          !isSourceSummaryNote(candidate) &&
          isDerivedFromSource(candidate, sourceNote.id),
      ),
    [activeNotes, sourceNote.id],
  );
  const groups = useMemo(() => derivedSourceGroups(derivedNotes), [derivedNotes]);
  const derivedCount = derivedNotes.length;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-[var(--foreground)]">Derived Active Memories</h3>
        <StatusPill
          label={`${derivedCount} active memor${derivedCount === 1 ? "y" : "ies"}`}
          tone={derivedCount ? "good" : "neutral"}
        />
      </div>
      {loading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
          <Loader2 className="mr-2 animate-spin" size="0.875rem" />
          Loading derived memories...
        </div>
      ) : groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
          No active typed memories link back to this source yet.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={`${group.type}:${group.status}`} className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5 px-1">
                <StatusPill label={friendlyNoteType(group.type)} />
                <StatusPill
                  label={friendlyStatus(group.status)}
                  tone={group.status === "active" ? "good" : "neutral"}
                />
                <StatusPill label={`${group.notes.length} memor${group.notes.length === 1 ? "y" : "ies"}`} />
              </div>
              <div className="space-y-2">
                {group.notes.map((derivedNote) => (
                  <button
                    key={derivedNote.id}
                    type="button"
                    onClick={() => onOpenNote?.(derivedNote.id)}
                    disabled={!onOpenNote}
                    className="w-full rounded-lg bg-[var(--card)] p-3 text-left ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:cursor-default disabled:hover:bg-[var(--card)]"
                  >
                    <div className="truncate text-xs font-medium text-[var(--foreground)]">
                      {friendlyNoteTitle(derivedNote)}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                      {derivedNote.sections.summary?.text.trim() ||
                        derivedNote.sections.core?.text.trim() ||
                        Object.values(derivedNote.sections)[0]?.text.trim() ||
                        "No summary text."}
                    </p>
                    <div className="mt-2 truncate text-[0.625rem] text-[var(--muted-foreground)]/80">
                      Internal ID: {derivedNote.id}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function NoteViewModalContent({
  note,
  activeNotes,
  activeNotesLoading,
  drafts,
  draftsLoading,
  diagnostics,
  onDiagnostics,
  onOpenSourceNote,
}: {
  note: LtmNote;
  activeNotes: LtmNote[];
  activeNotesLoading: boolean;
  drafts: LtmExtractionDraft[];
  draftsLoading: boolean;
  diagnostics: LtmExtractionDiagnostic[];
  onDiagnostics: (noteId: string, diagnostics: LtmExtractionDiagnostic[]) => void;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  const extractSourceNote = useExtractLongTermMemorySourceNote();
  const [includeExistingNotes, setIncludeExistingNotes] = useState(true);
  const [autoApplySafeChanges, setAutoApplySafeChanges] = useState(false);
  const isSourceNote = isSourceSummaryNote(note);
  const extractedDrafts = drafts.filter((draft) => draft.source.sourceNoteId === note.id);
  const extractedMutations = extractedDrafts.flatMap((draft) => draft.mutations);
  const extractedLinks = extractedMutations.flatMap((mutation) => {
    if (mutation.kind === "create_note") return mutation.note.links;
    if (mutation.kind === "add_link") return [mutation.link];
    return [];
  });

  return (
    <div className="grid gap-4">
      <div className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <StatusPill label={friendlyNoteType(note.type)} />
          <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
          {note.modes.map((mode) => (
            <StatusPill key={mode} label={friendlyMode(mode)} />
          ))}
        </div>
        <div className="mt-2 text-[0.625rem] text-[var(--muted-foreground)]">
          {compactScope(note)} · updated {new Date(note.updatedAt).toLocaleString()}
        </div>
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--foreground)]">Memory Details</h3>
        {Object.entries(note.sections).map(([key, section]) => (
          <article key={key} className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-[var(--foreground)]">{friendlySectionKey(key)}</span>
              {typeof section.salience === "number" && <StatusPill label={`Importance ${section.salience}`} />}
              {typeof section.confidence === "number" && <StatusPill label={`AI certainty ${section.confidence}`} />}
              {(section.gates ?? []).map((gate) => (
                <StatusPill key={gate} label={sentenceCaseIdentifier(gate)} tone="warn" />
              ))}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">{section.text}</p>
            {(section.evidence ?? []).length > 0 && (
              <div className="mt-2 text-[0.625rem] text-[var(--muted-foreground)]">
                Evidence: {section.evidence?.join(", ")}
              </div>
            )}
          </article>
        ))}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--foreground)]">Related Memories</h3>
        <GraphLinks links={note.links} />
      </section>

      {isSourceNote && (
        <DerivedActiveMemories
          sourceNote={note}
          activeNotes={activeNotes}
          loading={activeNotesLoading}
          onOpenNote={onOpenSourceNote}
        />
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-[var(--foreground)]">Suggestions From This Memory</h3>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={`${extractedMutations.length} suggested change${extractedMutations.length === 1 ? "" : "s"}`}
            />
            {isSourceNote && (
              <ToolButton
                onClick={() =>
                  extractSourceNote
                    .mutateAsync({
                      noteId: note.id,
                      includeExistingNotes,
                      applyLowRisk: autoApplySafeChanges,
                    })
                    .then((result) => {
                      onDiagnostics(note.id, result.diagnostics);
                      const count = result.draft?.mutations.length ?? 0;
                      const issueCount = result.diagnostics.length;
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
            )}
          </div>
        </div>
        {isSourceNote && (
          <div className="grid gap-2 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)] sm:grid-cols-2">
            <SettingToggle
              label="Include existing notes"
              checked={includeExistingNotes}
              disabled={extractSourceNote.isPending}
              onChange={setIncludeExistingNotes}
            />
            <SettingToggle
              label="Auto-apply safe changes"
              checked={autoApplySafeChanges}
              disabled={extractSourceNote.isPending}
              onChange={setAutoApplySafeChanges}
            />
          </div>
        )}
        <ExtractionDiagnosticsList diagnostics={diagnostics} />
        {draftsLoading ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
            <Loader2 className="mr-2 animate-spin" size="0.875rem" />
            Loading suggestions...
          </div>
        ) : extractedDrafts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
            No typed memories extracted yet.
          </p>
        ) : (
          <div className="space-y-3">
            {extractedDrafts.map((draft) => (
              <article key={draft.id} className="rounded-lg bg-[var(--card)] p-3 ring-1 ring-[var(--border)]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusPill label={draftStatusLabel(draft.status)} tone={draftStatusTone(draft.status)} />
                  <StatusPill
                    label={`${draft.mutations.length} suggested change${draft.mutations.length === 1 ? "" : "s"}`}
                  />
                  {draft.appliedMutationIds?.length ? (
                    <StatusPill label={`${draft.appliedMutationIds.length} kept`} tone="good" />
                  ) : null}
                </div>
                <DraftMetadataPills draft={draft} onOpenSourceNote={onOpenSourceNote} />
                {draft.summary && <p className="mt-2 text-xs text-[var(--foreground)]">{draft.summary}</p>}
                <div className="mt-3 space-y-2">
                  {draft.mutations.map((mutation) => (
                    <MutationPreview key={mutation.id} mutation={mutation} />
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
        {extractedLinks.length > 0 && (
          <div className="space-y-2">
            <div className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
              Related memories proposed by suggestions
            </div>
            <GraphLinks links={extractedLinks} />
          </div>
        )}
      </section>
    </div>
  );
}

function DraftRow({
  draft,
  selected,
  onView,
  onOpenSourceNote,
}: {
  draft: LtmExtractionDraft;
  selected: boolean;
  onView: () => void;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  const accept = useAcceptLongTermMemoryDraft();
  const reject = useRejectLongTermMemoryDraft();
  const pending = draft.status === "pending";

  return (
    <article
      className={cn(
        "group relative rounded-lg bg-[var(--secondary)]/45 p-2.5 ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]/45 hover:ring-rose-300/25",
        selected && "bg-rose-300/10 ring-rose-300/35",
      )}
    >
      <div className={cn("min-w-0", pending && "transition-[padding] group-hover:pr-32 max-md:pr-32")}>
        <div className="truncate text-xs font-semibold text-[var(--foreground)]" title={draft.summary || draft.id}>
          {draft.summary || draft.id}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <StatusPill label={draftStatusLabel(draft.status)} tone={draftStatusTone(draft.status)} />
          <StatusPill label={`${draft.mutations.length} suggested change${draft.mutations.length === 1 ? "" : "s"}`} />
        </div>
        <DraftMetadataPills draft={draft} onOpenSourceNote={onOpenSourceNote} />
      </div>
      {pending && (
        <div className={rowActionPillClassName}>
          <button
            type="button"
            onClick={onView}
            className={cn(rowActionButtonClassName, selected && "bg-[var(--accent)] text-[var(--foreground)]")}
            aria-label={`View suggestion ${draft.id}`}
            title="View suggestion"
          >
            <Eye size="0.875rem" />
          </button>
          <button
            type="button"
            onClick={() =>
              accept
                .mutateAsync({ id: draft.id })
                .then(() => toast.success("Suggestion kept"))
                .catch((err: Error) => toast.error(err.message))
            }
            disabled={accept.isPending}
            className={cn(
              rowActionButtonClassName,
              "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/85",
            )}
            aria-label={`Keep suggestion ${draft.id}`}
            title="Keep suggestion"
          >
            <Check size="0.875rem" />
          </button>
          <button
            type="button"
            onClick={() =>
              reject
                .mutateAsync({ id: draft.id, reason: "Rejected from memory panel" })
                .then(() => toast.success("Suggestion skipped"))
                .catch((err: Error) => toast.error(err.message))
            }
            disabled={reject.isPending}
            className={rowActionButtonClassName}
            aria-label={`Skip suggestion ${draft.id}`}
            title="Skip suggestion"
          >
            <X size="0.875rem" />
          </button>
        </div>
      )}
    </article>
  );
}

function draftStatusTone(statusId: LtmExtractionDraft["status"]) {
  if (statusId === "pending") return "warn";
  if (statusId === "accepted" || statusId === "auto_applied") return "good";
  return "neutral";
}

function draftStatusLabel(statusId: LtmExtractionDraft["status"]) {
  if (statusId === "pending") return "Needs review";
  if (statusId === "accepted") return "Kept";
  if (statusId === "auto_applied") return "Kept automatically";
  return "Skipped";
}

function DraftDetails({
  draft,
  onOpenSourceNote,
}: {
  draft: LtmExtractionDraft;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  const { highestRisk, averageConfidence, evidenceCount } = draftRiskSummary(draft);
  return (
    <div className="grid gap-4">
      <div className="space-y-3 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={draftStatusLabel(draft.status)} tone={draftStatusTone(draft.status)} />
          <StatusPill label={`${draft.mutations.length} suggested change${draft.mutations.length === 1 ? "" : "s"}`} />
          {draft.modes.map((mode) => (
            <StatusPill key={mode} label={friendlyMode(mode)} />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={`Risk ${mutationRiskLabel(highestRisk)}`} tone={mutationRiskTone(highestRisk)} />
          <StatusPill label={`Confidence ${Math.round(averageConfidence * 100)}%`} />
          <StatusPill label={`${evidenceCount} reference${evidenceCount === 1 ? "" : "s"}`} />
        </div>
        {draft.source.sourceNoteId && (
          <div className="mt-2">
            <SourceNoteReference sourceNoteId={draft.source.sourceNoteId} onOpenSourceNote={onOpenSourceNote} />
          </div>
        )}
        <div className="text-[0.625rem] text-[var(--muted-foreground)]">
          Created {new Date(draft.createdAt).toLocaleString()} · updated {new Date(draft.updatedAt).toLocaleString()}
        </div>
        {draft.rejectedReason && (
          <div className="mt-2 rounded-md bg-[var(--background)]/70 p-2 text-[0.6875rem] text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
            {draft.rejectedReason}
          </div>
        )}
      </div>

      {draft.summary && <p className="text-xs leading-relaxed text-[var(--foreground)]">{draft.summary}</p>}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--foreground)]">Suggested Changes</h3>
        {draft.mutations.map((mutation) => (
          <MutationPreview key={mutation.id} mutation={mutation} />
        ))}
      </section>
    </div>
  );
}

function DraftJsonEditor({
  draft,
  onSaved,
}: {
  draft: LtmExtractionDraft;
  onSaved?: (draft: LtmExtractionDraft) => void;
}) {
  const updateDraft = useUpdateLongTermMemoryDraft();
  const [text, setText] = useState(() => JSON.stringify(draft, null, 2));

  useEffect(() => {
    setText(JSON.stringify(draft, null, 2));
  }, [draft]);

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      toast.error(`Suggestion JSON is invalid: ${(err as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      toast.error("Suggestion JSON must be an object.");
      return;
    }
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...patch } = parsed as Record<string, unknown>;
    try {
      const saved = await updateDraft.mutateAsync({
        id: draft.id,
        patch: patch as UpdateLongTermMemoryDraftInput,
      });
      toast.success("Suggestion saved");
      onSaved?.(saved);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="grid gap-3">
      <p className="text-xs text-[var(--muted-foreground)]">
        Advanced: edit the raw suggestion payload before restoring or keeping it archived.
      </p>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        className="min-h-[24rem] w-full resize-y rounded-lg bg-[var(--background)] p-3 font-mono text-[0.6875rem] leading-relaxed text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] focus:ring-[var(--primary)]"
      />
      <div className="flex justify-end">
        <ToolButton onClick={save} disabled={updateDraft.isPending} tone="primary">
          {updateDraft.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Save size="0.875rem" />}
          Save Suggestion
        </ToolButton>
      </div>
    </div>
  );
}

function ArchivedDraftRow({
  draft,
  selected,
  bulkSelected,
  onView,
  onEdit,
  onRestore,
  onDelete,
  onSelect,
  onOpenSourceNote,
}: {
  draft: LtmExtractionDraft;
  selected: boolean;
  bulkSelected?: boolean;
  onView: () => void;
  onEdit: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onSelect?: (selected: boolean) => void;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  return (
    <article
      className={cn(
        "group relative rounded-xl border border-rose-300/15 bg-gradient-to-br from-rose-300/5 to-fuchsia-500/5 p-2.5 transition-all hover:border-rose-300/30 hover:bg-[var(--sidebar-accent)]",
        (selected || bulkSelected) && "border-rose-300/40 bg-rose-300/10 ring-1 ring-rose-300/25",
      )}
    >
      {onSelect && (
        <label className="absolute left-2 top-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--background)]/55 ring-1 ring-[var(--border)]">
          <input
            type="checkbox"
            checked={bulkSelected ?? false}
            onChange={(event) => onSelect(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
            aria-label={`Select suggestion ${draft.id}`}
          />
        </label>
      )}
      <div className={cn("min-w-0 transition-[padding] group-hover:pr-36 max-md:pr-36", onSelect && "pl-10")}>
        <div className="truncate text-xs font-semibold text-[var(--foreground)]" title={draft.summary || draft.id}>
          {draft.summary || draft.id}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <StatusPill label={draftStatusLabel(draft.status)} tone={draftStatusTone(draft.status)} />
          <StatusPill label={`${draft.mutations.length} suggested change${draft.mutations.length === 1 ? "" : "s"}`} />
        </div>
        <DraftMetadataPills draft={draft} onOpenSourceNote={onOpenSourceNote} />
        <div className="mt-1 truncate text-[0.625rem] text-[var(--muted-foreground)]/80">Internal ID: {draft.id}</div>
      </div>
      <div className={rowActionPillClassName}>
        <button
          type="button"
          onClick={onView}
          className={cn(rowActionButtonClassName, selected && "bg-[var(--accent)] text-[var(--foreground)]")}
          aria-label={`View suggestion ${draft.id}`}
          title="View suggestion"
        >
          <Eye size="0.875rem" />
        </button>
        <button
          type="button"
          onClick={onEdit}
          className={rowActionButtonClassName}
          aria-label={`Edit suggestion ${draft.id}`}
          title="Edit raw suggestion"
        >
          <Pencil size="0.875rem" />
        </button>
        <button
          type="button"
          onClick={onRestore}
          disabled={draft.status !== "rejected"}
          className={cn(rowActionButtonClassName, "hover:bg-emerald-500/10 hover:text-emerald-200")}
          aria-label={`Restore suggestion ${draft.id}`}
          title={draft.status === "rejected" ? "Restore suggestion" : "Kept suggestions cannot be restored"}
        >
          <RotateCcw size="0.875rem" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className={cn(rowActionButtonClassName, "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]")}
          aria-label={`Delete suggestion ${draft.id}`}
          title="Delete suggestion"
        >
          <Trash2 size="0.875rem" />
        </button>
      </div>
      <div className="mt-2 truncate text-[0.625rem] text-[var(--muted-foreground)]">
        Updated {new Date(draft.updatedAt).toLocaleString()}
      </div>
    </article>
  );
}

function ImportPreviewRowItem({
  sample,
  selected,
  disabled,
  importing,
  hidden,
  onSelect,
  onImport,
  onToggleHidden,
}: {
  sample: ImportPreviewRow;
  selected: boolean;
  disabled?: boolean;
  importing?: boolean;
  hidden?: boolean;
  onSelect: (selected: boolean) => void;
  onImport: () => void;
  onToggleHidden: () => void;
}) {
  return (
    <article
      className={cn(
        "group relative grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-lg bg-[var(--secondary)]/45 p-3 ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]/45",
        selected && "bg-rose-300/10 ring-rose-300/35",
      )}
    >
      <label className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--background)]/55 ring-1 ring-[var(--border)]">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.checked)}
          className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
          aria-label={`Select ${sample.title}`}
        />
      </label>
      <div className="min-w-0 self-center transition-[padding] group-hover:pr-20 max-md:pr-20">
        <div className="truncate text-xs font-medium text-[var(--foreground)]" title={sample.title}>
          {sample.title}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <StatusPill label={`${sample.mutationCount} suggested change${sample.mutationCount === 1 ? "" : "s"}`} />
        </div>
      </div>
      <div className={rowActionPillClassName}>
        <button
          type="button"
          onClick={onImport}
          disabled={disabled || importing}
          className={cn(
            rowActionButtonClassName,
            "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/85",
          )}
          aria-label={`Import ${sample.title}`}
          title="Import"
        >
          {importing ? <Loader2 size="0.875rem" className="animate-spin" /> : <Import size="0.875rem" />}
        </button>
        <button
          type="button"
          onClick={onToggleHidden}
          disabled={disabled}
          className={rowActionButtonClassName}
          aria-label={hidden ? `Show ${sample.title}` : `Hide ${sample.title}`}
          title={hidden ? "Show source" : "Hide source"}
        >
          {hidden ? <Eye size="0.875rem" /> : <EyeOff size="0.875rem" />}
        </button>
      </div>
    </article>
  );
}

function ChatMemorySettings({ onOpenExtractionSettings }: { onOpenExtractionSettings: () => void }) {
  const activeChatId = useChatStore((s) => s.activeChatId);
  const cachedActiveChat = useChatStore((s) => s.activeChat);
  const activeChatQuery = useChat(activeChatId);
  const activeChat = activeChatQuery.data ?? cachedActiveChat;
  const updateMeta = useUpdateChatMetadata();
  const metadata = useMemo(() => parseMetadata(activeChat?.metadata), [activeChat?.metadata]);
  const enabled = metadata.enableLongTermMemory === true;
  const debug = metadata.longTermMemoryDebug === true;
  const autoExtract = metadata.longTermMemoryAutoExtract === true;
  const autoApplyLowRisk = metadata.longTermMemoryAutoApplyLowRisk === true;
  const scopeUniverse = readScopeValue(metadata, "universe");
  const scopeRpId = readScopeValue(metadata, "rpId");
  const budgetValue =
    typeof metadata.longTermMemoryBudgetTokens === "number" && Number.isFinite(metadata.longTermMemoryBudgetTokens)
      ? Math.max(128, Math.min(16_384, Math.floor(metadata.longTermMemoryBudgetTokens)))
      : 2048;
  const [scopeDraft, setScopeDraft] = useState({
    universe: scopeUniverse,
    rpId: scopeRpId,
  });
  const [budgetDraft, setBudgetDraft] = useState(String(budgetValue));
  const sliderBudget = Number.isFinite(Number(budgetDraft))
    ? Math.max(128, Math.min(16_384, Math.floor(Number(budgetDraft))))
    : budgetValue;

  useEffect(() => {
    setScopeDraft({
      universe: scopeUniverse,
      rpId: scopeRpId,
    });
    setBudgetDraft(String(budgetValue));
  }, [activeChat?.id, budgetValue, scopeRpId, scopeUniverse]);

  const patch = (next: Record<string, unknown>) => {
    if (!activeChat) return Promise.resolve();
    return updateMeta
      .mutateAsync({ id: activeChat.id, ...next })
      .then(() => toast.success("Chat memory settings updated"))
      .catch((err: Error) => toast.error(err.message));
  };

  const commitScope = (draft = scopeDraft) => {
    const universe = normalizeScopeIdentifier(draft.universe);
    const rpId = normalizeScopeIdentifier(draft.rpId);
    setScopeDraft({ universe, rpId });
    if (universe === scopeUniverse && rpId === scopeRpId) {
      return Promise.resolve();
    }
    return patch({
      longTermMemoryScope: {
        ...(universe ? { universe } : {}),
        ...(rpId ? { rpId } : {}),
      },
    });
  };

  const commitBudget = (value: string) => {
    const numeric = Number(value);
    const next = Number.isFinite(numeric) ? Math.max(128, Math.min(16_384, Math.floor(numeric))) : 2048;
    setBudgetDraft(String(next));
    if (next === budgetValue) return Promise.resolve();
    return patch({ longTermMemoryBudgetTokens: next });
  };

  return (
    <div className="space-y-2">
      <ToolButton onClick={onOpenExtractionSettings}>
        <SlidersHorizontal size="0.875rem" />
        Extraction settings
      </ToolButton>

      {!activeChat && (
        <p className="text-xs text-[var(--muted-foreground)]">Open a chat to edit its long-term memory settings.</p>
      )}

      {activeChat && (
        <>
          <SettingToggle
            label="Use memory in prompts"
            checked={enabled}
            onChange={(checked) => patch({ enableLongTermMemory: checked })}
          />

          <div className="grid gap-3 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
            <div className="grid gap-3 sm:grid-cols-2">
              <SettingField label="Universe">
                <input
                  value={scopeDraft.universe}
                  onChange={(event) => setScopeDraft((current) => ({ ...current, universe: event.target.value }))}
                  onBlur={() => commitScope()}
                  placeholder="shared_realm"
                  className="w-full rounded-lg bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:ring-[var(--primary)]"
                />
              </SettingField>
              <SettingField label="Story line">
                <input
                  value={scopeDraft.rpId}
                  onChange={(event) => setScopeDraft((current) => ({ ...current, rpId: event.target.value }))}
                  onBlur={() => commitScope()}
                  placeholder="main_story"
                  className="w-full rounded-lg bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:ring-[var(--primary)]"
                />
              </SettingField>
            </div>

            <SettingField label="Memory space used in replies">
              <div className="grid grid-cols-[1fr_5.5rem] items-center gap-3">
                <input
                  type="range"
                  min={128}
                  max={16384}
                  step={128}
                  value={sliderBudget}
                  onChange={(event) => setBudgetDraft(event.target.value)}
                  onPointerUp={(event) => commitBudget((event.target as HTMLInputElement).value)}
                  onBlur={(event) => commitBudget(event.target.value)}
                  className="min-w-0 accent-[var(--primary)]"
                />
                <input
                  type="number"
                  min={128}
                  max={16384}
                  step={128}
                  value={budgetDraft}
                  onChange={(event) => setBudgetDraft(event.target.value)}
                  onBlur={(event) => commitBudget(event.target.value)}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs outline-none focus:border-[var(--primary)]"
                />
              </div>
            </SettingField>
          </div>

          <SettingToggle
            label="Debug retrieval logs"
            checked={debug}
            onChange={(checked) => patch({ longTermMemoryDebug: checked })}
          />
          <SettingToggle
            label="Create suggestions after replies"
            checked={autoExtract}
            onChange={(checked) =>
              patch({
                longTermMemoryAutoExtract: checked,
                ...(checked ? {} : { longTermMemoryAutoApplyLowRisk: false }),
              })
            }
          />
          <SettingToggle
            label="Auto-apply low-risk suggestions"
            checked={autoExtract && autoApplyLowRisk}
            disabled={!autoExtract}
            onChange={(checked) =>
              patch({
                longTermMemoryAutoExtract: true,
                longTermMemoryAutoApplyLowRisk: checked,
              })
            }
          />
        </>
      )}
    </div>
  );
}

export function LongTermMemoryPanel() {
  const [tab, setTab] = useState<TabId>("notes");
  const [noteType, setNoteType] = useState<"all" | LtmNoteType>("all");
  const [noteStatus, setNoteStatus] = useState<"all" | Exclude<LtmStatus, "archived">>("all");
  const [query, setQuery] = useState("");
  const [importSource, setImportSource] = useState<LtmInteropSource>("chats");
  const [importLimit, setImportLimit] = useState(25);
  const [hiddenImportRows, setHiddenImportRows] = useState<Set<string>>(() => new Set(hiddenImportRowCache));
  const [selectedImportRows, setSelectedImportRows] = useState<Set<string>>(() => new Set());
  const [showHiddenImportRows, setShowHiddenImportRows] = useState(false);
  const [activeImportIds, setActiveImportIds] = useState<Set<string>>(() => new Set());
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [debugLogOpen, setDebugLogOpen] = useState(false);
  const [extractionSettingsOpen, setExtractionSettingsOpen] = useState(false);
  const [archiveTab, setArchiveTab] = useState<"notes" | "drafts">("notes");
  const [selectedArchivedNoteIds, setSelectedArchivedNoteIds] = useState<Set<string>>(() => new Set());
  const [selectedArchivedDraftIds, setSelectedArchivedDraftIds] = useState<Set<string>>(() => new Set());
  const [creatingNote, setCreatingNote] = useState(false);
  const [createNoteDraft, setCreateNoteDraft] = useState<CreateLongTermMemoryNoteDraft | null>(null);
  const [createNoteDirty, setCreateNoteDirty] = useState(false);
  const [viewingNoteId, setViewingNoteId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editedNoteDirty, setEditedNoteDirty] = useState(false);
  const [viewingDraftId, setViewingDraftId] = useState<string | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [sourceExtractionDiagnostics, setSourceExtractionDiagnostics] = useState<
    Record<string, LtmExtractionDiagnostic[]>
  >({});

  const status = useLongTermMemoryStatus();
  const integrity = useLongTermMemoryIntegrity();
  const notes = useLongTermMemoryNotes({
    type: noteType === "all" ? undefined : noteType,
    status: noteStatus === "all" ? undefined : noteStatus,
  });
  const activeNotes = useLongTermMemoryNotes({ status: "active" }, { enabled: Boolean(viewingNoteId) });
  const archivedNotes = useLongTermMemoryNotes(
    { status: "archived" },
    { enabled: archiveOpen || Boolean(viewingNoteId) || Boolean(editingNoteId) },
  );
  const drafts = useLongTermMemoryDrafts({ status: "pending" });
  const allDrafts = useLongTermMemoryDrafts(
    {},
    { enabled: archiveOpen || Boolean(viewingNoteId) || Boolean(viewingDraftId) || Boolean(editingDraftId) },
  );
  const exactViewingNote = useLongTermMemoryNote(viewingNoteId ?? undefined);
  const importPreview = useLongTermMemoryImportPreview(importSource, importLimit);
  const rebuild = useRebuildLongTermMemory();
  const replay = useReplayLongTermMemory();
  const repair = useRepairLongTermMemory();
  const importSourceNotes = useImportLongTermMemorySourceNotes();
  const archiveNote = useArchiveLongTermMemoryNote();
  const deleteNote = useDeleteLongTermMemoryNote();
  const updateNote = useUpdateLongTermMemoryNote();
  const updateDraft = useUpdateLongTermMemoryDraft();
  const deleteDraft = useDeleteLongTermMemoryDraft();

  const filteredNotes = useMemo(() => {
    const list = (notes.data ?? []).filter((note) => note.status !== "archived");
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (note) =>
        note.id.toLowerCase().includes(needle) ||
        note.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
        Object.values(note.sections).some((section) => section.text.toLowerCase().includes(needle)),
    );
  }, [notes.data, query]);

  const filteredDrafts = drafts.data ?? [];
  const archivedDrafts = useMemo(
    () => (allDrafts.data ?? []).filter((draft) => draft.status !== "pending"),
    [allDrafts.data],
  );
  const archivedMemoryNotes = useMemo(() => archivedNotes.data ?? [], [archivedNotes.data]);
  const archivedNoteIds = useMemo(() => archivedMemoryNotes.map((note) => note.id), [archivedMemoryNotes]);
  const archivedDraftIds = useMemo(() => archivedDrafts.map((draft) => draft.id), [archivedDrafts]);
  const selectedArchivedNotes = useMemo(
    () => archivedMemoryNotes.filter((note) => selectedArchivedNoteIds.has(note.id)),
    [archivedMemoryNotes, selectedArchivedNoteIds],
  );
  const selectedArchivedDrafts = useMemo(
    () => archivedDrafts.filter((draft) => selectedArchivedDraftIds.has(draft.id)),
    [archivedDrafts, selectedArchivedDraftIds],
  );
  const allArchivedNotesSelected =
    archivedNoteIds.length > 0 && archivedNoteIds.every((id) => selectedArchivedNoteIds.has(id));
  const allArchivedDraftsSelected =
    archivedDraftIds.length > 0 && archivedDraftIds.every((id) => selectedArchivedDraftIds.has(id));
  const combinedDrafts = useMemo(() => {
    const byId = new Map<string, LtmExtractionDraft>();
    for (const draft of drafts.data ?? []) byId.set(draft.id, draft);
    for (const draft of allDrafts.data ?? []) byId.set(draft.id, draft);
    return [...byId.values()];
  }, [allDrafts.data, drafts.data]);
  const importRows = useMemo(() => importPreview.data?.samples ?? [], [importPreview.data?.samples]);
  const visibleImportRows = useMemo(
    () =>
      importRows.filter((sample) => {
        const key = importRowKey(importSource, sample.sourceId);
        return showHiddenImportRows ? hiddenImportRows.has(key) : !hiddenImportRows.has(key);
      }),
    [hiddenImportRows, importRows, importSource, showHiddenImportRows],
  );
  const selectedVisibleImportRows = useMemo(
    () => visibleImportRows.filter((sample) => selectedImportRows.has(importRowKey(importSource, sample.sourceId))),
    [importSource, selectedImportRows, visibleImportRows],
  );
  const hiddenImportRowCount = importRows.filter((sample) =>
    hiddenImportRows.has(importRowKey(importSource, sample.sourceId)),
  ).length;
  const allVisibleImportRowsSelected =
    visibleImportRows.length > 0 &&
    visibleImportRows.every((sample) => selectedImportRows.has(importRowKey(importSource, sample.sourceId)));
  const combinedNotes = useMemo(() => {
    const byId = new Map<string, LtmNote>();
    for (const note of notes.data ?? []) byId.set(note.id, note);
    for (const note of archivedNotes.data ?? []) byId.set(note.id, note);
    return [...byId.values()];
  }, [archivedNotes.data, notes.data]);
  const statusTone = integrity.data?.ok ? "good" : integrity.data ? "bad" : "neutral";
  const editingNote = useMemo(
    () => (editingNoteId ? (combinedNotes.find((note) => note.id === editingNoteId) ?? null) : null),
    [combinedNotes, editingNoteId],
  );
  const viewingNote = useMemo(
    () =>
      viewingNoteId
        ? (combinedNotes.find((note) => note.id === viewingNoteId) ??
          (exactViewingNote.data?.id === viewingNoteId ? exactViewingNote.data : null))
        : null,
    [combinedNotes, exactViewingNote.data, viewingNoteId],
  );
  const viewingDraft = useMemo(
    () => (viewingDraftId ? (combinedDrafts.find((draft) => draft.id === viewingDraftId) ?? null) : null),
    [combinedDrafts, viewingDraftId],
  );
  const editingDraft = useMemo(
    () => (editingDraftId ? (combinedDrafts.find((draft) => draft.id === editingDraftId) ?? null) : null),
    [combinedDrafts, editingDraftId],
  );
  const editedNoteFilteredOut = Boolean(editingNote && !filteredNotes.some((note) => note.id === editingNote.id));
  const editingNoteHiddenByFilters = Boolean(editedNoteFilteredOut && editingNote);

  const closeEditor = () => {
    setEditingNoteId(null);
    setEditedNoteDirty(false);
  };

  const closeViewer = () => {
    setViewingNoteId(null);
  };

  const closeDraftViewer = () => {
    setViewingDraftId(null);
  };

  const closeDraftEditor = () => {
    setEditingDraftId(null);
  };

  const closeCreateForm = () => {
    setCreatingNote(false);
    setCreateNoteDirty(false);
    setCreateNoteDraft(null);
  };

  const confirmDiscardCreate = () => !createNoteDirty || confirm("Discard unsaved memory draft?");

  const confirmDiscardEditor = () => !editedNoteDirty || confirm("Discard unsaved memory changes?");

  const setTabWithGuards = (nextTab: TabId) => {
    if (nextTab === tab) return;
    if (creatingNote && !confirmDiscardCreate()) return;
    if (editingNoteId && !confirmDiscardEditor()) return;
    if (creatingNote) closeCreateForm();
    if (editingNoteId) closeEditor();
    if (viewingNoteId) closeViewer();
    if (viewingDraftId) closeDraftViewer();
    if (editingDraftId) closeDraftEditor();
    setTab(nextTab);
  };

  const requestViewNote = (id: string) => {
    if (viewingNoteId === id) {
      closeViewer();
      return;
    }
    setViewingNoteId(id);
  };

  const requestViewDraft = (id: string) => {
    if (viewingDraftId === id) {
      closeDraftViewer();
      return;
    }
    setViewingNoteId(null);
    setEditingDraftId(null);
    setViewingDraftId(id);
  };

  const openSourceNote = (id: string) => {
    if (editingNoteId && !confirmDiscardEditor()) return;
    setArchiveOpen(false);
    setViewingDraftId(null);
    setEditingDraftId(null);
    setEditingNoteId(null);
    setEditedNoteDirty(false);
    setViewingNoteId(id);
  };

  const storeSourceDiagnostics = (noteId: string, diagnostics: LtmExtractionDiagnostic[]) => {
    setSourceExtractionDiagnostics((current) => ({ ...current, [noteId]: diagnostics }));
  };

  const requestEditNote = (id: string) => {
    if (editingNoteId === id) {
      return;
    }
    if (creatingNote && !confirmDiscardCreate()) return;
    if (!confirmDiscardEditor()) return;
    closeCreateForm();
    closeViewer();
    closeDraftViewer();
    closeDraftEditor();
    setEditingNoteId(id);
    setEditedNoteDirty(false);
  };

  const requestCreateNote = () => {
    if (creatingNote) return;
    if (!confirmDiscardEditor()) return;
    setEditingNoteId(null);
    setEditedNoteDirty(false);
    closeViewer();
    closeDraftViewer();
    closeDraftEditor();
    setCreatingNote(true);
  };

  const archiveFromRow = (note: LtmNote) => {
    if (!confirm(`Archive ${friendlyNoteTitle(note)}?`)) return;
    archiveNote
      .mutateAsync(note.id)
      .then((result) => {
        toast.success("Memory archived");
        if (editingNoteId === result.note.id) closeEditor();
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const restoreNote = (note: LtmNote) => {
    updateNote
      .mutateAsync({ id: note.id, patch: { status: "active" } })
      .then((saved) => {
        toast.success("Memory restored");
        setSelectedArchivedNoteIds((current) => {
          const next = new Set(current);
          next.delete(saved.id);
          return next;
        });
        setArchiveOpen(false);
        setViewingNoteId(null);
        setEditingNoteId(saved.id);
        setEditedNoteDirty(false);
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const deleteArchivedNote = (note: LtmNote) => {
    if (!confirm(`Delete ${friendlyNoteTitle(note)}? This cannot be undone.`)) return;
    deleteNote
      .mutateAsync(note.id)
      .then(() => {
        toast.success("Memory deleted");
        setSelectedArchivedNoteIds((current) => {
          const next = new Set(current);
          next.delete(note.id);
          return next;
        });
        if (viewingNoteId === note.id) closeViewer();
        if (editingNoteId === note.id) closeEditor();
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const setArchivedNotesSelected = (ids: string[], selected: boolean) => {
    setSelectedArchivedNoteIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const setArchivedDraftsSelected = (ids: string[], selected: boolean) => {
    setSelectedArchivedDraftIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const restoreSelectedArchivedNotes = async () => {
    if (selectedArchivedNotes.length === 0) return;
    try {
      await Promise.all(
        selectedArchivedNotes.map((note) => updateNote.mutateAsync({ id: note.id, patch: { status: "active" } })),
      );
      toast.success(
        `Restored ${selectedArchivedNotes.length} memor${selectedArchivedNotes.length === 1 ? "y" : "ies"}`,
      );
      setSelectedArchivedNoteIds(new Set());
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const deleteSelectedArchivedNotes = async () => {
    if (selectedArchivedNotes.length === 0) return;
    if (
      !confirm(
        `Delete ${selectedArchivedNotes.length} archived memor${
          selectedArchivedNotes.length === 1 ? "y" : "ies"
        }? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await Promise.all(selectedArchivedNotes.map((note) => deleteNote.mutateAsync(note.id)));
      toast.success(`Deleted ${selectedArchivedNotes.length} memor${selectedArchivedNotes.length === 1 ? "y" : "ies"}`);
      const deletedIds = new Set(selectedArchivedNotes.map((note) => note.id));
      setSelectedArchivedNoteIds(new Set());
      if (viewingNoteId && deletedIds.has(viewingNoteId)) closeViewer();
      if (editingNoteId && deletedIds.has(editingNoteId)) closeEditor();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const restoreDraft = (draft: LtmExtractionDraft) => {
    if (draft.status !== "rejected") return;
    updateDraft
      .mutateAsync({ id: draft.id, patch: { status: "pending" } })
      .then(() => {
        toast.success("Suggestion restored");
        setSelectedArchivedDraftIds((current) => {
          const next = new Set(current);
          next.delete(draft.id);
          return next;
        });
        setViewingDraftId(null);
        setEditingDraftId(null);
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const deleteArchivedDraft = (draft: LtmExtractionDraft) => {
    if (!confirm(`Delete suggestion ${draft.id}? This cannot be undone.`)) return;
    deleteDraft
      .mutateAsync(draft.id)
      .then(() => {
        toast.success("Suggestion deleted");
        setSelectedArchivedDraftIds((current) => {
          const next = new Set(current);
          next.delete(draft.id);
          return next;
        });
        if (viewingDraftId === draft.id) closeDraftViewer();
        if (editingDraftId === draft.id) closeDraftEditor();
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const restoreSelectedArchivedDrafts = async () => {
    const restorableDrafts = selectedArchivedDrafts.filter((draft) => draft.status === "rejected");
    if (restorableDrafts.length === 0) return;
    try {
      await Promise.all(
        restorableDrafts.map((draft) => updateDraft.mutateAsync({ id: draft.id, patch: { status: "pending" } })),
      );
      toast.success(`Restored ${restorableDrafts.length} suggestion${restorableDrafts.length === 1 ? "" : "s"}`);
      setSelectedArchivedDraftIds((current) => {
        const next = new Set(current);
        for (const draft of restorableDrafts) next.delete(draft.id);
        return next;
      });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const deleteSelectedArchivedDrafts = async () => {
    if (selectedArchivedDrafts.length === 0) return;
    if (
      !confirm(
        `Delete ${selectedArchivedDrafts.length} archived suggestion${
          selectedArchivedDrafts.length === 1 ? "" : "s"
        }? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await Promise.all(selectedArchivedDrafts.map((draft) => deleteDraft.mutateAsync(draft.id)));
      toast.success(
        `Deleted ${selectedArchivedDrafts.length} suggestion${selectedArchivedDrafts.length === 1 ? "" : "s"}`,
      );
      const deletedIds = new Set(selectedArchivedDrafts.map((draft) => draft.id));
      setSelectedArchivedDraftIds(new Set());
      if (viewingDraftId && deletedIds.has(viewingDraftId)) closeDraftViewer();
      if (editingDraftId && deletedIds.has(editingDraftId)) closeDraftEditor();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const setImportRowSelected = (sourceId: string, selected: boolean) => {
    const key = importRowKey(importSource, sourceId);
    setSelectedImportRows((current) => {
      const next = new Set(current);
      if (selected) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const setAllVisibleImportRowsSelected = (selected: boolean) => {
    setSelectedImportRows((current) => {
      const next = new Set(current);
      for (const row of visibleImportRows) {
        const key = importRowKey(importSource, row.sourceId);
        if (selected) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const updateHiddenImportRows = (updater: (current: Set<string>) => Set<string>) => {
    setHiddenImportRows((current) => {
      const next = updater(current);
      hiddenImportRowCache.clear();
      for (const key of next) hiddenImportRowCache.add(key);
      return next;
    });
  };

  const hideImportRows = (sourceIds: string[]) => {
    updateHiddenImportRows((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.add(importRowKey(importSource, sourceId));
      return next;
    });
    setSelectedImportRows((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
      return next;
    });
  };

  const unhideImportRows = (sourceIds: string[]) => {
    updateHiddenImportRows((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
      return next;
    });
    setSelectedImportRows((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
      return next;
    });
  };

  const restoreHiddenImportRows = () => {
    updateHiddenImportRows((current) => {
      const next = new Set(current);
      for (const row of importRows) next.delete(importRowKey(importSource, row.sourceId));
      return next;
    });
  };

  const importRowsToVault = async (sourceIds: string[]) => {
    if (sourceIds.length === 0) return;
    setActiveImportIds((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.add(importRowKey(importSource, sourceId));
      return next;
    });
    try {
      const result = await importSourceNotes.mutateAsync({
        source: importSource,
        sourceIds,
        limit: Math.max(importLimit, sourceIds.length),
      });
      const errorCount = result.imported.filter((item) =>
        item.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      ).length;
      const draftCount = result.imported.filter((item) => item.draft).length;
      const missingCount = result.missingSourceIds.length;
      if (errorCount || missingCount) {
        const firstError = result.imported
          .flatMap((item) => item.diagnostics)
          .find((diagnostic) => diagnostic.severity === "error");
        const issueDetails = [
          firstError?.message,
          missingCount ? `Missing: ${result.missingSourceIds.slice(0, 3).join(", ")}` : null,
        ].filter(Boolean);
        toast.error(
          `Imported ${result.imported.length} memory source(s), ${draftCount} suggestion(s), ${errorCount + missingCount} issue(s)${
            issueDetails.length ? `: ${issueDetails.join("; ")}` : ""
          }`,
        );
      } else {
        toast.success(`Imported ${result.imported.length} memory source(s), created ${draftCount} suggestion(s)`);
      }
      setSelectedImportRows((current) => {
        const next = new Set(current);
        for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
        return next;
      });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActiveImportIds((current) => {
        const next = new Set(current);
        for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
        return next;
      });
    }
  };

  return (
    <div className="flex min-h-full flex-col gap-3 p-3 text-[var(--foreground)]">
      <section className="space-y-2 border-b border-[var(--border)]/70 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight text-[var(--foreground)]">Story Memory</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <StatusPill label={`${status.data?.notes.total ?? 0} memories`} />
              <StatusPill label={`${status.data?.indexes.chunkCount ?? 0} search chunks`} />
              <StatusPill label={integrity.data?.ok ? "Healthy" : "Needs check"} tone={statusTone} />
              <StatusPill
                label={status.data?.indexes.embeddingsAvailable ? "Smart search" : "Basic search"}
                tone="neutral"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setArchiveOpen(true)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--secondary)] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
            aria-label="Open memory archive"
            title="Archive"
          >
            <Archive size="0.75rem" />
          </button>
          <button
            type="button"
            onClick={() => setDebugLogOpen(true)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--secondary)] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
            aria-label="Open memory debug log"
            title="Debug log"
          >
            <History size="0.75rem" />
          </button>
        </div>
      </section>

      <div className="sticky top-0 z-10 -mx-3 bg-[var(--background)]/95 px-3 py-2 backdrop-blur-sm">
        <div className="grid grid-cols-4 gap-1 rounded-lg bg-[var(--secondary)]/45 p-1 ring-1 ring-[var(--border)]/80">
          {(["notes", "drafts", "tools", "import"] as TabId[]).map((id) => (
            <button
              key={id}
              onClick={() => setTabWithGuards(id)}
              className={cn(
                "min-w-0 rounded-md px-2 py-1.5 text-xs font-medium transition-all active:scale-[0.98]",
                tab === id
                  ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm ring-1 ring-rose-300/25"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
              )}
            >
              {TAB_LABELS[id]}
            </button>
          ))}
        </div>
      </div>

      {tab === "notes" && (
        <Section title="Memories">
          <div className="mb-3 grid grid-cols-[1fr_auto] gap-2">
            <div className="flex items-center gap-2 rounded-xl bg-[var(--secondary)] px-3 py-2 ring-1 ring-[var(--border)] transition-shadow focus-within:ring-[var(--ring)]">
              <Search size="0.875rem" className="text-[var(--muted-foreground)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search memories"
                className="min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]/60"
              />
            </div>
            <ToolButton onClick={requestCreateNote} disabled={creatingNote}>
              <Plus size="0.875rem" />
              New
            </ToolButton>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <select
              value={noteType}
              onChange={(event) => setNoteType(event.target.value as "all" | LtmNoteType)}
              className="rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
            >
              {NOTE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type === "all" ? "All types" : friendlyNoteType(type)}
                </option>
              ))}
            </select>
            <select
              value={noteStatus}
              onChange={(event) => setNoteStatus(event.target.value as "all" | Exclude<LtmStatus, "archived">)}
              className="rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
            >
              {NOTE_STATUSES.map((statusId) => (
                <option key={statusId} value={statusId}>
                  {statusId === "all" ? "Any status" : friendlyStatus(statusId)}
                </option>
              ))}
            </select>
          </div>
          {editingNoteHiddenByFilters && (
            <div className="mb-3 rounded-lg bg-amber-500/10 p-3 ring-1 ring-amber-400/30">
              <div className="text-xs font-medium text-amber-100">Open note is hidden by filters</div>
              <p className="mt-1 text-[0.6875rem] text-amber-100/80">
                The editor stays open so unsaved edits are not lost.
              </p>
            </div>
          )}
          <div className="space-y-2">
            {notes.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
            {!notes.isLoading && filteredNotes.length === 0 && (
              <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                No matching memories.
              </p>
            )}
            {filteredNotes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                viewing={viewingNoteId === note.id}
                editing={editingNoteId === note.id}
                onView={() => requestViewNote(note.id)}
                onEdit={() => requestEditNote(note.id)}
                onArchive={() => archiveFromRow(note)}
              />
            ))}
          </div>
        </Section>
      )}

      {tab === "drafts" && (
        <Section title="Drafts">
          <div className="space-y-2">
            {filteredDrafts.length === 0 && (
              <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                No suggestions need review.
              </p>
            )}
            {filteredDrafts.map((draft) => (
              <DraftRow
                key={draft.id}
                draft={draft}
                selected={viewingDraftId === draft.id}
                onView={() => requestViewDraft(draft.id)}
                onOpenSourceNote={openSourceNote}
              />
            ))}
          </div>
        </Section>
      )}

      {tab === "tools" && (
        <>
          <Section title="Chat Settings">
            <ChatMemorySettings onOpenExtractionSettings={() => setExtractionSettingsOpen(true)} />
          </Section>
          <Section title="Tools">
            <div className="space-y-2">
              <ToolButton
                onClick={() =>
                  rebuild
                    .mutateAsync()
                    .then(() => toast.success("Memory search refreshed"))
                    .catch((err: Error) => toast.error(err.message))
                }
                disabled={rebuild.isPending}
                tone="primary"
              >
                <RefreshCw size="0.875rem" />
                Refresh Memory Search
              </ToolButton>
              <ToolButton
                onClick={() =>
                  replay
                    .mutateAsync()
                    .then((result) => toast(result.replayable ? "Memory history looks healthy" : result.messages[0]))
                    .catch((err: Error) => toast.error(err.message))
                }
                disabled={replay.isPending}
              >
                <History size="0.875rem" />
                Check Memory History
              </ToolButton>
              <ToolButton
                onClick={() =>
                  repair
                    .mutateAsync(["quarantine_malformed_notes", "rebuild_indexes"])
                    .then(() => toast.success("Repair actions finished"))
                    .catch((err: Error) => toast.error(err.message))
                }
                disabled={repair.isPending}
                tone="danger"
              >
                <Hammer size="0.875rem" />
                Repair Broken Memory Files
              </ToolButton>
            </div>
            <div className="mt-3 space-y-2">
              {(integrity.data?.issues ?? []).slice(0, 8).map((issue) => (
                <div
                  key={`${issue.code}-${issue.path ?? issue.noteId ?? issue.message}`}
                  className="rounded-lg bg-[var(--secondary)]/50 p-3 text-xs ring-1 ring-[var(--border)]"
                >
                  <div className="flex items-center gap-2 font-medium">
                    {issue.severity === "error" ? (
                      <AlertTriangle size="0.875rem" className="text-rose-300" />
                    ) : (
                      <ShieldCheck size="0.875rem" />
                    )}
                    {issue.code}
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">{issue.message}</p>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}

      {tab === "import" && (
        <Section title="Import">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <select
              value={importSource}
              onChange={(event) => setImportSource(event.target.value as LtmInteropSource)}
              className="rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
            >
              {IMPORT_SOURCES.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.id === "chats" ? "Chat summaries" : source.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={100}
              value={importLimit}
              onChange={(event) => setImportLimit(Number(event.target.value))}
              className="w-20 rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
            />
          </div>
          <div className="mt-3 rounded-lg bg-[var(--secondary)]/50 p-3 ring-1 ring-[var(--border)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-[var(--foreground)]">
                  {importPreview.data?.draftable ?? 0} source{importPreview.data?.draftable === 1 ? "" : "s"} ready
                </div>
              </div>
              {importPreview.isLoading ? <Loader2 className="animate-spin" size="1rem" /> : <FileJson size="1rem" />}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
            <label className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-xs text-[var(--foreground)]">
              <input
                type="checkbox"
                checked={allVisibleImportRowsSelected}
                disabled={visibleImportRows.length === 0}
                onChange={(event) => setAllVisibleImportRowsSelected(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
              />
              Select visible
            </label>
            <ToolButton
              onClick={() => importRowsToVault(selectedVisibleImportRows.map((row) => row.sourceId))}
              disabled={selectedVisibleImportRows.length === 0 || importSourceNotes.isPending}
              tone="primary"
            >
              {importSourceNotes.isPending ? (
                <Loader2 size="0.875rem" className="animate-spin" />
              ) : (
                <Import size="0.875rem" />
              )}
              Import selected
            </ToolButton>
            <ToolButton
              onClick={() =>
                showHiddenImportRows
                  ? unhideImportRows(selectedVisibleImportRows.map((row) => row.sourceId))
                  : hideImportRows(selectedVisibleImportRows.map((row) => row.sourceId))
              }
              disabled={selectedVisibleImportRows.length === 0}
            >
              {showHiddenImportRows ? <Eye size="0.875rem" /> : <EyeOff size="0.875rem" />}
              {showHiddenImportRows ? "Unhide selected" : "Hide selected"}
            </ToolButton>
            <button
              type="button"
              onClick={() => setShowHiddenImportRows((open) => !open)}
              disabled={!showHiddenImportRows && hiddenImportRowCount === 0}
              className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-3 py-2 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-all hover:bg-[var(--accent)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Eye size="0.875rem" />
              {showHiddenImportRows ? "Show active" : `Show hidden (${hiddenImportRowCount})`}
            </button>
            {showHiddenImportRows && hiddenImportRowCount > 0 && (
              <ToolButton onClick={restoreHiddenImportRows}>
                <RotateCcw size="0.875rem" />
                Restore hidden
              </ToolButton>
            )}
          </div>

          <div className="mt-3 space-y-2">
            {importPreview.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
            {!importPreview.isLoading && visibleImportRows.length === 0 && (
              <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                {hiddenImportRowCount > 0 ? "All sources are hidden." : "No sources are ready to bring in."}
              </p>
            )}
            {visibleImportRows.map((sample) => (
              <ImportPreviewRowItem
                key={sample.sourceId}
                sample={sample}
                selected={selectedImportRows.has(importRowKey(importSource, sample.sourceId))}
                disabled={importSourceNotes.isPending}
                importing={activeImportIds.has(importRowKey(importSource, sample.sourceId))}
                hidden={hiddenImportRows.has(importRowKey(importSource, sample.sourceId))}
                onSelect={(selected) => setImportRowSelected(sample.sourceId, selected)}
                onImport={() => importRowsToVault([sample.sourceId])}
                onToggleHidden={() =>
                  hiddenImportRows.has(importRowKey(importSource, sample.sourceId))
                    ? unhideImportRows([sample.sourceId])
                    : hideImportRows([sample.sourceId])
                }
              />
            ))}
          </div>
        </Section>
      )}

      <Modal
        open={archiveOpen}
        onClose={() => {
          if (editingNoteId && !confirmDiscardEditor()) return;
          setArchiveOpen(false);
          setViewingDraftId(null);
          setEditingDraftId(null);
        }}
        title="Archive"
        width="max-w-5xl"
      >
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--background)]/95 p-1">
            {(["notes", "drafts"] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setArchiveTab(id)}
                className={cn(
                  "rounded-lg px-2 py-1.5 text-xs font-medium transition-all active:scale-[0.98]",
                  archiveTab === id
                    ? "bg-rose-300/15 text-[var(--foreground)] ring-1 ring-rose-300/30"
                    : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                )}
              >
                {id === "notes" ? "Memories" : "Drafts"}
              </button>
            ))}
          </div>

          {archiveTab === "notes" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
                <label className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-xs text-[var(--foreground)]">
                  <input
                    type="checkbox"
                    checked={allArchivedNotesSelected}
                    disabled={archivedNoteIds.length === 0 || deleteNote.isPending || updateNote.isPending}
                    onChange={(event) => setArchivedNotesSelected(archivedNoteIds, event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                  />
                  Select visible
                </label>
                <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                  {selectedArchivedNotes.length} selected
                </span>
                <ToolButton
                  onClick={() => void restoreSelectedArchivedNotes()}
                  disabled={selectedArchivedNotes.length === 0 || updateNote.isPending || deleteNote.isPending}
                >
                  {updateNote.isPending ? (
                    <Loader2 size="0.875rem" className="animate-spin" />
                  ) : (
                    <RotateCcw size="0.875rem" />
                  )}
                  Restore selected
                </ToolButton>
                <ToolButton
                  onClick={() => void deleteSelectedArchivedNotes()}
                  disabled={selectedArchivedNotes.length === 0 || deleteNote.isPending}
                  tone="danger"
                >
                  {deleteNote.isPending ? (
                    <Loader2 size="0.875rem" className="animate-spin" />
                  ) : (
                    <Trash2 size="0.875rem" />
                  )}
                  Delete selected
                </ToolButton>
              </div>
              {archivedNotes.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
              {!archivedNotes.isLoading && archivedMemoryNotes.length === 0 && (
                <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                  No archived memories.
                </p>
              )}
              {archivedMemoryNotes.map((note) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  viewing={viewingNoteId === note.id}
                  editing={editingNoteId === note.id}
                  bulkSelected={selectedArchivedNoteIds.has(note.id)}
                  onSelect={(selected) => setArchivedNotesSelected([note.id], selected)}
                  onView={() => requestViewNote(note.id)}
                  onEdit={() => requestEditNote(note.id)}
                  onRestore={() => restoreNote(note)}
                  onDelete={() => deleteArchivedNote(note)}
                />
              ))}
            </div>
          )}

          {archiveTab === "drafts" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]">
                <label className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-xs text-[var(--foreground)]">
                  <input
                    type="checkbox"
                    checked={allArchivedDraftsSelected}
                    disabled={archivedDraftIds.length === 0 || deleteDraft.isPending || updateDraft.isPending}
                    onChange={(event) => setArchivedDraftsSelected(archivedDraftIds, event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                  />
                  Select visible
                </label>
                <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                  {selectedArchivedDrafts.length} selected
                </span>
                <ToolButton
                  onClick={() => void restoreSelectedArchivedDrafts()}
                  disabled={
                    selectedArchivedDrafts.every((draft) => draft.status !== "rejected") ||
                    updateDraft.isPending ||
                    deleteDraft.isPending
                  }
                >
                  {updateDraft.isPending ? (
                    <Loader2 size="0.875rem" className="animate-spin" />
                  ) : (
                    <RotateCcw size="0.875rem" />
                  )}
                  Restore selected
                </ToolButton>
                <ToolButton
                  onClick={() => void deleteSelectedArchivedDrafts()}
                  disabled={selectedArchivedDrafts.length === 0 || deleteDraft.isPending}
                  tone="danger"
                >
                  {deleteDraft.isPending ? (
                    <Loader2 size="0.875rem" className="animate-spin" />
                  ) : (
                    <Trash2 size="0.875rem" />
                  )}
                  Delete selected
                </ToolButton>
              </div>
              {allDrafts.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
              {!allDrafts.isLoading && archivedDrafts.length === 0 && (
                <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                  No archived suggestions.
                </p>
              )}
              {archivedDrafts.map((draft) => (
                <ArchivedDraftRow
                  key={draft.id}
                  draft={draft}
                  selected={viewingDraftId === draft.id || editingDraftId === draft.id}
                  bulkSelected={selectedArchivedDraftIds.has(draft.id)}
                  onSelect={(selected) => setArchivedDraftsSelected([draft.id], selected)}
                  onView={() => {
                    setEditingDraftId(null);
                    setViewingDraftId(draft.id);
                  }}
                  onEdit={() => {
                    setViewingDraftId(null);
                    setEditingDraftId(draft.id);
                  }}
                  onRestore={() => restoreDraft(draft)}
                  onDelete={() => deleteArchivedDraft(draft)}
                  onOpenSourceNote={openSourceNote}
                />
              ))}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={creatingNote}
        onClose={() => {
          if (!confirmDiscardCreate()) return;
          closeCreateForm();
        }}
        title="New Memory"
        width="max-w-3xl"
      >
        <CreateLongTermMemoryNoteForm
          initialDraft={createNoteDraft}
          onCancel={() => {
            if (!confirmDiscardCreate()) return;
            closeCreateForm();
          }}
          onDirtyChange={setCreateNoteDirty}
          onDraftChange={setCreateNoteDraft}
          onCreated={(note) => {
            closeCreateForm();
            setEditingNoteId(note.id);
            setEditedNoteDirty(false);
          }}
        />
      </Modal>

      <Modal
        open={Boolean(viewingNote)}
        onClose={closeViewer}
        title={viewingNote ? friendlyNoteTitle(viewingNote) : "View Memory"}
        width="max-w-4xl"
      >
        {viewingNote && (
          <NoteViewModalContent
            note={viewingNote}
            activeNotes={activeNotes.data ?? []}
            activeNotesLoading={activeNotes.isLoading}
            drafts={allDrafts.data ?? []}
            draftsLoading={allDrafts.isLoading}
            diagnostics={sourceExtractionDiagnostics[viewingNote.id] ?? []}
            onDiagnostics={storeSourceDiagnostics}
            onOpenSourceNote={openSourceNote}
          />
        )}
      </Modal>

      <Modal
        open={Boolean(editingNote)}
        onClose={() => {
          if (!confirmDiscardEditor()) return;
          closeEditor();
        }}
        title={editingNote ? `Edit ${friendlyNoteTitle(editingNote)}` : "Edit Memory"}
        width="max-w-4xl"
      >
        {editingNote && (
          <LongTermMemoryNoteEditor
            note={editingNote}
            onCancel={closeEditor}
            onDirtyChange={setEditedNoteDirty}
            onSaved={(saved) => {
              setEditedNoteDirty(false);
              setEditingNoteId(saved.id);
            }}
          />
        )}
      </Modal>

      <Modal
        open={Boolean(viewingDraft)}
        onClose={closeDraftViewer}
        title={viewingDraft?.summary || "View Suggestion"}
        width="max-w-4xl"
      >
        {viewingDraft && <DraftDetails draft={viewingDraft} onOpenSourceNote={openSourceNote} />}
      </Modal>

      <Modal
        open={Boolean(editingDraft)}
        onClose={closeDraftEditor}
        title={editingDraft ? `Edit Suggestion ${editingDraft.id}` : "Edit Suggestion"}
        width="max-w-4xl"
      >
        {editingDraft && (
          <DraftJsonEditor
            draft={editingDraft}
            onSaved={(saved) => {
              setEditingDraftId(saved.id);
            }}
          />
        )}
      </Modal>
      <LongTermMemoryDebugLogModal open={debugLogOpen} onClose={() => setDebugLogOpen(false)} />
      <LongTermMemoryExtractionSettingsModal
        open={extractionSettingsOpen}
        onClose={() => setExtractionSettingsOpen(false)}
      />

      {(status.isLoading || integrity.isLoading) && (
        <div className="fixed bottom-3 right-3 rounded-full bg-[var(--card)] p-2 shadow-sm ring-1 ring-[var(--border)]">
          <Loader2 size="1rem" className="animate-spin" />
        </div>
      )}
    </div>
  );
}
