import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { LtmImportance, LtmNote, LtmSection } from "@marinara-engine/shared";
import { logger } from "../../../lib/logger.js";
import { isEnoent } from "../ltm-utils.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, LTM_VAULT_FOLDERS, safeJoin } from "../paths.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import { inferSourceProvenance, sourceNoteIdForProvenance } from "../source-identity.js";
import { LongTermMemoryStorage } from "../storage.js";
import { parseStoredLtmNote } from "../stored-note.js";

export type LtmMigrationArgs = {
  dryRun: boolean;
  backupDir?: string;
  noBackup: boolean;
  root?: string;
};

type PlannedNoteMigration = {
  originalId: string;
  nextId: string;
  note: LtmNote;
  changed: boolean;
};

const IMPORTANCE_PREFIX = /^\s*(?:🔴|critical:?)\s*/i;
const MAJOR_PREFIX = /^\s*(?:🟠|major:?)\s*/i;
const MODERATE_PREFIX = /^\s*(?:🟡|moderate:?)\s*/i;
const MINOR_PREFIX = /^\s*(?:🟢|minor:?)\s*/i;

export function parseLtmMigrationArgs(argv: string[]): LtmMigrationArgs {
  const args: LtmMigrationArgs = { dryRun: false, noBackup: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-backup") args.noBackup = true;
    else if (arg.startsWith("--backup=")) args.backupDir = resolve(arg.slice("--backup=".length));
    else if (arg.startsWith("--root=")) args.root = resolve(arg.slice("--root=".length));
  }
  return args;
}

function migrateSection(section: LtmSection): LtmSection {
  const inferred = inferImportance(section.text);
  if (!inferred || section.importance) return section;
  return {
    ...section,
    text: inferred.text,
    importance: inferred.importance,
  };
}

function inferImportance(text: string): { importance: LtmImportance; text: string } | null {
  if (IMPORTANCE_PREFIX.test(text)) return { importance: "critical", text: text.replace(IMPORTANCE_PREFIX, "").trim() };
  if (MAJOR_PREFIX.test(text)) return { importance: "major", text: text.replace(MAJOR_PREFIX, "").trim() };
  if (MODERATE_PREFIX.test(text)) return { importance: "moderate", text: text.replace(MODERATE_PREFIX, "").trim() };
  if (MINOR_PREFIX.test(text)) return { importance: "minor", text: text.replace(MINOR_PREFIX, "").trim() };
  return null;
}

export function planLtmNoteMigration(note: LtmNote): PlannedNoteMigration {
  const sections = Object.fromEntries(
    Object.entries(note.sections).map(([key, section]) => [key, migrateSection(section)]),
  );
  const provenance = note.type === "source"
    ? inferSourceProvenance(note) ?? note.provenance
    : undefined;
  const nextId = provenance ? sourceNoteIdForProvenance(provenance) : note.id;
  const migrated = {
    ...note,
    id: nextId,
    sections,
    ...(provenance ? { provenance } : {}),
  };
  return {
    originalId: note.id,
    nextId,
    note: migrated,
    changed: JSON.stringify(migrated) !== JSON.stringify(note),
  };
}

function assertUniquePlannedNoteIds(planned: PlannedNoteMigration[]) {
  const sourcesByTarget = new Map<string, string[]>();
  for (const item of planned) {
    const sources = sourcesByTarget.get(item.nextId) ?? [];
    sources.push(item.originalId);
    sourcesByTarget.set(item.nextId, sources);
  }
  const collisions = [...sourcesByTarget.entries()].filter(([, sources]) => sources.length > 1);
  if (collisions.length === 0) return;
  const detail = collisions
    .map(([target, sources]) => `${target} <= ${sources.sort().join(", ")}`)
    .sort()
    .join("; ");
  throw new Error(`Long-term memory migration would create duplicate note IDs: ${detail}`);
}

async function readVaultNotesWithoutInitialization(root: string) {
  const dirs = getLongTermMemoryDirectories(root);
  const notes: LtmNote[] = [];
  for (const folder of LTM_VAULT_FOLDERS) {
    const folderPath = safeJoin(dirs.vault, folder);
    const entries = await readdir(folderPath, { withFileTypes: true }).catch((err) => {
      if (isEnoent(err)) return [];
      throw err;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      notes.push(parseStoredLtmNote(JSON.parse(await readFile(safeJoin(folderPath, entry.name), "utf8"))));
    }
  }
  return notes.sort((left, right) => left.id.localeCompare(right.id));
}

async function writeFullBackup(root: string, backupDir?: string) {
  const destinationRoot = backupDir ?? resolve(dirname(root), "ltm-backups");
  const relativeDestination = relative(resolve(root), resolve(destinationRoot));
  const destinationIsInsideRoot = relativeDestination === ""
    || (relativeDestination !== ".."
      && !relativeDestination.startsWith(`..${sep}`)
      && !isAbsolute(relativeDestination));
  if (destinationIsInsideRoot) {
    throw new Error("Long-term memory backup destination must be outside the memory root.");
  }
  await mkdir(destinationRoot, { recursive: true });
  const destination = resolve(
    destinationRoot,
    `long-term-memory-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await cp(root, destination, { recursive: true, errorOnExist: true, force: false });
  return destination;
}

export async function runLtmMigration(
  input: LtmMigrationArgs,
  dependencies: { rebuild?: typeof rebuildLongTermMemoryIndexes } = {},
) {
  const root = input.root ?? getLongTermMemoryRoot();
  const notes = await readVaultNotesWithoutInitialization(root);
  const planned = notes.map(planLtmNoteMigration);
  assertUniquePlannedNoteIds(planned);
  const changed = planned.filter((item) => item.changed);

  if (input.dryRun) {
    return { root, total: notes.length, changed: changed.length, backupPath: null, rebuilt: false, planned };
  }

  const backupPath = changed.length > 0 && !input.noBackup
    ? await writeFullBackup(root, input.backupDir)
    : null;
  const storage = new LongTermMemoryStorage(root);
  await storage.initializeLtmStore();

  for (const item of changed) {
    const renamed = item.originalId === item.nextId
      ? await storage.getNote(item.originalId)
      : await storage.renameNoteId(item.originalId, item.nextId, {
          actor: "ltm_migration",
          cause: "migrate_source_identity",
          summary: "Migrated imported source note to stable provenance identity",
        });
    if (!renamed) throw new Error(`Long-term memory note not found during migration: ${item.originalId}`);
    await storage.updateNote(
      item.nextId,
      {
        sections: item.note.sections,
        provenance: item.note.provenance,
      },
      {
        actor: "ltm_migration",
        cause: "migrate_remove_buckets",
        summary: "Migrated LTM note identity and structured importance fields",
      },
    );
  }

  if (changed.length > 0) await (dependencies.rebuild ?? rebuildLongTermMemoryIndexes)({ root });
  return {
    root,
    total: notes.length,
    changed: changed.length,
    backupPath,
    rebuilt: changed.length > 0,
    planned,
  };
}

async function main() {
  const result = await runLtmMigration(parseLtmMigrationArgs(process.argv.slice(2)));
  if (result.backupPath) logger.info("[ltm-migration] Wrote backup to %s", result.backupPath);
  const prefix = process.argv.includes("--dry-run") ? "Dry run: " : "";
  process.stdout.write(`${prefix}${result.changed}/${result.total} note(s) would be or were updated.\n`);
  for (const item of result.planned.filter((candidate) => candidate.changed).slice(0, 20)) {
    process.stdout.write(`- ${item.originalId}${item.originalId === item.nextId ? "" : ` -> ${item.nextId}`}\n`);
  }
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isDirectExecution) {
  main().catch((err) => {
    logger.error(err, "[ltm-migration] Migration failed");
    process.exit(1);
  });
}
