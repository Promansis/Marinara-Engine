import { createHash } from "node:crypto";
import {
  DEFAULT_LTM_ALLOWED_STREAMS_BY_MODE,
  RELATIONSHIP_DIMENSIONS,
  uniqueLinks,
  type LtmEvidenceUnit,
  type LtmMode,
  type LtmNote,
} from "@marinara-engine/shared";
import { uniqueStrings } from "./ltm-utils.js";
import { noteIdForEvidenceUnit } from "./evidence-unit-validation.js";

type StructuredSection = {
  bucket: LtmEvidenceUnit["bucket"];
  lines: string[];
  fields: Map<string, string[]>;
};

type RelationshipHints = {
  dimensions?: NonNullable<LtmEvidenceUnit["dimensions"]>;
  dimensionChanges?: NonNullable<LtmEvidenceUnit["dimensionChanges"]>;
  links: LtmEvidenceUnit["links"];
};

type EvidenceUnitLink = LtmEvidenceUnit["links"][number];

type StructuredSummaryHints = {
  eventIds: string[];
  relationships: Map<string, RelationshipHints>;
  threadIds: string[];
  threadResolvers: Map<string, string>;
  characterSections: Map<string, string>;
  toneText?: string;
};

export type StructuredSummaryNormalizationResult = {
  units: LtmEvidenceUnit[];
  structured: boolean;
  addedUnits: number;
};

const STRUCTURED_BUCKETS = new Set<LtmEvidenceUnit["bucket"]>([
  "timeline_event",
  "character_fact",
  "relationship_state",
  "world_fact",
  "thread",
  "tone",
  "anchor",
]);
const HEADING_PATTERN = /^#{2,6}\s*([a-z][a-z0-9_ -]*)\b.*$/i;
const NOTE_ID_PREFIX_PATTERN = /^(?:timeline|thread|world|tone|rel|char)_/;
const THREAD_RESOLUTION_PATTERN =
  /\b(?:resolve|resolved|resolver|resolution|would resolve|will resolve|until|when|if|requires|needs|awaits|pending|unresolved|open question|pay off|payoff|future|follow-?up|goal|must|should|confess(?:ion|es|ed|ing)?|confront(?:s|ed|ing)?|explain(?:s|ed|ing|ation)?|updates?)\b/i;
const CHARACTER_ITEM_PATTERN =
  /\b(?:bracelet|necklace|ring|pendant|keepsake|token|gift|item|weapon|book|letter|photo|photograph|charm|key|tool|artifact)\b/i;
const CHARACTER_SUBJECT_SECTION_SUFFIXES = new Set(["facts", "core", "profile", "developments", "abilities", "items", "voice"]);
const WORLD_SUBJECT_SECTION_SUFFIXES = new Set(["facts", "lore", "rules", "items", "places", "locations"]);
const ANCHOR_SUBJECT_SECTION_SUFFIXES = new Set(["motif", "anchor", "callback", "callbacks"]);
const RELATIONSHIP_DIMENSION_KEYS = new Set<string>(RELATIONSHIP_DIMENSIONS);
const TIMELINE_LINK_RELATIONS = new Set<LtmEvidenceUnit["links"][number]["relation"]>([
  "caused_by",
  "evidenced_by",
  "planted_in",
  "paid_off_in",
  "resolved_in",
  "occurred_in",
  "triggered_by",
]);
const STRUCTURED_CHARACTER_LINK_KEYS = new Set<EvidenceUnitLink["relation"]>([
  "caused_by",
  "evidenced_by",
  "occurred_in",
  "triggered_by",
  "resolved_in",
  "planted_in",
  "paid_off_in",
]);
const TIMELINE_EVENT_ID_FIELD_KEYS = new Set(["event_id", "timeline_event_id", "timeline_id", "id", "subject"]);
const TIMELINE_EVENT_NON_ID_FIELD_KEYS = new Set([
  "event",
  "text",
  "summary",
  "description",
  "changed",
  "change",
  "caused_by",
  "evidenced_by",
  "triggered_by",
  "occurred_in",
  "resolved_in",
  "planted_in",
  "paid_off_in",
  "importance",
  "confidence",
  "salience",
  "status",
  "evidence",
  "links",
  "link",
  "source",
]);
const CHARACTER_STRUCTURED_SECTION_KEYS = new Set([
  ...CHARACTER_SUBJECT_SECTION_SUFFIXES,
  "progression",
  "details",
  "state",
]);
const STRUCTURED_IMPORTANCE_VALUES = new Set<LtmEvidenceUnit["importance"]>([
  "critical",
  "major",
  "moderate",
  "minor",
]);
const STRUCTURED_CHARACTER_METADATA_KEYS = new Set([
  "id",
  "subject",
  "character",
  "character_id",
  "section",
  "section_key",
  "stream",
  "importance",
  "confidence",
  "salience",
  "status",
  "evidence",
  "links",
  "link",
  "source",
]);
const EMPTY_LINK_VALUE_PATTERN = /^(?:n[_/]?a|none|null|unknown|unspecified|not_applicable)$/i;
const CHARACTER_DEVELOPMENT_PATTERN =
  /\b(?:almost\s+quit|once\b|learned|developed|started|began|became|stopped|quit|lost|gained|committed|decided|chose|promised|confronted|realized|recognised|recognized)\b/i;

export function normalizeStructuredSummaryEvidenceUnits({
  units,
  sourceText,
  sourceNote,
  sourceHash,
  allowedBuckets,
  mode,
  modes,
  addStructuredUnits = true,
}: {
  units: LtmEvidenceUnit[];
  sourceText: string;
  sourceNote?: LtmNote;
  sourceHash: string;
  allowedBuckets?: readonly LtmEvidenceUnit["bucket"][];
  mode?: LtmMode;
  modes?: readonly LtmMode[];
  addStructuredUnits?: boolean;
}): StructuredSummaryNormalizationResult {
  const sections = parseStructuredSections(sourceText);
  if (sections.length === 0) {
    return {
      units: normalizeCanonicalTargetLinks(units, units.map(normalizeTargetShapeUnit)),
      structured: false,
      addedUnits: 0,
    };
  }

  const allowed = new Set(allowedBuckets ?? DEFAULT_LTM_ALLOWED_STREAMS_BY_MODE[mode ?? modes?.[0] ?? "roleplay"]);
  const hints = structuredSummaryHints(sections);
  const normalized = normalizeCanonicalTargetLinks(units, units.map((unit) => normalizeUnit(unit, hints)));
  if (!addStructuredUnits) {
    return {
      units: normalized,
      structured: true,
      addedUnits: 0,
    };
  }
  const withStructuredCharacters = maybeAddStructuredCharacterUnits({
    units: normalized,
    sections,
    allowed,
    sourceNote,
    sourceHash,
    hints,
    deriveTimelineLinks: isRoleplayMode(mode, modes),
  });
  const withTone = maybeAddToneUnit({
    units: withStructuredCharacters,
    hints,
    allowed,
    sourceNote,
    sourceHash,
  });

  return {
    units: withTone,
    structured: true,
    addedUnits: withTone.length - normalized.length,
  };
}

function normalizeTargetShapeUnit(unit: LtmEvidenceUnit): LtmEvidenceUnit {
  if (unit.bucket === "character_fact") {
    const normalized = normalizeSubjectSectionSuffix({
      subjectId: stripUnitSubjectPrefix(unit.bucket, unit.subjectId),
      sectionKey: unit.sectionKey,
      suffixes: CHARACTER_SUBJECT_SECTION_SUFFIXES,
    });
    return {
      ...unit,
      subjectId: normalized.subjectId,
      sectionKey: normalized.sectionKey,
    };
  }

  if (unit.bucket === "world_fact") {
    const normalized = normalizeSubjectSectionSuffix({
      subjectId: stripUnitSubjectPrefix(unit.bucket, unit.subjectId),
      sectionKey: unit.sectionKey,
      suffixes: WORLD_SUBJECT_SECTION_SUFFIXES,
    });
    return {
      ...unit,
      subjectId: normalized.subjectId,
      sectionKey: normalized.sectionKey,
    };
  }

  if (unit.bucket === "anchor") {
    const normalized = normalizeSubjectSectionSuffix({
      subjectId: stripUnitSubjectPrefix(unit.bucket, unit.subjectId),
      sectionKey: unit.sectionKey,
      suffixes: ANCHOR_SUBJECT_SECTION_SUFFIXES,
    });
    return {
      ...unit,
      subjectId: normalized.subjectId,
      sectionKey: normalized.sectionKey,
    };
  }

  return unit;
}

function normalizeCanonicalTargetLinks(originalUnits: LtmEvidenceUnit[], normalizedUnits: LtmEvidenceUnit[]) {
  const targetRemaps = new Map<string, string>();
  for (const [index, originalUnit] of originalUnits.entries()) {
    const normalizedUnit = normalizedUnits[index];
    if (!normalizedUnit) continue;
    const originalNoteId = noteIdForEvidenceUnit(originalUnit);
    const normalizedNoteId = noteIdForEvidenceUnit(normalizedUnit);
    if (originalNoteId !== normalizedNoteId) {
      targetRemaps.set(originalNoteId, normalizedNoteId);
    }
  }
  if (targetRemaps.size === 0) return normalizedUnits;
  return normalizedUnits.map((unit) => {
    const links = unit.links.map((link) => {
      const target = targetRemaps.get(link.target);
      return target ? { ...link, target } : link;
    });
    return links.some((link, index) => link.target !== unit.links[index]?.target)
      ? { ...unit, links: uniqueLinks(links) }
      : unit;
  });
}

function parseStructuredSections(sourceText: string) {
  const sections: StructuredSection[] = [];
  let current: { bucket: LtmEvidenceUnit["bucket"]; lines: string[] } | null = null;

  for (const line of sourceText.split(/\r?\n/)) {
    const bucket = structuredBucketFromHeading(line);
    if (bucket) {
      if (current) sections.push(sectionFromLines(current.bucket, current.lines));
      current = { bucket, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }

  if (current) sections.push(sectionFromLines(current.bucket, current.lines));
  return sections;
}

function structuredBucketFromHeading(line: string) {
  const match = line.match(HEADING_PATTERN);
  if (!match?.[1]) return null;
  const bucket = normalizeFieldKey(match[1]);
  return STRUCTURED_BUCKETS.has(bucket as LtmEvidenceUnit["bucket"]) ? (bucket as LtmEvidenceUnit["bucket"]) : null;
}

function sectionFromLines(bucket: LtmEvidenceUnit["bucket"], lines: string[]): StructuredSection {
  const fields = new Map<string, string[]>();
  for (const line of lines) {
    const parsed = parseFieldLine(line);
    if (!parsed) continue;
    for (const key of parsed.keys) {
      const values = fields.get(key) ?? [];
      values.push(parsed.value);
      fields.set(key, values);
    }
  }
  return { bucket, lines, fields };
}

function parseFieldLine(line: string) {
  const cleaned = cleanListLine(line);
  const match = cleaned.match(/^([A-Za-z][A-Za-z0-9_ /|-]{0,100}):\s*(.+)$/);
  if (!match?.[1] || !match[2]?.trim()) return null;
  return {
    keys: match[1]
      .split("|")
      .map(normalizeFieldKey)
      .filter(Boolean),
    value: match[2].trim(),
  };
}

function structuredSummaryHints(sections: StructuredSection[]): StructuredSummaryHints {
  const eventIds = new Set<string>();
  const relationships = new Map<string, RelationshipHints>();
  const threadIds = new Set<string>();
  const threadResolvers = new Map<string, string>();
  const characterSections = new Map<string, string>();
  let toneText: string | undefined;

  for (const section of sections) {
    if (section.bucket === "timeline_event") {
      for (const value of eventIdValues(section)) {
        const id = stripUnitSubjectPrefix("timeline_event", normalizeIdentifier(value, ""));
        if (id) eventIds.add(id);
      }
    }
  }

  for (const section of sections) {
    if (section.bucket === "timeline_event") continue;

    if (section.bucket === "relationship_state") {
      const subject = relationshipSubject(section);
      if (!subject) continue;
      relationships.set(subject, {
        dimensions: parseDimensionMap(fieldValues(section, ["dimensions", "dimension"]), { min: 0, max: 100 }),
        dimensionChanges: parseDimensionMap(
          fieldValues(section, ["dimension_changes", "dimensionchanges", "changes", "change", "deltas", "delta"]),
          { min: -100, max: 100 },
        ),
        links: structuredLinks(section, ["caused_by"]),
      });
      continue;
    }

    if (section.bucket === "thread") {
      const subject = threadSubject(section);
      const resolver = firstFieldValue(section, ["resolver", "resolution", "resolves_when", "resolve_when"]);
      if (subject) threadIds.add(subject);
      if (subject && resolver) threadResolvers.set(subject, resolver);
      continue;
    }

    if (section.bucket === "character_fact") {
      const subject = characterSubject(section);
      const sectionKey = normalizeSectionKey(firstFieldValue(section, ["section", "section_key", "stream"]) ?? "", "");
      if (subject && sectionKey) characterSections.set(subject, sectionKey);
      continue;
    }

    if (section.bucket === "tone") {
      toneText = toneText ?? renderToneText(section);
    }
  }

  return {
    eventIds: [...eventIds].sort((a, b) => b.length - a.length),
    relationships,
    threadIds: [...threadIds].sort((a, b) => b.length - a.length),
    threadResolvers,
    characterSections,
    toneText,
  };
}

function normalizeUnit(unit: LtmEvidenceUnit, hints: StructuredSummaryHints): LtmEvidenceUnit {
  const links = normalizeLinks(unit.links, hints);

  if (unit.bucket === "timeline_event") {
    return {
      ...unit,
      subjectId: normalizeTimelineSubject(unit.subjectId, hints),
      sectionKey: "event",
      links,
    };
  }

  if (unit.bucket === "relationship_state") {
    const subjectId = stripUnitSubjectPrefix(unit.bucket, unit.subjectId);
    const relationship = relationshipHintsFor(subjectId, hints);
    return {
      ...unit,
      subjectId,
      sectionKey: "state",
      links: uniqueLinks([...links, ...(relationship?.links ?? [])]),
      dimensions: relationship?.dimensions ?? unit.dimensions,
      dimensionChanges: relationship?.dimensionChanges ?? unit.dimensionChanges,
    };
  }

  if (unit.bucket === "thread") {
    const subjectId = normalizeThreadSubject(unit.subjectId, hints);
    const resolver = hints.threadResolvers.get(subjectId);
    return {
      ...unit,
      subjectId,
      text: resolver ? withResolverText(unit.text, resolver) : unit.text,
      links,
    };
  }

  if (unit.bucket === "character_fact") {
    const normalized = normalizeSubjectSectionSuffix({
      subjectId: stripUnitSubjectPrefix(unit.bucket, unit.subjectId),
      sectionKey: unit.sectionKey,
      suffixes: CHARACTER_SUBJECT_SECTION_SUFFIXES,
    });
    return {
      ...unit,
      subjectId: normalized.subjectId,
      sectionKey: characterSectionKey({ ...unit, sectionKey: normalized.sectionKey }, normalized.subjectId, hints),
      links,
    };
  }

  if (unit.bucket === "world_fact") {
    const normalized = normalizeSubjectSectionSuffix({
      subjectId: stripUnitSubjectPrefix(unit.bucket, unit.subjectId),
      sectionKey: unit.sectionKey,
      suffixes: WORLD_SUBJECT_SECTION_SUFFIXES,
    });
    return {
      ...unit,
      subjectId: normalized.subjectId,
      sectionKey: normalized.sectionKey,
      links,
    };
  }

  if (unit.bucket === "anchor") {
    const normalized = normalizeSubjectSectionSuffix({
      subjectId: stripUnitSubjectPrefix(unit.bucket, unit.subjectId),
      sectionKey: unit.sectionKey,
      suffixes: ANCHOR_SUBJECT_SECTION_SUFFIXES,
    });
    return {
      ...unit,
      subjectId: normalized.subjectId,
      sectionKey: normalized.sectionKey,
      links,
    };
  }

  return {
    ...unit,
    subjectId: stripUnitSubjectPrefix(unit.bucket, unit.subjectId),
    links,
  };
}

function normalizeSubjectSectionSuffix({
  subjectId,
  sectionKey,
  suffixes,
}: {
  subjectId: string;
  sectionKey: string;
  suffixes: Set<string>;
}) {
  const currentSection = normalizeSectionKey(sectionKey, sectionKey);
  const suffix = matchingSectionSuffix(subjectId, suffixes);
  if (!suffix) return { subjectId, sectionKey: currentSection };

  const nextSubject = subjectId.slice(0, -(suffix.length + 1)).replace(/_+$/g, "");
  if (!nextSubject) return { subjectId, sectionKey: currentSection };
  return {
    subjectId: nextSubject,
    sectionKey: currentSection === suffix || ["facts", "motif", "anchor"].includes(currentSection) ? suffix : currentSection,
  };
}

function matchingSectionSuffix(subjectId: string, suffixes: Set<string>) {
  for (const suffix of [...suffixes].sort((a, b) => b.length - a.length)) {
    if (subjectId.endsWith(`_${suffix}`)) return suffix;
  }
  return null;
}

function maybeAddStructuredCharacterUnits({
  units,
  sections,
  allowed,
  sourceNote,
  sourceHash,
  hints,
  deriveTimelineLinks,
}: {
  units: LtmEvidenceUnit[];
  sections: StructuredSection[];
  allowed: Set<LtmEvidenceUnit["bucket"]>;
  sourceNote?: LtmNote;
  sourceHash: string;
  hints: StructuredSummaryHints;
  deriveTimelineLinks: boolean;
}) {
  if (!allowed.has("character_fact") || !sourceNote) return units;

  const next = [...units];
  const seen = new Set(next.filter((unit) => unit.bucket === "character_fact").map(characterUnitIdentity));

  for (const section of sections) {
    if (section.bucket !== "character_fact") continue;
    for (const line of section.lines) {
      const unit = parseStructuredCharacterLine(line, sourceNote, sourceHash, {
        hints,
        deriveTimelineLinks,
      });
      if (!unit) continue;
      const identity = characterUnitIdentity(unit);
      if (seen.has(identity)) continue;
      seen.add(identity);
      next.push(unit);
    }
  }

  return next;
}

function parseStructuredCharacterLine(
  line: string,
  sourceNote: LtmNote,
  sourceHash: string,
  options: { hints: StructuredSummaryHints; deriveTimelineLinks: boolean },
): LtmEvidenceUnit | null {
  const cleaned = stripInlineMarkup(cleanListLine(line));
  if (!cleaned || isMetadataOnlyLine(cleaned)) return null;

  const importanceResult = extractStructuredImportance(cleaned);
  let subjectId = "";
  let sectionKey = "";
  let importance = importanceResult.importance;
  let confidence = 0.9;
  let salience = 0.7;
  const textParts: string[] = [];
  const links: LtmEvidenceUnit["links"] = [];
  const missingTimelineLinkRelations: EvidenceUnitLink["relation"][] = [];
  const segments = importanceResult.text
    .split("|")
    .map((segment) => stripInlineMarkup(segment))
    .filter(Boolean);

  for (const [index, segment] of segments.entries()) {
    const parsed = parseStructuredSegment(segment);
    if (!parsed) {
      const segmentIdentifier = normalizeIdentifier(segment, "");
      const segmentSection = normalizeSectionKey(segment, "");
      if (!subjectId && (index === 0 || NOTE_ID_PREFIX_PATTERN.test(segmentIdentifier))) {
        subjectId = segmentIdentifier;
        continue;
      }
      if (!sectionKey && CHARACTER_STRUCTURED_SECTION_KEYS.has(segmentSection)) {
        sectionKey = segmentSection;
        continue;
      }
      textParts.push(segment);
      continue;
    }

    const key = normalizeFieldKey(parsed.key);
    const value = stripInlineMarkup(parsed.value);
    if (!value) continue;

    if (["id", "subject", "character", "character_id"].includes(key)) {
      subjectId = normalizeIdentifier(value, subjectId);
      continue;
    }
    if (["section", "section_key", "stream"].includes(key)) {
      sectionKey = normalizeSectionKey(value, sectionKey);
      continue;
    }
    if (key === "importance") {
      importance = parseStructuredImportanceValue(value, importance);
      continue;
    }
    if (key === "confidence") {
      confidence = parseStructuredScore(value, confidence);
      continue;
    }
    if (key === "salience") {
      salience = parseStructuredScore(value, salience);
      continue;
    }
    if (["status", "evidence", "links", "link", "source"].includes(key)) {
      continue;
    }
    if (STRUCTURED_CHARACTER_LINK_KEYS.has(key as EvidenceUnitLink["relation"])) {
      const relation = key as EvidenceUnitLink["relation"];
      const explicitLink = timelineLinkFromValue(value, relation);
      if (explicitLink) {
        links.push(explicitLink);
      } else if (options.deriveTimelineLinks && isEmptyLinkValue(value)) {
        missingTimelineLinkRelations.push(relation);
      }
      continue;
    }

    const keyIdentifier = normalizeIdentifier(key, "");
    const keySection = normalizeSectionKey(key, "");
    if (index === 0 && !subjectId && keyIdentifier) {
      subjectId = keyIdentifier;
      textParts.push(value);
      continue;
    }
    if (CHARACTER_STRUCTURED_SECTION_KEYS.has(keySection)) {
      sectionKey = sectionKey || keySection;
      textParts.push(value);
      continue;
    }
    if (!STRUCTURED_CHARACTER_METADATA_KEYS.has(key)) {
      textParts.push(segment);
    }
  }

  const normalizedSubject = stripUnitSubjectPrefix("character_fact", normalizeIdentifier(subjectId, ""));
  const normalizedSection = structuredCharacterSectionKey(normalizeSectionKey(sectionKey, "facts"), textParts.join(" | "));
  const text = textParts.join(" | ").replace(/\s+/g, " ").trim();
  if (!normalizedSubject || !normalizedSection || !text) return null;
  for (const relation of missingTimelineLinkRelations) {
    const derived = deriveTimelineLinkForStructuredCharacter({
      line: cleaned,
      relation,
      sectionKey: normalizedSection,
      hints: options.hints,
    });
    if (derived) links.push(derived);
  }
  const normalizedLinks = links.map((link) =>
    TIMELINE_LINK_RELATIONS.has(link.relation)
      ? { ...link, relation: characterTimelineRelation(normalizedSection, link.relation) }
      : link,
  );

  return {
    id: deterministicUuid(`structured-character:${sourceNote.id}:${sourceHash}:${normalizedSubject}:${normalizedSection}:${text}`),
    bucket: "character_fact",
    subjectId: normalizedSubject,
    sectionKey: normalizedSection,
    text: text.slice(0, 2_000),
    importance,
    keywords: [],
    evidence: sourceEvidence(sourceNote),
    confidence,
    salience,
    status: "active",
    links: uniqueLinks(normalizedLinks),
    sourceHash,
  };
}

function characterUnitIdentity(unit: LtmEvidenceUnit) {
  return [
    stripUnitSubjectPrefix("character_fact", unit.subjectId),
    normalizeSectionKey(unit.sectionKey, "facts"),
    normalizeComparableText(unit.text),
  ].join("|");
}

function normalizeComparableText(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseStructuredSegment(segment: string) {
  const match = segment.match(/^([^:]{1,120}):\s*(.+)$/);
  if (!match?.[1] || !match[2]?.trim()) return null;
  return {
    key: match[1].trim(),
    value: match[2].trim(),
  };
}

function extractStructuredImportance(text: string) {
  const match = text.match(/^\[([A-Za-z]+)\]\s*(.+)$/);
  return {
    importance: parseStructuredImportanceValue(match?.[1] ?? "", "moderate"),
    text: match?.[2]?.trim() ?? text,
  };
}

function parseStructuredImportanceValue(
  value: string,
  fallback: LtmEvidenceUnit["importance"],
): LtmEvidenceUnit["importance"] {
  const normalized = normalizeFieldKey(value);
  return STRUCTURED_IMPORTANCE_VALUES.has(normalized as LtmEvidenceUnit["importance"])
    ? (normalized as LtmEvidenceUnit["importance"])
    : fallback;
}

function parseStructuredScore(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed >= 0 && parsed <= 1) return parsed;
  if (parsed > 1 && parsed <= 100) return parsed / 100;
  return fallback;
}

function stripInlineMarkup(value: string) {
  return value.trim().replace(/^`+|`+$/g, "").trim();
}

function maybeAddToneUnit({
  units,
  hints,
  allowed,
  sourceNote,
  sourceHash,
}: {
  units: LtmEvidenceUnit[];
  hints: StructuredSummaryHints;
  allowed: Set<LtmEvidenceUnit["bucket"]>;
  sourceNote?: LtmNote;
  sourceHash: string;
}): LtmEvidenceUnit[] {
  if (!allowed.has("tone") || !hints.toneText || !sourceNote) return units;
  if (units.some((unit) => unit.bucket === "tone")) {
    return units.map((unit) =>
      unit.bucket === "tone"
        ? {
            ...unit,
            subjectId: "session",
            sectionKey: "observations",
          }
        : unit,
    );
  }
  const toneUnit: LtmEvidenceUnit = {
    id: deterministicUuid(`structured-tone:${sourceNote.id}:${sourceHash}:${hints.toneText}`),
    bucket: "tone",
    subjectId: "session",
    sectionKey: "observations",
    text: hints.toneText,
    importance: "moderate",
    keywords: [],
    evidence: sourceEvidence(sourceNote),
    confidence: 0.9,
    salience: 0.7,
    status: "active",
    links: [],
    sourceHash,
  };
  return [
    ...units,
    toneUnit,
  ];
}

function eventIdValues(section: StructuredSection) {
  const explicit = fieldValues(section, ["event_id", "timeline_event_id", "timeline_id"]);
  if (explicit.length > 0) return explicit;
  const ids = fieldValues(section, ["id"]);
  if (ids.length > 0) return ids;
  const subjectFields = fieldValues(section, ["subject"]).filter((value) => normalizeIdentifier(value, "").includes("_"));
  const lineIds = section.lines.flatMap(timelineEventIdsFromLine);
  return uniqueStrings([...subjectFields, ...lineIds]);
}

function timelineEventIdsFromLine(line: string) {
  const cleaned = stripInlineMarkup(cleanListLine(line));
  if (!cleaned || isMetadataOnlyLine(cleaned)) return [];
  const importanceResult = extractStructuredImportance(cleaned);
  const segments = importanceResult.text
    .split("|")
    .map((segment) => stripInlineMarkup(segment))
    .filter(Boolean);
  const ids: string[] = [];
  for (const segment of segments) {
    const parsed = parseStructuredSegment(segment);
    if (!parsed) {
      continue;
    }
    const key = normalizeFieldKey(parsed.key);
    if (TIMELINE_EVENT_ID_FIELD_KEYS.has(key)) {
      const explicitId = stripUnitSubjectPrefix("timeline_event", normalizeIdentifier(parsed.value, ""));
      if (explicitId) ids.push(explicitId);
      continue;
    }
    if (key && !TIMELINE_EVENT_NON_ID_FIELD_KEYS.has(key) && key.includes("_")) {
      ids.push(stripUnitSubjectPrefix("timeline_event", key));
    }
  }
  return ids;
}

function relationshipSubject(section: StructuredSection) {
  const raw = firstFieldValue(section, ["relationship_id", "subject", "id"]);
  return raw ? stripUnitSubjectPrefix("relationship_state", normalizeIdentifier(raw, "")) : null;
}

function threadSubject(section: StructuredSection) {
  const raw = firstFieldValue(section, ["thread_id", "topic_id", "subject", "id"]);
  return raw ? stripUnitSubjectPrefix("thread", normalizeIdentifier(raw, "")) : null;
}

function characterSubject(section: StructuredSection) {
  const raw = firstFieldValue(section, ["character_id", "character", "subject", "id"]);
  return raw ? stripUnitSubjectPrefix("character_fact", normalizeIdentifier(raw, "")) : null;
}

function relationshipHintsFor(subjectId: string, hints: StructuredSummaryHints) {
  return hints.relationships.get(subjectId) ?? hints.relationships.get(stripUnitSubjectPrefix("relationship_state", subjectId));
}

function normalizeTimelineSubject(subjectId: string, hints: StructuredSummaryHints) {
  const stripped = stripUnitSubjectPrefix("timeline_event", subjectId);
  for (const eventId of hints.eventIds) {
    if (stripped === eventId || stripped.endsWith(`_${eventId}`) || stripped.includes(`_${eventId}_`)) {
      return eventId;
    }
  }
  return stripped;
}

function normalizeThreadSubject(subjectId: string, hints: StructuredSummaryHints) {
  const stripped = stripUnitSubjectPrefix("thread", subjectId);
  for (const threadId of hints.threadIds) {
    if (stripped === threadId || stripped.endsWith(`_${threadId}`) || stripped.includes(`_${threadId}_`)) {
      return threadId;
    }
  }
  return hints.threadIds.length === 1 ? hints.threadIds[0]! : stripped;
}

function characterSectionKey(unit: LtmEvidenceUnit, subjectId: string, hints: StructuredSummaryHints) {
  const sourceSection = hints.characterSections.get(subjectId);
  if (sourceSection) return sourceSection;
  return structuredCharacterSectionKey(unit.sectionKey, unit.text);
}

function structuredCharacterSectionKey(sectionKey: string, text: string) {
  if (!["facts", "core", "profile"].includes(sectionKey)) return sectionKey;
  if (CHARACTER_ITEM_PATTERN.test(text)) return "items";
  if (CHARACTER_DEVELOPMENT_PATTERN.test(text)) return "developments";
  return sectionKey;
}

function normalizeLinks(links: LtmEvidenceUnit["links"], hints: StructuredSummaryHints) {
  return uniqueLinks(
    links.map((link) => ({
      ...link,
      target: normalizeLinkTarget(link.target, link.relation, hints),
    })),
  );
}

function structuredLinks(section: StructuredSection, keys: string[]) {
  return keys.flatMap((key) =>
    fieldValues(section, [key]).flatMap((value) => {
      const link = timelineLinkFromValue(value, key as EvidenceUnitLink["relation"]);
      return link ? [link] : [];
    }),
  );
}

function timelineLinkFromValue(value: string, relation: EvidenceUnitLink["relation"]): EvidenceUnitLink | null {
  const target = timelineTargetFromValue(value);
  return target ? { target, relation } : null;
}

function timelineTargetFromValue(value: string) {
  if (isEmptyLinkValue(value)) return null;
  const identifier = normalizeIdentifier(value, "");
  if (!identifier) return null;
  if (NOTE_ID_PREFIX_PATTERN.test(identifier)) return identifier;
  const subject = stripUnitSubjectPrefix("timeline_event", identifier);
  return `timeline_${subject}`;
}

function deriveTimelineLinkForStructuredCharacter({
  line,
  relation,
  sectionKey,
  hints,
}: {
  line: string;
  relation: EvidenceUnitLink["relation"];
  sectionKey: string;
  hints: StructuredSummaryHints;
}): EvidenceUnitLink | null {
  const target = exactTimelineTargetFromLine(line, hints) ?? singleTimelineTarget(hints);
  if (!target) return null;
  return {
    target,
    relation: characterTimelineRelation(sectionKey, relation),
  };
}

function exactTimelineTargetFromLine(line: string, hints: StructuredSummaryHints) {
  const normalizedLine = normalizeFieldKey(line);
  const matches = hints.eventIds.filter((eventId) => {
    const noteId = `timeline_${eventId}`;
    return normalizedLine === eventId || normalizedLine === noteId || normalizedLine.includes(eventId) || normalizedLine.includes(noteId);
  });
  return matches.length === 1 ? `timeline_${matches[0]}` : null;
}

function singleTimelineTarget(hints: StructuredSummaryHints) {
  return hints.eventIds.length === 1 ? `timeline_${hints.eventIds[0]}` : null;
}

function characterTimelineRelation(
  sectionKey: string,
  requestedRelation: EvidenceUnitLink["relation"],
): EvidenceUnitLink["relation"] {
  if (requestedRelation !== "caused_by") return requestedRelation;
  return ["developments", "progression"].includes(sectionKey) ? "caused_by" : "evidenced_by";
}

function normalizeLinkTarget(
  target: string,
  relation: LtmEvidenceUnit["links"][number]["relation"],
  hints: Pick<StructuredSummaryHints, "eventIds" | "threadIds">,
) {
  const identifier = normalizeIdentifier(target, "");
  if (!identifier) return target;
  if (NOTE_ID_PREFIX_PATTERN.test(identifier)) return identifier;
  if (hints.eventIds.includes(identifier) || TIMELINE_LINK_RELATIONS.has(relation)) return `timeline_${identifier}`;
  if (hints.threadIds.includes(identifier) || relation === "blocks") return `thread_${identifier}`;
  if (relation === "affects_character") return `char_${identifier}`;
  if (relation === "affects_relationship") return `rel_${identifier}`;
  return identifier;
}

function withResolverText(text: string, resolver: string) {
  if (THREAD_RESOLUTION_PATTERN.test(text)) return text;
  const trimmed = text.trim().replace(/[.?!]\s*$/u, "");
  return `${trimmed}. Resolver: ${resolver.trim().replace(/[.?!]\s*$/u, "")}.`;
}

function parseDimensionMap(values: string[], bounds: { min: number; max: number }) {
  const dimensions: Record<string, number> = {};
  for (const value of values) {
    for (const match of value.matchAll(/([A-Za-z][A-Za-z_ ]*)\s*(?::|=)?\s*([+-]?\d{1,3})/g)) {
      const key = normalizeFieldKey(match[1] ?? "");
      const parsed = Number.parseInt(match[2] ?? "", 10);
      if (!RELATIONSHIP_DIMENSION_KEYS.has(key) || !Number.isInteger(parsed)) continue;
      if (parsed < bounds.min || parsed > bounds.max) continue;
      dimensions[key] = parsed;
    }
  }
  return Object.keys(dimensions).length > 0 ? dimensions : undefined;
}

function renderToneText(section: StructuredSection) {
  const lines = uniqueStrings(
    section.lines
      .map(cleanListLine)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !isMetadataOnlyLine(line)),
  );
  return lines.join("; ").slice(0, 2_000).trim() || undefined;
}

function isRoleplayMode(mode?: LtmMode, modes?: readonly LtmMode[]) {
  return (mode ?? modes?.[0] ?? "roleplay") === "roleplay";
}

function isEmptyLinkValue(value: string) {
  const normalized = normalizeFieldKey(value);
  return !normalized || EMPTY_LINK_VALUE_PATTERN.test(normalized);
}

function isMetadataOnlyLine(line: string) {
  const parsed = parseFieldLine(line);
  if (!parsed) return false;
  return parsed.keys.every((key) =>
    [
      "id",
      "subject",
      "source",
      "importance",
      "confidence",
      "salience",
      "status",
      "evidence",
      "links",
    ].includes(key),
  );
}

function fieldValues(section: StructuredSection, keys: string[]) {
  return keys.flatMap((key) => section.fields.get(key) ?? []);
}

function firstFieldValue(section: StructuredSection, keys: string[]) {
  return fieldValues(section, keys)[0]?.trim();
}

function normalizeFieldKey(value: string) {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function normalizeIdentifier(value: string, fallback: string) {
  const normalized = normalizeFieldKey(value).slice(0, 120).replace(/_+$/g, "");
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(normalized) ? normalized : fallback;
}

function normalizeSectionKey(value: string, fallback: string) {
  const normalized = normalizeFieldKey(value).slice(0, 80).replace(/_+$/g, "");
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(normalized) ? normalized : fallback;
}

function stripUnitSubjectPrefix(bucket: LtmEvidenceUnit["bucket"], subjectId: string) {
  const prefix = prefixForBucket(bucket);
  return subjectId.startsWith(`${prefix}_`) ? subjectId.slice(prefix.length + 1) : subjectId;
}

function prefixForBucket(bucket: LtmEvidenceUnit["bucket"]) {
  if (bucket === "timeline_event") return "timeline";
  if (bucket === "thread") return "thread";
  if (bucket === "world_fact") return "world";
  if (bucket === "tone") return "tone";
  if (bucket.startsWith("relationship_")) return "rel";
  return "char";
}

function cleanListLine(line: string) {
  return line.replace(/^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)+/u, "").trim();
}

function sourceEvidence(note: LtmNote) {
  return uniqueStrings([
    `source_note:${note.id}`,
    ...(note.sections.source?.evidence ?? []),
    ...(note.sections.summary?.evidence ?? []),
  ]).slice(0, 20);
}

function deterministicUuid(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
