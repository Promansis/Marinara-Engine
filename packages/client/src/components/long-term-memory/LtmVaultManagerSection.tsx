import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowRightLeft,
  Check,
  Copy,
  Eye,
  FileJson,
  Import,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Unlink2,
  X,
} from "lucide-react";
import type {
  Chat,
  LtmDraftMutation,
  LtmDraftReviewSource,
  LtmExtractionDraft,
  LtmExtractionDroppedCandidate,
  LtmMode,
  LtmNote,
  LtmScope,
  LtmNoteType,
  LtmStatus,
} from "@marinara-engine/shared";
import { getLtmScopeChatIds, ltmModeForChatMode } from "@marinara-engine/shared";
import {
  useAcceptLongTermMemoryDraft,
  useDeleteLongTermMemoryDraft,
  useImportLongTermMemorySourceNotes,
  useDeleteLongTermMemoryNotes,
  useLongTermMemoryDrafts,
  useLongTermMemoryDraftReview,
  useLongTermMemoryImportPreview,
  useLongTermMemoryNote,
  useLongTermMemoryNotes,
  useLongTermMemorySettings,
  useRemoveLongTermMemoryNotesFromScope,
  useSkipLongTermMemoryDraftMutations,
  useSearchLongTermMemory,
  type ImportLongTermMemorySourceNotesResponse,
  type LtmSearchResponse,
  type LtmInteropSource,
} from "../../hooks/use-long-term-memory";
import { useChatStore } from "../../stores/chat.store";
import { useChat, useChatMessages, useChats } from "../../hooks/use-chats";
import { useCharacters } from "../../hooks/use-characters";
import { cn } from "../../lib/utils";
import {
  CreateLongTermMemoryNoteForm,
  type CreateLongTermMemoryNoteDraft,
} from "../long-term-memory/CreateLongTermMemoryNoteForm";
import { LongTermMemoryDebugLogPanel } from "../long-term-memory/LongTermMemoryDebugLogModal";
import { MemoryNoteModal, defaultMemoryModalTab } from "../long-term-memory/LongTermMemoryNoteModal";
import { TypeMemoryGroups } from "../long-term-memory/LongTermMemoryNoteList";
import { ImportPreviewRowItem } from "../long-term-memory/LongTermMemoryImportSection";
import { SelectionActionBar, type SelectionActionBarAction } from "../ui/SelectionActionBar";
import {
  type LongTermMemoryLatestExtractionResult,
  useLtmExtractionResultsStore,
} from "../../stores/ltm-extraction-results.store";
import { LongTermMemoryNoteTransferModal } from "../long-term-memory/LongTermMemoryNoteTransferModal";
import { LongTermMemoryIdentityRepairSection } from "../long-term-memory/LongTermMemoryIdentityRepairSection";
import { LtmTabRail } from "../long-term-memory/LtmTabRail";
import {
  readLtmManagedExtractionPrefs,
  type LtmManagedExtractionPrefs,
} from "../long-term-memory/ltm-managed-extraction-prefs";
import {
  friendlyIdentifier,
  friendlyNoteType,
  friendlyStatus,
  type LtmDisplayLookupContext,
} from "../long-term-memory/ltm-editor-utils";
import {
  compactInputClassName,
  emptyStateClassName,
  helperTextClassName,
  panelIntroCardClassName,
  sectionCardClassName,
} from "../long-term-memory/LtmFields";
import {
  buildNavigatorGroupLookup,
  buildNavigatorThreads,
  findNavigatorThread,
  LtmNavigatorSelector,
  navigatorSelectionLabel,
  normalizeChatCharacterIds,
  noteFilterFromNavigatorScope,
  selectedNavigatorChat,
  scopeFromNavigatorSelection,
  type CharacterLookup,
  type LtmNavigatorSelection,
} from "../long-term-memory/ltm-navigator";
import { StatusPill, ToolButton } from "../long-term-memory/LtmPills";
import { LtmModal } from "./LtmModal";
import { showConfirmDialog } from "../../lib/app-dialogs";
import {
  IMPORT_SOURCES,
  MODE_LABELS,
  NOTE_STATUSES,
  NOTE_TYPES,
  TAB_LABELS,
  buildNoteLookup,
  characterNameFromRow,
  clampImportConcurrency,
  derivedNoteIdsForSources,
  groupNotesByType,
  importRowKey,
  isSourceSummaryNote,
  memoryRowTitle,
  optionalTrimmedText,
  parseMetadata,
  readLongTermMemoryRecallSearchSettings,
  scopeDraftFromLtmScope,
  sourceNoteTitle,
  uniqueNoteIds,
  ModeBadge,
  DisclosureChevron,
  Section,
  type MemoryModalMode,
  type MemoryModalTab,
  type TabId,
} from "../long-term-memory/ltm-panel-shared";
import { useUpdateAgentByType, type AgentConfigRow } from "../../hooks/use-agents";

type LtmImportSource = "characters" | "lorebooks" | "chats";
const LTM_TAB_IDS: TabId[] = ["notes", "import", "review", "debug"];

type RemovableLtmScope = {
  chatIds?: string[];
  groupId?: string;
  characterIds?: string[];
};

interface LtmVaultManagerSectionProps {
  agentConfig: AgentConfigRow;
  agentSettings: Record<string, unknown>;
  initialTab?: TabId | "suggestions";
  sourceNoteId?: string;
}

function extractPanelPrefs(settings: Record<string, unknown>) {
  const rawImportSource = settings.importSource;
  const importSource: LtmImportSource =
    rawImportSource === "characters" || rawImportSource === "lorebooks" || rawImportSource === "chats"
      ? rawImportSource
      : "chats";
  return {
    ...readLtmManagedExtractionPrefs(settings),
    importConcurrency:
      typeof settings.importConcurrency === "number"
        ? Math.max(1, Math.min(10, Math.round(settings.importConcurrency)))
        : 3,
    importLimit: 100,
    importSource,
  };
}

function hasRemovableLtmScope(scope: RemovableLtmScope | null | undefined) {
  return Boolean(scope && ((scope.chatIds?.length ?? 0) > 0 || scope.groupId || (scope.characterIds?.length ?? 0) > 0));
}

function removableScopeForContext(noteScope: LtmScope, contextScope: LtmScope): RemovableLtmScope | null {
  const contextChatIds = new Set(getLtmScopeChatIds(contextScope));
  const contextCharacterIds = new Set(contextScope.characterIds ?? []);
  const chatIds = getLtmScopeChatIds(noteScope).filter((chatId) => contextChatIds.has(chatId));
  const groupId = noteScope.groupId && noteScope.groupId === contextScope.groupId ? noteScope.groupId : undefined;
  const characterIds = (noteScope.characterIds ?? []).filter((characterId) => contextCharacterIds.has(characterId));
  const scope = {
    ...(chatIds.length > 0 ? { chatIds } : {}),
    ...(groupId ? { groupId } : {}),
    ...(characterIds.length > 0 ? { characterIds } : {}),
  };
  return hasRemovableLtmScope(scope) ? scope : null;
}

function removeScopeLinks(scope: LtmScope, removal: RemovableLtmScope): LtmScope {
  const chatIdsToRemove = new Set(removal.chatIds ?? []);
  const characterIdsToRemove = new Set(removal.characterIds ?? []);
  const chatIds = getLtmScopeChatIds(scope).filter((chatId) => !chatIdsToRemove.has(chatId));
  const characterIds = (scope.characterIds ?? []).filter((characterId) => !characterIdsToRemove.has(characterId));
  const next: LtmScope = {};
  if (chatIds.length > 0) {
    next.chatId = chatIds[0];
    next.chatIds = chatIds;
  }
  if (scope.groupId && scope.groupId !== removal.groupId) next.groupId = scope.groupId;
  if (characterIds.length > 0) next.characterIds = characterIds;
  return next;
}

function scopeHasLinks(scope: LtmScope) {
  return getLtmScopeChatIds(scope).length > 0 || Boolean(scope.groupId) || Boolean(scope.characterIds?.length);
}

function QueryFailure({
  label,
  error,
  stale = false,
  onRetry,
}: {
  label: string;
  error: unknown;
  stale?: boolean;
  onRetry: () => void;
}) {
  const detail = error instanceof Error && error.message ? error.message : "The request failed.";
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--destructive)]/25 bg-[var(--destructive)]/5 px-3 py-2"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs font-semibold text-[var(--foreground)]">
          <AlertCircle size="0.875rem" className="shrink-0 text-[var(--destructive)]" />
          {stale ? `${label} could not refresh` : `${label} could not load`}
        </div>
        <details className="mt-1 text-[0.6875rem] text-[var(--muted-foreground)]">
          <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60">
            Technical details
          </summary>
          <p className="mt-1 break-words">{detail}</p>
        </details>
      </div>
      <ToolButton onClick={onRetry}>
        <RotateCcw size="0.75rem" />
        Retry
      </ToolButton>
    </div>
  );
}

function reviewDispositionLabel(disposition: "new" | "merge" | "rewrite") {
  if (disposition === "new") return "New";
  if (disposition === "merge") return "Merge";
  return "Rewrite";
}

function ReviewSourceDiagnostics({ source }: { source: LtmDraftReviewSource }) {
  const blockReasons = source.drafts.flatMap((draftReview) => draftReview.blockReasons);
  const diagnostics = source.drafts.flatMap((draftReview) => draftReview.diagnostics);
  const candidateRejections = source.drafts.flatMap((draftReview) => draftReview.candidateRejections);
  const deduplications = source.drafts.flatMap((draftReview) => draftReview.deduplications);
  const detailCount = diagnostics.length + candidateRejections.length + deduplications.length;

  return (
    <>
      {blockReasons.map((reason, index) => (
        <div
          key={`${reason.code}-${index}`}
          role="alert"
          className="mt-2 flex gap-2 rounded-lg bg-[var(--destructive)]/5 px-2.5 py-2 text-xs ring-1 ring-[var(--destructive)]/20"
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
      {detailCount > 0 ? (
        <details className="mt-2 rounded-lg bg-[var(--background)]/35 px-2.5 py-2 ring-1 ring-[var(--border)]/60">
          <summary className="cursor-pointer text-xs font-medium text-[var(--foreground)]">
            Extraction details ({detailCount})
          </summary>
          <div className="mt-2 space-y-2">
            {diagnostics.map((diagnostic, index) => (
              <p key={`${diagnostic.code}-${index}`} className="break-words text-xs text-[var(--muted-foreground)]">
                {diagnostic.message} <code className="break-all">{diagnostic.code}</code>
              </p>
            ))}
            {candidateRejections.map((candidate) => (
              <p
                key={`${candidate.index}-${candidate.reason}`}
                className="break-words text-xs text-[var(--muted-foreground)]"
              >
                {candidate.message} <code className="break-all">{candidate.reason}</code>
              </p>
            ))}
            {deduplications.map((diagnostic, index) => (
              <p
                key={`${diagnostic.code}-dedup-${index}`}
                className="break-words text-xs text-[var(--muted-foreground)]"
              >
                {diagnostic.message} <code className="break-all">{diagnostic.code}</code>
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}

function ReviewTargetSummary({ target }: { target: LtmDraftReviewSource["targets"][number] }) {
  const dispositions = (["new", "merge", "rewrite"] as const)
    .map((disposition) => ({
      disposition,
      count: target.rows.filter((row) => row.disposition === disposition).length,
    }))
    .filter((item) => item.count > 0);
  const warningCount = target.rows.reduce((sum, row) => sum + row.diagnostics.length, 0);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)]/45 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-[var(--foreground)]">
          {target.title ?? friendlyIdentifier(target.noteId)}
        </p>
        <p className="mt-0.5 text-[0.6875rem] text-[var(--muted-foreground)]">
          {friendlyNoteType(target.noteType)}: {target.rows.length} change{target.rows.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {dispositions.map(({ disposition, count }) => (
          <StatusPill key={disposition} label={`${count} ${reviewDispositionLabel(disposition)}`} />
        ))}
        {warningCount > 0 ? (
          <StatusPill label={`${warningCount} warning${warningCount === 1 ? "" : "s"}`} tone="warn" />
        ) : null}
      </div>
    </div>
  );
}

export function LtmVaultManagerSection({
  agentConfig: _agentConfig,
  agentSettings,
  initialTab,
  sourceNoteId,
}: LtmVaultManagerSectionProps) {
  const panelPrefs = useMemo(() => extractPanelPrefs(agentSettings ?? {}), [agentSettings]);
  const importLimit = panelPrefs.importLimit;
  const importSource = panelPrefs.importSource;

  const updateAgentByType = useUpdateAgentByType();

  // One-time client migration: read old ltmPanelPreferences from localStorage
  // and merge into agent settings, then clear the old key.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("ui-store");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const oldPrefs: Record<string, unknown> | undefined = parsed?.state?.ltmPanelPreferences;
      if (!oldPrefs) return;

      const relevantFields: Array<keyof ReturnType<typeof extractPanelPrefs>> = [
        "autoApplyLowRisk",
        "connectionId",
        "importConcurrency",
        "importSource",
        "instruction",
        "model",
      ];
      const hasRelevantValue = relevantFields.some(
        (f) => oldPrefs[f] !== undefined && oldPrefs[f] !== "" && oldPrefs[f] !== false,
      );
      if (!hasRelevantValue) return;

      const merged = { ...agentSettings, ...oldPrefs };
      updateAgentByType.mutate({ agentType: "long-term-memory", settings: merged });
      const newState = { ...parsed };
      delete newState.state?.ltmPanelPreferences;
      window.localStorage.setItem("ui-store", JSON.stringify(newState));
    } catch {
      // Silently ignore migration errors
    }
  }, [agentSettings, updateAgentByType]);

  const handlePrefsChange = useCallback(
    (partial: Partial<ReturnType<typeof extractPanelPrefs>>) => {
      const merged = { ...agentSettings, ...partial };
      updateAgentByType.mutate({ agentType: "long-term-memory", settings: merged });
    },
    [agentSettings, updateAgentByType],
  );

  const initialTabId: TabId =
    initialTab === "review"
      ? "review"
      : initialTab === "import"
        ? "import"
        : initialTab === "debug"
          ? "debug"
          : "notes";
  const [tab, setTab] = useState<TabId>(initialTabId);
  const [noteType, setNoteType] = useState<"all" | LtmNoteType>("all");
  const [noteStatus, setNoteStatus] = useState<"all" | LtmStatus>("all");
  const [noteMode, setNoteMode] = useState<"all" | LtmMode>("all");
  const [query, setQuery] = useState("");
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set());
  const [selectedImportRows, setSelectedImportRows] = useState<Set<string>>(() => new Set());
  const [activeImportIds, setActiveImportIds] = useState<Set<string>>(() => new Set());
  const [lastImportResult, setLastImportResult] = useState<ImportLongTermMemorySourceNotesResponse | null>(null);
  const [importedRowsOpen, setImportedRowsOpen] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const [createNoteDraft, setCreateNoteDraft] = useState<CreateLongTermMemoryNoteDraft | null>(null);
  const [createNoteDirty, setCreateNoteDirty] = useState(false);
  const resultsBySourceNoteId = useLtmExtractionResultsStore((s) => s.resultsBySourceNoteId);
  const setExtractionResult = useLtmExtractionResultsStore((s) => s.setResult);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const [memoryModalMode, setMemoryModalMode] = useState<MemoryModalMode>("view");
  const [memoryModalTab, setMemoryModalTab] = useState<MemoryModalTab>("overview");
  const [transferModalMode, setTransferModalMode] = useState<"copy" | "move" | null>(null);
  const [editedNoteDirty, setEditedNoteDirty] = useState(false);
  const [expandedTypeIds, setExpandedTypeIds] = useState<Set<string>>(() => new Set());
  const [expandedMemoryIds, setExpandedMemoryIds] = useState<Set<string>>(() => new Set());
  const [navigatorSelection, setNavigatorSelection] = useState<LtmNavigatorSelection>({ groupId: null, chatId: null });
  const [navigatorQuery, setNavigatorQuery] = useState("");
  const [importMode, setImportMode] = useState<LtmMode>("roleplay");
  const [reviewBatchAction, setReviewBatchAction] = useState<"keep-low" | "skip-all" | null>(null);
  const reviewBatchLockRef = useRef(false);
  const importAbortControllerRef = useRef<AbortController | null>(null);

  const { data: chats } = useChats();
  const { data: characters } = useCharacters();
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
  const groupLookup = useMemo(() => buildNavigatorGroupLookup(navigatorThreads), [navigatorThreads]);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const followsActive = Boolean(activeChatId && navigatorSelection.chatId === activeChatId);
  const cachedActiveChat = useChatStore((s) => s.activeChat);
  const activeChatQuery = useChat(activeChatId);
  const activeChat = activeChatQuery.data ?? cachedActiveChat;
  const globalSettings = useLongTermMemorySettings();
  const ltmSettings = globalSettings.data;
  const importApplyLowRisk = panelPrefs.autoApplyLowRisk;
  const importConnectionId = panelPrefs.connectionId;
  const importConcurrencySetting = panelPrefs.importConcurrency;
  const importInstruction = panelPrefs.instruction;
  const importModel = panelPrefs.model;
  const extractionPrefs = useMemo<LtmManagedExtractionPrefs>(
    () => ({
      autoApplyLowRisk: panelPrefs.autoApplyLowRisk,
      connectionId: panelPrefs.connectionId,
      instruction: panelPrefs.instruction,
      model: panelPrefs.model,
    }),
    [panelPrefs.autoApplyLowRisk, panelPrefs.connectionId, panelPrefs.instruction, panelPrefs.model],
  );
  const sourceNoteOpenedRef = useRef<string | null>(null);
  const selectedNavigatorThread = useMemo(
    () => findNavigatorThread(navigatorThreads, navigatorSelection),
    [navigatorSelection, navigatorThreads],
  );
  const navigatorScope = useMemo(
    () => scopeFromNavigatorSelection(selectedNavigatorThread, navigatorSelection),
    [navigatorSelection, selectedNavigatorThread],
  );
  const navigatorNoteFilter = useMemo(() => noteFilterFromNavigatorScope(navigatorScope), [navigatorScope]);
  const navigatorScopeLabel = useMemo(
    () => navigatorSelectionLabel(selectedNavigatorThread, navigatorSelection),
    [navigatorSelection, selectedNavigatorThread],
  );
  const selectedRecallChat = useMemo(
    () => selectedNavigatorChat(selectedNavigatorThread, navigatorSelection),
    [navigatorSelection, selectedNavigatorThread],
  );
  const selectedRecallMetadata = useMemo(
    () => (selectedRecallChat ? parseMetadata(selectedRecallChat.metadata) : {}),
    [selectedRecallChat],
  );
  const selectedRecallSettings = useMemo(
    () =>
      readLongTermMemoryRecallSearchSettings(
        ltmSettings,
        selectedRecallMetadata,
        selectedRecallChat?.mode ?? "roleplay",
      ),
    [ltmSettings, selectedRecallChat?.mode, selectedRecallMetadata],
  );
  const selectedRecallCharacterIds = useMemo(
    () => (selectedRecallChat ? normalizeChatCharacterIds(selectedRecallChat.characterIds) : []),
    [selectedRecallChat],
  );
  const selectedRecallCharacterNames = useMemo(
    () =>
      selectedRecallCharacterIds
        .map((characterId) => characterLookup.get(characterId)?.name)
        .filter((name): name is string => Boolean(name)),
    [characterLookup, selectedRecallCharacterIds],
  );
  const selectedImportChatMode = useMemo<LtmMode | null>(() => {
    if (importSource !== "chats") return null;
    const scopeChatIds = navigatorScope.chatIds ?? (navigatorScope.chatId ? [navigatorScope.chatId] : []);
    const selectedChatId = scopeChatIds[0] ?? null;
    if (!selectedChatId || !chats) return null;
    const selectedChat = (chats as Chat[]).find((chat) => chat.id === selectedChatId);
    return selectedChat ? ltmModeForChatMode(selectedChat.mode) : null;
  }, [chats, importSource, navigatorScope.chatId, navigatorScope.chatIds]);
  const selectedRecallMessages = useChatMessages(
    selectedRecallChat?.id ?? null,
    20,
    Boolean(openNoteId && selectedRecallChat),
  );
  const notes = useLongTermMemoryNotes(navigatorNoteFilter, {
    enabled: Boolean(selectedNavigatorThread) && (tab === "notes" || Boolean(openNoteId)),
  });
  const reviewNotes = useLongTermMemoryNotes({}, { enabled: tab === "review" });
  const allNotesForScopes = useLongTermMemoryNotes({}, { enabled: tab === "notes" });

  const scopedNavigatorThreads = useMemo(() => {
    if (tab !== "notes" || !allNotesForScopes.data) return navigatorThreads;
    const chatIdsWithNotes = new Set<string>();
    const groupIdsWithNotes = new Set<string>();
    for (const note of allNotesForScopes.data) {
      if (note.scope.groupId) groupIdsWithNotes.add(note.scope.groupId);
      if (note.scope.chatId) chatIdsWithNotes.add(note.scope.chatId);
      if (note.scope.chatIds) for (const id of note.scope.chatIds) chatIdsWithNotes.add(id);
    }
    const filtered = navigatorThreads.filter((thread) =>
      thread.groupId
        ? groupIdsWithNotes.has(thread.groupId) || thread.chats.some((c) => chatIdsWithNotes.has(c.id))
        : chatIdsWithNotes.has(thread.representative.id),
    );
    const selected = findNavigatorThread(navigatorThreads, navigatorSelection);
    return selected && !filtered.includes(selected) ? [selected, ...filtered] : filtered;
  }, [navigatorThreads, allNotesForScopes.data, tab, navigatorSelection]);
  const activeNotes = useLongTermMemoryNotes(
    { ...navigatorNoteFilter, status: "active" },
    { enabled: tab === "notes" || Boolean(openNoteId) },
  );
  const allDrafts = useLongTermMemoryDrafts(
    {},
    {
      enabled: Boolean(openNoteId),
    },
  );
  const draftReview = useLongTermMemoryDraftReview({ status: "pending" }, { enabled: tab === "review" });
  const acceptDraft = useAcceptLongTermMemoryDraft();
  const deleteDraft = useDeleteLongTermMemoryDraft();
  const skipDraftMutations = useSkipLongTermMemoryDraftMutations();
  const exactViewingNote = useLongTermMemoryNote(openNoteId ?? undefined);
  const importPreview = useLongTermMemoryImportPreview(
    importSource,
    importLimit,
    importSource === "chats" ? navigatorScope : undefined,
    importSource === "chats" ? importMode : undefined,
    { enabled: tab === "import" },
  );
  const deleteNotes = useDeleteLongTermMemoryNotes();
  const removeNotesFromScope = useRemoveLongTermMemoryNotesFromScope();
  const importSourceNotes = useImportLongTermMemorySourceNotes();
  const searchMemory = useSearchLongTermMemory();
  const noteActionPending = deleteNotes.isPending || removeNotesFromScope.isPending;
  const [recallQueryByNoteId, setRecallQueryByNoteId] = useState<Record<string, string>>({});
  const [recallResultByNoteId, setRecallResultByNoteId] = useState<Record<string, LtmSearchResponse | null>>({});

  useEffect(() => {
    if (importSource !== "chats") return;
    if (selectedImportChatMode) {
      setImportMode(selectedImportChatMode);
    }
  }, [importSource, selectedImportChatMode]);

  useEffect(() => {
    setLastImportResult(null);
  }, [importSource]);

  useEffect(() => () => importAbortControllerRef.current?.abort(), []);

  useEffect(() => {
    if (!activeChatId) return;
    setNavigatorSelection({ groupId: activeChat?.groupId ?? null, chatId: activeChatId });
  }, [activeChat?.groupId, activeChatId]);

  const filteredNotes = useMemo(() => {
    const list = (notes.data ?? []).filter((note) => {
      if (noteStatus !== "all" && note.status !== noteStatus) return false;
      if (noteType !== "all" && note.type !== noteType) return false;
      if (noteMode !== "all" && !note.modes.includes(noteMode)) return false;
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
  }, [noteStatus, noteType, noteMode, notes.data, query]);
  const groupedBucketNotes = useMemo(() => groupNotesByType(filteredNotes), [filteredNotes]);
  const visibleNoteIds = useMemo(() => filteredNotes.map((note) => note.id), [filteredNotes]);
  const selectedVisibleNoteIds = useMemo(
    () => visibleNoteIds.filter((id) => selectedNoteIds.has(id)),
    [selectedNoteIds, visibleNoteIds],
  );
  const selectedTransferNotes = useMemo(
    () => filteredNotes.filter((note) => selectedVisibleNoteIds.includes(note.id)),
    [filteredNotes, selectedVisibleNoteIds],
  );
  const allVisibleNotesSelected = visibleNoteIds.length > 0 && visibleNoteIds.every((id) => selectedNoteIds.has(id));
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
  const pendingImportRows = useMemo(() => importRows.filter((sample) => sample.status === "pending"), [importRows]);
  const importedImportRows = useMemo(() => importRows.filter((sample) => sample.status === "imported"), [importRows]);
  const staleImportRows = useMemo(
    () => pendingImportRows.filter((sample) => sample.freshness === "stale"),
    [pendingImportRows],
  );
  const lastImportFailures = useMemo(() => {
    if (!lastImportResult) return [];
    return [
      ...lastImportResult.imported.flatMap((item) =>
        item.extractionStatus === "succeeded"
          ? []
          : [{ sourceId: item.sourceId, title: item.title, message: item.error.message }],
      ),
      ...lastImportResult.writeFailures.map((failure) => ({
        sourceId: failure.sourceId,
        title: failure.title,
        message: failure.error.message,
      })),
      ...lastImportResult.missingSourceIds.map((sourceId) => ({
        sourceId,
        title: sourceId,
        message: "The selected source was not found.",
      })),
    ];
  }, [lastImportResult]);
  const lastImportHasReview = Boolean(
    lastImportResult?.imported.some((item) => (item.draft?.mutations.length ?? 0) > 0),
  );
  const selectedVisibleImportRows = useMemo(
    () => pendingImportRows.filter((sample) => selectedImportRows.has(importRowKey(importSource, sample.sourceId))),
    [importSource, pendingImportRows, selectedImportRows],
  );
  const allVisibleImportRowsSelected =
    pendingImportRows.length > 0 &&
    pendingImportRows.every((sample) => selectedImportRows.has(importRowKey(importSource, sample.sourceId)));
  const combinedNotes = useMemo(() => {
    const byId = new Map<string, LtmNote>();
    for (const note of notes.data ?? []) byId.set(note.id, note);
    for (const note of reviewNotes.data ?? []) byId.set(note.id, note);
    if (exactViewingNote.data) byId.set(exactViewingNote.data.id, exactViewingNote.data);
    return [...byId.values()];
  }, [exactViewingNote.data, notes.data, reviewNotes.data]);
  const noteLookup = useMemo(() => buildNoteLookup(combinedNotes), [combinedNotes]);
  const displayContext = useMemo<LtmDisplayLookupContext>(
    () => ({ chats: chatLookup, notes: noteLookup, groups: groupLookup }),
    [chatLookup, noteLookup, groupLookup],
  );
  const openNote = useMemo(
    () =>
      openNoteId
        ? (combinedNotes.find((note) => note.id === openNoteId) ??
          (exactViewingNote.data?.id === openNoteId ? exactViewingNote.data : null))
        : null,
    [combinedNotes, exactViewingNote.data, openNoteId],
  );
  const editedNoteFilteredOut = Boolean(openNote && !filteredNotes.some((note) => note.id === openNote.id));
  const editingNoteHiddenByFilters = Boolean(editedNoteFilteredOut && openNote && memoryModalMode === "edit");
  const viewingRecallQuery = openNote ? (recallQueryByNoteId[openNote.id] ?? "") : "";
  const viewingRecallResult = openNote ? (recallResultByNoteId[openNote.id] ?? null) : null;
  const recentRecallMessages = useMemo(
    () =>
      (selectedRecallMessages.data?.pages.flat() ?? [])
        .slice(-selectedRecallSettings.contextMessages)
        .map((message) => message.content)
        .filter(Boolean),
    [selectedRecallMessages.data?.pages, selectedRecallSettings.contextMessages],
  );
  const pendingDraftsForOpenNote = useMemo(
    () =>
      openNote
        ? combinedDrafts.filter((draft) => draft.status === "pending" && draft.source.sourceNoteId === openNote.id)
        : [],
    [combinedDrafts, openNote],
  );
  const latestExtractionResultForOpenNote = useMemo(
    () => (openNote ? (resultsBySourceNoteId[openNote.id] ?? null) : null),
    [resultsBySourceNoteId, openNote],
  );

  const reviewGroups = useMemo(() => {
    return (draftReview.data?.sources ?? []).map((reviewSource) => {
      const sourceNoteId = reviewSource.sourceNoteId;
      const sourceNote = noteLookup.get(sourceNoteId);
      const totalMutations = reviewSource.targets.reduce((sum, target) => sum + target.rows.length, 0);
      return {
        sourceNoteId,
        sourceNote,
        totalMutations,
        mode: reviewSource.modes[0] ?? null,
        reviewSource,
      };
    });
  }, [draftReview.data?.sources, noteLookup]);
  const reviewMutations = useMemo(
    () =>
      reviewGroups.flatMap(({ reviewSource }) => {
        const draftById = new Map(reviewSource.drafts.map((draftReview) => [draftReview.draft.id, draftReview]));
        return reviewSource.targets.flatMap((target) =>
          target.rows.flatMap((row) => {
            const draftReview = draftById.get(row.draftId);
            return draftReview
              ? [{ draft: draftReview.draft, mutation: row.mutation, blocked: draftReview.blockReasons.length > 0 }]
              : [];
          }),
        );
      }),
    [reviewGroups],
  );
  const reviewLowRiskEligibleCount = reviewMutations.filter(
    (row) => !row.blocked && row.mutation.risk === "low",
  ).length;
  const reviewBusy =
    reviewBatchAction !== null || acceptDraft.isPending || deleteDraft.isPending || skipDraftMutations.isPending;
  const reviewLoading = draftReview.isLoading || reviewNotes.isLoading;
  const reviewError = draftReview.error ?? reviewNotes.error;

  useEffect(() => {
    const availableIds = new Set((notes.data ?? []).map((note) => note.id));
    setSelectedNoteIds((current) => {
      const next = new Set([...current].filter((id) => availableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [notes.data]);

  useEffect(() => {
    if (!sourceNoteId || sourceNoteOpenedRef.current === sourceNoteId) return;
    if (notes.data && !notes.isLoading) {
      const sourceNote = notes.data.find((n) => n.id === sourceNoteId);
      if (sourceNote) {
        sourceNoteOpenedRef.current = sourceNoteId;
        setTab("notes");
        openMemory(sourceNoteId, { mode: "view" });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceNoteId, notes.data, notes.isLoading]);

  const closeMemoryModal = () => {
    setOpenNoteId(null);
    setMemoryModalMode("view");
    setMemoryModalTab("overview");
    setEditedNoteDirty(false);
  };

  const closeCreateForm = () => {
    setCreatingNote(false);
    setCreateNoteDirty(false);
    setCreateNoteDraft(null);
  };

  const confirmDiscardCreate = async () =>
    !createNoteDirty ||
    showConfirmDialog({
      title: "Discard Draft",
      message: "Discard unsaved memory draft?",
      confirmLabel: "Discard",
      tone: "destructive",
    });

  const confirmDiscardEditor = async () =>
    !editedNoteDirty ||
    showConfirmDialog({
      title: "Discard Changes",
      message: "Discard unsaved memory changes?",
      confirmLabel: "Discard",
      tone: "destructive",
    });

  const dismissBlockedReviewDrafts = async (reviewSource: LtmDraftReviewSource) => {
    const total = reviewSource.drafts.length;
    const confirmed = await showConfirmDialog({
      title: "Dismiss blocked review?",
      message: `This removes ${total} blocked extraction report${total === 1 ? "" : "s"}. It does not change memory notes.`,
      confirmLabel: "Dismiss",
      tone: "destructive",
    });
    if (!confirmed) return;
    let deletedCount = 0;
    for (const draftReview of reviewSource.drafts) {
      try {
        await deleteDraft.mutateAsync(draftReview.draft.id);
        deletedCount += 1;
      } catch (err) {
        toast.error((err as Error).message);
      }
    }
    if (deletedCount > 0) {
      toast.success(`${deletedCount} blocked extraction report${deletedCount === 1 ? "" : "s"} dismissed`);
    }
  };

  const withReviewBatchLock = async <T,>(action: () => Promise<T>) => {
    if (reviewBatchLockRef.current) return null;
    reviewBatchLockRef.current = true;
    try {
      return await action();
    } finally {
      reviewBatchLockRef.current = false;
    }
  };

  const keepAllLowRiskReviewMutations = async () => {
    const lowRiskByDraft = new Map<string, LtmDraftMutation[]>();
    for (const row of reviewMutations) {
      if (row.blocked || row.mutation.risk !== "low") continue;
      const existing = lowRiskByDraft.get(row.draft.id);
      if (existing) existing.push(row.mutation);
      else lowRiskByDraft.set(row.draft.id, [row.mutation]);
    }
    if (lowRiskByDraft.size === 0) {
      toast.info("No low-risk suggestions to keep.");
      return;
    }

    const completed = await withReviewBatchLock(async () => {
      setReviewBatchAction("keep-low");
      let keptCount = 0;
      let failedDraftCount = 0;
      let autoIncludedCount = 0;
      try {
        for (const [draftId, mutations] of lowRiskByDraft) {
          try {
            const result = await acceptDraft.mutateAsync({
              id: draftId,
              mutationIds: mutations.map((mutation) => mutation.id),
              lowRiskOnly: true,
            });
            keptCount += mutations.length;
            autoIncludedCount += result.autoIncludedMutationIds.length;
          } catch {
            failedDraftCount += 1;
          }
        }
      } finally {
        setReviewBatchAction(null);
      }
      return { keptCount, failedDraftCount, autoIncludedCount };
    });

    if (!completed) return;
    if (completed.failedDraftCount > 0) {
      toast.error(
        `Kept ${completed.keptCount} suggestion${completed.keptCount === 1 ? "" : "s"}; ${completed.failedDraftCount} draft${completed.failedDraftCount === 1 ? "" : "s"} failed.`,
      );
      return;
    }
    const depNote = completed.autoIncludedCount
      ? ` Also created ${completed.autoIncludedCount} note${completed.autoIncludedCount === 1 ? "" : "s"} to support changes.`
      : "";
    toast.success(`Kept ${completed.keptCount} low-risk suggestion${completed.keptCount === 1 ? "" : "s"}.` + depNote);
  };

  const skipAllReviewMutations = async () => {
    if (reviewMutations.length === 0) return;
    const confirmed = await showConfirmDialog({
      title: "Skip all suggestions?",
      message: `This will skip all ${reviewMutations.length} pending suggestion${reviewMutations.length === 1 ? "" : "s"}. This cannot be undone.`,
      confirmLabel: "Skip all",
      tone: "destructive",
    });
    if (!confirmed) return;

    const groups = new Map<string, string[]>();
    for (const row of reviewMutations) {
      const existing = groups.get(row.draft.id);
      if (existing) existing.push(row.mutation.id);
      else groups.set(row.draft.id, [row.mutation.id]);
    }

    const completed = await withReviewBatchLock(async () => {
      setReviewBatchAction("skip-all");
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
        setReviewBatchAction(null);
      }
      return { skippedCount, failedDraftCount };
    });

    if (!completed) return;
    if (completed.failedDraftCount > 0) {
      toast.error(
        `Skipped ${completed.skippedCount} suggestion${completed.skippedCount === 1 ? "" : "s"}; ${completed.failedDraftCount} draft${completed.failedDraftCount === 1 ? "" : "s"} failed.`,
      );
      return;
    }
    toast.success(`Skipped ${completed.skippedCount} suggestion${completed.skippedCount === 1 ? "" : "s"}.`);
  };

  const setTabWithGuards = async (nextTab: TabId) => {
    if (nextTab === tab) return true;
    if (creatingNote && !(await confirmDiscardCreate())) return false;
    if (memoryModalMode === "edit" && !(await confirmDiscardEditor())) return false;
    if (creatingNote) closeCreateForm();
    if (openNoteId) closeMemoryModal();
    setTab(nextTab);
    return true;
  };

  const openMemory = async (id: string, options: { mode?: MemoryModalMode; tab?: MemoryModalTab } = {}) => {
    if (openNoteId === id && memoryModalMode === (options.mode ?? "view")) return;
    if (memoryModalMode === "edit" && !(await confirmDiscardEditor())) return;
    if (creatingNote && !(await confirmDiscardCreate())) return;
    closeCreateForm();
    setOpenNoteId(id);
    setMemoryModalMode(options.mode ?? "view");
    const nextNote = noteLookup.get(id) ?? openNote;
    if (nextNote) {
      setMemoryModalTab(options.tab ?? defaultMemoryModalTab(nextNote));
    } else if (options.tab) {
      setMemoryModalTab(options.tab);
    }
    setEditedNoteDirty(false);
  };

  const closeOpenMemory = async () => {
    if (memoryModalMode === "edit" && !(await confirmDiscardEditor())) return;
    closeMemoryModal();
  };

  const setMemoryModeWithGuard = async (mode: MemoryModalMode) => {
    if (mode === memoryModalMode) return;
    if (memoryModalMode === "edit" && mode === "view" && !(await confirmDiscardEditor())) return;
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

  const requestCreateNote = async () => {
    if (creatingNote) return;
    if (!(await confirmDiscardEditor())) return;
    closeMemoryModal();
    setEditedNoteDirty(false);
    setCreatingNote(true);
  };

  const runViewingNoteRecall = async () => {
    if (!openNote) return;
    if (!selectedRecallChat) {
      toast.error("Choose a specific chat branch before testing recall.");
      return;
    }
    if (!selectedRecallSettings.enabled) {
      toast.error(
        `Long-Term Memory is off for ${navigatorScopeLabel}. Turn it on in Chat Settings before testing recall.`,
      );
      return;
    }
    const recallQuery = viewingRecallQuery.trim();
    if (!recallQuery) return;
    try {
      const result = await searchMemory.mutateAsync({
        queryText: recallQuery,
        recentMessages: recentRecallMessages,
        mentionedCharacterNames: selectedRecallCharacterNames,
        mode: ltmModeForChatMode(selectedRecallChat.mode),
        scope: navigatorScope,
        characterIds: selectedRecallCharacterIds,
        includeResolved: selectedRecallSettings.includeResolved,
        maxChunks: selectedRecallSettings.maxChunks,
        maxTokens: selectedRecallSettings.maxTokens,
        minScore: selectedRecallSettings.minScore,
        semanticWeight: selectedRecallSettings.semanticWeight,
        lexicalWeight: selectedRecallSettings.lexicalWeight,
        graphWeight: selectedRecallSettings.graphWeight,
        keywordWeight: selectedRecallSettings.keywordWeight,
        debug: true,
      });
      setRecallResultByNoteId((current) => ({ ...current, [openNote.id]: result }));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const openRecoveryDraft = async (candidate: LtmExtractionDroppedCandidate, sourceNote: LtmNote) => {
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
    const defaultId =
      recovery?.noteId ??
      (
        {
          timeline_event: "timeline_",
          character: "char_",
          relationship: "rel_",
          scene: "scene_",
          thread: "thread_",
          world: "world_",
          tone: "tone_",
          source: "source_",
        } satisfies Record<LtmNoteType, string>
      )[defaultType];

    if (!(await confirmDiscardEditor()) || !(await confirmDiscardCreate())) return;
    closeMemoryModal();
    setCreateNoteDraft({
      type: defaultType,
      id: defaultId,
      title: "",
      status: recovery?.status ?? "active",
      modes: sourceNote.modes,
      tagsText: "",
      keywordsText: "",
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

  const setLatestExtractionResultForSourceNote = useCallback(
    (sourceNoteId: string, result: LongTermMemoryLatestExtractionResult | null) => {
      setExtractionResult(sourceNoteId, result);
    },
    [setExtractionResult],
  );

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

  const contextRemovalScope = useMemo(() => {
    const chatIds = getLtmScopeChatIds(navigatorScope);
    const scope = {
      ...(chatIds.length > 0 ? { chatIds } : {}),
      ...(navigatorScope.groupId ? { groupId: navigatorScope.groupId } : {}),
      ...(navigatorScope.characterIds?.length ? { characterIds: navigatorScope.characterIds } : {}),
    };
    return hasRemovableLtmScope(scope) ? scope : null;
  }, [navigatorScope]);

  const getNoteRemovalScope = useCallback(
    (note: LtmNote) => removableScopeForContext(note.scope, navigatorScope),
    [navigatorScope],
  );

  const canRemoveMemoryFromCurrentScope = useCallback(
    (note: LtmNote) => hasRemovableLtmScope(getNoteRemovalScope(note)),
    [getNoteRemovalScope],
  );

  const removalWouldDeleteMemory = useCallback(
    (note: LtmNote) => {
      const removal = getNoteRemovalScope(note);
      return removal ? !scopeHasLinks(removeScopeLinks(note.scope, removal)) : false;
    },
    [getNoteRemovalScope],
  );

  const selectedRemovableNoteIds = useMemo(
    () =>
      selectedVisibleNoteIds.filter((id) => {
        const note = noteLookup.get(id);
        return note ? canRemoveMemoryFromCurrentScope(note) : false;
      }),
    [canRemoveMemoryFromCurrentScope, noteLookup, selectedVisibleNoteIds],
  );

  const removeMemoriesFromCurrentScopeById = async (ids: string[], skippedCount = 0) => {
    const uniqueIds = uniqueNoteIds(
      ids.filter((id) => {
        const note = noteLookup.get(id);
        return note ? canRemoveMemoryFromCurrentScope(note) : false;
      }),
    );
    if (uniqueIds.length === 0 || !contextRemovalScope) {
      toast.error("No selected memories are linked to this chat context.");
      return;
    }

    try {
      const result = await removeNotesFromScope.mutateAsync({ ids: uniqueIds, scope: contextRemovalScope });
      const allAffected = [...result.removedIds, ...result.deletedIds];
      setSelectedNoteIds((current) => {
        const next = new Set(current);
        for (const id of allAffected) next.delete(id);
        return next;
      });
      setExpandedMemoryIds((current) => {
        const next = new Set(current);
        for (const id of allAffected) next.delete(id);
        return next;
      });
      if (openNoteId && allAffected.includes(openNoteId)) {
        closeMemoryModal();
      }

      const totalSkipped = skippedCount + result.unchangedIds.length;
      const skippedSuffix = totalSkipped > 0 ? `, ${totalSkipped} skipped` : "";
      if (result.failedIds.length > 0) {
        toast.error(
          `${allAffected.length} memor${allAffected.length === 1 ? "y" : "ies"} affected, ${result.failedIds.length} failed${skippedSuffix}.`,
        );
      } else if (allAffected.length === 0 && result.unchangedIds.length > 0) {
        toast.error("Selected memories are no longer linked to this chat context.");
      } else if (result.deletedIds.length > 0 && result.removedIds.length > 0) {
        toast.success(
          `${result.removedIds.length} removed from this chat, ${result.deletedIds.length} permanently deleted${skippedSuffix}`,
        );
      } else if (result.deletedIds.length > 0) {
        toast.success(
          `${result.deletedIds.length} memor${result.deletedIds.length === 1 ? "y" : "ies"} permanently deleted${skippedSuffix}`,
        );
      } else {
        toast.success(
          `${result.removedIds.length} memor${result.removedIds.length === 1 ? "y" : "ies"} removed from this chat${skippedSuffix}`,
        );
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
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

  const confirmDerivedDeleteIds = async (ids: string[], action: "delete" | "remove" = "delete") => {
    const selectedIds = new Set(ids);
    const sourceIds = new Set(
      ids.filter((id) => {
        const note = noteLookup.get(id);
        return note ? isSourceSummaryNote(note) : false;
      }),
    );
    const unselectedDerivedIds = derivedNoteIdsForSources(combinedNotes, sourceIds).filter(
      (id) => !selectedIds.has(id),
    );
    if (unselectedDerivedIds.length === 0) return ids;

    const includeDerived = await showConfirmDialog({
      title: action === "remove" ? "Remove Extracted Memories" : "Delete Extracted Memories",
      message: `${sourceIds.size} selected source memor${sourceIds.size === 1 ? "y has" : "ies have"} ${unselectedDerivedIds.length} extracted memor${unselectedDerivedIds.length === 1 ? "y" : "ies"}. ${
        action === "remove" ? "Remove extracted memories from this chat too?" : "Delete extracted memories too?"
      }`,
      confirmLabel: action === "remove" ? "Remove All" : "Delete All",
      tone: "destructive",
    });
    return includeDerived ? uniqueNoteIds([...ids, ...unselectedDerivedIds]) : ids;
  };

  const removeMemoryFromCurrentScope = async (note: LtmNote) => {
    const title = memoryRowTitle(note, chatLookup);
    if (!canRemoveMemoryFromCurrentScope(note)) {
      toast.error("This memory is not linked to the current chat context.");
      return;
    }
    const ids = await confirmDerivedDeleteIds([note.id], "remove");
    const removableNotes = ids
      .map((id) => noteLookup.get(id))
      .filter((item): item is LtmNote => item !== undefined && canRemoveMemoryFromCurrentScope(item));
    const skippedCount = ids.length - removableNotes.length;
    const willDeleteCount = removableNotes.filter(removalWouldDeleteMemory).length;
    const choice = await showConfirmDialog({
      title: "Remove Memory",
      message:
        willDeleteCount > 0
          ? `${willDeleteCount} memor${willDeleteCount === 1 ? "y is" : "ies are"} only linked to this chat context. Removing ${
              willDeleteCount === 1 ? "it" : "them"
            } will permanently delete ${willDeleteCount === 1 ? "it" : "them"}. This cannot be undone.`
          : `Remove "${title}" from this chat? It will remain anywhere else it is linked.`,
      confirmLabel: "Remove from chat",
      tone: "destructive",
    });
    if (!choice) return;
    void removeMemoriesFromCurrentScopeById(ids, skippedCount);
  };

  const deleteMemory = async (note: LtmNote) => {
    const title = memoryRowTitle(note, chatLookup);
    if (
      !(await showConfirmDialog({
        title: "Permanently Delete",
        message: `Permanently delete "${title}"? This cannot be undone.`,
        confirmLabel: "Delete",
        tone: "destructive",
      }))
    )
      return;
    void deleteMemoriesById(await confirmDerivedDeleteIds([note.id]));
  };

  const removeSelectedMemoriesFromCurrentScope = async () => {
    const ids = selectedVisibleNoteIds;
    if (ids.length === 0) return;
    if (selectedRemovableNoteIds.length === 0) {
      toast.error("No selected memories are linked to this chat context.");
      return;
    }
    const allIds = await confirmDerivedDeleteIds(selectedRemovableNoteIds, "remove");
    const removableNotes = allIds
      .map((id) => noteLookup.get(id))
      .filter((item): item is LtmNote => item !== undefined && canRemoveMemoryFromCurrentScope(item));
    const skippedCount = allIds.length - removableNotes.length + (ids.length - selectedRemovableNoteIds.length);
    const willDeleteCount = removableNotes.filter(removalWouldDeleteMemory).length;
    const removeOnlyCount = removableNotes.length - willDeleteCount;
    const choice = await showConfirmDialog({
      title: "Remove Memories",
      message:
        willDeleteCount > 0
          ? `${
              removeOnlyCount > 0
                ? `${removeOnlyCount} memor${removeOnlyCount === 1 ? "y" : "ies"} will be removed from this chat, and `
                : ""
            }${willDeleteCount} memor${willDeleteCount === 1 ? "y" : "ies"} will be permanently deleted because ${
              willDeleteCount === 1 ? "it has" : "they have"
            } no other scope links. This cannot be undone.`
          : `Remove ${removableNotes.length} selected memor${removableNotes.length === 1 ? "y" : "ies"} from this chat? ${
              removableNotes.length === 1 ? "It" : "They"
            } will remain anywhere else linked.`,
      confirmLabel: "Remove from chat",
      tone: "destructive",
    });
    if (!choice) return;
    void removeMemoriesFromCurrentScopeById(allIds, skippedCount);
  };

  const deleteSelectedMemories = async () => {
    const ids = selectedVisibleNoteIds;
    if (ids.length === 0) return;
    if (
      !(await showConfirmDialog({
        title: "Permanently Delete",
        message: `Permanently delete ${ids.length} selected memor${ids.length === 1 ? "y" : "ies"}? This cannot be undone.`,
        confirmLabel: "Delete",
        tone: "destructive",
      }))
    ) {
      return;
    }
    void deleteMemoriesById(await confirmDerivedDeleteIds(ids));
  };

  const openTransferModal = (mode: "copy" | "move") => {
    if (selectedVisibleNoteIds.length === 0) return;
    setTransferModalMode(mode);
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
      for (const row of pendingImportRows) {
        const key = importRowKey(importSource, row.sourceId);
        if (selected) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const importRowsToVault = async (sourceIds: string[]) => {
    if (sourceIds.length === 0 || importSourceNotes.isPending) return;
    const controller = new AbortController();
    importAbortControllerRef.current = controller;
    setActiveImportIds((current) => {
      const next = new Set(current);
      for (const sourceId of sourceIds) next.add(importRowKey(importSource, sourceId));
      return next;
    });
    try {
      const result = await importSourceNotes.mutateAsync({
        source: importSource,
        sourceIds,
        limit: sourceIds.length,
        scope: importSource === "chats" ? navigatorScope : undefined,
        connectionId: optionalTrimmedText(importConnectionId),
        model: optionalTrimmedText(importModel),
        instruction: optionalTrimmedText(importInstruction),
        applyLowRisk: importApplyLowRisk || undefined,
        importConcurrency: clampImportConcurrency(importConcurrencySetting),
        ...(importSource === "chats" ? { mode: importMode } : {}),
        signal: controller.signal,
      });
      setLastImportResult(result);
      for (const item of result.imported) {
        const mutationCount =
          item.appliedMutationIds.length + item.skippedMutationIds.length || item.draft?.mutations.length;
        setExtractionResult(item.note.id, {
          accounting: item.accounting,
          diagnostics: item.diagnostics,
          operationId: result.operationId,
          outcome: item.outcome,
          mutationCount,
        });
      }

      const succeededItems = result.imported.filter((item) => item.extractionStatus === "succeeded");
      const suggestionCount = succeededItems.reduce((sum, item) => {
        const applySelectionCount = item.appliedMutationIds.length + item.skippedMutationIds.length;
        return sum + (applySelectionCount > 0 ? applySelectionCount : (item.draft?.mutations.length ?? 0));
      }, 0);
      const incompleteCount =
        result.counts.failed + result.counts.cancelled + result.counts.missing + result.counts.sourceWriteFailed;
      const summary = `${result.counts.succeeded} of ${result.counts.requested} source${result.counts.requested === 1 ? "" : "s"} extracted, ${suggestionCount} suggestion${suggestionCount === 1 ? "" : "s"} created`;
      if (result.batchStatus === "success") toast.success(summary);
      else if (result.batchStatus === "partial_success") {
        toast.warning(`${summary}. ${incompleteCount} source${incompleteCount === 1 ? " needs" : "s need"} attention.`);
      } else if (result.batchStatus === "cancelled") {
        toast.warning(`Import cancelled. ${result.counts.succeeded} completed; unfinished sources remain selected.`);
      } else {
        toast.error(
          `Import failed for ${incompleteCount} source${incompleteCount === 1 ? "" : "s"}. Retryable sources remain selected.`,
        );
      }

      const retryableSourceIds = new Set([
        ...result.imported.filter((item) => item.retryable).map((item) => item.sourceId),
        ...result.writeFailures.map((failure) => failure.sourceId),
        ...result.missingSourceIds,
      ]);
      setSelectedImportRows((current) => {
        const next = new Set(current);
        for (const sourceId of sourceIds) {
          const key = importRowKey(importSource, sourceId);
          if (retryableSourceIds.has(sourceId)) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        toast.warning("Import cancelled. Unfinished sources remain selected.");
      } else {
        toast.error(err instanceof Error ? err.message : "Import failed");
      }
    } finally {
      if (importAbortControllerRef.current === controller) importAbortControllerRef.current = null;
      setActiveImportIds((current) => {
        const next = new Set(current);
        for (const sourceId of sourceIds) next.delete(importRowKey(importSource, sourceId));
        return next;
      });
    }
  };

  const cancelImport = () => importAbortControllerRef.current?.abort();

  const noteSelectionActions: SelectionActionBarAction[] = [
    {
      id: "copy",
      label: "Copy",
      icon: <Copy size="0.75rem" />,
      onClick: () => openTransferModal("copy"),
      disabled: noteActionPending,
    },
    {
      id: "move",
      label: "Move",
      icon: <ArrowRightLeft size="0.75rem" />,
      onClick: () => openTransferModal("move"),
      disabled: noteActionPending,
    },
    {
      id: "clear",
      label: "Clear",
      icon: <RotateCcw size="0.75rem" />,
      onClick: () => setAllVisibleNotesSelected(false),
      disabled: noteActionPending,
    },
    {
      id: "remove-from-chat",
      label: "Remove from chat",
      icon: removeNotesFromScope.isPending ? (
        <Loader2 size="0.75rem" className="animate-spin" />
      ) : (
        <Unlink2 size="0.75rem" />
      ),
      onClick: () => void removeSelectedMemoriesFromCurrentScope(),
      disabled: selectedRemovableNoteIds.length === 0 || noteActionPending,
    },
    {
      id: "delete",
      label: "Delete",
      icon: deleteNotes.isPending ? <Loader2 size="0.75rem" className="animate-spin" /> : <Trash2 size="0.75rem" />,
      onClick: () => void deleteSelectedMemories(),
      disabled: selectedVisibleNoteIds.length === 0 || noteActionPending,
      tone: "danger",
    },
  ];

  const importSelectionActions: SelectionActionBarAction[] = importSourceNotes.isPending
    ? [
        {
          id: "cancel",
          label: "Cancel import",
          icon: <X size="0.75rem" />,
          onClick: cancelImport,
          tone: "danger",
        },
      ]
    : [
        {
          id: "import",
          label: "Import selected",
          icon: <Import size="0.75rem" />,
          onClick: () => void importRowsToVault(selectedVisibleImportRows.map((row) => row.sourceId)),
          disabled: selectedVisibleImportRows.length === 0,
          tone: "primary",
        },
        {
          id: "clear",
          label: "Clear",
          icon: <RotateCcw size="0.75rem" />,
          onClick: () => setAllVisibleImportRowsSelected(false),
        },
      ];

  return (
    <div className="flex min-h-full flex-col gap-3 p-3 text-[var(--foreground)]">
      <div className="sticky top-0 z-10 -mx-3 bg-[var(--background)]/95 px-3 py-2 backdrop-blur-sm">
        <LtmTabRail
          tabs={LTM_TAB_IDS.map((id) => ({ id, label: TAB_LABELS[id] }))}
          activeId={tab}
          onChange={setTabWithGuards}
          ariaLabel="Long-term memory views"
          idPrefix="ltm"
        />
      </div>

      {tab === "notes" && (
        <Section title="Memories" id="ltm-panel-notes" labelledBy="ltm-tab-notes">
          <div className={panelIntroCardClassName}>
            <div className="flex flex-wrap gap-1.5">
              <StatusPill
                label={followsActive ? "Following selected chat" : "Panel scope"}
                tone={followsActive ? "good" : "warn"}
              />
              <StatusPill
                label={`${(notes.data ?? []).length} memor${(notes.data ?? []).length === 1 ? "y" : "ies"} in this scope`}
                title={`Memories linked to ${navigatorScopeLabel}, plus global memories.`}
              />
            </div>
            <p className={cn("mt-2", helperTextClassName)}>
              Includes global memories plus memories linked to {navigatorScopeLabel}.
            </p>
          </div>

          <LtmNavigatorSelector
            threads={scopedNavigatorThreads}
            selection={navigatorSelection}
            activeChatId={activeChatId}
            scopeLabel={navigatorScopeLabel}
            query={navigatorQuery}
            hideContextPill
            onQueryChange={setNavigatorQuery}
            onSelect={setNavigatorSelection}
          />

          {editingNoteHiddenByFilters && (
            <div className="mb-3 rounded-xl bg-amber-500/10 p-3 ring-1 ring-amber-500/30">
              <div className="text-xs font-medium text-amber-700 dark:text-amber-100">
                Open note is hidden by filters
              </div>
              <p className="mt-1 text-[0.6875rem] text-amber-700/80 dark:text-amber-100/80">
                The editor stays open so unsaved edits are not lost.
              </p>
            </div>
          )}
          <section className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <label className="flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-3 shadow-sm transition-[border-color,box-shadow] hover:border-[var(--primary)]/50 focus-within:border-[var(--primary)] focus-within:ring-2 focus-within:ring-[var(--ring)]/40">
                <Search size="0.875rem" className="text-[var(--muted-foreground)]" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search memories"
                  aria-label="Search memories"
                  className="min-w-0 flex-1 bg-transparent text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]/60"
                />
              </label>
              <ToolButton onClick={requestCreateNote} disabled={creatingNote}>
                <Plus size="0.875rem" />
                New
              </ToolButton>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <select
                value={noteType}
                onChange={(event) => setNoteType(event.target.value as "all" | LtmNoteType)}
                className={compactInputClassName}
                aria-label="Memory type"
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
                aria-label="Memory status"
              >
                {NOTE_STATUSES.map((statusId) => (
                  <option key={statusId} value={statusId}>
                    {statusId === "all" ? "Any status" : friendlyStatus(statusId)}
                  </option>
                ))}
              </select>
              <select
                value={noteMode}
                onChange={(event) => setNoteMode(event.target.value as "all" | LtmMode)}
                className={compactInputClassName}
                aria-label="Memory mode"
              >
                <option value="all">Any mode</option>
                {(["roleplay", "conversation", "game"] as const).map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABELS[mode]}
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
                    disabled={visibleNoteIds.length === 0 || noteActionPending}
                    onChange={(event) => setAllVisibleNotesSelected(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                  />
                  Select visible
                </label>
                <StatusPill
                  label={`${selectedVisibleNoteIds.length} selected`}
                  tone={selectedVisibleNoteIds.length > 0 ? "warn" : "neutral"}
                />
              </div>
            )}
            <div className="space-y-2">
              {notes.isError && (
                <QueryFailure
                  label="Memories"
                  error={notes.error}
                  stale={Boolean(notes.data)}
                  onRetry={() => void notes.refetch()}
                />
              )}
              {notes.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
              {!notes.isLoading && !notes.isError && filteredNotes.length === 0 && (
                <div className={cn(emptyStateClassName, "space-y-3")}>
                  <p>No matching memories.</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {(query || noteType !== "all" || noteStatus !== "all" || noteMode !== "all") && (
                      <ToolButton
                        onClick={() => {
                          setQuery("");
                          setNoteType("all");
                          setNoteStatus("all");
                          setNoteMode("all");
                        }}
                      >
                        <RotateCcw size="0.875rem" />
                        Clear filters
                      </ToolButton>
                    )}
                    <ToolButton onClick={requestCreateNote} disabled={creatingNote} tone="primary">
                      <Plus size="0.875rem" />
                      New memory
                    </ToolButton>
                  </div>
                </div>
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
                  canRemoveFromScope={canRemoveMemoryFromCurrentScope}
                  onRemoveFromScope={removeMemoryFromCurrentScope}
                  onDelete={deleteMemory}
                />
              )}
            </div>
            {selectedVisibleNoteIds.length > 0 && (
              <SelectionActionBar
                selectedCount={selectedVisibleNoteIds.length}
                actions={noteSelectionActions}
                placement="sticky"
              />
            )}
          </section>
        </Section>
      )}

      {tab === "import" && (
        <Section title="Import" id="ltm-panel-import" labelledBy="ltm-tab-import">
          <div className={panelIntroCardClassName}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--foreground)]">
                  {importPreview.data?.draftable ?? 0} pending source{importPreview.data?.draftable === 1 ? "" : "s"}{" "}
                  ready
                </div>
                <div className="mt-1 text-[0.6875rem] text-[var(--muted-foreground)]">
                  {importPreview.data?.importedCount ?? 0} source{importPreview.data?.importedCount === 1 ? "" : "s"}{" "}
                  current in Memory
                </div>
                {staleImportRows.length > 0 && (
                  <div className="mt-1 text-[0.6875rem] text-amber-700 dark:text-amber-200">
                    {staleImportRows.length} source{staleImportRows.length === 1 ? "" : "s"} changed since import
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                {importPreview.isFetching ? <Loader2 className="animate-spin" size="1rem" /> : <FileJson size="1rem" />}
                <button
                  type="button"
                  onClick={() => void importPreview.refetch()}
                  disabled={importPreview.isFetching}
                  aria-label="Refresh available imports"
                  title="Refresh available imports"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-[background-color,color,transform] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:scale-90 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RefreshCw size="0.75rem" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          {importSource === "chats" && (
            <LtmNavigatorSelector
              threads={navigatorThreads}
              selection={navigatorSelection}
              activeChatId={activeChatId}
              scopeLabel={navigatorScopeLabel}
              query={navigatorQuery}
              onQueryChange={setNavigatorQuery}
              onSelect={setNavigatorSelection}
            />
          )}

          <div className={cn("grid gap-2", importSource === "chats" ? "sm:grid-cols-[1fr_1fr]" : "sm:grid-cols-[1fr]")}>
            {importSource === "chats" && (
              <label className="space-y-1">
                <span className="block text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Chat mode</span>
                <select
                  value={importMode}
                  disabled={importSourceNotes.isPending}
                  onChange={(event) => setImportMode(event.target.value as LtmMode)}
                  className={compactInputClassName}
                >
                  {(["roleplay", "conversation", "game"] as const).map((mode) => (
                    <option key={mode} value={mode}>
                      {MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="space-y-1">
              <span className="block text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Source</span>
              <select
                value={importSource}
                disabled={importSourceNotes.isPending}
                onChange={(event) => handlePrefsChange({ importSource: event.target.value as LtmInteropSource })}
                className={compactInputClassName}
              >
                {IMPORT_SOURCES.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.id === "chats" ? "Chat summaries" : source.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={cn(sectionCardClassName, "mt-2")}>
            <div className="flex flex-wrap gap-1.5">
              <StatusPill label={`${clampImportConcurrency(importConcurrencySetting)} at once`} />
              {importApplyLowRisk ? <StatusPill label="Low-risk auto-apply" tone="warn" /> : null}
            </div>
            <p className={cn("mt-2", helperTextClassName)}>
              Import uses the shared extraction defaults, including connection, model, instruction, and low-risk
              auto-apply.
            </p>
          </div>
          {lastImportResult && (
            <div
              role={lastImportResult.batchStatus === "failed" ? "alert" : "status"}
              aria-live="polite"
              className={cn(
                sectionCardClassName,
                "mt-3 space-y-2",
                lastImportResult.batchStatus === "success"
                  ? "border-emerald-500/25 bg-emerald-500/5"
                  : lastImportResult.batchStatus === "failed"
                    ? "border-[var(--destructive)]/25 bg-[var(--destructive)]/5"
                    : "border-amber-500/25 bg-amber-500/5",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-[var(--foreground)]">
                  {lastImportResult.batchStatus === "success"
                    ? "Import complete"
                    : lastImportResult.batchStatus === "partial_success"
                      ? "Import partly complete"
                      : lastImportResult.batchStatus === "cancelled"
                        ? "Import cancelled"
                        : "Import failed"}
                </div>
                {lastImportHasReview && (
                  <ToolButton onClick={() => void setTabWithGuards("review")}>
                    <Eye size="0.75rem" />
                    Open Review
                  </ToolButton>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <StatusPill
                  label={`${lastImportResult.counts.succeeded} extracted`}
                  tone={lastImportResult.counts.succeeded > 0 ? "good" : "neutral"}
                />
                {lastImportResult.counts.failed > 0 && (
                  <StatusPill label={`${lastImportResult.counts.failed} failed`} tone="bad" />
                )}
                {lastImportResult.counts.cancelled > 0 && (
                  <StatusPill label={`${lastImportResult.counts.cancelled} cancelled`} tone="warn" />
                )}
                {lastImportResult.counts.sourceWriteFailed > 0 && (
                  <StatusPill label={`${lastImportResult.counts.sourceWriteFailed} not saved`} tone="bad" />
                )}
                {lastImportResult.counts.missing > 0 && (
                  <StatusPill label={`${lastImportResult.counts.missing} missing`} tone="warn" />
                )}
              </div>
              {lastImportFailures.slice(0, 5).map((failure) => (
                <p
                  key={`${failure.sourceId}-${failure.message}`}
                  className="text-[0.6875rem] text-[var(--muted-foreground)]"
                >
                  <span className="font-medium text-[var(--foreground)]">{failure.title}:</span> {failure.message}
                </p>
              ))}
            </div>
          )}
          <div className={cn(sectionCardClassName, "mt-3")}>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-xs text-[var(--foreground)]">
                <input
                  type="checkbox"
                  checked={allVisibleImportRowsSelected}
                  disabled={pendingImportRows.length === 0}
                  onChange={(event) => setAllVisibleImportRowsSelected(event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                />
                Select visible
              </label>
              <StatusPill
                label={`${selectedVisibleImportRows.length} selected`}
                tone={selectedVisibleImportRows.length > 0 ? "warn" : "neutral"}
              />
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {importPreview.isError && (
              <QueryFailure
                label="Import sources"
                error={importPreview.error}
                stale={Boolean(importPreview.data)}
                onRetry={() => void importPreview.refetch()}
              />
            )}
            {importPreview.isLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
            {!importPreview.isLoading &&
              !importPreview.isError &&
              pendingImportRows.length === 0 &&
              importedImportRows.length === 0 && (
                <p className={emptyStateClassName}>No sources are ready to bring in.</p>
              )}
            {pendingImportRows.map((sample) => (
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
            {importedImportRows.length > 0 && (
              <div className={cn(sectionCardClassName, "border-amber-500/20 bg-amber-500/5")}>
                <button
                  type="button"
                  onClick={() => setImportedRowsOpen((current) => !current)}
                  aria-expanded={importedRowsOpen}
                  className="flex w-full items-center justify-between gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  <div>
                    <div className="text-xs font-semibold text-[var(--foreground)]">
                      Imported source{importedImportRows.length === 1 ? "" : "s"} ({importedImportRows.length})
                    </div>
                    <div className="mt-1 text-[0.6875rem] text-[var(--muted-foreground)]">
                      These source snapshots are current. They stay visible for reference and cannot be imported again.
                    </div>
                  </div>
                  <DisclosureChevron open={importedRowsOpen} />
                </button>
                {importedRowsOpen && (
                  <div className="mt-3 space-y-2">
                    {importedImportRows.map((sample) => (
                      <ImportPreviewRowItem
                        key={sample.sourceId}
                        sample={sample}
                        selected={false}
                        disabled
                        importing={false}
                        onSelect={() => {}}
                        onImport={() => {}}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {(selectedVisibleImportRows.length > 0 || importSourceNotes.isPending) && (
            <SelectionActionBar
              selectedCount={importSourceNotes.isPending ? activeImportIds.size : selectedVisibleImportRows.length}
              actions={importSelectionActions}
              placement="sticky"
            />
          )}
        </Section>
      )}

      {tab === "review" && (
        <Section title="Review and Repair" id="ltm-panel-review" labelledBy="ltm-tab-review">
          <LtmNavigatorSelector
            threads={navigatorThreads}
            selection={navigatorSelection}
            activeChatId={activeChatId}
            scopeLabel={navigatorScopeLabel}
            query={navigatorQuery}
            onQueryChange={setNavigatorQuery}
            onSelect={setNavigatorSelection}
          />

          <LongTermMemoryIdentityRepairSection
            scope={navigatorScope}
            scopeLabel={navigatorScopeLabel}
            enabled={Boolean(selectedNavigatorThread)}
          />

          <div className="border-t border-[var(--border)]/70 pt-3">
            <h3 className="text-sm font-semibold text-[var(--foreground)]">Draft suggestions</h3>
          </div>
          {reviewError && (
            <QueryFailure
              label="Suggestions"
              error={reviewError}
              stale={Boolean(draftReview.data || reviewNotes.data)}
              onRetry={() => {
                void draftReview.refetch();
                void reviewNotes.refetch();
              }}
            />
          )}
          {reviewLoading && <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />}
          {!reviewLoading && !reviewError && reviewGroups.length === 0 && (
            <p className={emptyStateClassName}>No pending suggestions to review.</p>
          )}
          {!reviewLoading && reviewGroups.length > 0 && (
            <div className="space-y-2">
              <div className={sectionCardClassName}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className={helperTextClassName}>
                    <span className="font-semibold text-[var(--foreground)]">{reviewMutations.length}</span> pending
                    suggestion{reviewMutations.length === 1 ? "" : "s"} across{" "}
                    <span className="font-semibold text-[var(--foreground)]">{reviewGroups.length}</span> source
                    {reviewGroups.length === 1 ? "" : "s"}
                    {(draftReview.data?.counts.blockedDrafts ?? 0) > 0 ? (
                      <>
                        {", "}
                        <span className="font-semibold text-[var(--destructive)]">
                          {draftReview.data?.counts.blockedDrafts}
                        </span>{" "}
                        blocked
                      </>
                    ) : null}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <ToolButton
                      onClick={() => void keepAllLowRiskReviewMutations()}
                      disabled={reviewBusy || reviewLowRiskEligibleCount === 0}
                      tone="primary"
                    >
                      {reviewBatchAction === "keep-low" ? (
                        <Loader2 size="0.875rem" className="animate-spin" />
                      ) : (
                        <Check size="0.875rem" />
                      )}
                      Keep all low-risk
                    </ToolButton>
                    <ToolButton
                      onClick={() => void skipAllReviewMutations()}
                      disabled={reviewBusy || reviewMutations.length === 0}
                      tone="danger"
                    >
                      {reviewBatchAction === "skip-all" ? (
                        <Loader2 size="0.875rem" className="animate-spin" />
                      ) : (
                        <X size="0.875rem" />
                      )}
                      Skip all
                    </ToolButton>
                  </div>
                </div>
              </div>
              {reviewGroups.map(({ sourceNoteId, sourceNote, totalMutations, mode, reviewSource }) => {
                const blocked = reviewSource.drafts.some((draftReview) => draftReview.blockReasons.length > 0);
                const diagnosticOnly = totalMutations === 0;
                return (
                  <section
                    key={sourceNoteId}
                    className="overflow-hidden rounded-lg bg-[var(--secondary)]/35 ring-1 ring-[var(--border)]"
                  >
                    <div className="p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {!sourceNote ? (
                              <AlertCircle size="0.75rem" className="shrink-0 text-[var(--destructive)]" />
                            ) : null}
                            <p className="truncate text-xs font-semibold text-[var(--foreground)]">
                              {sourceNote ? memoryRowTitle(sourceNote, chatLookup) : friendlyIdentifier(sourceNoteId)}
                            </p>
                            {mode ? <ModeBadge mode={mode} /> : null}
                            {blocked ? <StatusPill label="Blocked" tone="bad" /> : null}
                            {diagnosticOnly ? <StatusPill label="Diagnostics only" tone="warn" /> : null}
                          </div>
                          <p className="mt-0.5 text-[0.6875rem] text-[var(--muted-foreground)]">
                            {totalMutations} pending suggestion{totalMutations === 1 ? "" : "s"} across{" "}
                            {reviewSource.targets.length} target{reviewSource.targets.length === 1 ? "" : "s"}
                          </p>
                        </div>
                        {sourceNote ? (
                          <ToolButton onClick={() => openMemory(sourceNoteId, { tab: "suggestions" })} tone="primary">
                            <Eye size="0.75rem" />
                            Review
                          </ToolButton>
                        ) : (
                          <ToolButton
                            onClick={() => void dismissBlockedReviewDrafts(reviewSource)}
                            disabled={reviewBusy}
                            tone="danger"
                          >
                            <X size="0.875rem" />
                            Dismiss
                          </ToolButton>
                        )}
                      </div>
                      <ReviewSourceDiagnostics source={reviewSource} />
                    </div>
                    {reviewSource.targets.map((target) => (
                      <ReviewTargetSummary key={target.noteId} target={target} />
                    ))}
                  </section>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {tab === "debug" && (
        <Section title="Debug" id="ltm-panel-debug" labelledBy="ltm-tab-debug">
          <LongTermMemoryDebugLogPanel />
        </Section>
      )}

      <LtmModal
        open={creatingNote}
        onClose={() => {
          void confirmDiscardCreate().then((ok) => {
            if (ok) closeCreateForm();
          });
        }}
        title="New Memory"
        width="max-w-3xl"
      >
        <CreateLongTermMemoryNoteForm
          initialDraft={createNoteDraft}
          defaultScopeDraft={scopeDraftFromLtmScope(navigatorScope)}
          displayContext={displayContext}
          onCancel={() => {
            void confirmDiscardCreate().then((ok) => {
              if (ok) closeCreateForm();
            });
          }}
          onDirtyChange={setCreateNoteDirty}
          onDraftChange={setCreateNoteDraft}
          onCreated={(note) => {
            closeCreateForm();
            openMemory(note.id, { mode: "edit", tab: "overview" });
          }}
        />
      </LtmModal>

      <MemoryNoteModal
        note={openNote}
        open={Boolean(openNote)}
        mode={memoryModalMode}
        activeTab={memoryModalTab}
        extractionPrefs={extractionPrefs}
        activeNotes={activeNotes.data ?? []}
        noteLookup={noteLookup}
        chatLookup={chatLookup}
        displayContext={displayContext}
        activeNotesLoading={activeNotes.isLoading}
        pendingDrafts={pendingDraftsForOpenNote}
        recallQuery={viewingRecallQuery}
        recallResult={viewingRecallResult}
        recallPending={searchMemory.isPending}
        recallContext={{
          chatLabel: selectedRecallChat ? navigatorScopeLabel : null,
          mode: selectedRecallChat ? ltmModeForChatMode(selectedRecallChat.mode) : null,
          enabled: selectedRecallSettings.enabled,
        }}
        editorDirty={editedNoteDirty}
        latestExtractionResult={latestExtractionResultForOpenNote}
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
        onLatestExtractionResultChange={(result) => {
          if (!openNote) return;
          setLatestExtractionResultForSourceNote(openNote.id, result);
        }}
        onRecoverDroppedCandidate={openRecoveryDraft}
      />

      <LongTermMemoryNoteTransferModal
        open={transferModalMode !== null}
        mode={transferModalMode ?? "copy"}
        notes={selectedTransferNotes}
        allNotes={notes.data ?? []}
        chats={chats as Chat[] | undefined}
        activeChatId={activeChatId}
        chatLookup={chatLookup}
        characterLookup={characterLookup}
        groupLookup={groupLookup}
        onClose={() => setTransferModalMode(null)}
      />
    </div>
  );
}
