import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRightLeft, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Chat, LtmNote, LtmNoteTransferPreviewItem } from "@marinara-engine/shared";
import {
  useApplyLongTermMemoryNoteTransfer,
  usePreviewLongTermMemoryNoteTransfer,
} from "../../hooks/use-long-term-memory";
import { cn } from "../../lib/utils";
import { Modal } from "../ui/Modal";
import {
  actionRowClassName,
  helperTextClassName,
  insetSectionCardClassName,
  modalIntroCardClassName,
  sectionCardClassName,
} from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";
import {
  buildNavigatorGroupLookup,
  buildNavigatorThreads,
  findNavigatorThread,
  LtmNavigatorSelector,
  navigatorSelectionLabel,
  type CharacterLookup,
  type LtmNavigatorSelection,
} from "./ltm-navigator";
import { friendlyNoteType, humanScopeLabel, type LtmGroupLookup } from "./ltm-editor-utils";

type TransferMode = "copy" | "move";

type LongTermMemoryNoteTransferModalProps = {
  open: boolean;
  mode: TransferMode;
  notes: LtmNote[];
  allNotes: LtmNote[];
  chats: Chat[] | undefined;
  activeChatId: string | null;
  chatLookup?: Map<string, Chat>;
  characterLookup: CharacterLookup;
  groupLookup?: LtmGroupLookup;
  onClose: () => void;
};

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Something went wrong.";
}

function extractedChildrenForNoteIds(notes: LtmNote[], noteIds: string[]) {
  const selected = new Set(noteIds);
  const descendants = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const note of notes) {
      const sourceNoteId = note.links.find((link) => link.relation === "extracted_from")?.target;
      if (!sourceNoteId || (!selected.has(sourceNoteId) && !descendants.has(sourceNoteId))) continue;
      if (selected.has(note.id) || descendants.has(note.id)) continue;
      descendants.add(note.id);
      changed = true;
    }
  }

  return [...descendants];
}

function itemTone(item: LtmNoteTransferPreviewItem) {
  if (item.classification === "conflict") return "warn" as const;
  if (item.classification === "ready") return "good" as const;
  return "neutral" as const;
}

function itemStatusLabel(item: LtmNoteTransferPreviewItem) {
  if (item.classification === "conflict") return item.conflicts[0]?.severity === "hard" ? "Hard conflict" : "Soft conflict";
  if (item.classification === "ready") return "Ready";
  return "No change";
}

function conflictReasonLabel(reason: LtmNoteTransferPreviewItem["conflicts"][number]["reason"]) {
  switch (reason) {
    case "exact_text":
      return "Exact text";
    case "same_source_type":
      return "Same source";
    case "lexical_overlap":
      return "Exact words overlap";
    default:
      return reason;
  }
}

export function LongTermMemoryNoteTransferModal({
  open,
  mode,
  notes,
  allNotes,
  chats,
  activeChatId,
  chatLookup,
  characterLookup,
  groupLookup,
  onClose,
}: LongTermMemoryNoteTransferModalProps) {
  const previewTransfer = usePreviewLongTermMemoryNoteTransfer();
  const applyTransfer = useApplyLongTermMemoryNoteTransfer();
  const selectedNoteIds = useMemo(() => notes.map((note) => note.id), [notes]);
  const availableDerivedIds = useMemo(
    () => extractedChildrenForNoteIds(allNotes, selectedNoteIds),
    [allNotes, selectedNoteIds],
  );
  const hasDerivedChildren = availableDerivedIds.length > 0;
  const [navigatorSelection, setNavigatorSelection] = useState<LtmNavigatorSelection>({ groupId: null, chatId: null });
  const [navigatorQuery, setNavigatorQuery] = useState("");
  const [includeDerived, setIncludeDerived] = useState(true);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewTransfer.mutateAsync>> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [includedNoteIds, setIncludedNoteIds] = useState<Set<string>>(new Set());
  const previewVersionRef = useRef(0);

  const navigatorThreads = useMemo(() => buildNavigatorThreads(chats, characterLookup), [characterLookup, chats]);
  const modalGroupLookup = useMemo(
    () => groupLookup ?? buildNavigatorGroupLookup(navigatorThreads),
    [groupLookup, navigatorThreads],
  );
  const selectedNavigatorThread = useMemo(
    () => findNavigatorThread(navigatorThreads, navigatorSelection),
    [navigatorSelection, navigatorThreads],
  );
  const destinationLabel = useMemo(
    () => navigatorSelectionLabel(selectedNavigatorThread, navigatorSelection),
    [navigatorSelection, selectedNavigatorThread],
  );
  const destinationChatId = navigatorSelection.chatId;
  const includedCount = includedNoteIds.size;

  useEffect(() => {
    if (!open) return;
    setNavigatorSelection({ groupId: null, chatId: null });
    setNavigatorQuery("");
    setIncludeDerived(true);
    setPreview(null);
    setPreviewError(null);
    setPreviewing(false);
    setIncludedNoteIds(new Set());
    previewTransfer.reset();
  }, [open, previewTransfer]);

  useEffect(() => {
    if (!open || !destinationChatId || notes.length === 0) return;
    const currentVersion = ++previewVersionRef.current;
    setPreviewing(true);
    setPreviewError(null);

    void previewTransfer
      .mutateAsync({
        noteIds: selectedNoteIds,
        mode,
        destinationChatId,
        ...(hasDerivedChildren ? { includeDerived } : {}),
      })
      .then((result) => {
        if (previewVersionRef.current !== currentVersion) return;
        setPreview(result);
        setIncludedNoteIds(new Set(result.items.filter((item) => item.defaultIncluded).map((item) => item.noteId)));
      })
      .catch((error) => {
        if (previewVersionRef.current !== currentVersion) return;
        setPreview(null);
        setIncludedNoteIds(new Set());
        setPreviewError(errorMessage(error));
      })
      .finally(() => {
        if (previewVersionRef.current === currentVersion) setPreviewing(false);
      });
  }, [destinationChatId, hasDerivedChildren, includeDerived, mode, notes.length, open, previewTransfer, selectedNoteIds]);

  const toggleIncluded = (noteId: string, checked: boolean) => {
    setIncludedNoteIds((current) => {
      const next = new Set(current);
      if (checked) next.add(noteId);
      else next.delete(noteId);
      return next;
    });
  };

  const apply = async () => {
    if (!destinationChatId || !preview || includedCount === 0) return;
    try {
      const result = await applyTransfer.mutateAsync({
        noteIds: [...includedNoteIds],
        mode,
        destinationChatId,
        includeDerived: false,
      });
      const verb = mode === "copy" ? "Copied" : "Moved";
      toast.success(
        result.skippedNoteIds.length > 0
          ? `${verb} ${result.updatedNoteIds.length} memories. Skipped ${result.skippedNoteIds.length}.`
          : `${verb} ${result.updatedNoteIds.length} memories.`,
      );
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const actionLabel = mode === "copy" ? "Copy selected" : "Move selected";
  const ActionIcon = mode === "copy" ? Copy : ArrowRightLeft;

  return (
    <Modal open={open} onClose={onClose} title={mode === "copy" ? "Copy Selected Memories" : "Move Selected Memories"} width="max-w-5xl">
      <div className="space-y-4">
        <div className={modalIntroCardClassName}>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill label={`${notes.length} selected`} tone="warn" />
            {hasDerivedChildren && <StatusPill label={`${availableDerivedIds.length} extracted linked`} />}
            <StatusPill label={mode === "copy" ? "Add destination scope" : "Replace destination scope"} />
          </div>
          <p className={cn(helperTextClassName, "mt-2")}>
            {mode === "copy"
              ? "Copy keeps the current memories in place and adds the destination branch to their scope."
              : "Move rewrites each memory to use the destination branch scope."}
          </p>
        </div>

        <LtmNavigatorSelector
          threads={navigatorThreads}
          selection={navigatorSelection}
          activeChatId={activeChatId}
          scopeLabel={destinationLabel}
          query={navigatorQuery}
          contextLabel="Destination"
          onQueryChange={setNavigatorQuery}
          onSelect={setNavigatorSelection}
        />

        {!destinationChatId && <p className={helperTextClassName}>Choose one specific branch before reviewing the transfer.</p>}

        {hasDerivedChildren && (
          <label className={cn(sectionCardClassName, "flex items-center gap-2.5")}>
            <input
              type="checkbox"
              checked={includeDerived}
              onChange={(event) => setIncludeDerived(event.target.checked)}
              className="h-3.5 w-3.5 shrink-0 rounded border-[var(--border)] accent-[var(--primary)]"
            />
            <div className="min-w-0">
              <div className="text-xs font-medium text-[var(--foreground)]">Include extracted memories</div>
              <div className={helperTextClassName}>
                Linked extracted memories follow the selected source memories into the same transfer review.
              </div>
            </div>
          </label>
        )}

        {destinationChatId && previewing && (
          <div className={cn(sectionCardClassName, "flex items-center justify-center gap-2 py-8 text-xs text-[var(--muted-foreground)]")}>
            <Loader2 size="0.875rem" className="animate-spin" />
            Reviewing destination conflicts...
          </div>
        )}

        {destinationChatId && previewError && !previewing && (
          <div className={cn(sectionCardClassName, "flex items-start gap-2.5 text-xs text-[var(--foreground)]")}>
            <AlertTriangle size="0.875rem" className="mt-0.5 shrink-0 text-[var(--warning)]" />
            <div className="space-y-1">
              <div className="font-medium">Transfer preview failed</div>
              <div className={helperTextClassName}>{previewError}</div>
            </div>
          </div>
        )}

        {destinationChatId && preview && !previewing && (
          <>
            <div className={cn(sectionCardClassName, "space-y-2")}>
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusPill label={`${preview.selection.totalNoteCount} reviewed`} />
                <StatusPill label={`${preview.buckets.ready.length} ready`} tone={preview.buckets.ready.length > 0 ? "good" : "neutral"} />
                <StatusPill label={`${preview.buckets.conflict.length} conflicts`} tone={preview.buckets.conflict.length > 0 ? "warn" : "neutral"} />
                <StatusPill label={`${preview.buckets.noOp.length} unchanged`} />
                <StatusPill label={`${includedCount} included`} tone={includedCount > 0 ? "good" : "neutral"} />
              </div>
              {preview.selection.availableDerivedCount > 0 && (
                <div className={helperTextClassName}>
                  {preview.selection.includedDerivedCount} of {preview.selection.availableDerivedCount} extracted memories are in this review.
                </div>
              )}
            </div>

            <div className="space-y-2">
              {preview.items.map((item) => {
                const currentScopeLabel = humanScopeLabel({ scope: item.scope }, chatLookup, modalGroupLookup);
                const nextScopeLabel = humanScopeLabel({ scope: item.nextScope }, chatLookup, modalGroupLookup);
                const selected = includedNoteIds.has(item.noteId);
                const locked = item.classification === "no_op";

                return (
                  <div key={item.noteId} className={cn(sectionCardClassName, selected && !locked && "ring-[var(--ring)]/35")}>
                    <div className="flex flex-wrap items-start gap-3">
                      <label className={cn("flex min-w-0 flex-1 items-start gap-3", locked && "opacity-70")}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={locked}
                          onChange={(event) => toggleIncluded(item.noteId, event.target.checked)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-[var(--border)] accent-[var(--primary)] disabled:cursor-not-allowed"
                        />
                        <div className="min-w-0 space-y-1">
                          <div className="truncate text-sm font-semibold text-[var(--foreground)]" title={item.title}>
                            {item.title}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusPill label={friendlyNoteType(item.type)} />
                            <StatusPill label={itemStatusLabel(item)} tone={itemTone(item)} />
                            {item.derived && <StatusPill label="Extracted" />}
                          </div>
                        </div>
                      </label>
                      <div className="shrink-0 text-right text-[0.6875rem] text-[var(--muted-foreground)]">
                        <div>{currentScopeLabel}</div>
                        <div>{nextScopeLabel}</div>
                      </div>
                    </div>

                    <div className={cn(insetSectionCardClassName, "mt-3 space-y-2")}>
                      <p className="text-xs leading-relaxed text-[var(--foreground)]">{item.previewText || "No preview text available."}</p>
                      {item.reason && <p className={helperTextClassName}>{item.reason}</p>}
                      {item.conflicts.length > 0 && (
                        <div className="space-y-2">
                          {item.conflicts.map((conflict) => (
                            <div key={`${item.noteId}:${conflict.targetNoteId}:${conflict.reason}`} className="space-y-1 rounded-lg bg-[var(--background)]/65 p-2 ring-1 ring-[var(--border)]/70">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <StatusPill label={conflict.severity === "hard" ? "Hard" : "Soft"} tone={conflict.severity === "hard" ? "warn" : "neutral"} />
                                <StatusPill label={conflictReasonLabel(conflict.reason)} />
                                <StatusPill label={friendlyNoteType(conflict.targetType)} />
                                {typeof conflict.score === "number" && conflict.score < 1 && (
                                  <StatusPill label={`Score ${Math.round(conflict.score * 100)}%`} />
                                )}
                              </div>
                              <div className="text-xs font-medium text-[var(--foreground)]">{conflict.targetTitle}</div>
                              {conflict.targetPreview && <p className={helperTextClassName}>{conflict.targetPreview}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className={actionRowClassName}>
          <ToolButton onClick={onClose} disabled={applyTransfer.isPending}>
            Close
          </ToolButton>
          <div className="ml-auto">
            <ToolButton
              onClick={() => void apply()}
              disabled={!destinationChatId || !preview || previewing || includedCount === 0 || applyTransfer.isPending}
              tone="primary"
            >
              {applyTransfer.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <ActionIcon size="0.875rem" />}
              {actionLabel}
            </ToolButton>
          </div>
        </div>
      </div>
    </Modal>
  );
}
