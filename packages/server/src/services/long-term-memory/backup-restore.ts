import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ltmEventSchema, ltmExtractionDraftSchema, type LtmIntegrityResponse } from "@marinara-engine/shared";
import { fsyncPath, renameWithRetry, writeJsonAtomic } from "./atomic-json.js";
import { getLtmExtractionConfig } from "./extraction-config.js";
import { checkLongTermMemoryIntegrity } from "./maintenance.js";
import { isEnoent } from "./ltm-utils.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";
import { rebuildLongTermMemoryIndexes, type LtmRebuildOptions, type LtmRebuildResult } from "./rebuild.js";
import { getLtmGlobalSettings } from "./settings.js";
import { LongTermMemoryStorage } from "./storage.js";
import {
  longTermMemoryUsagePath,
  validateLongTermMemoryInjectionReceipts,
  validateLongTermMemoryUsage,
} from "./usage.js";
import { withLtmVaultLock } from "./vault-lock.js";

export type LtmBackupRestorePhase = "staged" | "current_root_moved" | "published" | "rebuilt" | "verified";

export type LtmBackupRestoreHooks = {
  onPhase?: (phase: LtmBackupRestorePhase) => Promise<void> | void;
};

export type RestoreLongTermMemoryBackupOptions = {
  /** Writes the untrusted backup into the supplied empty staging root. */
  stage: (stagingRoot: string) => Promise<void>;
  root?: string;
  rebuildOptions?: Omit<LtmRebuildOptions, "root">;
  rebuild?: (options: LtmRebuildOptions) => Promise<LtmRebuildResult>;
  checkIntegrity?: (root: string) => Promise<LtmIntegrityResponse>;
  hooks?: LtmBackupRestoreHooks;
};

export type RestoreLongTermMemoryBackupResult = {
  root: string;
  rebuild: LtmRebuildResult;
  integrity: LtmIntegrityResponse;
};

/**
 * Captures the complete durable LTM root while canonical writers are paused.
 * Full backups may retain index artifacts for forensic recovery, but restore
 * deliberately rebuilds them instead of trusting those artifacts.
 */
export async function copyLongTermMemoryBackupSnapshot(root: string, destinationRoot: string) {
  return withLtmVaultLock(root, async () => {
    try {
      await cp(root, destinationRoot, { recursive: true, errorOnExist: true, force: false });
      return true;
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
  });
}

function restoreWorkspacePath(root: string, label: string, id: string) {
  return join(dirname(root), `.${basename(root)}-${label}-${id}`);
}

async function validateDrafts(root: string) {
  const draftsDir = getLongTermMemoryDirectories(root).drafts;
  const entries = await readdir(draftsDir, { withFileTypes: true }).catch((error) => {
    if (isEnoent(error)) return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const draft = ltmExtractionDraftSchema.parse(JSON.parse(await readFile(safeJoin(draftsDir, entry.name), "utf8")));
    if (entry.name !== `${draft.id}.json`) {
      throw new Error(`Long-term memory draft filename does not match draft ${draft.id}.`);
    }
  }
}

async function validateEvents(root: string) {
  const eventLog = getLongTermMemoryDirectories(root).eventLog;
  let content: string;
  try {
    content = await readFile(eventLog, "utf8");
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  for (const line of content.split("\n")) {
    if (line.trim()) ltmEventSchema.parse(JSON.parse(line));
  }
}

async function validateCanonicalLtmData(root: string) {
  const storage = new LongTermMemoryStorage(root);
  await storage.initializeLtmStore();
  await storage.listNotes();
  await validateDrafts(root);
  await validateEvents(root);
  await getLtmGlobalSettings(root);
  await getLtmExtractionConfig(root);
  await validateLongTermMemoryUsage(root);
  await validateLongTermMemoryInjectionReceipts(root);
}

async function discardImportedDerivedIndexes(root: string) {
  const usage = await validateLongTermMemoryUsage(root);
  const dirs = getLongTermMemoryDirectories(root);
  await rm(dirs.indexes, { recursive: true, force: true });
  await mkdir(dirs.indexes, { recursive: true });
  await writeJsonAtomic(longTermMemoryUsagePath(root), usage);
}

async function rollbackPublishedRoot(root: string, previousRoot: string, hadPreviousRoot: boolean) {
  await rm(root, { recursive: true, force: true });
  if (hadPreviousRoot) {
    await renameWithRetry(previousRoot, root);
    await fsyncPath(dirname(root));
  }
}

/**
 * Replaces an LTM root only after a full staged validation. The current root
 * remains as a sibling rollback directory until a local rebuild and integrity
 * check both complete successfully.
 */
export async function restoreLongTermMemoryBackup(
  options: RestoreLongTermMemoryBackupOptions,
): Promise<RestoreLongTermMemoryBackupResult> {
  const root = options.root ?? getLongTermMemoryRoot();
  return withLtmVaultLock(root, async () => {
    const restoreId = randomUUID();
    const stagingRoot = restoreWorkspacePath(root, "restore-staging", restoreId);
    const previousRoot = restoreWorkspacePath(root, "restore-previous", restoreId);
    const hadPreviousRoot = await readdir(dirname(root))
      .then((entries) => entries.includes(basename(root)))
      .catch(() => false);
    let movedCurrentRoot = false;
    let published = false;
    let rollbackSucceeded = false;

    await rm(stagingRoot, { recursive: true, force: true });
    await rm(previousRoot, { recursive: true, force: true });

    try {
      await options.stage(stagingRoot);
      await validateCanonicalLtmData(stagingRoot);
      await discardImportedDerivedIndexes(stagingRoot);
      await options.hooks?.onPhase?.("staged");

      if (hadPreviousRoot) {
        await renameWithRetry(root, previousRoot);
        movedCurrentRoot = true;
        await fsyncPath(dirname(root));
      }
      await options.hooks?.onPhase?.("current_root_moved");

      await renameWithRetry(stagingRoot, root);
      published = true;
      await fsyncPath(dirname(root));
      await options.hooks?.onPhase?.("published");

      const rebuild = await (options.rebuild ?? rebuildLongTermMemoryIndexes)({
        ...options.rebuildOptions,
        root,
      });
      await options.hooks?.onPhase?.("rebuilt");

      const integrity = await (options.checkIntegrity ?? checkLongTermMemoryIntegrity)(root);
      if (!integrity.ok) {
        throw new Error(
          `Restored long-term memory failed integrity verification (${integrity.issues.length} issue(s)).`,
        );
      }
      await options.hooks?.onPhase?.("verified");

      if (movedCurrentRoot) {
        await rm(previousRoot, { recursive: true, force: true }).catch(() => {});
      }
      return { root, rebuild, integrity };
    } catch (error) {
      try {
        if (published || movedCurrentRoot) {
          await rollbackPublishedRoot(root, previousRoot, hadPreviousRoot);
        }
        rollbackSucceeded = true;
      } catch (rollbackError) {
        const primaryMessage = error instanceof Error ? error.message : String(error);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(
          `Long-term memory restore failed (${primaryMessage}) and rollback failed (${rollbackMessage}).`,
        );
      } finally {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
        if (rollbackSucceeded && movedCurrentRoot) {
          await rm(previousRoot, { recursive: true, force: true }).catch(() => {});
        }
      }
      throw error;
    }
  });
}
