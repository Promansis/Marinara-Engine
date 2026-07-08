// Shared types, constants, and helpers for the Long-Term Memory panel and its sub-components.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Chat, LtmDraftMutation, LtmExtractionDraft, LtmMode, LtmNote, LtmNoteType, LtmScope, LtmStatus } from "@marinara-engine/shared";
import { isLtmSourceLikeNote } from "@marinara-engine/shared";
import type { LtmInteropPreview, LtmInteropSource } from "../../hooks/use-long-term-memory";
import type { LtmResolvedGlobalSettings } from "../../hooks/use-long-term-memory";
import {
  displayNoteTitle,
  friendlyIdentifier,
  friendlyNoteTitle,
  friendlyNoteType,
  friendlySectionKey,
  friendlyStatus,
} from "../long-term-memory/ltm-editor-utils";
import { LTM_RECALL_STYLE_WEIGHTS } from "@marinara-engine/shared";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import { StatusPill } from "./LtmPills";

// ── Types ──────────────────────────────────────

export type TabId = "notes" | "import" | "review" | "debug";
export type MemoryModalMode = "view" | "edit";
export type MemoryModalTab = "overview" | "content" | "links" | "recall" | "suggestions";
export type LtmRecallStyle = "balanced" | "exact" | "broad" | "story";
export type ImportPreviewRow = LtmInteropPreview["samples"][number];

export type LtmBucketGroup = {
  type: LtmNoteType;
  notes: LtmNote[];
};

export type SourceSummaryGroup = {
  source: LtmNote;
  derived: LtmNote[];
  orphaned: boolean;
};

// ── Constants ──────────────────────────────────

export const NOTE_TYPES: Array<"all" | LtmNoteType> = [
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

export const NOTE_STATUSES: Array<"all" | LtmStatus> = ["all", "active", "resolved", "archived"];

export const NOTE_TYPE_ORDER = new Map<LtmNoteType, number>(
  NOTE_TYPES.filter((type) => type !== "all").map((type, index) => [type, index]),
);

export const NOTE_STATUS_ORDER = new Map<LtmStatus, number>(
  ["active", "resolved", "archived"].map((status, index) => [status as LtmStatus, index]),
);

export const IMPORT_SOURCES: Array<{ id: LtmInteropSource; label: string }> = [
  { id: "chats", label: "Chat summaries" },
  { id: "characters", label: "Characters" },
  { id: "lorebooks", label: "Lorebooks" },
];

export const TAB_LABELS: Record<TabId, string> = {
  notes: "Memories",
  import: "Import",
  review: "Review",
  debug: "Debug",
};

export const LTM_GLOBAL_SETTINGS_MIGRATION_KEY = "ltm:global-settings-migrated:v1";
export const LTM_RECALL_STYLES: Array<{ id: LtmRecallStyle; label: string; description: string }> = [
  { id: "balanced", label: "Balanced", description: "Mixes meaning, exact wording, and linked story notes. Good default for most chats." },
  { id: "exact", label: "Exact", description: "Favors direct keyword and name matches. Best when you need specific facts recalled precisely." },
  { id: "broad", label: "Broad", description: "Looks farther through linked memories. Good for catching indirect connections." },
  { id: "story", label: "Story", description: "Leans toward arcs, relationships, and scene continuity. Best for long-running stories." },
];

export const DEFAULT_LTM_BUDGET_TOKENS = 2048;
export const DEFAULT_LTM_MAX_CHUNKS = 12;
export const DEFAULT_LTM_SCORE_THRESHOLD = 0;
export const DEFAULT_LTM_CONTEXT_MESSAGES = 4;
export const DEFAULT_IMPORT_CONCURRENCY = 3;
export const LTM_WEIGHT_MIN = 0;
export const LTM_WEIGHT_MAX = 2;
export const LTM_WEIGHT_STEP = 0.05;

export const LTM_WEIGHT_PATCH_KEY_MAP = {
  semantic: "longTermMemorySemanticWeight",
  lexical: "longTermMemoryLexicalWeight",
  graph: "longTermMemoryGraphWeight",
  keyword: "longTermMemoryKeywordWeight",
} as const;

export const TIMELINE_LINK_RELATIONS = new Set(["occurred_in", "triggered_by", "resolved_in", "evidenced_by"]);

export const MODE_LABELS: Record<LtmMode, string> = {
  roleplay: "Roleplay",
  conversation: "Conversation",
  game: "Game",
};

export const MODE_BADGE_COLORS: Record<LtmMode, string> = {
  roleplay: "bg-amber-500/15 text-amber-600 ring-amber-500/30",
  conversation: "bg-blue-500/15 text-blue-600 ring-blue-500/30",
  game: "bg-violet-500/15 text-violet-600 ring-violet-500/30",
};

// ── CSS class constants ────────────────────────

export const rowActionButtonClassName =
  "mari-chrome-control mari-chrome-control--small mari-chrome-control--icon shrink-0 text-[var(--muted-foreground)] active:scale-90 disabled:cursor-not-allowed disabled:opacity-45 [&>svg]:!size-[0.9375rem] [&>svg]:shrink-0 [&>svg]:!stroke-[2.15]";

export const rowActionGroupClassName =
  "absolute right-2 top-1/2 flex shrink-0 -translate-y-1/2 items-center justify-end gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100";

export const rowActionOverlayClassName =
  "absolute right-2 top-1/2 flex shrink-0 -translate-y-1/2 items-center justify-end gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100";

export const disclosureButtonClassName =
  "flex min-h-11 w-full items-center justify-between gap-3 rounded-xl bg-[var(--secondary)]/35 px-3 py-2 text-left text-xs font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)] transition-[background-color,box-shadow,color] hover:bg-[var(--accent)]/45 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60";

// ── Utility functions ──────────────────────────

export function importRowKey(source: LtmInteropSource, sourceId: string) {
  return `${source}:${sourceId}`;
}

export function optionalTrimmedText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function clampImportConcurrency(value: number) {
  return Number.isFinite(value) ? Math.max(1, Math.min(10, Math.floor(value))) : DEFAULT_IMPORT_CONCURRENCY;
}

export function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function characterNameFromRow(row: unknown) {
  const record = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const data = record.data;
  const parsed = typeof data === "string" ? parseMetadata(data) : parseMetadata(data);
  return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Unknown";
}

export function readLongTermMemoryRecallSearchSettings(settings: LtmResolvedGlobalSettings | undefined) {
  const recallStyle = settings?.longTermMemoryRecallStyle ?? "balanced";
  const styleWeights = LTM_RECALL_STYLE_WEIGHTS[recallStyle];
  const weights = settings
    ? {
        semanticWeight: settings.longTermMemorySemanticWeight,
        lexicalWeight: settings.longTermMemoryLexicalWeight,
        graphWeight: settings.longTermMemoryGraphWeight,
        keywordWeight: settings.longTermMemoryKeywordWeight,
      }
    : styleWeights;
  return {
    maxTokens: settings?.longTermMemoryBudgetTokens ?? DEFAULT_LTM_BUDGET_TOKENS,
    maxChunks: settings?.longTermMemoryMaxChunks ?? DEFAULT_LTM_MAX_CHUNKS,
    minScore: settings?.longTermMemoryScoreThreshold ?? DEFAULT_LTM_SCORE_THRESHOLD,
    includeResolved: settings?.longTermMemoryIncludeResolved ?? false,
    contextMessages: settings?.longTermMemoryRecallContextMessages ?? DEFAULT_LTM_CONTEXT_MESSAGES,
    ...weights,
  };
}

export function compactLtmText(text: string | undefined, limit = 260) {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1).trim()}...` : value;
}

export function noteTextPreview(note: LtmNote, limit = 220) {
  return compactLtmText(
    note.sections.summary?.text.trim() ||
      note.sections.core?.text.trim() ||
      note.sections.source?.text.trim() ||
      Object.values(note.sections)[0]?.text.trim() ||
      "",
    limit,
  );
}

export function scopeDraftFromLtmScope(scope: LtmScope) {
  return {
    chatIds: scope.chatIds ?? (scope.chatId ? [scope.chatId] : []),
    groupId: scope.groupId ?? "",
    characterIds: scope.characterIds ?? [],
  };
}

export function mutationTarget(mutation: LtmDraftMutation) {
  if (mutation.kind === "create_note") return friendlyNoteTitle(mutation.note);
  if (mutation.kind === "add_link") {
    return `${friendlyIdentifier(mutation.noteId)} is related to ${friendlyIdentifier(mutation.link.target)}`;
  }
  return friendlyIdentifier(mutation.noteId);
}

export function mutationKindLabel(kind: LtmDraftMutation["kind"]) {
  switch (kind) {
    case "create_note":
      return "New memory";
    case "append_section":
      return "Add detail";
    case "update_section":
      return "Rewrite detail";
    case "add_link":
      return "Related memory";
    case "set_keywords":
      return "Keywords";
    case "set_status":
      return "Status change";
  }
}

export function mutationRiskLabel(risk: LtmDraftMutation["risk"]) {
  if (risk === "low") return "Low risk";
  if (risk === "medium") return "Review";
  return "Careful";
}

export function mutationRiskTone(risk: LtmDraftMutation["risk"]) {
  if (risk === "low") return "good";
  if (risk === "medium") return "warn";
  return "bad";
}

export function draftRiskSummary(draft: LtmExtractionDraft) {
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

export function sourceSummaryEvidence(note: LtmNote) {
  return note.sections.source?.evidence ?? [];
}

function firstSectionEntry(mutation: LtmDraftMutation) {
  if (mutation.kind !== "create_note") return null;
  return Object.entries(mutation.note.sections)[0] ?? null;
}

export function mutationTargetTitle(mutation: LtmDraftMutation) {
  if (mutation.kind === "create_note") return friendlyNoteTitle(mutation.note);
  return friendlyIdentifier(mutation.noteId);
}

export function compactMutationText(mutation: LtmDraftMutation, noteLookup: Map<string, LtmNote>) {
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
  if (mutation.kind === "set_keywords") return mutation.keywords.join(", ");
  if (mutation.kind === "set_status") return friendlyStatus(mutation.status);
  return "Unknown mutation";
}

export function suggestionRowKey(draftId: string, mutationId: string) {
  return `${draftId}:${mutationId}`;
}

export function sourceSummaryEvidenceValue(note: LtmNote, prefix: string) {
  const item = sourceSummaryEvidence(note).find((entry) => entry.startsWith(prefix));
  return item?.slice(prefix.length).trim();
}

export function sourceSummaryChatName(note: LtmNote, chatLookup?: Map<string, Chat>) {
  return sourceSummaryEvidenceValue(note, "chat_name:") || chatLookup?.get(note.scope.chatId ?? "")?.name || "Unknown Chat";
}

export function sourceSummaryMessageRange(note: LtmNote) {
  const evidenceRange = sourceSummaryEvidenceValue(note, "message_range:");
  if (evidenceRange) return evidenceRange;
  const idFallback = friendlyIdentifier(note.id)
    .replace(/^Summary\s+/i, "")
    .trim();
  return idFallback ? `unknown (${idFallback})` : "unknown";
}

export function isChatSummarySourceNote(note: LtmNote) {
  if (note.type === "source") {
    return (
      note.tags.includes("imported_chat") ||
      sourceSummaryEvidence(note).some((entry) => entry.startsWith("chat_name:") || entry.startsWith("message_range:"))
    );
  }
  return isLtmSourceLikeNote(note);
}

export function isSourceSummaryNote(note: LtmNote) {
  return note.type === "source" || isChatSummarySourceNote(note);
}

export function sourceSummaryTitle(note: LtmNote, chatLookup?: Map<string, Chat>) {
  const chatName = sourceSummaryChatName(note, chatLookup);
  const range = sourceSummaryMessageRange(note);
  return `${chatName}, msgs ${range}`;
}

export function sourceNoteTitle(note: LtmNote, chatLookup?: Map<string, Chat>) {
  if (note.title?.trim()) return note.title.trim();
  return isChatSummarySourceNote(note) ? sourceSummaryTitle(note, chatLookup) : friendlyNoteTitle(note);
}

export function sourceLinkIds(note: LtmNote) {
  return note.links.filter((link) => link.relation === "extracted_from").map((link) => link.target);
}

export function buildNoteLookup(notes: LtmNote[]) {
  return new Map(notes.map((note) => [note.id, note] as const));
}

export function noteReferenceLabel(noteId: string, noteLookup: Map<string, LtmNote>, chatLookup?: Map<string, Chat>) {
  const note = noteLookup.get(noteId);
  if (!note) return "Unknown memory";
  return isSourceSummaryNote(note) ? sourceNoteTitle(note, chatLookup) : displayNoteTitle(note);
}

export function sourceReferenceLabel(sourceNoteId: string, noteLookup: Map<string, LtmNote>, chatLookup?: Map<string, Chat>) {
  const note = noteLookup.get(sourceNoteId);
  return note ? sourceNoteTitle(note, chatLookup) : "Unknown source note";
}

export function memoryRowTitle(note: LtmNote, chatLookup?: Map<string, Chat>) {
  return isSourceSummaryNote(note) ? sourceNoteTitle(note, chatLookup) : displayNoteTitle(note);
}

export function timelineLinksForNote(note: LtmNote, noteLookup: Map<string, LtmNote>) {
  return note.links.filter((link) => {
    const target = noteLookup.get(link.target);
    return target?.type === "timeline_event" || TIMELINE_LINK_RELATIONS.has(link.relation);
  });
}

export function pendingConflictCount(note: LtmNote) {
  return note.conflicts?.filter((conflict) => conflict.resolution === "pending").length ?? 0;
}

export function isDerivedFromSource(note: LtmNote, sourceNoteId: string) {
  return note.links.some((link) => link.relation === "extracted_from" && link.target === sourceNoteId);
}

export function derivedNoteIdsForSources(notes: LtmNote[], sourceIds: Set<string>) {
  return notes
    .filter((note) => [...sourceIds].some((sourceId) => note.id !== sourceId && isDerivedFromSource(note, sourceId)))
    .map((note) => note.id);
}

export function uniqueNoteIds(ids: string[]) {
  return [...new Set(ids)];
}

export function groupNotesByType(notes: LtmNote[]): LtmBucketGroup[] {
  const groups = new Map<LtmNoteType, LtmNote[]>();
  for (const note of notes) {
    const rows = groups.get(note.type) ?? [];
    rows.push(note);
    groups.set(note.type, rows);
  }
  return [...groups.entries()]
    .map(([type, groupNotes]) => ({
      type,
      notes: groupNotes.sort((left, right) => displayNoteTitle(left).localeCompare(displayNoteTitle(right))),
    }))
    .sort(
      (left, right) =>
        (NOTE_TYPE_ORDER.get(left.type) ?? Number.MAX_SAFE_INTEGER) -
          (NOTE_TYPE_ORDER.get(right.type) ?? Number.MAX_SAFE_INTEGER) ||
        friendlyNoteType(left.type).localeCompare(friendlyNoteType(right.type)),
    );
}

export function sourceTypeLabel(note: LtmNote) {
  if (isChatSummarySourceNote(note)) return "Chat summary";
  if (note.tags.includes("imported_character")) return "Imported character";
  if (note.tags.includes("imported_lorebook")) return "Imported lorebook";
  return note.type === "source" ? "Source note" : "Manual memory";
}

export function mutationText(mutation: LtmDraftMutation) {
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
    case "set_keywords":
      return `Update keywords for ${friendlyIdentifier(mutation.noteId)}`;
    case "set_status":
      return `Mark ${friendlyIdentifier(mutation.noteId)} as ${friendlyStatus(mutation.status).toLowerCase()}`;
  }
}

// ── Shared small components ────────────────────

export function ModeBadge({ mode }: { mode: LtmMode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium ring-1 ring-inset ${MODE_BADGE_COLORS[mode]}`}
    >
      {MODE_LABELS[mode]}
    </span>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="px-1 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function DisclosureHeader({
  title,
  description,
  open,
  onToggle,
  children,
}: {
  title: string;
  description?: string;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={disclosureButtonClassName}
      aria-expanded={open}
    >
      <span className="min-w-0">
        <span className="block truncate">{title}</span>
        {description && (
          <span className="mt-0.5 block truncate text-[0.625rem] font-medium text-[var(--muted-foreground)]">
            {description}
          </span>
        )}
      </span>
      <span className="flex min-w-0 shrink items-center justify-end gap-1 overflow-hidden">
        {children}
        <span className="shrink-0">
          {open ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
        </span>
      </span>
    </button>
  );
}

export function sourceGroupNoteIds(group: SourceSummaryGroup) {
  return [group.source.id, ...group.derived.map((note) => note.id)];
}

export function derivedSourceGroups(notes: LtmNote[]) {
  const groups = new Map<string, { type: LtmNoteType; status: LtmStatus; notes: LtmNote[] }>();
  for (const note of notes) {
    const key = `${note.type}:${note.status}`;
    const group = groups.get(key) ?? { type: note.type, status: note.status, notes: [] };
    group.notes.push(note);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      (NOTE_TYPE_ORDER.get(left.type) ?? Number.MAX_SAFE_INTEGER) -
        (NOTE_TYPE_ORDER.get(right.type) ?? Number.MAX_SAFE_INTEGER) ||
      (NOTE_STATUS_ORDER.get(left.status) ?? Number.MAX_SAFE_INTEGER) -
        (NOTE_STATUS_ORDER.get(right.status) ?? Number.MAX_SAFE_INTEGER) ||
      friendlyNoteType(left.type).localeCompare(friendlyNoteType(right.type)),
  );
}
export function EvidencePills({
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
      {sourceIds.length > 0 && (
        <SourceInfoPopover
          sourceIds={sourceIds}
          noteLookup={noteLookup}
          chatLookup={chatLookup}
          onOpenSource={onOpenSource}
        />
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
      {missingSourceCount > 0 && <StatusPill label="Missing source note" tone="warn" />}
    </div>
  );
}

export function SourceInfoPopover({
  sourceIds,
  noteLookup,
  chatLookup,
  onOpenSource,
}: {
  sourceIds: string[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  onOpenSource?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; ready: boolean }>({ top: 0, left: 0, ready: false });
  const uniqueSourceIds = [...new Set(sourceIds)];

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  };

  useEffect(() => () => cancelClose(), []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !popoverRef.current) {
      setPos({ top: 0, left: 0, ready: false });
      return;
    }
    const trigger = triggerRef.current.getBoundingClientRect();
    const popover = popoverRef.current.getBoundingClientRect();
    const pad = 8;
    let top = trigger.bottom + 6;
    let left = trigger.left;

    left = Math.max(pad, Math.min(left, window.innerWidth - pad - popover.width));
    if (top + popover.height > window.innerHeight - pad) {
      top = trigger.top - 6 - popover.height;
    }
    top = Math.max(pad, Math.min(top, window.innerHeight - pad - popover.height));

    setPos({ top, left, ready: true });
  }, [open, uniqueSourceIds.length]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-[var(--secondary)]/70 px-2 py-0.5 text-[0.625rem] font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60"
        aria-expanded={open}
        aria-label={`Show ${uniqueSourceIds.length} source note${uniqueSourceIds.length === 1 ? "" : "s"}`}
      >
        <Info size="0.6875rem" />
        {uniqueSourceIds.length} source note{uniqueSourceIds.length === 1 ? "" : "s"}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            className="fixed z-[9999] w-[min(20rem,calc(100vw-1rem))] rounded-lg bg-[var(--popover)] p-2 text-[0.6875rem] text-[var(--popover-foreground)] shadow-xl ring-1 ring-[var(--border)]"
            style={{ top: pos.top, left: pos.left, visibility: pos.ready ? "visible" : "hidden" }}
          >
            <div className="mb-1.5 px-1 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
              Source notes
            </div>
            <div className="grid gap-1">
              {uniqueSourceIds.map((sourceId) => {
                const source = noteLookup.get(sourceId);
                const title = sourceReferenceLabel(sourceId, noteLookup, chatLookup);
                const content = (
                  <>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate font-medium text-[var(--foreground)]">{title}</span>
                      {source && <StatusPill label={friendlyStatus(source.status)} tone="neutral" />}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
                      {source ? noteTextPreview(source) || "Source has no summary text." : sourceId}
                    </p>
                  </>
                );

                if (!onOpenSource) {
                  return (
                    <div key={sourceId} className="rounded-md bg-[var(--secondary)]/35 p-2 ring-1 ring-[var(--border)]/70">
                      {content}
                    </div>
                  );
                }

                return (
                  <button
                    key={sourceId}
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setOpen(false);
                      onOpenSource(sourceId);
                    }}
                    className="rounded-md bg-[var(--secondary)]/35 p-2 text-left ring-1 ring-[var(--border)]/70 transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60"
                  >
                    {content}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
