import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ltmBm25IndexSchema,
  ltmEmbeddingIndexSchema,
  ltmGraphIndexSchema,
  ltmKeywordIndexSchema,
  ltmMetadataIndexSchema,
} from "@marinara-engine/shared";
import {
  checkLongTermMemoryIntegrity,
  repairLongTermMemory,
} from "../maintenance.js";
import {
  clearLtmDebugLog,
  exportLtmDebugLog,
  readLtmDebugLog,
  recordLtmDebugEvent,
} from "../debug-log.js";
import { getLongTermMemoryDirectories } from "../paths.js";
import { readLtmIndexState } from "../index-state.js";
import { readLtmIndexFamilyGeneration, writeLtmIndexFamilyGeneration } from "../index-generation.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import { invalidateLongTermMemoryRetrievalCache, retrieveLongTermMemory } from "../retrieval.js";
import { LongTermMemoryStorage } from "../storage.js";

const timestamp = "2026-06-21T12:00:00.000Z";

function validNote(overrides: Record<string, unknown> = {}) {
  return {
    id: "world_test_mem",
    type: "world",
    status: "active",
    modes: ["roleplay"],
    scope: {},
    tags: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: { facts: { text: "A test memory.", updatedAt: timestamp } },
    version: 1,
    ...overrides,
  };
}

async function writeNote(root: string, note: Record<string, unknown>) {
  const dirs = getLongTermMemoryDirectories(root);
  const folder = note.type === "source" ? "sources"
    : note.type === "timeline_event" ? "timeline"
    : note.type === "character" ? "characters"
    : note.type === "relationship" ? "relationships"
    : note.type === "scene" ? "scenes"
    : note.type === "thread" ? "threads"
    : note.type === "tone" ? "tone"
    : "world";
  const noteDir = join(dirs.vault, folder);
  await mkdir(noteDir, { recursive: true });
  await writeFile(join(noteDir, `${note.id}.json`), JSON.stringify(note));
}

test("persisted LTM index schemas reject malformed family payloads", () => {
  for (const schema of [
    ltmMetadataIndexSchema,
    ltmEmbeddingIndexSchema,
    ltmBm25IndexSchema,
    ltmGraphIndexSchema,
    ltmKeywordIndexSchema,
  ]) {
    assert.equal(schema.safeParse({ version: 1 }).success, false);
  }
});

test("index generation validation rejects cross-family references to missing chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-coherence-"));
  try {
    await writeNote(root, validNote());
    const rebuild = await rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: async (texts) => texts.map(() => []),
    });
    const loaded = await readLtmIndexFamilyGeneration(root, rebuild.generation.generationId, "typed");
    assert.ok(loaded);
    const inconsistent = structuredClone(loaded.bundle);
    inconsistent.bm25.terms.orphan = {
      documentFrequency: 1,
      postings: [{ chunkId: "world_missing::facts", count: 1 }],
    };

    await assert.rejects(
      writeLtmIndexFamilyGeneration(
        root,
        "00000000-0000-4000-8000-000000000001",
        "typed",
        inconsistent,
      ),
      /BM25 posting references missing chunk/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("index generation validation rejects an inconsistent source manifest hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-manifest-hash-"));
  try {
    await writeNote(root, validNote());
    const rebuild = await rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: async (texts) => texts.map(() => []),
    });
    const dirs = getLongTermMemoryDirectories(root);
    const manifestPath = join(dirs.indexes, "generations", rebuild.generation.generationId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.sourceHash = "b".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      readLtmIndexFamilyGeneration(root, rebuild.generation.generationId, "typed"),
      /source hash does not match its source file inventory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkLongTermMemoryIntegrity — valid note passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-integrity-valid-"));
  try {
    await writeNote(root, validNote());
    const result = await checkLongTermMemoryIntegrity(root);
    assert.equal((result as { health?: string }).health, "not_built");
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "indexes_not_built"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkLongTermMemoryIntegrity reports a published generation as healthy", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-integrity-healthy-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });

    const result = await checkLongTermMemoryIntegrity(root);

    assert.equal(result.health, "healthy");
    assert.equal(result.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkLongTermMemoryIntegrity reports indexes as stale after a vault mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-integrity-stale-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const storage = new LongTermMemoryStorage(root);
    await storage.updateNote(
      "world_test_mem",
      { sections: { facts: { text: "Changed after indexing.", updatedAt: timestamp } } },
      { suppressEvent: true },
    );

    const result = await checkLongTermMemoryIntegrity(root);

    assert.equal(result.health, "stale");
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "indexes_dirty"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("index publication keeps the previous generation current when staging fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-publication-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    const pointerPath = join(dirs.indexes, "current.json");
    const pointerBefore = await readFile(pointerPath, "utf8");

    await writeNote(root, validNote({ sections: { facts: { text: "Changed after publication.", updatedAt: timestamp } } }));
    await rm(join(dirs.indexes, "metadata.json"), { force: true });
    await mkdir(join(dirs.indexes, "metadata.json"), { recursive: true });

    await assert.rejects(
      rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) }),
    );
    assert.equal(await readFile(pointerPath, "utf8"), pointerBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retrieval does not adopt an unpublished generation when the current pointer is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-unpublished-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    await rm(join(dirs.indexes, "current.json"));
    invalidateLongTermMemoryRetrievalCache(root);

    const result = await retrieveLongTermMemory({
      root,
      queryText: "test memory",
      semanticWeight: 0,
      lexicalWeight: 1,
      graphWeight: 0,
      keywordWeight: 0,
      localEmbedder: async (texts) => texts.map(() => []),
    });

    assert.deepEqual(result.chunks, []);
    assert.ok(result.warnings.some((warning) => /not built/.test(warning)));
    const integrity = await checkLongTermMemoryIntegrity(root);
    assert.equal(integrity.health, "not_built");
    assert.equal(integrity.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retrieval recovers from a corrupt current generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-recovery-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    await writeNote(
      root,
      validNote({ sections: { facts: { text: "Changed current generation.", updatedAt: timestamp } } }),
    );
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    const pointer = JSON.parse(await readFile(join(dirs.indexes, "current.json"), "utf8")) as {
      generationId: string;
    };
    await writeFile(join(dirs.indexes, "generations", pointer.generationId, "metadata.json"), "{invalid json}");
    invalidateLongTermMemoryRetrievalCache(root);

    const result = await retrieveLongTermMemory({
      root,
      queryText: "test memory",
      semanticWeight: 0,
      lexicalWeight: 1,
      graphWeight: 0,
      keywordWeight: 0,
      localEmbedder: async (texts) => texts.map(() => []),
    });

    assert.equal(result.chunks[0]?.chunk.text, "A test memory.");
    assert.ok(result.warnings.some((warning) => /Recovered typed indexes/.test(warning)));
    const integrity = await checkLongTermMemoryIntegrity(root);
    assert.equal(integrity.health, "degraded");
    assert.equal(integrity.ok, false);
    assert.ok(integrity.issues.some((issue) => issue.code === "index_generation_recovered"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery follows pointer history instead of selecting an unreferenced newer generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-lineage-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    await writeNote(
      root,
      validNote({ sections: { facts: { text: "The second published memory.", updatedAt: timestamp } } }),
    );
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    const pointerPath = join(dirs.indexes, "current.json");
    const secondPointerText = await readFile(pointerPath, "utf8");
    const secondPointer = JSON.parse(secondPointerText) as { generationId: string };

    await writeNote(
      root,
      validNote({ sections: { facts: { text: "An unrelated newer generation.", updatedAt: timestamp } } }),
    );
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    await writeFile(pointerPath, secondPointerText);
    await writeFile(join(dirs.indexes, "generations", secondPointer.generationId, "metadata.json"), "{invalid json}");
    invalidateLongTermMemoryRetrievalCache(root);

    const result = await retrieveLongTermMemory({
      root,
      queryText: "memory",
      semanticWeight: 0,
      lexicalWeight: 1,
      graphWeight: 0,
      keywordWeight: 0,
      localEmbedder: async (texts) => texts.map(() => []),
    });

    assert.equal(result.chunks[0]?.chunk.text, "A test memory.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkLongTermMemoryIntegrity reports corrupt when no valid generation remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-corrupt-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    const pointer = JSON.parse(await readFile(join(dirs.indexes, "current.json"), "utf8")) as {
      generationId: string;
    };
    await writeFile(join(dirs.indexes, "generations", pointer.generationId, "metadata.json"), "{invalid json}");

    const result = await checkLongTermMemoryIntegrity(root);

    assert.equal(result.health, "corrupt");
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "index_generation_unavailable"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuild retries when the vault changes before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-concurrent-write-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const storage = new LongTermMemoryStorage(root);
    let releaseFirstBuild!: () => void;
    let markFirstBuildStarted!: () => void;
    const firstBuildStarted = new Promise<void>((resolve) => {
      markFirstBuildStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirstBuild = resolve;
    });
    let embedCalls = 0;
    const rebuild = rebuildLongTermMemoryIndexes({
      root,
      scope: "typed",
      localEmbedder: async (texts) => {
        embedCalls += 1;
        if (embedCalls === 1) {
          markFirstBuildStarted();
          await release;
        }
        return texts.map(() => []);
      },
    });

    await firstBuildStarted;
    await storage.updateNote(
      "world_test_mem",
      { sections: { facts: { text: "A concurrent sapphire revision.", updatedAt: timestamp } } },
      { suppressEvent: true },
    );
    releaseFirstBuild();
    await rebuild;
    invalidateLongTermMemoryRetrievalCache(root);

    const result = await retrieveLongTermMemory({
      root,
      queryText: "sapphire revision",
      semanticWeight: 0,
      lexicalWeight: 1,
      graphWeight: 0,
      keywordWeight: 0,
      localEmbedder: async (texts) => texts.map(() => []),
    });
    assert.ok(embedCalls >= 2);
    assert.equal(result.chunks[0]?.chunk.text, "A concurrent sapphire revision.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent index rebuilds are serialized per vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-serialized-"));
  try {
    await writeNote(root, validNote());
    let releaseFirstBuild!: () => void;
    let markFirstBuildStarted!: () => void;
    const firstBuildStarted = new Promise<void>((resolve) => {
      markFirstBuildStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirstBuild = resolve;
    });
    const sequence: string[] = [];
    const first = rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: async (texts) => {
        sequence.push("first-started");
        markFirstBuildStarted();
        await release;
        sequence.push("first-finished");
        return texts.map(() => []);
      },
    });

    await firstBuildStarted;
    const second = rebuildLongTermMemoryIndexes({
      root,
      localEmbedder: async (texts) => {
        sequence.push("second-started");
        return texts.map(() => []);
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sequence, ["first-started"]);

    releaseFirstBuild();
    await Promise.all([first, second]);
    assert.deepEqual(sequence, ["first-started", "first-finished", "second-started"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed index rebuild remains dirty and visible to integrity checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-failed-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const storage = new LongTermMemoryStorage(root);
    await storage.updateNote(
      "world_test_mem",
      { sections: { facts: { text: "This change needs a rebuild.", updatedAt: timestamp } } },
      { suppressEvent: true },
    );

    await assert.rejects(
      rebuildLongTermMemoryIndexes({
        root,
        localEmbedder: async () => {
          throw new Error("embedding backend unavailable");
        },
      }),
      /embedding backend unavailable/,
    );

    const state = await readLtmIndexState(root);
    assert.equal(state.dirty, true);
    assert.equal(state.rebuildState, "failed");
    assert.match(state.error ?? "", /embedding backend unavailable/);
    const integrity = await checkLongTermMemoryIntegrity(root);
    assert.equal(integrity.health, "stale");
    assert.equal(integrity.ok, false);
    assert.ok(integrity.issues.some((issue) => issue.code === "index_rebuild_failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkLongTermMemoryIntegrity — malformed note is flagged", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-integrity-malformed-"));
  try {
    const dirs = getLongTermMemoryDirectories(root);
    await mkdir(join(dirs.vault, "world"), { recursive: true });
    await writeFile(join(dirs.vault, "world", "world_bad.json"), "{invalid json}");
    const result = await checkLongTermMemoryIntegrity(root);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "malformed_note"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkLongTermMemoryIntegrity — missing link target is flagged", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-integrity-link-"));
  try {
    await writeNote(root, validNote({ links: [{ target: "char_nonexistent", relation: "involves" }] }));
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const result = await checkLongTermMemoryIntegrity(root);
    assert.equal(result.ok, true);
    assert.ok(result.issues.some((i) => i.code === "missing_link_target"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkLongTermMemoryIntegrity — folder/type mismatch is flagged", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-integrity-folder-"));
  try {
    const dirs = getLongTermMemoryDirectories(root);
    await mkdir(join(dirs.vault, "sources"), { recursive: true });
    await writeFile(
      join(dirs.vault, "sources", "world_test_mem.json"),
      JSON.stringify(validNote()),
    );
    const result = await checkLongTermMemoryIntegrity(root);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === "folder_type_mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkLongTermMemoryIntegrity — path/id mismatch is flagged", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-integrity-pathid-"));
  try {
    const dirs = getLongTermMemoryDirectories(root);
    await mkdir(join(dirs.vault, "world"), { recursive: true });
    await writeFile(
      join(dirs.vault, "world", "wrong_name.json"),
      JSON.stringify(validNote({ id: "world_test_mem" })),
    );
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const result = await checkLongTermMemoryIntegrity(root);
    assert.equal(result.ok, true);
    assert.ok(result.issues.some((i) => i.code === "path_id_mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repairLongTermMemory — rebuild_indexes action", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-repair-rebuild-"));
  try {
    await writeNote(root, validNote());
    const result = await repairLongTermMemory(["rebuild_indexes"], root);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]!.action, "rebuild_indexes");
    assert.equal(result.actions[0]!.result, "rebuilt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repairLongTermMemory — quarantine_malformed_notes action quarantines bad notes and rebuilds indexes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-repair-quarantine-"));
  try {
    await writeNote(root, validNote());
    const dirs = getLongTermMemoryDirectories(root);
    await mkdir(join(dirs.vault, "world"), { recursive: true });
    await writeFile(join(dirs.vault, "world", "world_bad.json"), "{invalid}");

    const result = await repairLongTermMemory(["quarantine_malformed_notes"], root);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]!.action, "quarantine_malformed_notes");
    assert.equal(result.actions[0]!.result, "quarantined");
    assert.equal(result.actions[0]!.count, 1);

    const integrity = await checkLongTermMemoryIntegrity(root);
    assert.equal(integrity.issues.filter((i) => i.code === "malformed_note").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repairLongTermMemory — no malformed notes yields no_malformed_notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-repair-clean-"));
  try {
    await writeNote(root, validNote());
    const result = await repairLongTermMemory(["quarantine_malformed_notes"], root);
    assert.equal(result.actions[0]!.result, "no_malformed_notes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repairLongTermMemory - combined repairs publish one final index generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-repair-combined-"));
  try {
    await writeNote(root, validNote({
      id: "source_imported_combined",
      type: "source",
      tags: ["imported_chat"],
      sections: { source: { text: "Imported source text.", updatedAt: timestamp } },
    }));
    const dirs = getLongTermMemoryDirectories(root);
    await mkdir(join(dirs.vault, "world"), { recursive: true });
    await writeFile(join(dirs.vault, "world", "world_bad.json"), "{invalid}");

    const result = await repairLongTermMemory([
      "quarantine_malformed_notes",
      "backfill_imported_source_titles",
      "rebuild_indexes",
    ], root);

    assert.deepEqual(result.actions.map((action) => action.action), [
      "quarantine_malformed_notes",
      "backfill_imported_source_titles",
      "rebuild_indexes",
    ]);
    assert.equal((await readdir(join(dirs.indexes, "generations"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy source notes remain readable and are not quarantined", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-repair-legacy-source-"));
  try {
    await writeNote(root, validNote({
      id: "scene_summary_legacy_source",
      type: "source",
      tags: ["source_summary"],
      previousHash: "legacy-transient-hash",
    }));

    const before = await checkLongTermMemoryIntegrity(root);
    assert.equal(before.issues.some((issue) => issue.code === "malformed_note"), false);

    const result = await repairLongTermMemory(["quarantine_malformed_notes"], root);
    assert.equal(result.actions[0]?.result, "no_malformed_notes");
    const stored = await readFile(
      join(getLongTermMemoryDirectories(root).vault, "sources", "scene_summary_legacy_source.json"),
      "utf8",
    );
    assert.match(stored, /scene_summary_legacy_source/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readLtmDebugLog — filter by operationId", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-debug-filter-"));
  try {
    await recordLtmDebugEvent({ root, phase: "extraction", action: "test", status: "ok", message: "alpha" });
    await recordLtmDebugEvent({ root, phase: "extraction", action: "test", status: "ok", message: "beta" });

    const all = await readLtmDebugLog({}, root);
    assert.ok(all.length >= 2);

    const opId = all[0]!.operationId;
    const filtered = await readLtmDebugLog({ operationId: opId }, root);
    assert.ok(filtered.every((e) => e.operationId === opId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readLtmDebugLog — filter by phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-debug-phase-"));
  try {
    await recordLtmDebugEvent({ root, phase: "import", action: "test", status: "ok", message: "import event" });
    await recordLtmDebugEvent({ root, phase: "extraction", action: "test", status: "ok", message: "extraction event" });
    const filtered = await readLtmDebugLog({ phase: "import" }, root);
    assert.ok(filtered.every((e) => e.phase === "import"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readLtmDebugLog — filter by status", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-debug-status-"));
  try {
    await recordLtmDebugEvent({ root, phase: "extraction", action: "test", status: "ok", message: "ok event" });
    await recordLtmDebugEvent({ root, phase: "extraction", action: "test", status: "error", message: "error event" });
    const filtered = await readLtmDebugLog({ status: "error" }, root);
    assert.ok(filtered.every((e) => e.status === "error"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clearLtmDebugLog — clears the log", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-debug-clear-"));
  try {
    await recordLtmDebugEvent({ root, phase: "extraction", action: "test", status: "ok", message: "to be cleared" });
    const result = await clearLtmDebugLog(root);
    assert.equal(result.cleared, true);
    const events = await readLtmDebugLog({}, root);
    assert.equal(events.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exportLtmDebugLog — exports the log as raw text", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-debug-export-"));
  try {
    await recordLtmDebugEvent({ root, phase: "extraction", action: "test", status: "ok", message: "export me" });
    const text = await exportLtmDebugLog(root);
    assert.ok(typeof text === "string");
    assert.ok(text.length > 0);
    assert.ok(text.includes("export me"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
