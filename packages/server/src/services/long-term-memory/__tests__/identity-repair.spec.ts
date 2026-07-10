import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ltmNoteSchema, type LtmNote } from "@marinara-engine/shared";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import {
  applyLtmIdentityRepairs,
  getLtmIdentityRepairBackupsRoot,
  LtmIdentityRepairError,
  previewLtmIdentityRepairs,
  restoreLtmIdentityRepairBackup,
  type LtmIdentityRepairBackup,
} from "../identity-repair.js";
import { notePathForId } from "../paths.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import { LongTermMemoryStorage } from "../storage.js";
import { buildTrustedLtmSubjectCatalog } from "../subject-identity.js";

const NOW = "2026-07-10T00:00:00.000Z";

function note(input: Partial<LtmNote> & Pick<LtmNote, "id" | "type">): LtmNote {
  return ltmNoteSchema.parse({
    id: input.id,
    type: input.type,
    title: input.title,
    status: input.status ?? "active",
    modes: input.modes ?? ["roleplay"],
    scope: input.scope ?? { chatId: "chat_a", chatIds: ["chat_a"] },
    tags: input.tags ?? ["typed_memory"],
    keywords: input.keywords ?? [],
    createdAt: input.createdAt ?? NOW,
    updatedAt: input.updatedAt ?? input.createdAt ?? NOW,
    links: input.links ?? [],
    sections: input.sections ?? {},
    conflicts: input.conflicts,
    subjects: input.subjects,
    version: input.version ?? 1,
  });
}

function catalog(notes: LtmNote[]) {
  return buildTrustedLtmSubjectCatalog({
    roster: [
      { kind: "persona", id: "persona_damo", name: "Damo" },
      { kind: "character", id: "character_lisa", name: "Lisa" },
    ],
    notes,
  });
}

async function withVault(run: (root: string, storage: LongTermMemoryStorage) => Promise<void>) {
  const container = await mkdtemp(join(tmpdir(), "marinara-ltm-identity-repair-"));
  const root = join(container, "long-term-memory");
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();
    await run(root, storage);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
}

test("identity repair preview is dry-run, deterministic, and groups trait and reversed-pair aliases", () => {
  const notes = [
    note({
      id: "char_damo_considerate_nature",
      type: "character",
      createdAt: "2025-01-01T00:00:00.000Z",
      sections: { facts: { text: "- Damo notices when Lisa is uneasy.", updatedAt: NOW } },
    }),
    note({
      id: "char_damo",
      title: "Damo",
      type: "character",
      createdAt: "2026-01-01T00:00:00.000Z",
      sections: { facts: { text: "- Damo keeps his promises.", updatedAt: NOW } },
    }),
    note({
      id: "rel_lisa_damo",
      type: "relationship",
      createdAt: "2025-02-01T00:00:00.000Z",
      sections: { state: { text: "Lisa is cautious around Damo.", updatedAt: NOW } },
    }),
    note({
      id: "rel_damo_lisa",
      type: "relationship",
      createdAt: "2026-02-01T00:00:00.000Z",
      sections: { state: { text: "Damo and Lisa trust each other.", updatedAt: NOW } },
    }),
    note({ id: "char_unknown", title: "Unknown", type: "character" }),
  ];
  const before = JSON.stringify(notes);
  const first = previewLtmIdentityRepairs(catalog(notes), { chatIds: ["chat_a"] }, NOW);
  const second = previewLtmIdentityRepairs(catalog(notes), { chatIds: ["chat_a"] }, NOW);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(notes), before);
  assert.equal(first.counts.candidateCount, 2);
  assert.equal(first.counts.duplicateNotes, 2);
  assert.equal(first.counts.unresolvedNotes, 1);
  assert.equal(first.unresolved[0]?.noteId, "char_unknown");

  const damo = first.candidates.find((candidate) => candidate.noteType === "character");
  assert(damo);
  assert.equal(damo.canonicalNoteId, "char_damo", "exact full name must beat an older fallback");
  assert.deepEqual(damo.duplicateNoteIds, ["char_damo_considerate_nature"]);
  assert(damo.matchBasis.includes("exact_name"));
  assert(damo.matchBasis.includes("trait_or_qualified_alias"));
  assert.deepEqual(damo.additiveContent[0]?.addedLines, ["- Damo notices when Lisa is uneasy."]);

  const relationship = first.candidates.find((candidate) => candidate.noteType === "relationship");
  assert(relationship);
  assert.equal(relationship.canonicalNoteId, "rel_damo_lisa");
  assert.deepEqual(relationship.duplicateNoteIds, ["rel_lisa_damo"]);
  assert.equal(relationship.supersedingConflicts[0]?.sectionKey, "state");
  assert.equal(relationship.supersedingConflicts[0]?.options.length, 2);
});

test("identity repair preview blocks ambiguous aliases instead of binding them", () => {
  const ambiguousCatalog = buildTrustedLtmSubjectCatalog({
    roster: [
      { kind: "character", id: "damo_korvak", name: "Damo Korvak" },
      { kind: "character", id: "damo_rell", name: "Damo Rell" },
    ],
    notes: [note({ id: "char_damo", title: "Damo", type: "character" })],
  });

  const preview = previewLtmIdentityRepairs(ambiguousCatalog, { chatIds: ["chat_a"] }, NOW);
  assert.equal(preview.candidates.length, 0);
  assert.equal(preview.unresolved[0]?.reason, "ambiguous");
  assert.deepEqual(new Set(preview.unresolved[0]?.candidateSubjectKeys), new Set(["character:damo_korvak", "character:damo_rell"]));
});

test("identity repair chooses an exact full-name title before a canonical-looking filename", () => {
  const preview = previewLtmIdentityRepairs(
    catalog([
      note({
        id: "char_damo",
        type: "character",
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
      note({
        id: "char_damo_considerate_nature",
        title: "Damo",
        type: "character",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ]),
    { chatIds: ["chat_a"] },
    NOW,
  );

  assert.equal(preview.candidates[0]?.canonicalNoteId, "char_damo_considerate_nature");
});

test("selected identity repair merges additive lines, rewrites references and drafts, archives duplicates, and restores its backup", async () => {
  await withVault(async (root, storage) => {
    await storage.createNote(
      note({
        id: "char_damo",
        title: "Damo",
        type: "character",
        keywords: ["tea"],
        sections: {
          facts: { text: "- Enjoys tea.", updatedAt: NOW, evidence: ["source_note:source_a"] },
        },
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      note({
        id: "char_damo_considerate_nature",
        type: "character",
        keywords: ["Promises"],
        sections: {
          facts: {
            text: "* enjoys   tea.\n- Keeps promises.",
            updatedAt: NOW,
            evidence: ["source_note:source_b"],
          },
        },
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      note({
        id: "world_reference_holder",
        type: "world",
        links: [{ target: "char_damo_considerate_nature", relation: "affects_character" }],
        sections: { facts: { text: "The town relies on Damo.", updatedAt: NOW } },
      }),
      { suppressEvent: true },
    );

    const draftStore = new LongTermMemoryDraftStore(root);
    const draft = await draftStore.createDraft({
      source: { sourceNoteId: "source_identity_fixture", sourceHash: "a".repeat(64) },
      scope: { chatIds: ["chat_a"] },
      modes: ["roleplay"],
      response: {
        summary: "Pending identity reference",
        mutations: [
          {
            id: randomUUID(),
            kind: "append_section",
            noteId: "char_damo_considerate_nature",
            sectionKey: "facts",
            text: "- Listens carefully.",
            risk: "low",
            confidence: 0.9,
            summary: "Append a Damo fact",
            evidence: ["source_note:source_identity_fixture"],
          },
        ],
      },
    });

    const loadCatalog = async () => catalog(await storage.listNotes());
    const preview = previewLtmIdentityRepairs(await loadCatalog(), { chatIds: ["chat_a"] }, NOW);
    const candidate = preview.candidates.find((item) => item.noteType === "character");
    assert(candidate);
    let rebuildCount = 0;
    const result = await applyLtmIdentityRepairs(
      {
        scope: { chatIds: ["chat_a"] },
        repairs: [
          {
            candidateId: candidate.id,
            canonicalNoteId: candidate.canonicalNoteId,
            excludedNoteIds: [],
            sectionChoices: [],
          },
        ],
      },
      {
        root,
        loadCatalog,
        rebuild: async (options) => {
          rebuildCount += 1;
          return rebuildLongTermMemoryIndexes(options);
        },
      },
    );

    assert.equal(rebuildCount, 1);
    assert.equal(result.repairs[0]?.canonicalNoteId, "char_damo");
    assert.deepEqual(result.repairs[0]?.archivedNoteIds, ["char_damo_considerate_nature"]);
    assert.equal(result.repairs[0]?.rewrittenNoteCount, 1);
    assert.equal(result.repairs[0]?.rewrittenDraftCount, 1);
    assert.equal(result.integrity.health, "healthy");

    const canonical = await storage.getNote("char_damo");
    assert(canonical);
    assert.equal(canonical.sections.facts?.text, "- Enjoys tea.\n- Keeps promises.");
    assert.deepEqual(canonical.keywords, ["tea", "Promises"]);
    assert.deepEqual(canonical.subjects, [{ key: "persona:persona_damo", ref: { kind: "persona", id: "persona_damo" } }]);
    assert.equal((await storage.getNote("char_damo_considerate_nature"))?.status, "archived");
    assert.deepEqual((await storage.getNote("world_reference_holder"))?.links, [
      { target: "char_damo", relation: "affects_character" },
    ]);
    const rewrittenMutation = (await draftStore.getDraft(draft.id))?.mutations[0];
    assert.equal(rewrittenMutation?.kind, "append_section");
    assert(rewrittenMutation?.kind === "append_section");
    assert.equal(rewrittenMutation.noteId, "char_damo");

    const afterPreview = previewLtmIdentityRepairs(await loadCatalog(), { chatIds: ["chat_a"] }, NOW);
    assert.equal(afterPreview.candidates.length, 0, "a confirmed repair must not be offered again");

    const backupDirectory = join(getLtmIdentityRepairBackupsRoot(root), result.backup.id);
    const backup: LtmIdentityRepairBackup = {
      id: result.backup.id,
      createdAt: result.backup.createdAt,
      directory: backupDirectory,
      snapshotRoot: join(backupDirectory, basename(root)),
    };
    const duplicateBackup = JSON.parse(
      await readFile(notePathForId("char_damo_considerate_nature", "character", backup.snapshotRoot), "utf8"),
    ) as LtmNote;
    assert.equal(duplicateBackup.status, "active");

    await restoreLtmIdentityRepairBackup(root, backup);
    const restoredStorage = new LongTermMemoryStorage(root);
    assert.equal((await restoredStorage.getNote("char_damo"))?.subjects, undefined);
    assert.equal((await restoredStorage.getNote("char_damo_considerate_nature"))?.status, "active");
    assert.deepEqual((await restoredStorage.getNote("world_reference_holder"))?.links, [
      { target: "char_damo_considerate_nature", relation: "affects_character" },
    ]);
  });
});

test("identity repair requires superseding choices and rolls the full root back after a write failure", async () => {
  await withVault(async (root, storage) => {
    await storage.createNote(
      note({
        id: "rel_damo_lisa",
        type: "relationship",
        sections: { state: { text: "Damo and Lisa trust each other.", updatedAt: NOW } },
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      note({
        id: "rel_lisa_damo",
        type: "relationship",
        sections: { state: { text: "Lisa remains cautious around Damo.", updatedAt: NOW } },
      }),
      { suppressEvent: true },
    );
    const loadCatalog = async () => catalog(await storage.listNotes());
    const preview = previewLtmIdentityRepairs(await loadCatalog(), { chatIds: ["chat_a"] }, NOW);
    const candidate = preview.candidates[0];
    assert(candidate);

    await assert.rejects(
      applyLtmIdentityRepairs(
        {
          scope: { chatIds: ["chat_a"] },
          repairs: [
            {
              candidateId: candidate.id,
              canonicalNoteId: candidate.canonicalNoteId,
              excludedNoteIds: [],
              sectionChoices: [],
            },
          ],
        },
        { root, loadCatalog },
      ),
      (error: unknown) => error instanceof LtmIdentityRepairError && error.code === "identity_repair_conflict_unresolved",
    );
    await assert.rejects(readdir(getLtmIdentityRepairBackupsRoot(root)), { code: "ENOENT" });

    let rebuildCount = 0;
    await assert.rejects(
      applyLtmIdentityRepairs(
        {
          scope: { chatIds: ["chat_a"] },
          repairs: [
            {
              candidateId: candidate.id,
              canonicalNoteId: candidate.canonicalNoteId,
              excludedNoteIds: [],
              sectionChoices: [{ sectionKey: "state", noteId: "rel_lisa_damo" }],
            },
          ],
        },
        {
          root,
          loadCatalog,
          rebuild: async (options) => {
            rebuildCount += 1;
            return rebuildLongTermMemoryIndexes(options);
          },
          hooks: {
            afterCanonicalWrite: () => {
              throw new Error("injected repair failure");
            },
          },
        },
      ),
      /injected repair failure/,
    );

    assert.equal(rebuildCount, 0);
    assert.equal((await storage.getNote("rel_damo_lisa"))?.sections.state?.text, "Damo and Lisa trust each other.");
    assert.equal((await storage.getNote("rel_damo_lisa"))?.subjects, undefined);
    assert.equal((await storage.getNote("rel_lisa_damo"))?.status, "active");
    const backupIds = await readdir(getLtmIdentityRepairBackupsRoot(root));
    assert.equal(backupIds.length, 1, "rollback must retain the recovery backup");
  });
});

test("selected relationship repair keeps the user-chosen superseding state", async () => {
  await withVault(async (root, storage) => {
    await mkdir(root, { recursive: true });
    for (const relationship of [
      note({
        id: "rel_damo_lisa",
        type: "relationship",
        sections: { state: { text: "Damo and Lisa trust each other.", updatedAt: NOW } },
      }),
      note({
        id: "rel_lisa_damo",
        type: "relationship",
        sections: { state: { text: "Lisa remains cautious around Damo.", updatedAt: NOW } },
      }),
    ]) {
      await storage.createNote(relationship, { suppressEvent: true });
    }
    const loadCatalog = async () => catalog(await storage.listNotes());
    const candidate = previewLtmIdentityRepairs(await loadCatalog(), { chatIds: ["chat_a"] }, NOW).candidates[0];
    assert(candidate);

    await applyLtmIdentityRepairs(
      {
        scope: { chatIds: ["chat_a"] },
        repairs: [
          {
            candidateId: candidate.id,
            canonicalNoteId: "rel_damo_lisa",
            excludedNoteIds: [],
            sectionChoices: [{ sectionKey: "state", noteId: "rel_lisa_damo" }],
          },
        ],
      },
      { root, loadCatalog },
    );

    assert.equal((await storage.getNote("rel_damo_lisa"))?.sections.state?.text, "Lisa remains cautious around Damo.");
    assert.equal((await storage.getNote("rel_lisa_damo"))?.status, "archived");
  });
});
