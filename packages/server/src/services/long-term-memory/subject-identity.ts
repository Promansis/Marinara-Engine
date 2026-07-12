import { createHash } from "node:crypto";
import {
  getLtmScopeChatIds,
  isGlobalLtmScope,
  type LtmEvidenceUnit,
  type LtmExtractionDroppedCandidate,
  type LtmIdentityMatchBasis,
  type LtmNote,
  type LtmScope,
  type LtmSubject,
  type LtmSubjectReference,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { normalizeLtmChatCharacterIds } from "./chat-scope.js";
import type { LtmExtractionDiagnostic } from "./diagnostics.js";
import { noteIdForEvidenceUnit } from "./evidence-unit-validation.js";
import { safeSnippet, uniqueStrings } from "./ltm-utils.js";
import { LongTermMemoryStorage } from "./storage.js";

type RosterSubjectInput = {
  kind: LtmSubjectReference["kind"];
  id: string;
  name: string;
  aliases?: string[];
};

export type TrustedLtmSubjectCatalogEntry = {
  subject: LtmSubject;
  name: string;
  aliases: string[];
  canonicalSlug: string;
};

export type TrustedLtmSubjectCatalog = {
  entries: TrustedLtmSubjectCatalogEntry[];
  notes: LtmNote[];
};

export type LtmSubjectIdentityResolution = {
  units: LtmEvidenceUnit[];
  existingNotes: LtmNote[];
  diagnostics: LtmExtractionDiagnostic[];
  droppedCandidates: LtmExtractionDroppedCandidate[];
  legacyBindings: Map<string, LtmSubject[]>;
};

export type TrustedLtmNoteSubjectMatch = {
  note: LtmNote;
  subjects: LtmSubject[];
  entries: TrustedLtmSubjectCatalogEntry[];
  basis: LtmIdentityMatchBasis;
  exactFullName: boolean;
};

export type TrustedLtmNoteSubjectIssue = {
  note: LtmNote;
  reason: "ambiguous" | "untrusted" | "invalid_cardinality";
  basis: string;
  candidateSubjectKeys: string[];
};

type CatalogIndex = {
  entries: TrustedLtmSubjectCatalogEntry[];
  byKey: Map<string, TrustedLtmSubjectCatalogEntry>;
  exact: Map<string, TrustedLtmSubjectCatalogEntry[]>;
  aliases: Map<string, TrustedLtmSubjectCatalogEntry[]>;
  tokens: string[];
};

const SOURCE_BACKED_NPC_NAME_PATTERN = /\b[A-Z][\p{L}\p{N}'-]*(?:\s+[A-Z][\p{L}\p{N}'-]*){1,3}\b/gu;

type SubjectMatch =
  | { status: "matched"; entries: TrustedLtmSubjectCatalogEntry[]; basis: string }
  | { status: "ambiguous"; keys: string[]; basis: string }
  | { status: "cardinality"; count: number; basis: string }
  | { status: "untrusted"; basis: string };

type ResolvedUnit = {
  unit: LtmEvidenceUnit;
  originalNoteId: string;
  targetNoteId: string;
};

export async function loadTrustedLtmSubjectCatalog(
  db: DB,
  scope: LtmScope,
  root?: string,
): Promise<TrustedLtmSubjectCatalog> {
  const chatsStorage = createChatsStorage(db);
  const charactersStorage = createCharactersStorage(db);
  const chatIds = getLtmScopeChatIds(scope);
  const allChats = chatIds.length === 0 && scope.groupId ? await chatsStorage.list() : [];
  const chats = chatIds.length
    ? (await Promise.all(chatIds.map((id) => chatsStorage.getById(id)))).filter(
        (chat): chat is NonNullable<typeof chat> => Boolean(chat),
      )
    : allChats.filter((chat) => chat.groupId === scope.groupId);
  const characterIds = uniqueStrings([
    ...(scope.characterIds ?? []),
    ...chats.flatMap((chat) => normalizeLtmChatCharacterIds(chat.characterIds)),
  ]);
  const personaIds = uniqueStrings(chats.map((chat) => chat.personaId ?? undefined));
  const [characterRows, personaRows, notes] = await Promise.all([
    Promise.all(characterIds.map((id) => charactersStorage.getById(id))),
    Promise.all(personaIds.map((id) => charactersStorage.getPersona(id))),
    new LongTermMemoryStorage(root).listNotes({
      scope,
      includeGlobal: isGlobalLtmScope(scope),
    }),
  ]);

  const roster: RosterSubjectInput[] = [];
  for (const row of characterRows) {
    if (!row) continue;
    const data = readObject(row.data);
    const name = readName(data.name);
    if (!name) continue;
    roster.push({
      kind: "character",
      id: row.id,
      name,
      aliases: extractAliases(data),
    });
  }
  for (const row of personaRows) {
    if (!row) continue;
    const record = row as unknown as Record<string, unknown>;
    const name = readName(record.name);
    if (!name) continue;
    roster.push({
      kind: "persona",
      id: String(record.id),
      name,
      aliases: extractAliases(record),
    });
  }

  return buildTrustedLtmSubjectCatalog({ roster, notes });
}

export function buildTrustedLtmSubjectCatalog({
  roster,
  notes,
}: {
  roster: RosterSubjectInput[];
  notes: LtmNote[];
}): TrustedLtmSubjectCatalog {
  const preferredKeyByRef = new Map<string, string>();
  for (const note of [...notes].sort(compareNoteAge)) {
    for (const subject of note.subjects ?? []) {
      if (!subject.ref) continue;
      const refKey = subjectRefKey(subject.ref);
      if (!preferredKeyByRef.has(refKey)) preferredKeyByRef.set(refKey, subject.key);
    }
  }

  const mutable = new Map<string, { subject: LtmSubject; name: string; aliases: Set<string>; canonicalSlug: string }>();
  for (const item of roster) {
    const ref = { kind: item.kind, id: item.id } satisfies LtmSubjectReference;
    const key = preferredKeyByRef.get(subjectRefKey(ref)) ?? `${item.kind}:${item.id}`;
    const aliases = new Set(expandedAliases(item.name, item.aliases ?? []));
    mutable.set(key, {
      subject: { key, ref },
      name: item.name,
      aliases,
      canonicalSlug: normalizeSubjectIdentifier(item.name, "subject"),
    });
  }

  for (const note of notes) {
    const subjects = note.subjects ?? [];
    for (const subject of subjects) {
      const existing = mutable.get(subject.key);
      const noteName = note.type === "character" && subjects.length === 1 ? subjectNameFromNote(note) : "";
      if (existing) {
        if (noteName) existing.aliases.add(noteName);
        continue;
      }
      const name = noteName || subjectLabelFromKey(subject.key);
      mutable.set(subject.key, {
        subject,
        name,
        aliases: new Set(expandedAliases(name, [])),
        canonicalSlug: normalizeSubjectIdentifier(name, subjectSlugFromNote(note)),
      });
    }
  }

  return {
    entries: Array.from(mutable.values())
      .map((entry) => ({
        ...entry,
        aliases: uniqueStrings(Array.from(entry.aliases)).filter(
          (alias) => normalizeSubjectIdentifier(alias, "") !== normalizeSubjectIdentifier(entry.name, ""),
        ),
      }))
      .sort((left, right) => left.subject.key.localeCompare(right.subject.key)),
    notes: notes.filter((note) => note.type === "character" || note.type === "relationship").sort(compareNoteAge),
  };
}

export function trustedLtmSubjectPromptCatalog(catalog: TrustedLtmSubjectCatalog) {
  const index = buildCatalogIndex(catalog);
  return index.entries.map((entry) => ({
    key: entry.subject.key,
    name: entry.name,
    aliases: entry.aliases.filter((alias) => {
      const match = matchDirect(index, normalizeSubjectIdentifier(alias, ""));
      return match.status === "matched" && match.entries[0]?.subject.key === entry.subject.key;
    }),
    ...(entry.subject.ref ? { ref: entry.subject.ref } : {}),
  }));
}

export function analyzeTrustedLtmNoteSubjects(catalog: TrustedLtmSubjectCatalog): {
  matches: TrustedLtmNoteSubjectMatch[];
  unresolved: TrustedLtmNoteSubjectIssue[];
} {
  const index = buildCatalogIndex(catalog);
  const matches: TrustedLtmNoteSubjectMatch[] = [];
  const unresolved: TrustedLtmNoteSubjectIssue[] = [];

  for (const note of catalog.notes.filter((candidate) => candidate.status !== "archived")) {
    const expectedSubjects = note.type === "character" ? 1 : 2;
    if (note.subjects) {
      const entries = note.subjects.map((subject) => index.byKey.get(subject.key));
      if (
        note.subjects.length !== expectedSubjects ||
        new Set(note.subjects.map((subject) => subject.key)).size !== expectedSubjects ||
        entries.some((entry) => !entry)
      ) {
        unresolved.push({
          note,
          reason: "invalid_cardinality",
          basis: "bound_subjects",
          candidateSubjectKeys: note.subjects.map((subject) => subject.key),
        });
        continue;
      }
      const resolvedEntries = entries as TrustedLtmSubjectCatalogEntry[];
      matches.push({
        note,
        subjects: sortSubjects(resolvedEntries.map((entry) => entry.subject)),
        entries: resolvedEntries,
        basis: "bound_subjects",
        exactFullName: isExactRepairIdentityNote(
          note,
          resolvedEntries,
          canonicalNoteIdForEntries(resolvedEntries, note.type === "character" ? "character_fact" : "relationship_state"),
        ),
      });
      continue;
    }

    const identifiers = uniqueStrings([
      note.title ? normalizeSubjectIdentifier(note.title, "") : "",
      stripNotePrefix(note.id),
    ]);
    const attempts = identifiers.map((identifier) =>
      note.type === "character" ? matchLegacyCharacter(index, identifier) : matchRelationship(index, identifier),
    );
    const matchedBySubjects = new Map<string, Extract<SubjectMatch, { status: "matched" }>>();
    for (const attempt of attempts) {
      if (attempt.status !== "matched") continue;
      const identityKey = attempt.entries.map(subjectEntryKey).sort().join("\u0000");
      const current = matchedBySubjects.get(identityKey);
      if (!current || identityBasisPriority(attempt.basis) < identityBasisPriority(current.basis)) {
        matchedBySubjects.set(identityKey, attempt);
      }
    }

    if (matchedBySubjects.size === 1) {
      const match = [...matchedBySubjects.values()][0]!;
      const bucket = note.type === "character" ? "character_fact" : "relationship_state";
      matches.push({
        note,
        subjects: sortSubjects(match.entries.map((entry) => entry.subject)),
        entries: match.entries,
        basis: publicIdentityMatchBasis(match.basis),
        exactFullName: isExactRepairIdentityNote(note, match.entries, canonicalNoteIdForEntries(match.entries, bucket)),
      });
      continue;
    }

    const ambiguous = attempts.filter((attempt): attempt is Extract<SubjectMatch, { status: "ambiguous" }> =>
      attempt.status === "ambiguous",
    );
    const cardinality = attempts.filter((attempt): attempt is Extract<SubjectMatch, { status: "cardinality" }> =>
      attempt.status === "cardinality",
    );
    unresolved.push({
      note,
      reason: matchedBySubjects.size > 1 || ambiguous.length > 0
        ? "ambiguous"
        : cardinality.length > 0
          ? "invalid_cardinality"
          : "untrusted",
      basis:
        matchedBySubjects.size > 1
          ? "conflicting_identifiers"
          : ambiguous[0]?.basis ?? cardinality[0]?.basis ?? attempts[0]?.basis ?? "name",
      candidateSubjectKeys: uniqueStrings([
        ...ambiguous.flatMap((attempt) => attempt.keys.flatMap((key) => key.split("\u0000"))),
        ...[...matchedBySubjects.values()].flatMap((attempt) => attempt.entries.map(subjectEntryKey)),
      ]),
    });
  }

  return { matches, unresolved };
}

export function resolveLtmSubjectIdentities({
  units,
  catalog,
  existingNotes,
  enforceTrustedSubjects = true,
  sourceBackedNpcSourceText,
}: {
  units: LtmEvidenceUnit[];
  catalog: TrustedLtmSubjectCatalog;
  existingNotes: LtmNote[];
  enforceTrustedSubjects?: boolean;
  sourceBackedNpcSourceText?: string;
}): LtmSubjectIdentityResolution {
  const index = buildCatalogIndex(catalog);
  const legacyBindings = inferLegacyBindings(catalog, index);
  const diagnostics: LtmExtractionDiagnostic[] = [];
  const droppedCandidates: LtmExtractionDroppedCandidate[] = [];
  const resolved: ResolvedUnit[] = [];
  const targetNotes = new Map(existingNotes.map((note) => [note.id, note]));

  for (const [candidateIndex, unit] of units.entries()) {
    if (unit.bucket !== "character_fact" && unit.bucket !== "relationship_state") {
      resolved.push({ unit, originalNoteId: noteIdForEvidenceUnit(unit), targetNoteId: noteIdForEvidenceUnit(unit) });
      continue;
    }

    const match = resolveUnitSubjects(unit, index);
    if (match.status !== "matched") {
      const sourceBackedNpc = sourceBackedNpcSubject(unit, sourceBackedNpcSourceText);
      if (sourceBackedNpc && match.status === "untrusted") {
        addCatalogEntry(index, sourceBackedNpc);
        const subjects = [sourceBackedNpc.subject];
        const canonicalNoteId = canonicalNoteIdForEntries([sourceBackedNpc], unit.bucket);
        const originalNoteId = noteIdForEvidenceUnit(unit);
        const nextUnit: LtmEvidenceUnit = {
          ...unit,
          subjectId: subjectIdForTarget(canonicalNoteId, unit.bucket),
          subjectKeys: subjects.map((subject) => subject.key),
          subjects,
        };
        resolved.push({ unit: nextUnit, originalNoteId, targetNoteId: canonicalNoteId });
        diagnostics.push({
          severity: "warning",
          code: "source_backed_npc_identity",
          candidateIndex,
          mutationId: unit.id,
          noteId: canonicalNoteId,
          message: `Accepted ${sourceBackedNpc.name} as an unbound NPC identity from the imported source.`,
          details: { subjectKeys: nextUnit.subjectKeys, matchBasis: "source_backed_npc" },
        });
        continue;
      }
      if (!enforceTrustedSubjects) {
        const fallbackSubjects = fallbackSubjectsForUnit(unit);
        const targetNoteId = noteIdForEvidenceUnit(unit);
        resolved.push({
          unit: { ...unit, subjectKeys: fallbackSubjects.map((subject) => subject.key), subjects: fallbackSubjects },
          originalNoteId: targetNoteId,
          targetNoteId,
        });
        continue;
      }
      const rejection = subjectRejection(unit, match, candidateIndex);
      diagnostics.push(rejection.diagnostic);
      droppedCandidates.push(rejection.dropped);
      continue;
    }

    const subjects = sortSubjects(match.entries.map((entry) => entry.subject));
    const target = chooseIdentityTarget(catalog.notes, legacyBindings, match.entries, unit.bucket);
    const canonicalNoteId = target?.id ?? canonicalNoteIdForEntries(match.entries, unit.bucket);
    if (target) targetNotes.set(target.id, target);
    const originalNoteId = noteIdForEvidenceUnit(unit);
    const subjectId = subjectIdForTarget(canonicalNoteId, unit.bucket);
    const nextUnit: LtmEvidenceUnit = {
      ...unit,
      subjectId,
      subjectKeys: subjects.map((subject) => subject.key),
      subjects,
    };
    resolved.push({ unit: nextUnit, originalNoteId, targetNoteId: canonicalNoteId });

    if (originalNoteId !== canonicalNoteId || match.basis !== "trusted_key") {
      diagnostics.push({
        severity: "warning",
        code: "subject_identity_normalized",
        candidateIndex,
        mutationId: unit.id,
        noteId: canonicalNoteId,
        message: `Resolved ${originalNoteId} to canonical subject target ${canonicalNoteId}.`,
        details: {
          originalNoteId,
          targetNoteId: canonicalNoteId,
          subjectKeys: subjects.map((subject) => subject.key),
          matchBasis: match.basis,
        },
      });
    }
  }

  const remaps = new Map(resolved.map((item) => [item.originalNoteId, item.targetNoteId]));
  const normalizedUnits = resolved.map((item) => ({
    ...item.unit,
    links: item.unit.links.map((link) => {
      const remapped = remaps.get(link.target);
      if (remapped) return { ...link, target: remapped };
      const target = resolveIdentityLinkTarget(link.target, link.relation, index, catalog, legacyBindings);
      if (target?.note) targetNotes.set(target.note.id, target.note);
      return target ? { ...link, target: target.noteId } : link;
    }),
  }));

  return {
    units: normalizedUnits,
    existingNotes: Array.from(targetNotes.values()).sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics,
    droppedCandidates,
    legacyBindings,
  };
}

function sourceBackedNpcSubject(unit: LtmEvidenceUnit, sourceText: string | undefined): TrustedLtmSubjectCatalogEntry | null {
  if (unit.bucket !== "character_fact" || !sourceText || (unit.subjectKeys?.length ?? 0) > 0) return null;
  const slug = stripNotePrefix(normalizeSubjectIdentifier(unit.subjectId, ""));
  if (slug.split("_").length < 2) return null;
  const sourceNames = sourceBackedNpcNames(sourceText);
  const name = sourceNames.get(slug);
  if (!name) return null;
  return {
    subject: { key: `npc:${slug}` },
    name,
    aliases: [],
    canonicalSlug: slug,
  };
}

function sourceBackedNpcNames(sourceText: string) {
  const names = new Map<string, string>();
  for (const match of sourceText.matchAll(SOURCE_BACKED_NPC_NAME_PATTERN)) {
    const name = match[0]!.trim();
    const slug = normalizeSubjectIdentifier(name, "");
    if (slug && !names.has(slug)) names.set(slug, name);
  }
  return names;
}

function addCatalogEntry(index: CatalogIndex, entry: TrustedLtmSubjectCatalogEntry) {
  if (index.byKey.has(entry.subject.key)) return;
  index.entries.push(entry);
  index.byKey.set(entry.subject.key, entry);
  addIndexEntry(index.exact, normalizeSubjectIdentifier(entry.name, ""), entry);
  for (const alias of entry.aliases) addIndexEntry(index.aliases, normalizeSubjectIdentifier(alias, ""), entry);
  index.tokens = uniqueStrings([...index.tokens, normalizeSubjectIdentifier(entry.name, ""), entry.canonicalSlug]).sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

export function subjectsEqual(left: readonly LtmSubject[] | undefined, right: readonly LtmSubject[] | undefined) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((subject, index) => subject.key === right[index]?.key);
}

function buildCatalogIndex(catalog: TrustedLtmSubjectCatalog): CatalogIndex {
  const exact = new Map<string, TrustedLtmSubjectCatalogEntry[]>();
  const aliases = new Map<string, TrustedLtmSubjectCatalogEntry[]>();
  for (const entry of catalog.entries) {
    addIndexEntry(exact, normalizeSubjectIdentifier(entry.name, ""), entry);
    for (const alias of entry.aliases) addIndexEntry(aliases, normalizeSubjectIdentifier(alias, ""), entry);
    addIndexEntry(aliases, entry.canonicalSlug, entry);
  }
  return {
    entries: catalog.entries,
    byKey: new Map(catalog.entries.map((entry) => [entry.subject.key, entry])),
    exact,
    aliases,
    tokens: uniqueStrings([...exact.keys(), ...aliases.keys()]).sort(
      (left, right) => right.length - left.length || left.localeCompare(right),
    ),
  };
}

function addIndexEntry(
  map: Map<string, TrustedLtmSubjectCatalogEntry[]>,
  token: string,
  entry: TrustedLtmSubjectCatalogEntry,
) {
  if (!token) return;
  const current = map.get(token) ?? [];
  if (!current.some((candidate) => candidate.subject.key === entry.subject.key)) current.push(entry);
  map.set(token, current);
}

function resolveUnitSubjects(unit: LtmEvidenceUnit, index: CatalogIndex): SubjectMatch {
  const expected = unit.bucket === "character_fact" ? 1 : 2;
  const subjectKeys = unit.subjectKeys ?? [];
  if (subjectKeys.length > 0) {
    if (subjectKeys.length !== expected) {
      return { status: "cardinality", count: subjectKeys.length, basis: "trusted_key" };
    }
    const entries = subjectKeys.map((key) => index.byKey.get(key));
    if (entries.some((entry) => !entry)) return { status: "untrusted", basis: "trusted_key" };
    const resolved = entries as TrustedLtmSubjectCatalogEntry[];
    if (new Set(resolved.map((entry) => entry.subject.key)).size !== resolved.length) {
      return { status: "cardinality", count: 1, basis: "trusted_key" };
    }
    return { status: "matched", entries: resolved, basis: "trusted_key" };
  }

  const raw = stripNotePrefix(normalizeSubjectIdentifier(unit.subjectId, ""));
  if (unit.bucket === "character_fact") {
    const composite = segmentSubjectIdentifier(raw, index).filter(
      (sequence) => new Set(sequence.map(subjectEntryKey)).size > 1,
    );
    if (composite.length > 0) {
      return {
        status: "cardinality",
        count: Math.max(...composite.map((sequence) => new Set(sequence.map(subjectEntryKey)).size)),
        basis: "composite",
      };
    }
    const direct = matchDirect(index, raw);
    if (direct.status !== "untrusted") return direct;
    return matchTraitPrefix(index, raw);
  }
  return matchRelationship(index, raw);
}

function matchDirect(index: CatalogIndex, token: string): SubjectMatch {
  if (!token) return { status: "untrusted", basis: "name" };
  const exact = index.exact.get(token) ?? [];
  if (exact.length === 1) return { status: "matched", entries: exact, basis: "exact_name" };
  if (exact.length > 1) return { status: "ambiguous", keys: exact.map(subjectEntryKey), basis: "exact_name" };
  const aliases = index.aliases.get(token) ?? [];
  if (aliases.length === 1) return { status: "matched", entries: aliases, basis: "unique_alias" };
  if (aliases.length > 1) return { status: "ambiguous", keys: aliases.map(subjectEntryKey), basis: "alias" };
  return { status: "untrusted", basis: "name" };
}

function matchTraitPrefix(index: CatalogIndex, raw: string): SubjectMatch {
  for (const token of index.tokens) {
    if (!raw.startsWith(`${token}_`)) continue;
    const match = matchDirect(index, token);
    if (match.status === "matched") return { ...match, basis: "trait_or_qualified_alias" };
    if (match.status === "ambiguous") return match;
  }
  return { status: "untrusted", basis: "trait_or_qualified_alias" };
}

function matchRelationship(index: CatalogIndex, raw: string): SubjectMatch {
  const sequences = segmentSubjectIdentifier(raw, index);
  const pairs = sequences.filter(
    (sequence) => sequence.length === 2 && sequence[0]!.subject.key !== sequence[1]!.subject.key,
  );
  const pairByIdentity = new Map<string, TrustedLtmSubjectCatalogEntry[]>();
  for (const pair of pairs) {
    const key = pair.map(subjectEntryKey).sort().join("\u0000");
    if (!pairByIdentity.has(key)) pairByIdentity.set(key, pair);
  }
  if (pairByIdentity.size === 1) {
    return { status: "matched", entries: [...pairByIdentity.values()][0]!, basis: "unordered_pair" };
  }
  if (pairByIdentity.size > 1) {
    return { status: "ambiguous", keys: [...pairByIdentity.keys()], basis: "unordered_pair" };
  }
  if (sequences.length > 0) {
    return {
      status: "cardinality",
      count: Math.max(...sequences.map((sequence) => new Set(sequence.map(subjectEntryKey)).size)),
      basis: "unordered_pair",
    };
  }
  return { status: "untrusted", basis: "unordered_pair" };
}

function segmentSubjectIdentifier(raw: string, index: CatalogIndex) {
  const results: TrustedLtmSubjectCatalogEntry[][] = [];
  const visit = (remaining: string, sequence: TrustedLtmSubjectCatalogEntry[]) => {
    if (!remaining) {
      results.push(sequence);
      return;
    }
    if (sequence.length >= 4) return;
    for (const token of index.tokens) {
      if (remaining !== token && !remaining.startsWith(`${token}_`)) continue;
      const match = matchDirect(index, token);
      if (match.status !== "matched") continue;
      const rest = remaining === token ? "" : remaining.slice(token.length + 1);
      for (const entry of match.entries) visit(rest, [...sequence, entry]);
    }
  };
  visit(raw, []);
  const unique = new Map<string, TrustedLtmSubjectCatalogEntry[]>();
  for (const sequence of results) {
    const key = sequence.map(subjectEntryKey).join("\u0000");
    if (!unique.has(key)) unique.set(key, sequence);
  }
  return [...unique.values()];
}

function inferLegacyBindings(catalog: TrustedLtmSubjectCatalog, index: CatalogIndex) {
  const bindings = new Map<string, LtmSubject[]>();
  for (const note of catalog.notes) {
    if (note.subjects) continue;
    const identifiers = uniqueStrings([
      note.title ? normalizeSubjectIdentifier(note.title, "") : "",
      stripNotePrefix(note.id),
    ]);
    for (const identifier of identifiers) {
      const match =
        note.type === "character" ? matchLegacyCharacter(index, identifier) : matchRelationship(index, identifier);
      if (match.status !== "matched") continue;
      bindings.set(note.id, sortSubjects(match.entries.map((entry) => entry.subject)));
      break;
    }
  }
  return bindings;
}

function matchLegacyCharacter(index: CatalogIndex, identifier: string) {
  const direct = matchDirect(index, identifier);
  return direct.status === "untrusted" ? matchTraitPrefix(index, identifier) : direct;
}

function publicIdentityMatchBasis(basis: string): LtmIdentityMatchBasis {
  if (basis === "exact_name") return "exact_name";
  if (basis === "unique_alias") return "unique_alias";
  if (basis === "trait_or_qualified_alias") return "trait_or_qualified_alias";
  return "unordered_pair";
}

function identityBasisPriority(basis: string) {
  if (basis === "exact_name") return 0;
  if (basis === "unique_alias") return 1;
  if (basis === "trait_or_qualified_alias") return 2;
  return 3;
}

function chooseIdentityTarget(
  notes: LtmNote[],
  legacyBindings: Map<string, LtmSubject[]>,
  entries: TrustedLtmSubjectCatalogEntry[],
  bucket: LtmEvidenceUnit["bucket"],
) {
  const type = bucket === "character_fact" ? "character" : "relationship";
  const subjects = sortSubjects(entries.map((entry) => entry.subject));
  const canonicalId = canonicalNoteIdForEntries(entries, bucket);
  const candidates = notes.filter((note) => {
    if (note.type !== type) return false;
    return subjectsEqual(note.subjects ?? legacyBindings.get(note.id), subjects);
  });
  return candidates.sort((left, right) => {
    const leftExact = isExactIdentityNote(left, entries, canonicalId) ? 0 : 1;
    const rightExact = isExactIdentityNote(right, entries, canonicalId) ? 0 : 1;
    return leftExact - rightExact || compareNoteAge(left, right);
  })[0];
}

function isExactIdentityNote(note: LtmNote, entries: TrustedLtmSubjectCatalogEntry[], canonicalId: string) {
  if (note.id === canonicalId) return true;
  if (entries.length !== 1 || !note.title) return false;
  return normalizeSubjectIdentifier(note.title, "") === normalizeSubjectIdentifier(entries[0]!.name, "");
}

function isExactRepairIdentityNote(note: LtmNote, entries: TrustedLtmSubjectCatalogEntry[], canonicalId: string) {
  if (note.type === "character") {
    return Boolean(
      entries.length === 1 &&
      note.title &&
      normalizeSubjectIdentifier(note.title, "") === normalizeSubjectIdentifier(entries[0]!.name, ""),
    );
  }
  return note.id === canonicalId;
}

function resolveIdentityLinkTarget(
  target: string,
  relation: LtmEvidenceUnit["links"][number]["relation"],
  index: CatalogIndex,
  catalog: TrustedLtmSubjectCatalog,
  legacyBindings: Map<string, LtmSubject[]>,
) {
  const raw = stripNotePrefix(normalizeSubjectIdentifier(target, ""));
  const match =
    relation === "affects_character"
      ? matchLegacyCharacter(index, raw)
      : relation === "affects_relationship"
        ? matchRelationship(index, raw)
        : null;
  if (!match || match.status !== "matched") return null;
  const bucket = relation === "affects_character" ? "character_fact" : "relationship_state";
  const note = chooseIdentityTarget(catalog.notes, legacyBindings, match.entries, bucket);
  return { noteId: note?.id ?? canonicalNoteIdForEntries(match.entries, bucket), note };
}

function canonicalNoteIdForEntries(entries: TrustedLtmSubjectCatalogEntry[], bucket: LtmEvidenceUnit["bucket"]) {
  const prefix = bucket === "character_fact" ? "char" : "rel";
  const slugs = entries.map((entry) => entry.canonicalSlug).sort();
  const base = `${prefix}_${slugs.join("_")}`;
  if (base.length <= 120) return base;
  const suffix = createHash("sha256")
    .update(entries.map(subjectEntryKey).sort().join("\u0000"))
    .digest("hex")
    .slice(0, 10);
  return `${base.slice(0, 109).replace(/_+$/g, "")}_${suffix}`;
}

function subjectIdForTarget(noteId: string, bucket: LtmEvidenceUnit["bucket"]) {
  const prefix = bucket === "character_fact" ? "char_" : "rel_";
  return noteId.startsWith(prefix) ? noteId.slice(prefix.length) : noteId;
}

function subjectRejection(unit: LtmEvidenceUnit, match: Exclude<SubjectMatch, { status: "matched" }>, index: number) {
  const noteId = noteIdForEvidenceUnit(unit);
  const isCompositeCharacter = unit.bucket === "character_fact" && match.status === "cardinality" && match.count > 1;
  const code = isCompositeCharacter
    ? "composite_character_subject"
    : match.status === "ambiguous"
      ? "ambiguous_subject_identity"
      : match.status === "cardinality"
        ? "invalid_subject_cardinality"
        : "untrusted_subject_identity";
  const reason: LtmExtractionDroppedCandidate["reason"] =
    match.status === "ambiguous"
      ? "ambiguous_subject"
      : match.status === "untrusted"
        ? "untrusted_subject"
        : "invalid_subject_cardinality";
  const message = isCompositeCharacter
    ? "Dropped a character fact that combined multiple character subjects."
    : match.status === "ambiguous"
      ? "Dropped a candidate whose subject matches more than one trusted roster identity."
      : match.status === "cardinality"
        ? `Dropped a ${unit.bucket} candidate with ${match.count} resolved subjects.`
        : "Dropped a candidate whose subject is not in the trusted chat roster or bound memories.";
  return {
    diagnostic: {
      severity: "error" as const,
      code,
      candidateIndex: index,
      mutationId: unit.id,
      noteId,
      message,
      details: { subjectId: unit.subjectId, subjectKeys: unit.subjectKeys ?? [], matchBasis: match.basis },
    },
    dropped: {
      index,
      reason,
      message,
      snippet: safeSnippet(unit.text),
      recovery: {
        noteType: unit.bucket === "character_fact" ? ("character" as const) : ("relationship" as const),
        noteId,
        sectionKey: unit.sectionKey,
        status: unit.status === "archived" ? ("archived" as const) : ("active" as const),
      },
    },
  };
}

function fallbackSubjectsForUnit(unit: LtmEvidenceUnit) {
  if (unit.bucket === "character_fact") return [{ key: `legacy:${unit.subjectId}` }];
  return sortSubjects([{ key: `legacy:${unit.subjectId}:1` }, { key: `legacy:${unit.subjectId}:2` }]);
}

function sortSubjects(subjects: LtmSubject[]) {
  return [...subjects].sort((left, right) => left.key.localeCompare(right.key));
}

function subjectEntryKey(entry: TrustedLtmSubjectCatalogEntry) {
  return entry.subject.key;
}

function subjectRefKey(ref: LtmSubjectReference) {
  return `${ref.kind}\u0000${ref.id}`;
}

function compareNoteAge(left: LtmNote, right: LtmNote) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function subjectNameFromNote(note: LtmNote) {
  return note.title?.trim() || subjectSlugFromNote(note).replace(/_/g, " ");
}

function subjectSlugFromNote(note: LtmNote) {
  return stripNotePrefix(note.id) || "subject";
}

function subjectLabelFromKey(key: string) {
  const suffix = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  return normalizeSubjectIdentifier(suffix, "subject").replace(/_/g, " ");
}

function stripNotePrefix(identifier: string) {
  return identifier.replace(/^(?:char|rel)_/, "");
}

function readObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readName(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 240) : "";
}

function extractAliases(record: Record<string, unknown>) {
  const extensions = readObject(record.extensions);
  return uniqueStrings([
    ...readStringArray(record.aliases),
    ...readStringArray(record.alias),
    ...readStringArray(record.nicknames),
    ...readStringArray(record.alternateNames),
    ...readStringArray(record.alternate_names),
    ...readStringArray(extensions.aliases),
    ...readStringArray(extensions.nicknames),
  ]);
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? value.split(/[,;\n]/g) : [];
}

function expandedAliases(name: string, aliases: string[]) {
  const words = name.trim().split(/\s+/g).filter(Boolean);
  return uniqueStrings([...aliases, ...(words.length > 1 ? [words[0], words[words.length - 1]] : [])]);
}

export function normalizeSubjectIdentifier(value: unknown, fallback = "subject") {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 120)
    .replace(/_+$/g, "");
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(normalized) ? normalized : fallback;
}
