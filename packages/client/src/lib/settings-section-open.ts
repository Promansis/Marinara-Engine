/** Fired on a collapsed `SettingsSection` element to ask it to open (see `revealSettingsSection`). */
export const SETTINGS_SECTION_OPEN_EVENT = "marinara:settings-section-open";

/**
 * Open every collapsed Settings section around `target` (or `target` itself when it is the section), so a jump that
 * scrolls and focuses finds its control on screen.
 */
export function revealSettingsSection(target: Element | null): void {
  const selector = '[data-settings-section][data-collapsed="true"]';
  for (let section = target?.closest(selector); section; section = section.parentElement?.closest(selector)) {
    section.dispatchEvent(new Event(SETTINGS_SECTION_OPEN_EVENT));
  }
}
