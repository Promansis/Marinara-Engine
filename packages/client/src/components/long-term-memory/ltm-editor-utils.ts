import type {
  ChatMode,
  LtmGate,
  LtmMode,
  LtmNote,
  LtmNoteType,
  LtmScope,
  LtmSection,
  LtmStatus,
} from "@marinara-engine/shared";
import type {
  CreateLongTermMemoryNoteInput,
  UpdateLongTermMemoryNoteInput,
} from "../../hooks/use-long-term-memory";

export const noteTypeOptions: LtmNoteType[] = [
  "character",
  "relationship",
  "scene",
  "thread",
  "callback",
  "world",
  "voice",
  "tone",
];

export const statusOptions: LtmStatus[] = ["active", "dormant", "resolved", "archived"];
export const modeOptions: LtmMode[] = ["roleplay", "conversation", "game", "visual_novel"];
export const gateOptions: LtmGate[] = ["spoiler", "character_secret", "private", "nsfw"];

export const allowedIdPrefixesByType: Record<LtmNoteType, readonly string[]> = {
  character: ["char_"],
  relationship: ["rel_"],
  scene: ["scene_"],
  thread: ["thread_"],
  callback: ["cb_"],
  world: ["world_", "faction_", "location_", "rule_", "rules"],
  voice: ["voice_"],
  tone: ["tone_"],
};

export function normalizeIdentifier(value: string, fallbackPrefix = "item") {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!normalized) return "";
  return /^[a-z]/.test(normalized) ? normalized : `${fallbackPrefix}_${normalized}`;
}

export function normalizeTagsInput(value: string) {
  return value
    .split(/[,\n]+/)
    .map((item) => normalizeIdentifier(item, "tag"))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
}

export function normalizeIdentifierList(value: string, fallbackPrefix = "item") {
  return value
    .split(/[,\n]+/)
    .map((item) => normalizeIdentifier(item, fallbackPrefix))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
}

export function parseTextList(value: string) {
  return value
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
}

export function joinIdentifierList(values: string[] | undefined) {
  return values?.join(", ") ?? "";
}

export function defaultSectionKeyForType(type: LtmNoteType) {
  return type === "scene" ? "summary" : "core";
}

export function emptySection(text = ""): LtmSection {
  return {
    text,
    updatedAt: new Date().toISOString(),
  };
}

export function defaultModeFromChatMode(mode?: ChatMode): LtmMode {
  if (mode === "conversation" || mode === "game" || mode === "visual_novel") return mode;
  return "roleplay";
}

export function emptyScopeFromDraft(draft: {
  universe?: string;
  rpId?: string;
  chatId?: string;
  groupId?: string;
  characterIdsText?: string;
}): LtmScope {
  const scope: LtmScope = {};
  const universe = normalizeIdentifier(draft.universe ?? "", "universe");
  const rpId = normalizeIdentifier(draft.rpId ?? "", "rp");
  const characterIds = parseTextList(draft.characterIdsText ?? "");
  if (universe) scope.universe = universe;
  if (rpId) scope.rpId = rpId;
  if (draft.chatId?.trim()) scope.chatId = draft.chatId.trim();
  if (draft.groupId?.trim()) scope.groupId = draft.groupId.trim();
  if (characterIds.length > 0) scope.characterIds = characterIds;
  return scope;
}

export function createNoteInput(data: {
  id: string;
  type: LtmNoteType;
  status: LtmStatus;
  modes: LtmMode[];
  scope: LtmScope;
  tags: string[];
  sectionKey: string;
  sectionText: string;
}): CreateLongTermMemoryNoteInput {
  const sectionKey = normalizeIdentifier(data.sectionKey, "section") || defaultSectionKeyForType(data.type);
  return {
    id: normalizeIdentifier(data.id, allowedIdPrefixesByType[data.type][0].replace(/_$/, "")),
    type: data.type,
    status: data.status,
    modes: data.modes.length > 0 ? data.modes : ["roleplay"],
    scope: data.scope,
    tags: data.tags,
    links: [],
    sections: {
      [sectionKey]: emptySection(data.sectionText.trim()),
    },
  };
}

export function editablePatchFromDraft(draft: LtmNote): UpdateLongTermMemoryNoteInput {
  return {
    status: draft.status,
    modes: draft.modes,
    scope: draft.scope,
    tags: draft.tags,
    links: draft.links,
    sections: draft.sections,
    conflicts: draft.conflicts,
  };
}

export function isAllowedNoteId(type: LtmNoteType, id: string) {
  const prefixes = allowedIdPrefixesByType[type];
  return prefixes.some((prefix) => id === prefix || id.startsWith(prefix));
}
