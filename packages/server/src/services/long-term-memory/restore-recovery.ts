import { randomUUID } from "node:crypto";
import { readFile, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { fsyncPath, renameWithRetry, writeJsonAtomic } from "./atomic-json.js";
import { isEnoent, nowIso } from "./ltm-utils.js";

const activeRestoreRoots = new Set<string>();

const ltmBackupRestoreJournalSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    phase: z.enum(["staged", "current_root_moved", "published", "rebuilt", "verified"]),
    hadPreviousRoot: z.boolean(),
  })
  .strict();

export type LtmBackupRestoreJournal = z.infer<typeof ltmBackupRestoreJournalSchema>;

export function isLtmBackupRestoreActive(root: string) {
  return activeRestoreRoots.has(root);
}

export async function withActiveLtmBackupRestore<T>(root: string, operation: () => Promise<T>) {
  activeRestoreRoots.add(root);
  try {
    return await operation();
  } finally {
    activeRestoreRoots.delete(root);
  }
}

export function createLtmBackupRestoreJournal(hadPreviousRoot: boolean): LtmBackupRestoreJournal {
  return ltmBackupRestoreJournalSchema.parse({
    version: 1,
    id: randomUUID(),
    createdAt: nowIso(),
    phase: "staged",
    hadPreviousRoot,
  });
}

export function ltmBackupRestoreWorkspacePath(root: string, label: string, id: string) {
  return join(dirname(root), `.${basename(root)}-${label}-${id}`);
}

export function ltmBackupRestoreJournalPath(root: string) {
  return join(dirname(root), `.${basename(root)}-restore.json`);
}

export async function writeLtmBackupRestoreJournal(root: string, journal: LtmBackupRestoreJournal) {
  const parsed = ltmBackupRestoreJournalSchema.parse(journal);
  await writeJsonAtomic(ltmBackupRestoreJournalPath(root), parsed);
  return parsed;
}

export async function removeLtmBackupRestoreJournal(root: string) {
  await unlink(ltmBackupRestoreJournalPath(root)).catch((error) => {
    if (!isEnoent(error)) throw error;
  });
  await fsyncPath(dirname(root));
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export async function recoverInterruptedLtmBackupRestore(root: string) {
  let journal: LtmBackupRestoreJournal;
  try {
    journal = ltmBackupRestoreJournalSchema.parse(
      JSON.parse(await readFile(ltmBackupRestoreJournalPath(root), "utf8")),
    );
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }

  const stagingRoot = ltmBackupRestoreWorkspacePath(root, "restore-staging", journal.id);
  const previousRoot = ltmBackupRestoreWorkspacePath(root, "restore-previous", journal.id);
  const previousExists = await pathExists(previousRoot);

  if (journal.phase === "verified") {
    if (await pathExists(root)) {
      await rm(previousRoot, { recursive: true, force: true });
    } else if (previousExists) {
      await renameWithRetry(previousRoot, root);
      await fsyncPath(dirname(root));
    } else {
      throw new Error("Verified long-term memory restore has no canonical or rollback root.");
    }
  } else if (journal.hadPreviousRoot && previousExists) {
    await rm(root, { recursive: true, force: true });
    await renameWithRetry(previousRoot, root);
    await fsyncPath(dirname(root));
  } else if (journal.hadPreviousRoot && journal.phase !== "staged") {
    throw new Error("Interrupted long-term memory restore is missing its rollback root.");
  } else if (!journal.hadPreviousRoot) {
    await rm(root, { recursive: true, force: true });
  }

  await rm(stagingRoot, { recursive: true, force: true });
  await rm(previousRoot, { recursive: true, force: true });
  await removeLtmBackupRestoreJournal(root);
  return true;
}
