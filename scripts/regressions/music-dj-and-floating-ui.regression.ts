import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const topBarUrl = new URL("../../packages/client/src/components/layout/TopBar.tsx", import.meta.url);
const appShellUrl = new URL("../../packages/client/src/components/layout/AppShell.tsx", import.meta.url);
const professorMariUrl = new URL(
  "../../packages/client/src/components/chat/HomeProfessorMariChat.tsx",
  import.meta.url,
);
const settingsUrl = new URL("../../packages/client/src/components/panels/SettingsPanel.tsx", import.meta.url);
const agentEditorUrl = new URL("../../packages/client/src/components/agents/AgentEditor.tsx", import.meta.url);
const globalsUrl = new URL("../../packages/client/src/styles/globals.css", import.meta.url);
const unavailablePlayerUrl = new URL(
  "../../packages/client/src/components/music/MusicDjUnavailablePlayer.tsx",
  import.meta.url,
);

const topBarSource = readFileSync(topBarUrl, "utf8");
const appShellSource = readFileSync(appShellUrl, "utf8");
const professorMariSource = readFileSync(professorMariUrl, "utf8");
const settingsSource = readFileSync(settingsUrl, "utf8");
const agentEditorSource = readFileSync(agentEditorUrl, "utf8");
const globalsSource = readFileSync(globalsUrl, "utf8");

assert.equal(existsSync(unavailablePlayerUrl), false, "Music DJ must not leave an absent-package player placeholder");
assert.doesNotMatch(topBarSource, /MusicDjUnavailablePlayer/u);
assert.doesNotMatch(appShellSource, /MusicDjUnavailablePlayer/u);
assert.match(
  agentEditorSource,
  /checked=\{musicDjInstalled && musicPlayerEnabled\}[\s\S]{0,500}disabled=\{!musicDjInstalled\}/u,
  "The Music Player switch must remain off and unavailable until Music DJ is installed",
);
assert.match(agentEditorSource, /id="settings-control-music-player"/u, "Search lands on the Music DJ player switch");
assert.doesNotMatch(settingsSource, /music-player|musicPlayerEnabled/u, "The Music Player switch left Settings");
const registrySource = readFileSync(
  new URL("../../packages/client/src/lib/settings-registry.ts", import.meta.url),
  "utf8",
);
assert.match(
  registrySource,
  /id: "music-player",[\s\S]{0,500}home: "music-dj"/u,
  "Search still finds the Music Player and jumps to the Music DJ agent",
);
const stateNavigationSource = readFileSync(
  new URL("../../packages/client/src/lib/state-navigation.ts", import.meta.url),
  "utf8",
);
assert.match(stateNavigationSource, /openAgentDetail\(MUSIC_DJ_AGENT_ID\)/u, "Installed: open the agent detail");
assert.match(stateNavigationSource, /openAgentCatalog\(MUSIC_DJ_AGENT_ID\)/u, "Not installed: open its catalog entry");

// Custom generation parameters are added where the sliders are (the shared editor), not in Settings.
const parametersEditorSource = readFileSync(
  new URL("../../packages/client/src/components/ui/GenerationParametersEditor.tsx", import.meta.url),
  "utf8",
);
assert.match(
  parametersEditorSource,
  /<CustomGenerationParametersSettings \/>/u,
  "The editor carries the Add parameter row",
);
assert.doesNotMatch(settingsSource, /CustomGenerationParametersSettings/u, "Custom parameters left Settings");
assert.match(
  registrySource,
  /id: "custom-generation-parameters",[\s\S]{0,600}home: "chat-parameters"/u,
  "Search still finds custom parameters and jumps to the chat's Advanced Parameters",
);
assert.match(
  stateNavigationSource,
  /requestChatSettingsSectionOpen\(chatId, "advanced-parameters"\)/u,
  "The search jump opens the chat's Advanced Parameters",
);
assert.match(
  stateNavigationSource,
  /openPresetDetail\(preset\.id, \{ initialTab: "parameters" \}\)/u,
  "With no chat to show the row, the search jump opens an editable preset's Parameters tab",
);
assert.match(
  stateNavigationSource,
  /confirmEditorLeave\([\s\S]{0,1500}openPresetDetail/u,
  "The preset fallback asks before leaving an editor with unsaved edits",
);
const customParametersSource = readFileSync(
  new URL(
    "../../packages/client/src/components/panels/settings/CustomGenerationParametersSettings.tsx",
    import.meta.url,
  ),
  "utf8",
);
assert.match(
  customParametersSource,
  /data-settings-anchor=\{ANCHOR\}/u,
  "The anchor is a data attribute because several editors can be mounted at once",
);
assert.doesNotMatch(customParametersSource, /\bid=\{ANCHOR/u, "The anchor must not be a duplicated DOM id");
assert.match(
  customParametersSource,
  /const canEdit = isSuccess;[\s\S]*disabled=\{!canEdit\b[\s\S]*disabled=\{!canEdit \|\| saveDefinitions\.isPending\}/u,
  "A failed load must not allow a save that overwrites every stored definition",
);

// 5bb03f918 replaced Professor Mari's floating window with the top-bar presence pill; she lives in
// the omnibar and Home only, so no floating follow-up or floating window may come back.
assert.doesNotMatch(
  appShellSource,
  /hasProfessorMariFloatingFollowup/u,
  "Professor Mari has no floating window to follow chats",
);
// Slice 82: the chat's parts live in components/chat/mari/, so "nowhere" reads all of them.
const professorMariPartsDir = new URL("../../packages/client/src/components/chat/mari/", import.meta.url);
const professorMariAllSource = [
  professorMariSource,
  ...readdirSync(professorMariPartsDir).map((name) => readFileSync(new URL(name, professorMariPartsDir), "utf8")),
].join("\n");
assert.doesNotMatch(
  professorMariAllSource,
  /floatingFollowupEligibleRef|rememberProfessorMariFloatingEnabled/u,
  "Professor Mari's chat must not track a floating window",
);
// Slice 82: globals.css imports Mari's and the omnibar's rules from their own files; check all of them.
const allGlobalStyles = [
  globalsSource,
  ...["mari.css", "omnibar.css", "omnibar-settings.css"].map((name) => readFileSync(new URL(name, globalsUrl), "utf8")),
].join("\n");
assert.doesNotMatch(
  allGlobalStyles,
  /\.mari-chrome-token-scope\s*\{[^}]*--primary:/u,
  "The shared chat-chroma scope must not replace the configured app accent",
);

assert.match(
  topBarSource,
  /!mobileTopbarNavigation && "mari-topbar-chat-gradient-icon"/u,
  "Mobile Chats must not apply the desktop gradient to the icon",
);
assert.match(
  topBarSource,
  /!mobileTopbarNavigation && "mari-topbar-chat-gradient-hover"/u,
  "Mobile Chats must not retain a sticky gradient hover class",
);
assert.match(
  topBarSource,
  /mari-topbar-chat-gradient-underline/u,
  "The active Chats underline must retain its gradient",
);
assert.match(topBarSource, /<Menu size=\{15\}/u, "The mobile overflow control must use a menu icon");
assert.match(topBarSource, /"ml-auto sm:hidden"/u, "The mobile overflow control must stay at the right edge");
assert.match(
  globalsSource,
  /@media \(max-width: 639px\) \{\s*\.mari-topbar \{[^}]*\}\s*\.mari-topbar-action \{\s*flex: 0 0 auto;\s*width: 3\.5rem !important;\s*(?:\/\*[^*]*\*\/\s*)?height: 2\.6rem !important;/u,
  "Phone top-bar controls must keep fixed desktop-style sizes instead of filling the row",
);

// The Tracker look controls live in the Tracker panel's header menu; a search for one only navigates.
const trackerHeaderSource = readFileSync(
  new URL("../../packages/client/src/features/tracker-panel/components/TrackerSidebarHeader.tsx", import.meta.url),
  "utf8",
);
const trackerShowStart = stateNavigationSource.indexOf("function showTrackerLookMenu");
const trackerJumpEnd = stateNavigationSource.indexOf("export function openSettingsControlHome");
assert.ok(trackerShowStart >= 0 && trackerJumpEnd > trackerShowStart, "The Tracker jump functions must exist");
const trackerJumpSource = stateNavigationSource.slice(trackerShowStart, trackerJumpEnd);
assert.equal(
  trackerJumpSource.match(/setTrackerPanelEnabled/gu)?.length,
  1,
  "A search must not change the saved Tracker switch; only the toast action may turn it on",
);
assert.match(
  trackerJumpSource,
  /onClick: \(\) => \{\s*useUIStore\.getState\(\)\.setTrackerPanelEnabled\(true\);/u,
  "Turning the Tracker panel on needs the person's explicit action",
);
assert.match(
  trackerJumpSource,
  /confirmEditorLeave\([\s\S]*?\)\) return;\s*ui\.closeAllDetails\(\);/u,
  "The Tracker jump must ask before leaving an editor, then close the details covering the panel",
);
assert.match(
  trackerJumpSource,
  /closeRightPanel\(\);\s*requestAnimationFrame\(showMenu\)/u,
  "On the phone shell the right panel closes and the menu opens on the next frame",
);
assert.match(
  trackerJumpSource,
  /scrollToSettingsAnchor\(controlId, \(\) => useUIStore\.getState\(\)\.consumeTrackerLookMenuRequest\(\)\)/u,
  "A request nobody picked up must be cleared",
);
// The docked panel can be 96 px wide and its header row does not wrap, so a fourth header button pushes
// "Show help" out of the panel: Panel settings lives in the gear toolbar instead.
assert.match(
  trackerHeaderSource,
  /TRACKER_TOOLBAR_ITEM_ORDER = \[[^\]]*"look"/u,
  "The Panel settings button is a gear toolbar item, not a fourth header button",
);
assert.match(
  trackerHeaderSource,
  /aria-label=\{localizeUi\("ui\.trackerPanel\.lookMenu\.panelSettings"\)\}\s*aria-expanded=\{lookOpen\}/u,
  "The Panel settings button needs a name and its expanded state",
);

console.info("Music DJ availability and floating UI regressions passed.");
