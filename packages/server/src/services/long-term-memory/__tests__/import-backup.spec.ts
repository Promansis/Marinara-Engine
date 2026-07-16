// ──────────────────────────────────────────────
// LTM Import & Backup Contracts
// ──────────────────────────────────────────────
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rename, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { buildApp } from "../../../app.js";
import {
  FULL_BACKUP_DATA_DIRS,
  PROFILE_EXPORT_ASSET_DIRS,
} from "../../../routes/backup.routes.js";
import { LongTermMemoryStorage } from "../storage.js";
import {
  copyLongTermMemoryBackupSnapshot,
  restoreLongTermMemoryBackup,
} from "../backup-restore.js";
import {
  withTempRoot,
  withTempApp,
  worldNote,
} from "./fixtures/ltm-test-harness.js";
import { getLongTermMemoryRoot } from "../paths.js";
import {
  createLtmBackupRestoreJournal,
  ltmBackupRestoreWorkspacePath,
  writeLtmBackupRestoreJournal,
} from "../restore-recovery.js";

test("full backups include LTM without exposing its private store as profile assets", () => {
  assert.ok(FULL_BACKUP_DATA_DIRS.includes("long-term-memory"));
  assert.equal(PROFILE_EXPORT_ASSET_DIRS.includes("long-term-memory"), false);
});

function multipartZipBody(archive: Buffer) {
  const boundary = "----marinara-ltm-backup-contract";
  return {
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="full-backup.zip"\r\nContent-Type: application/zip\r\n\r\n`,
        "utf8",
      ),
      archive,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

await test("full-backup import preserves LTM by default and restores it only when requested", async () => {
  await withTempApp(async (dataDir) => {
    const root = getLongTermMemoryRoot(dataDir);
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(worldNote("world_route_backup", "The backed-up vault fact."));

    const app = await buildApp();
    try {
      const backupResponse = await app.inject({
        method: "POST",
        url: "/api/backup/download",
        remoteAddress: "127.0.0.1",
      });
      assert.equal(backupResponse.statusCode, 200, backupResponse.body);
      const archive = backupResponse.rawPayload;
      const zip = new AdmZip(archive);
      assert.ok(
        zip.getEntries().some((entry) =>
          entry.entryName.endsWith("/long-term-memory/vault/world/world_route_backup.json"),
        ),
      );

      await storage.updateNote("world_route_backup", {
        sections: { facts: { text: "The live vault changed after backup.", updatedAt: new Date().toISOString() } },
      });
      const multipart = multipartZipBody(archive);
      const request = (restore: boolean) =>
        app.inject({
          method: "POST",
          url: `/api/backup/import-profile${restore ? "?restoreLongTermMemory=true" : ""}`,
          remoteAddress: "127.0.0.1",
          headers: {
            accept: "application/json",
            "content-type": multipart.contentType,
            "content-length": String(multipart.body.length),
          },
          payload: multipart.body,
        });

      const ordinaryImport = await request(false);
      assert.equal(ordinaryImport.statusCode, 200, ordinaryImport.body);
      assert.equal(
        (await storage.getNote("world_route_backup"))?.sections.facts?.text,
        "The live vault changed after backup.",
      );

      const explicitRestore = await request(true);
      assert.equal(explicitRestore.statusCode, 200, explicitRestore.body);
      assert.equal(JSON.parse(explicitRestore.body).longTermMemory?.restored, true);
      assert.equal((await storage.getNote("world_route_backup"))?.sections.facts?.text, "The backed-up vault fact.");
    } finally {
      await app.close();
    }
  });
});

await test("copyLongTermMemoryBackupSnapshot creates a coherent snapshot", async () => {
  await withTempRoot(async (root) => {
    const s = new LongTermMemoryStorage(root);
    await s.createNote(worldNote("world_snap", "Snapshot world fact."));

    const dest = join(root, "..", "snapshot-dest");
    const ok = await copyLongTermMemoryBackupSnapshot(root, dest);
    assert.equal(ok, true);

    const snapStorage = new LongTermMemoryStorage(dest);
    const retrieved = await snapStorage.getNote("world_snap");
    assert.ok(retrieved);
    assert.equal(retrieved.id, "world_snap");

    await rm(dest, { recursive: true, force: true });
  });
});

test("snapshot of non-existent root returns false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marinara-ltm-nosnap-"));
  try {
    const fakeRoot = join(dir, "no-exist-root");
    const dest = join(dir, "no-exist-dest");
    const ok = await copyLongTermMemoryBackupSnapshot(fakeRoot, dest);
    assert.equal(ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup zip round trip preserves vault data", async () => {
  const parent = await mkdtemp(join(tmpdir(), "marinara-ltm-zip-"));
  try {
    const ltmRoot = join(parent, "long-term-memory");
    const s = new LongTermMemoryStorage(ltmRoot);
    await s.createNote(worldNote("world_zip", "Zip round trip fact."));

    const snapshotRoot = join(parent, "snapshot");
    await copyLongTermMemoryBackupSnapshot(ltmRoot, snapshotRoot);

    const zip = new AdmZip();
    const prefix = "backup-test/long-term-memory";
    const { readdir } = await import("node:fs/promises");
    const { readFile: rf } = await import("node:fs/promises");
    for (const entry of await readdir(snapshotRoot, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath ?? snapshotRoot, entry.name);
      const relPath = fullPath.slice(snapshotRoot.length).replace(/\\/g, "/").replace(/^\//, "");
      zip.addFile(`${prefix}/${relPath}`, await rf(fullPath));
    }

    const zipBuffer = zip.toBuffer();
    const restoredDir = join(parent, "restored");
    await mkdir(restoredDir, { recursive: true });
    const restoredZip = new AdmZip(zipBuffer);
    for (const entry of restoredZip.getEntries()) {
      if (entry.isDirectory) continue;
      const entryPath = entry.entryName.startsWith(`${prefix}/`)
        ? entry.entryName.slice(prefix.length + 1)
        : entry.entryName;
      const dest = join(restoredDir, entryPath);
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(dest, entry.getData());
    }

    const restoredStorage = new LongTermMemoryStorage(restoredDir);
    const retrieved = await restoredStorage.getNote("world_zip");
    assert.ok(retrieved);
    assert.equal(retrieved.id, "world_zip");
    assert.equal(retrieved.sections["facts"]?.text, "Zip round trip fact.");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("staged restore replaces the vault when verification succeeds", async () => {
  const parent = await mkdtemp(join(tmpdir(), "marinara-ltm-staged-"));
  try {
    const backupRoot = join(parent, "backup-source");
    await mkdir(backupRoot, { recursive: true });
    const backupStorage = new LongTermMemoryStorage(backupRoot);
    await backupStorage.createNote(worldNote("world_restored", "Staged restore fact."));

    const targetRoot = join(parent, "long-term-memory");

    await restoreLongTermMemoryBackup({
      root: targetRoot,
      stage: async (stagingRoot) => {
        await cp(backupRoot, stagingRoot, { recursive: true, errorOnExist: true, force: false });
      },
    });

    const restoredStorage = new LongTermMemoryStorage(targetRoot);
    const retrieved = await restoredStorage.getNote("world_restored");
    assert.ok(retrieved);
    assert.equal(retrieved.id, "world_restored");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("staged restore rejects invalid staging data and rolls back", async () => {
  const parent = await mkdtemp(join(tmpdir(), "marinara-ltm-reject-"));
  try {
    const targetRoot = join(parent, "long-term-memory");
    await mkdir(targetRoot, { recursive: true });
    const targetStorage = new LongTermMemoryStorage(targetRoot);
    await targetStorage.createNote(worldNote("world_prior", "Prior vault content."));

    // Stage data that will crash validation — an invalid draft file.
    await assert.rejects(
      restoreLongTermMemoryBackup({
        root: targetRoot,
        stage: async (stagingRoot) => {
          await mkdir(stagingRoot, { recursive: true });
          // Create a vault directory with a malformed note to trigger a parse failure
          await mkdir(join(stagingRoot, "vault", "world"), { recursive: true });
          await writeFile(
            join(stagingRoot, "vault", "world", "broken.json"),
            '{ "id": "broken" "malformed": true',
            "utf8",
          );
        },
      }),
    );

    const postStorage = new LongTermMemoryStorage(targetRoot);
    const stillThere = await postStorage.getNote("world_prior");
    assert.ok(stillThere);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("initialization recovers a vault interrupted after the current root moved", async () => {
  const parent = await mkdtemp(join(tmpdir(), "marinara-ltm-restore-recovery-"));
  try {
    const targetRoot = join(parent, "long-term-memory");
    const targetStorage = new LongTermMemoryStorage(targetRoot);
    await targetStorage.createNote(worldNote("world_before_interruption", "Prior vault content."));

    const journal = createLtmBackupRestoreJournal(true);
    const previousRoot = ltmBackupRestoreWorkspacePath(targetRoot, "restore-previous", journal.id);
    await writeLtmBackupRestoreJournal(targetRoot, journal);
    await rename(targetRoot, previousRoot);
    await writeLtmBackupRestoreJournal(targetRoot, { ...journal, phase: "current_root_moved" });

    const recoveredStorage = new LongTermMemoryStorage(targetRoot);
    const recovered = await recoveredStorage.getNote("world_before_interruption");
    assert.equal(recovered?.sections.facts?.text, "Prior vault content.");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
