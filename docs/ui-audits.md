Repeated Pattern Matrix

This matrix groups the audits below by repeated UI problem, using docs/ui-source-map.md for the surface boundaries. It is intentionally not one row per button.

| Workstream | Repeated problem | Surfaces affected | Can fix now | Needs product decision | Shared helper/component | First PR candidate | Proof needed |
|---|---|---|---|---|---|---|---|
| A11y semantics | Icon-only controls rely on title/visual state instead of accessible names, expanded state, or active state | Shell nav, chat settings, conversation, roleplay, game rail, Professor Mari, tracker, catalog editors | Yes | No | ToolbarButton/IconButton wrapper, Section header pattern | Add aria-label, aria-expanded, aria-controls, and active labels to existing repeated icon/section controls | pnpm check:docs plus DOM or browser keyboard pass on shell, settings, roleplay, tracker |
| A11y semantics | Clickable div/list rows are not consistently native keyboard controls | Home quick-start cards, left chat list rows, recent chats, folder/action rows | Yes | Mostly no | ActionRow/ButtonCard pattern | Convert Home QuickStartCard and primary chat row action to real buttons or full Enter/Space activation | Keyboard-only pass through Home and chat list |
| Modal/sheet behavior | Overlays use inconsistent dialog semantics, close naming, focus behavior, and Escape handling | Chat settings drawer, delete flow, prompt peek, gallery delete, setup wizard, tracker/right panels | Partly | Some for backdrop-close behavior | Existing Modal, AppDialogRenderer, app-dialogs, proposed Sheet wrapper | Normalize shared chat delete/prompt/settings overlays onto dialog semantics and labeled close controls | Browser keyboard/focus pass: open, tab, Escape, close, focus return |
| Risky actions | Destructive or high-consequence flows use vague copy, weak confirmation, or one-click removal | Delete more, tracker row/object deletes, combat Previous Turn, preset section/source delete, knowledge file delete, tutorial reset, End Session | Partly | Yes for undo vs confirm policy | Confirmation modal, destructive action copy helper, undo toast | Rename delete-more to range selection, add bulk delete confirmation, and replace combat Previous Turn wording/modal | Manual delete-flow pass with selected range count and expected deleted message |
| Toolbar overload | Too many peer icon buttons compete with the primary task | Shell titlebar/tools, conversation header, roleplay toolbar, game action rail, tracker header, preset row, lorebook entries | Partly | Yes | Overflow/menu pattern, grouped toolbar sections | Pilot one surface: conversation or roleplay header as Chat tools/Context/Manage groups | Desktop and mobile browser pass proving core actions remain within two clicks |
| Compact/mobile hierarchy | Compact layouts hide labels or change hierarchy instead of simplifying the task | Mobile tools menu, roleplay compact toolbar, game mobile action rail/retry menu, tracker widths, Professor Mari narrow input, settings drawer | Partly | Yes for mobile IA | Labeled overflow menu, responsive toolbar/menu primitive | Make one compact menu render labeled rows with grouped sections and destructive separation | 320px and desktop browser pass, no overlap, labels visible without hover |
| Primary path clarity | Compose/start/edit surfaces mix setup, context, insert, generation, save, and launch actions at the same decision point | Conversation composer, Professor Mari input, Home, game start flow, catalog detail editors, chat settings drawer | Partly | Yes | Context selector, primary-action group, editor action bar | Add visible model/context readiness near Mari/conversation inputs and demote secondary input tools | First-run and returning-user pass: user can identify the primary next action |
| Vocabulary/copy | Same words mean different things, or labels hide consequences | Connection vs Connected Chat, Browser, Encounter, Start Game, Retry, Quick Persona Switcher, Delete more, Previous Turn, Force Interrupt | Yes for labels | Some for concepts that need ownership | Terminology map, button copy constants | Rename low-risk labels: Browser -> Character Browser, Encounter -> Start Combat, Start Game phase labels | Copy review plus smoke pass that routes/actions still match labels |
| Advanced controls | Expert/debug/automation controls are exposed as equal-weight routine actions | Chat settings agents/tools/memory, conversation message actions, game retry/recovery, tracker rerun/auto-avatar, catalog bulk tools | Partly | Yes | More menu, advanced section/tabs, consequence tooltip | Move secondary conversation message actions into More and separate delete | Desktop/mobile pass, especially touch access for message actions |
| Persistence and saved-state clarity | Users cannot tell what is saved, sent, skipped, linked, or mutated | Catalog editors, PresetEditor, Professor Mari attachments, setup wizard close, model connection requirement, tracker rerun | Partly | Yes | Dirty-state banner, sent attachment summary, save-scope copy, mode strip | Add visible sent attachment summary in Mari and save-scope copy to PresetEditor | Manual pass with attachments and preset edits; confirm transcript/save state is visible |
| Navigation/state recovery | Navigation and loading states can hide consequences or feel blank/stale | Home/Mari shell actions, desktop vs mobile nav, ModeSurface loading/missing chat, active right panel, dirty editor exits | Partly | Yes | Route loading fallback, unsaved-change guard, shell navigation helper | Add neutral "Opening chat..." fallback and align dirty-editor guard for Home/Mari paths | Route-switch smoke pass and dirty-editor navigation pass |
| Selection/bulk actions | Selection mode mixes range helpers, destructive commit, and secondary actions in one floating bar | Shared chat multiselect, lorebook entries selection, catalog bulk copy/move/delete patterns | Partly | Some | SelectionBar/SelectionMenu pattern | Simplify shared chat multi-select: primary Delete N/Cancel, range helpers in Selection menu | Manual mobile and keyboard pass for select range, cancel, delete confirmation |

Used skills/marinara-agent-workflow/references/workflows/ui-audit.md and audited the current ChatSettingsDrawer.tsx statically. No code changes made; no browser/screenshot validation run.

  Surface Map

  ┌─────────────────────────────┬───────────────────────────────┬──────────────────────────────────────────────────────────────┐
  │ Surface                     │ User Goal                     │ Main Risk                                                    │
  ├─────────────────────────────┼───────────────────────────────┼──────────────────────────────────────────────────────────────┤
  │ Chat settings drawer        │ Tune one chat safely          │ Too many unrelated decisions in one narrow panel             │
  │ Preset bar                  │ Reuse or manage chat settings │ Icon-only actions, destructive action beside routine actions │
  │ Collapsible sections        │ Find the right setting        │ All sections start collapsed, no semantic expanded state     │
  │ Agents/tools/memory         │ Enable advanced behavior      │ Advanced systems exposed as equal-weight settings            │
  │ Connected chat/conversation │ Link chats                    │ Similar wording to AI provider “Connection”                  │
  └─────────────────────────────┴───────────────────────────────┴──────────────────────────────────────────────────────────────┘

  Top Findings

  1. Preset management is overloaded at the top of the drawer
     In src/features/modes/shared/chat-ui/components/ChatSettingsDrawer.tsx:1638, the preset bar exposes save, rename, save-as, import, export, and delete as icon-only controls, plus default-star/help nearby. This
     exceeds the workflow’s “more than four visible choices” threshold and places destructive/export actions beside routine saves.
     Recommendation: keep preset selection and “default” visible; move rename/import/export/delete into a labeled “Manage presets” disclosure or menu. Add visible text or aria-labels for every icon action.
  2. Drawer lacks dialog/sheet semantics
     The drawer/backdrop at src/features/modes/shared/chat-ui/components/ChatSettingsDrawer.tsx:1549 renders as plain divs, and the close button at line 1556 has no accessible name. I also found no role="dialog",
     aria-modal, labelled heading, focus trap, or Escape handling in this component.
     Recommendation: use the shared modal/sheet primitive if one exists, or add dialog semantics, focus management, Escape close, and aria-label="Close chat settings".
  3. “Connection” and “Connected Chat/Conversation” create avoidable vocabulary collision
     AI provider/model selection is labeled “Connection” at src/features/modes/shared/chat-ui/components/ChatSettingsDrawer.tsx:1740, while chat linking uses “Connected Chat” and “Connected Conversation” around src/
     features/modes/shared/chat-ui/components/ChatSettingsDrawer.tsx:3243. These are different mental models but nearly the same word.
     Recommendation: rename provider/model to “AI Model” or “Generation Provider”; rename chat linking consistently to “Linked Chat” or “OOC Link”.
  4. Advanced behavior is too flat
     Agents, Function Calling, Memory Recall, Translation, Context Limit, Discord Mirror, and Impersonate are all peers in one long settings list, for example src/features/modes/shared/chat-ui/components/
     ChatSettingsDrawer.tsx:3606, src/features/modes/shared/chat-ui/components/ChatSettingsDrawer.tsx:4881, and src/features/modes/shared/chat-ui/components/ChatSettingsDrawer.tsx:5062.
     Recommendation: group into “Basics”, “Participants”, “Prompt & Context”, “Automation”, and “Integrations”, or add section tabs. Keep risky actions explicit inside their groups.
  5. Collapsible sections hide state without ARIA
     The reusable Section starts closed and only visually rotates a chevron at src/features/modes/shared/chat-ui/components/ChatSettingsDrawer.tsx:6221. It does not expose aria-expanded or aria-controls.
     Recommendation: add semantic expanded state, stable IDs, and consider default-opening the most relevant section based on mode or recent entry point.

  Can Fix Now

  Add ARIA labels/states, rename “Connection”, label or regroup preset actions, make close accessible, and add aria-expanded to Section and AgentCategorySection.

  Needs Product Decision

  Whether this remains one all-purpose drawer or becomes grouped/tabs per mode. The current file is carrying several workflows at once, and the best simplification depends on whether “settings” is meant to be quick
  chat setup or an expert configuration console.
	
	
	
	----------------------
	
	
	• Used skills/marinara-agent-workflow/references/workflows/ui-audit.md on src/features/modes/roleplay/components/ChatRoleplaySurface.tsx:600. No code changes made.

  Scope
  User goal: continue or manage a roleplay chat without losing scene context.
  Primary path: read transcript -> choose/compose reply -> send/trigger response.
  Likely state: returning user in an active chat, possibly with agents, sprites, scene, combat, files, gallery, and summaries enabled.
  Owner files reviewed: main surface, plus child controls where placement/labeling affects this surface.

  Top Findings

  1. Toolbar has too many peer actions before the primary chat path
     The roleplay header can expose branch selector, summary, world info, author notes, files, sprite arrange, sprite side, gallery, connected chat, and settings as equal-weight controls near the top of the chat
     src/features/modes/roleplay/components/ChatRoleplaySurface.tsx:816. This exceeds the workflow’s “more than four visible choices” threshold and makes routine roleplay compete with setup/management actions.
     Can fix now: group into two menus: Context for summary/world/notes, and Manage for files/gallery/settings/sprites. Keep branch switch visible only when branch state exists.
     Proof needed: desktop and compact/mobile pass with agents UI on/off.
  2. Icon-only controls rely mostly on title, so discoverability/accessibility is thin
     RpToolbarButton only sets title, not aria-label src/features/modes/roleplay/components/ChatRoleplaySurface.tsx:262. SummaryButton and AuthorNotesButton follow the same pattern src/features/modes/roleplay/
     components/ChatRoleplaySurface.tsx:379, src/features/modes/roleplay/components/ChatRoleplaySurface.tsx:440. Keyboard/screen-reader users get weaker naming than ActiveWorldInfoButton, which does include aria-
     label.
     Can fix now: add aria-label={title} to RpToolbarButton, SummaryButton, AuthorNotesButton, and ToolbarMenu.
  3. Compact overflow menu preserves clutter instead of simplifying it
     The compact menu becomes a narrow w-9 vertical icon column src/features/modes/roleplay/components/ChatRoleplaySurface.tsx:335. That hides labels but keeps the same mental model burden. It also makes
     heterogeneous actions like branch switching, summary, files, gallery, settings, and sprite controls feel equivalent.
     Can fix now: render a labeled menu list in compact mode, with separators or headings for Context, Visuals, and Manage.
  4. “Encounter” is vague and competes with the composer
     The combat entry point sits directly above ChatInput with label Encounter while its title says Start Combat Encounter src/features/modes/roleplay/components/ChatRoleplaySurface.tsx:1153. It is a major mode
     shift but styled as a quiet secondary chip.
     Can fix now: rename visible label to Start Combat and add disabled/loading/consequence state if combat setup can be unavailable.
     Needs product decision: whether combat should be a persistent scene action or live inside an agents/actions HUD.

  Compact Inventory

  ┌─────────────────────────────────────┬───────────────────┬────────┬────────────────────────────────────────────────────────────────┐
  │ Control                             │ Current Placement │   Risk │ Recommendation                                                 │
  ├─────────────────────────────────────┼───────────────────┼────────┼────────────────────────────────────────────────────────────────┤
  │ Branch selector                     │ Top toolbar       │ Medium │ Visible only when useful; otherwise move to Manage             │
  │ Summary / World Info / Author Notes │ Top toolbar       │ Medium │ Group as Context                                               │
  │ Files / Gallery / Settings          │ Top toolbar       │ Medium │ Group as Manage                                                │
  │ Sprite arrange / side               │ Top toolbar       │ Medium │ Group as Visuals; show active state clearly                    │
  │ Connected chat switch               │ Top toolbar       │ Medium │ Rename/title as explicit destination, keep visible when linked │
  │ Load More                           │ Transcript top    │    Low │ Fine; label could be Load earlier messages                     │
  │ Encounter                           │ Above composer    │ Medium │ Rename to Start Combat; clarify consequence                    │
  │ End Scene / Discard / Convert       │ Scene bar child   │ Medium │ Already explicit; verify hierarchy in scene state              │
  └─────────────────────────────────────┴───────────────────┴────────┴────────────────────────────────────────────────────────────────┘

  Verification
  Static code audit only. I did not run browser checks, screenshots, or tests, matching the workflow’s “no screenshots/durable notes unless requested” guidance.



-----------------------


Read-only UI audit done against ui-audit.md. No files edited, no browser pass run.

  Top Findings

  1. Home / Professor Mari can silently discard dirty editor work.
     src/app/shell/TopBar.tsx:66, src/app/shell/WindowTitleBar.tsx:118, and src/app/shell/ChatTitleControls.tsx:33 call closeAllDetails(), which clears editorDirty in src/shared/stores/ui.store.ts:363. Chat
     selection already guards this with an unsaved-changes confirm in src/app/shell/ChatSidebar.tsx:583.
     Can fix now: route shell navigation through the same discard-confirm helper.
  2. Mobile panel behavior is split across controls instead of one clear shell contract.
     src/app/shell/AppShell.tsx:662 prioritizes right > tracker > sidebar, while src/app/shell/TopBar.tsx:59 manually closes some panels before opening others. Other callers of openRightPanel() do not share
     that policy.
     Can fix now: centralize “open one mobile panel” behavior in store/shell helpers, then make TopBar call that.
  3. Panel navigation is too dense for a primary decision point.
     src/app/shell/PanelNavButtons.tsx:7 exposes eight icon-only destinations in the titlebar. Mobile hides the same set under “Tools” in src/app/shell/TopBar.tsx:149, producing different hierarchy and
     behavior.
     Needs product decision: keep direct access, or group into fewer visible choices such as Library, Setup, Browser, Settings.
  4. “Browser” is ambiguous.
     The panel nav “Browser” opens BotBrowserPanel in the right panel, while that panel can open full BotBrowserView via openBotBrowser() in src/features/shell/bot-browser/components/BotBrowserPanel.tsx:86.
     Can fix now: rename the panel entry to “Character Browser” or “Browse Characters”.
  5. Agent failure state is only a dot.
     src/app/shell/PanelNavButtons.tsx:64 shows an amber dot for failed agents, but there is no count, label, or accessible explanation.
     Can fix now: update title/aria-label to include the failed count, and consider a tiny count badge.

  Compact Inventory

  ┌──────────────────────────────────┬────────────────────────────────────────┬─────────────────────────────────────┐
  │ Surface                          │ Main Controls                          │ Main Risk                           │
  ├──────────────────────────────────┼────────────────────────────────────────┼─────────────────────────────────────┤
  │ AppShell.tsx                     │ panels, overlays, focus trap, resizers │ mobile panel state split            │
  │ TopBar.tsx                       │ chats, home, Mari, tools menu          │ hidden side effects, vague grouping │
  │ PanelNavButtons.tsx              │ 8 right-panel icons                    │ too many icon-only choices          │
  │ WindowTitleBar/ChatTitleControls │ desktop home/Mari/sidebar              │ unsaved-change bypass               │
  └──────────────────────────────────┴────────────────────────────────────────┴─────────────────────────────────────┘

  Verification
  Code-read audit only with rg. Remaining proof needed: mobile viewport/manual browser pass for overlay stacking, focus return, active states, and dirty-editor navigation.
	
	---------------------------------
	  Scope
  Surface: Conversation mode. User goal: read/respond naturally, manage chat context only when needed. Primary path starts at src/features/modes/conversation/components/ConversationModeRoute.tsx:111, flows through
  src/features/modes/conversation/components/ChatConversationSurface.tsx:147, then ConversationView, ConversationMessage, ConversationInput, and shared overlays.

  Top Findings

  1. Header has too many equivalent icon-only destinations for a routine chat surface.
     src/features/modes/conversation/components/ConversationView.tsx:410 exposes branch switcher, world info, files, gallery, connected-chat switch, and settings in one cluster. That is 5-6 visible choices before
     the user reaches the composer, mostly icon-only. Simplify by keeping branch/chat switch plus one overflow/tools button visible, moving Files/Gallery/World Info/Settings into a named “Chat tools” menu on desktop
     and mobile. Proof needed: quick usability check that users can still find files/gallery/settings within two clicks.
  2. Message hover actions overload a single bubble with advanced and risky actions.
     src/features/modes/conversation/components/ConversationMessage.tsx:1184 can show Copy, Translate, Edit, Regenerate, Peek prompt, Hide from AI, Stored guidance, View thoughts, Delete. That is up to 9 actions,
     including destructive and advanced debugging controls. Keep Copy/Edit/Regenerate/Delete visible, move Translate/Peek/Hidden/Guidance/Thoughts into “More message actions.” Delete should remain visually separated
     at the far end. Proof needed: check mobile/touch access because hover-only discoverability is already fragile.
  3. Composer action row is powerful but visually under-explained.
     src/features/modes/conversation/components/ConversationInput.tsx:1499 through src/features/modes/conversation/components/ConversationInput.tsx:1786 includes attach, connection/persona switching, GIF, emoji,
     trigger character response, translate draft, speech, saved statuses, quick replies, and send/stop/retry. The primary job, “write and send,” competes with mode-specific extras. Simplify by grouping extras into
     three stable zones: identity/context left, content insertions near textarea, send/generation right. Hide saved statuses and draft translate behind the quick-reply/tools menu unless active/relevant.
  4. Delete dialog copy is vague for a destructive decision.
     src/features/modes/shared/chat-ui/components/ChatCommonOverlays.tsx:70 asks “How to proceed?” then offers “Delete only this swipe,” “Delete this message,” and “Delete more.” Rename title to “Delete message?”
     and change “Delete more” to “Select messages to delete.” This preserves behavior but makes consequence and mode switch clearer.
  5. Multi-select bar has unclear directional batch actions.
     src/features/modes/shared/chat-ui/components/ChatCommonOverlays.tsx:126 shows Delete selected, Cancel, up/down icon buttons, and Unselect all. The up/down buttons have accessible labels but no visible names.
     Add compact visible labels or put them in a “Select range” menu. This is a can-fix-now clarity change.

  Compact Inventory

  ┌────────────────┬────────────────────────────┬───────────────────────────────────┬───────────────────────────────────────┐
  │ Decision Point │            Visible Actions │ Risk                              │ Recommendation                        │
  ├────────────────┼────────────────────────────┼───────────────────────────────────┼───────────────────────────────────────┤
  │ Header toolbar │                        5-6 │ choice overload, icon ambiguity   │ regroup into Chat tools               │
  │ Message bubble │                    up to 9 │ advanced/risky mixed with routine │ visible core + More menu              │
  │ Composer       │                       8-10 │ primary send path diluted         │ stable zones + progressive disclosure │
  │ Delete dialog  │ 3 destructive/mode actions │ vague consequence                 │ clearer title/labels                  │
  │ Scene bar      │                        3-4 │ acceptable but consequence-heavy  │ keep explicit confirmations           │
  └────────────────┴────────────────────────────┴───────────────────────────────────┴───────────────────────────────────────┘

  Can Fix Now
  Rename/delete-dialog labels, add visible labels or menu for multi-select range actions, add missing aria-labels to icon-only header buttons that only have title, and regroup message secondary actions.

  Needs Product Decision
  Whether Conversation mode should treat Files/Gallery/World Info/Settings as always-primary header tools, or as contextual chat tools behind one menu. That changes the surface hierarchy, not the underlying
  behavior.

  No code changes or tests run; this was a repository-grounded UI audit using rg only.
	
	-------------------------------------------------
	• Used ui-audit.md; did not use impeccable. No repo changes made.
	
	Soruce: Desktop/mobile nav

  Top Findings

  1. Desktop primary nav is overloaded: the title bar exposes Home, Chats, Professor Mari, 8 panel buttons, Spotify, and window controls in one strip. This exceeds the workflow’s “more than four visible action
     choices” check and makes the panel icons rely heavily on memory. Owner: src/app/shell/PanelNavButtons.tsx:7, src/app/shell/WindowTitleBar.tsx:166. Proposed simplification: keep primary surface controls visible,
     move lower-frequency catalog/settings panels into a grouped overflow or “Library/Tools” menu. Needs product decision.
  2. Home/Professor Mari have different consequences on desktop vs mobile. Mobile closes sidebar/right panel/tracker before navigating, but desktop Home only clears chat/detail state, leaving the right panel open,
     which can prevent Home from appearing current because rightPanelOpen is part of hasOpenSurface. Owner: src/app/shell/WindowTitleBar.tsx:118, src/app/shell/TopBar.tsx:66. Proposed simplification: decide whether
     “Home” means center route only or full shell reset, then align desktop/mobile state cleanup. Needs product decision.
  3. Professor Mari disappears on very narrow mobile with no visible fallback in Tools. The mobile button uses max-[360px]:hidden, while the Tools menu only lists right-panel tools. Owner: src/app/shell/
     TopBar.tsx:120. Proposed simplification: include Professor Mari in Tools below 360px or keep a compact icon-only affordance. Can fix now.
  4. Agent failure badge is visual-only and desktop-only. The amber dot does not change the accessible name, count, or mobile Tools entry. Owner: src/app/shell/PanelNavButtons.tsx:64, src/app/shell/TopBar.tsx:169.
     Proposed simplification: expose “Agents, N failed” in aria-label/title and mirror the indicator in mobile Tools. Can fix now.
  5. Mobile Tools uses menu semantics without menu keyboard behavior. It declares role="menu" / role="menuitem" but does not implement arrow-key navigation or initial focus behavior. Owner: src/app/shell/
     TopBar.tsx:143. Proposed simplification: either implement menu keyboard interaction or downgrade semantics to a labeled nav/list of buttons. Can fix now.

  Compact Inventory

  ┌───────────────────┬──────────────────────────────────────────────────────────────────────────────────┬───────────────────────────────────────────┐
  │ Surface           │ Main Controls                                                                    │ Risk                                      │
  ├───────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────┤
  │ Desktop title bar │ Chats, Home, Professor Mari, 8 right-panel icons, Spotify, window controls       │ High choice count, icon memory load       │
  │ Mobile top bar    │ Chats, Home, Professor Mari, Tools                                               │ Narrow-width hidden Mari, Tools semantics │
  │ Mobile Tools      │ Browser, Characters, Lorebooks, Presets, Connections, Agents, Personas, Settings │ Active/failure state parity gaps          │
  └───────────────────┴──────────────────────────────────────────────────────────────────────────────────┴───────────────────────────────────────────┘

  Verification
  Audit only. I inspected the requested workflow and source/CSS/store context with rg; no tests, browser checks, or screenshots were run.
	
	--------------------------------------------
	
	• Used ui-audit.md directly and did not use impeccable.

  Scope
  Surface: Game mode.
  User goal: set up a game, start play, read GM output, act, recover from generation issues, and manage session/game state.
  Owner files: src/features/modes/game/components/GameModeRoute.tsx:18, src/features/modes/game/components/GameSurface.tsx:1599. Route mostly delegates state and overlays into GameSurface.

  Top Findings

  1. The top action rail exposes too many icon-only choices at once.
     Desktop shows roughly 10 controls, and mobile hides nearly all of them in one narrow icon-only menu: Tutorial, History, Checkpoints, Active World Info, End/New Session, Journal, Volume, Gallery, Game
     Assets, Retry, Settings. This exceeds the workflow’s “more than four visible choices” threshold and mixes routine, recovery, settings, and destructive actions.
     Owner: src/features/modes/game/components/GameSurface.tsx:7539, src/features/modes/game/components/GameSurface.tsx:7704.
     Simplification: group into Campaign, Media, Turn tools, and keep End Session visually separated. Add visible labels in the mobile menu.
     Proof needed: mobile/desktop usability pass where a user identifies each icon without hover.
  2. Recovery actions are vague and easy to misfire.
     Retry... expands into Retry Turn, Retry Scene Analysis, Retry Spotify DJ Music Generation, and Retry Assets Image Generation; start flow also has generic Retry, Retry Scene Analysis, and Skip. These are
     different consequences but share similar labels.
     Owner: src/features/modes/game/components/GameSurface.tsx:7430, src/features/modes/game/components/GameSurface.tsx:7635.
     Simplification: rename to consequence-first labels: Regenerate last GM turn, Retry scene effects, Regenerate music, Regenerate images; show failed recovery inline where the failure appears.
     Proof needed: confirm which retry actions preserve/delete existing turn content.
  3. Combat “Previous Turn” is destructive but reads like navigation.
     It exits combat, clears combat state, transitions to exploration, clears the snapshot, and deletes the latest assistant message. The label Previous Turn undersells that.
     Owner: src/features/modes/game/components/GameSurface.tsx:6780, src/features/modes/game/components/GameSurface.tsx:8107.
     Simplification: rename to Undo combat start or Exit combat and delete turn; use the app modal pattern instead of window.confirm.
     Proof needed: verify exact message deleted in multi-message combat setup.
  4. Interrupt confirmation labels do not match consequence.
     Modal choices are No, Force Interrupt, and Yes. Yes is actually risky in-fiction interruption; Force Interrupt silently truncates context. The labels ask users to understand implementation behavior during
     a tense moment.
     Owner: src/features/modes/game/components/GameSurface.tsx:8618, src/features/modes/game/components/GameSurface.tsx:6594.
     Simplification: Keep listening, Interrupt cleanly, Try risky interrupt. Put the consequence in the button subtitle or modal body.
     Proof needed: confirm whether force interrupt should remain available as a normal user-facing action.
  5. “Start Game” means two different things.
     In setup, Start Game generates the world; on the next screen, Start Game begins the first turn; then Continue enters play.
     Owner: src/features/modes/game/components/GameSetupWizard.tsx:1697, src/features/modes/game/components/GameSurface.tsx:7373.
     Simplification: use Generate World, Begin First Scene, then Enter Game.
     Proof needed: none beyond copy review.

  Compact Inventory

  ┌──────────────────────┬─────────────────────────────────────────┬─────────────────────────────────────────┐
  │ Control area         │ Risk                                    │ Recommendation                          │
  ├──────────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────┤
  │ Top action rail      │ Too many icon-only choices              │ Regroup and label mobile menu           │
  │ Retry menu           │ Similar labels, different consequences  │ Rename by outcome                       │
  │ End Session          │ Destructive action among routine icons  │ Separate/destructive styling            │
  │ Combat Previous Turn │ Deletes content but sounds navigational │ Rename and use explicit modal           │
  │ Interrupt modal      │ Ambiguous Yes/No                        │ Consequence-first labels                │
  │ Start flow           │ Duplicate Start Game meaning            │ Rename each phase                       │
  │ Map destination      │ Set destination stages, send commits    │ Clarify staged travel                   │
  │ Mobile icons         │ Mostly title, few aria-labels           │ Add accessible names and visible labels │
  └──────────────────────┴─────────────────────────────────────────┴─────────────────────────────────────────┘

  Can Fix Now
  Copy/label changes, mobile menu labels, aria-labels, regrouping retry labels, replacing Previous Turn label, and start-flow wording.

  Needs Product Decision
  Whether Force Interrupt should remain exposed, how destructive End Session should be positioned, and whether game recovery tools should be expert-only or always visible.

  No code changes or runtime/browser verification were performed; this was a repository UI audit only.
	
	-------------------------------------------------------
	Scope
  Surface: Main route switch
	• Used ui-audit.md directly and did not use impeccable.

  Top Findings

  1. Blank loading states make chat switching feel broken.
     src/features/modes/router/components/ModeSurface.tsx:37 uses an empty div fallback, and src/features/modes/game/components/GameModeRoute.tsx:47 also returns an empty surface while chat data is missing.
     Proposed simplification: show a small mode-neutral “Opening chat...” shell fallback, matching AppShell’s loading pattern.
  2. Previous mode can briefly route the new chat.
     lastModeRef in src/features/modes/router/components/ModeSurface.tsx:26 lets the prior chat mode decide the route until the newly selected chat loads. Switching Game → Conversation could briefly mount the
     game route for a conversation chat id. Proposed simplification: when activeChatId changes and chat?.mode is not loaded, render the neutral loading state instead of reusing the last mode.
  3. Missing chats silently dump the user home.
     A 404 clears activeChatId in src/features/modes/router/components/ModeSurface.tsx:28 without visible explanation. Proposed simplification: keep the reset, but add a toast or home-surface banner like “That
     chat no longer exists.”
  4. visual_novel labeling is inconsistent.
     src/features/modes/router/components/ModeSurface.tsx:46 routes visual_novel through roleplay, while src/features/modes/router/components/RecentChats.tsx:23 labels it “Game”; the sidebar labels it “Visual
     Novel.” Proposed simplification: label it “Visual Novel” everywhere, or make a product decision to fold/deprecate it.

  Can Fix Now

  - Replace empty fallbacks with visible loading.
  - Stop using stale lastModeRef across chat ids.
  - Add a user-visible 404 recovery message.
  - Rename the recent-chat visual_novel badge if Visual Novel remains a distinct mode.

  Needs Product Decision

  - Whether visual_novel is a supported fourth mode, a roleplay presentation variant, or an obsolete/coming-soon path.

  No code changes, tests, browser checks, or screenshots were run for this audit.
	-------
	
	Scope
  Surface: Home surface
	Used skills\marinara-agent-workflow\references\workflows\ui-audit.md only. No impeccable.

  Top Findings

  1. Primary quick-start cards are clickable divs, not buttons.
     Owner: src/features/modes/router/components/ModeHomeSurface.tsx:233
     Why it matters: the Home surface’s main actions are not keyboard-native and do not expose button semantics. This is high impact because Conversation, Roleplay, and Game are the primary path.
     Simplification: make QuickStartCard render a real button type="button" with focus styling, disabled/pending handling, and an accessible name matching the visible label.
     Proof needed: keyboard-only pass through Home surface.
  2. Mode cards describe categories, but perform “create new chat now.”
     Owner: src/features/modes/router/components/ModeHomeSurface.tsx:84
     Why it matters: clicking Conversation, Roleplay, or Game immediately creates a chat when a connection exists, then opens settings/wizard; when no connection exists, it opens setup instead. Same visible
     control, two different consequences.
     Simplification: rename cards to New conversation, New roleplay, New game, and add small state text near the group such as selected/default connection or “Connection required”.
     Proof needed: first-run and returning-user click-through.
  3. Home surface has too many competing action clusters for a start screen.
     Owner: src/features/modes/router/components/ModeHomeSurface.tsx:83, src/features/modes/router/components/RecentChats.tsx:61, src/features/modes/router/components/HomeFaq.tsx:400
     Why it matters: the user is asked to start a chat, reopen a recent chat, expand FAQ, visit Discord, support, replay tutorial, and follow attribution links from one compact surface.
     Simplification: keep New chat and Recent chats dominant; demote FAQ/support/tutorial/credits into a quieter help/footer area.
     Proof needed: visual review at mobile and desktop sizes.
  4. Recent chats are compact but under-labeled.
     Owner: src/features/modes/router/components/RecentChats.tsx:103
     Why it matters: each chip only shows a truncated chat name; mode is only a tiny dot/title. Users with similar branch names may not know what will open.
     Simplification: add aria-label={"Open recent chat: ..."}; and consider a second micro-line or tooltip with mode/character.
     Proof needed: screen reader/name inspection plus real data with long names.

  Compact Inventory

  ┌──────────────────────────────────────┬─────────────────────────────────────┬────────┬────────────────────────────────────────────────────────────┐
  │ Control                              │ Result                              │ Risk   │ Recommendation                                             │
  ├──────────────────────────────────────┼─────────────────────────────────────┼────────┼────────────────────────────────────────────────────────────┤
  │ Conversation / Roleplay / Game cards │ Create chat or open connection gate │ High   │ Rename to explicit New ...; render as buttons              │
  │ Recent chat chips                    │ Opens chat                          │ Medium │ Add accessible labels and clearer mode/character context   │
  │ Professor Mari's FAQ                 │ Expands help panel                  │ Medium │ Keep collapsed; consider moving below primary/recent paths │
  │ FAQ question rows                    │ Toggle answers                      │ Low    │ OK, but add aria-controls if polishing                     │
  │ Discord, Support, credits links      │ External navigation                 │ Low    │ Keep in footer/help area                                   │
  │ Replay Tutorial                      │ Resets onboarding completion        │ Medium │ Move under Help or confirm/relabel as Restart tutorial     │
  └──────────────────────────────────────┴─────────────────────────────────────┴────────┴────────────────────────────────────────────────────────────┘

  Can Fix Now

  Convert QuickStartCard to a semantic button, rename labels to action language, add explicit accessible labels to recent chat chips, and tune hierarchy so start/recent actions dominate.

  Needs Product Decision

  Whether FAQ belongs on Home as a large expandable support surface, or should move into a Help/Professor Mari area with only a smaller entry point here.

  No tests or browser checks run; this was a static UI audit from the referenced workflow and source files.
	

-----------------------
 Used ui-audit.md; did not use impeccable. No repo changes made.

  Scope
  Surface: Left chat list. User goal: find, open, create, organize, or delete chats by mode. Owner: src/app/shell/ChatSidebar.tsx:120.

  Top Findings

  1. Chat rows are keyboard-focusable but not keyboard-operable. Each row is a div role="button" with tabIndex, but the row block has no onKeyDown, so Enter/Space users can focus a chat without opening/
     selecting it. Proposed simplification: make the main row action a real button, or add full keyboard activation and a clear accessible name. Owner: src/app/shell/ChatSidebar.tsx:573. Can fix now.
  2. Chat rows mix one large row action with hidden inline actions. Move/delete buttons appear inside the same clickable row on hover/mobile, including destructive delete next to routine open. Proposed
     simplification: split row structure into a primary “open chat” button plus a stable overflow/actions group; keep delete explicit inside the overflow with confirmation. Owner: src/app/shell/
     ChatSidebar.tsx:777. Needs product decision if changing action hierarchy.
  3. Mode tabs use short labels only: CONVO, RP, GM. These save width, but they are not full user-language labels and have no aria-selected, aria-current, or aria-pressed. Unread badges also do not alter the
     accessible label. Proposed simplification: expose full labels to assistive tech, add selected state, and consider visible full labels on desktop width. Owner: src/app/shell/ChatSidebar.tsx:837. Can fix
     now.
  4. The top control area has too many visible choices before the user reaches the list: mode tabs, search, sort, New, Folder, Select chats, Tags, tag chips, Clear, and “more.” That crosses the workflow’s
     “more than four choices” check for a primary path. Proposed simplification: keep mode/search/New primary; move sort, folder, select, and tag expansion into a compact filter/actions row or overflow. Owner:
     src/app/shell/ChatSidebar.tsx:867. Needs product decision.
  5. Folder row icon controls are not fully named. Rename has title, delete appears icon-only, and drag reorder is visual/pointer-only. Proposed simplification: add aria-labels for folder rename/delete/reorder
     and consider a named overflow menu for folder actions. Owner: src/app/shell/ChatSidebar.tsx:1292. Can fix now.

  Compact Inventory

  ┌─────────────────┬─────────────────────────────────────────┬─────────────────────────────────────────┐
  │ Area            │ Controls                                │ Main risk                               │
  ├─────────────────┼─────────────────────────────────────────┼─────────────────────────────────────────┤
  │ Header/tabs     │ Close, Conversation, Roleplay, Game     │ Abbreviated state/labels                │
  │ Filters/actions │ Search, sort, New, Folder, Select, Tags │ Too many choices early                  │
  │ Chat rows       │ Open/select, move, delete, badges       │ Nested/hidden actions                   │
  │ Folders         │ Expand, drag, rename, delete            │ Icon-only and pointer-heavy             │
  │ Footer          │ Status picker, custom activity          │ Secondary task competing with chat list │
  └─────────────────┴─────────────────────────────────────────┴─────────────────────────────────────────┘

  Verification
  Audit only. I inspected source with rg; no tests, screenshots, or browser checks were run.

-----------------------

• Using skills\marinara-agent-workflow\references\workflows\ui-audit.md, repo-only audit. No Impeccable, no screenshots, no code edits.

  Scope
  Surface: Professor Mari
  Primary source: src/features/shell/mari/components/ProfessorMariSurface.tsx:101
  User goal: ask Professor Mari for help with Marinara or app customization.
  Primary path: open Mari, type a question, ensure a model connection exists/selected, send.
  Likely user state: new or stuck user, possibly no connection configured.

  Top Findings

  1. The model connection requirement is too hidden for the primary path.
     The send button can look available before the user has a usable selected connection, then sending reveals a setup prompt or “chains icon” error. The connection control is icon-only, and the selected connection
     is only visible through title/active styling.
     Owner: src/features/shell/mari/components/ProfessorMariSurface.tsx:337 and src/features/shell/mari/components/ProfessorMariSurface.tsx:575.
     Simplification: show a small visible “Using <connection>” / “Choose model” chip near the input, and make the no-connection state a clear CTA before typing or before send.
     Proof needed: first-run user can tell what is required before pressing Send.
  2. The input bar has too many competing decisions.
     At the primary decision point, users see attach, connection, persona/quick switcher, text entry, and send. On mobile, “Quick Switcher” overlaps conceptually with the separate connection button.
     Owner: src/features/shell/mari/components/ProfessorMariSurface.tsx:565.
     Simplification: merge connection + persona into one context selector, or move persona into an overflow/context menu. Keep the main row focused on attach, message, send.
     Proof needed: mobile and desktop input bars have one obvious primary action.
  3. The placeholder advertises a destructive reset command.
     Message @Professor Mari, /reset to reset the conversation and only then clear it mixes the main task with a risky action in low-contrast placeholder text.
     Owner: src/features/shell/mari/components/ProfessorMariSurface.tsx:31.
     Simplification: make the placeholder only describe messaging. Move reset to an explicit menu or command help surface with consequence copy.
     Proof needed: users are not taught destructive actions in the typing hint.
  4. Persona selection is ambiguous.
     “Quick Persona Switcher” may read as changing Mari’s persona, the user persona, or the chat persona. It also silently persists.
     Owner: src/features/shell/mari/components/ProfessorMariSurface.tsx:606.
     Simplification: rename to user-language copy like “User persona” or “Ask as,” and show selected state in the combined context selector.
     Proof needed: user can predict what persona changes before selecting it.
  5. Attachments have unclear consequence and transcript proof.
     Files can be attached and sent to Mari, but the visible transcript records only the typed message, or [attachments] when no draft exists. Users may not know what was sent later.
     Owner: src/features/shell/mari/components/ProfessorMariSurface.tsx:288 and src/features/shell/mari/components/ProfessorMariSurface.tsx:362.
     Simplification: show attached file names/count in the user message or a durable transcript attachment summary.
     Proof needed: after sending, users can verify which files Mari received.

  Compact Inventory

  ┌──────────────────────┬───────────────────────────┬───────────────────────────────────┬──────────────────────────────────────────┐
  │ Control              │ Current Role              │ Risk                              │ Recommendation                           │
  ├──────────────────────┼───────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────┤
  │ Attach +             │ Add files                 │ Consequence unclear               │ Keep, but show durable sent-file summary │
  │ Link icon            │ Connection selector/setup │ Required state hidden             │ Convert/augment with visible model chip  │
  │ Persona icon         │ Persona selector          │ Ambiguous owner/effect            │ Rename and move into context selector    │
  │ Mobile chevron       │ Combined switcher         │ Duplicates connection control     │ Merge with connection/persona selector   │
  │ Textarea placeholder │ Message + reset hint      │ Destructive hint in placeholder   │ Use message-only placeholder             │
  │ Send                 │ Primary action            │ Enabled before connection clarity │ Pair with visible readiness state        │
  └──────────────────────┴───────────────────────────┴───────────────────────────────────┴──────────────────────────────────────────┘

  Can Fix Now
  Rename placeholder, improve icon labels/titles, add aria-expanded to popover buttons, and merge mobile switcher labeling without changing backend behavior.

  Needs Product Decision
  Whether reset becomes an explicit control, whether persona belongs in the main input path, and whether attachment metadata should be persisted in Mari history.

-----------------------

• Used skills\marinara-agent-workflow\references\workflows\ui-audit.md; did not use impeccable.

  Surface Map
  Surface: Tracker panel
  User goal: inspect and lightly correct live tracker data for the active chat.
  Primary path: open tracker panel, read world/persona/characters/quests/custom stats, edit inline fields, optionally rerun a section tracker.
  Likely user state: mid-chat, scanning quickly, not in an explicit “editing workspace” mindset.
  Primary owner: src/features/runtime/tracker/components/TrackerDataSidebar.tsx:9, with controls flowing through TrackerSidebarHeader, TrackerSectionList, section panels, and shared tracker controls.

  Top Findings

  1. Header has too many same-weight icon actions for a narrow panel
     Confusing controls: global add, delete, size cycle, side switch, close all sit as unlabeled icons in src/features/runtime/tracker/components/TrackerSidebarHeader.tsx:60.
     Why it matters: the first decision point exposes five actions before the user reaches tracker content, and three of them are mode/layout controls rather than the primary read/edit task.
     Simplification: keep close visible, make add/delete a small segmented edit-mode control with active text or a shared “Edit” menu, and move size/side into a layout overflow.
     Proof needed: screenshot or interaction pass at compact, standard, expanded widths.
  2. Add/delete modes are global, but their effects are scattered and implicit
     Confusing controls: header Plus/Trash2 toggles change controls across persona, characters, quests, custom stats, inventory, and stats, but the panel does not appear to show a persistent mode label or scope.
     Entry starts at src/features/runtime/tracker/components/TrackerDataSidebar.tsx:10, effects fan out in src/features/runtime/tracker/components/TrackerSectionList.tsx:153.
     Why it matters: users may not understand why new remove buttons or add rows appeared, especially after scrolling away from the sticky header.
     Simplification: when mode is active, show a thin sticky mode strip such as “Adding tracker rows” / “Removing tracker rows” with an exit button, or localize add/remove to each section.
     Proof needed: manual scroll test with a populated tracker.
  3. Rerun and auto-avatar actions are visually equivalent to harmless section tools
     Confusing controls: section rerun uses the same tiny SectionIconButton as character auto-avatar toggle in src/features/runtime/tracker/components/TrackerSectionList.tsx:104 and src/features/runtime/tracker/
     components/TrackerSectionList.tsx:116.
     Why it matters: rerun can trigger model work and overwrite/refresh tracker interpretation, while auto-avatar changes media behavior. They deserve clearer consequence and state than a small icon beside section
     collapse.
     Simplification: keep rerun explicit but label it in tooltip copy as “Refresh this tracker from chat,” and separate feature toggles from rerun actions. Consider text labels when the panel is expanded.
     Proof needed: confirm whether rerun mutates manual edits or only recomputes missing data.
  4. Destructive row removals appear without confirmation once delete mode is active
     Confusing controls: remove buttons directly call removals for characters, quests, objectives, stats, inventory, and custom fields, e.g. src/features/runtime/tracker/components/CharacterTrackerCard.tsx:220, src/
     features/runtime/tracker/components/quest-tracker/QuestRow.tsx:111, src/features/runtime/tracker/components/tracker-data-sidebar.stats.tsx:233.
     Why it matters: delete mode reduces accidental exposure, but the individual actions are still one-click data loss.
     Simplification: add undo toast or lightweight confirmation for larger objects like character/quest; small stat/objective rows may be okay with undo only.
     Proof needed: verify persistence model and whether undo is already available elsewhere.

  Compact Inventory

  ┌──────────────────────┬──────────────────────────────────────┬──────────────────────────────────┬─────────────────────────────────────┐
  │ Control              │ Result                               │ State/Risk                       │ Recommendation                      │
  ├──────────────────────┼──────────────────────────────────────┼──────────────────────────────────┼─────────────────────────────────────┤
  │ Close tracker panel  │ Hides panel                          │ Low risk                         │ Keep visible                        │
  │ Add mode             │ Reveals add controls across sections │ Hidden scope                     │ Add mode label/exit strip           │
  │ Delete mode          │ Reveals remove controls              │ Destructive                      │ Add undo/confirm for larger objects │
  │ Size cycle           │ Compact/standard/expanded            │ Layout-only but prominent        │ Move to layout overflow             │
  │ Side switch          │ Left/right anchor                    │ Layout-only but prominent        │ Move to layout overflow             │
  │ Section header click │ Collapse/expand                      │ Good, but shares area with icons │ Keep                                │
  │ Refresh section      │ Reruns tracker agent                 │ Potential data surprise          │ Stronger label/consequence          │
  │ Auto-avatar sparkle  │ Toggles character avatar generation  │ Stateful feature toggle          │ Separate from rerun cluster         │
  └──────────────────────┴──────────────────────────────────────┴──────────────────────────────────┴─────────────────────────────────────┘

  Can Fix Now
  Rename/retitle icon labels, add active mode strip, regroup header controls, and improve rerun tooltip copy.

  Needs Product Decision
  Whether deletes require confirmation, undo, or immediate removal; whether rerun is allowed to overwrite user edits. No tests or browser checks were run because this was an audit-only pass.
-----------------------

• Used ui-audit.md only, no impeccable. No code changes made.

  Scope
  Surface: Shared chat overlays.
  User goal: manage chat-adjacent overlays without losing context or deleting the wrong content.
  Primary path: open settings/files/gallery/wizard or message delete flow from an active chat.
  Likely state: mid-chat, often mobile, with generated content or selected messages active.

  Top Findings

  1. Bulk delete is too easy to trigger after a vague “Delete more” choice.
     src/features/modes/shared/chat-ui/components/ChatCommonOverlays.tsx:70 asks “How to proceed?”, then offers “Delete more”; the hook preselects the clicked message and every later message, and Delete selected
     runs without a second user-facing confirmation.
     Recommendation: rename to “Select this and later messages…”, show the range/count, and require confirm on Delete selected.
  2. The setup wizard treats backdrop/close as finish/skip.
     src/features/modes/shared/chat-ui/components/ChatCommonOverlays.tsx:272 mounts the wizard, while ChatSetupWizard uses onFinish for outside click/close/skip paths. That can silently end setup.
     Recommendation: make outside click inert or map it to explicit cancel; label close as “Skip setup” if that is the intended product behavior.
  3. Settings presets expose too many compact icon actions at once.
     src/features/modes/shared/chat-ui/components/ChatSettingsDrawer.tsx:1638 puts save, rename, save-as, import, export, and delete into one icon row next to preset selection/defaulting. This is high choice count
     and places destructive preset delete beside routine actions.
     Recommendation: keep preset select + one primary “Save preset” visible; move rename/duplicate/import/export/delete into an overflow menu with destructive separation.
  4. Several overlay dialogs lack modal semantics and consistent close names.
     Delete confirmation, prompt peek, gallery delete, and settings drawer use fixed/absolute overlay divs without consistent role="dialog", aria-modal, labels, focus handling, or Escape behavior. Files/gallery
     close buttons have labels; settings and prompt close do not.
     Recommendation: use the shared modal pattern where possible, or add dialog semantics, labeled close buttons, focus trap, and Escape close.
  5. Multi-select has too many choices in the floating bar.
     src/features/modes/shared/chat-ui/components/ChatCommonOverlays.tsx:126 shows count, delete, cancel, select-above, unselect-all, and select-below. The range actions are icon-only and secondary but occupy the
     same decision point as deletion.
     Recommendation: keep “Delete N” and “Cancel” prominent; move range helpers into a “Selection” menu or label them as text on mobile.

  Can Fix Now
  Rename the delete-more flow, add bulk delete confirmation, add aria labels/dialog semantics, reduce preset icon row into overflow, and simplify the multi-select bar.

  Needs Product Decision
  Whether outside-clicking the setup wizard should truly skip setup, and what “Illustrate”/“Pin to chat” should mean in gallery language. Proof needed: a quick keyboard/mobile pass through delete, wizard, settings
  presets, and gallery overlays.
-----------------------

	Scope
  User goal: edit catalog resources without losing work or accidentally deleting/moving data.
  Primary path: open item, edit fields, understand what is saved now vs later, close safely.
  Likely user state: content-heavy, switching between characters/personas/presets/lorebooks/agents.
  Owner files: src/features/catalog/*/components/*Editor.tsx plus related create/import/maker modals.

  Top Findings

  1. Preset editor mixes manual Save with immediate mutations
     PresetEditor header Save only persists preset-level fields, while section/group/variable actions mutate separately. The clearest risk is section delete: /abs/path/C:/Ai/dev/Marinara-Engine/src/features/
     catalog/presets/components/PresetEditor.tsx:1159 deletes directly, while group and variable delete use confirmation at lines 1001 and 1639.
     Proposed simplification: make all destructive preset child actions confirm, and visually separate “preset settings save” from auto-saved sections/variables.
     Proof needed: browser pass confirming users can tell which changes are saved immediately.
  2. Knowledge file delete in Agent editor is too easy
     In AgentEditor, uploaded file deletion calls deleteSource.mutate directly from a small inline trash button: /abs/path/C:/Ai/dev/Marinara-Engine/src/features/catalog/agents/components/AgentEditor.tsx:1785.
     Other deletes in the same editor use confirmation, like custom agent delete at line 587.
     Proposed simplification: add confirm dialog, or rename action to “Remove file” if it only detaches from the agent. If it deletes the source globally, keep “Delete file” explicit.
     Proof needed: confirm whether deletion is global or just unlinks from this agent.
  3. Lorebook entries tab exceeds the four-choice decision rule
     The entries area exposes keyword test, sort, Select, Add Folder, Add Entry, then selection-mode actions Select all, Clear, Copy, Move, Done around /abs/path/C:/Ai/dev/Marinara-Engine/src/features/catalog/
     lorebooks/components/LorebookEditor.tsx:1482 and /abs/path/C:/Ai/dev/Marinara-Engine/src/features/catalog/lorebooks/components/LorebookEditor.tsx:1579.
     Proposed simplification: keep “Add Entry” primary, keep sort visible, move Keyword test and Add Folder behind secondary controls, and make bulk Copy/Move appear only after selection.
     Proof needed: browser check that the primary add/edit path remains obvious on narrow widths.
  4. Character/persona editors have competing primary actions
     Character editing surfaces expose edit actions alongside play/export/duplicate/copy/delete actions in the header. Example: CharacterEditor starts header actions with “Start Chat” around /abs/path/C:/Ai/
     dev/Marinara-Engine/src/features/catalog/characters/components/CharacterEditor.tsx:580, while Save is also a core editor action.
     Proposed simplification: make Save/dirty state the editor’s primary cluster; move Start Chat, Export, Duplicate, and Copy into a secondary menu or lower-intensity group.
     Proof needed: product decision on whether detail editors are primarily “edit” surfaces or “use this resource” launch surfaces.
  5. Icon-only controls rely inconsistently on discoverability
     Some editors do this well, e.g. ToolEditor back button has aria-label="Back to tools" at /abs/path/C:/Ai/dev/Marinara-Engine/src/features/catalog/agents/components/ToolEditor.tsx:247. Preset header
     controls are less consistent: back/export/delete are mostly icon-only around /abs/path/C:/Ai/dev/Marinara-Engine/src/features/catalog/presets/components/PresetEditor.tsx:317.
     Proposed simplification: add aria-label to every icon-only action and reserve title as a supplement, not the only name.
     Proof needed: accessibility scan or DOM inspection after changes.

  Can Fix Now
  Add confirmations for direct destructive child actions, add missing aria-labels, align delete wording, and reduce visible secondary controls in preset/lorebook headers.

  Needs Product Decision
  Whether character/persona detail editors should prioritize editing or launching chat/use actions, and whether preset sections/variables should be framed as auto-saved while preset metadata remains manual-
  save.
	
	
