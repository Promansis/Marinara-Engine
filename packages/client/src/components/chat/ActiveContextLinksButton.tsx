import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import {
  BookOpen,
  BrainCircuit,
  ChevronRight,
  FileText,
  Loader2,
  Plug,
  User,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { CHAT_FLOATING_UI_DISMISS_EVENT, announceChatFloatingUiDismiss } from "../../lib/chat-floating-ui-events";
import { useUIStore } from "../../stores/ui.store";
import { useActiveLorebookEntries, useLorebooks } from "../../hooks/use-lorebooks";
import { usePresets } from "../../hooks/use-presets";
import { usePendingDraftsCount } from "../../hooks/use-long-term-memory";
import { MemoryOverviewNotice } from "./MemoryOverviewNotice";
import { ChatCommonOverlays } from "./ChatCommonOverlays";
import { CHAT_FLOATING_PANEL_SELECTOR, getChatToolbarButtonClass } from "./ChatToolbarControls";
import {
  ROLEPLAY_POPOVER_SCROLL_AREA,
  ROLEPLAY_POPOVER_SHELL,
  ROLEPLAY_POPOVER_TITLE,
} from "./roleplay-popover-styles";
import { getMobileFloatingPanelFrame, type MobileFloatingPanelFrame } from "./mobile-floating-panel";
import type { CharacterMap } from "./chat-area.types";

type ChatData = ComponentProps<typeof ChatCommonOverlays>["chat"];

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

type Props = {
  chat: ChatData | null | undefined;
  chatMeta: Record<string, any>;
  chatCharIds: string[];
  characterMap: CharacterMap;
  onViewAll?: () => void;
  onOpenVault?: (payload?: { initialTab?: "notes" | "import" | "review" | "suggestions"; sourceNoteId?: string }) => void;
};

export function ActiveContextLinksButton({
  chat,
  chatMeta,
  chatCharIds,
  characterMap,
  onViewAll,
  onOpenVault,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [mobileFrame, setMobileFrame] = useState<MobileFloatingPanelFrame | null>(null);
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  const compact = useUIStore((s) => s.centerCompact);
  const { data: lorebooks } = useLorebooks();
  const { data: presets } = usePresets();
  const { data: activeLorebookScan, isLoading: activeLorebookScanLoading } = useActiveLorebookEntries(
    chat?.id ?? null,
    open && !!chat?.id,
  );
  const { data: pendingDrafts } = usePendingDraftsCount({ chatId: chat?.id, enabled: !!chat?.id });
  const pendingCount = pendingDrafts?.count ?? 0;

  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => {
      const target = event.target as Node;
      const targetElement = target instanceof Element ? target : target.parentElement;
      if (targetElement?.closest(CHAT_FLOATING_PANEL_SELECTOR)) return;
      if (ref.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !isMobile) return;
    const update = () => setMobileFrame(getMobileFloatingPanelFrame(buttonRef.current, 288));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [isMobile, open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleDismiss = () => setOpen(false);
    window.addEventListener(CHAT_FLOATING_UI_DISMISS_EVENT, handleDismiss);
    return () => window.removeEventListener(CHAT_FLOATING_UI_DISMISS_EVENT, handleDismiss);
  }, [open]);

  if (!chat) return null;

  const inactiveCharacterIds = readStringArray(chatMeta.inactiveCharacterIds);
  const characterIds = chatCharIds.filter((id) => !inactiveCharacterIds.includes(id));
  const activeLorebookIds = readStringArray(chatMeta.activeLorebookIds);
  const promptPresetId = typeof chat.promptPresetId === "string" ? chat.promptPresetId : null;
  const triggeredEntries = activeLorebookScan?.entries ?? [];
  const skippedLorebookEntries = activeLorebookScan?.budgetSkippedEntries ?? [];
  const visibleLorebookIds = Array.from(
    new Set([
      ...activeLorebookIds,
      ...triggeredEntries.map((entry) => entry.lorebookId),
      ...skippedLorebookEntries.map((entry) => entry.lorebookId),
    ]),
  );
  const triggeredEntriesByLorebook = new Map<string, typeof triggeredEntries>();
  for (const entry of triggeredEntries) {
    const current = triggeredEntriesByLorebook.get(entry.lorebookId) ?? [];
    current.push(entry);
    triggeredEntriesByLorebook.set(entry.lorebookId, current);
  }
  const skippedEntriesByLorebook = new Map<string, typeof skippedLorebookEntries>();
  for (const entry of skippedLorebookEntries) {
    const current = skippedEntriesByLorebook.get(entry.lorebookId) ?? [];
    current.push(entry);
    skippedEntriesByLorebook.set(entry.lorebookId, current);
  }
  const hasLinks =
    characterIds.length > 0 ||
    visibleLorebookIds.length > 0 ||
    triggeredEntries.length > 0 ||
    skippedLorebookEntries.length > 0 ||
    !!promptPresetId;

  if (!hasLinks && pendingCount === 0) return null;

  const lorebookNameById = new Map((lorebooks ?? []).map((book) => [book.id, book.name]));
  const presetName = promptPresetId ? presets?.find((preset) => preset.id === promptPresetId)?.name : null;

  const openCharacter = (id: string) => {
    useUIStore.getState().openCharacterDetail(id);
    setOpen(false);
  };
  const openLorebook = (id: string) => {
    useUIStore.getState().openLorebookDetail(id);
    setOpen(false);
  };
  const openPreset = (id: string) => {
    useUIStore.getState().openPresetDetail(id);
    setOpen(false);
  };

  const handleOpenVault = (payload?: { initialTab?: "notes" | "import" | "review" | "suggestions"; sourceNoteId?: string }) => {
    announceChatFloatingUiDismiss();
    if (onOpenVault) {
      onOpenVault(payload);
    } else if (onViewAll) {
      onViewAll();
    }
    setOpen(false);
  };

  const itemClassName =
    "marinara-chat-popover__item flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-[var(--marinara-chat-chrome-panel-text)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] hover:text-[var(--marinara-chat-chrome-highlight-text)]";
  const iconClassName = "shrink-0 text-[var(--marinara-chat-chrome-panel-muted)]";
  const entryClassName =
    "flex min-w-0 items-center gap-1.5 rounded-md bg-[var(--marinara-chat-chrome-highlight-bg)] px-2 py-1 text-[0.625rem] text-[var(--marinara-chat-chrome-panel-muted)] ring-1 ring-[var(--marinara-chat-chrome-panel-divider)]";

  const activeContextContent = (
    <>
      <div className={cn(ROLEPLAY_POPOVER_TITLE, "px-2 pb-1")}>
        <BookOpen size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
        Active Context
      </div>
      <div className="space-y-1">
        {characterIds.map((id, index) => (
          <button key={id} type="button" role="menuitem" className={itemClassName} onClick={() => openCharacter(id)}>
            <User size="0.8125rem" className={iconClassName} />
            <span className="min-w-0 flex-1 truncate">{characterMap.get(id)?.name ?? `Character ${index + 1}`}</span>
            <span className="shrink-0 text-[0.625rem] text-foreground/45">Card</span>
          </button>
        ))}
        {visibleLorebookIds.map((id, index) => {
          const entries = triggeredEntriesByLorebook.get(id) ?? [];
          const skippedEntries = skippedEntriesByLorebook.get(id) ?? [];
          return (
            <div key={id} className="space-y-1">
              <button type="button" role="menuitem" className={itemClassName} onClick={() => openLorebook(id)}>
                <BookOpen size="0.8125rem" className={iconClassName} />
                <span className="min-w-0 flex-1 truncate">{lorebookNameById.get(id) ?? `Lorebook ${index + 1}`}</span>
                <span className="shrink-0 text-[0.625rem] text-foreground/45">
                  {entries.length > 0 ? `${entries.length} hit${entries.length === 1 ? "" : "s"}` : "Lorebook"}
                </span>
              </button>
              {entries.length > 0 && (
                <div className="ml-6 space-y-1 border-l border-foreground/10 pl-2">
                  {entries.map((entry) => (
                    <div key={entry.id} className={entryClassName} title={entry.content || entry.name}>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {entry.constant && (
                        <span className="shrink-0 rounded bg-amber-400/15 px-1 py-0.5 text-[0.5rem] font-semibold text-amber-300">
                          CONST
                        </span>
                      )}
                      <span className="shrink-0 text-foreground/40">#{entry.order}</span>
                    </div>
                  ))}
                </div>
              )}
              {skippedEntries.length > 0 && (
                <div className="ml-6 rounded-md bg-amber-500/10 px-2 py-1 text-[0.625rem] leading-relaxed text-amber-100/80 ring-1 ring-amber-500/20">
                  {skippedEntries.length} matching {skippedEntries.length === 1 ? "entry was" : "entries were"} skipped
                  by token budget.
                </div>
              )}
            </div>
          );
        })}
        {activeLorebookScanLoading && visibleLorebookIds.length > 0 && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-[0.625rem] text-foreground/50">
            <Loader2 size="0.6875rem" className="animate-spin" />
            Scanning active lorebook entries...
          </div>
        )}
        {promptPresetId && (
          <button type="button" role="menuitem" className={itemClassName} onClick={() => openPreset(promptPresetId)}>
            <FileText size="0.8125rem" className={iconClassName} />
            <span className="min-w-0 flex-1 truncate">{presetName ?? "Prompt preset"}</span>
            <span className="shrink-0 text-[0.625rem] text-foreground/45">Preset</span>
          </button>
        )}
        {pendingCount > 0 && (
          <div className="mb-2 rounded-lg p-2 text-xs ring-1 ring-[var(--border)]">
            <button
              type="button"
              onClick={() => handleOpenVault({ initialTab: "review" })}
              className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-xs ring-1 ring-[var(--border)] hover:bg-[var(--accent)]"
            >
              <BrainCircuit size="0.75rem" className="text-[var(--primary)]" />
              <span className="min-w-0 flex-1 text-left font-medium text-[var(--foreground)]">
                {pendingCount} suggestion{pendingCount === 1 ? "" : "s"} to review
              </span>
              <ChevronRight size="0.75rem" />
            </button>
          </div>
        )}
        <MemoryOverviewNotice chatId={chat.id} onViewAll={onViewAll} />
        <div className="px-1">
          <button
            type="button"
            onClick={() => handleOpenVault({ initialTab: "import" })}
            className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <Plug size="0.75rem" />
            Import →
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="relative" ref={ref} onClick={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((prev) => !prev)}
        className={getChatToolbarButtonClass({ compact, open }) +
          (pendingCount > 0 && !open ? " animate-pulse-ring" : "")}
        title="Active Context"
        aria-label="Active Context"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <BookOpen size="0.875rem" />
      </button>
      {open &&
        (isMobile ? (
          createPortal(
            <div
              ref={panelRef}
              data-chat-floating-panel
              role="menu"
              className={cn(ROLEPLAY_POPOVER_SHELL, ROLEPLAY_POPOVER_SCROLL_AREA, "fixed z-[9999] overflow-y-auto p-2")}
              style={
                mobileFrame
                  ? {
                      top: mobileFrame.top,
                      left: mobileFrame.left,
                      width: mobileFrame.width,
                      maxHeight: mobileFrame.maxHeight,
                    }
                  : undefined
              }
              onMouseDown={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
            >
              {activeContextContent}
            </div>,
            document.body,
          )
        ) : (
          <div
            ref={panelRef}
            data-chat-floating-panel
            role="menu"
            className={cn(
              ROLEPLAY_POPOVER_SHELL,
              ROLEPLAY_POPOVER_SCROLL_AREA,
              "absolute right-0 top-full z-50 mt-2 max-h-[min(32rem,calc(100vh-6rem))] w-72 overflow-y-auto p-2",
            )}
            onMouseDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            {activeContextContent}
          </div>
        ))}
    </div>
  );
}
