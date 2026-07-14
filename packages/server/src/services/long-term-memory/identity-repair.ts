import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getLtmScopeChatIds,
  ltmIdentityRepairApplyRequestSchema,
  ltmIdentityRepairApplyResponseSchema,
  ltmIdentityRepairPreviewResponseSchema,
  ltmNoteSchema,
  uniqueLinks,
  withMergedLtmScopeLinks,
  type LtmConflict,
  type LtmIdentityMatchBasis,
  type LtmIdentityRepairApplyRequest,
  type LtmIdentityRepairApplyResponse,
  type LtmIdentityRepairCandidate,
  type LtmIdentityRepairPreviewResponse,
  type LtmIdentityRepairSelection,
  type LtmNote,
  type LtmScope,
  type LtmSection,
  type LtmSubject,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { stableJsonHash } from "./chunking.js";
import { nowIso, uniqueStrings } from "./ltm-utils.js";
import { checkLongTermMemoryIntegrity } from "./maintenance.js";
import { getLongTermMemoryRoot } from "./paths.js";
import { rebuildLongTermMemoryIndexes } from "./rebuild.js";
import { LongTermMemoryStorage, type UpdateLtmNotePatch } from "./storage.js";
import { withLtmVaultLock } from "./vault-lock.js";
import { isAdditiveLtmSection } from "./draft-projector.js";
import {
  analyzeTrustedLtmNoteSubjects,
  type TrustedLtmNoteSubjectMatch,
  type TrustedLtmSubjectCatalog,
} from "./subject-identity.js";

type IdentityRepairGroup = {
  id: string;
  noteType: "character" | "relationship";
  subjects: LtmSubject[];
  subjectNames: string[];
  matches: TrustedLtmNoteSubjectMatch[];
  canonical: TrustedLtmNoteSubjectMatch;
};

type PreparedIdentityRepair = {
  group: IdentityRepairGroup;
  canonical: TrustedLtmNoteSubjectMatch;
  archived: TrustedLtmNoteSubjectMatch[];
  excludedNoteIds: string[];
  patch: UpdateLtmNotePatch;
};

export type LtmIdentityRepairBackup = {
  id: string;
  createdAt: string;
  directory: string;
  snapshotRoot: string;
};

type IdentityRepairApplyOptions = {
  root?: string;
  loadCatalog: () => Promise<TrustedLtmSubjectCatalog>;
  rebuild?: typeof rebuildLongTermMemoryIndexes;
  checkIntegrity?: typeof checkLongTermMemoryIntegrity;
  hooks?: {
    afterBackup?: (backup: LtmIdentityRepairBackup) => Promise<void> | void;
    afterCanonicalWrite?: (noteId: string, index: number) => Promise<void> | void;
  };
};

const identityRepairLocks = new Map<string, Promise<void>>();

export class LtmIdentityRepairError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "LtmIdentityRepairError";
  }
}

export function previewLtmIdentityRepairs(
  catalog: TrustedLtmSubjectCatalog,
  scope: LtmScope,
  generatedAt = nowIso(),
): LtmIdentityRepairPreviewResponse {
  const { groups, unresolved, analyzedNotes } = analyzeIdentityRepairGroups(catalog);
  const candidates = groups.map(candidateForGroup);
  return ltmIdentityRepairPreviewResponseSchema.parse({
    generatedAt,
    scope,
    counts: {
      analyzedNotes,
      candidateCount: candidates.length,
      bindableNotes: groups.reduce(
        (count, group) => count + group.matches.filter((match) => !match.note.subjects).length,
        0,
      ),
      duplicateNotes: groups.reduce((count, group) => count + Math.max(0, group.matches.length - 1), 0),
      unresolvedNotes: unresolved.length,
    },
    candidates,
    unresolved,
  });
}

export async function applyLtmIdentityRepairs(
  request: LtmIdentityRepairApplyRequest,
  options: IdentityRepairApplyOptions,
): Promise<LtmIdentityRepairApplyResponse> {
  const parsedRequest = ltmIdentityRepairApplyRequestSchema.parse(request);
  const root = options.root ?? getLongTermMemoryRoot();
  return withIdentityRepairLock(root, () =>
    withLtmVaultLock(root, async () => {
      const storage = new LongTermMemoryStorage(root);
      await storage.initializeLtmStore();
      const catalog = await options.loadCatalog();
      const { groups } = analyzeIdentityRepairGroups(catalog);
      const groupsById = new Map(groups.map((group) => [group.id, group]));
      const prepared = parsedRequest.repairs.map((selection) => prepareIdentityRepair(groupsById, selection));
      assertDisjointRepairSelections(prepared);

      const backup = await createLtmIdentityRepairBackup(root);
      const rebuild = options.rebuild ?? rebuildLongTermMemoryIndexes;
      const checkIntegrity = options.checkIntegrity ?? checkLongTermMemoryIntegrity;

      try {
        await options.hooks?.afterBackup?.(backup);
        const results: LtmIdentityRepairApplyResponse["repairs"] = [];

        for (const [index, repair] of prepared.entries()) {
          const eventContext = {
            actor: "maintenance_api",
            cause: "identity_repair",
            summary: `Merged canonical identity into ${repair.canonical.note.id}`,
            payload: {
              candidateId: repair.group.id,
              archivedNoteIds: repair.archived.map((match) => match.note.id),
            },
          };
          await storage.updateNote(repair.canonical.note.id, repair.patch, eventContext);
          await options.hooks?.afterCanonicalWrite?.(repair.canonical.note.id, index);

          let rewrittenNoteCount = 0;
          let rewrittenDraftCount = 0;
          for (const duplicate of repair.archived) {
            const rewritten = await storage.redirectReferences(
              duplicate.note.id,
              repair.canonical.note.id,
              eventContext,
            );
            rewrittenNoteCount += rewritten.rewrittenNoteCount;
            rewrittenDraftCount += rewritten.rewrittenDraftCount;
            await storage.updateNote(
              duplicate.note.id,
              { status: "archived", subjects: repair.group.subjects },
              {
                ...eventContext,
                summary: `Archived identity duplicate ${duplicate.note.id}`,
                payload: {
                  ...eventContext.payload,
                  canonicalNoteId: repair.canonical.note.id,
                },
              },
            );
          }

          results.push({
            candidateId: repair.group.id,
            canonicalNoteId: repair.canonical.note.id,
            archivedNoteIds: repair.archived.map((match) => match.note.id),
            excludedNoteIds: repair.excludedNoteIds,
            rewrittenNoteCount,
            rewrittenDraftCount,
          });
        }

        const rebuildResult = await rebuild({ root });
        const integrity = await checkIntegrity(root);
        return ltmIdentityRepairApplyResponseSchema.parse({
          repairedAt: nowIso(),
          backup: { id: backup.id, createdAt: backup.createdAt },
          repairs: results,
          rebuild: {
            generatedAt: rebuildResult.generatedAt,
            noteCount: rebuildResult.noteCount,
            chunkCount: rebuildResult.chunkCount,
            sourceChunkCount: rebuildResult.sourceChunkCount,
            embeddedChunkCount: rebuildResult.embeddedChunkCount,
            embeddingsAvailable: rebuildResult.embeddingsAvailable,
            manifest: rebuildResult.manifest,
          },
          integrity,
        });
      } catch (error) {
        try {
          await restoreLtmIdentityRepairBackup(root, backup);
        } catch (restoreError) {
          logger.error(restoreError, "[ltm] Failed to restore identity-repair backup %s", backup.id);
          throw new LtmIdentityRepairError(
            `Identity repair failed and its backup could not be restored: ${errorMessage(error)}`,
            500,
            "identity_repair_restore_failed",
          );
        }
        throw error;
      }
    }),
  );
}

export function getLtmIdentityRepairBackupsRoot(root = getLongTermMemoryRoot()) {
  return join(dirname(root), "backups", "long-term-memory-identity-repairs");
}

export async function createLtmIdentityRepairBackup(root = getLongTermMemoryRoot()): Promise<LtmIdentityRepairBackup> {
  return withLtmVaultLock(root, async () => {
    const id = randomUUID();
    const createdAt = nowIso();
    const backupsRoot = getLtmIdentityRepairBackupsRoot(root);
    const directory = join(backupsRoot, id);
    const snapshotRoot = join(directory, basename(root));
    await mkdir(backupsRoot, { recursive: true });
    await mkdir(directory);
    try {
      await cp(root, snapshotRoot, { recursive: true, errorOnExist: true, force: false });
      await writeJsonAtomic(join(directory, "manifest.json"), {
        version: 1,
        id,
        createdAt,
        sourceDirectory: basename(root),
        purpose: "long-term-memory-identity-repair",
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return { id, createdAt, directory, snapshotRoot };
  });
}

export async function restoreLtmIdentityRepairBackup(root: string, backup: LtmIdentityRepairBackup) {
  return withLtmVaultLock(root, async () => {
    const parent = dirname(root);
    const restoreId = randomUUID();
    const stagingRoot = join(parent, `.${basename(root)}-identity-restore-${restoreId}`);
    const failedRoot = join(parent, `.${basename(root)}-identity-failed-${restoreId}`);
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(failedRoot, { recursive: true, force: true });
    await cp(backup.snapshotRoot, stagingRoot, { recursive: true, errorOnExist: true, force: false });
    await rename(root, failedRoot);
    try {
      await rename(stagingRoot, root);
    } catch (error) {
      await rename(failedRoot, root).catch(() => {});
      throw error;
    }
    await rm(failedRoot, { recursive: true, force: true });
  });
}

function analyzeIdentityRepairGroups(catalog: TrustedLtmSubjectCatalog) {
  const analysis = analyzeTrustedLtmNoteSubjects(catalog);
  const grouped = new Map<string, TrustedLtmNoteSubjectMatch[]>();
  for (const match of analysis.matches) {
    const key = `${match.note.type}\u0000${match.subjects.map((subject) => subject.key).join("\u0000")}`;
    const current = grouped.get(key) ?? [];
    current.push(match);
    grouped.set(key, current);
  }

  const catalogEntries = new Map(catalog.entries.map((entry) => [entry.subject.key, entry]));
  const groups: IdentityRepairGroup[] = [];
  for (const matches of grouped.values()) {
    if (matches.length === 1 && matches[0]!.note.subjects) continue;
    const ordered = [...matches].sort(compareIdentityMatches);
    const canonical = ordered[0]!;
    const subjects = [...canonical.subjects].sort((left, right) => left.key.localeCompare(right.key));
    const noteType = canonical.note.type as "character" | "relationship";
    const id = identityRepairCandidateId(noteType, subjects, ordered);
    groups.push({
      id,
      noteType,
      subjects,
      subjectNames: subjects.map((subject) => catalogEntries.get(subject.key)?.name ?? subject.key),
      matches: ordered,
      canonical,
    });
  }

  groups.sort((left, right) => left.canonical.note.id.localeCompare(right.canonical.note.id));
  return {
    groups,
    analyzedNotes: analysis.matches.length + analysis.unresolved.length,
    unresolved: analysis.unresolved.map((issue) => ({
      noteId: issue.note.id,
      noteType: issue.note.type as "character" | "relationship",
      title: issue.note.title?.trim() || issue.note.id,
      reason: issue.reason,
      basis: issue.basis,
      candidateSubjectKeys: issue.candidateSubjectKeys,
    })),
  };
}

function identityRepairCandidateId(
  noteType: "character" | "relationship",
  subjects: LtmSubject[],
  matches: TrustedLtmNoteSubjectMatch[],
) {
  return stableJsonHash({
    noteType,
    subjects,
    notes: [...matches]
      .sort((left, right) => left.note.id.localeCompare(right.note.id))
      .map((match) => ({ note: match.note, basis: match.basis, exactFullName: match.exactFullName })),
  });
}

function candidateForGroup(group: IdentityRepairGroup): LtmIdentityRepairCandidate {
  const sectionPreview = previewSectionChanges(group.matches, group.canonical.note.id);
  return {
    id: group.id,
    noteType: group.noteType,
    subjects: group.subjects,
    subjectNames: group.subjectNames,
    canonicalNoteId: group.canonical.note.id,
    duplicateNoteIds: group.matches
      .map((match) => match.note.id)
      .filter((noteId) => noteId !== group.canonical.note.id),
    notes: group.matches.map((match) => ({
      noteId: match.note.id,
      title: match.note.title?.trim() || match.note.id,
      createdAt: match.note.createdAt,
      basis: match.basis,
      alreadyBound: Boolean(match.note.subjects),
      exactFullName: match.exactFullName,
    })),
    matchBasis: uniqueIdentityBases(group.matches.map((match) => match.basis)),
    additiveContent: sectionPreview.additiveContent,
    supersedingConflicts: sectionPreview.supersedingConflicts,
    blockingReasons: capacityBlockers(group.matches, group.canonical.note.id),
  };
}

function prepareIdentityRepair(
  groupsById: Map<string, IdentityRepairGroup>,
  selection: LtmIdentityRepairSelection,
): PreparedIdentityRepair {
  const group = groupsById.get(selection.candidateId);
  if (!group) {
    throw new LtmIdentityRepairError(
      "The identity repair preview is stale. Refresh it before applying changes.",
      409,
      "identity_repair_stale",
    );
  }

  const noteIds = new Set(group.matches.map((match) => match.note.id));
  if (!noteIds.has(selection.canonicalNoteId)) {
    throw new LtmIdentityRepairError(
      `Canonical note ${selection.canonicalNoteId} is not part of the selected identity candidate.`,
      400,
      "identity_repair_invalid_selection",
    );
  }
  if (selection.excludedNoteIds.some((noteId) => !noteIds.has(noteId))) {
    throw new LtmIdentityRepairError(
      "An excluded note is not part of the selected identity candidate.",
      400,
      "identity_repair_invalid_selection",
    );
  }

  const excluded = new Set(selection.excludedNoteIds);
  const included = group.matches.filter((match) => !excluded.has(match.note.id));
  const canonical = included.find((match) => match.note.id === selection.canonicalNoteId)!;
  const blockers = capacityBlockers(included, canonical.note.id);
  if (blockers.length > 0) {
    throw new LtmIdentityRepairError(blockers.join(" "), 409, "identity_repair_blocked");
  }
  const patch = projectIdentityRepair(included, canonical, group.subjects, selection.sectionChoices, true);
  return {
    group,
    canonical,
    archived: included.filter((match) => match.note.id !== canonical.note.id),
    excludedNoteIds: selection.excludedNoteIds,
    patch,
  };
}

function projectIdentityRepair(
  matches: TrustedLtmNoteSubjectMatch[],
  canonical: TrustedLtmNoteSubjectMatch,
  subjects: LtmSubject[],
  sectionChoices: LtmIdentityRepairSelection["sectionChoices"],
  requireConflictChoices: boolean,
): UpdateLtmNotePatch {
  const ordered = orderWithCanonicalFirst(matches, canonical.note.id);
  const archivedIds = new Set(ordered.slice(1).map((match) => match.note.id));
  const sectionChoiceByKey = new Map(sectionChoices.map((choice) => [choice.sectionKey, choice.noteId]));
  const sections: LtmNote["sections"] = {};
  const sectionKeys = uniqueStrings(ordered.flatMap((match) => Object.keys(match.note.sections))).sort();

  for (const sectionKey of sectionKeys) {
    const entries = ordered.flatMap((match) => {
      const section = match.note.sections[sectionKey];
      return section ? [{ noteId: match.note.id, section }] : [];
    });
    if (entries.length === 0) continue;
    if (isAdditiveLtmSection(canonical.note, sectionKey)) {
      sections[sectionKey] = mergeAdditiveSections(entries.map((entry) => entry.section));
      continue;
    }

    const options = supersedingOptions(entries);
    let selected = options[0]!;
    if (options.length > 1) {
      const selectedNoteId = sectionChoiceByKey.get(sectionKey);
      if (requireConflictChoices && !selectedNoteId) {
        throw new LtmIdentityRepairError(
          `Choose which ${sectionKey.replace(/_/g, " ")} value to keep.`,
          400,
          "identity_repair_conflict_unresolved",
        );
      }
      if (selectedNoteId) {
        const selectedOption = options.find((option) => option.noteIds.includes(selectedNoteId));
        if (!selectedOption) {
          throw new LtmIdentityRepairError(
            `The selected ${sectionKey.replace(/_/g, " ")} value is no longer available.`,
            409,
            "identity_repair_stale",
          );
        }
        selected = selectedOption;
      } else {
        selected = options.find((option) => option.noteIds.includes(canonical.note.id)) ?? options[0]!;
      }
    }
    const selectedEntry = entries.find((entry) => selected.noteIds.includes(entry.noteId))!;
    sections[sectionKey] = mergeSupersedingSection(
      selectedEntry.section,
      entries.map((entry) => entry.section),
    );
  }

  const scopes = ordered.map((match) => match.note.scope);
  const groupIds = uniqueStrings(scopes.map((scope) => scope.groupId));
  const scope = withMergedLtmScopeLinks(groupIds[0] ? { groupId: groupIds[0] } : {}, {
    chatIds: uniqueStrings(scopes.flatMap(getLtmScopeChatIds)),
    characterIds: uniqueStrings(scopes.flatMap((value) => value.characterIds ?? [])),
  });
  const links = uniqueLinks(
    ordered
      .flatMap((match) => match.note.links)
      .map((link) => (archivedIds.has(link.target) ? { ...link, target: canonical.note.id } : link))
      .filter((link) => link.target !== canonical.note.id),
  );
  const conflicts = uniqueConflicts(ordered.flatMap((match) => match.note.conflicts ?? []));
  const patch: UpdateLtmNotePatch = {
    modes: uniqueStrings(ordered.flatMap((match) => match.note.modes)) as LtmNote["modes"],
    scope,
    tags: uniqueStrings(ordered.flatMap((match) => match.note.tags)),
    keywords: uniqueCaseInsensitiveStrings(ordered.flatMap((match) => match.note.keywords)),
    links,
    sections,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
    subjects,
  };

  ltmNoteSchema.parse({
    ...canonical.note,
    ...patch,
    updatedAt: nowIso(),
    version: canonical.note.version + 1,
  });
  return patch;
}

function previewSectionChanges(matches: TrustedLtmNoteSubjectMatch[], canonicalNoteId: string) {
  const ordered = orderWithCanonicalFirst(matches, canonicalNoteId);
  const canonical = ordered[0]!.note;
  const sectionKeys = uniqueStrings(ordered.flatMap((match) => Object.keys(match.note.sections))).sort();
  const additiveContent: LtmIdentityRepairCandidate["additiveContent"] = [];
  const supersedingConflicts: LtmIdentityRepairCandidate["supersedingConflicts"] = [];

  for (const sectionKey of sectionKeys) {
    const entries = ordered.flatMap((match) => {
      const section = match.note.sections[sectionKey];
      return section ? [{ noteId: match.note.id, section }] : [];
    });
    if (isAdditiveLtmSection(canonical, sectionKey)) {
      const seen = new Set(sectionLines(canonical.sections[sectionKey]?.text ?? "").map(normalizedLineKey));
      const addedLines: string[] = [];
      const sourceNoteIds = new Set<string>();
      for (const entry of entries.filter((entry) => entry.noteId !== canonicalNoteId)) {
        for (const line of sectionLines(entry.section.text)) {
          const key = normalizedLineKey(line);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          addedLines.push(line);
          sourceNoteIds.add(entry.noteId);
        }
      }
      if (addedLines.length > 0) {
        additiveContent.push({ sectionKey, addedLines, sourceNoteIds: [...sourceNoteIds] });
      }
      continue;
    }

    const options = supersedingOptions(entries);
    if (options.length > 1) supersedingConflicts.push({ sectionKey, options });
  }

  return { additiveContent, supersedingConflicts };
}

function capacityBlockers(matches: TrustedLtmNoteSubjectMatch[], canonicalNoteId: string) {
  const ordered = orderWithCanonicalFirst(matches, canonicalNoteId);
  const blockers: string[] = [];
  const groupIds = uniqueStrings(ordered.map((match) => match.note.scope.groupId));
  if (groupIds.length > 1) blockers.push("The selected notes belong to different groups and cannot be merged safely.");
  if (uniqueStrings(ordered.flatMap((match) => match.note.tags)).length > 100) {
    blockers.push("Combined tags exceed the 100-tag note limit.");
  }
  if (uniqueCaseInsensitiveStrings(ordered.flatMap((match) => match.note.keywords)).length > 30) {
    blockers.push("Combined keywords exceed the 30-keyword note limit.");
  }
  if (uniqueLinks(ordered.flatMap((match) => match.note.links)).length > 250) {
    blockers.push("Combined links exceed the 250-link note limit.");
  }
  if (uniqueConflicts(ordered.flatMap((match) => match.note.conflicts ?? [])).length > 250) {
    blockers.push("Combined note conflicts exceed the 250-conflict note limit.");
  }

  const canonical = ordered[0]!.note;
  const sectionKeys = uniqueStrings(ordered.flatMap((match) => Object.keys(match.note.sections)));
  for (const sectionKey of sectionKeys) {
    const sections = ordered.flatMap((match) => {
      const section = match.note.sections[sectionKey];
      return section ? [section] : [];
    });
    const evidence = uniqueStrings(sections.flatMap((section) => section.evidence ?? []));
    if (evidence.length > 100) blockers.push(`${sectionKey} has more than 100 combined evidence references.`);
    if (isAdditiveLtmSection(canonical, sectionKey)) {
      const mergedText = mergeLines(sections.map((section) => section.text));
      if (mergedText.length > 20_000) blockers.push(`${sectionKey} exceeds the 20,000-character section limit.`);
    }
  }
  return uniqueStrings(blockers);
}

function mergeAdditiveSections(sections: LtmSection[]): LtmSection {
  return {
    text: mergeLines(sections.map((section) => section.text)),
    updatedAt: nowIso(),
    salience: maxOptional(sections.map((section) => section.salience)),
    confidence: maxOptional(sections.map((section) => section.confidence)),
    importance: highestImportance(sections.map((section) => section.importance)),
    dimensions: sections.find((section) => section.dimensions)?.dimensions,
    dimensionChanges: sections.find((section) => section.dimensionChanges)?.dimensionChanges,
    evidence: optionalStrings(uniqueStrings(sections.flatMap((section) => section.evidence ?? []))),
  };
}

function mergeSupersedingSection(selected: LtmSection, allSections: LtmSection[]): LtmSection {
  return {
    ...selected,
    text: selected.text.trim(),
    updatedAt: nowIso(),
    evidence: optionalStrings(uniqueStrings(allSections.flatMap((section) => section.evidence ?? []))),
  };
}

function supersedingOptions(entries: Array<{ noteId: string; section: LtmSection }>) {
  const options = new Map<string, { noteIds: string[]; text: string }>();
  for (const entry of entries) {
    const key = normalizedTextKey(entry.section.text);
    const current = options.get(key);
    if (current) current.noteIds.push(entry.noteId);
    else options.set(key, { noteIds: [entry.noteId], text: entry.section.text.trim() });
  }
  return [...options.values()];
}

function mergeLines(texts: string[]) {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const line of sectionLines(text)) {
      const key = normalizedLineKey(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  return lines.join("\n");
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

function normalizedTextKey(text: string) {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
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
  const result: LtmConflict[] = [];
  for (const conflict of conflicts) {
    const key = stableJsonHash(conflict);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(conflict);
  }
  return result;
}

function optionalStrings(values: string[]) {
  return values.length > 0 ? values : undefined;
}

function maxOptional(values: Array<number | undefined>) {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.max(...present) : undefined;
}

function highestImportance(values: Array<LtmSection["importance"]>) {
  const order = ["critical", "major", "moderate", "minor"] as const;
  return order.find((importance) => values.includes(importance));
}

function uniqueIdentityBases(values: LtmIdentityMatchBasis[]) {
  const order: LtmIdentityMatchBasis[] = [
    "bound_subjects",
    "exact_name",
    "unique_alias",
    "trait_or_qualified_alias",
    "unordered_pair",
  ];
  const valueSet = new Set(values);
  return order.filter((value) => valueSet.has(value));
}

function orderWithCanonicalFirst(matches: TrustedLtmNoteSubjectMatch[], canonicalNoteId: string) {
  return [...matches].sort((left, right) => {
    const leftCanonical = left.note.id === canonicalNoteId ? 0 : 1;
    const rightCanonical = right.note.id === canonicalNoteId ? 0 : 1;
    return leftCanonical - rightCanonical || compareIdentityMatches(left, right);
  });
}

function compareIdentityMatches(left: TrustedLtmNoteSubjectMatch, right: TrustedLtmNoteSubjectMatch) {
  const leftExact = left.exactFullName ? 0 : 1;
  const rightExact = right.exactFullName ? 0 : 1;
  return (
    leftExact - rightExact ||
    left.note.createdAt.localeCompare(right.note.createdAt) ||
    left.note.id.localeCompare(right.note.id)
  );
}

function assertDisjointRepairSelections(repairs: PreparedIdentityRepair[]) {
  const noteIds = new Set<string>();
  for (const repair of repairs) {
    for (const match of repair.group.matches) {
      if (noteIds.has(match.note.id)) {
        throw new LtmIdentityRepairError(
          `Note ${match.note.id} appears in more than one selected repair.`,
          400,
          "identity_repair_invalid_selection",
        );
      }
      noteIds.add(match.note.id);
    }
  }
}

async function withIdentityRepairLock<T>(root: string, operation: () => Promise<T>) {
  const previous = identityRepairLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  identityRepairLocks.set(root, tail);
  try {
    await previous.catch(() => {});
    return await operation();
  } finally {
    release();
    if (identityRepairLocks.get(root) === tail) identityRepairLocks.delete(root);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
