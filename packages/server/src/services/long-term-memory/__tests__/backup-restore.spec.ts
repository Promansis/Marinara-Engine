import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import type { LtmBudgetedChunk } from "../budget.js";
import { buildApp } from "../../../app.js";
import {
  copyLongTermMemoryBackupSnapshot,
  restoreLongTermMemoryBackup,
  type LtmBackupRestorePhase,
} from "../backup-restore.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import { getLongTermMemoryDirectories } from "../paths.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import { getLtmGlobalSettings, updateLtmGlobalSettings } from "../settings.js";
import { LongTermMemoryStorage } from "../storage.js";
import { readLongTermMemoryInjectionReceipt, readLongTermMemoryUsage, recordLongTermMemoryInjection } from "../usage.js";
import { withLtmVaultLock } from "../vault-lock.js";

const timestamp = "2026-07-12T00:00:00.000Z";
const localEmbedder = async (texts: string[]) => texts.map(() => []);

function receiptChunk(): LtmBudgetedChunk {
  return {
    chunk: {
      id: "world_backup::facts",
      noteId: "world_backup",
      sectionKey: "facts",
      text: "The backup fact is authoritative.",
      sourceHash: "a".repeat(64),
      noteType: "world",
      status: "active",
      tags: ["backup"],
      keywords: ["backup"],
      scope: { chatId: "chat_backup" },
      updatedAt: timestamp,
    },
    score: 1,
    reasons: ["direct"],
    lanes: ["direct"],
    tier: 1,
    estimatedTokens: 8,
  };
}

async function stageDirectory(source: string, destination: string) {
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

async function addDirectoryToZip(zip: AdmZip, root: string, prefix: string) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const archivePath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, path, archivePath);
    } else if (entry.isFile()) {
      zip.addFile(archivePath, await readFile(path));
    }
  }
}

function multipartZipBody(zip: AdmZip, filename: string) {
  const boundary = "----marinara-ltm-backup-restore-test";
  const archive = zip.toBuffer();
  const before = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    "utf8",
  );
  const after = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    body: Buffer.concat([before, archive, after]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function seedBackupFixture(root: string) {
  const storage = new LongTermMemoryStorage(root);
  await storage.createNote({
    id: "source_backup",
    type: "source",
    title: "Backup source",
    status: "active",
    modes: ["roleplay"],
    scope: { chatId: "chat_backup" },
    tags: ["source_summary"],
    keywords: ["backup"],
    links: [],
    sections: { source: { text: "Source material retained in the backup.", updatedAt: timestamp } },
  });
  await storage.createNote({
    id: "world_backup",
    type: "world",
    title: "Backup world",
    status: "active",
    modes: ["roleplay"],
    scope: { chatId: "chat_backup" },
    tags: ["backup"],
    keywords: ["backup"],
    links: [{ target: "source_backup", relation: "extracted_from" }],
    sections: { facts: { text: "The backup fact is authoritative.", updatedAt: timestamp } },
  });
  await new LongTermMemoryDraftStore(root).createDraft({
    scope: { chatId: "chat_backup" },
    modes: ["roleplay"],
    source: { sourceNoteId: "source_backup", chatId: "chat_backup" },
    response: { summary: "A preserved draft.", mutations: [] },
  });
  await updateLtmGlobalSettings(
    {
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: 321,
    },
    root,
  );
  await recordLongTermMemoryInjection(
    {
      chatId: "chat_backup",
      chunks: [receiptChunk()],
      serializedTokenCount: 8,
    },
    root,
  );
  await rebuildLongTermMemoryIndexes({ root, localEmbedder });
  await writeFile(join(getLongTermMemoryDirectories(root).indexes, "forged-imported-index.json"), "forged", "utf8");
}

async function createBackupFixture(root: string) {
  await seedBackupFixture(root);
  const backupRoot = join(root, "..", "backup-root");
  assert.equal(await copyLongTermMemoryBackupSnapshot(root, backupRoot), true);
  return backupRoot;
}

async function mutateLiveVault(root: string) {
  const storage = new LongTermMemoryStorage(root);
  await storage.updateNote("world_backup", {
    sections: { facts: { text: "The live vault changed after backup.", updatedAt: "2026-07-12T01:00:00.000Z" } },
  });
  await updateLtmGlobalSettings({ enableLongTermMemory: false }, root);
}

async function withFixture(run: (root: string, backupRoot: string) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), "marinara-ltm-backup-restore-"));
  const root = join(parent, "long-term-memory");
  try {
    const backupRoot = await createBackupFixture(root);
    await run(root, backupRoot);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("LTM backup restore round-trips canonical data and rebuilds imported indexes locally", async () => {
  await withFixture(async (root, backupRoot) => {
    await mutateLiveVault(root);

    const result = await restoreLongTermMemoryBackup({
      root,
      stage: (stagingRoot) => stageDirectory(backupRoot, stagingRoot),
      rebuildOptions: { localEmbedder },
    });

    const storage = new LongTermMemoryStorage(root);
    const restored = await storage.getNote("world_backup");
    assert.equal(restored?.sections.facts?.text, "The backup fact is authoritative.");
    assert.deepEqual(restored?.links, [{ target: "source_backup", relation: "extracted_from" }]);
    assert.equal((await new LongTermMemoryDraftStore(root).listDrafts()).length, 1);
    assert.equal((await getLtmGlobalSettings(root)).enableLongTermMemory, true);
    assert.equal((await getLtmGlobalSettings(root)).longTermMemoryBudgetTokens, 321);
    assert.equal((await readLongTermMemoryUsage(root)).chats.chat_backup?.chunks[receiptChunk().chunk.id]?.injectionCount, 1);
    assert.equal((await readLongTermMemoryInjectionReceipt("chat_backup", root))?.serializedTokenCount, 8);
    assert.equal(result.integrity.ok, true);
    assert.equal(result.rebuild.noteCount, 2);
    await assert.rejects(
      () => import("node:fs/promises").then(({ access }) => access(join(getLongTermMemoryDirectories(root).indexes, "forged-imported-index.json"))),
      /ENOENT/,
    );
  });
});

test("LTM backup restore rolls back the complete prior root after every publication boundary", async () => {
  const phases: LtmBackupRestorePhase[] = ["staged", "current_root_moved", "published", "rebuilt", "verified"];
  for (const failingPhase of phases) {
    await withFixture(async (root, backupRoot) => {
      await mutateLiveVault(root);
      await assert.rejects(
        () =>
          restoreLongTermMemoryBackup({
            root,
            stage: (stagingRoot) => stageDirectory(backupRoot, stagingRoot),
            rebuildOptions: { localEmbedder },
            hooks: {
              onPhase: (phase) => {
                if (phase === failingPhase) throw new Error(`injected ${phase} failure`);
              },
            },
          }),
        new RegExp(`injected ${failingPhase} failure`),
      );

      const restored = await new LongTermMemoryStorage(root).getNote("world_backup");
      assert.equal(restored?.sections.facts?.text, "The live vault changed after backup.", failingPhase);
      assert.equal((await getLtmGlobalSettings(root)).enableLongTermMemory, false, failingPhase);
    });
  }
});

test("LTM backup snapshots serialize against concurrent canonical mutations", async () => {
  const parent = await mkdtemp(join(tmpdir(), "marinara-ltm-backup-snapshot-"));
  const root = join(parent, "long-term-memory");
  const snapshotRoot = join(parent, "snapshot");
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote({
      id: "world_before_snapshot",
      type: "world",
      status: "active",
      modes: ["roleplay"],
      scope: {},
      tags: [],
      keywords: [],
      links: [],
      sections: { facts: { text: "Before snapshot.", updatedAt: timestamp } },
    });

    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldLock = withLtmVaultLock(root, async () => {
      entered();
      await gate;
    });
    await enteredLock;

    const snapshot = copyLongTermMemoryBackupSnapshot(root, snapshotRoot);
    const mutation = storage.createNote({
      id: "world_after_snapshot",
      type: "world",
      status: "active",
      modes: ["roleplay"],
      scope: {},
      tags: [],
      keywords: [],
      links: [],
      sections: { facts: { text: "After snapshot.", updatedAt: timestamp } },
    });
    release();
    await Promise.all([heldLock, snapshot, mutation]);

    const snapshotNotes = await new LongTermMemoryStorage(snapshotRoot).listNotes();
    assert.deepEqual(snapshotNotes.map((note) => note.id), ["world_before_snapshot"]);
    assert.deepEqual(
      (await storage.listNotes()).map((note) => note.id),
      ["world_after_snapshot", "world_before_snapshot"],
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("full-backup profile imports preserve LTM by default and restore it only when requested", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-default-import-"));
  const root = join(dataDir, "long-term-memory");
  const previousDataDir = process.env.DATA_DIR;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    process.env.DATA_DIR = dataDir;
    await seedBackupFixture(root);
    const backupRoot = join(dataDir, "backup-ltm-root");
    await copyLongTermMemoryBackupSnapshot(root, backupRoot);
    await mutateLiveVault(root);

    const zip = new AdmZip();
    const backupName = "marinara-backup-test";
    zip.addFile(
      `${backupName}/marinara-profile.json`,
      Buffer.from(
        JSON.stringify({
          type: "marinara_profile",
          version: 1,
          exportedAt: timestamp,
          data: { fileStorage: { version: 1, tables: {}, files: [] } },
        }),
        "utf8",
      ),
    );
    await addDirectoryToZip(zip, backupRoot, `${backupName}/long-term-memory`);
    const multipart = multipartZipBody(zip, "full-backup.zip");

    app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/backup/import-profile",
      remoteAddress: "127.0.0.1",
      headers: {
        accept: "application/json",
        "content-type": multipart.contentType,
        "content-length": String(multipart.body.length),
      },
      payload: multipart.body,
    });
    assert.equal(response.statusCode, 200, response.body);
    const live = await new LongTermMemoryStorage(root).getNote("world_backup");
    assert.equal(live?.sections.facts?.text, "The live vault changed after backup.");

    const restoreResponse = await app.inject({
      method: "POST",
      url: "/api/backup/import-profile?restoreLongTermMemory=true",
      remoteAddress: "127.0.0.1",
      headers: {
        accept: "application/json",
        "content-type": multipart.contentType,
        "content-length": String(multipart.body.length),
      },
      payload: multipart.body,
    });
    assert.equal(restoreResponse.statusCode, 200, restoreResponse.body);
    assert.equal(JSON.parse(restoreResponse.body).longTermMemory?.restored, true);

    const restored = await new LongTermMemoryStorage(root).getNote("world_backup");
    assert.equal(restored?.sections.facts?.text, "The backup fact is authoritative.");
    assert.equal((await getLtmGlobalSettings(root)).enableLongTermMemory, true);
    await assert.rejects(
      () =>
        import("node:fs/promises").then(({ access }) =>
          access(join(getLongTermMemoryDirectories(root).indexes, "forged-imported-index.json")),
        ),
      /ENOENT/,
    );
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
