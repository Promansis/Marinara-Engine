import { join, resolve, sep } from "node:path";
import {
  LTM_NOTE_TYPE_TO_VAULT_FOLDER,
  ltmNoteIdSchema,
  ltmNoteTypeSchema,
  ltmSafeRelativePathSchema,
  type LtmNoteType,
} from "@marinara-engine/shared";
import { getDataDir } from "../../utils/data-dir.js";

export const LTM_DIR_NAME = "long-term-memory";
export const LTM_VAULT_DIR = "vault";
export const LTM_EVENTS_DIR = "events";
export const LTM_DEBUG_DIR = "debug";
export const LTM_INDEXES_DIR = "indexes";
export const LTM_CONFIG_DIR = "config";
export const LTM_DRAFTS_DIR = "drafts";
export const LTM_EVIDENCE_UNIT_DRAFTS_DIR = "evidence-unit-drafts";
export const LTM_EVENT_LOG = "log.jsonl";
export const LTM_DEBUG_LOG = "log.jsonl";

export const LTM_VAULT_FOLDERS = [
  "sources",
  "timeline",
  "characters",
  "relationships",
  "scenes",
  "world",
  "threads",
  "tone",
] as const;

export function getLongTermMemoryRoot(rootDir = getDataDir()) {
  return join(rootDir, LTM_DIR_NAME);
}

export function getLongTermMemoryDirectories(root = getLongTermMemoryRoot()) {
  return {
    root,
    vault: join(root, LTM_VAULT_DIR),
    events: join(root, LTM_EVENTS_DIR),
    debug: join(root, LTM_DEBUG_DIR),
    indexes: join(root, LTM_INDEXES_DIR),
    config: join(root, LTM_CONFIG_DIR),
    drafts: join(root, LTM_DRAFTS_DIR),
    evidenceUnitDrafts: join(root, LTM_EVIDENCE_UNIT_DRAFTS_DIR),
    eventLog: join(root, LTM_EVENTS_DIR, LTM_EVENT_LOG),
    debugLog: join(root, LTM_DEBUG_DIR, LTM_DEBUG_LOG),
  };
}

export function vaultFolderForNoteType(type: LtmNoteType) {
  return LTM_NOTE_TYPE_TO_VAULT_FOLDER[type];
}

export function notePathForId(id: string, type: LtmNoteType, root = getLongTermMemoryRoot()) {
  const parsedId = ltmNoteIdSchema.parse(id);
  const parsedType = ltmNoteTypeSchema.parse(type);
  return join(root, LTM_VAULT_DIR, vaultFolderForNoteType(parsedType), `${parsedId}.json`);
}

export function assertInsideDirectory(root: string, candidate: string) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Path escapes long-term memory root: ${candidate}`);
  }
  return resolvedCandidate;
}

export function safeJoin(root: string, relativePath: string) {
  const safePath = ltmSafeRelativePathSchema.parse(relativePath);
  return assertInsideDirectory(root, join(root, ...safePath.split(/[\\/]+/)));
}
