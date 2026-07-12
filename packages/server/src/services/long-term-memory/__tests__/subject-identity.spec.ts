import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("provider schema and prompt keep trusted subject cardinality server-owned", () => {
  const catalog = damoLisaCatalog();
  const promptCatalog = trustedLtmSubjectPromptCatalog(catalog);
  const format = evidenceUnitResponseFormat({
    allowedBuckets: ["character_fact", "relationship_state"],
    sourceHash,
    trustedSubjectKeys: promptCatalog.map((entry) => entry.key),
  });
  const serializedFormat = JSON.stringify(format);
  assert.match(serializedFormat, /subjectKeys/);
  assert.match(serializedFormat, /character:damo-id/);
  assert.match(serializedFormat, /"minItems":2,"maxItems":2/);

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
});

test("provider schema permits unbound NPC character facts only when requested", () => {
  const format = evidenceUnitResponseFormat({
    allowedBuckets: ["character_fact", "relationship_state"],
    sourceHash,
    allowSourceBackedNpcSubjects: true,
  });
  const serializedFormat = JSON.stringify(format);
  assert.match(serializedFormat, /"minItems":0,"maxItems":1/);

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
    allowSourceBackedNpcSubjects: true,
  });
  const payload = JSON.parse(messages[1]!.content) as { targetNoteRules?: string[] };
  assert.match(payload.targetNoteRules?.join(" ") ?? "", /explicitly named multi-word NPC/);
});
