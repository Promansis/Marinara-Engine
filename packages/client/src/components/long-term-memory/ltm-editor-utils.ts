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
  type LtmSubject,
} from "@marinara-engine/shared";
import type { CreateLongTermMemoryNoteInput, UpdateLongTermMemoryNoteInput } from "../../hooks/use-long-term-memory";

export type LtmGroupLookup = Map<string, { label: string; rawId?: string }>;
export type LtmNoteLookup = Map<string, LtmNote>;
export type LtmDisplayLookupContext = {
  chats?: Map<string, Chat>;
  notes?: LtmNoteLookup;
  groups?: LtmGroupLookup;
};

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

function lookupGroupLabel(groupId: string | undefined, context?: LtmDisplayLookupContext) {
  if (!groupId) return null;
  return context?.groups?.get(groupId)?.label ?? "Grouped chat";
}

export function humanScopeLabel(note: Pick<LtmNote, "scope">, chatLookup?: Map<string, Chat>, groupLookup?: LtmGroupLookup) {
  const chatIds = [
    ...(note.scope.chatIds ?? []),
    ...(note.scope.chatId ? [note.scope.chatId] : []),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
  const chatLabels = chatIds.map((id) => chatLookup?.get(id)?.name).filter(Boolean);
  const parts = [
    ...chatLabels,
    ...(note.scope.characterIds?.length ? [`${note.scope.characterIds.length} character link${note.scope.characterIds.length === 1 ? "" : "s"}`] : []),
    ...(note.scope.groupId ? [groupLookup?.get(note.scope.groupId)?.label ?? "Grouped chat"] : []),
  ];
  return parts.length ? parts.join(", ") : "Available everywhere";
}

export function humanRelationLabel(relation: string) {
  if (relation === "extracted_from") return "Source";
  if (relation === "occurred_in") return "Occurred in";
  if (relation === "triggered_by") return "Triggered by";
  if (relation === "resolved_in") return "Resolved in";
  if (relation === "evidenced_by") return "Evidenced by";
  if (relation === "affects_relationship") return "Affects relationship";
  if (relation === "affects_character") return "Affects character";
  if (relation === "caused_by") return "Caused by";
  if (relation === "involves") return "Involves";
  if (relation === "blocks") return "Blocks";
  if (relation === "planted_in") return "Planted in";
  if (relation === "paid_off_in") return "Paid off in";
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

export function normalizeKeywordsInput(value: string) {
  const seen = new Set<string>();
  return value
    .split(/[,\n]+/)
    .map((item) => item.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .filter((item) => {
      const normalized = item.toLocaleLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
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
  keywords?: string[];
  sectionKey: string;
  sectionText: string;
  links?: LtmLink[];
  evidence?: string[];
  salience?: number;
  confidence?: number;
  subjects?: LtmSubject[];
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
    keywords: data.keywords ?? [],
    links: data.links ?? [],
    ...(data.subjects ? { subjects: data.subjects } : {}),
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
    keywords: draft.keywords,
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
  const resolved = resolveEvidenceDisplay(entry);
  return resolved.label;
}

type LtmResolvedEvidence = {
  label: string;
  rawValue?: string;
  tooltip?: string;
  sourceNoteId?: string;
  kind: "chat" | "chat_name" | "message_range" | "source_note" | "summary_entry" | "generic";
};

export function resolveEvidenceDisplay(entry: string, context?: LtmDisplayLookupContext): LtmResolvedEvidence {
  const colonIdx = entry.indexOf(":");
  if (colonIdx <= 0) {
    return {
      kind: "generic",
      label: friendlyIdentifier(entry),
      rawValue: entry,
      tooltip: entry,
    };
  }

  const prefix = entry.slice(0, colonIdx);
  const value = entry.slice(colonIdx + 1).trim();

  if (prefix === "chat_name") {
    return {
      kind: "chat_name",
      label: value || "Unknown chat",
      rawValue: value,
      tooltip: value || undefined,
    };
  }

  if (prefix === "chat") {
    const chat = context?.chats?.get(value);
    return {
      kind: "chat",
      label: chat?.name?.trim() || "Unknown chat",
      rawValue: value,
      tooltip: value || undefined,
    };
  }

  if (prefix === "message_range") {
    return {
      kind: "message_range",
      label: value ? `messages ${value}` : "Unknown messages",
      rawValue: value,
      tooltip: value || undefined,
    };
  }

  if (prefix === "source_note") {
    const note = context?.notes?.get(value);
    return {
      kind: "source_note",
      label: note ? humanMemoryTitle(note, context?.chats) : "Source note",
      rawValue: value,
      tooltip: value || undefined,
      sourceNoteId: value,
    };
  }

  if (prefix === "summary_entry") {
    const sourceNote = [...(context?.notes?.values() ?? [])].find((candidate) =>
      (candidate.sections.source?.evidence ?? []).includes(entry),
    );
    if (sourceNote) {
      return {
        kind: "summary_entry",
        label: `Chat summary: ${humanMemoryTitle(sourceNote, context?.chats)}`,
        rawValue: value,
        tooltip: value || undefined,
        sourceNoteId: sourceNote.id,
      };
    }
    return {
      kind: "summary_entry",
      label: "Chat summary",
      rawValue: value,
      tooltip: value || undefined,
    };
  }

  const friendlyValue = friendlyIdentifier(value);
  return {
    kind: "generic",
    label: `${sentenceCaseIdentifier(prefix)}: ${friendlyValue}`,
    rawValue: value,
    tooltip: value || undefined,
  };
}

export function humanEvidenceLabel(entry: string, chatLookup?: Map<string, Chat>, noteLookup?: LtmNoteLookup) {
  return resolveEvidenceDisplay(entry, { chats: chatLookup, notes: noteLookup }).label;
}

export function dedupeEvidenceEntries(entries: string[], context?: LtmDisplayLookupContext) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const resolved = resolveEvidenceDisplay(entry, context);
    const key = resolved.label.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function groupScopeLabel(groupId: string | undefined, context?: LtmDisplayLookupContext) {
  return lookupGroupLabel(groupId, context);
}
