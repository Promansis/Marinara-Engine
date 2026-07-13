import assert from "node:assert/strict";
import test from "node:test";
import {
  ltmEvidenceUnitSchema,
  ltmNoteSchema,
  ltmSubjectsSchema,
  type LtmEvidenceUnit,
  type LtmNote,
  type LtmSubject,
} from "@marinara-engine/shared";
import type { BaseLLMProvider } from "../../llm/base-provider.js";
import { compileLtmEvidenceUnits } from "../evidence-unit-compiler.js";
import { evidenceUnitMessages, evidenceUnitResponseFormat } from "../evidence-unit-extraction.js";
import { noteIdForEvidenceUnit } from "../evidence-unit-validation.js";
import { resolveScopedEvidenceUnitTargets } from "../scoped-targets.js";
import {
  buildTrustedLtmSubjectCatalog,
  resolveLtmSubjectIdentities,
  trustedLtmSubjectPromptCatalog,
} from "../subject-identity.js";

const timestamp = "2026-07-10T00:00:00.000Z";
const sourceHash = "a".repeat(64);

function note(patch: Partial<LtmNote> & Pick<LtmNote, "id" | "type">): LtmNote {
  return {
    id: patch.id,
    title: patch.title,
    type: patch.type,
    status: patch.status ?? "active",
    modes: patch.modes ?? ["roleplay"],
    scope: patch.scope ?? { chatIds: ["chat_a"] },
    tags: patch.tags ?? ["typed_memory"],
    keywords: patch.keywords ?? [],
    createdAt: patch.createdAt ?? timestamp,
    updatedAt: patch.updatedAt ?? timestamp,
    links: patch.links ?? [],
    sections: patch.sections ?? {
      facts: { text: "Durable identity fact.", updatedAt: timestamp },
    },
    version: patch.version ?? 1,
    ...(patch.subjects ? { subjects: patch.subjects } : {}),
  };
}

function unit(
  bucket: LtmEvidenceUnit["bucket"],
  subjectId: string,
  patch: Partial<LtmEvidenceUnit> = {},
): LtmEvidenceUnit {
  return {
    id: patch.id ?? crypto.randomUUID(),
    bucket,
    subjectId,
    sectionKey: patch.sectionKey ?? (bucket === "relationship_state" ? "state" : "facts"),
    text: patch.text ?? "A durable source-backed fact about the subject.",
    importance: patch.importance ?? "major",
    keywords: patch.keywords ?? [],
    evidence: patch.evidence ?? ["source_note:source_summary"],
    confidence: patch.confidence ?? 0.92,
    salience: patch.salience ?? 0.8,
    status: patch.status ?? "active",
    links: patch.links ?? [],
    sourceHash,
    ...(patch.subjectNames ? { subjectNames: patch.subjectNames } : {}),
    ...(patch.subjectKeys ? { subjectKeys: patch.subjectKeys } : {}),
    ...(patch.subjects ? { subjects: patch.subjects } : {}),
  };
}

function damoLisaCatalog(notes: LtmNote[] = []) {
  return buildTrustedLtmSubjectCatalog({
    roster: [
      { kind: "character", id: "damo-id", name: "Damo Korvak", aliases: ["Damo"] },
      { kind: "character", id: "lisa-id", name: "Lisa Imai", aliases: ["Lisa"] },
    ],
    notes,
  });
}

test("subject metadata stays optional for legacy notes and validates canonical cardinality", () => {
  const legacy = note({ id: "char_damo", type: "character" });
  assert.equal(ltmNoteSchema.parse(legacy).subjects, undefined);

  const oneSubject = [{ key: "character:damo-id", ref: { kind: "character", id: "damo-id" } }] as const;
  assert.deepEqual(
    ltmNoteSchema.parse({ ...legacy, subjects: oneSubject }).subjects,
    oneSubject,
  );
  assert.equal(
    ltmNoteSchema.safeParse({
      ...note({ id: "rel_damo_lisa", type: "relationship" }),
      subjects: oneSubject,
    }).success,
    false,
  );
  assert.equal(
    ltmSubjectsSchema.safeParse([{ key: "persona:lisa" }, { key: "character:damo" }]).success,
    false,
  );
  assert.equal(
    ltmSubjectsSchema.safeParse([{ key: "character:damo" }, { key: "character:damo" }]).success,
    false,
  );
});

test("evidence unit subject names stay optional for legacy payloads", () => {
  const legacy = unit("character_fact", "damo", { subjectKeys: ["character:damo-id"] });
  const parsedLegacy = ltmEvidenceUnitSchema.parse(legacy);
  assert.equal(parsedLegacy.subjectNames, undefined);
  assert.deepEqual(parsedLegacy.subjectKeys, ["character:damo-id"]);
  assert.deepEqual(
    unit("relationship_state", "damo_lisa", { subjectNames: ["Damo", "Lisa"] }).subjectNames,
    ["Damo", "Lisa"],
  );
});

test("trusted catalog canonicalizes shorthand, full names, trait suffixes, and reversed pairs", () => {
  const catalog = damoLisaCatalog();
  const result = resolveLtmSubjectIdentities({
    catalog,
    existingNotes: [],
    units: [
      unit("character_fact", "damo"),
      unit("character_fact", "damo_korvak"),
      unit("character_fact", "damo_considerate_nature"),
      unit("relationship_state", "lisa_damo"),
      unit("relationship_state", "damo_lisa"),
    ],
  });

  assert.equal(result.droppedCandidates.length, 0);
  assert.deepEqual(
    result.units.slice(0, 3).map(noteIdForEvidenceUnit),
    ["char_damo_korvak", "char_damo_korvak", "char_damo_korvak"],
  );
  assert.deepEqual(
    result.units.slice(3).map(noteIdForEvidenceUnit),
    ["rel_damo_korvak_lisa_imai", "rel_damo_korvak_lisa_imai"],
  );
  assert.deepEqual(
    result.units[3]?.subjects?.map((subject) => subject.key),
    ["character:damo-id", "character:lisa-id"],
  );
});

test("source-visible aliases resolve to canonical Damo and Sayo character notes", () => {
  const catalog = buildTrustedLtmSubjectCatalog({
    roster: [
      { kind: "character", id: "damo-id", name: "Damo Korvak" },
      { kind: "character", id: "sayo-id", name: "Sayo Hikawa" },
    ],
    notes: [
      note({
        id: "char_damo_korvak",
        title: "Damo Korvak",
        type: "character",
        subjects: [{ key: "character:damo-id", ref: { kind: "character", id: "damo-id" } }],
      }),
      note({
        id: "char_sayo_hikawa",
        title: "Sayo Hikawa",
        type: "character",
        subjects: [{ key: "character:sayo-id", ref: { kind: "character", id: "sayo-id" } }],
      }),
    ],
  });
  const result = resolveLtmSubjectIdentities({
    catalog,
    existingNotes: catalog.notes,
    sourceBackedNpcSourceText: "Damo checked the piano while Sayo tuned her guitar.",
    units: [
      unit("character_fact", "wrong_damo", { subjectNames: ["Damo"] }),
      unit("character_fact", "wrong_sayo", { subjectNames: ["Sayo"] }),
    ],
  });

  assert.equal(result.droppedCandidates.length, 0);
  assert.deepEqual(result.units.map(noteIdForEvidenceUnit), ["char_damo_korvak", "char_sayo_hikawa"]);
  assert.deepEqual(result.units.map((candidate) => candidate.subjectNames), [["Damo Korvak"], ["Sayo Hikawa"]]);
});

test("ref-backed roster identities suppress stale unbound NPC duplicates", () => {
  const stale = note({
    id: "char_damo",
    title: "Damo",
    type: "character",
    subjects: [{ key: "npc:damo" }],
  });
  const canonical = note({
    id: "char_damo_korvak",
    title: "Damo Korvak",
    type: "character",
    subjects: [{ key: "character:damo-id", ref: { kind: "character", id: "damo-id" } }],
  });
  const catalog = buildTrustedLtmSubjectCatalog({
    roster: [{ kind: "character", id: "damo-id", name: "Damo Korvak" }],
    notes: [stale, canonical],
  });

  assert.equal(catalog.notes.some((candidate) => candidate.id === stale.id), true);
  assert.equal(catalog.entries.some((entry) => entry.subject.key === "npc:damo"), false);
  assert.equal(
    trustedLtmSubjectPromptCatalog(catalog).some((entry) => entry.key === "npc:damo"),
    false,
  );
  const source = note({
    id: "source_summary",
    type: "source",
    tags: ["source"],
    sections: { source: { text: "Damo returned the borrowed guitar.", updatedAt: timestamp } },
  });
  const prompt = evidenceUnitMessages({
    sourceNote: source,
    sourceText: source.sections.source!.text,
    existingNotes: [stale, canonical],
    provider: {} as BaseLLMProvider,
    model: "test-model",
    scope: source.scope,
    modes: ["roleplay"],
    sourceHash,
    trustedSubjectCatalog: catalog,
  });
  const promptPayload = JSON.parse(prompt[1]!.content) as { existingTypedNotes: string };
  assert.doesNotMatch(promptPayload.existingTypedNotes, /id: char_damo\n/);
  assert.match(promptPayload.existingTypedNotes, /id: char_damo_korvak\n/);

  const result = resolveLtmSubjectIdentities({
    catalog,
    existingNotes: catalog.notes,
    sourceBackedNpcSourceText: "Damo returned the borrowed guitar.",
    units: [unit("character_fact", "damo", { subjectNames: ["Damo"] })],
  });
  assert.equal(noteIdForEvidenceUnit(result.units[0]!), canonical.id);
});

test("new single-name characters use source-backed provisional identities", () => {
  const result = resolveLtmSubjectIdentities({
    catalog: buildTrustedLtmSubjectCatalog({ roster: [], notes: [] }),
    existingNotes: [],
    sourceBackedNpcSourceText: "Roselia guarded the archive through the night.",
    units: [unit("character_fact", "invented_key", { subjectNames: ["Roselia"] })],
  });

  assert.equal(result.droppedCandidates.length, 0);
  assert.equal(noteIdForEvidenceUnit(result.units[0]!), "char_roselia");
  assert.deepEqual(result.units[0]?.subjectNames, ["Roselia"]);
  assert.deepEqual(result.units[0]?.subjects, [{ key: "npc:roselia" }]);
});

test("a proper name visible only in the source title can create a provisional identity", () => {
  const result = resolveLtmSubjectIdentities({
    catalog: buildTrustedLtmSubjectCatalog({ roster: [], notes: [] }),
    existingNotes: [],
    sourceBackedNpcSourceText: "She guarded the archive through the night.",
    sourceBackedNpcSourceTitle: "Roselia",
    units: [unit("character_fact", "provider_guess", { subjectNames: ["Roselia"] })],
  });

  assert.equal(result.droppedCandidates.length, 0);
  assert.equal(noteIdForEvidenceUnit(result.units[0]!), "char_roselia");
});

test("proper names and occupational surnames remain admissible", () => {
  const result = resolveLtmSubjectIdentities({
    catalog: buildTrustedLtmSubjectCatalog({ roster: [], notes: [] }),
    existingNotes: [],
    sourceBackedNpcSourceText: "Sameer met Simon Baker and Karen Carpenter outside the archive.",
    units: [
      unit("character_fact", "provider_sameer", { subjectNames: ["Sameer"] }),
      unit("character_fact", "provider_baker", { subjectNames: ["Simon Baker"] }),
      unit("character_fact", "provider_carpenter", { subjectNames: ["Karen Carpenter"] }),
    ],
  });

  assert.equal(result.droppedCandidates.length, 0);
  assert.deepEqual(result.units.map(noteIdForEvidenceUnit), [
    "char_sameer",
    "char_simon_baker",
    "char_karen_carpenter",
  ]);
});

test("short and full source names converge on one provisional identity in either unit order", () => {
  for (const names of [["Sayo", "Sayo Hikawa"], ["Sayo Hikawa", "Sayo"]]) {
    const result = resolveLtmSubjectIdentities({
      catalog: buildTrustedLtmSubjectCatalog({ roster: [], notes: [] }),
      existingNotes: [],
      sourceBackedNpcSourceText: "Sayo Hikawa tuned her guitar. Later, Sayo locked the rehearsal room.",
      units: names.map((name) => unit("character_fact", `provider_${name.toLowerCase().replace(/\s+/g, "_")}`, {
        subjectNames: [name],
        text: `${name} kept the rehearsal secure.`,
      })),
    });

    assert.equal(result.droppedCandidates.length, 0);
    assert.deepEqual(result.units.map(noteIdForEvidenceUnit), ["char_sayo_hikawa", "char_sayo_hikawa"]);
    assert.deepEqual(result.units.map((candidate) => candidate.subjects), [
      [{ key: "npc:sayo_hikawa" }],
      [{ key: "npc:sayo_hikawa" }],
    ]);
  }
});

test("a same-batch full name supersedes an existing unbound short-name identity", () => {
  const shortNote = note({
    id: "char_sayo",
    title: "Sayo",
    type: "character",
    subjects: [{ key: "npc:sayo" }],
  });
  for (const names of [["Sayo", "Sayo Hikawa"], ["Sayo Hikawa", "Sayo"]]) {
    const catalog = buildTrustedLtmSubjectCatalog({ roster: [], notes: [shortNote] });
    const result = resolveLtmSubjectIdentities({
      catalog,
      existingNotes: catalog.notes,
      sourceBackedNpcSourceText: "Sayo Hikawa tuned her guitar. Later, Sayo locked the rehearsal room.",
      units: names.map((name) =>
        unit("character_fact", `provider_${name.toLowerCase().replace(/\s+/g, "_")}`, {
          subjectNames: [name],
        }),
      ),
    });

    assert.equal(result.droppedCandidates.length, 0);
    assert.deepEqual(result.units.map(noteIdForEvidenceUnit), ["char_sayo_hikawa", "char_sayo_hikawa"]);
    assert.equal(result.units.some((candidate) => candidate.subjectKeys?.includes("npc:sayo")), false);
  }
});

test("mixed known and provisional relationship subjects reuse the same batch identity", () => {
  const catalog = buildTrustedLtmSubjectCatalog({
    roster: [{ kind: "character", id: "damo-id", name: "Damo Korvak" }],
    notes: [],
  });
  const result = resolveLtmSubjectIdentities({
    catalog,
    existingNotes: [],
    sourceBackedNpcSourceText: "Damo met Roselia at the archive. Roselia trusted Damo with the key.",
    units: [
      unit("relationship_state", "wrong_relationship", {
        subjectNames: ["Damo", "Roselia"],
        text: "Damo and Roselia trusted each other with the archive key.",
      }),
      unit("character_fact", "wrong_character", {
        subjectNames: ["Roselia"],
        text: "Roselia guarded the archive key.",
      }),
      unit("character_fact", "another_wrong_character", {
        subjectNames: ["Roselia"],
        text: "Roselia kept a meticulous archive log.",
      }),
    ],
  });

  assert.equal(result.droppedCandidates.length, 0);
  assert.equal(noteIdForEvidenceUnit(result.units[0]!), "rel_damo_korvak_roselia");
  assert.deepEqual(result.units.slice(1).map(noteIdForEvidenceUnit), ["char_roselia", "char_roselia"]);
  assert.deepEqual(result.units[0]?.subjects?.map((subject) => subject.key), ["character:damo-id", "npc:roselia"]);

  const compiled = compileLtmEvidenceUnits({
    units: result.units,
    existingNotes: [],
    scope: { chatIds: ["chat_a"] },
    modes: ["roleplay"],
    createdAt: timestamp,
  });
  const roseliaCreates = compiled.mutations.filter(
    (mutation) => mutation.kind === "create_note" && mutation.note.id === "char_roselia",
  );
  assert.equal(roseliaCreates.length, 1);
  assert.match(roseliaCreates[0]?.kind === "create_note" ? roseliaCreates[0].note.sections.facts?.text ?? "" : "", /guarded the archive key/);
  assert.match(roseliaCreates[0]?.kind === "create_note" ? roseliaCreates[0].note.sections.facts?.text ?? "" : "", /meticulous archive log/);
});

test("later extraction reuses an accepted NPC identity with normal update risk", () => {
  const accepted = note({
    id: "char_roselia",
    title: "Roselia",
    type: "character",
    subjects: [{ key: "npc:roselia" }],
    sections: {
      facts: { text: "Roselia guards the archive.", updatedAt: timestamp },
    },
  });
  const catalog = buildTrustedLtmSubjectCatalog({ roster: [], notes: [accepted] });
  const resolved = resolveLtmSubjectIdentities({
    catalog,
    existingNotes: catalog.notes,
    sourceBackedNpcSourceText: "Roselia now keeps a meticulous archive log.",
    units: [
      unit("character_fact", "provider_guess", {
        subjectNames: ["Roselia"],
        text: "Roselia keeps a meticulous archive log.",
      }),
    ],
  });

  assert.equal(resolved.droppedCandidates.length, 0);
  assert.equal(noteIdForEvidenceUnit(resolved.units[0]!), accepted.id);
  const compiled = compileLtmEvidenceUnits({
    units: resolved.units,
    existingNotes: resolved.existingNotes,
    scope: { chatIds: ["chat_a"] },
    modes: ["roleplay"],
    createdAt: timestamp,
  });
  assert(compiled.mutations.length > 0);
  assert(compiled.mutations.every((mutation) => mutation.risk === "low"));
});

test("ambiguous aliases, generic roles, and unsupported names are rejected", () => {
  const catalog = buildTrustedLtmSubjectCatalog({
    roster: [
      { kind: "character", id: "sayo-one", name: "Sayo Hikawa" },
      { kind: "character", id: "sayo-two", name: "Sayo Yamato" },
    ],
    notes: [],
  });
  const result = resolveLtmSubjectIdentities({
    catalog,
    existingNotes: [],
    sourceBackedNpcSourceText:
      "Sayo spoke to the guitarist, Technician, Archivist, Lead Guitarist, A Guitarist, Engineer, Lead Engineer, Librarian, Blacksmith, Commander, Knight, Surgeon, Constable, Royal Guard, Chief, Temple Guard, and Unknown Soldier. User and Narrator watched from the booth.",
    units: [
      unit("character_fact", "ambiguous", { subjectNames: ["Sayo"] }),
      unit("character_fact", "descriptor", { subjectNames: ["guitarist"] }),
      unit("character_fact", "technician", { subjectNames: ["Technician"] }),
      unit("character_fact", "archivist", { subjectNames: ["Archivist"] }),
      unit("character_fact", "lead_guitarist", { subjectNames: ["Lead Guitarist"] }),
      unit("character_fact", "a_guitarist", { subjectNames: ["A Guitarist"] }),
      unit("character_fact", "engineer", { subjectNames: ["Engineer"] }),
      unit("character_fact", "lead_engineer", { subjectNames: ["Lead Engineer"] }),
      unit("character_fact", "librarian", { subjectNames: ["Librarian"] }),
      unit("character_fact", "blacksmith", { subjectNames: ["Blacksmith"] }),
      unit("character_fact", "commander", { subjectNames: ["Commander"] }),
      unit("character_fact", "knight", { subjectNames: ["Knight"] }),
      unit("character_fact", "surgeon", { subjectNames: ["Surgeon"] }),
      unit("character_fact", "constable", { subjectNames: ["Constable"] }),
      unit("character_fact", "royal_guard", { subjectNames: ["Royal Guard"] }),
      unit("character_fact", "chief", { subjectNames: ["Chief"] }),
      unit("character_fact", "temple_guard", { subjectNames: ["Temple Guard"] }),
      unit("character_fact", "unknown_soldier", { subjectNames: ["Unknown Soldier"] }),
      unit("character_fact", "generic_user", { subjectNames: ["User"] }),
      unit("character_fact", "generic_assistant", { subjectNames: ["Assistant"] }),
      unit("character_fact", "generic_narrator", { subjectNames: ["Narrator"] }),
      unit("character_fact", "unsupported", { subjectNames: ["Roselia"] }),
    ],
  });

  assert.deepEqual(result.units, []);
  assert.equal(result.droppedCandidates.length, 22);
  assert.equal(result.droppedCandidates[0]?.reason, "ambiguous_subject");
  assert.equal(
    result.droppedCandidates.slice(1).every((candidate) => candidate.reason === "untrusted_subject"),
    true,
  );
});

test("legacy keys are corrected from a unique name and rejected when the name is ambiguous", () => {
  const catalog = buildTrustedLtmSubjectCatalog({
    roster: [
      { kind: "character", id: "damo-id", name: "Damo Korvak" },
      { kind: "character", id: "lisa-id", name: "Lisa Imai" },
      { kind: "character", id: "sayo-one", name: "Sayo Hikawa" },
      { kind: "character", id: "sayo-two", name: "Sayo Yamato" },
    ],
    notes: [],
  });
  const result = resolveLtmSubjectIdentities({
    catalog,
    existingNotes: [],
    sourceBackedNpcSourceText: "Damo returned the key. Sayo watched from the doorway.",
    units: [
      unit("character_fact", "lisa_imai", {
        subjectNames: ["Damo"],
        subjectKeys: ["character:lisa-id"],
      }),
      unit("character_fact", "damo_korvak", {
        subjectNames: ["Sayo"],
        subjectKeys: ["character:damo-id"],
      }),
      unit("character_fact", "damo_korvak", {
        subjectNames: ["Roselia"],
        subjectKeys: ["character:damo-id"],
      }),
    ],
  });

  assert.equal(result.units.length, 1);
  assert.equal(noteIdForEvidenceUnit(result.units[0]!), "char_damo_korvak");
  assert.deepEqual(result.units[0]?.subjectKeys, ["character:damo-id"]);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "subject_identity_corrected"), true);
  assert.equal(result.droppedCandidates[0]?.reason, "ambiguous_subject");
  assert.equal(result.droppedCandidates[1]?.reason, "untrusted_subject");
});

test("canonical identity remaps same-batch links to the resolved character note", () => {
  const result = resolveLtmSubjectIdentities({
    catalog: damoLisaCatalog(),
    existingNotes: [],
    units: [
      unit("timeline_event", "damo_arrival", {
        sectionKey: "event",
        links: [{ target: "char_damo_considerate_nature", relation: "affects_character" }],
      }),
      unit("character_fact", "damo_considerate_nature"),
    ],
  });
  assert.equal(result.units[0]?.links[0]?.target, "char_damo_korvak");
});

test("canonical identity does not guess when a disposable target resolves to different people", () => {
  for (const subjectNames of [
    ["Damo", "Lisa"],
    ["Lisa", "Damo"],
  ] as const) {
    const result = resolveLtmSubjectIdentities({
      catalog: damoLisaCatalog(),
      existingNotes: [],
      sourceBackedNpcSourceText: "Damo and Lisa returned to the archive.",
      units: [
        unit("timeline_event", "archive_return", {
          sectionKey: "event",
          links: [{ target: "char_reused", relation: "affects_character" }],
        }),
        ...subjectNames.map((subjectName) =>
          unit("character_fact", "reused", { subjectNames: [subjectName] }),
        ),
      ],
    });

    assert.equal(result.units[0]?.links[0]?.target, "char_reused");
    const diagnostic = result.diagnostics.find((candidate) => candidate.code === "ambiguous_subject_link_target");
    assert.equal(diagnostic?.details?.linkTarget, "char_reused");
    assert.equal(diagnostic?.details?.linkRelation, "affects_character");
    assert.deepEqual(diagnostic?.details?.candidateTargetNoteIds, ["char_damo_korvak", "char_lisa_imai"]);
  }
});

test("canonical identity still remaps a repeated disposable target with one canonical identity", () => {
  const result = resolveLtmSubjectIdentities({
    catalog: damoLisaCatalog(),
    existingNotes: [],
    units: [
      unit("timeline_event", "archive_return", {
        sectionKey: "event",
        links: [{ target: "char_reused", relation: "affects_character" }],
      }),
      unit("character_fact", "reused", { subjectNames: ["Damo"] }),
      unit("character_fact", "reused", { subjectNames: ["Damo"] }),
    ],
  });

  assert.equal(result.units[0]?.links[0]?.target, "char_damo_korvak");
  assert.equal(result.diagnostics.some((candidate) => candidate.code === "ambiguous_subject_link_target"), false);
});

test("exact full-name legacy note wins canonical targeting and receives a safe binding mutation", () => {
  const shorthand = note({
    id: "char_damo",
    title: "Damo",
    type: "character",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  const exact = note({
    id: "char_damo_korvak",
    title: "Damo Korvak",
    type: "character",
    createdAt: "2026-07-03T00:00:00.000Z",
  });
  const result = resolveLtmSubjectIdentities({
    catalog: damoLisaCatalog([shorthand, exact]),
    existingNotes: [],
    units: [unit("character_fact", "damo_considerate_nature")],
  });

  assert.equal(noteIdForEvidenceUnit(result.units[0]!), exact.id);
  assert.deepEqual(result.legacyBindings.get(exact.id)?.map((subject) => subject.key), ["character:damo-id"]);
  const compiled = compileLtmEvidenceUnits({
    units: result.units,
    existingNotes: result.existingNotes,
    scope: { chatIds: ["chat_a"] },
    modes: ["roleplay"],
  });
  assert.equal(compiled.mutations.some((mutation) => mutation.kind === "set_subjects" && mutation.noteId === exact.id), true);
  assert.equal(compiled.mutations.some((mutation) => mutation.kind === "create_note"), false);
});

test("ambiguous aliases and three-subject relationships are blocked with typed diagnostics", () => {
  const catalog = buildTrustedLtmSubjectCatalog({
    roster: [
      { kind: "character", id: "alice-id", name: "Alice Hart", aliases: ["Ace"] },
      { kind: "character", id: "alina-id", name: "Alina Cross", aliases: ["Ace"] },
      { kind: "character", id: "damo-id", name: "Damo Korvak", aliases: ["Damo"] },
      { kind: "character", id: "lisa-id", name: "Lisa Imai", aliases: ["Lisa"] },
      { kind: "character", id: "roselia-id", name: "Roselia", aliases: [] },
    ],
    notes: [],
  });
  const result = resolveLtmSubjectIdentities({
    catalog,
    existingNotes: [],
    units: [unit("character_fact", "ace"), unit("relationship_state", "damo_lisa_roselia")],
  });

  assert.deepEqual(result.units, []);
  assert.deepEqual(result.droppedCandidates.map((candidate) => candidate.reason), [
    "ambiguous_subject",
    "invalid_subject_cardinality",
  ]);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
    "ambiguous_subject_identity",
    "invalid_subject_cardinality",
  ]);
});

test("a composite character candidate is rejected without removing valid individual facts", () => {
  const catalog = buildTrustedLtmSubjectCatalog({
    roster: [
      { kind: "character", id: "roselia-id", name: "Roselia" },
      { kind: "character", id: "damo-id", name: "Damo Korvak", aliases: ["Damo"] },
    ],
    notes: [],
  });
  const result = resolveLtmSubjectIdentities({
    catalog,
    existingNotes: [],
    units: [unit("character_fact", "roselia_damo"), unit("character_fact", "roselia")],
  });
  assert.equal(result.units.length, 1);
  assert.equal(noteIdForEvidenceUnit(result.units[0]!), "char_roselia");
  assert.equal(result.diagnostics[0]?.code, "composite_character_subject");
});

test("renamed and deleted roster entities retain identity through already-bound in-scope notes", () => {
  const subject = { key: "persona:damo-id", ref: { kind: "persona", id: "damo-id" } } satisfies LtmSubject;
  const bound = note({
    id: "char_damo",
    title: "Damo Korvak",
    type: "character",
    subjects: [subject],
  });
  const renamedCatalog = buildTrustedLtmSubjectCatalog({
    roster: [{ kind: "persona", id: "damo-id", name: "Damo Vale" }],
    notes: [bound],
  });
  const renamed = resolveLtmSubjectIdentities({
    catalog: renamedCatalog,
    existingNotes: [],
    units: [unit("character_fact", "damo_korvak")],
  });
  assert.equal(noteIdForEvidenceUnit(renamed.units[0]!), bound.id);

  const deletedCatalog = buildTrustedLtmSubjectCatalog({ roster: [], notes: [bound] });
  const deleted = resolveLtmSubjectIdentities({
    catalog: deletedCatalog,
    existingNotes: [],
    units: [unit("character_fact", "damo")],
  });
  assert.equal(noteIdForEvidenceUnit(deleted.units[0]!), bound.id);
});

test("matching subjects do not bypass current visibility scope", async () => {
  const catalog = damoLisaCatalog();
  const identity = resolveLtmSubjectIdentities({
    catalog,
    existingNotes: [],
    units: [unit("character_fact", "damo")],
  });
  const outOfScope = note({
    id: "char_damo_korvak",
    title: "Damo Korvak",
    type: "character",
    scope: { chatIds: ["chat_b"] },
    subjects: identity.units[0]?.subjects,
  });
  const scoped = await resolveScopedEvidenceUnitTargets({
    units: identity.units,
    existingNotes: [],
    scope: { chatIds: ["chat_a"] },
    storage: {
      async getNotesByIds(ids) {
        return new Map(ids.includes(outOfScope.id) ? [[outOfScope.id, outOfScope]] : []);
      },
    },
  });
  assert.notEqual(noteIdForEvidenceUnit(scoped.units[0]!), outOfScope.id);
  assert.equal(scoped.diagnostics[0]?.code, "target_note_scoped_variant");
});

test("imported summaries admit explicitly named unbound NPC character facts", () => {
  const result = resolveLtmSubjectIdentities({
    catalog: damoLisaCatalog(),
    existingNotes: [],
    sourceBackedNpcSourceText: "Sayo Hikawa watched Damo perform at The Foundry.",
    units: [unit("character_fact", "sayo_hikawa", { subjectKeys: [] })],
  });

  assert.equal(result.droppedCandidates.length, 0);
  assert.equal(noteIdForEvidenceUnit(result.units[0]!), "char_sayo_hikawa");
  assert.deepEqual(result.units[0]?.subjects, [{ key: "npc:sayo_hikawa" }]);
  assert.equal(result.diagnostics[0]?.code, "source_backed_npc_identity");
});

test("unbound NPC admission requires an explicit multi-word source name", () => {
  const result = resolveLtmSubjectIdentities({
    catalog: damoLisaCatalog(),
    existingNotes: [],
    sourceBackedNpcSourceText: "The guitarist watched Damo perform.",
    units: [unit("character_fact", "guitarist", { subjectKeys: [] })],
  });

  assert.equal(result.units.length, 0);
  assert.equal(result.droppedCandidates[0]?.reason, "untrusted_subject");
});

test("provider schema requires source-visible names while legacy keys remain optional", () => {
  const catalog = damoLisaCatalog();
  const promptCatalog = trustedLtmSubjectPromptCatalog(catalog);
  const format = evidenceUnitResponseFormat({
    allowedBuckets: ["character_fact", "relationship_state"],
    sourceHash,
  });
  const serializedFormat = JSON.stringify(format);
  assert.match(serializedFormat, /subjectNames/);
  assert.doesNotMatch(serializedFormat, /"required":\[[^\]]*"subjectKeys"/);
  assert.match(serializedFormat, /"minItems":1,"maxItems":1/);
  assert.match(serializedFormat, /"minItems":2,"maxItems":2/);
  assert.match(serializedFormat, /"maxItems":0/);

  const source = note({
    id: "source_summary",
    type: "source",
    tags: ["source"],
    sections: { source: { text: "Damo and Lisa spoke.", updatedAt: timestamp } },
  });
  const messages = evidenceUnitMessages({
    sourceNote: source,
    sourceText: source.sections.source!.text,
    existingNotes: [],
    provider: {} as BaseLLMProvider,
    model: "test-model",
    scope: source.scope,
    modes: ["roleplay"],
    sourceHash,
    systemPrompt: "A custom template that says nothing about subjects.",
    trustedSubjectCatalog: catalog,
  });
  const payload = JSON.parse(messages[1]!.content) as Record<string, unknown>;
  assert.deepEqual(payload.trustedSubjects, promptCatalog);
  assert.match(JSON.stringify(payload), /source-visible/);
});

test("provider prompt admits source-visible new names for every LLM source", () => {
  const format = evidenceUnitResponseFormat({
    allowedBuckets: ["character_fact", "relationship_state"],
    sourceHash,
  });
  const serializedFormat = JSON.stringify(format);
  assert.match(serializedFormat, /"minItems":1,"maxItems":1/);

  const source = note({
    id: "source_summary",
    type: "source",
    tags: ["source_summary", "imported_chat"],
    sections: { source: { text: "Sayo Hikawa watched Damo perform.", updatedAt: timestamp } },
  });
  const messages = evidenceUnitMessages({
    sourceNote: source,
    sourceText: source.sections.source!.text,
    existingNotes: [],
    provider: {} as BaseLLMProvider,
    model: "test-model",
    scope: source.scope,
    modes: ["roleplay"],
    sourceHash,
    systemPrompt: "A custom template that says nothing about subjects.",
  });
  const payload = JSON.parse(messages[1]!.content) as { targetNoteRules?: string[] };
  assert.match(payload.targetNoteRules?.join(" ") ?? "", /one to four token proper name/);
});
