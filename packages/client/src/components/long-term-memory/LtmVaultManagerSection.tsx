import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowRightLeft,
  Check,
  Copy,
  Eye,
  FileJson,
  History,
  Import,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  Chat,
  LtmExtractionDraft,
  LtmExtractionDroppedCandidate,
  LtmNote,
  LtmNoteType,
  LtmStatus,
} from "@marinara-engine/shared";
import { getLtmScopeChatIds, isGlobalLtmScope } from "@marinara-engine/shared";
import {
  useAcceptLongTermMemoryDraft,
  useDeleteLongTermMemoryDraftMutation,
  useImportLongTermMemorySourceNotes,
  useDeleteLongTermMemoryNotes,
  useLongTermMemoryDrafts,
  useLongTermMemoryImportPreview,
  useLongTermMemoryIntegrity,
  useLongTermMemoryNote,
  useLongTermMemoryNotes,
  useLongTermMemorySettings,
  useRemoveLongTermMemoryNotesFromScope,
  useSkipLongTermMemoryDraftMutations,
  useLongTermMemoryStatus,
  useSearchLongTermMemory,
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
import { LongTermMemoryDebugLogModal } from "../long-term-memory/LongTermMemoryDebugLogModal";
import { MemoryNoteModal, defaultMemoryModalTab } from "../long-term-memory/LongTermMemoryNoteModal";
import { TypeMemoryGroups } from "../long-term-memory/LongTermMemoryNoteList";
import { ImportPreviewRowItem } from "../long-term-memory/LongTermMemoryImportSection";
import { LongTermMemoryNoteTransferModal } from "../long-term-memory/LongTermMemoryNoteTransferModal";
import { friendlyIdentifier, friendlyNoteType, friendlyStatus, type LtmDisplayLookupContext } from "../long-term-memory/ltm-editor-utils";
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
  noteFilterFromNavigatorScope,
  scopeFromNavigatorSelection,
  type CharacterLookup,
  type LtmNavigatorSelection,
} from "../long-term-memory/ltm-navigator";
import { StatusPill, ToolButton } from "../long-term-memory/LtmPills";
import { Modal } from "../ui/Modal";
import { showConfirmDialog } from "../../lib/app-dialogs";
import type { LtmMode } from "@marinara-engine/shared";
import {
  IMPORT_SOURCES,
  MODE_LABELS,
  NOTE_STATUSES,
  NOTE_TYPES,
  TAB_LABELS,
  buildNoteLookup,
  characterNameFromRow,
  clampImportConcurrency,
  compactMutationText,
  derivedNoteIdsForSources,
  groupNotesByType,
  importRowKey,
  isSourceSummaryNote,
  memoryRowTitle,
  mutationKindLabel,
  mutationRiskLabel,
  mutationRiskTone,
  mutationTargetTitle,
  optionalTrimmedText,
  readLongTermMemoryRecallSearchSettings,
  scopeDraftFromLtmScope,
  sourceNoteTitle,
  suggestionRowKey,
  uniqueNoteIds,
  ModeBadge,
  Section,
  type MemoryModalMode,
  type MemoryModalTab,
  type TabId,
} from "../long-term-memory/ltm-panel-shared";
import {
  useUpdateAgentByType,
  type AgentConfigRow,
} from "../../hooks/use-agents";


type LtmImportSource = "characters" | "lorebooks" | "chats";

interface LtmVaultManagerSectionProps {
  agentConfig: AgentConfigRow;
  agentSettings: Record<string, unknown>;
  initialTab?: "notes" | "import" | "review" | "suggestions";
  sourceNoteId?: string;
}

function extractPanelPrefs(settings: Record<string, unknown>) {
  const rawImportSource = settings.importSource;
  const importSource: LtmImportSource =
    rawImportSource === "characters" || rawImportSource === "lorebooks" || rawImportSource === "chats"
      ? rawImportSource
      : "chats";
  return {
    autoApplyLowRisk: settings.autoApplyLowRisk === true,
    connectionId: typeof settings.connectionId === "string" ? settings.connectionId : "",
    importConcurrency:
      typeof settings.importConcurrency === "number"
        ? Math.max(1, Math.min(10, Math.round(settings.importConcurrency)))
        : 3,
    importLimit:
      typeof settings.importLimit === "number"
        ? Math.max(1, Math.min(100, Math.round(settings.importLimit)))
        : 25,
    importSource,
    instruction: typeof settings.instruction === "string" ? settings.instruction : "",
    model: typeof settings.model === "string" ? settings.model : "",
  };
}

export function LtmVaultManagerSection({ agentConfig: _agentConfig, agentSettings, initialTab, sourceNoteId }: LtmVaultManagerSectionProps) {
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
        "autoApplyLowRisk", "connectionId", "importConcurrency",
        "importLimit", "importSource", "instruction", "model",
      ];
      const hasRelevantValue = relevantFields.some((f) => oldPrefs[f] !== undefined && oldPrefs[f] !== "" && oldPrefs[f] !== false);
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
    initialTab === "review" ? "review" : initialTab === "import" ? "import" : "notes";
  const [tab, setTab] = useState<TabId>(initialTabId);
  const [noteType, setNoteType] = useState<"all" | LtmNoteType>("all");
  const [noteStatus, setNoteStatus] = useState<"all" | LtmStatus>("all");
  const [noteMode, setNoteMode] = useState<"all" | LtmMode>("all");
  const [query, setQuery] = useState("");
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set());
  const [selectedImportRows, setSelectedImportRows] = useState<Set<string>>(() => new Set());
  const [activeImportIds, setActiveImportIds] = useState<Set<string>>(() => new Set());
  const [importedRowsOpen, setImportedRowsOpen] = useState(false);
  const [debugLogOpen, setDebugLogOpen] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const [createNoteDraft, setCreateNoteDraft] = useState<CreateLongTermMemoryNoteDraft | null>(null);
  const [createNoteDirty, setCreateNoteDirty] = useState(false);
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
  const selectedImportChatMode = useMemo<LtmMode | null>(() => {
    if (importSource !== "chats") return null;
    const scopeChatIds = navigatorScope.chatIds ?? (navigatorScope.chatId ? [navigatorScope.chatId] : []);
    const selectedChatId = scopeChatIds[0] ?? null;
    if (!selectedChatId || !chats) return null;
    const selectedChat = (chats as Chat[]).find((chat) => chat.id === selectedChatId);
    return selectedChat?.mode === "roleplay" || selectedChat?.mode === "conversation" || selectedChat?.mode === "game"
      ? selectedChat.mode
      : null;
  }, [chats, importSource, navigatorScope.chatId, navigatorScope.chatIds]);
  const activeRecallSettings = useMemo(() => readLongTermMemoryRecallSearchSettings(ltmSettings), [ltmSettings]);
  const activeChatMessages = useChatMessages(activeChatId, activeRecallSettings.contextMessages, Boolean(openNoteId));
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
      enabled: Boolean(openNoteId),
    },
  );
  const pendingDraftsForReview = useLongTermMemoryDrafts(
    { status: "pending" },
    { enabled: tab === "review" },
  );
  const acceptDraft = useAcceptLongTermMemoryDraft();
  const deleteDraftMutation = useDeleteLongTermMemoryDraftMutation();
  const skipDraftMutations = useSkipLongTermMemoryDraftMutations();
  const exactViewingNote = useLongTermMemoryNote(openNoteId ?? undefined);
  const importPreview = useLongTermMemoryImportPreview(
    importSource,
    importLimit,
    importSource === "chats" ? navigatorScope : undefined,
  );
  const deleteNotes = useDeleteLongTermMemoryNotes();
  const removeNotesFromScope = useRemoveLongTermMemoryNotesFromScope();
  const importSourceNotes = useImportLongTermMemorySourceNotes();
  const searchMemory = useSearchLongTermMemory();
  const [recallQueryByNoteId, setRecallQueryByNoteId] = useState<Record<string, string>>({});
  const [recallResultByNoteId, setRecallResultByNoteId] = useState<Record<string, LtmSearchResponse | null>>({});

  useEffect(() => {
    if (importSource !== "chats") return;
    if (selectedImportChatMode && importMode !== selectedImportChatMode) {
      setImportMode(selectedImportChatMode);
    }
  }, [importMode, importSource, selectedImportChatMode]);

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
  const pendingImportRows = useMemo(() => importRows.filter((sample) => sample.status === "pending"), [importRows]);
  const importedImportRows = useMemo(() => importRows.filter((sample) => sample.status === "imported"), [importRows]);
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

  const reviewGroups = useMemo(() => {
    const drafts = pendingDraftsForReview.data ?? [];
    const groups = new Map<string, LtmExtractionDraft[]>();
    for (const draft of drafts) {
      const sourceNoteId = draft.source.sourceNoteId;
      if (!sourceNoteId) continue;
      const existing = groups.get(sourceNoteId);
      if (existing) existing.push(draft);
      else groups.set(sourceNoteId, [draft]);
    }
    return Array.from(groups.entries()).map(([sourceNoteId, sourceDrafts]) => {
      const sourceNote = noteLookup.get(sourceNoteId);
      const totalMutations = sourceDrafts.reduce((sum, d) => sum + d.mutations.length, 0);
      return { sourceNoteId, sourceNote, sourceDrafts, totalMutations, mode: sourceDrafts[0]?.modes[0] ?? null };
    });
  }, [pendingDraftsForReview.data, noteLookup]);

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

  const keepOrphanMutation = async (draft: LtmExtractionDraft, mutationId: string) => {
    try {
      await acceptDraft.mutateAsync({ id: draft.id, mutationIds: [mutationId] });
      toast.success("Suggestion kept");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const skipOrphanMutation = async (draft: LtmExtractionDraft, mutationId: string) => {
    try {
      await deleteDraftMutation.mutateAsync({ id: draft.id, mutationId });
      toast.success("Suggestion skipped");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const skipAllOrphans = async (drafts: LtmExtractionDraft[]) => {
    const total = drafts.reduce((s, d) => s + d.mutations.length, 0);
    const confirmed = await showConfirmDialog({
      title: "Skip all orphaned suggestions?",
      message: `This will skip ${total} suggestion${total === 1 ? "" : "s"} from a deleted source. This cannot be undone.`,
      confirmLabel: "Skip all",
      tone: "destructive",
    });
    if (!confirmed) return;
    for (const draft of drafts) {
      try {
        await skipDraftMutations.mutateAsync({ id: draft.id, mutationIds: draft.mutations.map((m) => m.id) });
      } catch (err) {
        toast.error((err as Error).message);
      }
    }
    toast.success("All orphaned suggestions skipped");
  };

  const setTabWithGuards = async (nextTab: TabId) => {
    if (nextTab === tab) return;
    if (creatingNote && !(await confirmDiscardCreate())) return;
    if (memoryModalMode === "edit" && !(await confirmDiscardEditor())) return;
    if (creatingNote) closeCreateForm();
    if (openNoteId) closeMemoryModal();
    setTab(nextTab);
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

  const activeScopeChatIds = useMemo(
    () => getLtmScopeChatIds(navigatorScope),
    [navigatorScope],
  );

  const noteIsSharedBeyondScope = useCallback(
    (note: LtmNote): boolean => {
      if (isGlobalLtmScope(note.scope)) return true;
      const noteChatIds = new Set(getLtmScopeChatIds(note.scope));
      const hasGroupId = Boolean(note.scope.groupId);
      const hasCharacterIds = Boolean(note.scope.characterIds?.length);
      if (hasGroupId || hasCharacterIds) {
        if (noteChatIds.size > 0) return true;
        return activeScopeChatIds.length === 0;
      }
      if (activeScopeChatIds.length === 0) return true;
      return noteChatIds.size > activeScopeChatIds.filter((id) => noteChatIds.has(id)).length;
    },
    [activeScopeChatIds],
  );

  const removeMemoriesFromScopeById = async (ids: string[], chatIds: string[]) => {
    const uniqueIds = uniqueNoteIds(ids);
    if (uniqueIds.length === 0 || chatIds.length === 0) return;

    try {
      const result = await removeNotesFromScope.mutateAsync({ ids: uniqueIds, chatIds });
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

      if (result.failedIds.length > 0) {
        toast.error(
          `${allAffected.length} memor${allAffected.length === 1 ? "y" : "ies"} affected, ${result.failedIds.length} failed.`,
        );
      } else if (result.deletedIds.length > 0 && result.removedIds.length > 0) {
        toast.success(
          `${result.removedIds.length} removed from this chat, ${result.deletedIds.length} permanently deleted`,
        );
      } else if (result.deletedIds.length > 0) {
        toast.success(`${result.deletedIds.length} memor${result.deletedIds.length === 1 ? "y" : "ies"} deleted`);
      } else {
        toast.success(`${result.removedIds.length} memor${result.removedIds.length === 1 ? "y" : "ies"} removed from this chat`);
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

  const confirmDerivedDeleteIds = async (ids: string[]) => {
    const selectedIds = new Set(ids);
    const sourceIds = new Set(
      ids.filter((id) => {
        const note = noteLookup.get(id);
        return note ? isSourceSummaryNote(note) : false;
      }),
    );
    const unselectedDerivedIds = derivedNoteIdsForSources(combinedNotes, sourceIds).filter((id) => !selectedIds.has(id));
    if (unselectedDerivedIds.length === 0) return ids;

    const includeDerived = await showConfirmDialog({
      title: "Delete Extracted Memories",
      message: `${sourceIds.size} selected source memor${sourceIds.size === 1 ? "y has" : "ies have"} ${unselectedDerivedIds.length} extracted memor${unselectedDerivedIds.length === 1 ? "y" : "ies"}. Delete extracted memories too?`,
      confirmLabel: "Delete All",
      tone: "destructive",
    });
    return includeDerived ? uniqueNoteIds([...ids, ...unselectedDerivedIds]) : ids;
  };

  const deleteMemory = async (note: LtmNote) => {
    const title = memoryRowTitle(note, chatLookup);
    const scopeChatIds = activeScopeChatIds;

    if (scopeChatIds.length > 0 && noteIsSharedBeyondScope(note)) {
      const choice = await showConfirmDialog({
        title: "Remove Memory",
        message: `Remove "${title}" from this chat? It will still be available in other chats it belongs to.`,
        confirmLabel: "Remove from chat",
        tone: "destructive",
      });
      if (!choice) return;
      const ids = await confirmDerivedDeleteIds([note.id]);
      void removeMemoriesFromScopeById(ids, scopeChatIds);
      return;
    }

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

  const deleteSelectedMemories = async () => {
    const ids = selectedVisibleNoteIds;
    if (ids.length === 0) return;
    const scopeChatIds = activeScopeChatIds;
    const selectedNotes = ids.map((id) => noteLookup.get(id)).filter((n): n is LtmNote => Boolean(n));
    const anyShared = selectedNotes.some((note) => noteIsSharedBeyondScope(note));

    if (scopeChatIds.length > 0 && anyShared) {
      const choice = await showConfirmDialog({
        title: "Remove Memories",
        message: `Remove ${ids.length} selected memor${ids.length === 1 ? "y" : "ies"} from this chat? Memories that are only in this chat will be permanently deleted; shared memories will remain in other chats.`,
        confirmLabel: "Remove from chat",
        tone: "destructive",
      });
      if (!choice) return;
      const allIds = await confirmDerivedDeleteIds(ids);
      void removeMemoriesFromScopeById(allIds, scopeChatIds);
      return;
    }

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
        importConcurrency: clampImportConcurrency(importConcurrencySetting),
        ...(importSource === "chats" ? { mode: importMode } : {}),
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
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--secondary)]/35 p-1 ring-1 ring-[var(--border)]/80">
            {(["notes", "import", "review"] as TabId[]).map((id) => (
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

          <LtmNavigatorSelector
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
            <div className="grid grid-cols-3 gap-2">
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
              <select
                value={noteMode}
                onChange={(event) => setNoteMode(event.target.value as "all" | LtmMode)}
                className={compactInputClassName}
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
                  <>
                    <ToolButton onClick={() => openTransferModal("copy")} disabled={deleteNotes.isPending}>
                      <Copy size="0.875rem" />
                      Copy selected
                    </ToolButton>
                    <ToolButton onClick={() => openTransferModal("move")} disabled={deleteNotes.isPending}>
                      <ArrowRightLeft size="0.875rem" />
                      Move selected
                    </ToolButton>
                    <ToolButton onClick={() => setAllVisibleNotesSelected(false)} disabled={deleteNotes.isPending}>
                      <RotateCcw size="0.875rem" />
                      Clear selection
                    </ToolButton>
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
                  </>
                )}
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

      {tab === "import" && (
        <Section title="Import">
          <div className={panelIntroCardClassName}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--foreground)]">
                  {importPreview.data?.draftable ?? 0} pending source{importPreview.data?.draftable === 1 ? "" : "s"} ready
                </div>
                <div className="mt-1 text-[0.6875rem] text-[var(--muted-foreground)]">
                  {importPreview.data?.importedCount ?? 0} source{importPreview.data?.importedCount === 1 ? "" : "s"} already imported
                </div>
              </div>
              {importPreview.isLoading ? <Loader2 className="animate-spin" size="1rem" /> : <FileJson size="1rem" />}
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

          <div className={cn("grid gap-2", importSource === "chats" ? "sm:grid-cols-[1fr_1fr_auto]" : "sm:grid-cols-[1fr_auto]") }>
            {importSource === "chats" && (
              <select
                value={importMode}
                onChange={(event) => setImportMode(event.target.value as LtmMode)}
                className={compactInputClassName}
              >
                {(["roleplay", "conversation", "game"] as const).map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            )}
            <select
              value={importSource}
              onChange={(event) => handlePrefsChange({ importSource: event.target.value as LtmInteropSource })}
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
              onChange={(event) => handlePrefsChange({ importLimit: Number(event.target.value) })}
              className={cn(compactInputClassName, "w-24")}
            />
          </div>
          <div className={cn(sectionCardClassName, "mt-2")}>
            <div className="flex flex-wrap gap-1.5">
              <StatusPill label={`${clampImportConcurrency(importConcurrencySetting)} at once`} />
              {importApplyLowRisk ? <StatusPill label="Low-risk auto-apply" tone="warn" /> : null}
            </div>
            <p className={cn("mt-2", helperTextClassName)}>
              Import uses the shared extraction defaults, including connection, model, instruction,
              and low-risk auto-apply.
            </p>
          </div>
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
            {!importPreview.isLoading && pendingImportRows.length === 0 && importedImportRows.length === 0 && (
              <p className={emptyStateClassName}>
                No sources are ready to bring in.
              </p>
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
                  className="flex w-full items-center justify-between gap-3 text-left"
                >
                  <div>
                    <div className="text-xs font-semibold text-[var(--foreground)]">
                      Imported source{importedImportRows.length === 1 ? "" : "s"} ({importedImportRows.length})
                    </div>
                    <div className="mt-1 text-[0.6875rem] text-[var(--muted-foreground)]">
                      Already present in the vault. These stay visible for reference, but cannot be imported again.
                    </div>
                  </div>
                  {importedRowsOpen ? <Check size="0.875rem" /> : <Import size="0.875rem" />}
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
        </Section>
      )}

      {tab === "review" && (
        <Section title="Review">
          {pendingDraftsForReview.isLoading && (
            <Loader2 className="mx-auto animate-spin text-[var(--muted-foreground)]" />
          )}
          {!pendingDraftsForReview.isLoading && reviewGroups.length === 0 && (
            <p className={emptyStateClassName}>No pending suggestions to review.</p>
          )}
          {!pendingDraftsForReview.isLoading && reviewGroups.length > 0 && (
            <div className="space-y-2">
              {reviewGroups.map(({ sourceNoteId, sourceNote, sourceDrafts, totalMutations, mode }) => (
                <div key={sourceNoteId}>
                  {sourceNote ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="truncate text-xs font-semibold text-[var(--foreground)]">
                            {memoryRowTitle(sourceNote, chatLookup)}
                          </p>
                          {mode ? <ModeBadge mode={mode} /> : null}
                        </div>
                        <p className="mt-0.5 text-[0.6875rem] text-[var(--muted-foreground)]">
                          {totalMutations} pending suggestion{totalMutations === 1 ? "" : "s"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => openMemory(sourceNoteId, { tab: "suggestions" })}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-2.5 py-1.5 text-xs font-semibold text-[var(--primary-foreground)] transition-colors hover:opacity-90"
                      >
                        <Eye size="0.75rem" />
                        Review
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <AlertCircle size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
                            <span className="truncate text-xs font-semibold text-[var(--foreground)]">
                              {friendlyIdentifier(sourceNoteId)}
                            </span>
                            {mode ? <ModeBadge mode={mode} /> : null}
                            <StatusPill label="Source deleted" tone="warn" />
                          </div>
                          <p className="mt-0.5 text-[0.6875rem] text-[var(--muted-foreground)]">
                            {totalMutations} pending suggestion{totalMutations === 1 ? "" : "s"}
                          </p>
                        </div>
                        <ToolButton onClick={() => skipAllOrphans(sourceDrafts)} tone="danger">
                          <X size="0.875rem" />
                          Skip all
                        </ToolButton>
                      </div>
                      <div className="space-y-2">
                        {sourceDrafts.map((draft) =>
                          draft.mutations.map((mutation) => (
                              <div
                                key={suggestionRowKey(draft.id, mutation.id)}
                                className="rounded-lg bg-[var(--card)] p-3 ring-1 ring-[var(--border)]"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <StatusPill label={mutationKindLabel(mutation.kind)} />
                                      <StatusPill
                                        label={mutationRiskLabel(mutation.risk)}
                                        tone={mutationRiskTone(mutation.risk)}
                                      />
                                    </div>
                                    <h4 className="mt-2 text-xs font-medium text-[var(--foreground)]">
                                      {mutationTargetTitle(mutation)}
                                    </h4>
                                    <p className="mt-1 whitespace-pre-wrap text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                                      {compactMutationText(mutation, noteLookup)}
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 gap-1.5">
                                    <ToolButton
                                      onClick={() => keepOrphanMutation(draft, mutation.id)}
                                      tone="primary"
                                    >
                                      <Check size="0.875rem" />
                                      Keep
                                    </ToolButton>
                                    <ToolButton onClick={() => skipOrphanMutation(draft, mutation.id)}>
                                      <X size="0.875rem" />
                                      Skip
                                    </ToolButton>
                                  </div>
                                </div>
                              </div>
                            )),
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      <Modal
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

      <LongTermMemoryDebugLogModal open={debugLogOpen} onClose={() => setDebugLogOpen(false)} />
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
      {(status.isLoading || integrity.isLoading) && (
        <div className="fixed bottom-3 right-3 rounded-full bg-[var(--card)] p-2 shadow-sm ring-1 ring-[var(--border)]">
          <Loader2 size="1rem" className="animate-spin" />
        </div>
      )}
    </div>
  );
}
