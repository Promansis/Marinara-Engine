import {
  withMergedLtmScopeLinks,
  type ChatMode,
  type LtmExtractionDraft,
  type LtmMode,
  type LtmNote,
  type LtmNoteType,
  type LtmScope,
  type LtmSection,
  type LtmStatus,
} from "@marinara-engine/shared";
import type { CreateLongTermMemoryNoteInput, UpdateLongTermMemoryNoteInput } from "../../hooks/use-long-term-memory";

export const noteTypeOptions: LtmNoteType[] = [
  "source",
  "timeline_event",
  "character",
  "relationship",
  "scene",
  "thread",
  "world",
  "tone",
];

export const statusOptions: LtmStatus[] = ["active", "resolved", "archived"];
export const modeOptions: LtmMode[] = ["roleplay", "conversation", "game"];

export const allowedIdPrefixesByType: Record<LtmNoteType, readonly string[]> = {
  source: ["source_", "scene_summary_"],
  timeline_event: ["timeline_"],
  character: ["char_"],
  relationship: ["rel_"],
  scene: ["scene_"],
  thread: ["thread_"],
  world: ["world_", "faction_", "location_", "rule_", "rules"],
  tone: ["tone_"],
};

const NOTE_TYPE_LABELS: Record<LtmNoteType, string> = {
  source: "Source",
  timeline_event: "Timeline event",
  character: "Character",
  relationship: "Relationship",
  scene: "Scene",
  thread: "Story thread",
  world: "World detail",
  tone: "Tone",
};

const STATUS_LABELS: Record<LtmStatus, string> = {
  active: "Active",
  resolved: "Resolved",
  archived: "Archived",
};

const MODE_LABELS: Record<LtmMode, string> = {
  roleplay: "Roleplay",
  conversation: "Conversation",
  game: "Game",
};

const KNOWN_ID_PREFIXES = [
  "character_",
  "char_",
  "relationship_",
  "rel_",
  "source_",
  "timeline_",
  "scene_",
  "thread_",
  "world_",
  "faction_",
  "location_",
  "rule_",
  "tone_",
  "scope_",
  "universe_",
  "rp_",
  "section_",
  "tag_",
  "note_",
  "relation_",
];

export function friendlyNoteType(type: LtmNoteType) {
  return NOTE_TYPE_LABELS[type] ?? sentenceCaseIdentifier(type);
}

export function friendlyStatus(status: LtmStatus) {
  return STATUS_LABELS[status] ?? sentenceCaseIdentifier(status);
}

export function friendlyMode(mode: LtmMode) {
  return MODE_LABELS[mode] ?? sentenceCaseIdentifier(mode);
}

export function sentenceCaseIdentifier(value: string) {
  const text = friendlyIdentifier(value).toLowerCase();
  return text ? text[0].toUpperCase() + text.slice(1) : value;
}

export function friendlyIdentifier(value: string) {
  let text = value.trim();
  for (const prefix of KNOWN_ID_PREFIXES) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  text = text.replace(/_[a-f0-9]{8,}$/i, "");
  text = text.replace(/[_-]+/g, " ").trim();
  if (!text) return value;
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function friendlyNoteTitle(note: Pick<LtmNote, "id" | "type">) {
  return `${friendlyNoteType(note.type)}: ${friendlyIdentifier(note.id)}`;
}

export function friendlySectionKey(key: string) {
  if (key === "core") return "Core memory";
  if (key === "summary") return "Summary";
  return sentenceCaseIdentifier(key);
}

export const isTypedSuggestionDraft = (draft: LtmExtractionDraft) => Boolean(draft.source.sourceNoteId);

export function friendlyInternalIdHelp(prefixes: readonly string[]) {
  return `Advanced: saved as an internal ID starting with ${prefixes.join(" or ")}.`;
}

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

export function defaultSectionKeyForType(type: LtmNoteType) {
  if (type === "source") return "source";
  if (type === "timeline_event") return "event";
  return type === "scene" ? "summary" : "core";
}

export function emptySection(text = ""): LtmSection {
  return {
    text,
    updatedAt: new Date().toISOString(),
  };
}

export function defaultModeFromChatMode(mode?: ChatMode): LtmMode {
  if (mode === "conversation" || mode === "game") return mode;
  return "roleplay";
}

export function emptyScopeFromDraft(draft: {
  universe?: string;
  rpId?: string;
  chatIds?: string[];
  groupId?: string;
  characterIds?: string[];
}): LtmScope {
  let scope: LtmScope = {};
  const universe = normalizeIdentifier(draft.universe ?? "", "universe");
  const rpId = normalizeIdentifier(draft.rpId ?? "", "rp");
  if (universe) scope.universe = universe;
  if (rpId) scope.rpId = rpId;
  if (draft.groupId?.trim()) scope.groupId = draft.groupId.trim();
  scope = withMergedLtmScopeLinks(scope, {
    chatIds: draft.chatIds ?? [],
    characterIds: draft.characterIds ?? [],
  });
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
