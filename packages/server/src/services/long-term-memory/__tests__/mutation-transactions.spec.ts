import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LtmEvent, LtmNote } from "@marinara-engine/shared";
import { checkLongTermMemoryIntegrity } from "../maintenance.js";
import { ltmMutationTransactionSchema, recoverLtmMutations } from "../mutation-transaction.js";
import { getLongTermMemoryDirectories } from "../paths.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import { readLtmIndexState } from "../index-state.js";
import { retrieveLongTermMemory } from "../retrieval.js";
import { LongTermMemoryStorage } from "../storage.js";

const timestamp = "2026-07-11T00:00:00.000Z";

function note(input: Partial<LtmNote> & Pick<LtmNote, "id" | "type">): LtmNote {
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    status: input.status ?? "active",
    modes: input.modes ?? ["roleplay"],
    scope: input.scope ?? {},
    tags: input.tags ?? ["transaction_test"],
    keywords: input.keywords ?? [],
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    links: input.links ?? [],
    sections:
      input.sections ?? ({ facts: { text: `${input.id} memory`, updatedAt: timestamp } } satisfies LtmNote["sections"]),
    conflicts: input.conflicts,
    version: input.version ?? 1,
    extracted: input.extracted,
  };
}

function event(type: string, target: string): LtmEvent {
  return {
    id: randomUUID(),
    ts: timestamp,
    type,
    target,
    payload: {},
  };
}

async function writeTransaction(root: string, transaction: unknown) {
  const dirs = getLongTermMemoryDirectories(root);
  const parsed = ltmMutationTransactionSchema.parse(transaction);
  await mkdir(dirs.transactions, { recursive: true });
  await writeFile(join(dirs.transactions, `${parsed.id}.json`), `${JSON.stringify(parsed)}\n`, "utf8");
}

async function writeVaultNote(root: string, value: LtmNote) {
  const dirs = getLongTermMemoryDirectories(root);
  const folder =
    value.type === "source"
      ? "sources"
      : value.type === "timeline_event"
        ? "timeline"
        : value.type === "character"
          ? "characters"
          : value.type === "relationship"
            ? "relationships"
            : value.type === "scene"
              ? "scenes"
              : value.type === "thread"
                ? "threads"
                : value.type === "tone"
                  ? "tone"
                  : "world";
  const path = join(dirs.vault, folder, `${value.id}.json`);
  await mkdir(join(dirs.vault, folder), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
  return path;
}

test("LTM vault mutations recover an uncommitted journal to its before-state without an event", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-mutation-rollback-"));
  try {
    const before = note({
      id: "world_transaction_before",
      type: "world",
      sections: { facts: { text: "Before the interrupted update.", updatedAt: timestamp } },
    });
    const after = note({
      ...before,
      sections: { facts: { text: "After the interrupted update.", updatedAt: timestamp } },
      version: 2,
    });
    await writeVaultNote(root, after);
    const transactionEvent = event("world.updated", before.id);
    await writeTransaction(root, {
      version: 1,
      id: randomUUID(),
      createdAt: timestamp,
      status: "committing",
      files: [{ path: `vault/world/${before.id}.json`, before, after }],
      events: [transactionEvent],
    });

    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();

    assert.equal((await storage.getNote(before.id))?.sections.facts?.text, "Before the interrupted update.");
    assert.deepEqual(await storage.readEvents(), []);
    assert.equal((await readLtmIndexState(root)).dirty, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LTM vault mutations recover a committed delete and publish its event once", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-mutation-commit-"));
  try {
    const deleted = note({ id: "world_transaction_deleted", type: "world" });
    const inboundBefore = note({
      id: "world_transaction_inbound",
      type: "world",
      links: [{ target: deleted.id, relation: "involves" }],
    });
    const inboundAfter = note({ ...inboundBefore, links: [], version: 2 });
    await writeVaultNote(root, inboundBefore);
    const transactionEvent = event("world.deleted", deleted.id);
    await writeTransaction(root, {
      version: 1,
      id: randomUUID(),
      createdAt: timestamp,
      status: "committed",
      files: [
        { path: `vault/world/${deleted.id}.json`, before: deleted, after: null },
        { path: `vault/world/${inboundBefore.id}.json`, before: inboundBefore, after: inboundAfter },
      ],
      events: [transactionEvent],
    });

    const storage = new LongTermMemoryStorage(root);
    await storage.initializeLtmStore();
    await recoverLtmMutations(root);

    assert.equal(await storage.getNote(deleted.id), null);
    assert.deepEqual((await storage.getNote(inboundBefore.id))?.links, []);
    assert.deepEqual(
      (await storage.readEvents()).map((entry) => entry.id),
      [transactionEvent.id],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LTM permanent delete repairs links and cannot reuse a warm stale retrieval cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-mutation-cache-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const deleted = note({
      id: "world_transaction_cache_deleted",
      type: "world",
      sections: { facts: { text: "The vanished cobalt lighthouse marks the coast.", updatedAt: timestamp } },
    });
    const inbound = note({
      id: "world_transaction_cache_inbound",
      type: "world",
      links: [{ target: deleted.id, relation: "involves" }],
      sections: { facts: { text: "The harbor points to the cobalt lighthouse.", updatedAt: timestamp } },
    });
    await storage.createNote(deleted, { suppressEvent: true });
    await storage.createNote(inbound, { suppressEvent: true });
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const stateBeforeDelete = await readLtmIndexState(root);

    const initial = await retrieveLongTermMemory({
      root,
      queryText: "cobalt lighthouse",
      semanticWeight: 0,
      lexicalWeight: 1,
      graphWeight: 0,
      keywordWeight: 0,
    });
    assert.ok(initial.chunks.some((entry) => entry.chunk.noteId === deleted.id));

    await storage.deleteNote(deleted.id, { actor: "test", cause: "permanent_delete" });

    assert.deepEqual((await storage.getNote(inbound.id))?.links, []);
    const integrity = await checkLongTermMemoryIntegrity(root);
    assert.equal(
      integrity.issues.some((issue) => issue.code === "missing_link_target"),
      false,
    );
    const stateAfterDelete = await readLtmIndexState(root);
    assert.ok(stateAfterDelete.revision > stateBeforeDelete.revision);
    assert.equal(stateAfterDelete.dirty, true);

    const afterDelete = await retrieveLongTermMemory({
      root,
      queryText: "cobalt lighthouse",
      semanticWeight: 0,
      lexicalWeight: 1,
      graphWeight: 0,
      keywordWeight: 0,
    });
    assert.equal(
      afterDelete.chunks.some((entry) => entry.chunk.noteId === deleted.id),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LTM projection and update serialize on the canonical note id", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-mutation-lock-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const original = note({ id: "world_transaction_lock", type: "world", title: "Original" });
    await storage.createNote(original, { suppressEvent: true });

    let releaseProjection!: () => void;
    let markProjectionStarted!: () => void;
    const projectionStarted = new Promise<void>((resolve) => {
      markProjectionStarted = resolve;
    });
    const projectionRelease = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    const projection = storage.projectNote(
      original.id,
      async (current) => {
        assert.ok(current);
        markProjectionStarted();
        await projectionRelease;
        return { ...current, title: "Projected" };
      },
      { suppressEvent: true },
    );

    await projectionStarted;
    let updateComplete = false;
    const update = storage
      .updateNote(original.id, { tags: ["updated_after_projection"] }, { suppressEvent: true })
      .then(() => {
        updateComplete = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(updateComplete, false);

    releaseProjection();
    await Promise.all([projection, update]);

    const final = await storage.getNote(original.id);
    assert.equal(final?.title, "Projected");
    assert.deepEqual(final?.tags, ["updated_after_projection"]);
    assert.equal(final?.version, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
