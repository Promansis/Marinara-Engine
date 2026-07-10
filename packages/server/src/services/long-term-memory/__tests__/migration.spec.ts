import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import { runLtmMigration } from "../migration/migrate-remove-buckets.js";
import { sourceNoteIdForProvenance } from "../source-identity.js";
import { LongTermMemoryStorage } from "../storage.js";

const timestamp = "2026-07-10T00:00:00.000Z";

test("LTM migration dry-runs without writes and migrates source identity idempotently", async () => {
  const parent = await mkdtemp(join(tmpdir(), "marinara-ltm-migration-"));
  const root = join(parent, "long-term-memory");
  const backupDir = join(parent, "backups");
  const oldSourceId = "source_import_character_old_name_abcdef1234";
  const provenance = { kind: "character", sourceId: "character-123" } as const;
  const nextSourceId = sourceNoteIdForProvenance(provenance);
  const draftId = randomUUID();
  try {
    await mkdir(join(root, "vault", "sources"), { recursive: true });
    await mkdir(join(root, "vault", "world"), { recursive: true });
    await mkdir(join(root, "drafts"), { recursive: true });
    await writeFile(
      join(root, "vault", "sources", `${oldSourceId}.json`),
      JSON.stringify({
        id: oldSourceId,
        type: "source",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary", "imported_character"],
        keywords: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        links: [],
        sections: {
          source: {
            text: "Major: A patient navigator who never abandons the crew.",
            updatedAt: timestamp,
            evidence: ["character:character-123"],
          },
        },
        version: 1,
        previousHash: "legacy-hash",
      }),
    );
    await writeFile(
      join(root, "vault", "world", "world_navigation.json"),
      JSON.stringify({
        id: "world_navigation",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["typed_memory"],
        keywords: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        links: [{ target: oldSourceId, relation: "extracted_from" }],
        sections: { facts: { text: "Navigation matters.", updatedAt: timestamp } },
        version: 1,
      }),
    );
    await writeFile(
      join(root, "drafts", `${draftId}.json`),
      JSON.stringify({
        id: draftId,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
        source: { sourceNoteId: oldSourceId },
        scope: {},
        modes: ["roleplay"],
        summary: "Legacy draft",
        mutations: [{
          id: randomUUID(),
          kind: "add_link",
          risk: "low",
          confidence: 0.9,
          summary: "Retain source provenance",
          evidence: [`source_note:${oldSourceId}`],
          noteId: "world_navigation",
          link: { target: oldSourceId, relation: "extracted_from" },
        }],
      }),
    );

    const before = (await readdir(root)).sort();
    const dryRun = await runLtmMigration({ root, dryRun: true, noBackup: false, backupDir });
    assert.equal(dryRun.changed, 1);
    assert.deepEqual((await readdir(root)).sort(), before);
    await assert.rejects(readFile(join(root, "config", "settings.json"), "utf8"));

    let rebuilds = 0;
    const migrated = await runLtmMigration(
      { root, dryRun: false, noBackup: false, backupDir },
      { rebuild: async () => {
        rebuilds += 1;
        return {} as never;
      } },
    );
    assert.equal(migrated.changed, 1);
    assert.equal(rebuilds, 1);
    assert(migrated.backupPath);
    await readFile(join(migrated.backupPath, "vault", "sources", `${oldSourceId}.json`), "utf8");

    const storage = new LongTermMemoryStorage(root);
    assert.equal(await storage.getNote(oldSourceId), null);
    const source = await storage.getNote(nextSourceId);
    assert.deepEqual(source?.provenance, provenance);
    assert.equal(source?.sections.source?.importance, "major");
    assert.equal(source?.sections.source?.text, "A patient navigator who never abandons the crew.");
    const linked = await storage.getNote("world_navigation");
    assert(linked?.links.some((link) => link.target === nextSourceId));
    const draft = await new LongTermMemoryDraftStore(root).getDraft(draftId);
    assert.equal(draft?.source.sourceNoteId, nextSourceId);
    assert(draft?.mutations.some((mutation) => mutation.kind === "add_link" && mutation.link.target === nextSourceId));

    const rerun = await runLtmMigration(
      { root, dryRun: false, noBackup: true },
      { rebuild: async () => {
        throw new Error("idempotent migration must not rebuild");
      } },
    );
    assert.equal(rerun.changed, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("LTM migration rejects source identity collisions before writing", async () => {
  const parent = await mkdtemp(join(tmpdir(), "marinara-ltm-migration-collision-"));
  const root = join(parent, "long-term-memory");
  const backupDir = join(parent, "backups");
  try {
    await mkdir(join(root, "vault", "sources"), { recursive: true });
    for (const id of ["source_import_character_first", "source_import_character_second"]) {
      await writeFile(join(root, "vault", "sources", `${id}.json`), JSON.stringify({
        id,
        type: "source",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary", "imported_character"],
        keywords: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        links: [],
        sections: { source: { text: id, updatedAt: timestamp, evidence: ["character:same-source"] } },
        version: 1,
      }));
    }

    await assert.rejects(
      runLtmMigration({ root, dryRun: false, noBackup: false, backupDir }),
      /would create duplicate note IDs/,
    );
    assert.deepEqual((await readdir(join(root, "vault", "sources"))).sort(), [
      "source_import_character_first.json",
      "source_import_character_second.json",
    ]);
    await assert.rejects(readdir(backupDir));
    await assert.rejects(readFile(join(root, "config", "settings.json"), "utf8"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("LTM migration refuses backup destinations inside the memory root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "marinara-ltm-migration-backup-path-"));
  const root = join(parent, "long-term-memory");
  const id = "source_import_character_unsafe_backup";
  try {
    await mkdir(join(root, "vault", "sources"), { recursive: true });
    await writeFile(join(root, "vault", "sources", `${id}.json`), JSON.stringify({
      id,
      type: "source",
      status: "active",
      modes: ["roleplay"],
      scope: {},
      tags: ["source_summary", "imported_character"],
      keywords: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      links: [],
      sections: { source: { text: "Unsafe backup path.", updatedAt: timestamp, evidence: ["character:unsafe"] } },
      version: 1,
    }));

    await assert.rejects(
      runLtmMigration({ root, dryRun: false, noBackup: false, backupDir: join(root, "backups") }),
      /backup destination must be outside/,
    );
    await readFile(join(root, "vault", "sources", `${id}.json`), "utf8");
    await assert.rejects(readFile(join(root, "config", "settings.json"), "utf8"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
