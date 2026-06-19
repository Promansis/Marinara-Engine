import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Eye,
  FileJson,
  GitBranch,
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
  APIConnection,
  Chat,
  LtmDraftMutation,
  LtmExtractionDraft,
  LtmExtractionDroppedCandidate,
  LtmLink,
  LtmNote,
  LtmNoteType,
  LtmScope,
  LtmStatus,
} from "@marinara-engine/shared";
import {
  LTM_RECALL_STYLE_WEIGHTS,
  parseLongTermMemoryRecallStyle,
  readLtmRecallWeightOverrides,
} from "@marinara-engine/shared";
import {
  useImportLongTermMemorySourceNotes,
  useDeleteLongTermMemoryNotes,
  useLongTermMemoryDrafts,
  useLongTermMemoryImportPreview,
  useLongTermMemoryIntegrity,
  useLongTermMemoryNote,
  useLongTermMemoryNotes,
  useLongTermMemoryStatus,
  useRebuildLongTermMemory,
  useRepairLongTermMemory,
  useReplayLongTermMemory,
  useSearchLongTermMemory,
  type LtmSearchResponse,
  type LtmInteropSource,
  type LtmSourceExtractionMode,
} from "../../hooks/use-long-term-memory";
import { useChatStore } from "../../stores/chat.store";
import { useChat, useChatMessages, useChats, useUpdateChatMetadata } from "../../hooks/use-chats";
import { useCharacters } from "../../hooks/use-characters";
import { useConnections } from "../../hooks/use-connections";
import { cn } from "../../lib/utils";
import {
  readRememberedLtmAutoApplyLowRisk,
  rememberLtmAutoApplyLowRisk,
} from "../../lib/long-term-memory-preferences";
import {
  CreateLongTermMemoryNoteForm,
  type CreateLongTermMemoryNoteDraft,
} from "../long-term-memory/CreateLongTermMemoryNoteForm";
import { LongTermMemoryDebugLogModal } from "../long-term-memory/LongTermMemoryDebugLogModal";
import { LongTermMemoryExtractionSettingsModal } from "../long-term-memory/LongTermMemoryExtractionSettingsModal";
import { LongTermMemoryNoteEditor } from "../long-term-memory/LongTermMemoryNoteEditor";
import { LongTermMemorySuggestionsTab } from "../long-term-memory/LongTermMemorySuggestionsTab";
import {
  dedupeEvidenceEntries,
  displayNoteTitle,
  friendlyEvidence,
  friendlyIdentifier,
  friendlyMode,
  friendlyNoteTitle,
  friendlyNoteType,
  friendlySectionKey,
  friendlyStatus,
  humanMemoryTitle,
  humanRelationLabel,
  humanScopeLabel,
  humanScoreLabel,
  resolveEvidenceDisplay,
  sentenceCaseIdentifier,
  type LtmDisplayLookupContext,
  type LtmGroupLookup,
} from "../long-term-memory/ltm-editor-utils";
import {
  compactInputClassName,
  emptyStateClassName,
  helperTextClassName,
  inputClassName,
  listRowClassName,
  panelIntroCardClassName,
  selectedListRowClassName,
  sectionCardClassName,
  SettingField,
} from "../long-term-memory/LtmFields";
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
type LtmBucketGroup = {
  type: LtmNoteType;
  notes: LtmNote[];
};
type SourceSummaryGroup = {
  source: LtmNote;
  derived: LtmNote[];
  orphaned: boolean;
};
type MemoryModalMode = "view" | "edit";
type MemoryModalTab = "overview" | "content" | "links" | "recall" | "suggestions";
type LtmRecallStyle = "balanced" | "exact" | "broad" | "story";
type LtmNavigatorSelection = {
  groupId: string | null;
  chatId: string | null;
};
type LtmNavigatorThread = {
  id: string;
  groupId: string | null;
  title: string;
  chats: Chat[];
  representative: Chat;
  characterIds: string[];
  searchText: string;
};
type CharacterLookup = Map<string, { name: string }>;

const LTM_RECALL_STYLES: Array<{ id: LtmRecallStyle; label: string; description: string }> = [
  { id: "balanced", label: "Balanced", description: "Mixes meaning, exact wording, and linked story notes." },
  { id: "exact", label: "Exact", description: "Favors direct keyword and name matches." },
  { id: "broad", label: "Broad", description: "Looks farther through linked memories." },
  { id: "story", label: "Story", description: "Leans toward arcs, relationships, and scene continuity." },
];

const DEFAULT_LTM_BUDGET_TOKENS = 2048;
const DEFAULT_LTM_MAX_CHUNKS = 12;
const DEFAULT_LTM_SCORE_THRESHOLD = 0;
const DEFAULT_LTM_CONTEXT_MESSAGES = 4;
const DEFAULT_IMPORT_CONCURRENCY = 3;
const LTM_WEIGHT_MIN = 0;
const LTM_WEIGHT_MAX = 2;
const LTM_WEIGHT_STEP = 0.05;

const rowActionButtonClassName =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-45";

const rowActionGroupClassName = "flex shrink-0 items-center justify-end gap-0.5";

const rowActionOverlayClassName =
  "absolute right-2 bottom-2 flex shrink-0 items-center justify-end gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100";

const disclosureButtonClassName =
  "flex min-h-11 w-full items-center justify-between gap-3 rounded-xl bg-[var(--secondary)]/35 px-3 py-2 text-left text-xs font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)] transition-[background-color,box-shadow,color] hover:bg-[var(--accent)]/45 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60";

function importRowKey(source: LtmInteropSource, sourceId: string) {
  return `${source}:${sourceId}`;
}

function optionalTrimmedText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampImportConcurrency(value: number) {
  return Number.isFinite(value) ? Math.max(1, Math.min(10, Math.floor(value))) : DEFAULT_IMPORT_CONCURRENCY;
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

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function normalizeChatCharacterIds(value: unknown) {
  if (Array.isArray(value)) return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniqueStrings(parsed.filter((item): item is string => typeof item === "string"))
      : [];
  } catch {
    return value.trim() ? [value.trim()] : [];
  }
}

function characterNameFromRow(row: unknown) {
  const record = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const data = record.data;
  const parsed = typeof data === "string" ? parseMetadata(data) : parseMetadata(data);
  return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Unknown";
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
  return parseLongTermMemoryRecallStyle(metadata.longTermMemoryRecallStyle);
}

function readNumberSetting(metadata: Record<string, unknown>, key: string, fallback: number, min: number, max: number) {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function readScoreThresholdSetting(metadata: Record<string, unknown>) {
  const value = metadata.longTermMemoryScoreThreshold;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : DEFAULT_LTM_SCORE_THRESHOLD;
}

function readLongTermMemoryRecallSearchSettings(metadata: Record<string, unknown>) {
  const recallStyle = readRecallStyle(metadata);
  const styleWeights = LTM_RECALL_STYLE_WEIGHTS[recallStyle];
  const weights = readLtmRecallWeightOverrides(metadata, styleWeights);
  return {
    maxTokens: readNumberSetting(metadata, "longTermMemoryBudgetTokens", DEFAULT_LTM_BUDGET_TOKENS, 128, 16_384),
    maxChunks: readNumberSetting(metadata, "longTermMemoryMaxChunks", DEFAULT_LTM_MAX_CHUNKS, 1, 100),
    minScore: readScoreThresholdSetting(metadata),
    includeResolved: metadata.longTermMemoryIncludeResolved === true,
    contextMessages: readNumberSetting(
      metadata,
      "longTermMemoryRecallContextMessages",
      DEFAULT_LTM_CONTEXT_MESSAGES,
      1,
      20,
    ),
    ...weights,
  };
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

function buildNavigatorThreads(chats: Chat[] | undefined, characters: CharacterLookup): LtmNavigatorThread[] {
  const byThread = new Map<string, Chat[]>();
  for (const chat of chats ?? []) {
    const key = chat.groupId ? `group:${chat.groupId}` : `chat:${chat.id}`;
    byThread.set(key, [...(byThread.get(key) ?? []), chat]);
  }

  return [...byThread.entries()]
    .map(([id, groupChats]) => {
      const sortedChats = [...groupChats].sort((left, right) => {
        const updated = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
        return updated || (right.name || "").localeCompare(left.name || "");
      });
      const representative = sortedChats[0]!;
      const characterIds = uniqueStrings(sortedChats.flatMap((chat) => normalizeChatCharacterIds(chat.characterIds)));
      const characterNames = characterIds.map((id) => characters.get(id)?.name ?? "").filter(Boolean);
      return {
        id,
        groupId: representative.groupId,
        title: representative.name || "Untitled chat",
        chats: sortedChats,
        representative,
        characterIds,
        searchText: uniqueStrings([
          representative.name,
          representative.id,
          representative.groupId ?? undefined,
          ...sortedChats.flatMap((chat) => [chat.id, chat.name]),
          ...characterNames,
        ])
          .join(" ")
          .toLowerCase(),
      };
    })
    .sort((left, right) => new Date(right.representative.updatedAt).getTime() - new Date(left.representative.updatedAt).getTime());
}

function buildGroupLookup(threads: LtmNavigatorThread[]): LtmGroupLookup {
  return new Map(
    threads
      .filter((thread) => thread.groupId)
      .map((thread) => [
        thread.groupId!,
        {
          label: `${thread.title}, all branches`,
          rawId: thread.groupId ?? undefined,
        },
      ]),
  );
}

function findNavigatorThread(threads: LtmNavigatorThread[], selection: LtmNavigatorSelection) {
  if (selection.groupId) return threads.find((thread) => thread.groupId === selection.groupId) ?? null;
  if (selection.chatId) return threads.find((thread) => thread.chats.some((chat) => chat.id === selection.chatId)) ?? null;
  return null;
}

function selectedNavigatorChat(thread: LtmNavigatorThread | null, selection: LtmNavigatorSelection) {
  if (!thread) return null;
  return selection.chatId ? (thread.chats.find((chat) => chat.id === selection.chatId) ?? null) : null;
}

function scopeFromNavigatorSelection(thread: LtmNavigatorThread | null, selection: LtmNavigatorSelection): LtmScope {
  if (!thread) return {};
  const branch = selectedNavigatorChat(thread, selection);
  if (branch) {
    const characterIds = normalizeChatCharacterIds(branch.characterIds);
    return {
      chatId: branch.id,
      chatIds: [branch.id],
      ...(branch.groupId ? { groupId: branch.groupId } : {}),
      ...(characterIds.length ? { characterIds } : {}),
    };
  }
  if (thread.groupId) {
    return {
      groupId: thread.groupId,
      ...(thread.characterIds.length ? { characterIds: thread.characterIds } : {}),
    };
  }
  const chat = thread.representative;
  const characterIds = normalizeChatCharacterIds(chat.characterIds);
  return {
    chatId: chat.id,
    chatIds: [chat.id],
    ...(characterIds.length ? { characterIds } : {}),
  };
}

function noteFilterFromNavigatorScope(scope: LtmScope) {
  return {
    scopeChatIds: scope.chatIds ?? (scope.chatId ? [scope.chatId] : undefined),
    scopeGroupId: scope.groupId,
    scopeCharacterIds: scope.characterIds,
    includeGlobal: true,
  };
}

function scopeDraftFromLtmScope(scope: LtmScope) {
  return {
    chatIds: scope.chatIds ?? (scope.chatId ? [scope.chatId] : []),
    groupId: scope.groupId ?? "",
    characterIds: scope.characterIds ?? [],
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="px-1 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
        {title}
      </h3>
      {children}
    </section>
  );
}

function DisclosureHeader({
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

function LtmContextNavigator({
  threads,
  selection,
  activeChatId,
  scopeLabel,
  query,
  onQueryChange,
  onSelect,
}: {
  threads: LtmNavigatorThread[];
  selection: LtmNavigatorSelection;
  activeChatId: string | null;
  scopeLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (selection: LtmNavigatorSelection) => void;
}) {
  const filteredThreads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) => thread.searchText.includes(needle));
  }, [threads, query]);
  const selectedThread = findNavigatorThread(threads, selection);
  const selectedThreadId = selectedThread?.id ?? "";
  const selectedBranchId = selection.chatId ?? "";
  const followsActive = Boolean(activeChatId && selectedBranchId === activeChatId);

  return (
    <div className={cn(sectionCardClassName, "space-y-2")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill label={followsActive ? "Following active chat" : "Panel scope"} tone={followsActive ? "good" : "warn"} />
        <StatusPill label={scopeLabel} />
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 rounded-lg bg-[var(--secondary)] px-2.5 py-2 ring-1 ring-[var(--border)] focus-within:ring-2 focus-within:ring-[var(--ring)]/60">
            <Search size="0.8125rem" className="shrink-0 text-[var(--muted-foreground)]" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Find chat, branch, ID, or character"
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]/60"
            />
          </div>
          <select
            value={selectedThreadId}
            onChange={(event) => {
              const thread = threads.find((item) => item.id === event.target.value);
              if (thread) onSelect({ groupId: thread.groupId, chatId: thread.groupId ? null : thread.representative.id });
            }}
            className={compactInputClassName}
          >
            {filteredThreads.length === 0 && <option value={selectedThreadId}>No chats match</option>}
            {filteredThreads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.title} {thread.chats.length > 1 ? `(${thread.chats.length} branches)` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <div className="flex min-h-9 items-center gap-2 rounded-lg bg-[var(--secondary)]/45 px-2.5 text-xs text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
            <GitBranch size="0.8125rem" className="shrink-0" />
            <span className="truncate">Branch</span>
          </div>
          <select
            value={selectedBranchId}
            onChange={(event) => {
              if (!selectedThread) return;
              const chatId = event.target.value || null;
              onSelect({ groupId: selectedThread.groupId, chatId });
            }}
            disabled={!selectedThread || selectedThread.chats.length <= 1}
            className={compactInputClassName}
          >
            {selectedThread?.groupId && <option value="">All branches</option>}
            {selectedThread?.chats.map((chat) => (
              <option key={chat.id} value={chat.id}>
                {chat.name || "Untitled"} · {chat.id}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function NoteRow({
  note,
  open,
  onOpen,
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
  open: boolean;
  onOpen: () => void;
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
      className={cn("group", listRowClassName, (open || bulkSelected) && selectedListRowClassName)}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <div className={cn("grid min-w-0 gap-2", onSelect && "grid-cols-[auto_minmax(0,1fr)]")}>
          {onSelect && (            
              <input
                type="checkbox"
                checked={bulkSelected ?? false}
                onChange={(event) => onSelect(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                aria-label={`Select ${displayTitle}`}
              />           
          )}
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-[var(--foreground)]" title={displayTitle}>
              {displayTitle}
            </div>
            {primaryText && !showSourceSummary && (
              <div className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                {primaryText}
              </div>
            )}
            <div className="mt-1 flex min-w-0 flex-wrap gap-1">
              <StatusPill label={primaryLabel ?? (showSourceSummary ? "Source summary" : friendlyNoteType(note.type))} />
              {!showSourceSummary && (
                <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
              )}
              {note.extracted && <StatusPill label="Extracted" />}
              {sectionCount > 1 && <StatusPill label={`${sectionCount} details`} />}
            </div>
            {children}
          </div>
        </div>
        <div className={rowActionGroupClassName}>
          <button
            type="button"
            onClick={onOpen}
            className={cn(rowActionButtonClassName, open && "bg-[var(--accent)] text-[var(--foreground)]")}
            aria-label={`Open ${displayTitle}`}
            title="Open memory"
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
        </div>
      </div>
      {!hideTags && note.tags.length > 0 && (
        <div className="mt-2 truncate text-[0.625rem] text-[var(--muted-foreground)]" title={displayTitle}>
          {note.tags.map(friendlyIdentifier).join(", ")}
        </div>
      )}
    </article>
  );
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
  if (note.title?.trim()) return note.title.trim();
  return isChatSummarySourceNote(note) ? sourceSummaryTitle(note, chatLookup) : friendlyNoteTitle(note);
}

function sourceLinkIds(note: LtmNote) {
  return note.links.filter((link) => link.relation === "extracted_from").map((link) => link.target);
}

function buildNoteLookup(notes: LtmNote[]) {
  return new Map(notes.map((note) => [note.id, note] as const));
}

function noteReferenceLabel(noteId: string, noteLookup: Map<string, LtmNote>, chatLookup?: Map<string, Chat>) {
  const note = noteLookup.get(noteId);
  if (!note) return "Unknown Memory";
  return isSourceSummaryNote(note) ? sourceNoteTitle(note, chatLookup) : displayNoteTitle(note);
}

function sourceReferenceLabel(sourceNoteId: string, noteLookup: Map<string, LtmNote>, chatLookup?: Map<string, Chat>) {
  const note = noteLookup.get(sourceNoteId);
  return note ? sourceNoteTitle(note, chatLookup) : "Unknown Source";
}

function memoryRowTitle(note: LtmNote, chatLookup?: Map<string, Chat>) {
  return isSourceSummaryNote(note) ? sourceNoteTitle(note, chatLookup) : displayNoteTitle(note);
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

function derivedNoteIdsForSources(notes: LtmNote[], sourceIds: Set<string>) {
  return notes
    .filter((note) => [...sourceIds].some((sourceId) => note.id !== sourceId && isDerivedFromSource(note, sourceId)))
    .map((note) => note.id);
}

function uniqueNoteIds(ids: string[]) {
  return [...new Set(ids)];
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
      notes: groupNotes.sort((left, right) => displayNoteTitle(left).localeCompare(displayNoteTitle(right))),
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
      {missingSourceCount > 0 && <StatusPill label="Missing source" tone="warn" />}
    </div>
  );
}

function SourceInfoPopover({
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
        aria-label={`Show ${uniqueSourceIds.length} memory source${uniqueSourceIds.length === 1 ? "" : "s"}`}
      >
        <Info size="0.6875rem" />
        {uniqueSourceIds.length} source{uniqueSourceIds.length === 1 ? "" : "s"}
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
              Sources
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

function sourceGroupNoteIds(group: SourceSummaryGroup) {
  return [group.source.id, ...group.derived.map((note) => note.id)];
}

function TypeMemoryGroups({
  groups,
  noteLookup,
  expandedMemoryIds,
  expandedTypeIds,
  openNoteId,
  selectedNoteIds,
  derivedCountBySource,
  onToggleMemory,
  onToggleType,
  onOpen,
  onOpenSource,
  onSelect,
  onDelete,
  chatLookup,
}: {
  groups: LtmBucketGroup[];
  noteLookup: Map<string, LtmNote>;
  expandedMemoryIds: Set<string>;
  expandedTypeIds: Set<string>;
  openNoteId: string | null;
  selectedNoteIds: Set<string>;
  derivedCountBySource: Map<string, number>;
  onToggleMemory: (id: string) => void;
  onToggleType: (type: string) => void;
  onOpen: (id: string) => void;
  onOpenSource: (id: string) => void;
  onSelect: (id: string, selected: boolean) => void;
  onDelete: (note: LtmNote) => void;
  chatLookup?: Map<string, Chat>;
}) {
  if (groups.length === 0) {
    return (
      <p className={emptyStateClassName}>
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
            <DisclosureHeader
              title={friendlyNoteType(group.type)}
              description={`${group.notes.length} memor${group.notes.length === 1 ? "y" : "ies"}`}
              open={typeExpanded}
              onToggle={() => onToggleType(group.type)}
            >
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
            </DisclosureHeader>
            {typeExpanded && (
              <div className="mt-2 space-y-2">
                {group.notes.map((note) => {
                  const expanded = expandedMemoryIds.has(note.id);
                  const sourcesCount = sourceLinkIds(note).length;
                  const derivedCount = derivedCountBySource.get(note.id) ?? 0;
                  const selected = selectedNoteIds.has(note.id);
                  return (
                    <article
                      key={note.id}
                      className={cn(
                        "group relative",
                        listRowClassName,
                        (openNoteId === note.id || selected) && selectedListRowClassName,
                      )}
                    >
                      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2">
                        <div className="grid min-h-16 w-7 shrink-0 grid-rows-[auto_1fr] justify-items-center">
                          <button
                            type="button"
                            onClick={() => onToggleMemory(note.id)}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                            aria-label={expanded ? "Hide source details" : "Show source details"}
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
                          </button>
                          
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={(event) => onSelect(note.id, event.target.checked)}
                              className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                              aria-label={`Select ${memoryRowTitle(note, chatLookup)}`}
                            />
                          
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="min-w-0">
                            <div
                              className="truncate text-xs font-semibold text-[var(--foreground)]"
                              title={memoryRowTitle(note, chatLookup)}
                            >
                              {memoryRowTitle(note, chatLookup)}
                            </div>
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
                            {isSourceSummaryNote(note) && derivedCount > 0 && (
                              <StatusPill label={`${derivedCount} typed memor${derivedCount === 1 ? "y" : "ies"}`} />
                            )}
                          </div>
                          <EvidencePills
                            note={note}
                            noteLookup={noteLookup}
                            chatLookup={chatLookup}
                            onOpenSource={onOpenSource}
                          />
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
                                      onClick={() => onOpen(sourceId)}
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
                      <div className={rowActionOverlayClassName}>
                        <button
                          type="button"
                          onClick={() => onOpen(note.id)}
                          className={cn(
                            rowActionButtonClassName,
                            openNoteId === note.id && "bg-[var(--accent)] text-[var(--foreground)]",
                          )}
                          aria-label={`Open ${memoryRowTitle(note, chatLookup)}`}
                          title="Open memory"
                        >
                          <Eye size="0.875rem" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(note)}
                          className={cn(
                            rowActionButtonClassName,
                            "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]",
                          )}
                          aria-label={`Delete ${memoryRowTitle(note, chatLookup)}`}
                          title="Delete memory"
                        >
                          <Trash2 size="0.875rem" />
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

function _ArchivedSourceSummaryGroupRow({
  group,
  openNoteId,
  selectedNoteIds,
  onSelect,
  onOpen,
  onRestore,
  onDelete,
  chatLookup,
}: {
  group: SourceSummaryGroup;
  openNoteId: string | null;
  selectedNoteIds: Set<string>;
  onSelect: (ids: string[], selected: boolean) => void;
  onOpen: (id: string) => void;
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
        open={openNoteId === group.source.id}
        bulkSelected={selectedNoteIds.has(group.source.id)}
        onSelect={(selected) => onSelect([group.source.id], selected)}
        onOpen={() => onOpen(group.source.id)}
        onRestore={() => onRestore(group.source)}
        onDelete={() => onDelete(group.source)}
      />
    );
  }

  const sourceTitle = sourceNoteTitle(group.source, chatLookup);
  return (
    <article className={cn("group relative", listRowClassName)}>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2">
        <div className="grid min-h-12 w-8 shrink-0 justify-items-center">
          <label className="flex h-8 w-8 shrink-0 self-center items-center justify-center rounded-lg bg-[var(--background)]/55 ring-1 ring-[var(--border)]">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) => onSelect(groupIds, event.target.checked)}
              className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
              aria-label={`Select ${sourceTitle} group`}
            />
          </label>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-[var(--foreground)]" title={sourceTitle}>
            {sourceTitle}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusPill label={isChatSummarySourceNote(group.source) ? "Source summary" : "Source note"} />
            <StatusPill label={`${group.derived.length} typed memor${group.derived.length === 1 ? "y" : "ies"}`} />
          </div>
        </div>
      </div>
      <div className={rowActionOverlayClassName}>
        <button
          type="button"
          onClick={() => onOpen(group.source.id)}
          className={cn(
            rowActionButtonClassName,
            openNoteId === group.source.id && "bg-[var(--accent)] text-[var(--foreground)]",
          )}
          aria-label={`Open ${sourceTitle}`}
          title="Open source memory"
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
                  aria-label={`Select ${displayNoteTitle(derivedNote)}`}
                />
              </label>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-[var(--foreground)]">
                  {displayNoteTitle(derivedNote)}
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
                  onClick={() => onOpen(derivedNote.id)}
                  className={cn(
                    rowActionButtonClassName,
                    openNoteId === derivedNote.id && "bg-[var(--accent)] text-[var(--foreground)]",
                  )}
                  aria-label={`Open ${displayNoteTitle(derivedNote)}`}
                  title="Open memory"
                >
                  <Eye size="0.875rem" />
                </button>
                <button
                  type="button"
                  onClick={() => onRestore(derivedNote)}
                  className={cn(rowActionButtonClassName, "hover:bg-emerald-500/10 hover:text-emerald-200")}
                  aria-label={`Restore ${displayNoteTitle(derivedNote)}`}
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
                  aria-label={`Delete ${displayNoteTitle(derivedNote)}`}
                  title="Delete memory"
                >
                  <Trash2 size="0.875rem" />
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
      notes: group.notes.sort((left, right) => displayNoteTitle(left).localeCompare(displayNoteTitle(right))),
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

function GraphLinks({
  links,
  noteLookup,
  chatLookup,
  onOpenNote,
}: {
  links: LtmLink[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  onOpenNote?: (noteId: string) => void;
}) {
  if (links.length === 0) {
    return (
      <p className={emptyStateClassName}>
        No related memories yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {links.map((link, index) => {
        const label = noteReferenceLabel(link.target, noteLookup, chatLookup);
        const content = (
          <>
          <span className="shrink-0 rounded-md bg-[var(--muted)]/50 px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
            {humanRelationLabel(link.relation)}
          </span>
          <span className="min-w-0 truncate text-[var(--foreground)]" title={label}>
            {label}
          </span>
          </>
        );
        if (onOpenNote) {
          return (
            <button
              key={`${link.relation}-${link.target}-${index}`}
              type="button"
              onClick={() => onOpenNote(link.target)}
              className="flex w-full min-w-0 items-center gap-2 rounded-lg bg-[var(--secondary)]/45 px-3 py-2 text-left text-xs ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
            >
              {content}
            </button>
          );
        }
        return (
          <div
            key={`${link.relation}-${link.target}-${index}`}
            className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--secondary)]/45 px-3 py-2 text-xs ring-1 ring-[var(--border)]"
          >
            {content}
          </div>
        );
      })}
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
        <div className="flex items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
          <Loader2 className="mr-2 animate-spin" size="0.875rem" />
          Loading derived memories...
        </div>
      ) : groups.length === 0 ? (
        <p className={emptyStateClassName}>
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
                      {displayNoteTitle(derivedNote)}
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

function MemoryOverviewPanel({
  note,
  activeNotes,
  noteLookup,
  chatLookup,
  displayContext,
  activeNotesLoading,
  pendingSuggestionCount,
  onOpenNote,
}: {
  note: LtmNote;
  activeNotes: LtmNote[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  displayContext: LtmDisplayLookupContext;
  activeNotesLoading: boolean;
  pendingSuggestionCount: number;
  onOpenNote: (noteId: string) => void;
}) {
  const sourceIds = sourceLinkIds(note);
  const conflictCount = pendingConflictCount(note);
  const isSourceNote = isSourceSummaryNote(note);
  const derivedCount = activeNotes.filter((candidate) => candidate.id !== note.id && isDerivedFromSource(candidate, note.id)).length;

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={isSourceNote ? sourceTypeLabel(note) : friendlyNoteType(note.type)} />
          <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
          {note.modes.map((mode) => (
            <StatusPill key={mode} label={friendlyMode(mode)} />
          ))}
          {isSourceNote && <StatusPill label={`${derivedCount} linked memor${derivedCount === 1 ? "y" : "ies"}`} />}
          {pendingSuggestionCount > 0 && (
            <StatusPill
              label={`${pendingSuggestionCount} pending suggestion${pendingSuggestionCount === 1 ? "" : "s"}`}
              tone="warn"
            />
          )}
          {conflictCount > 0 && <StatusPill label={`${conflictCount} needs review`} tone="warn" />}
        </div>
        <div className="mt-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {humanScopeLabel(note, chatLookup, displayContext.groups)} · updated {new Date(note.updatedAt).toLocaleString()}
        </div>
      </div>

      <div className="rounded-lg bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]">
        <div className="text-xs font-semibold text-[var(--foreground)]">What this memory is about</div>
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">
          {noteTextPreview(note, 600) || "No memory text has been written yet."}
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="px-1 text-xs font-semibold text-[var(--foreground)]">Where it comes from</h3>
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
          <GraphLinks links={note.links} noteLookup={noteLookup} chatLookup={chatLookup} onOpenNote={onOpenNote} />
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

function MemoryContentsPanel({
  note,
  displayContext,
}: {
  note: LtmNote;
  displayContext: LtmDisplayLookupContext;
}) {
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
              {typeof section.salience === "number" && <StatusPill label={`Importance: ${humanScoreLabel(section.salience)}`} />}
              {typeof section.confidence === "number" && <StatusPill label={`Confidence: ${humanScoreLabel(section.confidence)}`} />}
            </div>
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">{section.text}</p>
          {(section.evidence ?? []).length > 0 && (
            <div className="mt-2 rounded-md bg-[var(--background)]/55 p-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
              <div className="mb-1 font-medium text-[var(--foreground)]">Evidence</div>
              <div className="flex flex-wrap gap-1.5">
                {dedupeEvidenceEntries(section.evidence ?? [], displayContext).map((entry) => {
                  const resolved = resolveEvidenceDisplay(entry, displayContext);
                  return <StatusPill key={`${key}-${entry}`} label={resolved.label} title={resolved.tooltip ?? resolved.label} />;
                })}
              </div>
            </div>
          )}
        </details>
      ))}
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

function _MemorySuggestionsPanel({
  note,
  drafts,
  noteLookup,
  chatLookup,
  _onViewDraft,
  onOpenSourceNote,
}: {
  note: LtmNote;
  drafts: LtmExtractionDraft[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  _onViewDraft: (draftId: string) => void;
  onOpenSourceNote: (noteId: string) => void;
}) {
  if (!isSourceSummaryNote(note)) {
    return (
      <p className={emptyStateClassName}>
        Suggestions live on source memories. Open a source summary to review extracted memory drafts.
      </p>
    );
  }

  if (drafts.length === 0) {
    return (
      <p className={emptyStateClassName}>
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
          onClick={() => _onViewDraft(draft.id)}
          className={cn("w-full text-left", listRowClassName)}
        >
          <div className="truncate text-xs font-semibold text-[var(--foreground)]">
            {draft.summary || "Untitled suggestion"}
          </div>
          <DraftMetadataPills draft={draft} noteLookup={noteLookup} chatLookup={chatLookup} onOpenSourceNote={onOpenSourceNote} />
        </button>
      ))}
    </div>
  );
}

function defaultMemoryModalTab(note: LtmNote): MemoryModalTab {
  return isSourceSummaryNote(note) ? "suggestions" : "overview";
}

function MemoryNoteModal({
  note,
  open,
  mode,
  activeTab,
  activeNotes,
  noteLookup,
  chatLookup,
  displayContext,
  activeNotesLoading,
  pendingDrafts,
  recallQuery,
  recallResult,
  recallPending,
  editorDirty,
  onClose,
  onModeChange,
  onTabChange,
  onOpenNote,
  onRecallQueryChange,
  onRunRecall,
  onEditorDirtyChange,
  onSaved,
  onRecoverDroppedCandidate,
}: {
  note: LtmNote | null;
  open: boolean;
  mode: MemoryModalMode;
  activeTab: MemoryModalTab;
  activeNotes: LtmNote[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  displayContext: LtmDisplayLookupContext;
  activeNotesLoading: boolean;
  pendingDrafts: LtmExtractionDraft[];
  recallQuery: string;
  recallResult: LtmSearchResponse | null;
  recallPending: boolean;
  editorDirty: boolean;
  onClose: () => void;
  onModeChange: (mode: MemoryModalMode) => void;
  onTabChange: (tab: MemoryModalTab) => void;
  onOpenNote: (noteId: string) => void;
  onRecallQueryChange: (query: string) => void;
  onRunRecall: () => void;
  onEditorDirtyChange: (dirty: boolean) => void;
  onSaved: (note: LtmNote) => void;
  onRecoverDroppedCandidate: (candidate: LtmExtractionDroppedCandidate, note: LtmNote) => void;
}) {
  const isSourceNote = note ? isSourceSummaryNote(note) : false;
  const tabs = useMemo(() => {
    if (!note) return [] as Array<{ id: MemoryModalTab; label: string }>;
    const hasLinks = note.links.length > 0 || sourceLinkIds(note).length > 0 || isSourceNote;
    return [
      { id: "overview" as const, label: "Overview" },
      { id: "content" as const, label: "Content" },
      ...(hasLinks || mode === "edit" ? [{ id: "links" as const, label: "Links" }] : []),
      ...(!isSourceNote ? [{ id: "recall" as const, label: "Recall" }] : []),
      ...(isSourceNote ? [{ id: "suggestions" as const, label: "Suggestions" }] : []),
    ];
  }, [isSourceNote, mode, note]);
  const safeActiveTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : tabs[0]?.id ?? "overview";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={note ? humanMemoryTitle(note, chatLookup) : "Memory"}
      width="max-w-4xl"
    >
      {note && (
        <div className="grid gap-4">
          <div className="grid gap-3 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[var(--foreground)]" title={humanMemoryTitle(note, chatLookup)}>
                {humanMemoryTitle(note, chatLookup)}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <StatusPill label={isSourceNote ? sourceTypeLabel(note) : friendlyNoteType(note.type)} />
                <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
                {note.modes.map((item) => (
                  <StatusPill key={item} label={friendlyMode(item)} />
                ))}
                {note.links.length > 0 && <StatusPill label={`${note.links.length} linked memor${note.links.length === 1 ? "y" : "ies"}`} />}
                {editorDirty && <StatusPill label="Unsaved changes" tone="warn" />}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              {mode === "view" ? (
                <ToolButton onClick={() => onModeChange("edit")}>
                  <Pencil size="0.875rem" />
                  Edit
                </ToolButton>
              ) : (
                <ToolButton onClick={() => onModeChange("view")}>
                  Cancel
                </ToolButton>
              )}
            </div>
          </div>

          {mode === "view" && (
            <>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--secondary)]/45 p-1 ring-1 ring-[var(--border)] sm:grid-cols-5">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => onTabChange(tab.id)}
                    className={cn(
                      "min-h-9 rounded-lg px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60",
                      safeActiveTab === tab.id
                        ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm ring-1 ring-[var(--border)]"
                        : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {safeActiveTab === "overview" && (
                <MemoryOverviewPanel
                  note={note}
                  activeNotes={activeNotes}
                  noteLookup={noteLookup}
                  chatLookup={chatLookup}
                  displayContext={displayContext}
                  activeNotesLoading={activeNotesLoading}
                  pendingSuggestionCount={pendingDrafts.length}
                  onOpenNote={onOpenNote}
                />
              )}
              {safeActiveTab === "content" && <MemoryContentsPanel note={note} displayContext={displayContext} />}
              {safeActiveTab === "links" && (
                <GraphLinks links={note.links} noteLookup={noteLookup} chatLookup={chatLookup} onOpenNote={onOpenNote} />
              )}
              {safeActiveTab === "recall" && !isSourceNote && (
                <MemoryRecallPanel
                  note={note}
                  result={recallResult}
                  pending={recallPending}
                  query={recallQuery}
                  onQueryChange={onRecallQueryChange}
                  onRun={onRunRecall}
                />
              )}
              {safeActiveTab === "suggestions" && isSourceNote && (
                <LongTermMemorySuggestionsTab note={note} onRecoverDroppedCandidate={onRecoverDroppedCandidate} />
              )}
            </>
          )}

          {mode === "edit" && (
            <LongTermMemoryNoteEditor
              note={note}
              onCancel={() => onModeChange("view")}
              onDirtyChange={onEditorDirtyChange}
              onSaved={onSaved}
              onRecoverDroppedCandidate={onRecoverDroppedCandidate}
              embedded
              displayContext={displayContext}
            />
          )}
        </div>
      )}
    </Modal>
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

function _ArchivedDraftRow({
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
      className={cn("group", listRowClassName, (selected || bulkSelected) && selectedListRowClassName)}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <div className={cn("grid min-w-0 gap-2", onSelect && "grid-cols-[auto_minmax(0,1fr)]")}>
          {onSelect && (           
              <input
                type="checkbox"
                checked={bulkSelected ?? false}
                onChange={(event) => onSelect(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                aria-label={`Select suggestion ${draft.id}`}
              />            
          )}
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-[var(--foreground)]" title={draft.summary || "Untitled suggestion"}>
              {draft.summary || "Untitled suggestion"}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap gap-1">
              <StatusPill label={draftStatusLabel(draft.status)} tone={draftStatusTone(draft.status)} />
              <StatusPill label={`${draft.mutations.length} suggested change${draft.mutations.length === 1 ? "" : "s"}`} />
            </div>
            <DraftMetadataPills draft={draft} noteLookup={noteLookup} chatLookup={chatLookup} onOpenSourceNote={onOpenSourceNote} />
          </div>
        </div>
        <div className={rowActionGroupClassName}>
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
        "group grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3",
        listRowClassName,
        selected && selectedListRowClassName,
      )}
    >
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.checked)}
          className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
          aria-label={`Select ${sample.title}`}
        />      
      <div className="min-w-0 self-center">
        <div className="truncate text-xs font-medium text-[var(--foreground)]" title={sample.title}>
          {sample.title}
        </div>
        {sample.snippet && (
          <div className="mt-1 truncate text-[10px] leading-relaxed text-[var(--muted-foreground)]" title={sample.snippet}>
            {sample.snippet}
          </div>
        )}        
      </div>
      <div className={rowActionGroupClassName}>
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
  integrity,
  rebuild,
  replay,
  repair,
}: {
  onOpenExtractionSettings: () => void;
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
  const recallSearchSettings = readLongTermMemoryRecallSearchSettings(metadata);
  const budgetValue = recallSearchSettings.maxTokens;
  const maxChunksValue = recallSearchSettings.maxChunks;
  const scoreThresholdValue = recallSearchSettings.minScore;
  const recallStyle = readRecallStyle(metadata);
  const includeResolved = metadata.longTermMemoryIncludeResolved === true;
  const weights = useMemo(
    () => readLtmRecallWeightOverrides(metadata, LTM_RECALL_STYLE_WEIGHTS[recallStyle]),
    [metadata, recallStyle],
  );
  const contextMessagesValue = readNumberSetting(
    metadata,
    "longTermMemoryRecallContextMessages",
    DEFAULT_LTM_CONTEXT_MESSAGES,
    1,
    20,
  );
  const [budgetDraft, setBudgetDraft] = useState(String(budgetValue));
  const [maxChunksDraft, setMaxChunksDraft] = useState(String(maxChunksValue));
  const [scoreThresholdDraft, setScoreThresholdDraft] = useState(scoreThresholdValue);
  const [contextMessagesDraft, setContextMessagesDraft] = useState(String(contextMessagesValue));
  const [semanticWeightDraft, setSemanticWeightDraft] = useState(String(weights.semanticWeight));
  const [lexicalWeightDraft, setLexicalWeightDraft] = useState(String(weights.lexicalWeight));
  const [graphWeightDraft, setGraphWeightDraft] = useState(String(weights.graphWeight));
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
    setSemanticWeightDraft(String(weights.semanticWeight));
    setLexicalWeightDraft(String(weights.lexicalWeight));
    setGraphWeightDraft(String(weights.graphWeight));
  }, [
    activeChat?.id,
    budgetValue,
    contextMessagesValue,
    maxChunksValue,
    scoreThresholdValue,
    weights.graphWeight,
    weights.lexicalWeight,
    weights.semanticWeight,
  ]);

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
    const next = Number.isFinite(numeric)
      ? Math.max(1, Math.min(20, Math.floor(numeric)))
      : DEFAULT_LTM_CONTEXT_MESSAGES;
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

  const readWeightDraft = (value: string, fallback: number, max = LTM_WEIGHT_MAX) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(LTM_WEIGHT_MIN, Math.min(max, Number(numeric.toFixed(2)))) : fallback;
  };

  const weightPatchKeyMap = {
    semantic: "longTermMemorySemanticWeight",
    lexical: "longTermMemoryLexicalWeight",
    graph: "longTermMemoryGraphWeight",
  } as const;

  const commitWeight = (key: "semantic" | "lexical" | "graph", value: string) => {
    const fallback = weights[`${key}Weight` as const];
    const next = readWeightDraft(value, fallback, 1);
    if (next === fallback) return Promise.resolve();
    return patch({ [weightPatchKeyMap[key]]: next });
  };

  const resetWeightOverrides = () => {
    setSemanticWeightDraft(String(LTM_RECALL_STYLE_WEIGHTS[recallStyle].semanticWeight));
    setLexicalWeightDraft(String(LTM_RECALL_STYLE_WEIGHTS[recallStyle].lexicalWeight));
    setGraphWeightDraft(String(LTM_RECALL_STYLE_WEIGHTS[recallStyle].graphWeight));
    return patch({
      longTermMemorySemanticWeight: null,
      longTermMemoryLexicalWeight: null,
      longTermMemoryGraphWeight: null,
      longTermMemoryMetadataWeight: null,
    });
  };

  const resetRecallDefaults = () => {
    setBudgetDraft(String(DEFAULT_LTM_BUDGET_TOKENS));
    setMaxChunksDraft(String(DEFAULT_LTM_MAX_CHUNKS));
    setScoreThresholdDraft(DEFAULT_LTM_SCORE_THRESHOLD);
    setContextMessagesDraft(String(DEFAULT_LTM_CONTEXT_MESSAGES));
    return patch({
      longTermMemoryBudgetTokens: DEFAULT_LTM_BUDGET_TOKENS,
      longTermMemoryMaxChunks: DEFAULT_LTM_MAX_CHUNKS,
      longTermMemoryScoreThreshold: DEFAULT_LTM_SCORE_THRESHOLD,
      longTermMemoryRecallContextMessages: DEFAULT_LTM_CONTEXT_MESSAGES,
      longTermMemoryRecallStyle: "balanced",
      longTermMemorySemanticWeight: null,
      longTermMemoryLexicalWeight: null,
      longTermMemoryGraphWeight: null,
      longTermMemoryMetadataWeight: null,
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
          <DisclosureHeader title="Recall" open={recallOpen} onToggle={() => setRecallOpen((c) => !c)} />
          {recallOpen && (
            <div className={sectionCardClassName}>
              <SettingToggle
                label="Use memory in prompts"
                checked={enabled}
                onChange={(checked) => patch({ enableLongTermMemory: checked })}
              />
              <SettingGroup label="Recall style">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--background)] p-1 ring-1 ring-[var(--border)]">
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
                Search uses recent chat text plus scope filters. Max memories is only a ceiling; relevance still decides what appears.
              </p>
              <DisclosureHeader
                title="Advanced recall"
                description="Resolved threads and score threshold"
                open={advancedOpen}
                onToggle={() => setAdvancedOpen((current) => !current)}
              />
              {advancedOpen && (
                <div className="grid gap-2 rounded-xl bg-[var(--background)]/75 p-2 shadow-inner ring-1 ring-[var(--border)]">
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
                      0 keeps all ranked matches. Higher values drop memories whose final weighted relevance is lower.
                    </p>
                  </SettingGroup>
                  <SettingGroup label="Lane weights">
                    <div className="space-y-2">
                      {[
                        {
                          label: "Semantic",
                          draft: semanticWeightDraft,
                          setDraft: setSemanticWeightDraft,
                          fallback: weights.semanticWeight,
                          max: 1,
                          key: "semantic" as const,
                        },
                        {
                          label: "Lexical",
                          draft: lexicalWeightDraft,
                          setDraft: setLexicalWeightDraft,
                          fallback: weights.lexicalWeight,
                          max: 1,
                          key: "lexical" as const,
                        },
                        {
                          label: "Graph",
                          draft: graphWeightDraft,
                          setDraft: setGraphWeightDraft,
                          fallback: weights.graphWeight,
                          max: 1,
                          key: "graph" as const,
                        },
                      ].map((item) => {
                        const inputId = `ltm-${item.key}-weight`;
                        return (
                          <div key={item.key} className="grid grid-cols-[4.5rem_1fr_4.75rem] items-center gap-3">
                            <label htmlFor={inputId} className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
                              {item.label}
                            </label>
                            <input
                              id={inputId}
                              type="range"
                              min={LTM_WEIGHT_MIN}
                              max={item.max}
                              step={LTM_WEIGHT_STEP}
                              value={item.draft}
                              onChange={(event) => item.setDraft(event.target.value)}
                              onPointerUp={(event) => commitWeight(item.key, (event.target as HTMLInputElement).value)}
                              onBlur={(event) => commitWeight(item.key, event.target.value)}
                              className="min-w-0 accent-[var(--primary)]"
                            />
                            <input
                              type="number"
                              min={LTM_WEIGHT_MIN}
                              max={item.max}
                              step={LTM_WEIGHT_STEP}
                              value={item.draft}
                              onChange={(event) => item.setDraft(event.target.value)}
                              onBlur={(event) => commitWeight(item.key, event.target.value)}
                              className={compactInputClassName}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                      The selected recall style sets the default mix. Set all three weights to 0 to disable LTM prompt injection. Metadata scopes only filter eligible memories.
                    </p>
                    <div className="mt-2">
                      <ToolButton onClick={resetWeightOverrides}>
                        <RotateCcw size="0.875rem" />
                        Reset lane weights
                      </ToolButton>
                    </div>
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

          <DisclosureHeader title="Extraction" open={extractionOpen} onToggle={() => setExtractionOpen((c) => !c)} />
          {extractionOpen && (
            <div className={sectionCardClassName}>
              <ToolButton onClick={onOpenExtractionSettings}>
                <SlidersHorizontal size="0.875rem" />
                Extraction settings
              </ToolButton>              
            </div>
          )}

          <DisclosureHeader
            title="Maintenance"
            open={maintenanceOpen}
            onToggle={() => setMaintenanceOpen((c) => !c)}
          />
          {maintenanceOpen && (
            <div className={sectionCardClassName}>
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

          <DisclosureHeader title="Debug" open={debugOpen} onToggle={() => setDebugOpen((c) => !c)} />
          {debugOpen && (
            <div className={sectionCardClassName}>
              <SettingToggle
                label="Debug retrieval logs"
                checked={debug}
                onChange={(checked) => patch({ longTermMemoryDebug: checked })}
              />
              <p className="text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                Detailed extraction diagnostics now stay in debug surfaces. Use source-memory Suggestions for kept and
                dropped candidate recovery.
              </p>
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
  const [importExtractionMode, setImportExtractionMode] = useState<LtmSourceExtractionMode>("fast");
  const [importConcurrency, setImportConcurrency] = useState(DEFAULT_IMPORT_CONCURRENCY);
  const [importApplyLowRisk, setImportApplyLowRisk] = useState(readRememberedLtmAutoApplyLowRisk);
  const [importConnectionId, setImportConnectionId] = useState("");
  const [importModel, setImportModel] = useState("");
  const [importInstruction, setImportInstruction] = useState("");
  const [importControlsOpen, setImportControlsOpen] = useState(true);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set());
  const [selectedImportRows, setSelectedImportRows] = useState<Set<string>>(() => new Set());
  const [activeImportIds, setActiveImportIds] = useState<Set<string>>(() => new Set());
  const [debugLogOpen, setDebugLogOpen] = useState(false);
  const [extractionSettingsOpen, setExtractionSettingsOpen] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const [createNoteDraft, setCreateNoteDraft] = useState<CreateLongTermMemoryNoteDraft | null>(null);
  const [createNoteDirty, setCreateNoteDirty] = useState(false);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const [memoryModalMode, setMemoryModalMode] = useState<MemoryModalMode>("view");
  const [memoryModalTab, setMemoryModalTab] = useState<MemoryModalTab>("overview");
  const [editedNoteDirty, setEditedNoteDirty] = useState(false);
  const [expandedTypeIds, setExpandedTypeIds] = useState<Set<string>>(() => new Set());
  const [expandedMemoryIds, setExpandedMemoryIds] = useState<Set<string>>(() => new Set());
  const [viewingDraftId, setViewingDraftId] = useState<string | null>(null);
  const [navigatorSelection, setNavigatorSelection] = useState<LtmNavigatorSelection>({ groupId: null, chatId: null });
  const [navigatorQuery, setNavigatorQuery] = useState("");

  const { data: chats } = useChats();
  const { data: characters } = useCharacters();
  const { data: connections } = useConnections();
  const chatLookup = useMemo(() => new Map((chats as Chat[] | undefined)?.map((c) => [c.id, c])), [chats]);
  const characterLookup = useMemo(() => {
    const map: CharacterLookup = new Map();
    for (const character of (characters ?? []) as Array<{ id?: unknown; data?: unknown }>) {
      if (typeof character.id === "string") map.set(character.id, { name: characterNameFromRow(character) });
    }
    return map;
  }, [characters]);
  const navigatorThreads = useMemo(
    () => buildNavigatorThreads(chats as Chat[] | undefined, characterLookup),
    [characterLookup, chats],
  );
  const groupLookup = useMemo(() => buildGroupLookup(navigatorThreads), [navigatorThreads]);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const cachedActiveChat = useChatStore((s) => s.activeChat);
  const activeChatQuery = useChat(activeChatId);
  const activeChat = activeChatQuery.data ?? cachedActiveChat;
  const selectedNavigatorThread = useMemo(
    () => findNavigatorThread(navigatorThreads, navigatorSelection),
    [navigatorSelection, navigatorThreads],
  );
  const navigatorScope = useMemo(
    () => scopeFromNavigatorSelection(selectedNavigatorThread, navigatorSelection),
    [navigatorSelection, selectedNavigatorThread],
  );
  const navigatorNoteFilter = useMemo(() => noteFilterFromNavigatorScope(navigatorScope), [navigatorScope]);
  const navigatorScopeLabel = useMemo(() => {
    const branch = selectedNavigatorChat(selectedNavigatorThread, navigatorSelection);
    if (branch) return branch.name || branch.id;
    if (selectedNavigatorThread?.groupId) return `${selectedNavigatorThread.title}, all branches`;
    return selectedNavigatorThread?.title ?? "No chat selected";
  }, [navigatorSelection, selectedNavigatorThread]);
  const activeChatMetadata = useMemo(() => parseMetadata(activeChat?.metadata), [activeChat?.metadata]);
  const activeRecallSettings = useMemo(
    () => readLongTermMemoryRecallSearchSettings(activeChatMetadata),
    [activeChatMetadata],
  );
  const activeChatMessages = useChatMessages(activeChatId, activeRecallSettings.contextMessages, Boolean(openNoteId));
  const textConnections = useMemo(
    () =>
      ((connections as APIConnection[] | undefined) ?? [])
        .filter((connection) => connection.provider !== "image_generation")
        .sort((left, right) => left.name.localeCompare(right.name)),
    [connections],
  );

  const status = useLongTermMemoryStatus();
  const integrity = useLongTermMemoryIntegrity();
  const notes = useLongTermMemoryNotes(navigatorNoteFilter, { enabled: Boolean(selectedNavigatorThread) });
  const activeNotes = useLongTermMemoryNotes(
    { ...navigatorNoteFilter, status: "active" },
    { enabled: tab === "notes" || Boolean(openNoteId) },
  );
  const allDrafts = useLongTermMemoryDrafts(
    {},
    {
      enabled:
        Boolean(openNoteId) ||
        Boolean(viewingDraftId),
    },
  );
  const exactViewingNote = useLongTermMemoryNote(openNoteId ?? undefined);
  const importPreview = useLongTermMemoryImportPreview(
    importSource,
    importLimit,
    importSource === "chats" ? navigatorScope : undefined,
  );
  const rebuild = useRebuildLongTermMemory();
  const replay = useReplayLongTermMemory();
  const repair = useRepairLongTermMemory();
  const deleteNotes = useDeleteLongTermMemoryNotes();
  const importSourceNotes = useImportLongTermMemorySourceNotes();
  const searchMemory = useSearchLongTermMemory();
  const [recallQueryByNoteId, setRecallQueryByNoteId] = useState<Record<string, string>>({});
  const [recallResultByNoteId, setRecallResultByNoteId] = useState<Record<string, LtmSearchResponse | null>>({});

  useEffect(() => {
    if (!activeChatId) return;
    setNavigatorSelection({ groupId: activeChat?.groupId ?? null, chatId: activeChatId });
  }, [activeChat?.groupId, activeChatId]);

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
        note.title?.toLowerCase().includes(needle) ||
        (isSourceSummaryNote(note) && sourceNoteTitle(note).toLowerCase().includes(needle)) ||
        note.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
        Object.values(note.sections).some((section) => section.text.toLowerCase().includes(needle)),
    );
  }, [noteStatus, noteType, notes.data, query]);
  const groupedBucketNotes = useMemo(() => groupNotesByType(filteredNotes), [filteredNotes]);
  const visibleNoteIds = useMemo(() => filteredNotes.map((note) => note.id), [filteredNotes]);
  const selectedVisibleNoteIds = useMemo(
    () => visibleNoteIds.filter((id) => selectedNoteIds.has(id)),
    [selectedNoteIds, visibleNoteIds],
  );
  const allVisibleNotesSelected =
    visibleNoteIds.length > 0 && visibleNoteIds.every((id) => selectedNoteIds.has(id));
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

  const combinedDrafts = useMemo(() => {
    const byId = new Map<string, LtmExtractionDraft>();
    for (const draft of allDrafts.data ?? []) byId.set(draft.id, draft);
    return [...byId.values()];
  }, [allDrafts.data]);
  const importRows = useMemo(() => importPreview.data?.samples ?? [], [importPreview.data?.samples]);
  const visibleImportRows = useMemo(
    () => {
      if (importSource !== "chats") return importRows;
      const scopeChatIds = navigatorScope.chatIds ?? (navigatorScope.chatId ? [navigatorScope.chatId] : []);
      if (scopeChatIds.length > 0) {
        const chatIds = new Set(scopeChatIds);
        return importRows.filter((sample) => chatIds.has(sample.sourceId.split(":")[0] ?? ""));
      }
      if (navigatorScope.groupId) {
        const groupChatIds = new Set(
          ((chats as Chat[] | undefined) ?? [])
            .filter((chat) => chat.groupId === navigatorScope.groupId)
            .map((chat) => chat.id),
        );
        return importRows.filter((sample) => groupChatIds.has(sample.sourceId.split(":")[0] ?? ""));
      }
      return importRows;
    },
    [chats, importRows, importSource, navigatorScope.chatId, navigatorScope.chatIds, navigatorScope.groupId],
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
  const displayContext = useMemo<LtmDisplayLookupContext>(
    () => ({ chats: chatLookup, notes: noteLookup, groups: groupLookup }),
    [chatLookup, noteLookup, groupLookup],
  );
  const statusTone = integrity.data?.ok ? "good" : integrity.data ? "bad" : "neutral";
  const openNote = useMemo(
    () =>
      openNoteId
        ? (combinedNotes.find((note) => note.id === openNoteId) ??
          (exactViewingNote.data?.id === openNoteId ? exactViewingNote.data : null))
        : null,
    [combinedNotes, exactViewingNote.data, openNoteId],
  );
  const viewingDraft = useMemo(
    () => (viewingDraftId ? (combinedDrafts.find((draft) => draft.id === viewingDraftId) ?? null) : null),
    [combinedDrafts, viewingDraftId],
  );
  const editedNoteFilteredOut = Boolean(openNote && !filteredNotes.some((note) => note.id === openNote.id));
  const editingNoteHiddenByFilters = Boolean(editedNoteFilteredOut && openNote && memoryModalMode === "edit");
  const viewingRecallQuery = openNote ? (recallQueryByNoteId[openNote.id] ?? "") : "";
  const viewingRecallResult = openNote ? (recallResultByNoteId[openNote.id] ?? null) : null;
  const recentRecallMessages = useMemo(
    () =>
      (activeChatMessages.data?.pages.flat() ?? [])
        .slice(-activeRecallSettings.contextMessages)
        .map((message) => message.content)
        .filter(Boolean),
    [activeChatMessages.data?.pages, activeRecallSettings.contextMessages],
  );
  const pendingDraftsForOpenNote = useMemo(
    () =>
      openNote
        ? combinedDrafts.filter(
            (draft) => draft.status === "pending" && draft.source.sourceNoteId === openNote.id,
          )
        : [],
    [combinedDrafts, openNote],
  );

  useEffect(() => {
    const availableIds = new Set((notes.data ?? []).map((note) => note.id));
    setSelectedNoteIds((current) => {
      const next = new Set([...current].filter((id) => availableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [notes.data]);

  const closeMemoryModal = () => {
    setOpenNoteId(null);
    setMemoryModalMode("view");
    setMemoryModalTab("overview");
    setEditedNoteDirty(false);
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
    if (memoryModalMode === "edit" && !confirmDiscardEditor()) return;
    if (creatingNote) closeCreateForm();
    if (openNoteId) closeMemoryModal();
    if (viewingDraftId) closeDraftViewer();
    setTab(nextTab);
  };

  const openMemory = (id: string, options: { mode?: MemoryModalMode; tab?: MemoryModalTab } = {}) => {
    if (openNoteId === id && memoryModalMode === (options.mode ?? "view")) return;
    if (memoryModalMode === "edit" && !confirmDiscardEditor()) return;
    if (creatingNote && !confirmDiscardCreate()) return;
    closeCreateForm();
    setViewingDraftId(null);
    setOpenNoteId(id);
    setMemoryModalMode(options.mode ?? "view");
    const nextNote = noteLookup.get(id) ?? openNote;
    if (nextNote) {
      setMemoryModalTab(options.tab ?? defaultMemoryModalTab(nextNote));
    }
    setEditedNoteDirty(false);
  };

  const closeOpenMemory = () => {
    if (memoryModalMode === "edit" && !confirmDiscardEditor()) return;
    closeMemoryModal();
  };

  const setMemoryModeWithGuard = (mode: MemoryModalMode) => {
    if (mode === memoryModalMode) return;
    if (memoryModalMode === "edit" && mode === "view" && !confirmDiscardEditor()) return;
    setMemoryModalMode(mode);
    setEditedNoteDirty(false);
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

  const requestCreateNote = () => {
    if (creatingNote) return;
    if (!confirmDiscardEditor()) return;
    closeMemoryModal();
    setEditedNoteDirty(false);
    closeDraftViewer();
    setCreatingNote(true);
  };

  const runViewingNoteRecall = async () => {
    if (!openNote) return;
    const recallQuery = viewingRecallQuery.trim();
    if (!recallQuery) return;
    try {
      const result = await searchMemory.mutateAsync({
        queryText: recallQuery,
        recentMessages: recentRecallMessages,
        noteIds: [openNote.id],
        scope: openNote.scope,
        characterIds: openNote.scope.characterIds,
        includeResolved: activeRecallSettings.includeResolved,
        maxChunks: activeRecallSettings.maxChunks,
        maxTokens: activeRecallSettings.maxTokens,
        minScore: activeRecallSettings.minScore,
        semanticWeight: activeRecallSettings.semanticWeight,
        lexicalWeight: activeRecallSettings.lexicalWeight,
        graphWeight: activeRecallSettings.graphWeight,
        metadataWeight: activeRecallSettings.metadataWeight,
        debug: true,
      });
      setRecallResultByNoteId((current) => ({ ...current, [openNote.id]: result }));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const openRecoveryDraft = (candidate: LtmExtractionDroppedCandidate, sourceNote: LtmNote) => {
    const sourceText = candidate.snippet?.trim();
    if (!sourceText) {
      toast.error("This dropped candidate does not include a safe snippet to recover.");
      return;
    }
    const recovery = candidate.recovery;
    const sourceEvidence = [`source_note:${sourceNote.id}`];
    const existingEvidence = sourceNote.sections.source?.evidence ?? sourceNote.sections.summary?.evidence ?? [];
    const nextEvidence = Array.from(new Set([...sourceEvidence, ...existingEvidence])).slice(0, 20);
    const defaultType = recovery?.noteType ?? "scene";
    const defaultId = recovery?.noteId ?? ({
      timeline_event: "timeline_",
      character: "char_",
      relationship: "rel_",
      scene: "scene_",
      thread: "thread_",
      world: "world_",
      tone: "tone_",
      source: "source_",
    } satisfies Record<LtmNoteType, string>)[defaultType];

    if (!confirmDiscardEditor() || !confirmDiscardCreate()) return;
    closeMemoryModal();
    closeDraftViewer();
    setCreateNoteDraft({
      type: defaultType,
      id: defaultId,
      title: "",
      status: recovery?.status ?? "active",
      modes: sourceNote.modes,
      tagsText: "",
      tags: ["typed_memory"],
      scopeDraft: {
        chatIds: sourceNote.scope.chatIds ?? (sourceNote.scope.chatId ? [sourceNote.scope.chatId] : []),
        groupId: sourceNote.scope.groupId ?? "",
        characterIds: sourceNote.scope.characterIds ?? [],
      },
      sectionKey: recovery?.sectionKey ?? "summary",
      sectionText: sourceText,
      links: [{ target: sourceNote.id, relation: "extracted_from" }],
      evidence: nextEvidence,
    });
    setCreatingNote(true);
  };

  const setNoteSelected = (id: string, selected: boolean) => {
    setSelectedNoteIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const setAllVisibleNotesSelected = (selected: boolean) => {
    setSelectedNoteIds((current) => {
      const next = new Set(current);
      for (const id of visibleNoteIds) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const deleteMemoriesById = async (ids: string[]) => {
    const uniqueIds = uniqueNoteIds(ids);
    if (uniqueIds.length === 0) return;

    try {
      const result = await deleteNotes.mutateAsync(uniqueIds);
      setSelectedNoteIds((current) => {
        const next = new Set(current);
        for (const id of result.deletedIds) next.delete(id);
        return next;
      });
      setExpandedMemoryIds((current) => {
        const next = new Set(current);
        for (const id of result.deletedIds) next.delete(id);
        return next;
      });
      if (openNoteId && result.deletedIds.includes(openNoteId)) {
        closeMemoryModal();
      }

      if (result.failedIds.length > 0) {
        toast.error(
          `${result.deletedIds.length} memor${result.deletedIds.length === 1 ? "y" : "ies"} deleted, ${result.failedIds.length} failed.`,
        );
      } else {
        toast.success(`${result.deletedIds.length} memor${result.deletedIds.length === 1 ? "y" : "ies"} deleted`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const confirmDerivedDeleteIds = (ids: string[]) => {
    const selectedIds = new Set(ids);
    const sourceIds = new Set(
      ids.filter((id) => {
        const note = noteLookup.get(id);
        return note ? isSourceSummaryNote(note) : false;
      }),
    );
    const unselectedDerivedIds = derivedNoteIdsForSources(combinedNotes, sourceIds).filter((id) => !selectedIds.has(id));
    if (unselectedDerivedIds.length === 0) return ids;

    const includeDerived = confirm(
      `${sourceIds.size} selected source memor${sourceIds.size === 1 ? "y has" : "ies have"} ${unselectedDerivedIds.length} derived memor${unselectedDerivedIds.length === 1 ? "y" : "ies"}. Delete derived memories too?`,
    );
    return includeDerived ? uniqueNoteIds([...ids, ...unselectedDerivedIds]) : ids;
  };

  const deleteMemory = (note: LtmNote) => {
    const title = memoryRowTitle(note, chatLookup);
    if (!confirm(`Permanently delete "${title}"? This cannot be undone.`)) return;
    void deleteMemoriesById(confirmDerivedDeleteIds([note.id]));
  };

  const deleteSelectedMemories = () => {
    const ids = selectedVisibleNoteIds;
    if (ids.length === 0) return;
    if (!confirm(`Permanently delete ${ids.length} selected memor${ids.length === 1 ? "y" : "ies"}? This cannot be undone.`)) {
      return;
    }
    void deleteMemoriesById(confirmDerivedDeleteIds(ids));
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
        scope: importSource === "chats" ? navigatorScope : undefined,
        connectionId: optionalTrimmedText(importConnectionId),
        model: optionalTrimmedText(importModel),
        instruction: optionalTrimmedText(importInstruction),
        applyLowRisk: importApplyLowRisk || undefined,
        importConcurrency: clampImportConcurrency(importConcurrency),
        extractionMode: importExtractionMode,
      });
      const importedCount = result.imported.length;
      const suggestionCount = result.imported.reduce(
        (sum, item) => sum + (item.outcome.suggestionCap?.returned ?? item.outcome.keptUnits),
        0,
      );
      const appliedCount = result.imported.reduce((sum, item) => sum + item.appliedMutationIds.length, 0);
      const skippedApplyCount = result.imported.reduce((sum, item) => sum + item.skippedMutationIds.length, 0);
      const droppedSourceCount = result.imported.filter((item) => item.outcome.droppedUnits > 0).length;
      const cappedSourceCount = result.imported.filter((item) => (item.outcome.suggestionCap?.capped ?? 0) > 0).length;
      const emptySourceCount = result.imported.filter((item) => item.outcome.keptUnits === 0).length;
      const missingCount = result.missingSourceIds.length;
      const summary = [
        `${importedCount} source note${importedCount === 1 ? "" : "s"} imported`,
        `${suggestionCount} suggestion${suggestionCount === 1 ? "" : "s"} created`,
        `${droppedSourceCount} source${droppedSourceCount === 1 ? "" : "s"} with dropped candidates`,
        `${emptySourceCount} source${emptySourceCount === 1 ? "" : "s"} with no usable suggestions`,
      ];
      if (cappedSourceCount > 0) {
        summary.push(
          `${cappedSourceCount} source${cappedSourceCount === 1 ? "" : "s"} hit the 25-suggestion review limit`,
        );
      }
      if (importApplyLowRisk) {
        summary.push(
          `${appliedCount} low-risk change${appliedCount === 1 ? "" : "s"} applied`,
          `${skippedApplyCount} change${skippedApplyCount === 1 ? "" : "s"} left for review`,
        );
      }
      if (missingCount > 0) {
        toast.error(`${summary.join(", ")}. Missing: ${result.missingSourceIds.slice(0, 3).join(", ")}`);
      } else {
        toast.success(summary.join(", "));
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
      <div className="sticky top-0 z-10 -mx-3 bg-[var(--background)]/95 px-3 py-2 backdrop-blur-sm">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--secondary)]/35 p-1 ring-1 ring-[var(--border)]/80">
            {(["notes", "tools", "import"] as TabId[]).map((id) => (
              <button
                key={id}
                onClick={() => setTabWithGuards(id)}
                className={cn(
                  "min-w-0 truncate rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60",
                  tab === id
                    ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                    : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                )}
              >
                {TAB_LABELS[id]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setDebugLogOpen(true)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--secondary)] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60"
            aria-label="Open memory debug log"
            title="Debug log"
          >
            <History size="0.875rem" />
          </button>
        </div>
      </div>

      {tab === "notes" && (
        <Section title="Memories">
          <div className={panelIntroCardClassName}>
            <div className="flex flex-wrap gap-1.5">
              <StatusPill label={`${(notes.data ?? []).length} memor${(notes.data ?? []).length === 1 ? "y" : "ies"}`} />
              <StatusPill label={`${status.data?.indexes.chunkCount ?? 0} search chunks`} />
              <StatusPill label={integrity.data?.ok ? "Healthy" : "Needs check"} tone={statusTone} />
              <StatusPill
                label={status.data?.indexes.embeddingsAvailable ? "Smart search" : "Basic search"}
                tone="neutral"
              />
            </div>
            <p className={cn("mt-2", helperTextClassName)}>
              Search, review, and maintain long-term memories.
            </p>
          </div>

          <LtmContextNavigator
            threads={navigatorThreads}
            selection={navigatorSelection}
            activeChatId={activeChatId}
            scopeLabel={navigatorScopeLabel}
            query={navigatorQuery}
            onQueryChange={setNavigatorQuery}
            onSelect={setNavigatorSelection}
          />

          {editingNoteHiddenByFilters && (
            <div className="mb-3 rounded-xl bg-amber-500/10 p-3 ring-1 ring-amber-500/30">
              <div className="text-xs font-medium text-amber-700 dark:text-amber-100">Open note is hidden by filters</div>
              <p className="mt-1 text-[0.6875rem] text-amber-700/80 dark:text-amber-100/80">
                The editor stays open so unsaved edits are not lost.
              </p>
            </div>
          )}
          <section className="space-y-3">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div className="flex items-center gap-2 rounded-xl bg-[var(--secondary)] px-3 py-2 shadow-sm ring-1 ring-[var(--border)] transition-shadow focus-within:ring-2 focus-within:ring-[var(--ring)]/60">
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
                className={compactInputClassName}
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
                className={compactInputClassName}
              >
                {NOTE_STATUSES.map((statusId) => (
                  <option key={statusId} value={statusId}>
                    {statusId === "all" ? "Any status" : friendlyStatus(statusId)}
                  </option>
                ))}
              </select>
            </div>
            {filteredNotes.length > 0 && (
              <div className={cn(sectionCardClassName, "flex flex-wrap items-center gap-2")}>
                <label className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-xs text-[var(--foreground)]">
                  <input
                    type="checkbox"
                    checked={allVisibleNotesSelected}
                    disabled={visibleNoteIds.length === 0 || deleteNotes.isPending}
                    onChange={(event) => setAllVisibleNotesSelected(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                  />
                  Select visible
                </label>
                <StatusPill
                  label={`${selectedVisibleNoteIds.length} selected`}
                  tone={selectedVisibleNoteIds.length > 0 ? "warn" : "neutral"}
                />
                {selectedVisibleNoteIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAllVisibleNotesSelected(false)}
                    disabled={deleteNotes.isPending}
                    className="rounded-lg px-2 py-1.5 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Clear selection
                  </button>
                )}
                <div className="ml-auto">
                  <ToolButton
                    onClick={deleteSelectedMemories}
                    disabled={selectedVisibleNoteIds.length === 0 || deleteNotes.isPending}
                    tone="danger"
                  >
                    {deleteNotes.isPending ? (
                      <Loader2 size="0.875rem" className="animate-spin" />
                    ) : (
                      <Trash2 size="0.875rem" />
                    )}
                    Delete selected
                  </ToolButton>
                </div>
              </div>
            )}
            <div className="space-y-2">
              {notes.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
              {!notes.isLoading && filteredNotes.length === 0 && (
                <p className={emptyStateClassName}>No matching memories.</p>
              )}
              {!notes.isLoading && filteredNotes.length > 0 && (
                <TypeMemoryGroups
                  groups={groupedBucketNotes}
                  noteLookup={noteLookup}
                  chatLookup={chatLookup}
                  expandedMemoryIds={expandedMemoryIds}
                  expandedTypeIds={expandedTypeIds}
                  openNoteId={openNoteId}
                  selectedNoteIds={selectedNoteIds}
                  derivedCountBySource={derivedCountBySource}
                  onToggleMemory={toggleExpandedMemory}
                  onToggleType={toggleExpandedType}
                  onOpen={(id) => openMemory(id, { mode: "view" })}
                  onOpenSource={(id) => openMemory(id, { mode: "view" })}
                  onSelect={setNoteSelected}
                  onDelete={deleteMemory}
                />
              )}
            </div>
          </section>
        </Section>
      )}

      {tab === "tools" && (
        <div className="space-y-3">
          <div className={panelIntroCardClassName}>
            <div className="flex flex-wrap gap-1.5">
              <StatusPill label={integrity.data?.ok ? "Healthy indexes" : "Needs maintenance"} tone={statusTone} />
              <StatusPill label={status.data?.indexes.embeddingsAvailable ? "Smart search" : "Basic search"} />
            </div>
            <p className={cn("mt-2", helperTextClassName)}>
              Tune recall, extraction, maintenance, and debug behavior.
            </p>
          </div>
          <ChatMemorySettings
            onOpenExtractionSettings={() => setExtractionSettingsOpen(true)}
            integrity={integrity}
            rebuild={rebuild}
            replay={replay}
            repair={repair}
          />
        </div>
      )}

      {tab === "import" && (
        <Section title="Import">
          <div className={panelIntroCardClassName}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--foreground)]">
                  {importPreview.data?.draftable ?? 0} source{importPreview.data?.draftable === 1 ? "" : "s"} ready
                </div>
              </div>
              {importPreview.isLoading ? <Loader2 className="animate-spin" size="1rem" /> : <FileJson size="1rem" />}
            </div>
          </div>

          {importSource === "chats" && (
            <LtmContextNavigator
              threads={navigatorThreads}
              selection={navigatorSelection}
              activeChatId={activeChatId}
              scopeLabel={navigatorScopeLabel}
              query={navigatorQuery}
              onQueryChange={setNavigatorQuery}
              onSelect={setNavigatorSelection}
            />
          )}

          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <select
              value={importSource}
              onChange={(event) => setImportSource(event.target.value as LtmInteropSource)}
              className={compactInputClassName}
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
              className={cn(compactInputClassName, "w-24")}
            />
          </div>
          <div className="mt-2">
            <select
              value={importExtractionMode}
              onChange={(event) => setImportExtractionMode(event.target.value as LtmSourceExtractionMode)}
              className={compactInputClassName}
            >
              <option value="fast">Fast extraction - skip memory lookup</option>
              <option value="balanced">Balanced extraction - merge-aware</option>
            </select>
          </div>
          <div className="mt-2 space-y-2">
            <DisclosureHeader
              title="Import controls"
              description={`${clampImportConcurrency(importConcurrency)} at once${
                importApplyLowRisk ? ", low-risk auto-apply" : ""
              }`}
              open={importControlsOpen}
              onToggle={() => setImportControlsOpen((current) => !current)}
            />
            {importControlsOpen && (
              <div className={cn(sectionCardClassName, "space-y-3")}>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem]">
                  <select
                    value={importConnectionId}
                    onChange={(event) => setImportConnectionId(event.target.value)}
                    className={compactInputClassName}
                  >
                    <option value="">Default extraction model</option>
                    <option value="random">Random pool</option>
                    {textConnections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name}
                        {connection.model ? ` - ${connection.model}` : ""}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={importConcurrency}
                    onChange={(event) => setImportConcurrency(Number(event.target.value))}
                    onBlur={() => setImportConcurrency((value) => clampImportConcurrency(value))}
                    className={compactInputClassName}
                    aria-label="Import concurrency"
                    title="How many source notes Marinara extracts at once"
                  />
                </div>
                <input
                  value={importModel}
                  onChange={(event) => setImportModel(event.target.value)}
                  placeholder="Optional model override"
                  className={compactInputClassName}
                />
                <textarea
                  value={importInstruction}
                  onChange={(event) => setImportInstruction(event.target.value)}
                  maxLength={2000}
                  rows={2}
                  placeholder="Optional instruction for this import"
                  className={cn(inputClassName, "min-h-16 resize-y text-xs")}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <SettingToggle
                    label="Apply low-risk suggestions after import"
                    checked={importApplyLowRisk}
                    onChange={(checked) => {
                      setImportApplyLowRisk(checked);
                      rememberLtmAutoApplyLowRisk(checked);
                    }}
                  />
                  <StatusPill
                    label={importExtractionMode === "fast" ? "Lower cost" : "Merge-aware"}
                    tone={importExtractionMode === "fast" ? "good" : "warn"}
                  />
                  {importApplyLowRisk && <StatusPill label="Review remains for riskier changes" tone="warn" />}
                </div>
                <p className={helperTextClassName}>
                  Higher concurrency can finish faster but may cost more at once. Low-risk auto-apply only accepts
                  suggestions already marked safe by extraction.
                </p>
              </div>
            )}
          </div>
          <div className={cn(sectionCardClassName, "mt-3")}>
            <div className="flex flex-wrap items-center gap-2">
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
          </div>

          <div className="mt-3 space-y-2">
            {importPreview.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
            {!importPreview.isLoading && visibleImportRows.length === 0 && (
              <p className={emptyStateClassName}>
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
          defaultScopeDraft={scopeDraftFromLtmScope(navigatorScope)}
          displayContext={displayContext}
          onCancel={() => {
            if (!confirmDiscardCreate()) return;
            closeCreateForm();
          }}
          onDirtyChange={setCreateNoteDirty}
          onDraftChange={setCreateNoteDraft}
          onCreated={(note) => {
            closeCreateForm();
            openMemory(note.id, { mode: "edit", tab: "overview" });
          }}
        />
      </Modal>

      <MemoryNoteModal
        note={openNote}
        open={Boolean(openNote)}
        mode={memoryModalMode}
        activeTab={memoryModalTab}
        activeNotes={activeNotes.data ?? []}
        noteLookup={noteLookup}
        chatLookup={chatLookup}
        displayContext={displayContext}
        activeNotesLoading={activeNotes.isLoading}
        pendingDrafts={pendingDraftsForOpenNote}
        recallQuery={viewingRecallQuery}
        recallResult={viewingRecallResult}
        recallPending={searchMemory.isPending}
        editorDirty={editedNoteDirty}
        onClose={closeOpenMemory}
        onModeChange={setMemoryModeWithGuard}
        onTabChange={setMemoryModalTab}
        onOpenNote={(id) => openMemory(id, { mode: "view" })}
        onRecallQueryChange={(next) => {
          if (!openNote) return;
          setRecallQueryByNoteId((current) => ({ ...current, [openNote.id]: next }));
        }}
        onRunRecall={runViewingNoteRecall}
        onEditorDirtyChange={setEditedNoteDirty}
        onSaved={(saved) => {
          setEditedNoteDirty(false);
          setOpenNoteId(saved.id);
          setMemoryModalMode("view");
          setMemoryModalTab(defaultMemoryModalTab(saved));
        }}
        onRecoverDroppedCandidate={openRecoveryDraft}
      />

      <Modal
        open={Boolean(viewingDraft)}
        onClose={closeDraftViewer}
        title={viewingDraft?.summary || "View Suggestion"}
        width="max-w-4xl"
      >
        {viewingDraft && (
          <DraftDetails
            draft={viewingDraft}
            noteLookup={noteLookup}
            chatLookup={chatLookup}
            onOpenSourceNote={(id) => openMemory(id, { mode: "view" })}
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
