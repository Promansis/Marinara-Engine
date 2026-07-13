import {
  getLtmScopeChatIds,
  ltmNoteSchema,
  uniqueLinks,
  withMergedLtmScopeLinks,
  type LtmConflict,
  type LtmDraftMutation,
  type LtmDraftSource,
  type LtmLink,
  type LtmMode,
  type LtmNote,
  type LtmScope,
  type LtmSection,
} from "@marinara-engine/shared";
import { stableStringify } from "./chunking.js";
import { uniqueStrings } from "./ltm-utils.js";
import { canUpdateLtmScopedTarget } from "./scoped-targets.js";
import { subjectsEqual } from "./subject-identity.js";

export type LtmMutationDisposition = "new" | "merge" | "rewrite";

export type LtmDraftProjectionContext = {
  source: LtmDraftSource;
  scope: LtmScope;
  modes: LtmMode[];
};

export type LtmMutationProjection = {
  mutationId: string;
  noteId: string;
  disposition: LtmMutationDisposition;
  changes: LtmProjectedChange[];
};

export type LtmProjectedChange = {
  kind: "section" | "link" | "keywords" | "status" | "subjects";
  key: string;
  before?: string;
  after: string;
};

export type LtmProjectedNoteMutationGroup = {
  noteId: string;
  before: LtmNote | null;
  after: LtmNote;
  changed: boolean;
  mutations: LtmMutationProjection[];
};

export class LtmDraftProjectionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LtmDraftProjectionError";
  }
}

export function noteIdForLtmDraftMutation(mutation: LtmDraftMutation) {
  return mutation.kind === "create_note" ? mutation.note.id : mutation.noteId;
}

export function groupLtmDraftMutationsByNote(mutations: LtmDraftMutation[]) {
  const groups = new Map<string, LtmDraftMutation[]>();
  for (const mutation of mutations) {
    const noteId = noteIdForLtmDraftMutation(mutation);
    const group = groups.get(noteId) ?? [];
    group.push(mutation);
    groups.set(noteId, group);
  }
  return [...groups.entries()].map(([noteId, group]) => ({
    noteId,
    mutations: [
      ...group.filter((mutation) => mutation.kind === "create_note"),
      ...group.filter((mutation) => mutation.kind !== "create_note"),
    ],
  }));
}

export function projectLtmDraftMutationGroup(options: {
  existing: LtmNote | null;
  mutations: LtmDraftMutation[];
  context: LtmDraftProjectionContext;
  timestamp: string;
}): LtmProjectedNoteMutationGroup {
  if (options.mutations.length === 0) {
    throw new LtmDraftProjectionError("Cannot project an empty mutation group.", "empty_mutation_group");
  }
  const noteId = noteIdForLtmDraftMutation(options.mutations[0]!);
  if (options.mutations.some((mutation) => noteIdForLtmDraftMutation(mutation) !== noteId)) {
    throw new LtmDraftProjectionError("A projected mutation group must target one note.", "mixed_mutation_targets");
  }

  let working = options.existing ? cloneNote(options.existing) : null;
  const projections: LtmMutationProjection[] = [];
  for (const mutation of options.mutations) {
    const before = working;
    const disposition = dispositionForMutation(before, mutation);
    working = projectMutation(before, mutation, options.context, options.timestamp);
    projections.push({
      mutationId: mutation.id,
      noteId,
      disposition,
      changes: changesForMutation(before, working, mutation),
    });
  }
  if (!working) {
    throw new LtmDraftProjectionError(`Long-term memory mutation target not found: ${noteId}`, "missing_target");
  }

  working = {
    ...working,
    links: withSourceLink(noteId, working.links, options.context.source.sourceNoteId),
  };
  const changed = !options.existing || !notesSemanticallyEqual(options.existing, working);
  if (!changed && options.existing) {
    return { noteId, before: options.existing, after: options.existing, changed: false, mutations: projections };
  }

  const candidate = options.existing
    ? {
        ...working,
        id: options.existing.id,
        type: options.existing.type,
        createdAt: options.existing.createdAt,
        updatedAt: options.timestamp,
        version: options.existing.version + 1,
      }
    : working;
  try {
    const after = ltmNoteSchema.parse(candidate);
    return { noteId, before: options.existing, after, changed: true, mutations: projections };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Projected note failed validation.";
    throw new LtmDraftProjectionError(
      `Long-term memory projection for ${noteId} exceeds its storage contract: ${message}`,
      "projection_limit_exceeded",
    );
  }
}

export function projectLtmDraftOntoNotes(options: {
  notes: ReadonlyMap<string, LtmNote>;
  mutations: LtmDraftMutation[];
  context: LtmDraftProjectionContext;
  timestamp: string;
}) {
  const notes = new Map(options.notes);
  const projections: LtmProjectedNoteMutationGroup[] = [];
  for (const group of groupLtmDraftMutationsByNote(options.mutations)) {
    const projection = projectLtmDraftMutationGroup({
      existing: notes.get(group.noteId) ?? null,
      mutations: group.mutations,
      context: options.context,
      timestamp: options.timestamp,
    });
    notes.set(group.noteId, projection.after);
    projections.push(projection);
  }
  return { notes, projections };
}

export function isAdditiveLtmSection(note: Pick<LtmNote, "type" | "tags">, sectionKey: string) {
  if (note.type === "timeline_event") return true;
  if (note.type === "character" && ["facts", "developments", "abilities", "voice"].includes(sectionKey)) {
    return true;
  }
  if (note.type === "relationship" && sectionKey === "history") return true;
  if (note.type === "world" && sectionKey === "facts") return true;
  if (note.type === "tone" && sectionKey === "observations") return true;
  return note.tags.includes("anchor") || sectionKey === "anchors";
}

function projectMutation(
  current: LtmNote | null,
  mutation: LtmDraftMutation,
  context: LtmDraftProjectionContext,
  timestamp: string,
) {
  if (mutation.kind === "create_note") {
    if (!canUpdateLtmScopedTarget(mutation.note.scope, context.scope)) {
      throw new LtmDraftProjectionError(
        `Long-term memory draft cannot create ${mutation.note.id} because its scope does not match the draft.`,
        "scope_mismatch",
      );
    }
    const incoming = ltmNoteSchema.parse({
      ...mutation.note,
      createdAt: mutation.note.createdAt ?? timestamp,
      updatedAt: mutation.note.updatedAt ?? timestamp,
      version: mutation.note.version ?? 1,
    });
    if (!current) return incoming;
    assertCompatibleCreate(current, incoming);
    const sections = { ...current.sections };
    for (const [sectionKey, section] of Object.entries(incoming.sections)) {
      sections[sectionKey] = mergeProjectedSection({
        existing: current.sections[sectionKey],
        incoming: section,
        additive: isAdditiveLtmSection(current, sectionKey),
        confidence: mutation.confidence,
        timestamp,
      });
    }
    return {
      ...current,
      title: current.title ?? incoming.title,
      status: current.status === "archived" ? current.status : incoming.status,
      modes: uniqueStrings([...current.modes, ...incoming.modes]) as LtmMode[],
      scope: mergeScopes(current.scope, incoming.scope),
      tags: uniqueStrings([...current.tags, ...incoming.tags]),
      keywords: uniqueCaseInsensitiveStrings([...current.keywords, ...incoming.keywords]),
      links: uniqueLinks([...current.links, ...incoming.links]),
      sections,
      conflicts: optionalConflicts(uniqueConflicts([...(current.conflicts ?? []), ...(incoming.conflicts ?? [])])),
      subjects: current.subjects ?? incoming.subjects,
    };
  }

  if (!current) {
    throw new LtmDraftProjectionError(
      `Long-term memory mutation target not found: ${mutation.noteId}`,
      "missing_target",
    );
  }
  if (!canUpdateLtmScopedTarget(current.scope, context.scope)) {
    throw new LtmDraftProjectionError(
      `Long-term memory draft cannot mutate ${current.id} because it belongs to another scope.`,
      "scope_mismatch",
    );
  }

  if (mutation.kind === "append_section") {
    const incoming: LtmSection = {
      text: mutation.text,
      updatedAt: timestamp,
      salience: mutation.salience,
      confidence: mutation.confidence,
      importance: mutation.importance,
      dimensions: mutation.dimensions,
      dimensionChanges: mutation.dimensionChanges,
      evidence: mutation.evidence,
    };
    return {
      ...current,
      sections: {
        ...current.sections,
        [mutation.sectionKey]: mergeProjectedSection({
          existing: current.sections[mutation.sectionKey],
          incoming,
          additive: isAdditiveLtmSection(current, mutation.sectionKey),
          confidence: mutation.confidence,
          timestamp,
        }),
      },
    };
  }
  if (mutation.kind === "update_section") {
    const incoming = {
      ...mutation.section,
      evidence: uniqueStrings([...(mutation.section.evidence ?? []), ...mutation.evidence]),
    };
    return {
      ...current,
      sections: {
        ...current.sections,
        [mutation.sectionKey]: mergeProjectedSection({
          existing: current.sections[mutation.sectionKey],
          incoming,
          additive: isAdditiveLtmSection(current, mutation.sectionKey),
          confidence: mutation.confidence,
          timestamp,
        }),
      },
    };
  }
  if (mutation.kind === "add_link") {
    return { ...current, links: uniqueLinks([...current.links, mutation.link]) };
  }
  if (mutation.kind === "set_keywords") {
    return { ...current, keywords: uniqueCaseInsensitiveStrings([...current.keywords, ...mutation.keywords]) };
  }
  if (mutation.kind === "set_status") return { ...current, status: mutation.status };
  if (mutation.kind === "set_subjects") {
    if (current.type !== "character" && current.type !== "relationship") {
      throw new LtmDraftProjectionError(
        `Long-term memory subjects cannot be assigned to ${current.type} note ${current.id}.`,
        "invalid_subject_target",
      );
    }
    if (current.subjects && !subjectsEqual(current.subjects, mutation.subjects)) {
      throw new LtmDraftProjectionError(
        `Long-term memory subject identity is already bound for ${current.id}.`,
        "subject_identity_mismatch",
      );
    }
    return { ...current, subjects: current.subjects ?? mutation.subjects };
  }
  const _exhaustive: never = mutation;
  throw new LtmDraftProjectionError(
    `Unsupported mutation kind: ${(_exhaustive as LtmDraftMutation).kind}`,
    "unsupported_mutation",
  );
}

function assertCompatibleCreate(existing: LtmNote, incoming: LtmNote) {
  if (existing.type !== incoming.type) {
    throw new LtmDraftProjectionError(
      `Long-term memory draft cannot merge ${incoming.type} note ${incoming.id} into ${existing.type}.`,
      "note_type_mismatch",
    );
  }
  if (!canUpdateLtmScopedTarget(existing.scope, incoming.scope)) {
    throw new LtmDraftProjectionError(
      `Long-term memory draft cannot merge scoped create ${incoming.id} into an existing note from another scope.`,
      "scope_mismatch",
    );
  }
  if (existing.subjects && incoming.subjects && !subjectsEqual(existing.subjects, incoming.subjects)) {
    throw new LtmDraftProjectionError(
      `Long-term memory draft cannot merge a different subject identity into ${existing.id}.`,
      "subject_identity_mismatch",
    );
  }
}

function mergeProjectedSection(options: {
  existing: LtmSection | undefined;
  incoming: LtmSection;
  additive: boolean;
  confidence: number;
  timestamp: string;
}) {
  const evidence = uniqueStrings([...(options.existing?.evidence ?? []), ...(options.incoming.evidence ?? [])]);
  if (evidence.length > 100) {
    throw new LtmDraftProjectionError(
      "A projected section exceeds the 100-entry evidence limit.",
      "projection_limit_exceeded",
    );
  }
  const text = options.additive
    ? mergeNormalizedSectionLines(options.existing?.text, options.incoming.text)
    : options.incoming.text.trim();
  if (text.length > 20_000) {
    throw new LtmDraftProjectionError(
      "A projected section exceeds the 20,000-character text limit.",
      "projection_limit_exceeded",
    );
  }
  return {
    ...options.incoming,
    text,
    updatedAt: options.timestamp,
    salience: maxOptional([options.existing?.salience, options.incoming.salience]),
    confidence: maxOptional([options.existing?.confidence, options.incoming.confidence, options.confidence]),
    importance: highestImportance(options.existing?.importance, options.incoming.importance),
    dimensions: options.additive
      ? (options.incoming.dimensions ?? options.existing?.dimensions)
      : options.incoming.dimensions,
    dimensionChanges: options.additive
      ? (options.incoming.dimensionChanges ?? options.existing?.dimensionChanges)
      : options.incoming.dimensionChanges,
    evidence: evidence.length > 0 ? evidence : undefined,
  } satisfies LtmSection;
}

export function mergeNormalizedSectionLines(existing: string | undefined, incoming: string) {
  const existingText = existing?.trim() ?? "";
  const seen = new Set(sectionLines(existingText).map(normalizedLineKey));
  const novelLines: string[] = [];
  for (const line of sectionLines(incoming)) {
    const key = normalizedLineKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    novelLines.push(line);
  }
  if (!existingText) return novelLines.join("\n");
  if (novelLines.length === 0) return existingText;
  return `${existingText}\n\n${novelLines.join("\n")}`;
}

function dispositionForMutation(current: LtmNote | null, mutation: LtmDraftMutation): LtmMutationDisposition {
  if (mutation.kind === "create_note") return current ? "merge" : "new";
  if (mutation.kind === "append_section" || mutation.kind === "update_section") {
    return current && isAdditiveLtmSection(current, mutation.sectionKey) ? "merge" : "rewrite";
  }
  if (mutation.kind === "add_link" || mutation.kind === "set_keywords") return "merge";
  return "rewrite";
}

function changesForMutation(before: LtmNote | null, after: LtmNote, mutation: LtmDraftMutation): LtmProjectedChange[] {
  if (mutation.kind === "create_note") {
    const changes: LtmProjectedChange[] = Object.keys(mutation.note.sections).flatMap((sectionKey) => {
      const beforeText = before?.sections[sectionKey]?.text;
      const afterText = after.sections[sectionKey]!.text;
      if (beforeText === afterText) return [];
      return [
        {
          kind: "section" as const,
          key: sectionKey,
          ...(beforeText ? { before: beforeText } : {}),
          after: afterText,
        },
      ];
    });
    const beforeKeywords = before?.keywords.join(", ");
    const afterKeywords = after.keywords.join(", ");
    if (mutation.note.keywords.length > 0 && beforeKeywords !== afterKeywords) {
      changes.push({
        kind: "keywords",
        key: "keywords",
        ...(beforeKeywords ? { before: beforeKeywords } : {}),
        after: afterKeywords,
      });
    }
    for (const link of mutation.note.links) {
      if (before?.links.some((existing) => linksEqual(existing, link))) continue;
      changes.push({
        kind: "link",
        key: `${link.relation}:${link.target}`,
        after: projectedLinkText(link),
      });
    }
    if (before && before.status !== after.status) {
      changes.push({ kind: "status", key: "status", before: before.status, after: after.status });
    }
    if (mutation.note.subjects && !before?.subjects) {
      changes.push({
        kind: "subjects",
        key: "subjects",
        after: projectedSubjectsText(after.subjects ?? mutation.note.subjects),
      });
    }
    return changes;
  }
  if (mutation.kind === "append_section" || mutation.kind === "update_section") {
    const beforeText = before?.sections[mutation.sectionKey]?.text;
    const afterText = after.sections[mutation.sectionKey]!.text;
    if (beforeText === afterText) return [];
    return [
      {
        kind: "section",
        key: mutation.sectionKey,
        ...(beforeText ? { before: beforeText } : {}),
        after: afterText,
      },
    ];
  }
  if (mutation.kind === "add_link") {
    if (before?.links.some((existing) => linksEqual(existing, mutation.link))) return [];
    return [
      {
        kind: "link",
        key: `${mutation.link.relation}:${mutation.link.target}`,
        after: projectedLinkText(mutation.link),
      },
    ];
  }
  if (mutation.kind === "set_keywords") {
    const beforeText = before?.keywords.join(", ");
    const afterText = after.keywords.join(", ");
    if (beforeText === afterText) return [];
    return [
      {
        kind: "keywords",
        key: "keywords",
        ...(beforeText ? { before: beforeText } : {}),
        after: afterText,
      },
    ];
  }
  if (mutation.kind === "set_status") {
    if (before?.status === after.status) return [];
    return [{ kind: "status", key: "status", ...(before ? { before: before.status } : {}), after: after.status }];
  }
  if (before?.subjects && subjectsEqual(before.subjects, after.subjects ?? mutation.subjects)) return [];
  return [
    {
      kind: "subjects",
      key: "subjects",
      ...(before?.subjects ? { before: projectedSubjectsText(before.subjects) } : {}),
      after: projectedSubjectsText(after.subjects ?? mutation.subjects),
    },
  ];
}

function linksEqual(left: LtmLink, right: LtmLink) {
  return left.target === right.target && left.relation === right.relation && left.aspect === right.aspect;
}

function projectedLinkText(link: LtmLink) {
  return `${link.relation} ${link.target}${link.aspect ? ` (${link.aspect})` : ""}`;
}

function projectedSubjectsText(subjects: NonNullable<LtmNote["subjects"]>) {
  return subjects.map((subject) => subject.key).join(", ");
}

function withSourceLink(noteId: string, links: LtmLink[], sourceNoteId: string | undefined) {
  if (!sourceNoteId || sourceNoteId === noteId) return uniqueLinks(links);
  return uniqueLinks([...links, { target: sourceNoteId, relation: "extracted_from" }]);
}

function mergeScopes(existing: LtmScope, incoming: LtmScope) {
  return {
    ...withMergedLtmScopeLinks(existing, {
      chatIds: getLtmScopeChatIds(incoming),
      characterIds: incoming.characterIds ?? [],
    }),
    groupId: existing.groupId ?? incoming.groupId,
  };
}

function uniqueCaseInsensitiveStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function uniqueConflicts(conflicts: LtmConflict[]) {
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = stableStringify(conflict);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function optionalConflicts(conflicts: LtmConflict[]) {
  return conflicts.length > 0 ? conflicts : undefined;
}

function maxOptional(values: Array<number | undefined>) {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.max(...present) : undefined;
}

function highestImportance(left: LtmSection["importance"], right: LtmSection["importance"]) {
  const order = ["critical", "major", "moderate", "minor"] as const;
  return order.find((importance) => importance === left || importance === right);
}

function sectionLines(text: string) {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizedLineKey(line: string) {
  return line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function notesSemanticallyEqual(left: LtmNote, right: LtmNote) {
  return stableStringify(noteSemanticValue(left)) === stableStringify(noteSemanticValue(right));
}

function noteSemanticValue(note: LtmNote) {
  return {
    ...note,
    updatedAt: undefined,
    version: undefined,
    sections: Object.fromEntries(
      Object.entries(note.sections).map(([sectionKey, section]) => [sectionKey, { ...section, updatedAt: undefined }]),
    ),
  };
}

function cloneNote(note: LtmNote): LtmNote {
  return structuredClone(note);
}
