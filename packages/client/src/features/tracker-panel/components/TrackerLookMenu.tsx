import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Dock,
  Gauge,
  MessageCircle,
} from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import {
  TRACKER_DATA_PANEL_SECTIONS,
  TRACKER_PANEL_DEFAULT_BACKGROUND_COLOR,
  getTrackerPanelWidthForProfile,
  useUIStore,
  type TrackerDataPanelSection,
  type TrackerLookMenuView,
  type TrackerPanelSizeProfile,
  type TrackerStatDisplayMode,
  type TrackerThoughtBubbleDisplay,
} from "../../../stores/ui.store";
import { ColorPicker } from "../../../components/ui/ColorPicker";
import { TrackerSizeTierIcon } from "../../../components/ui/TrackerSizeTierIcon";
import {
  SETTINGS_BUTTON_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SettingsSwitch,
} from "../../../components/panels/settings/SettingControls";
import { TrackerCardColorSettings } from "../../../components/panels/settings/TrackerCardColorSettings";
import { cn } from "../../../lib/utils";

/**
 * The panel keeps its own dark palette in both themes (`TRACKER_PANEL_NEUTRAL_VARS`), but the shared chrome buttons
 * and hints derive their colors from the app theme at the root. Point them at the panel's palette so the menu reads
 * the same in light and dark.
 */
const PANEL_PALETTE =
  "text-[var(--foreground)] [--marinara-chat-chrome-button-bg:var(--secondary)] [--marinara-chat-chrome-button-bg-hover:var(--accent)] [--marinara-chat-chrome-button-bg-active:var(--accent)] [--marinara-chat-chrome-button-border:var(--border)] [--marinara-chat-chrome-button-border-hover:var(--ring)] [--marinara-chat-chrome-button-border-active:var(--ring)] [--marinara-chat-chrome-button-text:var(--muted-foreground)] [--marinara-chat-chrome-button-text-hover:var(--foreground)] [--marinara-chat-chrome-button-text-active:var(--foreground)] [--marinara-chat-chrome-panel-muted:var(--muted-foreground)] [--marinara-chat-chrome-panel-title:var(--foreground)] [--marinara-chat-chrome-panel-text:var(--foreground)]";

/** The anchor id search jumps to (`openSettingsControlHome` looks for `settings-control-<id>`). */
const anchorId = (controlId: string) => `settings-control-${controlId}`;

const SIZE_OPTIONS: Array<{ id: TrackerPanelSizeProfile; labelKey: string }> = [
  { id: "compact", labelKey: "ui.trackerPanel.lookMenu.sizeCompact" },
  { id: "standard", labelKey: "ui.trackerPanel.lookMenu.sizeStandard" },
  { id: "expanded", labelKey: "ui.trackerPanel.lookMenu.sizeExpanded" },
];

const CARD_LABEL_KEYS: Record<TrackerDataPanelSection, string> = {
  world: "ui.trackerPanel.lookMenu.cardWorld",
  persona: "ui.trackerPanel.lookMenu.cardPersona",
  characters: "ui.trackerPanel.lookMenu.cardCharacters",
  inventory: "ui.panels.trackerOrder.inventoryTracker",
  quests: "ui.trackerPanel.lookMenu.cardQuests",
  custom: "ui.trackerPanel.lookMenu.cardCustom",
};

function Row({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div id={anchorId(id)} className="grid scroll-mt-3 gap-1">
      <span className="text-[0.6875rem] font-medium text-[var(--foreground)]">{label}</span>
      {children}
      {hint && <span className="text-[0.625rem] leading-tight text-[var(--muted-foreground)]">{hint}</span>}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string; icon?: ReactNode; title?: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          title={option.title}
          onClick={() => onChange(option.id)}
          className={cn(SETTINGS_BUTTON_CLASS, "min-w-0 flex-auto")}
        >
          <span className="inline-flex items-center gap-1.5">
            {option.icon}
            {option.label}
          </span>
        </button>
      ))}
    </div>
  );
}

function CardOrder() {
  const { t } = useUiTranslation();
  const sectionOrder = useUIStore((s) => s.trackerPanelSectionOrder);
  const setSectionOrder = useUIStore((s) => s.setTrackerPanelSectionOrder);
  const ordered = [
    ...sectionOrder.filter((section) => TRACKER_DATA_PANEL_SECTIONS.includes(section)),
    ...TRACKER_DATA_PANEL_SECTIONS.filter((section) => !sectionOrder.includes(section)),
  ];
  const isDefaultOrder = ordered.every((section, index) => section === TRACKER_DATA_PANEL_SECTIONS[index]);
  const [open, setOpen] = useState(!isDefaultOrder);
  const listId = useId();

  const move = (section: TrackerDataPanelSection, direction: -1 | 1) => {
    const index = ordered.indexOf(section);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ordered.length) return;
    const nextOrder = [...ordered];
    [nextOrder[index], nextOrder[next]] = [nextOrder[next]!, nextOrder[index]!];
    setSectionOrder(nextOrder);
  };

  return (
    <div id={anchorId("tracker-card-order")} className="grid scroll-mt-3 gap-1">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={listId}
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-left text-[0.6875rem] font-medium text-[var(--foreground)] hover:text-[var(--primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)]"
        >
          <ChevronDown size="0.6875rem" className={cn("shrink-0 transition-transform", !open && "-rotate-90")} />
          <span className="truncate">{t("ui.trackerPanel.lookMenu.cardOrder")}</span>
        </button>
        <button
          type="button"
          onClick={() => setSectionOrder([...TRACKER_DATA_PANEL_SECTIONS])}
          disabled={isDefaultOrder}
          className={SETTINGS_BUTTON_CLASS}
        >
          {t("ui.trackerPanel.lookMenu.resetOrder")}
        </button>
      </div>
      {open && (
        <div id={listId} className="grid gap-0.5">
          {ordered.map((section, index) => {
            const label = t(CARD_LABEL_KEYS[section]);
            return (
              <div
                key={section}
                className="grid min-h-7 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 rounded-sm bg-[var(--secondary)]/42 px-1.5 py-1 ring-1 ring-[var(--border)]/60"
              >
                <span className="truncate text-[0.6875rem] font-medium text-[var(--foreground)]">{label}</span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => move(section, -1)}
                    disabled={index === 0 || (section === "custom" && ordered[index - 1] === "inventory")}
                    title={t("ui.trackerPanel.lookMenu.moveUp", { card: label })}
                    aria-label={t("ui.trackerPanel.lookMenu.moveUp", { card: label })}
                    className={SETTINGS_ICON_BUTTON_CLASS}
                  >
                    <ArrowUp size="0.75rem" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(section, 1)}
                    disabled={
                      index === ordered.length - 1 || (section === "inventory" && ordered[index + 1] === "custom")
                    }
                    title={t("ui.trackerPanel.lookMenu.moveDown", { card: label })}
                    aria-label={t("ui.trackerPanel.lookMenu.moveDown", { card: label })}
                    className={SETTINGS_ICON_BUTTON_CLASS}
                  >
                    <ArrowDown size="0.75rem" />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The Tracker panel's look, in the panel's own header menu: size, stats, thoughts, background, sprites, docking,
 * card order and card colors. The on/off switch and temperature unit stay in Settings.
 */
export function TrackerLookMenu({
  id,
  view,
  onViewChange,
  onEscape,
}: {
  id: string;
  view: TrackerLookMenuView;
  onViewChange: (view: TrackerLookMenuView) => void;
  /** Escape from the top view closes the menu. */
  onEscape: () => void;
}) {
  const { t } = useUiTranslation();
  const dockToEdge = useUIStore((s) => s.trackerPanelHideHudWidgets);
  const setDockToEdge = useUIStore((s) => s.setTrackerPanelHideHudWidgets);
  const useSprites = useUIStore((s) => s.trackerPanelUseExpressionSprites);
  const setUseSprites = useUIStore((s) => s.setTrackerPanelUseExpressionSprites);
  const background = useUIStore((s) => s.trackerPanelBackgroundColor);
  const setBackground = useUIStore((s) => s.setTrackerPanelBackgroundColor);
  const sizeProfile = useUIStore((s) => s.trackerPanelSizeProfile);
  const setSizeProfile = useUIStore((s) => s.setTrackerPanelSizeProfile);
  const thoughtDisplay = useUIStore((s) => s.trackerPanelThoughtBubbleDisplay);
  const setThoughtDisplay = useUIStore((s) => s.setTrackerPanelThoughtBubbleDisplay);
  const statDisplay = useUIStore((s) => s.trackerStatDisplayMode);
  const setStatDisplay = useUIStore((s) => s.setTrackerStatDisplayMode);
  const dockedAlways = useUIStore((s) => s.trackerPanelDockedThoughtsAlwaysVisible);
  const setDockedAlways = useUIStore((s) => s.setTrackerPanelDockedThoughtsAlwaysVisible);

  // Moving between the menu and Card colors moves focus with it: Back on the way in, Edit on the way out.
  const backRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const previousViewRef = useRef(view);
  useEffect(() => {
    const previous = previousViewRef.current;
    previousViewRef.current = view;
    if (previous === view) return;
    (view === "colors" ? backRef : editRef).current?.focus({ preventScroll: true });
  }, [view]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (view === "colors") onViewChange("menu");
    else onEscape();
  };

  if (view === "colors") {
    return (
      <div
        id={id}
        role="group"
        aria-label={t("ui.trackerPanel.lookMenu.cardColors")}
        onKeyDown={handleKeyDown}
        className={cn("grid max-h-[min(70vh,34rem)] gap-2 overflow-y-auto overscroll-contain px-2 py-2", PANEL_PALETTE)}
      >
        <div id={anchorId("tracker-card-colors")} className="grid scroll-mt-3 gap-2">
          <button
            ref={backRef}
            type="button"
            data-settings-focus
            onClick={() => onViewChange("menu")}
            className="inline-flex w-fit items-center gap-1 rounded-sm text-[0.6875rem] text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)]"
          >
            <ChevronLeft size="0.75rem" />
            {t("ui.trackerPanel.lookMenu.backToTracker")}
          </button>
          <h3 className="text-xs font-semibold text-[var(--foreground)]">{t("ui.trackerPanel.lookMenu.cardColors")}</h3>
          <TrackerCardColorSettings />
        </div>
      </div>
    );
  }

  return (
    <div
      id={id}
      role="group"
      aria-label={t("ui.trackerPanel.lookMenu.panelSettings")}
      onKeyDown={handleKeyDown}
      className={cn("grid max-h-[min(70vh,34rem)] gap-2.5 overflow-y-auto overscroll-contain px-2 py-2", PANEL_PALETTE)}
    >
      <SettingsSwitch
        anchorId={anchorId("tracker-replace-hud-icons")}
        label={t("settings.controls.replaceTrackerIcons.label")}
        checked={dockToEdge}
        onChange={setDockToEdge}
        labelPosition="start"
        className="justify-between gap-3 p-1"
        labelClassName="text-[0.6875rem] font-medium"
      />
      <SettingsSwitch
        anchorId={anchorId("tracker-expression-sprites")}
        label={t("settings.controls.useExpressionSprites.label")}
        description={t("ui.trackerPanel.lookMenu.spritesHint")}
        checked={useSprites}
        onChange={setUseSprites}
        labelPosition="start"
        className="justify-between gap-3 p-1"
        labelClassName="text-[0.6875rem] font-medium"
      />
      <div id={anchorId("tracker-panel-background")} className="scroll-mt-3">
        <ColorPicker
          value={background}
          onChange={setBackground}
          gradient
          compact
          label={t("settings.controls.panelBackground.label")}
          emptyText={t("ui.panels.trackerpanelappearancedrawer.defaultValue1", {
            value1: TRACKER_PANEL_DEFAULT_BACKGROUND_COLOR,
          })}
          clearLabel={t("ui.trackerPanel.lookMenu.resetBackground")}
        />
      </div>
      <Row id="tracker-desktop-size" label={t("ui.panels.trackerpanelappearancedrawer.desktopSize")}>
        <Segmented<TrackerPanelSizeProfile>
          label={t("ui.panels.trackerpanelappearancedrawer.desktopSize")}
          value={sizeProfile}
          options={SIZE_OPTIONS.map((option) => ({
            id: option.id,
            label: t(option.labelKey),
            title: t("ui.trackerPanel.lookMenu.sizeTitle", {
              size: t(option.labelKey),
              px: getTrackerPanelWidthForProfile(option.id),
            }),
            icon: <TrackerSizeTierIcon sizeProfile={option.id} />,
          }))}
          onChange={setSizeProfile}
        />
      </Row>
      <Row id="tracker-thought-display-mode" label={t("ui.trackerPanel.lookMenu.thoughtDisplay")}>
        <Segmented<TrackerThoughtBubbleDisplay>
          label={t("ui.trackerPanel.lookMenu.thoughtDisplay")}
          value={thoughtDisplay}
          options={[
            {
              id: "inline",
              label: t("ui.trackerPanel.lookMenu.thoughtDocked"),
              title: t("ui.trackerPanel.lookMenu.thoughtDockedTitle"),
              icon: <Dock size="0.75rem" />,
            },
            {
              id: "floating",
              label: t("ui.trackerPanel.lookMenu.thoughtFloating"),
              title: t("ui.trackerPanel.lookMenu.thoughtFloatingTitle"),
              icon: <MessageCircle size="0.75rem" />,
            },
          ]}
          onChange={setThoughtDisplay}
        />
      </Row>
      <Row id="tracker-stat-display-mode" label={t("ui.trackerPanel.lookMenu.statDisplay")}>
        <Segmented<TrackerStatDisplayMode>
          label={t("ui.trackerPanel.lookMenu.statDisplay")}
          value={statDisplay}
          options={[
            {
              id: "bars",
              label: t("ui.panels.trackerpanelappearancedrawer.bars"),
              title: t("ui.panels.trackerpanelappearancedrawer.barsDescription"),
              icon: <BarChart3 size="0.75rem" />,
            },
            {
              id: "gauges",
              label: t("ui.panels.trackerpanelappearancedrawer.gauges"),
              title: t("ui.panels.trackerpanelappearancedrawer.gaugesDescription"),
              icon: <Gauge size="0.75rem" />,
            },
          ]}
          onChange={setStatDisplay}
        />
      </Row>
      <SettingsSwitch
        anchorId={anchorId("tracker-docked-thoughts")}
        label={t("settings.controls.alwaysShowDockedThoughts.label")}
        description={t("ui.trackerPanel.lookMenu.dockedThoughtsHint")}
        checked={dockedAlways}
        onChange={setDockedAlways}
        disabled={thoughtDisplay !== "inline"}
        labelPosition="start"
        className="justify-between gap-3 p-1"
        labelClassName="text-[0.6875rem] font-medium"
      />
      <CardOrder />
      <div className="flex min-h-8 items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-[0.6875rem] font-medium text-[var(--foreground)]">
            {t("ui.trackerPanel.lookMenu.cardColors")}
          </span>
          <span className="block text-[0.625rem] leading-tight text-[var(--muted-foreground)]">
            {t("ui.trackerPanel.lookMenu.cardColorsHint")}
          </span>
        </span>
        <button
          ref={editRef}
          type="button"
          onClick={() => onViewChange("colors")}
          className={cn(SETTINGS_BUTTON_CLASS, "shrink-0")}
        >
          {t("ui.trackerPanel.lookMenu.edit")}
          <ChevronRight size="0.75rem" />
        </button>
      </div>
    </div>
  );
}
