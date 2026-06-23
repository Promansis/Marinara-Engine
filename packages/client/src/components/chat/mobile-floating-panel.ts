const MOBILE_FLOATING_PANEL_PADDING = 8;

export type MobileFloatingPanelFrame = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

export function getMobileFloatingPanelFrame(
  button: HTMLElement | null,
  preferredWidth: number,
): MobileFloatingPanelFrame | null {
  if (!button || typeof window === "undefined") return null;
  const rect = button.getBoundingClientRect();
  const width = Math.min(preferredWidth, window.innerWidth - MOBILE_FLOATING_PANEL_PADDING * 2);
  const left = Math.max(
    MOBILE_FLOATING_PANEL_PADDING,
    Math.min(rect.right - width, window.innerWidth - width - MOBILE_FLOATING_PANEL_PADDING),
  );
  const top = Math.max(MOBILE_FLOATING_PANEL_PADDING, rect.bottom);
  const maxHeight = Math.max(160, window.innerHeight - top - MOBILE_FLOATING_PANEL_PADDING);
  return { top, left, width, maxHeight };
}
