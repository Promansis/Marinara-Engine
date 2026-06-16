import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Eye,
  FileJson,
  Hammer,
  History,
  Info,
  Import,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  ShieldCheck,
  Trash2,
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
  useImportLongTermMemorySourceNotes,
  useLongTermMemoryDrafts,
  useLongTermMemoryImportPreview,
  useLongTermMemoryIntegrity,
  useLongTermMemoryNote,
  useLongTermMemoryNotes,
  useLongTermMemoryStatus,
  useRebuildLongTermMemory,
  useRepairLongTermMemory,
  useReplayLongTermMemory,
  type LtmSearchResponse,
  type LtmInteropSource,
} from "../../hooks/use-long-term-memory";
import type { Chat } from "@marinara-engine/shared";
import { useChatStore } from "../../stores/chat.store";
import { useChat, useChats, useUpdateChatMetadata } from "../../hooks/use-chats";
import { cn } from "../../lib/utils";
import {
  CreateLongTermMemoryNoteForm,
  type CreateLongTermMemoryNoteDraft,
} from "../long-term-memory/CreateLongTermMemoryNoteForm";
import { LongTermMemoryDebugLogModal } from "../long-term-memory/LongTermMemoryDebugLogModal";
import { LongTermMemoryExtractionSettingsModal } from "../long-term-memory/LongTermMemoryExtractionSettingsModal";
import { LongTermMemoryWorkbenchModal } from "../long-term-memory/LongTermMemoryWorkbenchModal";
import { LongTermMemoryNoteEditor } from "../long-term-memory/LongTermMemoryNoteEditor";
import {
  friendlyEvidence,
  friendlyIdentifier,
  friendlyMode,
  friendlyNoteTitle,
  friendlyNoteType,
  friendlySectionKey,
  friendlyStatus,
  sentenceCaseIdentifier,
} from "../long-term-memory/ltm-editor-utils";
import { compactInputClassName, inputClassName, SettingField } from "../long-term-memory/LtmFields";
import { StatusPill, ToolButton } from "../long-term-memory/LtmPills";
import { Modal } from "../ui/Modal";

const NOTE_TYPES: Array<"all" | LtmNoteType> = [
  "all",
  "source",
  "timeline_event",
  "character",
  "relationship",
  "scene",
  "thread",
  "world",
  "tone",
];
const NOTE_STATUSES: Array<"all" | LtmStatus> = ["all", "active", "resolved", "archived"];
const NOTE_TYPE_ORDER = new Map<LtmNoteType, number>(
  NOTE_TYPES.filter((type) => type !== "all").map((type, index) => [type, index]),
);
const NOTE_STATUS_ORDER = new Map<LtmStatus, number>(
  ["active", "resolved", "archived"].map((status, index) => [status as LtmStatus, index]),
);
const IMPORT_SOURCES: Array<{ id: LtmInteropSource; label: string }> = [
  { id: "chats", label: "Chat summaries" },
  { id: "characters", label: "Characters" },
  { id: "lorebooks", label: "Lorebooks" },
];

const TAB_LABELS: Record<TabId, string> = {
  notes: "Memories",
  tools: "Tools",
  import: "Import",
};

type TabId = "notes" | "tools" | "import";
type ImportPreviewRow = NonNullable<ReturnType<typeof useLongTermMemoryImportPreview>["data"]>["samples"][number];
type SourceSummaryGroup = {
  source: LtmNote;
  derived: LtmNote[];
  orphaned: boolean;
};
type LtmBucketGroup = {
  type: LtmNoteType;
  notes: LtmNote[];
};
type LtmRecallStyle = "balanced" | "exact" | "broad" | "story";

const LTM_RECALL_STYLES: Array<{ id: LtmRecallStyle; label: string; description: string }> = [
  { id: "balanced", label: "Balanced", description: "Mixes meaning, exact wording, and linked story notes." },
  { id: "exact", label: "Exact", description: "Favors direct keyword and name matches." },
  { id: "broad", label: "Broad", description: "Looks farther through linked memories." },
  { id: "story", label: "Story", description: "Leans toward arcs, relationships, and scene continuity." },
];

const DEFAULT_LTM_BUDGET_TOKENS = 2048;
const DEFAULT_LTM_MAX_CHUNKS = 12;
const DEFAULT_LTM_SCORE_THRESHOLD = 0;

const rowActionPillClassName =
  "absolute right-2 top-1/2 flex shrink-0 -translate-y-1/2 items-center gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 max-md:opacity-100";

const rowActionButtonClassName =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-all hover:bg-[var(--accent)] hover:text-[var(--foreground)] active:scale-90 disabled:cursor-not-allowed disabled:opacity-45";

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

function SettingGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">{label}</div>
      {children}
    </div>
  );
}

function readRecallStyle(metadata: Record<string, unknown>): LtmRecallStyle {
  const value = metadata.longTermMemoryRecallStyle;
  return value === "exact" || value === "broad" || value === "story" ? value : "balanced";
}

function readNumberSetting(metadata: Record<string, unknown>, key: string, fallback: number, min: number, max: number) {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function compactLtmText(text: string | undefined, limit = 260) {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1).trim()}...` : value;
}

function noteTextPreview(note: LtmNote, limit = 220) {
  return compactLtmText(
    note.sections.summary?.text.trim() ||
      note.sections.core?.text.trim() ||
      note.sections.source?.text.trim() ||
      Object.values(note.sections)[0]?.text.trim() ||
      "",
    limit,
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="px-1 text-[0.6875rem] font-semibold uppercase text-[var(--muted-foreground)]">{title}</h3>
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
  onRestore,
  onDelete,
  bulkSelected,
  onSelect,
  title,
  primaryLabel,
  hideTags,
  children,
}: {
  note: LtmNote;
  viewing: boolean;
  editing: boolean;
  onView: () => void;
  onEdit: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  bulkSelected?: boolean;
  onSelect?: (selected: boolean) => void;
  title?: string;
  primaryLabel?: string;
  hideTags?: boolean;
  children?: ReactNode;
}) {
  const sectionCount = Object.keys(note.sections).length;
  const primaryText =
    note.sections.summary?.text.trim() ||
    note.sections.core?.text.trim() ||
    Object.values(note.sections)[0]?.text.trim() ||
    "";
  const displayTitle = title ?? friendlyNoteTitle(note);
  const showSourceSummary = isSourceSummaryNote(note);
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
            aria-label={`Select ${displayTitle}`}
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
        <div className="truncate text-xs font-semibold text-[var(--foreground)]" title={displayTitle}>
          {displayTitle}
        </div>
        {primaryText && !showSourceSummary && (
          <div className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
            {primaryText}
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-1.5">
          <StatusPill label={primaryLabel ?? (showSourceSummary ? "Source summary" : friendlyNoteType(note.type))} />
          {!showSourceSummary && (
            <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
          )}
          {note.extracted && <StatusPill label="Extracted" />}
          {sectionCount > 1 && <StatusPill label={`${sectionCount} details`} />}
        </div>
        {children}
      </div>
      <div className={rowActionPillClassName}>
        <button
          type="button"
          onClick={onView}
          className={cn(rowActionButtonClassName, viewing && "bg-[var(--accent)] text-[var(--foreground)]")}
          aria-label={`View ${displayTitle}`}
          title="View memory"
        >
          <Eye size="0.875rem" />
        </button>
        {onRestore && (
          <button
            type="button"
            onClick={onRestore}
            className={cn(rowActionButtonClassName, "hover:bg-emerald-500/10 hover:text-emerald-200")}
            aria-label={`Restore ${displayTitle}`}
            title="Restore memory"
          >
            <RotateCcw size="0.875rem" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className={cn(rowActionButtonClassName, "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]")}
            aria-label={`Delete ${displayTitle}`}
            title="Delete memory"
          >
            <Trash2 size="0.875rem" />
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className={cn(rowActionButtonClassName, editing && "bg-[var(--accent)] text-[var(--foreground)]")}
          aria-label={`Edit ${displayTitle}`}
          title="Edit memory"
        >
          <Pencil size="0.875rem" />
        </button>
      </div>
      {!hideTags && note.tags.length > 0 && (
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

function sourceSummaryEvidence(note: LtmNote) {
  return note.sections.source?.evidence ?? [];
}

function sourceSummaryEvidenceValue(note: LtmNote, prefix: string) {
  const item = sourceSummaryEvidence(note).find((entry) => entry.startsWith(prefix));
  return item?.slice(prefix.length).trim();
}

function sourceSummaryChatName(note: LtmNote, chatLookup?: Map<string, Chat>) {
  return sourceSummaryEvidenceValue(note, "chat_name:") || chatLookup?.get(note.scope.chatId ?? "")?.name || "Unknown Chat";
}

function sourceSummaryMessageRange(note: LtmNote) {
  const evidenceRange = sourceSummaryEvidenceValue(note, "message_range:");
  if (evidenceRange) return evidenceRange;
  const idFallback = friendlyIdentifier(note.id)
    .replace(/^Summary\s+/i, "")
    .trim();
  return idFallback ? `unknown (${idFallback})` : "unknown";
}

function isChatSummarySourceNote(note: LtmNote) {
  if (note.type === "source") {
    return (
      note.tags.includes("imported_chat") ||
      sourceSummaryEvidence(note).some((entry) => entry.startsWith("chat_name:") || entry.startsWith("message_range:"))
    );
  }
  return (
    note.type === "scene" && note.tags.some((tag) => tag.includes("source_summary") || tag.includes("chat_summary"))
  );
}

function isSourceSummaryNote(note: LtmNote) {
  return note.type === "source" || isChatSummarySourceNote(note);
}

function sourceSummaryTitle(note: LtmNote, chatLookup?: Map<string, Chat>) {
  const chatName = sourceSummaryChatName(note, chatLookup);
  const range = sourceSummaryMessageRange(note);
  return `${chatName}, msgs ${range}`;
}

function sourceNoteTitle(note: LtmNote, chatLookup?: Map<string, Chat>) {
  return isChatSummarySourceNote(note) ? sourceSummaryTitle(note, chatLookup) : friendlyNoteTitle(note);
}

function sourceLinkIds(note: LtmNote) {
  return note.links.filter((link) => link.relation === "extracted_from").map((link) => link.target);
}

function abbreviateSourceTitle(title: string): string {
  const parts = title.split(", msgs ");
  if (parts.length === 2) {
    const chatName = parts[0].replace(/\s+Chat$/i, "").trim();
    const range = parts[1].trim();
    return chatName.length > 12 ? `${chatName.slice(0, 10)}… ${range}` : `${chatName} ${range}`;
  }
  return title.length > 18 ? `${title.slice(0, 16)}…` : title;
}

function buildNoteLookup(notes: LtmNote[]) {
  return new Map(notes.map((note) => [note.id, note] as const));
}

function noteReferenceLabel(noteId: string, noteLookup: Map<string, LtmNote>, chatLookup?: Map<string, Chat>) {
  const note = noteLookup.get(noteId);
  if (!note) return "Unknown Memory";
  return isSourceSummaryNote(note) ? sourceNoteTitle(note, chatLookup) : friendlyNoteTitle(note);
}

function sourceReferenceLabel(sourceNoteId: string, noteLookup: Map<string, LtmNote>, chatLookup?: Map<string, Chat>) {
  const note = noteLookup.get(sourceNoteId);
  return note ? sourceNoteTitle(note, chatLookup) : "Unknown Source";
}

const TIMELINE_LINK_RELATIONS = new Set(["occurred_in", "triggered_by", "resolved_in", "evidenced_by"]);

function timelineLinksForNote(note: LtmNote, noteLookup: Map<string, LtmNote>) {
  return note.links.filter((link) => {
    const target = noteLookup.get(link.target);
    return target?.type === "timeline_event" || TIMELINE_LINK_RELATIONS.has(link.relation);
  });
}

function pendingConflictCount(note: LtmNote) {
  return note.conflicts?.filter((conflict) => conflict.resolution === "pending").length ?? 0;
}

function isDerivedFromSource(note: LtmNote, sourceNoteId: string) {
  return note.links.some((link) => link.relation === "extracted_from" && link.target === sourceNoteId);
}

function sourceSummaryGroups(notes: LtmNote[], chatLookup?: Map<string, Chat>): SourceSummaryGroup[] {
  const sourceNotes = notes.filter(isSourceSummaryNote);
  const sourceIds = new Set(sourceNotes.map((note) => note.id));
  const groups = new Map<string, SourceSummaryGroup>();
  const rows: SourceSummaryGroup[] = [];
  for (const source of sourceNotes) {
    const group = { source, derived: [], orphaned: false };
    groups.set(source.id, group);
    rows.push(group);
  }
  for (const note of notes) {
    if (isSourceSummaryNote(note)) continue;
    const sourceLink = note.links.find((link) => link.relation === "extracted_from" && sourceIds.has(link.target));
    if (sourceLink) groups.get(sourceLink.target)?.derived.push(note);
    else rows.push({ source: note, derived: [], orphaned: true });
  }
  return rows
    .map((group) => ({
      ...group,
      derived: group.derived.sort((left, right) => friendlyNoteTitle(left).localeCompare(friendlyNoteTitle(right))),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.source.updatedAt);
      const rightTime = Date.parse(right.source.updatedAt);
      if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
      return (left.orphaned ? friendlyNoteTitle(left.source) : sourceNoteTitle(left.source, chatLookup)).localeCompare(
        right.orphaned ? friendlyNoteTitle(right.source) : sourceNoteTitle(right.source, chatLookup),
      );
    });
}

function groupNotesByType(notes: LtmNote[]): LtmBucketGroup[] {
  const groups = new Map<LtmNoteType, LtmNote[]>();
  for (const note of notes) {
    const rows = groups.get(note.type) ?? [];
    rows.push(note);
    groups.set(note.type, rows);
  }
  return [...groups.entries()]
    .map(([type, groupNotes]) => ({
      type,
      notes: groupNotes.sort((left, right) => friendlyNoteTitle(left).localeCompare(friendlyNoteTitle(right))),
    }))
    .sort(
      (left, right) =>
        (NOTE_TYPE_ORDER.get(left.type) ?? Number.MAX_SAFE_INTEGER) -
          (NOTE_TYPE_ORDER.get(right.type) ?? Number.MAX_SAFE_INTEGER) ||
        friendlyNoteType(left.type).localeCompare(friendlyNoteType(right.type)),
    );
}

function sourceTypeLabel(note: LtmNote) {
  if (isChatSummarySourceNote(note)) return "Chat summary";
  if (note.tags.includes("imported_character")) return "Imported character";
  if (note.tags.includes("imported_lorebook")) return "Imported lorebook";
  return note.type === "source" ? "Source note" : "Manual memory";
}

function EvidencePills({
  note,
  noteLookup,
  chatLookup,
  onOpenSource,
}: {
  note: LtmNote;
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  onOpenSource?: (id: string) => void;
}) {
  const sourceIds = sourceLinkIds(note);
  const timelineLinks = timelineLinksForNote(note, noteLookup);
  const conflictCount = pendingConflictCount(note);
  const missingSourceCount = sourceIds.filter((id) => !noteLookup.has(id)).length;
  const archivedSourceCount = sourceIds.filter((id) => noteLookup.get(id)?.status === "archived").length;

  if (
    sourceIds.length === 0 &&
    timelineLinks.length === 0 &&
    conflictCount === 0 &&
    missingSourceCount === 0 &&
    archivedSourceCount === 0
  ) {
    return null;
  }

  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {sourceIds.slice(0, 4).map((sourceId) => {
        const sourceTitle = sourceReferenceLabel(sourceId, noteLookup, chatLookup);
        const tag = abbreviateSourceTitle(sourceTitle);
        const pill = (
          <StatusPill key={sourceId} label={tag} />
        );
        if (onOpenSource) {
          return (
            <button
              key={sourceId}
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenSource(sourceId); }}
              className="transition-opacity hover:opacity-75"
              title={sourceTitle}
            >
              {pill}
            </button>
          );
        }
        return pill;
      })}
      {sourceIds.length > 4 && (
        <StatusPill label={`+${sourceIds.length - 4}`} />
      )}
      {timelineLinks.slice(0, 2).map((link, index) => (
        <StatusPill
          key={`${link.relation}:${link.target}:${index}`}
          label={`Timeline: ${noteReferenceLabel(link.target, noteLookup, chatLookup)}`}
        />
      ))}
      {timelineLinks.length > 2 && <StatusPill label={`+${timelineLinks.length - 2} timeline links`} />}
      {conflictCount > 0 && <StatusPill label={`${conflictCount} needs review`} tone="warn" />}
      {archivedSourceCount > 0 && <StatusPill label="Archived evidence" tone="warn" />}
      {missingSourceCount > 0 && <StatusPill label="Missing source" tone="warn" />}
    </div>
  );
}

function sourceGroupNoteIds(group: SourceSummaryGroup) {
  return [group.source.id, ...group.derived.map((note) => note.id)];
}

function TypeMemoryGroups({
  groups,
  noteLookup,
  expandedMemoryIds,
  expandedTypeIds,
  viewingNoteId,
  editingNoteId,
  derivedCountBySource,
  onToggleMemory,
  onToggleType,
  onView,
  onEdit,
  onOpenSource,
  chatLookup,
}: {
  groups: LtmBucketGroup[];
  noteLookup: Map<string, LtmNote>;
  expandedMemoryIds: Set<string>;
  expandedTypeIds: Set<string>;
  viewingNoteId: string | null;
  editingNoteId: string | null;
  derivedCountBySource: Map<string, number>;
  onToggleMemory: (id: string) => void;
  onToggleType: (type: string) => void;
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  onOpenSource: (id: string) => void;
  chatLookup?: Map<string, Chat>;
}) {
  if (groups.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
        No typed memories match these filters.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const sourceIds = [...new Set(group.notes.flatMap(sourceLinkIds))];
        const sourceCount = sourceIds.length;
        const activeSourceCount = sourceIds.filter((sourceId) => noteLookup.get(sourceId)?.status === "active").length;
        const archivedSourceCount = sourceIds.filter(
          (sourceId) => noteLookup.get(sourceId)?.status === "archived",
        ).length;
        const missingSourceCount = sourceIds.filter((sourceId) => !noteLookup.has(sourceId)).length;
        const conflictCount = group.notes.reduce((total, note) => total + pendingConflictCount(note), 0);
        const typeExpanded = expandedTypeIds.has(group.type);
        return (
          <section key={group.type}>
            <button
              type="button"
              onClick={() => onToggleType(group.type)}
              className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-[var(--accent)]/35"
              aria-label={typeExpanded ? `Collapse ${friendlyNoteType(group.type)}` : `Expand ${friendlyNoteType(group.type)}`}
              aria-expanded={typeExpanded}
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)]">
                {typeExpanded ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusPill label={friendlyNoteType(group.type)} />
                <StatusPill label={`${group.notes.length} memor${group.notes.length === 1 ? "y" : "ies"}`} />
                {sourceCount > 0 && <StatusPill label={`${activeSourceCount}/${sourceCount} active sources`} />}
                {archivedSourceCount > 0 && (
                  <StatusPill
                    label={`${archivedSourceCount} archived source${archivedSourceCount === 1 ? "" : "s"}`}
                    tone="warn"
                  />
                )}
                {missingSourceCount > 0 && (
                  <StatusPill
                    label={`${missingSourceCount} missing source${missingSourceCount === 1 ? "" : "s"}`}
                    tone="warn"
                  />
                )}
                {conflictCount > 0 && <StatusPill label={`${conflictCount} needs review`} tone="warn" />}
              </div>
            </button>
            {typeExpanded && (
              <div className="mt-2 space-y-2">
                {group.notes.map((note) => {
                  const expanded = expandedMemoryIds.has(note.id);
                  const sourcesCount = sourceLinkIds(note).length;
                  const derivedCount = derivedCountBySource.get(note.id) ?? 0;
                  return (
                    <article
                      key={note.id}
                      className={cn(
                        "group relative rounded-lg bg-[var(--secondary)]/45 p-2.5 ring-1 ring-[var(--border)] transition-colors",
                        "hover:bg-[var(--accent)]/45 hover:ring-rose-300/25",
                        (viewingNoteId === note.id || editingNoteId === note.id) && "bg-rose-300/10 ring-rose-300/35",
                      )}
                    >
                      <div className="flex min-w-0 items-start gap-2 pr-28 max-md:pr-28">
                        <button
                          type="button"
                          onClick={() => onToggleMemory(note.id)}
                          className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                          aria-label={expanded ? "Hide source details" : "Show source details"}
                          aria-expanded={expanded}
                        >
                          {expanded ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 truncate">
                            <span className="truncate text-xs font-semibold text-[var(--foreground)]" title={note.id}>
                              {isSourceSummaryNote(note) ? sourceNoteTitle(note, chatLookup) : friendlyNoteTitle(note)}
                            </span>
                            {isSourceSummaryNote(note) && derivedCount > 0 && (
                              <span className="shrink-0 rounded bg-[var(--muted-foreground)]/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
                                &rarr;{derivedCount}
                              </span>
                            )}
                          </div>
                          {note.type !== "source" && (
                            <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                              {noteTextPreview(note) || "No summary text."}
                            </p>
                          )}
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {note.type === "source" ? (
                              <StatusPill label={sourceTypeLabel(note)} />
                            ) : (
                              <StatusPill
                                label={friendlyStatus(note.status)}
                                tone={note.status === "active" ? "good" : "neutral"}
                              />
                            )}
                            {sourcesCount === 0 && note.type !== "source" && <StatusPill label="Manual" />}
                          </div>
                          <EvidencePills note={note} noteLookup={noteLookup} chatLookup={chatLookup} onOpenSource={onOpenSource} />
                          {expanded && (
                            <div className="mt-2 space-y-1.5 rounded-lg bg-[var(--background)]/35 p-2 ring-1 ring-[var(--border)]/70">
                              {sourcesCount === 0 ? (
                                <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
                                  No source evidence is linked to this memory.
                                </p>
                              ) : (
                                sourceLinkIds(note).map((sourceId) => {
                                  const source = noteLookup.get(sourceId);
                                  return (
                                    <button
                                      key={sourceId}
                                      type="button"
                                      onClick={() => onView(sourceId)}
                                      className="w-full rounded-md bg-[var(--secondary)]/45 p-2 text-left ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
                                    >
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="min-w-0 truncate text-xs font-medium text-[var(--foreground)]">
                                          {sourceReferenceLabel(sourceId, noteLookup, chatLookup)}
                                        </span>
                                        {source && <StatusPill label={friendlyStatus(source.status)} tone="neutral" />}
                                      </div>
                                      {source && (
                                        <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                                          {noteTextPreview(source) || "Source has no summary text."}
                                        </p>
                                      )}
                                    </button>
                                  );
                                })
                              )}
                              {(note.conflicts ?? [])
                                .filter((conflict) => conflict.resolution === "pending")
                                .map((conflict) => (
                                  <div
                                    key={`${conflict.field}:${conflict.policy}`}
                                    className="rounded-md bg-amber-500/10 p-2 text-[0.6875rem] leading-relaxed text-amber-100 ring-1 ring-amber-400/30"
                                  >
                                    Needs review: {sentenceCaseIdentifier(conflict.field)}
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className={rowActionPillClassName}>
                        <button
                          type="button"
                          onClick={() => onView(note.id)}
                          className={cn(
                            rowActionButtonClassName,
                            viewingNoteId === note.id && "bg-[var(--accent)] text-[var(--foreground)]",
                          )}
                          aria-label={`View ${friendlyNoteTitle(note)}`}
                          title="View memory"
                        >
                          <Eye size="0.875rem" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onEdit(note.id)}
                          className={cn(
                            rowActionButtonClassName,
                            editingNoteId === note.id && "bg-[var(--accent)] text-[var(--foreground)]",
                          )}
                          aria-label={`Edit ${friendlyNoteTitle(note)}`}
                          title="Edit memory"
                        >
                          <Pencil size="0.875rem" />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ArchivedSourceSummaryGroupRow({
  group,
  viewingNoteId,
  editingNoteId,
  selectedNoteIds,
  onSelect,
  onView,
  onEdit,
  onRestore,
  onDelete,
  chatLookup,
}: {
  group: SourceSummaryGroup;
  viewingNoteId: string | null;
  editingNoteId: string | null;
  selectedNoteIds: Set<string>;
  onSelect: (ids: string[], selected: boolean) => void;
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  onRestore: (note: LtmNote) => void;
  onDelete: (note: LtmNote) => void;
  chatLookup?: Map<string, Chat>;
}) {
  const groupIds = sourceGroupNoteIds(group);
  const allSelected = groupIds.every((id) => selectedNoteIds.has(id));

  if (group.orphaned) {
    return (
      <NoteRow
        note={group.source}
        viewing={viewingNoteId === group.source.id}
        editing={editingNoteId === group.source.id}
        bulkSelected={selectedNoteIds.has(group.source.id)}
        onSelect={(selected) => onSelect([group.source.id], selected)}
        onView={() => onView(group.source.id)}
        onEdit={() => onEdit(group.source.id)}
        onRestore={() => onRestore(group.source)}
        onDelete={() => onDelete(group.source)}
      />
    );
  }

  const sourceTitle = sourceNoteTitle(group.source, chatLookup);
  return (
    <article className="rounded-lg bg-[var(--secondary)]/45 p-2.5 ring-1 ring-[var(--border)]">
      <div className="flex items-start gap-2">
        <label className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--background)]/55 ring-1 ring-[var(--border)]">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(event) => onSelect(groupIds, event.target.checked)}
            className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
            aria-label={`Select ${sourceTitle} group`}
          />
        </label>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-[var(--foreground)]" title={sourceTitle}>
            {sourceTitle}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusPill label={isChatSummarySourceNote(group.source) ? "Source summary" : "Source note"} />
            <StatusPill label={`${group.derived.length} typed memor${group.derived.length === 1 ? "y" : "ies"}`} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 shadow-sm ring-1 ring-[var(--border)]">
          <button
            type="button"
            onClick={() => onView(group.source.id)}
            className={cn(
              rowActionButtonClassName,
              viewingNoteId === group.source.id && "bg-[var(--accent)] text-[var(--foreground)]",
            )}
            aria-label={`View ${sourceTitle}`}
            title="View source memory"
          >
            <Eye size="0.875rem" />
          </button>
          <button
            type="button"
            onClick={() => onRestore(group.source)}
            className={cn(rowActionButtonClassName, "hover:bg-emerald-500/10 hover:text-emerald-200")}
            aria-label={`Restore ${sourceTitle}`}
            title="Restore source memory"
          >
            <RotateCcw size="0.875rem" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(group.source)}
            className={cn(rowActionButtonClassName, "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]")}
            aria-label={`Delete ${sourceTitle}`}
            title="Delete source memory"
          >
            <Trash2 size="0.875rem" />
          </button>
          <button
            type="button"
            onClick={() => onEdit(group.source.id)}
            className={cn(
              rowActionButtonClassName,
              editingNoteId === group.source.id && "bg-[var(--accent)] text-[var(--foreground)]",
            )}
            aria-label={`Edit ${sourceTitle}`}
            title="Edit source memory"
          >
            <Pencil size="0.875rem" />
          </button>
        </div>
      </div>
      {group.derived.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-[var(--border)]/70 pt-2">
          {group.derived.map((derivedNote) => (
            <div
              key={derivedNote.id}
              className="flex min-w-0 items-start gap-2 rounded-lg bg-[var(--background)]/35 p-2 ring-1 ring-[var(--border)]/70"
            >
              <label className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--secondary)]/55 ring-1 ring-[var(--border)]">
                <input
                  type="checkbox"
                  checked={selectedNoteIds.has(derivedNote.id)}
                  onChange={(event) => onSelect([derivedNote.id], event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                  aria-label={`Select ${friendlyNoteTitle(derivedNote)}`}
                />
              </label>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-[var(--foreground)]">
                  {friendlyNoteTitle(derivedNote)}
                </div>
                <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                  {derivedNote.sections.summary?.text.trim() ||
                    derivedNote.sections.core?.text.trim() ||
                    Object.values(derivedNote.sections)[0]?.text.trim() ||
                    "No summary text."}
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <StatusPill label={friendlyNoteType(derivedNote.type)} />
                  <StatusPill label={friendlyStatus(derivedNote.status)} tone="neutral" />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onView(derivedNote.id)}
                  className={cn(
                    rowActionButtonClassName,
                    viewingNoteId === derivedNote.id && "bg-[var(--accent)] text-[var(--foreground)]",
                  )}
                  aria-label={`View ${friendlyNoteTitle(derivedNote)}`}
                  title="View memory"
                >
                  <Eye size="0.875rem" />
                </button>
                <button
                  type="button"
                  onClick={() => onRestore(derivedNote)}
                  className={cn(rowActionButtonClassName, "hover:bg-emerald-500/10 hover:text-emerald-200")}
                  aria-label={`Restore ${friendlyNoteTitle(derivedNote)}`}
                  title="Restore memory"
                >
                  <RotateCcw size="0.875rem" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(derivedNote)}
                  className={cn(
                    rowActionButtonClassName,
                    "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]",
                  )}
                  aria-label={`Delete ${friendlyNoteTitle(derivedNote)}`}
                  title="Delete memory"
                >
                  <Trash2 size="0.875rem" />
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(derivedNote.id)}
                  className={cn(
                    rowActionButtonClassName,
                    editingNoteId === derivedNote.id && "bg-[var(--accent)] text-[var(--foreground)]",
                  )}
                  aria-label={`Edit ${friendlyNoteTitle(derivedNote)}`}
                  title="Edit memory"
                >
                  <Pencil size="0.875rem" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
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
          <span className="font-medium text-[var(--foreground)]">Evidence:</span>{" "}
          {mutation.evidence.map(friendlyEvidence).join(", ")}
        </div>
      )}
    </article>
  );
}

function SourceNoteReference({
  sourceNoteId,
  noteLookup,
  chatLookup,
  onOpenSourceNote,
}: {
  sourceNoteId?: string;
  noteLookup?: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  if (!sourceNoteId) return null;
  const label = noteLookup ? sourceReferenceLabel(sourceNoteId, noteLookup, chatLookup) : friendlyIdentifier(sourceNoteId);
  if (onOpenSourceNote) {
    return (
      <button
        type="button"
        onClick={() => onOpenSourceNote(sourceNoteId)}
        className="min-w-0 truncate rounded-md bg-[var(--muted)]/40 px-1.5 py-0.5 text-left text-[0.625rem] font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
        title={`Open source memory ${sourceNoteId}`}
      >
        From: {label}
      </button>
    );
  }
  return <StatusPill label={`From: ${label}`} />;
}

function DraftMetadataPills({
  draft,
  noteLookup,
  chatLookup,
  onOpenSourceNote,
}: {
  draft: LtmExtractionDraft;
  noteLookup?: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  const { highestRisk, averageConfidence, evidenceCount } = draftRiskSummary(draft);
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      <StatusPill label={`Mutation risk ${mutationRiskLabel(highestRisk)}`} tone={mutationRiskTone(highestRisk)} />
      <StatusPill label={`Confidence ${Math.round(averageConfidence * 100)}%`} />
      <StatusPill label={`${evidenceCount} evidence`} />
      <SourceNoteReference
        sourceNoteId={draft.source.sourceNoteId}
        noteLookup={noteLookup}
        chatLookup={chatLookup}
        onOpenSourceNote={onOpenSourceNote}
      />
    </div>
  );
}

function GraphLinks({ links, noteLookup, chatLookup }: { links: LtmLink[]; noteLookup: Map<string, LtmNote>; chatLookup?: Map<string, Chat> }) {
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
          <span className="min-w-0 truncate text-[var(--foreground)]" title={link.target}>
            {noteReferenceLabel(link.target, noteLookup, chatLookup)}
          </span>
        </div>
      ))}
    </div>
  );
}

function DerivedActiveMemories({
  sourceNote,
  activeNotes,
  noteLookup,
  chatLookup,
  loading,
  onOpenNote,
}: {
  sourceNote: LtmNote;
  activeNotes: LtmNote[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
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
                      {noteTextPreview(derivedNote) || "No summary text."}
                    </p>
                    <EvidencePills note={derivedNote} noteLookup={noteLookup} chatLookup={chatLookup} />
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
  noteLookup,
  chatLookup,
  activeNotesLoading,
  onOpenSourceNote,
}: {
  note: LtmNote;
  activeNotes: LtmNote[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  activeNotesLoading: boolean;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  const isSourceNote = isSourceSummaryNote(note);

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
            </div>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">{section.text}</p>
            {(section.evidence ?? []).length > 0 && (
              <div className="mt-2 text-[0.625rem] text-[var(--muted-foreground)]">
                Evidence: {section.evidence?.map(friendlyEvidence).join(", ")}
              </div>
            )}
          </article>
        ))}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--foreground)]">Related Memories</h3>
        <GraphLinks links={note.links} noteLookup={noteLookup} chatLookup={chatLookup} />
      </section>

      {isSourceNote && (
        <DerivedActiveMemories
          sourceNote={note}
          activeNotes={activeNotes}
          noteLookup={noteLookup}
          chatLookup={chatLookup}
          loading={activeNotesLoading}
          onOpenNote={onOpenSourceNote}
        />
      )}

      <details className="rounded-lg bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--foreground)]">Advanced metadata</summary>
        <div className="mt-2 space-y-1 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          <div>Note ID: {note.id}</div>
          {note.links.length > 0 && <div>Linked IDs: {note.links.map((link) => link.target).join(", ")}</div>}
          <div>Version: {note.version}</div>
          {note.previousHash && <div>Previous hash: {note.previousHash}</div>}
        </div>
      </details>
    </div>
  );
}

function MemoryOverviewPanel({
  note,
  activeNotes,
  noteLookup,
  chatLookup,
  activeNotesLoading,
  pendingSuggestionCount,
  onOpenNote,
}: {
  note: LtmNote;
  activeNotes: LtmNote[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  activeNotesLoading: boolean;
  pendingSuggestionCount: number;
  onOpenNote: (noteId: string) => void;
}) {
  const sourceIds = sourceLinkIds(note);
  const conflictCount = pendingConflictCount(note);
  const isSourceNote = isSourceSummaryNote(note);

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={isSourceNote ? sourceTypeLabel(note) : friendlyNoteType(note.type)} />
          <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
          {note.modes.map((mode) => (
            <StatusPill key={mode} label={friendlyMode(mode)} />
          ))}
          {pendingSuggestionCount > 0 && (
            <StatusPill
              label={`${pendingSuggestionCount} pending suggestion${pendingSuggestionCount === 1 ? "" : "s"}`}
              tone="warn"
            />
          )}
          {conflictCount > 0 && <StatusPill label={`${conflictCount} needs review`} tone="warn" />}
        </div>
        <div className="mt-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {compactScope(note)} · updated {new Date(note.updatedAt).toLocaleString()}
        </div>
      </div>

      <div className="rounded-lg bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]">
        <div className="text-xs font-semibold text-[var(--foreground)]">Preview</div>
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">
          {noteTextPreview(note, 600) || "No memory text has been written yet."}
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="px-1 text-xs font-semibold text-[var(--foreground)]">Source And Links</h3>
        {sourceIds.length > 0 ? (
          <div className="space-y-2">
            {sourceIds.map((sourceId) => {
              const source = noteLookup.get(sourceId);
              return (
                <button
                  key={sourceId}
                  type="button"
                  onClick={() => onOpenNote(sourceId)}
                  className="w-full rounded-lg bg-[var(--secondary)]/35 p-3 text-left ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate text-xs font-medium text-[var(--foreground)]">
                      {sourceReferenceLabel(sourceId, noteLookup, chatLookup)}
                    </span>
                    {source && <StatusPill label={friendlyStatus(source.status)} tone="neutral" />}
                  </div>
                  {source && (
                    <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                      {noteTextPreview(source) || "Source has no summary text."}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <GraphLinks links={note.links} noteLookup={noteLookup} chatLookup={chatLookup} />
        )}
      </section>

      {isSourceNote && (
        <DerivedActiveMemories
          sourceNote={note}
          activeNotes={activeNotes}
          noteLookup={noteLookup}
          chatLookup={chatLookup}
          loading={activeNotesLoading}
          onOpenNote={onOpenNote}
        />
      )}
    </div>
  );
}

function MemoryContentsPanel({ note }: { note: LtmNote }) {
  return (
    <div className="space-y-2">
      {Object.entries(note.sections).map(([key, section]) => (
        <details
          key={key}
          open={Object.keys(note.sections).length <= 3}
          className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]"
        >
          <summary className="cursor-pointer list-none">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-[var(--foreground)]">{friendlySectionKey(key)}</span>
              {typeof section.salience === "number" && <StatusPill label={`Importance ${section.salience}`} />}
              {typeof section.confidence === "number" && <StatusPill label={`AI certainty ${section.confidence}`} />}
            </div>
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">{section.text}</p>
          {(section.evidence ?? []).length > 0 && (
            <div className="mt-2 rounded-md bg-[var(--background)]/55 p-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
              Evidence: {section.evidence?.map(friendlyEvidence).join(", ")}
            </div>
          )}
        </details>
      ))}
      <details className="rounded-lg bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--foreground)]">Advanced metadata</summary>
        <div className="mt-2 space-y-1 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          <div>Note ID: {note.id}</div>
          {note.tags.length > 0 && <div>Tags: {note.tags.map(friendlyIdentifier).join(", ")}</div>}
          {note.links.length > 0 && <div>Linked IDs: {note.links.map((link) => link.target).join(", ")}</div>}
          <div>Version: {note.version}</div>
          {note.previousHash && <div>Previous hash: {note.previousHash}</div>}
        </div>
      </details>
    </div>
  );
}

function MemoryRecallPanel({
  note,
  result,
  pending,
  query,
  onQueryChange,
  onRun,
}: {
  note: LtmNote;
  result: LtmSearchResponse | null;
  pending: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onRun: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onRun();
          }}
          placeholder="Test a recall query"
          className={inputClassName}
        />
        <ToolButton onClick={onRun} disabled={!query.trim() || pending} tone="primary">
          {pending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Search size="0.875rem" />}
          Test
        </ToolButton>
      </div>
      <div className="rounded-lg bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={`Focused on ${friendlyNoteType(note.type)}`} />
          <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
          <StatusPill label="Debug funnel on" />
        </div>
      </div>
      {!result && (
        <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
          Run a query to see selected chunks, rejected candidates, scores, and token use for this memory.
        </p>
      )}
      {result && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill label={`${result.chunks.length} selected`} tone={result.chunks.length ? "good" : "neutral"} />
            <StatusPill label={`${result.usedTokens}/${result.maxTokens} tokens`} />
            <StatusPill
              label={result.embeddingsAvailable ? "Smart search" : "Basic search"}
              tone={result.embeddingsAvailable ? "good" : "warn"}
            />
          </div>
          {result.warnings.map((warning) => (
            <p key={warning} className="rounded-md bg-amber-500/10 px-2 py-1 text-[0.6875rem] text-amber-200">
              {warning}
            </p>
          ))}
          {result.debug?.weights && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(result.debug.weights).map(([key, value]) => (
                <StatusPill key={key} label={`${friendlyIdentifier(key)} ${value}`} />
              ))}
            </div>
          )}
          {result.debug?.funnel && (
            <div className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
              <div className="mb-2 text-xs font-semibold text-[var(--foreground)]">Funnel</div>
              <div className="grid grid-cols-2 gap-1.5">
                {Object.entries(result.debug.funnel).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-[var(--background)]/45 px-2 py-1 text-[0.6875rem] ring-1 ring-[var(--border)]/70"
                  >
                    <span className="truncate text-[var(--muted-foreground)]">{friendlyIdentifier(key)}</span>
                    <span className="font-medium text-[var(--foreground)]">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            {result.chunks.length === 0 && (
              <p className="rounded-md bg-[var(--secondary)]/50 px-2 py-2 text-xs text-[var(--muted-foreground)]">
                No chunks matched this memory-focused query.
              </p>
            )}
            {result.chunks.map((item, index) => (
              <article
                key={`${item.chunk?.id ?? "chunk"}-${index}`}
                className="rounded-md bg-[var(--secondary)]/45 p-2 ring-1 ring-[var(--border)]"
              >
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 truncate font-mono text-[0.6875rem] text-[var(--foreground)]">
                    {item.chunk?.noteId ?? "memory"} · {item.chunk?.sectionKey ?? "section"}
                  </span>
                  {typeof item.score === "number" && <StatusPill label={`Score ${item.score.toFixed(2)}`} />}
                  {item.estimatedTokens !== undefined && <StatusPill label={`~${item.estimatedTokens} tokens`} />}
                  {item.lanes?.map((lane) => (
                    <StatusPill key={lane} label={lane} />
                  ))}
                </div>
                <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                  {compactLtmText(item.chunk?.text, 360)}
                </p>
              </article>
            ))}
          </div>
          {result.debug?.rejected && result.debug.rejected.length > 0 && (
            <details className="rounded-md bg-[var(--secondary)]/35 p-2 text-xs text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
              <summary className="cursor-pointer font-medium text-[var(--foreground)]">
                Rejected candidates ({result.debug.rejected.length})
              </summary>
              <div className="mt-2 grid gap-1">
                {result.debug.rejected.slice(0, 12).map((candidate) => (
                  <div key={candidate.chunkId} className="flex flex-wrap gap-1.5">
                    <span className="font-mono">{candidate.noteId ?? candidate.chunkId}</span>
                    <span>{candidate.rejectionReason ?? "lower_rank"}</span>
                    {candidate.estimatedTokens !== undefined && <span>~{candidate.estimatedTokens} tokens</span>}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function MemorySuggestionsPanel({
  note,
  drafts,
  noteLookup,
  chatLookup,
  onViewDraft,
  onOpenSourceNote,
}: {
  note: LtmNote;
  drafts: LtmExtractionDraft[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  onViewDraft: (draftId: string) => void;
  onOpenSourceNote: (noteId: string) => void;
}) {
  if (!isSourceSummaryNote(note)) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
        Suggestions live on source memories. Open a source summary to review extracted memory drafts.
      </p>
    );
  }

  if (drafts.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
        No pending suggestions for this source.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {drafts.map((draft) => (
        <button
          key={draft.id}
          type="button"
          onClick={() => onViewDraft(draft.id)}
          className="w-full rounded-lg bg-[var(--secondary)]/35 p-3 text-left ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
        >
          <div className="truncate text-xs font-semibold text-[var(--foreground)]">{draft.summary || draft.id}</div>
          <DraftMetadataPills draft={draft} noteLookup={noteLookup} chatLookup={chatLookup} onOpenSourceNote={onOpenSourceNote} />
        </button>
      ))}
    </div>
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
  noteLookup,
  chatLookup,
  onOpenSourceNote,
}: {
  draft: LtmExtractionDraft;
  noteLookup?: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
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
            <SourceNoteReference
              sourceNoteId={draft.source.sourceNoteId}
              noteLookup={noteLookup}
              chatLookup={chatLookup}
              onOpenSourceNote={onOpenSourceNote}
            />
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

function ArchivedDraftRow({
  draft,
  noteLookup,
  chatLookup,
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
  noteLookup?: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
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
        <DraftMetadataPills draft={draft} noteLookup={noteLookup} chatLookup={chatLookup} onOpenSourceNote={onOpenSourceNote} />
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
  onSelect,
  onImport,
}: {
  sample: ImportPreviewRow;
  selected: boolean;
  disabled?: boolean;
  importing?: boolean;
  onSelect: (selected: boolean) => void;
  onImport: () => void;
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
        {sample.snippet && (
          <div className="mt-1 truncate text-[10px] leading-relaxed text-[var(--muted-foreground)]" title={sample.snippet}>
            {sample.snippet}
          </div>
        )}
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
      </div>
    </article>
  );
}

function ChatMemorySettings({
  onOpenExtractionSettings,
  onOpenWorkbench,
  integrity,
  rebuild,
  replay,
  repair,
}: {
  onOpenExtractionSettings: () => void;
  onOpenWorkbench: () => void;
  integrity: ReturnType<typeof useLongTermMemoryIntegrity>;
  rebuild: ReturnType<typeof useRebuildLongTermMemory>;
  replay: ReturnType<typeof useReplayLongTermMemory>;
  repair: ReturnType<typeof useRepairLongTermMemory>;
}) {
  const activeChatId = useChatStore((s) => s.activeChatId);
  const cachedActiveChat = useChatStore((s) => s.activeChat);
  const activeChatQuery = useChat(activeChatId);
  const activeChat = activeChatQuery.data ?? cachedActiveChat;
  const updateMeta = useUpdateChatMetadata();
  const metadata = useMemo(() => parseMetadata(activeChat?.metadata), [activeChat?.metadata]);
  const enabled = metadata.enableLongTermMemory === true;
  const debug = metadata.longTermMemoryDebug === true;
  const budgetValue = readNumberSetting(metadata, "longTermMemoryBudgetTokens", DEFAULT_LTM_BUDGET_TOKENS, 128, 16_384);
  const maxChunksValue = readNumberSetting(metadata, "longTermMemoryMaxChunks", DEFAULT_LTM_MAX_CHUNKS, 1, 100);
  const scoreThresholdValue =
    typeof metadata.longTermMemoryScoreThreshold === "number" && Number.isFinite(metadata.longTermMemoryScoreThreshold)
      ? Math.max(0, Math.min(1, metadata.longTermMemoryScoreThreshold))
      : DEFAULT_LTM_SCORE_THRESHOLD;
  const recallStyle = readRecallStyle(metadata);
  const includeResolved = metadata.longTermMemoryIncludeResolved === true;
  const contextMessagesValue = readNumberSetting(metadata, "longTermMemoryRecallContextMessages", 4, 1, 20);
  const [budgetDraft, setBudgetDraft] = useState(String(budgetValue));
  const [maxChunksDraft, setMaxChunksDraft] = useState(String(maxChunksValue));
  const [scoreThresholdDraft, setScoreThresholdDraft] = useState(scoreThresholdValue);
  const [contextMessagesDraft, setContextMessagesDraft] = useState(String(contextMessagesValue));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [recallOpen, setRecallOpen] = useState(true);
  const [extractionOpen, setExtractionOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const sliderBudget = Number.isFinite(Number(budgetDraft))
    ? Math.max(128, Math.min(16_384, Math.floor(Number(budgetDraft))))
    : budgetValue;

  useEffect(() => {
    setBudgetDraft(String(budgetValue));
    setMaxChunksDraft(String(maxChunksValue));
    setScoreThresholdDraft(scoreThresholdValue);
    setContextMessagesDraft(String(contextMessagesValue));
  }, [activeChat?.id, budgetValue, maxChunksValue, scoreThresholdValue, contextMessagesValue]);

  const patch = (next: Record<string, unknown>) => {
    if (!activeChat) return Promise.resolve();
    return updateMeta
      .mutateAsync({ id: activeChat.id, ...next })
      .then(() => toast.success("Chat memory settings updated"))
      .catch((err: Error) => toast.error(err.message));
  };

  const commitBudget = (value: string) => {
    const numeric = Number(value);
    const next = Number.isFinite(numeric)
      ? Math.max(128, Math.min(16_384, Math.floor(numeric)))
      : DEFAULT_LTM_BUDGET_TOKENS;
    setBudgetDraft(String(next));
    if (next === budgetValue) return Promise.resolve();
    return patch({ longTermMemoryBudgetTokens: next });
  };

  const commitMaxChunks = (value: string) => {
    const numeric = Number(value);
    const next = Number.isFinite(numeric) ? Math.max(1, Math.min(100, Math.floor(numeric))) : DEFAULT_LTM_MAX_CHUNKS;
    setMaxChunksDraft(String(next));
    if (next === maxChunksValue) return Promise.resolve();
    return patch({ longTermMemoryMaxChunks: next });
  };

  const commitContextMessages = (value: string) => {
    const numeric = Number(value);
    const next = Number.isFinite(numeric) ? Math.max(1, Math.min(20, Math.floor(numeric))) : 4;
    setContextMessagesDraft(String(next));
    if (next === contextMessagesValue) return Promise.resolve();
    return patch({ longTermMemoryRecallContextMessages: next });
  };

  const commitScoreThreshold = (value: number) => {
    const numeric = Number.isFinite(value) ? value : DEFAULT_LTM_SCORE_THRESHOLD;
    const next = Math.max(0, Math.min(1, Number(numeric.toFixed(2))));
    setScoreThresholdDraft(next);
    if (next === scoreThresholdValue) return Promise.resolve();
    return patch({ longTermMemoryScoreThreshold: next });
  };

  const resetRecallDefaults = () => {
    setBudgetDraft(String(DEFAULT_LTM_BUDGET_TOKENS));
    setMaxChunksDraft(String(DEFAULT_LTM_MAX_CHUNKS));
    setScoreThresholdDraft(DEFAULT_LTM_SCORE_THRESHOLD);
    return patch({
      longTermMemoryBudgetTokens: DEFAULT_LTM_BUDGET_TOKENS,
      longTermMemoryMaxChunks: DEFAULT_LTM_MAX_CHUNKS,
      longTermMemoryScoreThreshold: DEFAULT_LTM_SCORE_THRESHOLD,
      longTermMemoryRecallStyle: "balanced",
      longTermMemoryIncludeResolved: false,
    });
  };

  return (
    <div className="space-y-2">
      {!activeChat && (
        <p className="text-xs text-[var(--muted-foreground)]">Open a chat to edit its long-term memory settings.</p>
      )}

      {activeChat && (
        <>
          <button
            type="button"
            onClick={() => setRecallOpen((c) => !c)}
            className="flex min-h-8 items-center justify-between rounded-lg px-2 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
            aria-expanded={recallOpen}
          >
            <span>Recall</span>
            {recallOpen ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
          </button>
          {recallOpen && (
            <div className="grid gap-2 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
              <SettingToggle
                label="Use memory in prompts"
                checked={enabled}
                onChange={(checked) => patch({ enableLongTermMemory: checked })}
              />
              <SettingGroup label="Recall style">
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--background)] p-1 ring-1 ring-[var(--border)]">
                  {LTM_RECALL_STYLES.map((style) => (
                    <div key={style.id} className="grid grid-cols-[1fr_auto] overflow-hidden rounded-md">
                      <button
                        type="button"
                        onClick={() => patch({ longTermMemoryRecallStyle: style.id })}
                        aria-pressed={recallStyle === style.id}
                        className={cn(
                          "min-h-8 px-2 text-left text-xs font-medium transition-colors",
                          recallStyle === style.id
                            ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                            : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                        )}
                      >
                        {style.label}
                      </button>
                      <button
                        type="button"
                        title={style.description}
                        aria-label={`${style.label} recall style: ${style.description}`}
                        onClick={(event) => event.preventDefault()}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center transition-colors",
                          recallStyle === style.id
                            ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                            : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                        )}
                      >
                        <Info size="0.75rem" />
                      </button>
                    </div>
                  ))}
                </div>
              </SettingGroup>
              <div className="grid gap-3 sm:grid-cols-[1fr_6.5rem]">
                <SettingField label="Max tokens">
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
                      className={compactInputClassName}
                    />
                  </div>
                </SettingField>
                <SettingField label="Max memories">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={maxChunksDraft}
                    onChange={(event) => setMaxChunksDraft(event.target.value)}
                    onBlur={(event) => commitMaxChunks(event.target.value)}
                    className={compactInputClassName}
                  />
                </SettingField>
              </div>
              <SettingField label="Context messages for search">
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={contextMessagesDraft}
                  onChange={(event) => setContextMessagesDraft(event.target.value)}
                  onBlur={(event) => commitContextMessages(event.target.value)}
                  className={compactInputClassName}
                />
              </SettingField>
              <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                How many recent chat messages to use for searching the database. Default 4 (last 2 exchanges).
              </p>
              <button
                type="button"
                onClick={() => setAdvancedOpen((current) => !current)}
                className="flex min-h-8 items-center justify-between rounded-lg px-2 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
                aria-expanded={advancedOpen}
              >
                <span>Advanced recall</span>
                {advancedOpen ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
              </button>
              {advancedOpen && (
                <div className="grid gap-2 rounded-lg bg-[var(--background)] p-2 ring-1 ring-[var(--border)]">
                  <SettingToggle
                    label="Include resolved threads"
                    checked={includeResolved}
                    onChange={(checked) => patch({ longTermMemoryIncludeResolved: checked })}
                  />
                  <SettingGroup label="Score threshold">
                    <div className="grid grid-cols-[1fr_4.5rem] items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={scoreThresholdDraft}
                        onChange={(event) => setScoreThresholdDraft(Number(event.target.value))}
                        onPointerUp={(event) => commitScoreThreshold(Number((event.target as HTMLInputElement).value))}
                        onBlur={(event) => commitScoreThreshold(Number(event.target.value))}
                        className="min-w-0 accent-[var(--primary)]"
                      />
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={scoreThresholdDraft}
                        onChange={(event) => setScoreThresholdDraft(Number(event.target.value))}
                        onBlur={(event) => commitScoreThreshold(Number(event.target.value))}
                        className={compactInputClassName}
                      />
                    </div>
                    <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                      0 keeps all ranked matches. Higher values keep only memories close to the strongest match.
                    </p>
                  </SettingGroup>
                  <div>
                    <ToolButton onClick={resetRecallDefaults}>
                      <RotateCcw size="0.875rem" />
                      Reset recall defaults
                    </ToolButton>
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => setExtractionOpen((c) => !c)}
            className="flex min-h-8 items-center justify-between rounded-lg px-2 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
            aria-expanded={extractionOpen}
          >
            <span>Extraction</span>
            {extractionOpen ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
          </button>
          {extractionOpen && (
            <div className="grid gap-2 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
              <ToolButton onClick={onOpenExtractionSettings}>
                <SlidersHorizontal size="0.875rem" />
                Extraction settings
              </ToolButton>
              <p className="text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                Extraction now runs only from imported or created source notes. Generated chat turns no longer create
                long-term memory drafts automatically.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={() => setMaintenanceOpen((c) => !c)}
            className="flex min-h-8 items-center justify-between rounded-lg px-2 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
            aria-expanded={maintenanceOpen}
          >
            <span>Maintenance</span>
            {maintenanceOpen ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
          </button>
          {maintenanceOpen && (
            <div className="grid gap-2 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
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
              <div className="mt-3 space-y-2">
                {(integrity.data?.issues ?? [])
                  .filter((issue) => issue.severity !== "info")
                  .slice(0, 8).map((issue) => (
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
            </div>
          )}

          <button
            type="button"
            onClick={() => setDebugOpen((c) => !c)}
            className="flex min-h-8 items-center justify-between rounded-lg px-2 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
            aria-expanded={debugOpen}
          >
            <span>Debug</span>
            {debugOpen ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
          </button>
          {debugOpen && (
            <div className="grid gap-2 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
              <SettingToggle
                label="Debug retrieval logs"
                checked={debug}
                onChange={(checked) => patch({ longTermMemoryDebug: checked })}
              />
              <ToolButton onClick={onOpenWorkbench}>
                <Search size="0.875rem" />
                Open LTM Workbench
              </ToolButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function LongTermMemoryPanel() {
  const [tab, setTab] = useState<TabId>("notes");
  const [noteType, setNoteType] = useState<"all" | LtmNoteType>("all");
  const [noteStatus, setNoteStatus] = useState<"all" | LtmStatus>("all");
  const [query, setQuery] = useState("");
  const [importSource, setImportSource] = useState<LtmInteropSource>("chats");
  const [importLimit, setImportLimit] = useState(25);
  const [importChatId, setImportChatId] = useState<string>("");
  const [selectedImportRows, setSelectedImportRows] = useState<Set<string>>(() => new Set());
  const [activeImportIds, setActiveImportIds] = useState<Set<string>>(() => new Set());
  const [debugLogOpen, setDebugLogOpen] = useState(false);
  const [extractionSettingsOpen, setExtractionSettingsOpen] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const [createNoteDraft, setCreateNoteDraft] = useState<CreateLongTermMemoryNoteDraft | null>(null);
  const [createNoteDirty, setCreateNoteDirty] = useState(false);
  const [viewingNoteId, setViewingNoteId] = useState<string | null>(null);
  const [sourceViewerNoteId, setSourceViewerNoteId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editedNoteDirty, setEditedNoteDirty] = useState(false);
  const [expandedTypeIds, setExpandedTypeIds] = useState<Set<string>>(
    () => new Set(NOTE_TYPES.filter((t) => t !== "all")),
  );
  const [expandedMemoryIds, setExpandedMemoryIds] = useState<Set<string>>(() => new Set());
  const [viewingDraftId, setViewingDraftId] = useState<string | null>(null);

  const { data: chats } = useChats();
  const chatLookup = useMemo(() => new Map((chats as Chat[] | undefined)?.map((c) => [c.id, c])), [chats]);

  const status = useLongTermMemoryStatus();
  const integrity = useLongTermMemoryIntegrity();
  const notes = useLongTermMemoryNotes();
  const activeNotes = useLongTermMemoryNotes(
    { status: "active" },
    { enabled: tab === "notes" || Boolean(viewingNoteId) || Boolean(sourceViewerNoteId) },
  );
  const allDrafts = useLongTermMemoryDrafts(
    {},
    {
      enabled:
        Boolean(viewingNoteId) ||
        Boolean(sourceViewerNoteId) ||
        Boolean(viewingDraftId),
    },
  );
  const exactViewingNote = useLongTermMemoryNote(viewingNoteId ?? sourceViewerNoteId ?? undefined);
  const importPreview = useLongTermMemoryImportPreview(importSource, importLimit);
  const rebuild = useRebuildLongTermMemory();
  const replay = useReplayLongTermMemory();
  const repair = useRepairLongTermMemory();
  const importSourceNotes = useImportLongTermMemorySourceNotes();

  const filteredNotes = useMemo(() => {
    const list = (notes.data ?? []).filter((note) => {
      if (noteStatus !== "all" && note.status !== noteStatus) return false;
      if (noteType !== "all" && note.type !== noteType) return false;
      return true;
    });
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (note) =>
        note.id.toLowerCase().includes(needle) ||
        (isSourceSummaryNote(note) && sourceNoteTitle(note).toLowerCase().includes(needle)) ||
        note.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
        Object.values(note.sections).some((section) => section.text.toLowerCase().includes(needle)),
    );
  }, [noteStatus, noteType, notes.data, query]);
  const groupedBucketNotes = useMemo(() => groupNotesByType(filteredNotes), [filteredNotes]);
  const derivedCountBySource = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of filteredNotes) {
      for (const link of note.links) {
        if (link.relation === "extracted_from") {
          counts.set(link.target, (counts.get(link.target) ?? 0) + 1);
        }
      }
    }
    return counts;
  }, [filteredNotes]);

  const archivedDrafts = useMemo(
    () => (allDrafts.data ?? []).filter((draft) => draft.status !== "pending"),
    [allDrafts.data],
  );
  const combinedDrafts = useMemo(() => {
    const byId = new Map<string, LtmExtractionDraft>();
    for (const draft of allDrafts.data ?? []) byId.set(draft.id, draft);
    return [...byId.values()];
  }, [allDrafts.data]);
  const importRows = useMemo(() => importPreview.data?.samples ?? [], [importPreview.data?.samples]);
  const visibleImportRows = useMemo(
    () => importSource === "chats" && importChatId
      ? importRows.filter((sample) => sample.sourceId.startsWith(`${importChatId}:`))
      : importRows,
    [importRows, importSource, importChatId],
  );
  const selectedVisibleImportRows = useMemo(
    () => visibleImportRows.filter((sample) => selectedImportRows.has(importRowKey(importSource, sample.sourceId))),
    [importSource, selectedImportRows, visibleImportRows],
  );
  const allVisibleImportRowsSelected =
    visibleImportRows.length > 0 &&
    visibleImportRows.every((sample) => selectedImportRows.has(importRowKey(importSource, sample.sourceId)));
  const combinedNotes = useMemo(() => {
    const byId = new Map<string, LtmNote>();
    for (const note of notes.data ?? []) byId.set(note.id, note);
    if (exactViewingNote.data) byId.set(exactViewingNote.data.id, exactViewingNote.data);
    return [...byId.values()];
  }, [exactViewingNote.data, notes.data]);
  const noteLookup = useMemo(() => buildNoteLookup(combinedNotes), [combinedNotes]);
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
  const sourceViewerNote = useMemo(
    () =>
      sourceViewerNoteId
        ? (combinedNotes.find((note) => note.id === sourceViewerNoteId) ??
          (exactViewingNote.data?.id === sourceViewerNoteId ? exactViewingNote.data : null))
        : null,
    [combinedNotes, exactViewingNote.data, sourceViewerNoteId],
  );
  const viewingDraft = useMemo(
    () => (viewingDraftId ? (combinedDrafts.find((draft) => draft.id === viewingDraftId) ?? null) : null),
    [combinedDrafts, viewingDraftId],
  );
  const viewingNoteModalOpen = Boolean(viewingNote) && tab !== "notes";
  const editedNoteFilteredOut = Boolean(editingNote && !filteredNotes.some((note) => note.id === editingNote.id));
  const editingNoteHiddenByFilters = Boolean(editedNoteFilteredOut && editingNote);
  const activeListViewingNoteId = sourceViewerNoteId ?? viewingNoteId;

  const closeEditor = () => {
    setEditingNoteId(null);
    setEditedNoteDirty(false);
  };

  const closeViewer = () => {
    setViewingNoteId(null);
  };

  const closeSourceViewer = () => {
    setSourceViewerNoteId(null);
  };

  const closeDraftViewer = () => {
    setViewingDraftId(null);
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
    if (sourceViewerNoteId) closeSourceViewer();
    if (viewingDraftId) closeDraftViewer();
    setTab(nextTab);
  };

  const requestViewNote = (id: string) => {
    if (viewingNoteId === id) return;
    setViewingNoteId(id);
  };

  const requestViewMemory = (id: string) => {
    const note = noteLookup.get(id);
    if (note && isSourceSummaryNote(note)) {
      setSourceViewerNoteId(id);
      return;
    }
    requestViewNote(id);
  };

  const openSourceNote = (id: string) => {
    if (editingNoteId && !confirmDiscardEditor()) return;
    setViewingDraftId(null);
    setEditingNoteId(null);
    setEditedNoteDirty(false);
    setSourceViewerNoteId(id);
  };

  const toggleExpandedType = (type: string) => {
    setExpandedTypeIds((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleExpandedMemory = (id: string) => {
    setExpandedMemoryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const requestEditNote = (id: string) => {
    if (editingNoteId === id) {
      return;
    }
    if (creatingNote && !confirmDiscardCreate()) return;
    if (!confirmDiscardEditor()) return;
    closeCreateForm();
    closeViewer();
    closeSourceViewer();
    closeDraftViewer();
    setEditingNoteId(id);
    setEditedNoteDirty(false);
  };

  const requestCreateNote = () => {
    if (creatingNote) return;
    if (!confirmDiscardEditor()) return;
    setEditingNoteId(null);
    setEditedNoteDirty(false);
    closeViewer();
    closeSourceViewer();
    closeDraftViewer();
    setCreatingNote(true);
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
              <StatusPill label={`${(notes.data ?? []).length} memor${(notes.data ?? []).length === 1 ? "y" : "ies"}`} />
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
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-[var(--secondary)]/45 p-1 ring-1 ring-[var(--border)]/80">
          {(["notes", "tools", "import"] as TabId[]).map((id) => (
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
          {editingNoteHiddenByFilters && (
            <div className="mb-3 rounded-lg bg-amber-500/10 p-3 ring-1 ring-amber-400/30">
              <div className="text-xs font-medium text-amber-100">Open note is hidden by filters</div>
              <p className="mt-1 text-[0.6875rem] text-amber-100/80">
                The editor stays open so unsaved edits are not lost.
              </p>
            </div>
          )}
          <section className="space-y-3">
              <div className="grid grid-cols-[1fr_auto] gap-2">
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
              <div className="grid grid-cols-2 gap-2">
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
                  onChange={(event) => setNoteStatus(event.target.value as "all" | LtmStatus)}
                  className="rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
                >
                  {NOTE_STATUSES.map((statusId) => (
                    <option key={statusId} value={statusId}>
                      {statusId === "all" ? "Any status" : friendlyStatus(statusId)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                {notes.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
                {!notes.isLoading && filteredNotes.length === 0 && (
                  <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                    No matching memories.
                  </p>
                )}
                {!notes.isLoading &&
                  filteredNotes.length > 0 && (
                    <TypeMemoryGroups
                      groups={groupedBucketNotes}
                      noteLookup={noteLookup}
                      chatLookup={chatLookup}
                      expandedMemoryIds={expandedMemoryIds}
                      expandedTypeIds={expandedTypeIds}
                      viewingNoteId={activeListViewingNoteId}
                      editingNoteId={editingNoteId}
                      derivedCountBySource={derivedCountBySource}
      onToggleMemory={toggleExpandedMemory}
      onToggleType={toggleExpandedType}
      onView={requestViewMemory}
      onEdit={requestEditNote}
      onOpenSource={openSourceNote}
                    />
                  )}
              </div>
            </section>
        </Section>
      )}

      {tab === "tools" && (
        <ChatMemorySettings
          onOpenExtractionSettings={() => setExtractionSettingsOpen(true)}
          onOpenWorkbench={() => setWorkbenchOpen(true)}
          integrity={integrity}
          rebuild={rebuild}
          replay={replay}
          repair={repair}
        />
      )}

      {tab === "import" && (
        <Section title="Import">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <select
              value={importSource}
              onChange={(event) => { setImportSource(event.target.value as LtmInteropSource); setImportChatId(""); }}
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
          {importSource === "chats" && (
            <div className="mt-2">
              <select
                value={importChatId}
                onChange={(event) => setImportChatId(event.target.value)}
                className="w-full rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-transparent focus:ring-[var(--primary)]"
              >
                <option value="">All chats ({importRows.length})</option>
                {(chats as Chat[] | undefined)
                  ?.filter((c) => importRows.some((row) => row.sourceId.startsWith(`${c.id}:`)))
                  .sort((a, b) => (a.name || "Untitled").localeCompare(b.name || "Untitled"))
                  .map((chat) => (
                    <option key={chat.id} value={chat.id}>
                      {chat.name || "Untitled"} — {importRows.filter((row) => row.sourceId.startsWith(`${chat.id}:`)).length}
                    </option>
                  ))}
              </select>
            </div>
          )}
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
          </div>

          <div className="mt-3 space-y-2">
            {importPreview.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
            {!importPreview.isLoading && visibleImportRows.length === 0 && (
              <p className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
                No sources are ready to bring in.
              </p>
            )}
            {visibleImportRows.map((sample) => (
              <ImportPreviewRowItem
                key={sample.sourceId}
                sample={sample}
                selected={selectedImportRows.has(importRowKey(importSource, sample.sourceId))}
                disabled={importSourceNotes.isPending}
                importing={activeImportIds.has(importRowKey(importSource, sample.sourceId))}
                onSelect={(selected) => setImportRowSelected(sample.sourceId, selected)}
                onImport={() => importRowsToVault([sample.sourceId])}
              />
            ))}
          </div>
        </Section>
      )}

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
        open={Boolean(sourceViewerNote)}
        onClose={closeSourceViewer}
        title={sourceViewerNote ? sourceNoteTitle(sourceViewerNote) : "View Source Summary"}
        width="max-w-4xl"
      >
        {sourceViewerNote && (
          <NoteViewModalContent
            note={sourceViewerNote}
            activeNotes={activeNotes.data ?? []}
            noteLookup={noteLookup}
            activeNotesLoading={activeNotes.isLoading}
            onOpenSourceNote={openSourceNote}
          />
        )}
      </Modal>

      <Modal
        open={viewingNoteModalOpen}
        onClose={closeViewer}
        title={viewingNote ? friendlyNoteTitle(viewingNote) : "View Memory"}
        width="max-w-4xl"
      >
        {viewingNote && (
          <NoteViewModalContent
            note={viewingNote}
            activeNotes={activeNotes.data ?? []}
            noteLookup={noteLookup}
            chatLookup={chatLookup}
            activeNotesLoading={activeNotes.isLoading}
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
        {viewingDraft && (
          <DraftDetails draft={viewingDraft} noteLookup={noteLookup} chatLookup={chatLookup} onOpenSourceNote={openSourceNote} />
        )}
      </Modal>
      <LongTermMemoryDebugLogModal open={debugLogOpen} onClose={() => setDebugLogOpen(false)} />
      <LongTermMemoryExtractionSettingsModal
        open={extractionSettingsOpen}
        onClose={() => setExtractionSettingsOpen(false)}
      />
      <LongTermMemoryWorkbenchModal
        open={workbenchOpen}
        onClose={() => setWorkbenchOpen(false)}
      />

      {(status.isLoading || integrity.isLoading) && (
        <div className="fixed bottom-3 right-3 rounded-full bg-[var(--card)] p-2 shadow-sm ring-1 ring-[var(--border)]">
          <Loader2 size="1rem" className="animate-spin" />
        </div>
      )}
    </div>
  );
}
