// ──────────────────────────────────────────────
// Panel: Presets (overhauled — search, assign, edit, duplicate)
// ──────────────────────────────────────────────
import {
  useState,
  useMemo,
  useCallback,
  useRef,
  type ChangeEvent,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  type TouchEvent,
} from "react";
import { toast } from "sonner";
import { usePresets, useDeletePreset, useDuplicatePreset, useSetDefaultPreset } from "../../hooks/use-presets";
import { useUpdateChat, useUpdateChatMetadata } from "../../hooks/use-chats";
import {
  useRegexScripts,
  useDeleteRegexScript,
  useCreateRegexScript,
  useUpdateRegexScript,
  useReorderRegexScripts,
  type RegexScriptRow,
} from "../../hooks/use-regex-scripts";
import { useChatStore } from "../../stores/chat.store";
import { useUIStore } from "../../stores/ui.store";
import { api } from "../../lib/api-client";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { ChoiceSelectionModal } from "../presets/ChoiceSelectionModal";
import {
  Plus,
  Download,
  FileText,
  Trash2,
  Check,
  Copy,
  Search,
  Code2,
  Hash,
  Star,
  Regex,
  GripVertical,
  ToggleLeft,
  ToggleRight,
  Pencil,
  ChevronDown,
  ChevronRight,
  FolderPlus,
} from "lucide-react";
import { cn } from "../../lib/utils";
import {
  getNextUnnamedLibraryFolderName,
  useCreateLibraryFolder,
  useDeleteLibraryFolder,
  useLibraryFolders,
  useMoveLibraryItem,
  useUpdateLibraryFolder,
} from "../../hooks/use-library-folders";

type PresetRow = {
  id: string;
  name: string;
  description: string;
  wrapFormat?: string;
  isDefault?: string | boolean;
  author?: string;
  sectionOrder?: string | string[];
};

export function PresetsPanel() {
  const { data: presets, isLoading } = usePresets();
  const { data: regexScripts } = useRegexScripts();
  const deletePreset = useDeletePreset();
  const duplicatePreset = useDuplicatePreset();
  const setDefaultPreset = useSetDefaultPreset();
  const deleteRegex = useDeleteRegexScript();
  const createRegexScript = useCreateRegexScript();
  const updateRegex = useUpdateRegexScript();
  const reorderRegexScripts = useReorderRegexScripts();
  const { data: presetFolders = [] } = useLibraryFolders("presets");
  const createPresetFolder = useCreateLibraryFolder("presets");
  const updatePresetFolder = useUpdateLibraryFolder("presets");
  const deletePresetFolder = useDeleteLibraryFolder("presets");
  const movePresetItem = useMoveLibraryItem("presets");
  const openModal = useUIStore((s) => s.openModal);
  const openPresetDetail = useUIStore((s) => s.openPresetDetail);
  const openRegexDetail = useUIStore((s) => s.openRegexDetail);
  const activeChat = useChatStore((s) => s.activeChat);
  const updateChat = useUpdateChat();
  const updateMetadata = useUpdateChatMetadata();
  const [search, setSearch] = useState("");
  const [choiceModalPresetId, setChoiceModalPresetId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPresetIds, setSelectedPresetIds] = useState<Set<string>>(new Set());
  const [exportingSelected, setExportingSelected] = useState(false);
  const [regexImportError, setRegexImportError] = useState<string | null>(null);
  const [regexImportSuccess, setRegexImportSuccess] = useState<string | null>(null);
  const [draggedRegexId, setDraggedRegexId] = useState<string | null>(null);
  const [regexDragReadyId, setRegexDragReadyId] = useState<string | null>(null);
  const [expandedFolderId, setExpandedFolderId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editFolderName, setEditFolderName] = useState("");
  const [draggedPresetId, setDraggedPresetId] = useState<string | null>(null);
  const presetTouchDragRef = useRef<{ id: string; timer: number | null; active: boolean } | null>(null);
  const suppressPresetClickRef = useRef(false);

  const canAssignToActiveChat = !!activeChat && activeChat.mode !== "conversation";
  const activePresetId = canAssignToActiveChat ? (activeChat?.promptPresetId ?? null) : null;

  const filteredPresets = useMemo(() => {
    if (!presets) return [];
    if (!search.trim()) return presets as unknown as PresetRow[];
    const q = search.toLowerCase();
    return (presets as unknown as PresetRow[]).filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        (p.author ?? "").toLowerCase().includes(q),
    );
  }, [presets, search]);

  const presetById = useMemo(() => new Map(filteredPresets.map((preset) => [preset.id, preset])), [filteredPresets]);

  const folderedPresetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const folder of presetFolders) {
      for (const id of folder.itemIds) ids.add(id);
    }
    return ids;
  }, [presetFolders]);

  const rootPresets = useMemo(
    () => filteredPresets.filter((preset) => !folderedPresetIds.has(preset.id)),
    [filteredPresets, folderedPresetIds],
  );

  const sortedRegexScripts = useMemo(
    () => [...((regexScripts ?? []) as RegexScriptRow[])].sort((a, b) => a.order - b.order),
    [regexScripts],
  );

  const selectPreset = useCallback(
    (presetId: string) => {
      if (!activeChat) return;
      if (activeChat.mode === "conversation") {
        toast.error("Prompt presets are not available in conversation mode.");
        return;
      }
      const newId = activePresetId === presetId ? null : presetId;
      // Clear stale preset choices from the previous preset before switching
      updateMetadata.mutate({ id: activeChat.id, presetChoices: {} });
      updateChat.mutate(
        { id: activeChat.id, promptPresetId: newId },
        {
          onSuccess: async () => {
            if (!newId) {
              setChoiceModalPresetId(null);
              return;
            }

            try {
              const presetFull = await api.get<{ choiceBlocks?: unknown[] }>(`/prompts/${newId}/full`);
              if ((presetFull.choiceBlocks?.length ?? 0) > 0) {
                setChoiceModalPresetId(newId);
              } else {
                setChoiceModalPresetId(null);
              }
            } catch {
              setChoiceModalPresetId(null);
            }
          },
        },
      );
    },
    [activeChat, activePresetId, updateChat, updateMetadata],
  );

  const getSectionCount = useCallback((preset: PresetRow) => {
    try {
      const order = preset.sectionOrder;
      if (Array.isArray(order)) return order.length;
      return JSON.parse(order ?? "[]").length;
    } catch {
      return 0;
    }
  }, []);

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedPresetIds(new Set());
  };

  const toggleSelection = useCallback((presetId: string) => {
    setSelectedPresetIds((prev) => {
      const next = new Set(prev);
      if (next.has(presetId)) next.delete(presetId);
      else next.add(presetId);
      return next;
    });
  }, []);

  const handleExportSelected = async () => {
    if (selectedPresetIds.size === 0) return;
    setExportingSelected(true);
    try {
      await api.downloadPost("/prompts/export-bulk", { ids: [...selectedPresetIds] }, "marinara-presets.zip");
      toast.success(`Exported ${selectedPresetIds.size} preset${selectedPresetIds.size === 1 ? "" : "s"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to export presets");
    } finally {
      setExportingSelected(false);
    }
  };

  const handleCreateRegex = useCallback(() => {
    openRegexDetail("__new__");
  }, [openRegexDetail]);

  const handleImportRegex = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      setRegexImportError(null);
      setRegexImportSuccess(null);
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        if (entries.length === 0) throw new Error("No regex scripts found in file");

        let imported = 0;
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const obj = entry as Record<string, unknown>;
          const name =
            typeof obj.name === "string" ? obj.name : typeof obj.scriptName === "string" ? obj.scriptName : "";
          let findRegex = typeof obj.findRegex === "string" ? obj.findRegex : "";
          let flags = typeof obj.flags === "string" ? obj.flags : "gi";
          const delimited = findRegex.match(/^\/(.+)\/([gimsuy]*)$/s);
          if (delimited) {
            findRegex = delimited[1] ?? "";
            flags = delimited[2] || "g";
          }
          if (!name || !findRegex) continue;

          const stPlacementMap: Record<number, string> = { 1: "user_input", 2: "ai_output" };
          let placement: string[] = ["ai_output"];
          if (Array.isArray(obj.placement)) {
            const mapped = obj.placement
              .map((placementValue) =>
                typeof placementValue === "number" ? stPlacementMap[placementValue] : placementValue,
              )
              .filter(
                (placementValue): placementValue is string =>
                  placementValue === "ai_output" || placementValue === "user_input",
              );
            if (mapped.length > 0) placement = mapped;
          }

          let enabled = true;
          if (typeof obj.enabled === "boolean") enabled = obj.enabled;
          else if (typeof obj.enabled === "string") enabled = obj.enabled !== "false";
          else if (typeof obj.disabled === "boolean") enabled = !obj.disabled;

          await createRegexScript.mutateAsync({
            name,
            enabled,
            findRegex,
            replaceString: typeof obj.replaceString === "string" ? obj.replaceString : "",
            trimStrings: Array.isArray(obj.trimStrings)
              ? obj.trimStrings.filter((value): value is string => typeof value === "string")
              : [],
            placement,
            flags,
            promptOnly: typeof obj.promptOnly === "boolean" ? obj.promptOnly : false,
            order: typeof obj.order === "number" ? obj.order : 0,
            minDepth: typeof obj.minDepth === "number" ? obj.minDepth : null,
            maxDepth: typeof obj.maxDepth === "number" ? obj.maxDepth : null,
          });
          imported++;
        }

        setRegexImportSuccess(`Imported ${imported} regex script${imported === 1 ? "" : "s"}.`);
      } catch (error) {
        setRegexImportError(error instanceof Error ? error.message : "Failed to import regex scripts");
      }

      event.target.value = "";
    },
    [createRegexScript],
  );

  const handleRegexDrop = useCallback(
    (targetId: string) => {
      if (!draggedRegexId || draggedRegexId === targetId) return;
      const nextIds = sortedRegexScripts.map((script) => script.id);
      const from = nextIds.indexOf(draggedRegexId);
      const to = nextIds.indexOf(targetId);
      if (from < 0 || to < 0) return;
      const [moved] = nextIds.splice(from, 1);
      if (!moved) return;
      nextIds.splice(to, 0, moved);
      reorderRegexScripts.mutate(nextIds);
      setDraggedRegexId(null);
      setRegexDragReadyId(null);
    },
    [draggedRegexId, reorderRegexScripts, sortedRegexScripts],
  );

  const handleDeleteSelected = useCallback(async () => {
    const ids = [...selectedPresetIds];
    if (ids.length === 0) return;

    if (
      !(await showConfirmDialog({
        title: "Delete Presets",
        message: `Delete ${ids.length} preset${ids.length === 1 ? "" : "s"}?`,
        confirmLabel: "Delete",
        tone: "destructive",
      }))
    ) {
      return;
    }

    const results = await Promise.allSettled(ids.map((id) => deletePreset.mutateAsync(id)));
    const failedIds = ids.filter((_, index) => results[index]?.status === "rejected");
    const deletedCount = ids.length - failedIds.length;

    if (deletedCount > 0) {
      toast.success(`Deleted ${deletedCount} preset${deletedCount === 1 ? "" : "s"}`);
    }

    if (failedIds.length > 0) {
      setSelectedPresetIds(new Set(failedIds));
      toast.error(`Failed to delete ${failedIds.length} preset${failedIds.length === 1 ? "" : "s"}`);
      return;
    }

    exitSelectionMode();
  }, [selectedPresetIds, deletePreset]);

  const handleCreateFolder = useCallback(() => {
    createPresetFolder.mutate(
      { name: getNextUnnamedLibraryFolderName(presetFolders) },
      {
        onSuccess: (folder) => {
          setExpandedFolderId(folder.id);
        },
      },
    );
  }, [createPresetFolder, presetFolders]);

  const handleRenameFolder = useCallback(
    (folderId: string) => {
      const name = editFolderName.trim();
      if (!name) return;
      updatePresetFolder.mutate({ id: folderId, name });
      setEditingFolderId(null);
      setEditFolderName("");
    },
    [editFolderName, updatePresetFolder],
  );

  const movePresetToFolder = useCallback(
    (presetId: string, folderId: string | null) => {
      movePresetItem.mutate({ itemId: presetId, folderId });
    },
    [movePresetItem],
  );

  const handlePresetDrop = useCallback(
    (folderId: string | null) => {
      if (!draggedPresetId) return;
      movePresetToFolder(draggedPresetId, folderId);
      setDraggedPresetId(null);
    },
    [draggedPresetId, movePresetToFolder],
  );

  const startPresetTouchDrag = useCallback(
    (event: TouchEvent, presetId: string) => {
      if (selectionMode) return;
      const timer = window.setTimeout(() => {
        presetTouchDragRef.current = { id: presetId, timer: null, active: true };
        suppressPresetClickRef.current = true;
        setDraggedPresetId(presetId);
      }, 450);
      presetTouchDragRef.current = { id: presetId, timer, active: false };
      event.currentTarget.addEventListener(
        "touchcancel",
        () => {
          const current = presetTouchDragRef.current;
          if (current?.timer) window.clearTimeout(current.timer);
          presetTouchDragRef.current = null;
          setDraggedPresetId(null);
        },
        { once: true },
      );
    },
    [selectionMode],
  );

  const finishPresetTouchDrag = useCallback(
    (event: TouchEvent) => {
      const current = presetTouchDragRef.current;
      if (!current) return;
      if (current.timer) window.clearTimeout(current.timer);
      presetTouchDragRef.current = null;
      if (!current.active) return;
      const touch = event.changedTouches[0];
      const target = touch ? document.elementFromPoint(touch.clientX, touch.clientY) : null;
      const folderElement = target?.closest("[data-preset-folder-id]") as HTMLElement | null;
      const rootElement = target?.closest("[data-preset-folder-root]") as HTMLElement | null;
      if (folderElement?.dataset.presetFolderId) {
        movePresetToFolder(current.id, folderElement.dataset.presetFolderId);
      } else if (rootElement) {
        movePresetToFolder(current.id, null);
      }
      setDraggedPresetId(null);
      window.setTimeout(() => {
        suppressPresetClickRef.current = false;
      }, 0);
    },
    [movePresetToFolder],
  );

  const renderPresetRow = useCallback(
    (preset: PresetRow) => {
      const isSelected = activePresetId === preset.id;
      const isBulkSelected = selectedPresetIds.has(preset.id);
      const sectionCount = getSectionCount(preset);
      const wrapFormat = (preset.wrapFormat ?? "xml") as string;
      const isDefault = preset.isDefault === "true";

      return (
        <div
          key={preset.id}
          className={cn(
            "group relative flex cursor-pointer items-center gap-3 rounded-xl p-2.5 transition-all hover:bg-[var(--sidebar-accent)]",
            selectionMode && isBulkSelected && "ring-1 ring-purple-400/40 bg-purple-400/10",
            isSelected && "ring-1 ring-purple-400/40 bg-purple-400/5",
            draggedPresetId === preset.id && "opacity-50",
          )}
          draggable={!selectionMode}
          onDragStart={(event) => {
            if (selectionMode) {
              event.preventDefault();
              return;
            }
            setDraggedPresetId(preset.id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", preset.id);
          }}
          onDragEnd={() => setDraggedPresetId(null)}
          onTouchStart={(event) => startPresetTouchDrag(event, preset.id)}
          onTouchEnd={finishPresetTouchDrag}
        >
          <div
            className="flex min-w-0 flex-1 items-center gap-3"
            onClick={() => {
              if (suppressPresetClickRef.current) return;
              if (selectionMode) toggleSelection(preset.id);
              else openPresetDetail(preset.id);
            }}
          >
            {selectionMode && (
              <div
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors",
                  isBulkSelected
                    ? "border-purple-400 bg-purple-400 text-white"
                    : "border-[var(--muted-foreground)]/40 bg-[var(--secondary)] text-transparent",
                )}
              >
                <Check size="0.75rem" />
              </div>
            )}
            <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-purple-400 to-violet-500 text-white shadow-sm">
              <FileText size="1rem" />
              {isSelected && (
                <div className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-purple-400 shadow-sm">
                  <Check size="0.625rem" className="text-white" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{preset.name}</span>
                {isDefault && (
                  <span className="shrink-0 rounded bg-purple-400/15 px-1 py-0.5 text-[0.5625rem] font-medium text-purple-400">
                    DEFAULT
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[0.6875rem] text-[var(--muted-foreground)]">
                <span className="flex items-center gap-0.5">
                  {wrapFormat === "xml" ? <Code2 size="0.5625rem" /> : <Hash size="0.5625rem" />}
                  {wrapFormat.toUpperCase()}
                </span>
                <span>{sectionCount} sections</span>
                {preset.author && <span className="truncate">by {preset.author}</span>}
              </div>
            </div>
          </div>

          {!selectionMode && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex shrink-0 items-center gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 max-md:opacity-100">
              {canAssignToActiveChat && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    selectPreset(preset.id);
                  }}
                  className={cn(
                    "rounded-lg p-1.5 transition-all active:scale-90",
                    isSelected
                      ? "bg-purple-400/15 text-purple-400"
                      : "text-[var(--muted-foreground)] hover:bg-[var(--primary)]/10 hover:text-[var(--primary)]",
                  )}
                  title={isSelected ? "Unassign from chat" : "Assign to chat"}
                >
                  <Check size="0.75rem" />
                </button>
              )}
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setDefaultPreset.mutate(preset.id);
                }}
                className={cn(
                  "rounded-lg p-1.5 transition-all active:scale-90",
                  isDefault
                    ? "text-yellow-500"
                    : "text-[var(--muted-foreground)] hover:bg-yellow-500/10 hover:text-yellow-500",
                )}
                title={isDefault ? "Default preset" : "Set as default"}
              >
                <Star size="0.75rem" className={isDefault ? "fill-yellow-500" : ""} />
              </button>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  duplicatePreset.mutate(preset.id);
                }}
                className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-all hover:bg-sky-400/10 hover:text-sky-400 active:scale-90"
                title="Duplicate"
              >
                <Copy size="0.75rem" />
              </button>
              <button
                onClick={async (event) => {
                  event.stopPropagation();
                  if (
                    await showConfirmDialog({
                      title: "Delete Preset",
                      message: `Delete "${preset.name}"?`,
                      confirmLabel: "Delete",
                      tone: "destructive",
                    })
                  ) {
                    deletePreset.mutate(preset.id);
                  }
                }}
                className="rounded-lg p-1.5 transition-all hover:bg-[var(--destructive)]/15 active:scale-90"
                title="Delete"
              >
                <Trash2 size="0.75rem" className="text-[var(--destructive)]" />
              </button>
            </div>
          )}
        </div>
      );
    },
    [
      activePresetId,
      canAssignToActiveChat,
      deletePreset,
      draggedPresetId,
      duplicatePreset,
      finishPresetTouchDrag,
      getSectionCount,
      openPresetDetail,
      selectedPresetIds,
      selectPreset,
      selectionMode,
      setDefaultPreset,
      startPresetTouchDrag,
      toggleSelection,
    ],
  );

  return (
    <div className="flex flex-col gap-2 p-3">
      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => openModal("create-preset")}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-purple-400 to-violet-500 px-3 py-2.5 text-xs font-medium text-white shadow-md shadow-purple-400/15 transition-all hover:shadow-lg hover:shadow-purple-400/25 active:scale-[0.98]"
          title="New"
        >
          <Plus size="0.8125rem" /> <span className="md:hidden">New</span>
        </button>
        <button
          onClick={() => openModal("import-preset")}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-xs font-medium text-[var(--secondary-foreground)] ring-1 ring-[var(--border)] transition-all hover:bg-[var(--accent)] active:scale-[0.98]"
          title="Import"
        >
          <Download size="0.8125rem" /> <span className="md:hidden">Import</span>
        </button>
        <button
          onClick={() => {
            if (selectionMode) exitSelectionMode();
            else setSelectionMode(true);
          }}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-medium transition-all",
            selectionMode
              ? "bg-purple-400/15 text-purple-400 ring-1 ring-purple-400/30"
              : "bg-[var(--secondary)] text-[var(--secondary-foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)]",
          )}
          title="Select"
        >
          <Check size="0.8125rem" /> <span className="md:hidden">Select</span>
        </button>
      </div>

      {selectionMode && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--secondary)]/60 px-3 py-2">
          <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
            {selectedPresetIds.size} selected
          </span>
          <button
            onClick={() => setSelectedPresetIds(new Set(filteredPresets.map((preset) => preset.id)))}
            disabled={filteredPresets.length === 0}
            className="rounded-lg px-2.5 py-1 text-[0.625rem] font-medium text-purple-400 transition-colors hover:bg-[var(--accent)] disabled:opacity-40"
          >
            Select visible
          </button>
          <button
            onClick={() => setSelectedPresetIds(new Set())}
            disabled={selectedPresetIds.size === 0}
            className="rounded-lg px-2.5 py-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
          >
            Clear
          </button>
          <button
            onClick={handleDeleteSelected}
            disabled={selectedPresetIds.size === 0}
            className="inline-flex items-center gap-1 rounded-lg bg-[var(--destructive)]/12 px-2.5 py-1 text-[0.625rem] font-medium text-[var(--destructive)] transition-all hover:bg-[var(--destructive)]/20 disabled:opacity-40"
          >
            <Trash2 size="0.6875rem" />
            Delete
          </button>
          <button
            onClick={handleExportSelected}
            disabled={selectedPresetIds.size === 0 || exportingSelected}
            className="inline-flex items-center gap-1 rounded-lg bg-purple-500 px-2.5 py-1 text-[0.625rem] font-medium text-white transition-all hover:opacity-90 disabled:opacity-40"
          >
            <Download size="0.6875rem" />
            {exportingSelected ? "Exporting..." : "Export ZIP"}
          </button>
          <button
            onClick={exitSelectionMode}
            className="rounded-lg px-2.5 py-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          >
            Done
          </button>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search
          size="0.8125rem"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
        />
        <input
          type="text"
          placeholder="Search presets…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-xl bg-[var(--secondary)] py-2 pl-8 pr-3 text-xs text-[var(--foreground)] ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
        />
      </div>

      <PanelSection title="Presets" icon={<FileText size="0.8125rem" />}>
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <button
              onClick={handleCreateFolder}
              className="flex flex-1 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.6875rem] text-[var(--muted-foreground)] transition-all hover:bg-[var(--sidebar-accent)]/40 hover:text-[var(--foreground)]"
            >
              <FolderPlus size="0.75rem" />
              New Folder
            </button>
          </div>
          {presetFolders.length > 0 && (
            <p className="px-2.5 pb-1 text-[0.625rem] leading-snug text-[var(--muted-foreground)]/70">
              Drag and drop presets to folders
            </p>
          )}
          {presetFolders.map((folder) => {
            const isExpanded = expandedFolderId === folder.id;
            const isEditing = editingFolderId === folder.id;
            const folderItems = folder.itemIds
              .map((id) => presetById.get(id))
              .filter((item): item is PresetRow => Boolean(item));
            return (
              <div
                key={folder.id}
                data-preset-folder-id={folder.id}
                onDragOver={(event) => {
                  if (draggedPresetId) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handlePresetDrop(folder.id);
                }}
                className="flex flex-col rounded-lg transition-colors"
              >
                <div
                  className="group relative flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 transition-all hover:bg-[var(--sidebar-accent)]/40"
                  onClick={() => setExpandedFolderId(isExpanded ? null : folder.id)}
                >
                  <ChevronRight
                    size="0.75rem"
                    className={cn(
                      "shrink-0 text-[var(--muted-foreground)] transition-transform",
                      isExpanded && "rotate-90",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editFolderName}
                        onChange={(event) => setEditFolderName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") handleRenameFolder(folder.id);
                          if (event.key === "Escape") {
                            setEditingFolderId(null);
                            setEditFolderName("");
                          }
                        }}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={() => handleRenameFolder(folder.id)}
                        className="w-full rounded bg-transparent px-1 py-0.5 text-xs font-medium outline-none ring-1 ring-purple-400/30"
                      />
                    ) : (
                      <>
                        <div className="truncate text-xs font-medium text-[var(--muted-foreground)]">{folder.name}</div>
                      </>
                    )}
                  </div>
                  {folder.itemIds.length > 0 && (
                    <span className="shrink-0 text-[0.5625rem] text-[var(--muted-foreground)]">
                      {folder.itemIds.length}
                    </span>
                  )}
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 shrink-0 items-center gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 max-md:opacity-100">
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditingFolderId(folder.id);
                        setEditFolderName(folder.name);
                      }}
                      className="rounded-lg p-1 transition-colors hover:bg-[var(--accent)]"
                      title="Rename folder"
                    >
                      <Pencil size="0.6875rem" />
                    </button>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        deletePresetFolder.mutate(folder.id);
                        if (expandedFolderId === folder.id) setExpandedFolderId(null);
                      }}
                      className="rounded-lg p-1 transition-colors hover:bg-[var(--destructive)]/15"
                      title="Delete folder"
                    >
                      <Trash2 size="0.6875rem" className="text-[var(--destructive)]" />
                    </button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="ml-4 flex flex-col gap-0.5 border-l border-[var(--border)]/20 pb-1 pl-1">
                    {folderItems.length === 0 ? (
                      <p className="py-2 text-[0.625rem] italic text-[var(--muted-foreground)]">Drop presets here.</p>
                    ) : (
                      folderItems.map((preset) => renderPresetRow(preset))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex flex-col gap-2 py-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="shimmer h-16 rounded-xl" />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && filteredPresets.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <div className="animate-float flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-purple-400/20 to-violet-500/20">
              <FileText size="1.25rem" className="text-purple-400" />
            </div>
            <p className="text-xs text-[var(--muted-foreground)]">
              {search ? "No matching presets" : "No presets yet"}
            </p>
          </div>
        )}

        {/* Preset list */}
        <div
          data-preset-folder-root
          onDragOver={(event) => {
            if (draggedPresetId) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            handlePresetDrop(null);
          }}
          className={cn(
            "stagger-children flex min-h-8 flex-col gap-1 rounded-xl transition-colors",
            draggedPresetId && "ring-1 ring-purple-400/20",
          )}
        >
          {rootPresets.map((preset) => renderPresetRow(preset))}
        </div>

        {activeChat && !selectionMode && (
          <p className="px-1 text-[0.625rem] text-[var(--muted-foreground)]/60">
            {canAssignToActiveChat
              ? 'Click a preset to edit · hover → "Use" to assign to chat'
              : "Click a preset to edit"}
          </p>
        )}
      </PanelSection>

      <RegexSection
        handleCreateRegex={handleCreateRegex}
        handleImportRegex={handleImportRegex}
        regexImportError={regexImportError}
        regexImportSuccess={regexImportSuccess}
        sortedRegexScripts={sortedRegexScripts}
        draggedRegexId={draggedRegexId}
        regexDragReadyId={regexDragReadyId}
        setDraggedRegexId={setDraggedRegexId}
        setRegexDragReadyId={setRegexDragReadyId}
        handleRegexDrop={handleRegexDrop}
        openRegexDetail={openRegexDetail}
        updateRegex={updateRegex}
        deleteRegex={deleteRegex}
      />

      {/* Choice selection modal */}
      {activeChat && (
        <ChoiceSelectionModal
          open={!!choiceModalPresetId}
          onClose={() => setChoiceModalPresetId(null)}
          presetId={choiceModalPresetId}
          chatId={activeChat.id}
          existingChoices={
            typeof activeChat.metadata === "string"
              ? (JSON.parse(activeChat.metadata).presetChoices ?? {})
              : ((activeChat.metadata as any)?.presetChoices ?? {})
          }
        />
      )}
    </div>
  );
}

function RegexSection({
  handleCreateRegex,
  handleImportRegex,
  regexImportError,
  regexImportSuccess,
  sortedRegexScripts,
  draggedRegexId,
  regexDragReadyId,
  setDraggedRegexId,
  setRegexDragReadyId,
  handleRegexDrop,
  openRegexDetail,
  updateRegex,
  deleteRegex,
}: {
  handleCreateRegex: () => void;
  handleImportRegex: (event: ChangeEvent<HTMLInputElement>) => void;
  regexImportError: string | null;
  regexImportSuccess: string | null;
  sortedRegexScripts: RegexScriptRow[];
  draggedRegexId: string | null;
  regexDragReadyId: string | null;
  setDraggedRegexId: Dispatch<SetStateAction<string | null>>;
  setRegexDragReadyId: Dispatch<SetStateAction<string | null>>;
  handleRegexDrop: (targetId: string) => void;
  openRegexDetail: (id: string) => void;
  updateRegex: ReturnType<typeof useUpdateRegexScript>;
  deleteRegex: ReturnType<typeof useDeleteRegexScript>;
}) {
  return (
    <PanelSection
      title="Regexes"
      icon={<Regex size="0.8125rem" />}
      action={
        <div className="flex items-center gap-1">
          <button
            onClick={handleCreateRegex}
            className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-purple-400/10 hover:text-purple-400"
            title="Create regex"
          >
            <Plus size="0.8125rem" />
          </button>
          <label
            className="inline-flex cursor-pointer items-center justify-center rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-purple-400/10 hover:text-purple-400"
            title="Import regexes from JSON"
          >
            <input type="file" accept="application/json" className="hidden" onChange={handleImportRegex} />
            <Download size="0.8125rem" />
          </label>
        </div>
      }
    >
      <div className="mb-1.5 px-1 text-[0.625rem] text-[var(--muted-foreground)]">
        Find/replace patterns applied to AI output or user input.
      </div>
      {regexImportError && <div className="mb-1 px-1 text-xs text-red-500">{regexImportError}</div>}
      {regexImportSuccess && <div className="mb-1 px-1 text-xs text-green-500">{regexImportSuccess}</div>}
      {sortedRegexScripts.length === 0 ? (
        <p className="px-1 py-2 text-[0.625rem] text-[var(--muted-foreground)]">No regexes yet.</p>
      ) : (
        sortedRegexScripts.map((script) => {
          const placements = (() => {
            try {
              return JSON.parse(script.placement) as string[];
            } catch {
              return [];
            }
          })();
          const enabled = script.enabled === "true";
          return (
            <div
              key={script.id}
              className={cn(
                "flex items-start gap-2.5 rounded-xl p-2 transition-colors hover:bg-[var(--sidebar-accent)]",
                !enabled && "opacity-50",
                draggedRegexId === script.id && "opacity-40",
              )}
              draggable={regexDragReadyId === script.id}
              onDragStart={(event) => {
                setDraggedRegexId(script.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", script.id);
              }}
              onDragOver={(event) => {
                if (draggedRegexId && draggedRegexId !== script.id) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                handleRegexDrop(script.id);
              }}
              onDragEnd={() => {
                setDraggedRegexId(null);
                setRegexDragReadyId(null);
              }}
            >
              <button
                className="mt-0.5 shrink-0 cursor-grab rounded p-0.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] active:cursor-grabbing"
                title="Drag to reorder"
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  setRegexDragReadyId(script.id);
                }}
                onMouseUp={(event) => {
                  event.stopPropagation();
                  setRegexDragReadyId(null);
                }}
              >
                <GripVertical size="0.8125rem" />
              </button>
              <Regex size="0.875rem" className="mt-0.5 shrink-0 text-purple-400" />
              <button className="min-w-0 flex-1 text-left" onClick={() => openRegexDetail(script.id)}>
                <div className="text-xs font-medium">{script.name}</div>
                <div className="mt-0.5 flex items-center gap-1">
                  {placements.map((placement) => (
                    <span
                      key={placement}
                      className="rounded bg-[var(--secondary)] px-1 py-0.5 text-[0.5rem] text-[var(--muted-foreground)]"
                    >
                      {placement === "ai_output" ? "AI" : "User"}
                    </span>
                  ))}
                  <span className="max-w-[6.25rem] truncate font-mono text-[0.5625rem] text-[var(--muted-foreground)]">
                    /{script.findRegex}/{script.flags}
                  </span>
                </div>
              </button>
              <button
                className="mt-0.5 shrink-0 text-[var(--muted-foreground)] transition-colors hover:text-purple-400"
                title={enabled ? "Disable regex" : "Enable regex"}
                onClick={(event) => {
                  event.stopPropagation();
                  updateRegex.mutate({ id: script.id, enabled: !enabled });
                }}
              >
                {enabled ? (
                  <ToggleRight size="0.875rem" className="text-purple-400" />
                ) : (
                  <ToggleLeft size="0.875rem" className="text-[var(--muted-foreground)]" />
                )}
              </button>
              <button
                className="mt-0.5 shrink-0 text-[var(--muted-foreground)] transition-colors hover:text-purple-400"
                title="Edit regex"
                onClick={() => openRegexDetail(script.id)}
              >
                <Pencil size="0.8125rem" />
              </button>
              <button
                className="mt-0.5 shrink-0 text-[var(--muted-foreground)] transition-colors hover:text-[var(--destructive)]"
                title="Delete regex"
                onClick={async () => {
                  if (
                    await showConfirmDialog({
                      title: "Delete Regex",
                      message: `Delete "${script.name}"?`,
                      confirmLabel: "Delete",
                      tone: "destructive",
                    })
                  ) {
                    deleteRegex.mutate(script.id);
                  }
                }}
              >
                <Trash2 size="0.8125rem" />
              </button>
            </div>
          );
        })
      )}
    </PanelSection>
  );
}

function PanelSection({
  title,
  icon,
  action,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mt-1">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setOpen((current) => !current)}
          className="flex items-center gap-1.5 px-1 py-1 text-left text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]"
        >
          <ChevronDown
            size="0.75rem"
            className={cn("text-[var(--muted-foreground)] transition-transform", open && "rotate-180")}
          />
          <span className="text-purple-400">{icon}</span>
          {title}
        </button>
        {action}
      </div>
      {open && <div className="mt-1 flex flex-col gap-1">{children}</div>}
    </div>
  );
}
