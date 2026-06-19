import {
  withMergedLtmScopeLinks,
  type Chat,
  type ChatMode,
  type LtmExtractionDraft,
  type LtmLink,
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

export function displayNoteTitle(note: Pick<LtmNote, "id" | "type" | "title">) {
  return note.title?.trim() || friendlyNoteTitle(note);
}

export function humanMemoryTitle(note: Pick<LtmNote, "id" | "type" | "title" | "sections" | "scope" | "tags">, chatLookup?: Map<string, Chat>) {
  if (note.title?.trim()) return note.title.trim();
  const sourceEvidence = note.sections.source?.evidence ?? [];
  const chatName =
    sourceEvidence.find((entry) => entry.startsWith("chat_name:"))?.slice("chat_name:".length).trim() ||
    chatLookup?.get(note.scope.chatId ?? "")?.name;
  const messageRange = sourceEvidence.find((entry) => entry.startsWith("message_range:"))?.slice("message_range:".length).trim();

  if (note.type === "source" && chatName) {
    return messageRange ? `${chatName}, messages ${messageRange}` : chatName;
  }

  if (note.type === "source") return "Imported source";
  return displayNoteTitle(note);
}

export function humanScopeLabel(note: Pick<LtmNote, "scope">, chatLookup?: Map<string, Chat>) {
  const chatIds = [
    ...(note.scope.chatIds ?? []),
    ...(note.scope.chatId ? [note.scope.chatId] : []),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
  const chatLabels = chatIds.map((id) => chatLookup?.get(id)?.name).filter(Boolean);
  const parts = [
    ...chatLabels,
    ...(note.scope.characterIds?.length ? [`${note.scope.characterIds.length} character link${note.scope.characterIds.length === 1 ? "" : "s"}`] : []),
    ...(note.scope.groupId ? ["Group chat"] : []),
  ];
  return parts.length ? parts.join(", ") : "Available everywhere";
}

export function humanRelationLabel(relation: string) {
  if (relation === "extracted_from") return "Source";
  if (relation === "timeline_event" || relation.includes("timeline")) return "Timeline";
  if (relation === "source" || relation === "source_note") return "Source";
  return "Related memory";
}

export function humanScoreLabel(value: number) {
  if (value >= 0.75) return "High";
  if (value >= 0.45) return "Medium";
  return "Low";
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
  chatIds?: string[];
  groupId?: string;
  characterIds?: string[];
}): LtmScope {
  let scope: LtmScope = {};
  if (draft.groupId?.trim()) scope.groupId = draft.groupId.trim();
  scope = withMergedLtmScopeLinks(scope, {
    chatIds: draft.chatIds ?? [],
    characterIds: draft.characterIds ?? [],
  });
  return scope;
}

export function createNoteInput(data: {
  id: string;
  title?: string;
  type: LtmNoteType;
  status: LtmStatus;
  modes: LtmMode[];
  scope: LtmScope;
  tags: string[];
  sectionKey: string;
  sectionText: string;
  links?: LtmLink[];
  evidence?: string[];
  salience?: number;
  confidence?: number;
}): CreateLongTermMemoryNoteInput {
  const sectionKey = normalizeIdentifier(data.sectionKey, "section") || defaultSectionKeyForType(data.type);
  return {
    id: normalizeIdentifier(data.id, allowedIdPrefixesByType[data.type][0].replace(/_$/, "")),
    title: data.title?.trim() || undefined,
    type: data.type,
    status: data.status,
    modes: data.modes.length > 0 ? data.modes : ["roleplay"],
    scope: data.scope,
    tags: data.tags,
    links: data.links ?? [],
    sections: {
      [sectionKey]: {
        ...emptySection(data.sectionText.trim()),
        ...(data.evidence?.length ? { evidence: data.evidence } : {}),
        ...(data.salience !== undefined ? { salience: data.salience } : {}),
        ...(data.confidence !== undefined ? { confidence: data.confidence } : {}),
      },
    },
  };
}

export function editablePatchFromDraft(draft: LtmNote): UpdateLongTermMemoryNoteInput {
  return {
    status: draft.status,
    title: draft.title?.trim() || null,
    type: draft.type,
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

export function friendlyEvidence(entry: string) {
  const colonIdx = entry.indexOf(":");
  if (colonIdx > 0) {
    const rawPrefix = entry.slice(0, colonIdx);
    const value = friendlyIdentifier(entry.slice(colonIdx + 1));
    if (rawPrefix === "chat_name") return value;
    if (rawPrefix === "message_range") return `messages ${entry.slice(colonIdx + 1).trim()}`;
    if (rawPrefix === "source_note") return `Source: ${value || "Imported source"}`;
    return `${sentenceCaseIdentifier(rawPrefix)}: ${value}`;
  }
  return friendlyIdentifier(entry);
}

export function humanEvidenceLabel(entry: string, chatLookup?: Map<string, Chat>) {
  const colonIdx = entry.indexOf(":");
  if (colonIdx <= 0) return friendlyEvidence(entry);
  const prefix = entry.slice(0, colonIdx);
  const value = entry.slice(colonIdx + 1).trim();
  if (prefix === "chat_name") return value || "Unknown chat";
  if (prefix === "message_range") return value ? `messages ${value}` : "Unknown messages";
  if (prefix === "source_note") return "Source memory";
  return chatLookup?.get(value)?.name ?? friendlyEvidence(entry);
}
