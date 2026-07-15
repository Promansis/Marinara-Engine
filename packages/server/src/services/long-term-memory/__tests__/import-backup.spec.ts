// ──────────────────────────────────────────────
// LTM Import & Backup Contracts
// ──────────────────────────────────────────────
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { LongTermMemoryStorage } from "../storage.js";
import {
  copyLongTermMemoryBackupSnapshot,
  restoreLongTermMemoryBackup,
} from "../backup-restore.js";
import {
  withTempRoot,
  worldNote,
} from "./fixtures/ltm-test-harness.js";

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
