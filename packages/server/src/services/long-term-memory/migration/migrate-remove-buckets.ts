import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LtmImportance, LtmNote, LtmSection } from "@marinara-engine/shared";
import { logger } from "../../../lib/logger.js";
import { getLongTermMemoryRoot } from "../paths.js";
import { LongTermMemoryStorage } from "../storage.js";

type MigrationArgs = {
  dryRun: boolean;
  backupDir?: string;
  noBackup: boolean;
  root?: string;
};

const IMPORTANCE_PREFIX = /^\s*(?:🔴|critical:?)\s*/i;
const MAJOR_PREFIX = /^\s*(?:🟠|major:?)\s*/i;
const MODERATE_PREFIX = /^\s*(?:🟡|moderate:?)\s*/i;
const MINOR_PREFIX = /^\s*(?:🟢|minor:?)\s*/i;

function parseArgs(argv: string[]): MigrationArgs {
  const args: MigrationArgs = { dryRun: false, noBackup: false };
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

function migrateNote(note: LtmNote): { note: LtmNote; changed: boolean } {
  const sections = Object.fromEntries(
    Object.entries(note.sections).map(([key, section]) => [key, migrateSection(section)]),
  );
  const changed = JSON.stringify(sections) !== JSON.stringify(note.sections);
  return { note: { ...note, sections }, changed };
}

async function writeBackup(notes: LtmNote[], backupDir: string) {
  await mkdir(backupDir, { recursive: true });
  const path = resolve(backupDir, `ltm-notes-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify({ exportedAt: new Date().toISOString(), notes }, null, 2), "utf8");
  return path;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? getLongTermMemoryRoot();
  const storage = new LongTermMemoryStorage(root);
  await storage.initializeLtmStore();
  const notes = await storage.listNotes({});
  const migrated = notes.map(migrateNote);
  const changed = migrated.filter((item) => item.changed);

  if (!args.dryRun && !args.noBackup) {
    const backupDir = args.backupDir ?? resolve(root, "backups");
    const backupPath = await writeBackup(notes, backupDir);
    logger.info("[ltm-migration] Wrote backup to %s", backupPath);
  }

  if (args.dryRun) {
    process.stdout.write(`Dry run: ${changed.length}/${notes.length} note(s) would be updated.\n`);
    for (const item of changed.slice(0, 20)) {
      process.stdout.write(`- ${item.note.id}\n`);
    }
    return;
  }

  for (const item of changed) {
    await storage.updateNote(
      item.note.id,
      { sections: item.note.sections },
      {
        actor: "ltm_migration",
        cause: "migrate_remove_buckets",
        summary: "Migrated LTM sections to structured importance fields",
      },
    );
  }

  process.stdout.write(`Updated ${changed.length}/${notes.length} note(s).\n`);
}

main().catch((err) => {
  logger.error(err, "[ltm-migration] Migration failed");
  process.exit(1);
});
