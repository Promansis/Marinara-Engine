import {
  BUILT_IN_AGENTS,
  isStockMarinaraUniversalPreset,
  type AchievementEvent,
  type PromptPreset,
} from "@marinara-engine/shared";
import { toast } from "sonner";
import { trackAchievementEvent } from "../hooks/use-achievements";
import { presetKeys } from "../hooks/use-presets";
import { translate } from "../localization/i18n";
import { api } from "./api-client";
import { confirmEditorLeave } from "./editor-leave";
import { queryClient } from "./query-client";
import { useChatStore } from "../stores/chat.store";
import { isMobileShellViewport, useUIStore, type HomeRequest } from "../stores/ui.store";
import { requestChatSettingsSectionOpen } from "./chat-floating-ui-events";
import { TRACKER_PANEL_BUBBLE_ID, useFloatingWindowStore } from "../stores/floating-window.store";
import { revealSettingsSection } from "./settings-section-open";
import { requestProfessorMariOpen } from "./professor-mari-open";
import type { ProfessorMariNavigationTarget } from "./professor-mari-navigation";
import { isOmnibarSettingsTarget, settingsControlHome, type SettingsSearchableControlMeta } from "./settings-registry";

/** Music DJ is both the agent type and the package id. */
const MUSIC_DJ_AGENT_ID = "spotify";
const DISCORD_INVITE_URL = "https://discord.com/invite/KdAkTg94ME";
const SUPPORT_URL = "https://ko-fi.com/marinara_spaghetti";

/** The same achievement events Home's own Discord, Ko-fi and Credits links fire. */
function trackWindow(event: AchievementEvent) {
  void trackAchievementEvent(event, { keepalive: true }).catch(() => undefined);
}

/** Leave the current chat or editor, show Home, then let Home open the surface. */
function openHomeWith(request: HomeRequest) {
  const ui = useUIStore.getState();
  useChatStore.getState().setActiveChatId(null);
  ui.closeAllDetails();
  ui.closeRightPanel();
  ui.requestHome(request);
}

/** Every mounted copy of a control's anchor; duplicated ids are why this is not `getElementById`. */
function settingsAnchorNodes(controlId: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      `[id="settings-control-${controlId}"], [data-settings-anchor="${controlId}"]`,
    ),
  );
}

function visibleSettingsAnchor(controlId: string): HTMLElement | null {
  return (
    settingsAnchorNodes(controlId)
      .reverse()
      .find((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden") ?? null
  );
}

/** The place is lazy and its card may load data first, so wait a few seconds for the anchor instead of looking once. */
function scrollToSettingsAnchor(controlId: string, onMissing?: () => void) {
  let attempts = 0;
  const scrollWhenReady = () => {
    const anchor = visibleSettingsAnchor(controlId);
    if (anchor) {
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      anchor.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      (
        anchor.querySelector<HTMLElement>("[data-settings-focus]") ??
        anchor.querySelector<HTMLElement>("[role='radio'][tabindex='0']") ??
        anchor.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
      )?.focus({ preventScroll: true });
      return;
    }
    // An anchor inside a collapsed Settings section has no box yet: open the section and look again.
    settingsAnchorNodes(controlId).forEach(revealSettingsSection);
    if (++attempts < 30) window.setTimeout(scrollWhenReady, 100);
    else onMissing?.();
  };
  scrollWhenReady();
}

/**
 * The "Add parameter" row has no panel of its own: it sits under the sliders in the shared parameters editor. When no
 * chat can show it, open the first preset the user can edit (the stock Marinara Universal preset is read-only and
 * renders no parameters), asking first if an open editor has unsaved edits. With no editable preset, say where to go.
 */
async function openParametersInEditablePreset(controlId: string) {
  if (!confirmEditorLeave(useUIStore.getState(), translate("commandCenter.dirtyEditor"))) return;
  const presets = await queryClient
    .fetchQuery({
      queryKey: presetKeys.list(),
      queryFn: () => api.get<PromptPreset[]>("/prompts"),
      staleTime: 5 * 60_000,
    })
    .catch(() => [] as PromptPreset[]);
  const editable = presets.filter((preset) => !isStockMarinaraUniversalPreset(preset));
  const preset = editable.find((candidate) => String(candidate.isDefault) === "true") ?? editable[0];
  if (!preset) {
    toast(translate("settings.customGenerationParameters.noEditablePreset"), {
      action: {
        label: translate("settings.customGenerationParameters.openPresets"),
        onClick: () => useUIStore.getState().openRightPanel("presets"),
      },
    });
    return;
  }
  useUIStore.getState().openPresetDetail(preset.id, { initialTab: "parameters" });
  scrollToSettingsAnchor(controlId);
}

/** Chat Settings › Advanced Parameters when this chat can show the row; otherwise an editable preset. */
function openChatParameters(controlId: string) {
  const ui = useUIStore.getState();
  if (visibleSettingsAnchor(controlId)) return scrollToSettingsAnchor(controlId);
  const chatId = useChatStore.getState().activeChatId;
  // An open editor or library unmounts the chat (desktop) or covers it (phone), so Chat Settings cannot show.
  if (!chatId || ui.hasAnyDetailOpen() || ui.botBrowserOpen || ui.gameAssetsBrowserOpen) {
    void openParametersInEditablePreset(controlId);
    return;
  }
  const requestRow = () => requestChatSettingsSectionOpen(chatId, "advanced-parameters");
  // The phone shell hides the chat behind an open right panel, so close it and ask on the next frame.
  if (isMobileShellViewport()) {
    ui.closeRightPanel();
    requestAnimationFrame(requestRow);
  } else requestRow();
  // A provider that never sends custom parameters (openai_chatgpt, grok_subscription) hides the row.
  scrollToSettingsAnchor(controlId, () => void openParametersInEditablePreset(controlId));
}

/**
 * Show the Tracker panel with its header menu open, at the menu or at Card colors. Anything covering the chat is
 * closed first (asking before an open editor with unsaved edits is left), and on the phone shell the right panel
 * goes too, with the menu asked for on the next frame.
 */
function showTrackerLookMenu(controlId: string, chatId: string) {
  const ui = useUIStore.getState();
  // An open editor or library unmounts the chat (desktop) or covers it (phone), so the Tracker panel cannot show.
  if (ui.hasAnyDetailOpen()) {
    if (!confirmEditorLeave(ui, translate("commandCenter.dirtyEditor"))) return;
    ui.closeAllDetails();
  }
  const showMenu = () => {
    const current = useUIStore.getState();
    current.setTrackerPanelOpen(true, chatId);
    useFloatingWindowStore.getState().openWindow(TRACKER_PANEL_BUBBLE_ID, null, { focus: false });
    current.requestTrackerLookMenu(controlId === "tracker-card-colors" ? "colors" : "menu");
    // A request nobody picked up (the panel is popped out, or never mounted) must not open the menu later.
    scrollToSettingsAnchor(controlId, () => useUIStore.getState().consumeTrackerLookMenuRequest());
  };
  if (isMobileShellViewport()) {
    ui.closeRightPanel();
    requestAnimationFrame(showMenu);
  } else showMenu();
}

/**
 * Send a search for a Tracker look control to the Tracker panel's header menu. Nothing is changed on the way: a
 * switched-off panel is only turned on from the toast's action, and with no Roleplay chat open there is no panel
 * to show.
 */
function openTrackerLookMenu(controlId: string) {
  const { activeChatId, activeChat } = useChatStore.getState();
  if (!activeChatId || activeChat?.id !== activeChatId || activeChat.mode !== "roleplay") {
    toast(translate("ui.trackerPanel.lookMenu.needsRoleplayChat"));
    return;
  }
  if (!useUIStore.getState().trackerPanelEnabled) {
    toast(translate("ui.trackerPanel.lookMenu.panelOff"), {
      action: {
        label: translate("ui.trackerPanel.lookMenu.turnOn"),
        onClick: () => {
          useUIStore.getState().setTrackerPanelEnabled(true);
          showTrackerLookMenu(controlId, activeChatId);
        },
      },
    });
    return;
  }
  showTrackerLookMenu(controlId, activeChatId);
}

/**
 * Open the place a searchable control lives in and scroll to it. The player switch lives in the Music DJ agent's
 * detail; when that agent is not installed there is no detail, so open its Agents catalog entry instead. The
 * custom-parameters row lives in the shared parameters editor (see `openChatParameters`), and the Tracker look
 * controls live in the Tracker panel's header menu (see `openTrackerLookMenu`). The help-pages repair actions live in the help viewer.
 */
export function openSettingsControlHome(controlId: string, panel: NonNullable<SettingsSearchableControlMeta["home"]>) {
  const ui = useUIStore.getState();
  if (panel === "chat-parameters") return openChatParameters(controlId);
  if (panel === "music-dj") {
    if (!BUILT_IN_AGENTS.some((agent) => agent.id === MUSIC_DJ_AGENT_ID)) {
      ui.openAgentCatalog(MUSIC_DJ_AGENT_ID);
      return;
    }
    ui.openAgentDetail(MUSIC_DJ_AGENT_ID);
  } else if (panel === "tracker") {
    return openTrackerLookMenu(controlId);
  } else if (panel === "docs") {
    // The help-pages repair actions live in the help viewer's header.
    ui.openModal("docs-viewer");
  } else ui.openRightPanel(panel);
  scrollToSettingsAnchor(controlId);
}

export function executeStateNavigation(target: ProfessorMariNavigationTarget): boolean {
  const ui = useUIStore.getState();
  if (target.kind === "home") {
    useChatStore.getState().setActiveChatId(null);
    ui.closeAllDetails();
    ui.closeRightPanel();
  } else if (target.kind === "professor") {
    useChatStore.getState().setActiveChatId(null);
    ui.closeAllDetails();
    ui.closeRightPanel();
    requestProfessorMariOpen();
  } else if (target.kind === "chats") {
    ui.setSidebarOpen(true);
    ui.closeRightPanel();
  } else if (target.kind === "chat") {
    // On the phone shell the sidebar is a full-screen sheet, so opening it here
    // would cover the chat we just navigated to (F3, slice 41); closing it when
    // it was already open before this navigation covers the same case for a
    // sheet the user had open beforehand, not just one this action would have
    // opened (O4 item 6).
    if (isMobileShellViewport()) ui.setSidebarOpen(false);
    else ui.setSidebarOpen(true);
    ui.closeRightPanel();
    useChatStore.getState().setActiveChatId(target.chatId);
  } else if (target.kind === "panel") {
    ui.openRightPanel(target.panel);
  } else if (target.kind === "settings" && target.controlId && settingsControlHome(target.controlId)) {
    openSettingsControlHome(target.controlId, settingsControlHome(target.controlId)!);
  } else if (target.kind === "settings" && isOmnibarSettingsTarget(target)) {
    // Q2: these live in the omnibar's settings view, which keeps the omnibar open.
    ui.openOmnibarSettings(target.controlId ?? null);
    return true;
  } else if (target.kind === "settings") {
    ui.setSettingsTab(target.tab);
    ui.setSettingsTargetControlId(target.controlId ?? null);
    ui.setSettingsTargetSectionId(target.sectionId ?? null);
    ui.openRightPanel("settings");
  } else if (target.kind === "surface") {
    if (target.surface === "card-downloads") ui.openBotBrowser();
    else if (target.surface === "character-library") ui.openCharacterLibrary();
    else if (target.surface === "persona-library") ui.openPersonaLibrary();
    else if (target.surface === "agent-catalog") ui.openAgentCatalog();
    else ui.openGameAssetsBrowser();
  } else if (target.kind === "resource") {
    if (target.resource === "character") ui.openCharacterDetail(target.id);
    else if (target.resource === "persona") ui.openPersonaDetail(target.id);
    else if (target.resource === "preset") ui.openPresetDetail(target.id);
    else if (target.resource === "lorebook")
      ui.openLorebookDetail(target.id, target.entryId ? { initialTab: "entries", entryId: target.entryId } : undefined);
    else ui.openAgentDetail(target.id);
  } else if (target.kind === "window") {
    if (target.window === "documentation") ui.openModal("docs-viewer");
    else if (target.window === "tutorial") ui.setHasCompletedOnboarding(false);
    else if (target.window === "discord") {
      trackWindow("discord_clicked");
      window.open(DISCORD_INVITE_URL, "_blank", "noopener,noreferrer");
    } else if (target.window === "support") {
      trackWindow("kofi_clicked");
      window.open(SUPPORT_URL, "_blank", "noopener,noreferrer");
    } else if (target.window === "credits") {
      trackWindow("credits_viewed");
      openHomeWith({ kind: "credits" });
    } else if (target.window === "faq" || target.window === "widgets") openHomeWith({ kind: target.window });
  } else openHomeWith({ kind: "tab", tab: target.packageId });
  ui.setOmnibarOpen(false);
  return true;
}
