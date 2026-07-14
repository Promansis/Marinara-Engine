import { randomUUID } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { relative, sep } from "node:path";
import { z } from "zod";
import { ltmEventSchema, ltmSafeRelativePathSchema, type LtmEvent } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { appendJsonLineAtomic, writeJsonAtomic } from "./atomic-json.js";
import { markLtmIndexesDirty } from "./index-state.js";
import { isEnoent, nowIso } from "./ltm-utils.js";
import { assertInsideDirectory, getLongTermMemoryDirectories, safeJoin } from "./paths.js";

const ltmMutationFileChangeSchema = z
  .object({
    path: ltmSafeRelativePathSchema,
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
  })
  .strict();

export const ltmMutationTransactionSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    status: z.enum(["prepared", "committing", "committed"]),
    files: z.array(ltmMutationFileChangeSchema).min(1),
    events: z.array(ltmEventSchema),
  })
  .strict()
  .superRefine((transaction, ctx) => {
    const paths = new Set<string>();
    for (const [index, change] of transaction.files.entries()) {
      if (paths.has(change.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "path"],
          message: "Mutation transactions cannot contain the same file more than once.",
        });
      }
      paths.add(change.path);
    }
  });

export type LtmMutationTransaction = z.infer<typeof ltmMutationTransactionSchema>;

export type LtmMutationFileChange = {
  path: string;
  before: unknown | null;
  after: unknown | null;
};

export type CommitLtmMutationInput = {
  files: LtmMutationFileChange[];
  events?: LtmEvent[];
};

function transactionPath(root: string, id: string) {
  return safeJoin(getLongTermMemoryDirectories(root).transactions, `${id}.json`);
}

function transactionRelativePath(root: string, path: string) {
  const resolvedRoot = assertInsideDirectory(root, root);
  const resolvedPath = assertInsideDirectory(root, path);
  const relativePath = relative(resolvedRoot, resolvedPath).split(sep).join("/");
  return ltmSafeRelativePathSchema.parse(relativePath);
}

function createTransaction(root: string, input: CommitLtmMutationInput): LtmMutationTransaction {
  return ltmMutationTransactionSchema.parse({
    version: 1,
    id: randomUUID(),
    createdAt: nowIso(),
    status: "prepared",
    files: input.files.map((change) => ({
      path: transactionRelativePath(root, change.path),
      before: change.before,
      after: change.after,
    })),
    events: input.events ?? [],
  });
}

async function writeTransaction(root: string, transaction: LtmMutationTransaction) {
  await writeJsonAtomic(transactionPath(root, transaction.id), transaction);
}

async function applyTransactionFiles(root: string, transaction: LtmMutationTransaction, state: "before" | "after") {
  for (const change of transaction.files) {
    const path = safeJoin(root, change.path);
    const value = change[state];
    if (value === null) {
      try {
        await unlink(path);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      continue;
    }
    await writeJsonAtomic(path, value);
  }
}

async function readDeliveredEventIds(root: string) {
  const eventLog = getLongTermMemoryDirectories(root).eventLog;
  let content: string;
  try {
    content = await readFile(eventLog, "utf8");
  } catch (err) {
    if (isEnoent(err)) return new Set<string>();
    throw err;
  }

  const delivered = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = ltmEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) delivered.add(parsed.data.id);
    } catch {
      // Integrity reporting owns malformed historical event rows. A transaction
      // can still safely resume events whose durable IDs are absent.
    }
  }
  return delivered;
}

async function publishTransactionEvents(root: string, events: LtmEvent[]) {
  if (events.length === 0) return;
  const delivered = await readDeliveredEventIds(root);
  const eventLog = getLongTermMemoryDirectories(root).eventLog;
  for (const event of events) {
    if (delivered.has(event.id)) continue;
    await appendJsonLineAtomic(eventLog, event);
    delivered.add(event.id);
  }
}

async function removeTransaction(root: string, transaction: LtmMutationTransaction) {
  await unlink(transactionPath(root, transaction.id)).catch((err) => {
    if (!isEnoent(err)) throw err;
  });
}

async function rollbackPreparedTransaction(root: string, transaction: LtmMutationTransaction) {
  await applyTransactionFiles(root, transaction, "before");
  await markLtmIndexesDirty(root);
  await removeTransaction(root, transaction);
}

async function publishCommittedTransactionEvents(root: string, transaction: LtmMutationTransaction) {
  try {
    await publishTransactionEvents(root, transaction.events);
  } catch (err) {
    logger.warn(err, "[ltm] Failed to publish committed vault mutation events");
    return;
  }
  try {
    await removeTransaction(root, transaction);
  } catch (err) {
    logger.warn(err, "[ltm] Failed to remove completed vault mutation journal");
  }
}

async function recoverCommittedTransaction(root: string, transaction: LtmMutationTransaction) {
  await applyTransactionFiles(root, transaction, "after");
  await markLtmIndexesDirty(root);
  await publishCommittedTransactionEvents(root, transaction);
}

/**
 * Persist the intent before touching vault files. A pre-commit interruption
 * rolls back to the before-state; a committed interruption rolls forward and
 * idempotently publishes its deferred events.
 */
export async function commitLtmMutation(root: string, input: CommitLtmMutationInput) {
  const transaction = createTransaction(root, input);
  await writeTransaction(root, transaction);

  let committed: LtmMutationTransaction | null = null;
  try {
    // This must happen before an unlink so a stale index cannot be trusted if
    // the process stops during an irreversible mutation.
    await markLtmIndexesDirty(root);
    const committing = ltmMutationTransactionSchema.parse({ ...transaction, status: "committing" });
    await writeTransaction(root, committing);
    await applyTransactionFiles(root, committing, "after");
    const committedTransaction = ltmMutationTransactionSchema.parse({ ...committing, status: "committed" });
    await writeTransaction(root, committedTransaction);
    committed = committedTransaction;
    await publishCommittedTransactionEvents(root, committedTransaction);
  } catch (err) {
    if (committed) {
      logger.warn(err, "[ltm] Vault mutation committed; deferred recovery will finish its journal");
      return;
    }
    try {
      await rollbackPreparedTransaction(root, transaction);
    } catch (rollbackError) {
      logger.error(rollbackError, `[ltm] Failed to roll back interrupted vault mutation ${transaction.id}`);
    }
    throw err;
  }
}

/** Recover mutations left by an interrupted process before serving the vault. */
export async function recoverLtmMutations(root: string) {
  const transactionsDir = getLongTermMemoryDirectories(root).transactions;
  let entries;
  try {
    entries = await readdir(transactionsDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }

  for (const entry of entries
    .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = safeJoin(transactionsDir, entry.name);
    const transaction = ltmMutationTransactionSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (transaction.status === "committed") {
      await recoverCommittedTransaction(root, transaction);
      continue;
    }
    await rollbackPreparedTransaction(root, transaction);
  }
}
