/**
 * The single source of truth for settings navigation: every tab and section
 * the Settings panel exposes. Lives in `shared` (not just the client) so the
 * server can also point at a real setting label, e.g. for Professor Mari's
 * quick-answer docs grounding, without duplicating this list.
 *
 * Adding a setting: add it here and every surface that reads this finds it.
 */
export type SettingsTabId = "general" | "appearance" | "generations" | "import" | "advanced";

export type SettingsSectionId =
  | "application"
  | "omnibar"
  | "notifications"
  | "responses"
  | "input-editing"
  | "overall-generations"
  | "image-generation"
  | "video-generation"
  | "game-assets"
  | "app-style"
  | "text-scale"
  | "chat-display"
  | "roleplay-tracker"
  | "roleplay-messages"
  | "game-presentation"
  | "motion-backgrounds"
  | "conversation-theme"
  | "chat-backgrounds"
  | "prompt-overrides"
  | "personal-extensions"
  | "extensions-imports"
  | "theme-library"
  | "profile-marinara"
  | "sillytavern-import"
  | "access-status"
  | "admin-access"
  | "multiplayer"
  | "features"
  | "updates"
  | "support-diagnostics"
  | "request-timeouts"
  | "parameters"
  | "message-tools"
  | "backup-export"
  | "storage-optimization"
  | "danger-zone";

export type SettingsSectionMeta = {
  id: SettingsSectionId;
  tab: SettingsTabId;
  label: string;
  description: string;
  aliases: string[];
};

/**
 * Tab-level destinations. `SettingsPanel`'s own `TABS` owns the icon and the
 * i18n keys for rendering; this owns the id, the search copy and the aliases.
 * The panel pins its ids to this union with `satisfies`, so the two cannot
 * drift apart on ids.
 */
export const SETTINGS_TABS: readonly {
  id: SettingsTabId;
  label: string;
  description: string;
  aliases: readonly string[];
}[] = [
  {
    id: "general",
    label: "General",
    description: "Language, responses, input, and notifications.",
    aliases: ["general", "application", "notifications", "responses", "input", "editing"],
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme, chat display, art, motion, and backgrounds.",
    aliases: ["appearance", "style", "display", "font", "background", "themes", "custom css"],
  },
  {
    id: "generations",
    label: "Images & Video",
    description: "Image, video, asset, and prompt defaults.",
    aliases: ["generation", "image", "video", "assets", "prompts"],
  },
  {
    id: "import",
    label: "Data",
    description: "Import, export, backups, storage, and game assets.",
    aliases: ["data", "import", "export", "restore", "profile", "transfer", "backup", "storage"],
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "Updates, diagnostics, extensions, and tools.",
    aliases: ["advanced", "admin", "debug", "diagnostics", "extensions", "addons"],
  },
];

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    id: "application",
    tab: "general",
    label: "App Behavior",
    description: "Language, safety confirmations, privacy, achievements, and playful extras.",
    aliases: ["language", "delete", "confirm", "music", "achievements", "app"],
  },
  {
    // Q2: lives in the omnibar's own settings view, not in this panel. General shows one row
    // that opens it, and every jump to this section or its controls opens the omnibar instead.
    id: "omnibar",
    tab: "general",
    label: "Search and Professor Mari",
    description: "Search, quick answers, Professor Mari and her appearance. Opens in Search.",
    aliases: ["omnibar", "search", "command palette", "ctrl k", "quick answers", "professor mari", "mari", "mini mari"],
  },
  {
    id: "notifications",
    tab: "general",
    label: "Notifications",
    description: "Notification sounds and background notifications by mode.",
    aliases: ["notifications", "sound", "ping", "browser", "background replies", "conversation", "roleplay", "game"],
  },
  {
    id: "responses",
    tab: "general",
    label: "Responses",
    description: "How replies arrive, save, and paginate.",
    aliases: ["streaming", "speed", "messages", "pagination", "trim", "model endings"],
  },
  {
    id: "input-editing",
    tab: "general",
    label: "Input & Editing",
    description: "Message input, fast edit controls, and game navigation.",
    aliases: [
      "enter",
      "navigation",
      "send",
      "microphone",
      "speech",
      "swipe",
      "reroll",
      "double click",
      "arrow up",
      "quick replies",
      "post only",
      "guide reply",
      "impersonate",
      "mouse wheel",
      "middle mouse",
    ],
  },
  {
    id: "overall-generations",
    tab: "generations",
    label: "Overall Generations",
    description: "Shared behavior for image and video generation requests.",
    aliases: ["media", "image", "video", "queue", "prompt review", "generation"],
  },
  {
    id: "image-generation",
    tab: "generations",
    label: "Image Generation",
    description: "Image canvas defaults and style profiles.",
    aliases: ["image", "background", "portrait", "selfie", "style profiles"],
  },
  {
    id: "video-generation",
    tab: "generations",
    label: "Video Generation",
    description: "Video duration, clip behavior, and reusable video settings.",
    aliases: ["video", "clip", "duration", "conversation call", "animated", "scene"],
  },
  {
    id: "game-assets",
    tab: "import",
    label: "Game Assets",
    description: "Asset folders for music, ambience, sprites, and backgrounds.",
    aliases: ["assets", "music", "ambient", "sfx", "sprites", "backgrounds", "folder"],
  },
  {
    id: "app-style",
    tab: "appearance",
    label: "App Style",
    description: "Theme family, color scheme, accent, and app chrome controls.",
    aliases: ["theme", "accent", "rgb", "cursor", "background", "style", "color scheme"],
  },
  {
    id: "text-scale",
    tab: "appearance",
    label: "Text & Scale",
    description: "Fonts, display size, chat text colors, text rules, and legibility controls.",
    aliases: [
      "font",
      "google fonts",
      "display size",
      "chat font",
      "text",
      "stroke",
      "outline",
      "chrome text",
      "legibility",
      "quotes",
      "bold",
      "dialogue",
      "latex",
      "symbols",
    ],
  },
  {
    id: "chat-display",
    tab: "appearance",
    label: "Conversation Display",
    description: "Conversation layout and shared message text presentation.",
    aliases: ["chat", "conversation", "messages", "timestamps", "token", "model", "grouping"],
  },
  {
    id: "roleplay-tracker",
    tab: "appearance",
    label: "Tracker Panel",
    description: "Roleplay HUD tracker panel, card layout, and tracker portrait behavior.",
    aliases: ["roleplay", "tracker", "hud", "cards", "thoughts", "temperature", "portrait"],
  },
  {
    id: "roleplay-messages",
    tab: "appearance",
    label: "Roleplay Presentation",
    description: "Classic and Visual Novel display, avatars, sprites, and message opacity.",
    aliases: ["roleplay", "avatar", "sprite", "message", "bubble", "opacity", "portrait"],
  },
  {
    id: "game-presentation",
    tab: "appearance",
    label: "Game Presentation",
    description: "Game VN art scale, dialogue display, and narration playback.",
    aliases: [
      "game",
      "vn",
      "dialogue",
      "portrait",
      "sprite",
      "full body",
      "presentation",
      "text speed",
      "auto play",
      "playback",
    ],
  },
  {
    id: "motion-backgrounds",
    tab: "appearance",
    label: "Atmosphere",
    description: "Roleplay weather and atmospheric effects.",
    aliases: ["motion", "weather", "effects", "atmosphere", "rain", "snow", "fog", "roleplay"],
  },
  {
    id: "conversation-theme",
    tab: "appearance",
    label: "Conversation Theme",
    description: "Conversation-mode background gradient by color scheme.",
    aliases: ["conversation", "gradient", "theme", "dark", "light"],
  },
  {
    id: "chat-backgrounds",
    tab: "appearance",
    label: "Backgrounds",
    description: "Chat background images, blur, and default roleplay background.",
    aliases: ["background", "blur", "scene", "image", "roleplay background", "chat background"],
  },
  {
    id: "prompt-overrides",
    tab: "generations",
    label: "Prompt Overrides",
    description: "Reusable image and video prompt templates.",
    aliases: ["prompt", "template", "override", "video prompt", "image prompt"],
  },
  {
    id: "extensions-imports",
    tab: "advanced",
    label: "Extensions & imports",
    description: "Custom Agent and extension import switches, plus your extensions.",
    aliases: ["agent imports", "custom agents", "third-party", "external extensions", "addons", "plugins"],
  },
  {
    id: "personal-extensions",
    tab: "advanced",
    label: "Personal Extensions",
    description: "Sandboxed extension drafts authored by Professor Mari.",
    aliases: ["extensions", "addons", "local code", "browser", "server", "professor mari"],
  },
  {
    id: "theme-library",
    tab: "appearance",
    label: "Theme Library",
    description: "Synced themes and custom theme CSS.",
    aliases: ["themes", "custom css", "css", "library", "export theme"],
  },
  {
    id: "profile-marinara",
    tab: "import",
    label: "Profile & Marinara",
    description: "Restore full profiles or import individual Marinara files.",
    aliases: ["profile", "import", "restore", "marinara", "json", "zip"],
  },
  {
    id: "sillytavern-import",
    tab: "import",
    label: "SillyTavern Import",
    description: "Bring over characters, chats, presets, and lorebooks.",
    aliases: ["sillytavern", "st", "character", "chat", "preset", "lorebook", "import"],
  },
  {
    id: "access-status",
    tab: "advanced",
    label: "Access",
    description: "Who can open Marinara without a password.",
    aliases: ["password", "login", "remote", "network", "security", "exposed"],
  },
  {
    id: "admin-access",
    tab: "advanced",
    label: "Admin Access",
    description: "Admin authorization for privileged actions.",
    aliases: ["admin", "secret", "access", "authorization"],
  },
  {
    id: "multiplayer",
    tab: "advanced",
    label: "Multiplayer WIP",
    description: "Optional shared roleplay, conversation and game sessions.",
    aliases: ["multiplayer", "host", "join", "players", "invite", "shared", "online"],
  },
  {
    id: "features",
    tab: "advanced",
    label: "Features",
    description: "Optional server behaviours, all off by default.",
    aliases: ["features", "switches", "optional", "provider retry", "lorebook groups"],
  },
  {
    id: "updates",
    tab: "advanced",
    label: "Updates",
    description: "Version and update controls.",
    aliases: ["update", "version", "refresh", "release"],
  },
  {
    id: "support-diagnostics",
    tab: "advanced",
    label: "Support Diagnostics",
    description: "Copy technical details for support tickets.",
    aliases: ["support", "diagnostics", "system info", "gpu", "model", "ticket", "bug report"],
  },
  {
    id: "request-timeouts",
    tab: "advanced",
    label: "Request timeouts",
    description: "Adjust how long text, agents and media wait for a slow backend.",
    aliases: ["timeout", "slow", "koboldcpp", "images", "video", "seconds", "backend"],
  },
  {
    id: "parameters",
    tab: "advanced",
    label: "Parameters",
    description: "Reusable numeric controls for provider-specific request fields.",
    aliases: ["custom parameters", "generation", "provider", "min p", "min_p"],
  },
  {
    id: "message-tools",
    tab: "advanced",
    label: "Message Tools",
    description: "Message maintenance and repair utilities.",
    aliases: ["messages", "tools", "repair", "cleanup"],
  },
  {
    id: "backup-export",
    tab: "import",
    label: "Backup & Export",
    description: "Backups and manual export tools.",
    aliases: ["backup", "export", "download", "archive", "automatic", "scheduled"],
  },
  {
    id: "storage-optimization",
    tab: "import",
    label: "Storage Optimization",
    description: "Find and remove abandoned avatar files.",
    aliases: ["storage", "avatar", "cleanup", "optimize", "orphan", "abandoned"],
  },
  {
    id: "danger-zone",
    tab: "advanced",
    label: "Danger Zone",
    description: "Destructive reset and expunge actions.",
    aliases: ["danger", "reset", "delete", "clear", "expunge", "destructive"],
  },
] as const;

// Keyed by plain string: lookups come from persisted UI state and omnibar rows,
// which are only strings until this map validates them.
export const SETTINGS_SECTION_BY_ID = new Map<string, SettingsSectionMeta>(
  SETTINGS_SECTIONS.map((section) => [section.id, section]),
);
