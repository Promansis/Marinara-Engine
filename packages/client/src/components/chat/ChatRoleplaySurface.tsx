import { createPortal } from "react-dom";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import {
  type ChatSummaryEntry,
  type MarkerConfig,
  type PromptGroup,
  type PromptSection,
  type SceneForkMode,
  type SpritePlacement,
  type SpriteSide,
} from "@marinara-engine/shared";
import {
  Image,
  Loader2,
  PenLine,
  ScrollText,
  Settings2,
  ChevronUp,
  ArrowRightLeft,

} from "lucide-react";
import { cn } from "../../lib/utils";
import { CHAT_FLOATING_UI_DISMISS_EVENT } from "../../lib/chat-floating-ui-events";
import { getConnectedChatDisplayName } from "../../lib/chat-display";
import { playConfiguredNotificationPing } from "../../lib/notification-sound";
import { messageHasPendingPostProcessing } from "../../lib/chat-message-extra";
import { getTranscriptRenderWindow, TRANSCRIPT_RENDER_WINDOW_STEP } from "../../lib/transcript-render-window";
import { useUIStore } from "../../stores/ui.store";
import { useChatStore } from "../../stores/chat.store";
import { useGameStateStore } from "../../stores/game-state.store";
import { usePresetFull } from "../../hooks/use-presets";
import { ChatMessage } from "./ChatMessage";
import { ChatInput } from "./ChatInput";
import { CyoaChoices } from "./CyoaChoices";
import { ChatBranchSelector } from "./ChatBranchSelector";
import {
  CHAT_TOOLBAR_ICON_GAP_CLASS,
  CHAT_TOOLBAR_OVERFLOW_MENU_SELECTOR,
  ChatToolbarButton,
  ChatToolbarMenu,
  getChatToolbarButtonClass,
  readChatToolbarFloatingPanelAnchor,
  type ChatToolbarFloatingPanelAnchor,
} from "./ChatToolbarControls";
import { TranscriptWindowControls } from "./TranscriptWindowControls";
import { EndSceneBar } from "./SceneBanner";
import { ChatCommonOverlays } from "./ChatCommonOverlays";
import { PinnedImageOverlay } from "./PinnedImageOverlay";
import { ActiveContextLinksButton } from "./ActiveContextLinksButton";
import { getMobileFloatingPanelFrame, type MobileFloatingPanelFrame } from "./mobile-floating-panel";
import {
  ROLEPLAY_POPOVER_CLOSE_BUTTON,
  ROLEPLAY_POPOVER_CLOSE_ICON_SIZE,
  ROLEPLAY_POPOVER_SCROLL_AREA,
  ROLEPLAY_POPOVER_SHELL,
} from "./roleplay-popover-styles";
import type { SpriteDisplayMode } from "./sprite-display-modes";
import type {
  CharacterMap,
  ExpressionAvatarResolver,
  MessageSelectionToggle,
  MessageWithSwipes,
  PeekPromptData,
  PersonaInfo,
} from "./chat-area.types";

type ChatData = ComponentProps<typeof ChatCommonOverlays>["chat"];
type LorebookEntryStatus = "normal" | "constant" | "selective";

const RoleplayHUD = lazy(async () => {
  const module = await import("./RoleplayHUD");
  return { default: module.RoleplayHUD };
});

const WeatherEffects = lazy(async () => {
  const module = await import("./WeatherEffects");
  return { default: module.WeatherEffects };
});

const SpriteOverlay = lazy(async () => {
  const module = await import("./SpriteOverlay");
  return { default: module.SpriteOverlay };
});

const EchoChamberPanel = lazy(async () => {
  const module = await import("./EchoChamberPanel");
  return { default: module.EchoChamberPanel };
});

const EncounterModal = lazy(async () => {
  const module = await import("./EncounterModal");
  return { default: module.EncounterModal };
});

const SummaryPopover = lazy(async () => {
  const module = await import("./SummaryPopover");
  return { default: module.SummaryPopover };
});

const AuthorNotesPanel = lazy(async () => {
  const module = await import("./ChatRoleplayPanels");
  return { default: module.AuthorNotesPanel };
});

const TRACKER_FOREGROUND_AVOIDANCE_CLASS =
  "md:pl-[var(--tracker-chat-avoid-left)] md:pr-[var(--tracker-chat-avoid-right)] md:transition-[padding] md:duration-200 md:ease-[cubic-bezier(0.16,1,0.3,1)]";
const roleplayNotificationSeenKeys = new Set<string>();
const MOBILE_FLOATING_PANEL_PADDING = 8;

function useIsMobileToolbarViewport() {
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 767px)").matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobileViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isMobileViewport;
}

function WeatherEffectsConnected() {
  const gs = useGameStateStore((s) => s.current);
  return (
    <Suspense fallback={null}>
      <WeatherEffects weather={gs?.weather ?? null} timeOfDay={gs?.time ?? null} />
    </Suspense>
  );
}

function getBackgroundBlurStyle(blurPx: number): Pick<CSSProperties, "filter" | "transform"> {
  if (blurPx <= 0) return {};
  return {
    filter: `blur(${blurPx}px)`,
    transform: `scale(${Math.min(1.08, 1 + blurPx * 0.0025)})`,
  };
}

function CrossfadeBackground({
  url,
  className,
  blurPx = 0,
}: {
  url: string | null;
  className?: string;
  blurPx?: number;
}) {
  const [bgA, setBgA] = useState<string | null>(url);
  const [bgB, setBgB] = useState<string | null>(null);
  const [aActive, setAActive] = useState(true);
  const activeSlot = useRef<"a" | "b">("a");
  const backgroundBlurStyle = getBackgroundBlurStyle(blurPx);

  useEffect(() => {
    const currentUrl = activeSlot.current === "a" ? bgA : bgB;
    if (url === currentUrl) return;

    if (url && (url.startsWith("/api/backgrounds/") || url.startsWith("/api/game-assets/"))) {
      fetch(url, { method: "HEAD" })
        .then((res) => {
          if (res.ok) {
            applyUrl(url);
          } else {
            console.warn(`[Background] "${url}" not found — clearing`);
            useUIStore.getState().setChatBackground(null);
          }
        })
        .catch(() => {
          applyUrl(url);
        });
      return;
    }

    applyUrl(url);

    function applyUrl(nextUrl: string | null) {
      if (activeSlot.current === "a") {
        setBgB(nextUrl);
        setAActive(false);
        activeSlot.current = "b";
      } else {
        setBgA(nextUrl);
        setAActive(true);
        activeSlot.current = "a";
      }
    }
  }, [bgA, bgB, url]);

  return (
    <>
      <div
        className={cn(
          "mari-background absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-700 ease-in-out",
          className,
        )}
        style={{
          backgroundImage: bgA ? `url(${bgA})` : "none",
          opacity: aActive ? 1 : 0,
          transition: "opacity 700ms ease-in-out, filter 180ms ease-out, transform 180ms ease-out",
          ...backgroundBlurStyle,
        }}
      />
      <div
        className={cn(
          "mari-background absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-700 ease-in-out",
          className,
        )}
        style={{
          backgroundImage: bgB ? `url(${bgB})` : "none",
          opacity: aActive ? 0 : 1,
          transition: "opacity 700ms ease-in-out, filter 180ms ease-out, transform 180ms ease-out",
          ...backgroundBlurStyle,
        }}
      />
    </>
  );
}

function StreamingIndicator({
  activeChatId,
  chatCharIds,
  characterMap,
  personaInfo,
  chatMode,
  groupChatMode,
  expressionAvatarResolver,
}: {
  activeChatId: string;
  chatCharIds: string[];
  characterMap: CharacterMap;
  personaInfo?: PersonaInfo;
  chatMode: string;
  groupChatMode?: string;
  expressionAvatarResolver?: ExpressionAvatarResolver;
}) {
  const streamBuffer = useChatStore((s) => s.streamBuffer);
  const thinkingBuffer = useChatStore((s) => s.thinkingBuffer);
  const streamingCharacterId = useChatStore((s) => s.streamingCharacterId);

  return (
    <div className="animate-message-in">
      <ChatMessage
        message={{
          id: "__streaming__",
          chatId: activeChatId,
          role: "assistant",
          characterId: streamingCharacterId ?? chatCharIds[0] ?? null,
          content: streamBuffer || (thinkingBuffer ? "Thinking..." : ""),
          activeSwipeIndex: 0,
          extra: {
            displayText: null,
            isGenerated: true,
            tokenCount: 0,
            generationInfo: null,
            thinking: thinkingBuffer || null,
          },
          createdAt: new Date().toISOString(),
        }}
        isStreaming
        characterMap={characterMap}
        personaInfo={personaInfo}
        chatMode={chatMode}
        groupChatMode={groupChatMode}
        chatCharacterIds={chatCharIds}
        expressionAvatarResolver={expressionAvatarResolver}
      />
    </div>
  );
}

function RegeneratingMessageContent({
  msg,
  ...rest
}: {
  msg: MessageWithSwipes;
} & Omit<ComponentProps<typeof ChatMessage>, "message" | "isStreaming">) {
  const streamBuffer = useChatStore((s) => s.streamBuffer);
  const thinkingBuffer = useChatStore((s) => s.thinkingBuffer);
  // Strip old-swipe attachments so a previous illustration doesn't linger
  // while the new swipe's text is streaming in.
  const parsedExtra = typeof msg.extra === "string" ? JSON.parse(msg.extra) : (msg.extra ?? {});
  const cleanExtra = { ...parsedExtra, attachments: null, thinking: thinkingBuffer || parsedExtra.thinking };
  return (
    <ChatMessage
      message={{ ...msg, extra: cleanExtra, content: streamBuffer || (thinkingBuffer ? "Thinking..." : "") }}
      isStreaming
      {...rest}
    />
  );
}

/** True for stored context messages that should feed generation but not render in the transcript. */
function isHiddenFromUser(message: MessageWithSwipes) {
  const extra = typeof message.extra === "string" ? JSON.parse(message.extra) : (message.extra ?? {});
  return extra.hiddenFromUser === true;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function promptEnabled(value: unknown): boolean {
  return value !== false && value !== "false";
}

function readMarkerConfig(value: unknown): MarkerConfig | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as MarkerConfig;
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? (value as MarkerConfig) : null;
}

function groupPathEnabled(groupId: string | null, groupsById: Map<string, PromptGroup>): boolean {
  let currentId = groupId;
  const seen = new Set<string>();
  while (currentId) {
    if (seen.has(currentId)) return true;
    seen.add(currentId);
    const group = groupsById.get(currentId);
    if (!group) return true;
    if (!promptEnabled(group.enabled)) return false;
    currentId = group.parentGroupId;
  }
  return true;
}

function resolveChatSummaryInjectionHint(
  presetFull: { sections: PromptSection[]; groups: PromptGroup[] } | null | undefined,
): string | null {
  if (!presetFull) return null;

  const groupsById = new Map(presetFull.groups.map((group) => [group.id, group]));
  const summarySections = presetFull.sections.filter((section) => {
    const isMarker = (section.isMarker as unknown) === true || (section.isMarker as unknown) === "true";
    return isMarker && readMarkerConfig(section.markerConfig)?.type === "chat_summary";
  });

  if (summarySections.length === 0) {
    return "Active preset has no Chat Summary marker, so enabled summaries will not be inserted.";
  }
  if (!summarySections.some((section) => promptEnabled(section.enabled))) {
    return "Chat Summary section is disabled in the active preset.";
  }
  if (!summarySections.some((section) => promptEnabled(section.enabled) && groupPathEnabled(section.groupId, groupsById))) {
    return "Chat Summary section is inside a disabled preset group.";
  }
  return null;
}

function SummaryButton({
  chatId,
  summary,
  summaryEntries,
  summaryContextSize,
  summaryPromptTemplates,
  activeSummaryPromptTemplateId,
  summaryConnectionId,
  automaticSummaryEnabled,
  activeAgentIds,
  summaryRunInterval,
  hideSummarisedMessages,
  summaryTailMessages,
  automaticSummariesAvailable,
  totalMessageCount,
  promptPresetId,
}: {
  chatId: string | null;
  summary: string | null;
  summaryEntries?: ChatSummaryEntry[];
  summaryContextSize: number;
  summaryPromptTemplates?: ComponentProps<typeof SummaryPopover>["promptTemplates"];
  activeSummaryPromptTemplateId?: string | null;
  summaryConnectionId?: string | null;
  automaticSummaryEnabled: boolean;
  activeAgentIds: string[];
  summaryRunInterval?: number;
  hideSummarisedMessages?: boolean;
  summaryTailMessages?: number;
  automaticSummariesAvailable: boolean;
  totalMessageCount: number;
  promptPresetId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<ComponentProps<typeof SummaryPopover>["anchor"]>(null);
  const compact = useUIStore((s) => s.centerCompact);
  const { data: presetFull } = usePresetFull(promptPresetId ?? null);
  const summaryInjectionHint = useMemo(() => resolveChatSummaryInjectionHint(presetFull), [presetFull]);
  const readSummaryAnchor = useCallback((): ComponentProps<typeof SummaryPopover>["anchor"] => {
    const button = buttonRef.current;
    if (!button || typeof window === "undefined") return null;
    const rect = button.getBoundingClientRect();
    const overflowMenu = button.closest<HTMLElement>(CHAT_TOOLBAR_OVERFLOW_MENU_SELECTOR);
    if (window.innerWidth < 768 && overflowMenu) {
      const menuRect = overflowMenu.getBoundingClientRect();
      return {
        top: menuRect.top,
        right: Math.max(MOBILE_FLOATING_PANEL_PADDING, menuRect.left - MOBILE_FLOATING_PANEL_PADDING),
        bottom: menuRect.top,
        left: menuRect.left,
        width: menuRect.width,
        overflowMenu: true,
      };
    }
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
    };
  }, []);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const update = () => {
      setAnchor(readSummaryAnchor());
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, readSummaryAnchor]);

  useEffect(() => {
    if (!open) return;
    const handleDismiss = () => setOpen(false);
    window.addEventListener(CHAT_FLOATING_UI_DISMISS_EVENT, handleDismiss);
    return () => window.removeEventListener(CHAT_FLOATING_UI_DISMISS_EVENT, handleDismiss);
  }, [open]);

  if (!chatId) return null;

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        onClick={() => {
          setAnchor(readSummaryAnchor());
          setOpen(!open);
        }}
        className={getChatToolbarButtonClass({ active: !!summary, compact, open })}
        title="Chat Summary"
      >
        <ScrollText size="0.875rem" />
      </button>
      {open && (
        <Suspense fallback={null}>
          <SummaryPopover
            chatId={chatId}
            summary={summary}
            summaryEntries={summaryEntries}
            contextSize={summaryContextSize}
            promptTemplates={summaryPromptTemplates}
            activePromptTemplateId={activeSummaryPromptTemplateId}
            summaryConnectionId={summaryConnectionId}
            automaticSummaryEnabled={automaticSummaryEnabled}
            activeAgentIds={activeAgentIds}
            summaryRunInterval={summaryRunInterval}
            hideSummarisedMessages={hideSummarisedMessages}
            summaryTailMessages={summaryTailMessages}
            automaticSummariesAvailable={automaticSummariesAvailable}
            totalMessageCount={totalMessageCount}
            summaryInjectionHint={summaryInjectionHint}
            anchor={anchor}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

function AuthorNotesButton({
  chatId,
  chatMeta,
  open,
  onOpenChange,
  renderPanel,
  mobilePanel,
}: {
  chatId: string | null;
  chatMeta: Record<string, any>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  renderPanel: boolean;
  mobilePanel: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [mobileFrame, setMobileFrame] = useState<MobileFloatingPanelFrame | null>(null);
  const [desktopAnchor, setDesktopAnchor] = useState<ChatToolbarFloatingPanelAnchor>(null);
  const compact = useUIStore((s) => s.centerCompact);
  const isMobileViewport = useIsMobileToolbarViewport();
  const useMobilePanel = mobilePanel && isMobileViewport;

  useEffect(() => {
    if (!open || !renderPanel) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || panelRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onOpenChange, open, renderPanel]);

  useLayoutEffect(() => {
    if (!open || !renderPanel || !useMobilePanel) {
      setMobileFrame(null);
      return;
    }
    const update = () => setMobileFrame(getMobileFloatingPanelFrame(buttonRef.current, 288));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, renderPanel, useMobilePanel]);

  useLayoutEffect(() => {
    if (!open || !renderPanel || useMobilePanel) {
      setDesktopAnchor(null);
      return;
    }
    const update = () => setDesktopAnchor(readChatToolbarFloatingPanelAnchor(buttonRef.current));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, renderPanel, useMobilePanel]);

  useEffect(() => {
    if (!open || !renderPanel) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onOpenChange, open, renderPanel]);

  useEffect(() => {
    if (!open || !renderPanel) return;
    const handleDismiss = () => onOpenChange(false);
    window.addEventListener(CHAT_FLOATING_UI_DISMISS_EVENT, handleDismiss);
    return () => window.removeEventListener(CHAT_FLOATING_UI_DISMISS_EVENT, handleDismiss);
  }, [onOpenChange, open, renderPanel]);

  if (!chatId) return null;

  const hasNotes = !!String(chatMeta.authorNotes ?? "").trim();

  return (
    <div className="relative" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        onClick={() => {
          const nextOpen = !open;
          setMobileFrame(nextOpen && useMobilePanel ? getMobileFloatingPanelFrame(buttonRef.current, 288) : null);
          setDesktopAnchor(nextOpen && !useMobilePanel ? readChatToolbarFloatingPanelAnchor(buttonRef.current) : null);
          onOpenChange(nextOpen);
        }}
        className={getChatToolbarButtonClass({ active: hasNotes, compact, open })}
        title="Author's Notes"
      >
        <PenLine size="0.875rem" />
      </button>
      {open &&
        renderPanel &&
        (useMobilePanel ? (
          mobileFrame &&
          createPortal(
            <div
              ref={panelRef}
              className={cn(ROLEPLAY_POPOVER_SHELL, ROLEPLAY_POPOVER_SCROLL_AREA, "fixed z-[9999] overflow-y-auto p-3")}
              style={{
                top: mobileFrame.top,
                left: mobileFrame.left,
                width: mobileFrame.width,
                maxHeight: mobileFrame.maxHeight,
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            >
              <Suspense
                fallback={
                  <div className="flex items-center gap-2 py-4 text-xs text-[var(--muted-foreground)]">
                    <Loader2 size="0.75rem" className="animate-spin" />
                    Loading author's notes...
                  </div>
                }
              >
                  <AuthorNotesPanel
                    chatId={chatId}
                    chatMeta={chatMeta}
                    onClose={() => onOpenChange(false)}
                  />
              </Suspense>
            </div>,
            document.body,
          )
        ) : (
          desktopAnchor &&
          createPortal(
            <div
              ref={panelRef}
              data-chat-floating-panel
              className={cn(ROLEPLAY_POPOVER_SHELL, "fixed z-[70] w-72 p-3")}
              style={{
                right: `${desktopAnchor.right}px`,
                top: `${desktopAnchor.top}px`,
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Suspense
                fallback={
                  <div className="flex items-center gap-2 py-4 text-xs text-[var(--muted-foreground)]">
                    <Loader2 size="0.75rem" className="animate-spin" />
                    Loading author's notes...
                  </div>
                }
              >
                <AuthorNotesPanel
                  chatId={chatId}
                  chatMeta={chatMeta}
                  onClose={() => onOpenChange(false)}
                />
              </Suspense>
            </div>,
            document.body,
          )
        ))}
    </div>
  );
}

/** Props for the full roleplay surface, including scene lifecycle and fork controls. */
type RoleplaySurfaceProps = {
  activeChatId: string;
  chat: ChatData | null | undefined;
  allChats: Array<{ id: string; name: string; metadata?: string | Record<string, unknown> | null }> | undefined;
  chatMeta: Record<string, any>;
  chatMode: string;
  isRoleplay: boolean;
  centerCompact: boolean;
  chatBackground: string | null;
  weatherEffects: boolean;
  expressionAgentEnabled: boolean;
  combatAgentEnabled: boolean;
  encounterActive: boolean;
  spritePosition: SpriteSide;
  spriteCharacterIds: string[];
  spriteDisplayModes: SpriteDisplayMode[];
  spriteExpressions: Record<string, string>;
  expressionAvatarResolver?: ExpressionAvatarResolver;
  spritePlacements: Record<string, SpritePlacement>;
  spriteScale: number;
  expressionSpriteScale: number;
  fullBodySpriteScale: number;
  spriteOpacity: number;
  expressionSpriteOpacity: number;
  fullBodySpriteOpacity: number;
  spriteArrangeMode: boolean;
  enabledAgentTypes: Set<string>;
  chatCharIds: string[];
  characterMap: CharacterMap;
  characterNames: string[];
  personaInfo?: PersonaInfo;
  messages: MessageWithSwipes[] | undefined;
  msgPayload: Array<{ role: string; characterId: string | null; content: string }>;
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isStreaming: boolean;
  regenerateMessageId: string | null;
  shouldAnimateMessages: boolean;
  summaryContextSize: number;
  totalMessageCount: number;
  lastAssistantMessageId: string | null;
  settingsOpen: boolean;
  settingsAnchor: ComponentProps<typeof ChatCommonOverlays>["settingsAnchor"];
  settingsInitialSection?: ComponentProps<typeof ChatCommonOverlays>["settingsInitialSection"];
  filesOpen: boolean;
  galleryOpen: boolean;
  galleryAnchor: ComponentProps<typeof ChatCommonOverlays>["galleryAnchor"];
  wizardOpen: boolean;
  peekPromptData: PeekPromptData | null;
  deleteDialogMessageId: string | null;
  deleteDialogCanDeleteSwipe: boolean;
  deleteDialogActiveSwipeIndex: number;
  deleteDialogSwipeCount: number;
  multiSelectMode: boolean;
  selectedMessageIds: Set<string>;
  groupChatMode?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onLoadMore: () => void;
  onDelete: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onEdit: (messageId: string, content: string) => void;
  onSetActiveSwipe: (messageId: string, index: number) => void;
  onToggleConversationStart: (messageId: string, current: boolean) => void;
  onToggleHiddenFromAI: (messageId: string, current: boolean) => void;
  onPeekPrompt: () => void;
  onBranch?: (messageId: string) => void;
  onCloneSceneFromHere?: (messageId: string) => void;
  isCloneSceneFromHereDisabled?: boolean;
  onToggleSelectMessage: (toggle: MessageSelectionToggle) => void;
  onRerunTrackers: () => void;
  onRerunSingleTracker: (agentType: string) => void;
  onRetryFailedAgents?: () => void;
  onStartEncounter: () => void;
  onConcludeScene: () => void;
  onAbandonScene: () => void;
  onForkScene: (sceneChatId: string, mode: SceneForkMode) => void;
  isForkingScene?: boolean;
  onOpenSettings: (event?: ReactMouseEvent<HTMLElement>) => void;
  onOpenGallery: (event?: ReactMouseEvent<HTMLElement>) => void;
  onOpenVault?: (payload?: { initialTab?: "notes" | "import" | "review" | "suggestions"; sourceNoteId?: string }) => void;
  onCloseSettings: () => void;
  onCloseFiles: () => void;
  onCloseGallery: () => void;
  onIllustrate?: () => void;
  onWizardFinish: () => void;
  onClosePeekPrompt: () => void;
  onResetSpritePlacements: () => void;
  onSpriteSideChange: (side: SpriteSide) => void;
  onToggleSpriteArrange: () => void;
  spriteVisualSettings?: ComponentProps<typeof ChatCommonOverlays>["sceneSettings"]["spriteVisualSettings"];
  onSpriteVisualSettingsChange?: ComponentProps<
    typeof ChatCommonOverlays
  >["sceneSettings"]["onSpriteVisualSettingsChange"];
  onExpressionChange: (characterId: string, expression: string, options?: { immediate?: boolean }) => void;
  onSpritePlacementChange: (placementKey: string, placement: SpritePlacement) => void;
  onFinishSpritePlacement: () => void;
  onDeleteConfirm: () => void;
  onDeleteSwipe: () => void;
  onDeleteMore: () => void;
  onCloseDeleteDialog: () => void;
  onBulkDelete: () => void;
  onCancelMultiSelect: () => void;
  onUnselectAllMessages: () => void;
  onSelectAllAboveSelection: () => void;
  onSelectAllBelowSelection: () => void;
  isGrouped: (index: number) => boolean;
};

export function ChatRoleplaySurface({
  activeChatId,
  chat,
  allChats,
  chatMeta,
  chatMode,
  isRoleplay,
  centerCompact,
  chatBackground,
  weatherEffects,
  expressionAgentEnabled,
  combatAgentEnabled,
  encounterActive,
  spritePosition,
  spriteCharacterIds,
  spriteDisplayModes,
  spriteExpressions,
  expressionAvatarResolver,
  spritePlacements,
  spriteScale,
  expressionSpriteScale,
  fullBodySpriteScale,
  spriteOpacity,
  expressionSpriteOpacity,
  fullBodySpriteOpacity,
  spriteArrangeMode,
  enabledAgentTypes,
  chatCharIds,
  characterMap,
  characterNames,
  personaInfo,
  messages,
  msgPayload,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  isStreaming,
  regenerateMessageId,
  shouldAnimateMessages,
  summaryContextSize,
  totalMessageCount,
  lastAssistantMessageId,
  settingsOpen,
  settingsAnchor,
  settingsInitialSection,
  filesOpen,
  galleryOpen,
  galleryAnchor,
  wizardOpen,
  peekPromptData,
  deleteDialogMessageId,
  deleteDialogCanDeleteSwipe,
  deleteDialogActiveSwipeIndex,
  deleteDialogSwipeCount,
  multiSelectMode,
  selectedMessageIds,
  groupChatMode,
  scrollRef,
  messagesEndRef,
  onLoadMore,
  onDelete,
  onRegenerate,
  onEdit,
  onSetActiveSwipe,
  onToggleConversationStart,
  onToggleHiddenFromAI,
  onPeekPrompt,
  onBranch,
  onCloneSceneFromHere,
  isCloneSceneFromHereDisabled,
  onToggleSelectMessage,
  onRerunTrackers,
  onRerunSingleTracker,
  onRetryFailedAgents,
  onStartEncounter,
  onConcludeScene,
  onAbandonScene,
  onForkScene,
  isForkingScene,
  onOpenSettings,
  onOpenGallery,
  onOpenVault,
  onCloseSettings,
  onCloseFiles,
  onCloseGallery,
  onIllustrate,
  onWizardFinish,
  onClosePeekPrompt,
  onResetSpritePlacements,
  onSpriteSideChange,
  onToggleSpriteArrange,
  spriteVisualSettings,
  onSpriteVisualSettingsChange,
  onExpressionChange,
  onSpritePlacementChange,
  onFinishSpritePlacement,
  onDeleteConfirm,
  onDeleteSwipe,
  onDeleteMore,
  onCloseDeleteDialog,
  onBulkDelete,
  onCancelMultiSelect,
  onUnselectAllMessages,
  onSelectAllAboveSelection,
  onSelectAllBelowSelection,
  isGrouped,
}: RoleplaySurfaceProps) {
  const isStreamCommitted = useChatStore((s) => s.committedStreamChatIds.has(activeChatId));
  const hasDraftInput = useChatStore((s) => s.currentInput.trim().length > 0);
  const hasLiveStream = isStreaming && !isStreamCommitted;
  const linkedChatName = chat?.connectedChatId
    ? getConnectedChatDisplayName(allChats?.find((c) => c.id === chat.connectedChatId))
    : undefined;
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const chatBackgroundBlur = useUIStore((s) => s.chatBackgroundBlur);
  const initialLoadSettledRef = useRef(false);
  const prevMessageKeysRef = useRef<Set<string>>(new Set());
  const seenMessageKeysRef = useRef(roleplayNotificationSeenKeys);
  const pendingPostProcessingKeysRef = useRef<Set<string>>(new Set());
  const topChromeRef = useRef<HTMLDivElement>(null);
  const inputChromeRef = useRef<HTMLDivElement>(null);
  const [chromeHeights, setChromeHeights] = useState({ top: 0, bottom: 0 });
  const [authorNotesOpenOwner, setAuthorNotesOpenOwner] = useState<"expanded" | "compact" | null>(null);
  const isMobileToolbarViewport = useIsMobileToolbarViewport();
  const compactToolbarOwnsAuthorNotes = centerCompact || isMobileToolbarViewport;
  const expandedAuthorNotesOpen = authorNotesOpenOwner === "expanded";
  const compactAuthorNotesOpen = authorNotesOpenOwner === "compact";
  const setExpandedAuthorNotesOpen = useCallback(
    (open: boolean) => {
      setAuthorNotesOpenOwner(open ? "expanded" : null);
    },
    [],
  );
  const setCompactAuthorNotesOpen = useCallback(
    (open: boolean) => {
      setAuthorNotesOpenOwner(open ? "compact" : null);
    },
    [],
  );
  const hideEchoChamberOnMobile =
    sidebarOpen || rightPanelOpen || settingsOpen || filesOpen || galleryOpen || wizardOpen;
  const showSpriteOverlay = expressionAgentEnabled && spriteCharacterIds.length > 0 && spriteDisplayModes.length > 0;

  useLayoutEffect(() => {
    const measure = () => {
      const top = Math.ceil(topChromeRef.current?.getBoundingClientRect().height ?? 0);
      const bottom = Math.ceil(inputChromeRef.current?.getBoundingClientRect().height ?? 0);
      setChromeHeights((current) => (current.top === top && current.bottom === bottom ? current : { top, bottom }));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (topChromeRef.current) observer.observe(topChromeRef.current);
    if (inputChromeRef.current) observer.observe(inputChromeRef.current);
    return () => observer.disconnect();
  }, [activeChatId, centerCompact, chatMeta.enableAgents, chatMeta.sceneStatus, combatAgentEnabled]);

  useEffect(() => {
    initialLoadSettledRef.current = false;
    prevMessageKeysRef.current = new Set();
    pendingPostProcessingKeysRef.current = new Set();
    setAuthorNotesOpenOwner(null);
  }, [activeChatId]);

  const [transcriptWindowStart, setTranscriptWindowStart] = useState<number | null>(null);
  const pendingLoadMoreRevealRef = useRef<{
    previousLength: number;
    previousStartIndex: number;
    previousEndIndex: number;
  } | null>(null);

  useEffect(() => {
    setTranscriptWindowStart(null);
    pendingLoadMoreRevealRef.current = null;
  }, [activeChatId]);

  const messagesLength = messages?.length ?? 0;
  const transcriptWindow = useMemo(
    () => getTranscriptRenderWindow(messages, { startIndex: transcriptWindowStart }),
    [messages, transcriptWindowStart],
  );

  const showOlderTranscriptMessages = () => {
    setTranscriptWindowStart((current) => {
      const start = current ?? transcriptWindow.startIndex;
      return Math.max(0, start - TRANSCRIPT_RENDER_WINDOW_STEP);
    });
  };

  const showNewerTranscriptMessages = () => {
    setTranscriptWindowStart((current) => {
      const start = current ?? transcriptWindow.startIndex;
      return Math.min(transcriptWindow.latestStartIndex, start + TRANSCRIPT_RENDER_WINDOW_STEP);
    });
  };

  const jumpToLatestTranscriptMessages = () => {
    setTranscriptWindowStart(null);
  };

  const handleLoadMoreClick = () => {
    if (transcriptWindow.hiddenBeforeCount > 0) {
      showOlderTranscriptMessages();
      return;
    }
    pendingLoadMoreRevealRef.current = {
      previousLength: messagesLength,
      previousStartIndex: transcriptWindow.startIndex,
      previousEndIndex: transcriptWindow.endIndex,
    };
    onLoadMore();
  };

  useLayoutEffect(() => {
    const pending = pendingLoadMoreRevealRef.current;
    if (!pending || isFetchingNextPage) return;
    if (messagesLength <= pending.previousLength) {
      pendingLoadMoreRevealRef.current = null;
      return;
    }

    const addedCount = messagesLength - pending.previousLength;
    const previousVisibleCount = Math.max(1, pending.previousEndIndex - pending.previousStartIndex);
    const previousVisibleStart = pending.previousStartIndex + addedCount;
    setTranscriptWindowStart(Math.max(0, previousVisibleStart - previousVisibleCount));
    pendingLoadMoreRevealRef.current = null;
  }, [isFetchingNextPage, messagesLength]);

  useEffect(() => {
    if (!messages) return;
    const currentKeys = new Set(messages.map((message) => `${activeChatId}:${message.id}`));
    const pendingPostProcessingKeys = new Set(
      messages
        .filter((message) => messageHasPendingPostProcessing(message))
        .map((message) => `${activeChatId}:${message.id}`),
    );

    if (!initialLoadSettledRef.current) {
      if (currentKeys.size > 0) {
        prevMessageKeysRef.current = currentKeys;
        for (const message of messages) {
          const key = `${activeChatId}:${message.id}`;
          if (!pendingPostProcessingKeys.has(key)) seenMessageKeysRef.current.add(key);
        }
        pendingPostProcessingKeysRef.current = pendingPostProcessingKeys;
        initialLoadSettledRef.current = true;
      }
      return;
    }

    const prevKeys = prevMessageKeysRef.current;
    const seenKeys = seenMessageKeysRef.current;
    const now = Date.now();
    const FRESHNESS_MS = 15_000;
    let hasNewAssistantMessage = false;

    for (const message of messages) {
      const key = `${activeChatId}:${message.id}`;
      const isPendingPostProcessing = pendingPostProcessingKeys.has(key);
      if (isPendingPostProcessing) continue;
      const wasPendingPostProcessing = pendingPostProcessingKeysRef.current.has(key);
      if ((prevKeys.has(key) || seenKeys.has(key)) && !wasPendingPostProcessing) continue;

      const createdAt = new Date(message.createdAt).getTime();
      const isFresh = wasPendingPostProcessing || (Number.isFinite(createdAt) && now - createdAt < FRESHNESS_MS);
      if (isFresh && message.role === "assistant") {
        hasNewAssistantMessage = true;
      }
    }

    for (const message of messages) {
      const key = `${activeChatId}:${message.id}`;
      if (!pendingPostProcessingKeys.has(key)) seenKeys.add(key);
    }
    prevMessageKeysRef.current = currentKeys;
    pendingPostProcessingKeysRef.current = pendingPostProcessingKeys;

    if (hasNewAssistantMessage) {
      const uiState = useUIStore.getState();
      playConfiguredNotificationPing(uiState.rpNotificationSound, uiState.notificationSoundsOnlyWhenUnfocused);
    }
  }, [activeChatId, messages]);

  const visibleMessages = transcriptWindow.messages;
  const loadedMessageOffset = totalMessageCount - (messages?.length ?? 0);
  const summaryActiveAgentIds = Array.isArray(chatMeta.activeAgentIds)
    ? chatMeta.activeAgentIds.filter((agentId): agentId is string => typeof agentId === "string")
    : [];
  const automaticSummaryEnabled =
    chatMeta.automaticSummaryEnabled === true ||
    (chatMeta.enableAgents === true && summaryActiveAgentIds.includes("chat-summary"));
  const summaryRunInterval =
    typeof chatMeta.summaryRunInterval === "number" && Number.isFinite(chatMeta.summaryRunInterval)
      ? chatMeta.summaryRunInterval
      : undefined;
  const hideSummarisedMessages =
    typeof chatMeta.hideSummarisedMessages === "boolean" ? chatMeta.hideSummarisedMessages : undefined;
  const summaryTailMessages =
    typeof chatMeta.summaryTailMessages === "number" && Number.isFinite(chatMeta.summaryTailMessages)
      ? chatMeta.summaryTailMessages
      : undefined;

  return (
    <div data-component="ChatArea.Roleplay" className="flex flex-1 overflow-hidden">
      <div
        className="rpg-chat-area mari-chat-area mari-card-css relative flex flex-1 flex-col overflow-hidden"
        data-chat-mode="roleplay"
        style={{ isolation: "isolate" }}
      >
        <CrossfadeBackground url={chatBackground} blurPx={chatBackgroundBlur} />
        <div className="rpg-overlay absolute inset-0" />
        <div className="rpg-vignette pointer-events-none absolute inset-0" />
        {weatherEffects && <WeatherEffectsConnected />}
        {showSpriteOverlay && (
          <Suspense fallback={null}>
            <SpriteOverlay
              characterIds={spriteCharacterIds}
              messages={msgPayload}
              side={spritePosition}
              spriteDisplayModes={spriteDisplayModes}
              spriteExpressions={spriteExpressions}
              spritePlacements={spritePlacements}
              editing={spriteArrangeMode}
              spriteScale={spriteScale}
              expressionSpriteScale={expressionSpriteScale}
              fullBodySpriteScale={fullBodySpriteScale}
              spriteOpacity={spriteOpacity}
              expressionSpriteOpacity={expressionSpriteOpacity}
              fullBodySpriteOpacity={fullBodySpriteOpacity}
              onPlacementChange={onSpritePlacementChange}
              onFinishPlacement={onFinishSpritePlacement}
            />
          </Suspense>
        )}

        <div className="relative flex flex-1 overflow-hidden">
          <div className="relative flex flex-1 flex-col overflow-hidden">
            <div ref={topChromeRef} className="pointer-events-none absolute inset-x-0 top-0 z-40">
              <div
                data-tracker-panel-anchor="roleplay-hud"
                className={cn(
                  "pointer-events-none relative z-40 items-center py-2 max-md:hidden",
                  centerCompact ? "hidden" : "flex",
                )}
                style={{
                  paddingLeft: "calc(1rem + var(--tracker-panel-hud-clear-left, 0px))",
                  paddingRight: "calc(1rem + var(--tracker-panel-hud-clear-right, 0px))",
                }}
              >
                {chat && chatMeta.enableAgents && (
                  <div className="pointer-events-auto flex-1 overflow-x-auto">
                    <Suspense fallback={null}>
                      <RoleplayHUD
                        chatId={chat.id}
                        characterCount={chatCharIds.length}
                        layout="top"
                        isStreaming={isStreaming}
                        onRetriggerTrackers={onRerunTrackers}
                        onRetryFailedAgents={onRetryFailedAgents}
                        onRerunSingleTracker={onRerunSingleTracker}
                        enabledAgentTypes={enabledAgentTypes}
                        manualTrackers={!!chatMeta.manualTrackers}
                        injectionSourceMessages={messages}
                      />
                    </Suspense>
                  </div>
                )}
                <div
                  data-roleplay-top-controls="right"
                  className={cn("pointer-events-auto ml-auto flex shrink-0 items-center", CHAT_TOOLBAR_ICON_GAP_CLASS)}
                >
                  <ChatBranchSelector
                    activeChatId={activeChatId}
                    activeChatName={chat?.name}
                    groupId={chat?.groupId ?? null}
                    variant="roleplay"
                  />
                  <ChatToolbarMenu>
                    <SummaryButton
                      chatId={chat?.id ?? null}
                      summary={chatMeta.summary ?? null}
                      summaryEntries={
                        Array.isArray(chatMeta.summaryEntries) ? (chatMeta.summaryEntries as ChatSummaryEntry[]) : []
                      }
                      summaryContextSize={summaryContextSize}
                      summaryPromptTemplates={
                        Array.isArray(chatMeta.summaryPromptTemplates) ? chatMeta.summaryPromptTemplates : []
                      }
                      activeSummaryPromptTemplateId={
                        typeof chatMeta.activeSummaryPromptTemplateId === "string"
                          ? chatMeta.activeSummaryPromptTemplateId
                          : null
                      }
                      summaryConnectionId={
                        typeof chatMeta.summaryConnectionId === "string" ? chatMeta.summaryConnectionId : null
                      }
                      automaticSummaryEnabled={automaticSummaryEnabled}
                      activeAgentIds={summaryActiveAgentIds}
                      summaryRunInterval={summaryRunInterval}
                      hideSummarisedMessages={hideSummarisedMessages}
                      summaryTailMessages={summaryTailMessages}
                      automaticSummariesAvailable={chatMode === "roleplay"}
                      totalMessageCount={totalMessageCount}
                      promptPresetId={typeof chat?.promptPresetId === "string" ? chat.promptPresetId : null}
                    />
                    <ActiveContextLinksButton
                      chat={chat}
                      chatMeta={chatMeta}
                      chatCharIds={chatCharIds}
                      characterMap={characterMap}
                      onViewAll={onOpenVault}
                      onOpenVault={onOpenVault}
                    />
                    <AuthorNotesButton
                      chatId={chat?.id ?? null}
                      chatMeta={chatMeta}
                      open={!compactToolbarOwnsAuthorNotes && expandedAuthorNotesOpen}
                      onOpenChange={
                        compactToolbarOwnsAuthorNotes ? setCompactAuthorNotesOpen : setExpandedAuthorNotesOpen
                      }
                      renderPanel={!compactToolbarOwnsAuthorNotes}
                      mobilePanel={false}
                    />
                    <ChatToolbarButton icon={<Image size="0.875rem" />} title="Gallery" onClick={onOpenGallery} />
                    {chat?.connectedChatId && (
                      <ChatToolbarButton
                        icon={<ArrowRightLeft size="0.875rem" />}
                        title={linkedChatName ? `Switch to ${linkedChatName}` : "Connected chat"}
                        onClick={() => useChatStore.getState().setActiveChatId(chat.connectedChatId!)}
                      />
                    )}
                    <ChatToolbarButton
                      icon={<Settings2 size="0.875rem" />}
                      title="Chat Settings"
                      onClick={onOpenSettings}
                    />
                  </ChatToolbarMenu>
                </div>
              </div>
              <div
                data-tracker-panel-anchor={centerCompact ? "roleplay-hud" : undefined}
                className={cn(
                  "pointer-events-auto relative z-40 w-full flex-col",
                  centerCompact ? "flex" : "flex md:hidden",
                )}
              >
                {chat && chatMeta.enableAgents && (
                  <div
                    className="flex w-full min-w-0 items-start justify-between gap-1.5 pb-1 pt-2"
                    style={{
                      paddingLeft: "calc(0.5rem + var(--tracker-panel-hud-clear-left, 0px))",
                      paddingRight: "calc(0.5rem + var(--tracker-panel-hud-clear-right, 0px))",
                    }}
                  >
                    <div className="min-w-0 flex-1 overflow-x-auto">
                      <Suspense fallback={null}>
                        <RoleplayHUD
                          chatId={chat.id}
                          characterCount={chatCharIds.length}
                          layout="top"
                          isStreaming={isStreaming}
                          onRetriggerTrackers={onRerunTrackers}
                          onRetryFailedAgents={onRetryFailedAgents}
                          onRerunSingleTracker={onRerunSingleTracker}
                          enabledAgentTypes={enabledAgentTypes}
                          manualTrackers={!!chatMeta.manualTrackers}
                          mobileCompact
                          injectionSourceMessages={messages}
                        />
                      </Suspense>
                    </div>
                    <div
                      data-roleplay-top-controls="right"
                      className={cn("ml-auto flex shrink-0 items-center", CHAT_TOOLBAR_ICON_GAP_CLASS)}
                    >
                      <ChatToolbarMenu>
                        <ChatBranchSelector
                          activeChatId={activeChatId}
                          activeChatName={chat?.name}
                          groupId={chat?.groupId ?? null}
                          variant="roleplay"
                          compact
                        />
                        <SummaryButton
                          chatId={chat?.id ?? null}
                          summary={chatMeta.summary ?? null}
                          summaryEntries={
                            Array.isArray(chatMeta.summaryEntries)
                              ? (chatMeta.summaryEntries as ChatSummaryEntry[])
                              : []
                          }
                          summaryContextSize={summaryContextSize}
                          summaryPromptTemplates={
                            Array.isArray(chatMeta.summaryPromptTemplates) ? chatMeta.summaryPromptTemplates : []
                          }
                          activeSummaryPromptTemplateId={
                            typeof chatMeta.activeSummaryPromptTemplateId === "string"
                              ? chatMeta.activeSummaryPromptTemplateId
                              : null
                          }
                          summaryConnectionId={
                            typeof chatMeta.summaryConnectionId === "string" ? chatMeta.summaryConnectionId : null
                          }
                          automaticSummaryEnabled={automaticSummaryEnabled}
                          activeAgentIds={summaryActiveAgentIds}
                          summaryRunInterval={summaryRunInterval}
                          hideSummarisedMessages={hideSummarisedMessages}
                          summaryTailMessages={summaryTailMessages}
                          automaticSummariesAvailable={chatMode === "roleplay"}
                          totalMessageCount={totalMessageCount}
                          promptPresetId={typeof chat?.promptPresetId === "string" ? chat.promptPresetId : null}
                        />
                        <ActiveContextLinksButton
                          chat={chat}
                          chatMeta={chatMeta}
                          chatCharIds={chatCharIds}
                          characterMap={characterMap}
                          onViewAll={onOpenVault}
                          onOpenVault={onOpenVault}
                        />
                        <AuthorNotesButton
                          chatId={chat?.id ?? null}
                          chatMeta={chatMeta}
                          open={compactAuthorNotesOpen}
                          onOpenChange={setCompactAuthorNotesOpen}
                          renderPanel={compactToolbarOwnsAuthorNotes}
                          mobilePanel
                        />
                        <ChatToolbarButton icon={<Image size="0.875rem" />} title="Gallery" onClick={onOpenGallery} />
                        {chat?.connectedChatId && (
                          <ChatToolbarButton
                            icon={<ArrowRightLeft size="0.875rem" />}
                            title={linkedChatName ? `Switch to ${linkedChatName}` : "Connected chat"}
                            onClick={() => useChatStore.getState().setActiveChatId(chat.connectedChatId!)}
                          />
                        )}
                        <ChatToolbarButton
                          icon={<Settings2 size="0.875rem" />}
                          title="Chat Settings"
                          onClick={onOpenSettings}
                        />
                      </ChatToolbarMenu>
                    </div>
                  </div>
                )}
                {chat && !chatMeta.enableAgents && (
                  <div
                    className={cn("flex w-full items-center justify-end px-2 pb-1 pt-2", CHAT_TOOLBAR_ICON_GAP_CLASS)}
                  >
                    <ChatToolbarMenu>
                      <ChatBranchSelector
                        activeChatId={activeChatId}
                        activeChatName={chat?.name}
                        groupId={chat?.groupId ?? null}
                        variant="roleplay"
                        compact
                      />
                      <SummaryButton
                        chatId={chat?.id ?? null}
                        summary={chatMeta.summary ?? null}
                        summaryEntries={
                          Array.isArray(chatMeta.summaryEntries) ? (chatMeta.summaryEntries as ChatSummaryEntry[]) : []
                        }
                        summaryContextSize={summaryContextSize}
                        summaryPromptTemplates={
                          Array.isArray(chatMeta.summaryPromptTemplates) ? chatMeta.summaryPromptTemplates : []
                        }
                        activeSummaryPromptTemplateId={
                          typeof chatMeta.activeSummaryPromptTemplateId === "string"
                            ? chatMeta.activeSummaryPromptTemplateId
                            : null
                        }
                        summaryConnectionId={
                          typeof chatMeta.summaryConnectionId === "string" ? chatMeta.summaryConnectionId : null
                        }
                        automaticSummaryEnabled={automaticSummaryEnabled}
                        activeAgentIds={summaryActiveAgentIds}
                        summaryRunInterval={summaryRunInterval}
                        hideSummarisedMessages={hideSummarisedMessages}
                        summaryTailMessages={summaryTailMessages}
                        automaticSummariesAvailable={chatMode === "roleplay"}
                        totalMessageCount={totalMessageCount}
                        promptPresetId={typeof chat?.promptPresetId === "string" ? chat.promptPresetId : null}
                      />
                      <ActiveContextLinksButton
                        chat={chat}
                        chatMeta={chatMeta}
                        chatCharIds={chatCharIds}
                        characterMap={characterMap}
                        onViewAll={onOpenVault}
                        onOpenVault={onOpenVault}
                      />
                      <AuthorNotesButton
                        chatId={chat?.id ?? null}
                        chatMeta={chatMeta}
                        open={compactAuthorNotesOpen}
                        onOpenChange={setCompactAuthorNotesOpen}
                        renderPanel={compactToolbarOwnsAuthorNotes}
                        mobilePanel
                      />
                      <ChatToolbarButton icon={<Image size="0.875rem" />} title="Gallery" onClick={onOpenGallery} />
                      {chat?.connectedChatId && (
                        <ChatToolbarButton
                          icon={<ArrowRightLeft size="0.875rem" />}
                          title={linkedChatName ? `Switch to ${linkedChatName}` : "Connected chat"}
                          onClick={() => useChatStore.getState().setActiveChatId(chat.connectedChatId!)}
                        />
                      )}
                      <ChatToolbarButton
                        icon={<Settings2 size="0.875rem" />}
                        title="Chat Settings"
                        onClick={onOpenSettings}
                      />
                    </ChatToolbarMenu>
                  </div>
                )}
              </div>
            </div>

            {encounterActive && (
              <Suspense fallback={null}>
                <EncounterModal />
              </Suspense>
            )}

            <div className={cn("absolute inset-0 z-10 overflow-hidden", TRACKER_FOREGROUND_AVOIDANCE_CLASS)}>
              <div
                ref={scrollRef}
                data-chat-scroll
                className={cn(
                  "rpg-chat-messages-mobile mari-messages-scroll relative h-full overflow-y-auto overflow-x-hidden",
                  centerCompact ? "px-3" : "px-3 md:px-8 lg:px-10 xl:px-12",
                )}
                style={{
                  paddingTop: Math.max(16, chromeHeights.top + 12),
                  paddingBottom: Math.max(16, chromeHeights.bottom + 12),
                  scrollPaddingTop: Math.max(16, chromeHeights.top + 8),
                  scrollPaddingBottom: Math.max(16, chromeHeights.bottom + 12),
                }}
              >
                {hasNextPage && (
                  <div className="mb-3 flex justify-center">
                    <button
                      onClick={handleLoadMoreClick}
                      disabled={isFetchingNextPage}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-[var(--card)] px-3 py-1.5 text-xs font-medium text-foreground/70 backdrop-blur-sm transition-all hover:bg-[var(--accent)] hover:text-foreground/90 disabled:opacity-50"
                    >
                      {isFetchingNextPage ? (
                        <Loader2 size="0.75rem" className="animate-spin" />
                      ) : (
                        <ChevronUp size="0.75rem" />
                      )}
                      Load More
                    </button>
                  </div>
                )}

                <TranscriptWindowControls
                  hiddenBeforeCount={transcriptWindow.hiddenBeforeCount}
                  hiddenAfterCount={transcriptWindow.hiddenAfterCount}
                  onShowOlder={transcriptWindow.hiddenBeforeCount > 0 ? showOlderTranscriptMessages : undefined}
                  className="pt-0"
                />

                {isLoading && (
                  <div className="flex flex-col items-center gap-3 py-12">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-foreground/20 border-t-white/60" />
                  </div>
                )}

                {visibleMessages?.map((msg, i) => {
                  if (isHiddenFromUser(msg)) return null;
                  const sourceIndex = transcriptWindow.startIndex + i;
                  const messageDepth = (messages?.length ?? 0) - 1 - sourceIndex;
                  const messageOrderIndex = loadedMessageOffset + sourceIndex;
                  const isRegenerating = hasLiveStream && regenerateMessageId === msg.id;
                  return (
                    <div
                      key={msg.id}
                      className={shouldAnimateMessages ? "animate-message-in" : undefined}
                      style={
                        shouldAnimateMessages
                          ? { animationDelay: `${Math.min(i * 30, 200)}ms`, animationFillMode: "backwards" }
                          : undefined
                      }
                    >
                      {isRegenerating ? (
                        <RegeneratingMessageContent
                          msg={msg}
                          onDelete={onDelete}
                          onRegenerate={onRegenerate}
                          onEdit={onEdit}
                          onSetActiveSwipe={onSetActiveSwipe}
                          onToggleConversationStart={onToggleConversationStart}
                          onToggleHiddenFromAI={onToggleHiddenFromAI}
                          onPeekPrompt={onPeekPrompt}
                          onBranch={onBranch}
                          onCloneSceneFromHere={onCloneSceneFromHere}
                          isCloneSceneFromHereDisabled={isCloneSceneFromHereDisabled}
                          isLastAssistantMessage={msg.id === lastAssistantMessageId}
                          characterMap={characterMap}
                          personaInfo={personaInfo}
                          chatMode={chatMode}
                          hasDraftInput={hasDraftInput}
                          messageDepth={messageDepth}
                          messageIndex={messageOrderIndex + 1}
                          messageOrderIndex={messageOrderIndex}
                          isGrouped={isGrouped(sourceIndex)}
                          groupChatMode={groupChatMode}
                          chatCharacterIds={chatCharIds}
                          expressionAvatarResolver={expressionAvatarResolver}
                          multiSelectMode={multiSelectMode}
                          isSelected={selectedMessageIds.has(msg.id)}
                          onToggleSelect={onToggleSelectMessage}
                        />
                      ) : (
                        <ChatMessage
                          message={msg}
                          isStreaming={false}
                          onDelete={onDelete}
                          onRegenerate={onRegenerate}
                          onEdit={onEdit}
                          onSetActiveSwipe={onSetActiveSwipe}
                          onToggleConversationStart={onToggleConversationStart}
                          onToggleHiddenFromAI={onToggleHiddenFromAI}
                          onPeekPrompt={onPeekPrompt}
                          onBranch={onBranch}
                          onCloneSceneFromHere={onCloneSceneFromHere}
                          isCloneSceneFromHereDisabled={isCloneSceneFromHereDisabled}
                          isLastAssistantMessage={msg.id === lastAssistantMessageId}
                          characterMap={characterMap}
                          personaInfo={personaInfo}
                          chatMode={chatMode}
                          hasDraftInput={hasDraftInput}
                          messageDepth={messageDepth}
                          messageIndex={messageOrderIndex + 1}
                          messageOrderIndex={messageOrderIndex}
                          isGrouped={isGrouped(sourceIndex)}
                          groupChatMode={groupChatMode}
                          chatCharacterIds={chatCharIds}
                          expressionAvatarResolver={expressionAvatarResolver}
                          multiSelectMode={multiSelectMode}
                          isSelected={selectedMessageIds.has(msg.id)}
                          onToggleSelect={onToggleSelectMessage}
                        />
                      )}
                    </div>
                  );
                })}

                <TranscriptWindowControls
                  hiddenBeforeCount={transcriptWindow.hiddenBeforeCount}
                  hiddenAfterCount={transcriptWindow.hiddenAfterCount}
                  onShowNewer={transcriptWindow.hiddenAfterCount > 0 ? showNewerTranscriptMessages : undefined}
                  onJumpToLatest={transcriptWindow.hiddenAfterCount > 0 ? jumpToLatestTranscriptMessages : undefined}
                />

                {!isStreaming && <CyoaChoices messages={visibleMessages} />}

                {hasLiveStream && !regenerateMessageId && (
                  <StreamingIndicator
                    activeChatId={activeChatId}
                    chatCharIds={chatCharIds}
                    characterMap={characterMap}
                    personaInfo={personaInfo}
                    chatMode={chatMode}
                    groupChatMode={groupChatMode}
                    expressionAvatarResolver={expressionAvatarResolver}
                  />
                )}

                <div ref={messagesEndRef} />
              </div>
            </div>
            <PinnedImageOverlay activeChatId={activeChatId} />

            <div
              ref={inputChromeRef}
              className={cn("pointer-events-none absolute inset-x-0 bottom-0 z-30", TRACKER_FOREGROUND_AVOIDANCE_CLASS)}
            >
              <div
                className={cn(
                  "mari-roleplay-input-column pointer-events-auto relative mx-auto px-3 md:px-0",
                )}
              >
                {chatMeta.sceneStatus === "active" && (
                  <EndSceneBar
                    sceneChatId={activeChatId}
                    originChatId={chatMeta.sceneOriginChatId}
                    onConclude={onConcludeScene}
                    onAbandon={onAbandonScene}
                    onFork={onForkScene}
                    isForking={isForkingScene}
                  />
                )}
                <ChatInput
                  key={activeChatId}
                  mode={isRoleplay ? "roleplay" : "conversation"}
                  combatAgentEnabled={combatAgentEnabled}
                  onStartEncounter={onStartEncounter}
                  characterNames={characterNames}
                  groupResponseOrder={
                    chatCharIds.length > 1 && groupChatMode === "individual"
                      ? (chatMeta.groupResponseOrder ?? "sequential")
                      : undefined
                  }
                  chatCharacters={chatCharIds
                    .filter((id) => characterMap.has(id))
                    .map((id) => {
                      const info = characterMap.get(id)!;
                      return {
                        id,
                        name: info.name,
                        avatarUrl: info.avatarUrl ?? null,
                        avatarCrop: info.avatarCrop ?? null,
                      };
                    })}
                  onExpressionChange={onExpressionChange}
                  onPeekPrompt={onPeekPrompt}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Always mount so stagger timer runs even when panel is hidden */}
        <Suspense fallback={null}>
          <EchoChamberPanel hiddenOnMobile={hideEchoChamberOnMobile} />
        </Suspense>
      </div>

      <ChatCommonOverlays
        chat={chat}
        settingsOpen={settingsOpen}
        settingsAnchor={settingsAnchor}
        settingsInitialSection={settingsInitialSection}
        filesOpen={filesOpen}
        galleryOpen={galleryOpen}
        galleryAnchor={galleryAnchor}
        wizardOpen={wizardOpen}
        peekPromptData={peekPromptData}
        deleteDialogMessageId={deleteDialogMessageId}
        deleteDialogCanDeleteSwipe={deleteDialogCanDeleteSwipe}
        deleteDialogActiveSwipeIndex={deleteDialogActiveSwipeIndex}
        deleteDialogSwipeCount={deleteDialogSwipeCount}
        multiSelectMode={multiSelectMode}
        selectedMessageCount={selectedMessageIds.size}
        sceneSettings={{
          spriteArrangeMode,
          onToggleSpriteArrange,
          onResetSpritePlacements,
          onSpriteSideChange,
          spriteVisualSettings,
          onSpriteVisualSettingsChange,
        }}
        onCloseSettings={onCloseSettings}
        onCloseFiles={onCloseFiles}
        onCloseGallery={onCloseGallery}
        onIllustrate={onIllustrate}
        onWizardFinish={onWizardFinish}
        onClosePeekPrompt={onClosePeekPrompt}
        onDeleteConfirm={onDeleteConfirm}
        onDeleteSwipe={onDeleteSwipe}
        onDeleteMore={onDeleteMore}
        onCloseDeleteDialog={onCloseDeleteDialog}
        onBulkDelete={onBulkDelete}
        onCancelMultiSelect={onCancelMultiSelect}
        onUnselectAllMessages={onUnselectAllMessages}
        onSelectAllAboveSelection={onSelectAllAboveSelection}
        onSelectAllBelowSelection={onSelectAllBelowSelection}
      />
    </div>
  );
}
