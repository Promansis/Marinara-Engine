import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ltmBm25IndexSchema,
  ltmEmbeddingIndexSchema,
  ltmGraphIndexSchema,
  ltmKeywordIndexSchema,
  ltmMetadataIndexSchema,
  ltmRetentionConfigSchema,
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
import {
  loadLtmIndexGeneration,
  publishLtmIndexGeneration,
  readLtmIndexFamilyGeneration,
  writeLtmIndexFamilyGeneration,
} from "../index-generation.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import { invalidateLongTermMemoryRetrievalCache, retrieveLongTermMemory } from "../retrieval.js";
import { runLongTermMemoryRetention } from "../retention.js";
import { LongTermMemoryStorage } from "../storage.js";
import {
  longTermMemoryInjectionReceiptPath,
  longTermMemoryUsagePath,
  readLongTermMemoryUsage,
  recordLongTermMemoryInjection,
} from "../usage.js";
import type { LtmBudgetedChunk } from "../budget.js";
import { DEFAULT_LTM_RETRIEVAL_CONFIG } from "../default-config.js";

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

async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(join(root, entry.name))).map((path) => join(entry.name, path)));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files;
}

function budgetedChunk(id: string): LtmBudgetedChunk {
  return {
    chunk: {
      id,
      noteId: "world_test_mem",
      sectionKey: "facts",
      text: "A retained memory.",
      noteType: "world",
      status: "active",
      modes: ["roleplay"],
      scope: {},
      tags: [],
      keywords: [],
      updatedAt: timestamp,
      sourceHash: "a".repeat(64),
    },
    score: 1,
    reasons: [],
    lanes: [],
    tier: 3,
    estimatedTokens: 8,
  };
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

test("a first source-only rebuild publishes a complete generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-first-source-rebuild-"));
  try {
    await writeNote(
      root,
      validNote({
        id: "source_first_import",
        type: "source",
        tags: ["source_summary", "imported_chat"],
        extracted: false,
        sections: { source: { text: "A source awaiting review.", updatedAt: timestamp } },
      }),
    );

    const rebuild = await rebuildLongTermMemoryIndexes({
      root,
      scope: "source",
      localEmbedder: async (texts) => texts.map(() => []),
    });

    assert.ok(rebuild.generation.families.typed);
    assert.ok(rebuild.generation.families.source);
    const integrity = await checkLongTermMemoryIntegrity(root);
    assert.equal(integrity.health, "healthy");
    assert.equal(integrity.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial rebuild refreshes a stale complementary family", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-partial-complement-"));
  try {
    await writeNote(root, validNote());
    await writeNote(
      root,
      validNote({
        id: "source_partial_complement",
        type: "source",
        tags: ["source_summary", "imported_chat"],
        extracted: true,
        sections: { source: { text: "A source audit record.", updatedAt: timestamp } },
      }),
    );
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const storage = new LongTermMemoryStorage(root);
    await storage.updateNote(
      "world_test_mem",
      { sections: { facts: { text: "Updated before a source rebuild.", updatedAt: timestamp } } },
      { suppressEvent: true },
    );

    const rebuild = await rebuildLongTermMemoryIndexes({
      root,
      scope: "source",
      localEmbedder: async (texts) => texts.map(() => []),
    });
    const typed = await readLtmIndexFamilyGeneration(root, rebuild.generation.generationId, "typed");

    assert.equal(typed?.bundle.metadata.chunks["world_test_mem::facts"]?.text, "Updated before a source rebuild.");
    const integrity = await checkLongTermMemoryIntegrity(root);
    assert.equal(integrity.health, "healthy");
    assert.equal(integrity.ok, true);
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

test("index publication keeps the previous generation current when validation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-publication-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    const pointerPath = join(dirs.indexes, "current.json");
    const pointerBefore = await readFile(pointerPath, "utf8");

    await assert.rejects(
      publishLtmIndexGeneration(root, {
        version: 1,
        generationId: randomUUID(),
        publishedAt: timestamp,
      }),
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

test("retrieval marks an older recovered generation stale", async () => {
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
    assert.ok(result.warnings.some((warning) => /Recovered indexes/.test(warning)));
    const integrity = await checkLongTermMemoryIntegrity(root);
    assert.equal(integrity.health, "stale");
    assert.equal(integrity.ok, false);
    assert.ok(integrity.issues.some((issue) => issue.code === "index_generation_recovered"));
    assert.ok(integrity.issues.some((issue) => issue.code === "index_source_hash_mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuild quarantines malformed index state without discarding valid notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-state-rebuild-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    await writeFile(join(dirs.indexes, "state.json"), "{invalid json}");

    const rebuilt = await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const state = await readLtmIndexState(root);
    const note = await new LongTermMemoryStorage(root).getNote("world_test_mem");
    const quarantined = await listFilesRecursively(join(dirs.root, "quarantine", "indexes"));

    assert.equal(note?.sections.facts?.text, "A test memory.");
    assert.equal(state.dirty, false);
    assert.equal(state.lastPublishedGenerationId, rebuilt.generation.generationId);
    assert.ok(quarantined.some((path) => path.endsWith("state.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repair rebuilds from canonical notes after malformed index state", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-state-repair-"));
  try {
    await writeNote(root, validNote());
    const dirs = getLongTermMemoryDirectories(root);
    await mkdir(dirs.indexes, { recursive: true });
    await writeFile(join(dirs.indexes, "state.json"), "{invalid json}");

    const repaired = await repairLongTermMemory(["rebuild_indexes"], root);
    const quarantined = await listFilesRecursively(join(dirs.root, "quarantine", "indexes"));

    assert.equal(repaired.integrity.health, "healthy");
    assert.equal(repaired.integrity.noteCount, 1);
    assert.ok(quarantined.some((path) => path.endsWith("state.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuild quarantines a malformed current pointer before publishing a coherent generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-pointer-rebuild-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    await writeFile(join(dirs.indexes, "current.json"), "{invalid json}");

    const rebuilt = await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const loaded = await loadLtmIndexGeneration(root);
    const quarantined = await listFilesRecursively(join(dirs.root, "quarantine", "indexes"));

    assert.equal(loaded.recovered, false);
    assert.equal(loaded.manifest?.generationId, rebuilt.generation.generationId);
    assert.ok(quarantined.some((path) => path.endsWith("current.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery rejects damaged families as one generation and refreshes a warm cache", async () => {
  const artifacts = [
    { label: "typed", file: "metadata.json", corrupt: true },
    { label: "vector", file: "embeddings.json", corrupt: true },
    { label: "keyword", file: "keywords.json", corrupt: true },
    { label: "source", file: "source-metadata.json", corrupt: false },
  ] as const;

  for (const artifact of artifacts) {
    const root = await mkdtemp(join(tmpdir(), `marinara-ltm-index-${artifact.label}-`));
    try {
      await writeNote(root, validNote({ sections: { facts: { text: "First coherent memory.", updatedAt: timestamp } } }));
      await writeNote(
        root,
        validNote({
          id: "source_index_recovery",
          type: "source",
          tags: ["source_summary"],
          sections: { source: { text: "Source family fixture.", updatedAt: timestamp } },
        }),
      );
      const first = await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
      await writeNote(root, validNote({ sections: { facts: { text: "Second damaged memory.", updatedAt: timestamp } } }));
      const second = await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });

      const warm = await retrieveLongTermMemory({
        root,
        queryText: "memory",
        semanticWeight: 0,
        lexicalWeight: 1,
        graphWeight: 0,
        keywordWeight: 0,
        localEmbedder: async (texts) => texts.map(() => []),
      });
      assert.equal(warm.chunks[0]?.chunk.text, "Second damaged memory.", artifact.label);

      const artifactPath = join(
        getLongTermMemoryDirectories(root).indexes,
        "generations",
        second.generation.generationId,
        artifact.file,
      );
      if (artifact.corrupt) {
        await writeFile(artifactPath, "{invalid json}");
      } else {
        await rm(artifactPath);
      }

      const recovered = await retrieveLongTermMemory({
        root,
        queryText: "memory",
        semanticWeight: 0,
        lexicalWeight: 1,
        graphWeight: 0,
        keywordWeight: 0,
        localEmbedder: async (texts) => texts.map(() => []),
      });
      invalidateLongTermMemoryRetrievalCache(root);
      const afterCacheReset = await retrieveLongTermMemory({
        root,
        queryText: "memory",
        semanticWeight: 0,
        lexicalWeight: 1,
        graphWeight: 0,
        keywordWeight: 0,
        localEmbedder: async (texts) => texts.map(() => []),
      });
      const loaded = await loadLtmIndexGeneration(root);
      const quarantined = await listFilesRecursively(
        join(getLongTermMemoryDirectories(root).root, "quarantine", "indexes"),
      );

      assert.equal(recovered.chunks[0]?.chunk.text, "First coherent memory.", artifact.label);
      assert.equal(afterCacheReset.chunks[0]?.chunk.text, "First coherent memory.", artifact.label);
      assert.ok(recovered.warnings.some((warning) => /Recovered indexes/.test(warning)), artifact.label);
      assert.equal(loaded.recovered, true, artifact.label);
      assert.equal(loaded.manifest?.generationId, first.generation.generationId, artifact.label);
      assert.ok(quarantined.some((path) => path.includes(second.generation.generationId)), artifact.label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("index rebuild writes no unread flat-index artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-index-no-legacy-"));
  try {
    await writeNote(root, validNote());
    await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const entries = await readdir(getLongTermMemoryDirectories(root).indexes);

    for (const legacyFile of [
      "manifest.json",
      "metadata.json",
      "bm25.json",
      "graph.json",
      "keywords.json",
      "embeddings.json",
      "source-metadata.json",
      "source-bm25.json",
      "source-graph.json",
      "source-keywords.json",
      "source-embeddings.json",
    ]) {
      assert.equal(entries.includes(legacyFile), false, legacyFile);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuild reuses embeddings for unchanged chunk source hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-embedding-reuse-"));
  try {
    await writeNote(root, validNote());
    const batches: string[][] = [];
    const localEmbedder = async (texts: string[]) => {
      batches.push([...texts]);
      return texts.map((text) => [text.length, 1]);
    };

    const first = await rebuildLongTermMemoryIndexes({ root, localEmbedder });
    await rebuildLongTermMemoryIndexes({ root, localEmbedder });

    assert.equal(batches.length, 1, "an unchanged family must reuse its prior vectors");
    const firstFamily = await readLtmIndexFamilyGeneration(root, first.generation.generationId, "typed");
    assert.equal(firstFamily?.bundle.embeddings.byChunkId?.["world_test_mem::facts"], 0);

    await new LongTermMemoryStorage(root).updateNote(
      "world_test_mem",
      { sections: { facts: { text: "Only this memory changed.", updatedAt: timestamp } } },
      { suppressEvent: true },
    );
    await rebuildLongTermMemoryIndexes({ root, localEmbedder });

    assert.deepEqual(batches.map((batch) => batch.length), [1, 1]);
    assert.deepEqual(batches[1], ["Only this memory changed."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retrieval bounds catalog work while preserving a fixed relevance corpus", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-bounded-retrieval-"));
  try {
    for (let index = 0; index < 3; index += 1) {
      await writeNote(
        root,
        validNote({
          id: `world_candidate_${index}`,
          sections: {
            facts: {
              text: index === 2 ? "The target constellation matters." : `Background candidate ${index}.`,
              updatedAt: timestamp,
            },
          },
        }),
      );
    }
    const localEmbedder = async (texts: string[]) =>
      texts.map((text) => (text.toLocaleLowerCase().includes("target") ? [1, 0] : [0, 1]));
    await rebuildLongTermMemoryIndexes({ root, localEmbedder });

    const input = {
      root,
      queryText: "target",
      semanticWeight: 1,
      lexicalWeight: 0,
      graphWeight: 0,
      keywordWeight: 0,
      maxChunks: 3,
      localEmbedder,
    };
    const baseline = await retrieveLongTermMemory(input);

    const dirs = getLongTermMemoryDirectories(root);
    const fixedCorpusConfig = {
      ...DEFAULT_LTM_RETRIEVAL_CONFIG,
      maxMetadataCandidates: 3,
      maxDirectCandidates: 3,
      maxLexicalCandidates: 3,
      maxKeywordCandidates: 3,
      maxVectorCandidates: 3,
      maxGraphCandidates: 3,
      maxMandatoryCandidates: 3,
    };
    await writeFile(join(dirs.config, "retrieval.json"), JSON.stringify(fixedCorpusConfig));
    invalidateLongTermMemoryRetrievalCache(root);
    const boundedEquivalent = await retrieveLongTermMemory(input);
    assert.deepEqual(
      boundedEquivalent.chunks.map((item) => item.chunk.id),
      baseline.chunks.map((item) => item.chunk.id),
    );

    const cappedConfig = { ...fixedCorpusConfig, maxMetadataCandidates: 2, maxVectorCandidates: 2 };
    await writeFile(join(dirs.config, "retrieval.json"), JSON.stringify(cappedConfig));
    invalidateLongTermMemoryRetrievalCache(root);
    const capped = await retrieveLongTermMemory({ ...input, debug: true });
    assert.equal(capped.debug?.funnel.catalogCandidates, 2);
    assert.equal(capped.debug?.funnel.vectorCatalogCandidates, 2);
    assert.ok((capped.debug?.funnel.vectorCandidates ?? 0) <= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention honors its audit floor and preserves active generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-retention-"));
  try {
    await writeNote(root, validNote());
    const rebuild = await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });
    const dirs = getLongTermMemoryDirectories(root);
    const now = new Date("2026-08-01T00:00:00.000Z");
    const old = new Date("2026-05-01T00:00:00.000Z");
    const current = new Date("2026-07-25T00:00:00.000Z");

    await recordLongTermMemoryInjection({ chatId: "chat_old", chunks: [budgetedChunk("old_chunk")], serializedTokenCount: 8 }, root);
    await recordLongTermMemoryInjection(
      { chatId: "chat_current", chunks: [budgetedChunk("current_chunk")], serializedTokenCount: 8 },
      root,
    );
    const usagePath = longTermMemoryUsagePath(root);
    const usage = await readLongTermMemoryUsage(root);
    const oldUsage = usage.chats.chat_old?.chunks.old_chunk;
    const currentUsage = usage.chats.chat_current?.chunks.current_chunk;
    assert.ok(oldUsage);
    assert.ok(currentUsage);
    oldUsage.lastRetrievedAt = old.toISOString();
    oldUsage.lastInjectedAt = old.toISOString();
    currentUsage.lastRetrievedAt = current.toISOString();
    currentUsage.lastInjectedAt = current.toISOString();
    await writeFile(usagePath, JSON.stringify(usage));

    for (const [chatId, date] of [["chat_old", old], ["chat_current", current]] as const) {
      const path = longTermMemoryInjectionReceiptPath(chatId, root);
      const receipt = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      receipt.dispatchedAt = date.toISOString();
      await writeFile(path, JSON.stringify(receipt));
    }
    await writeFile(
      dirs.eventLog,
      [
        JSON.stringify({ id: randomUUID(), ts: old.toISOString(), type: "note.updated", target: "world_test_mem" }),
        JSON.stringify({ id: randomUUID(), ts: current.toISOString(), type: "note.updated", target: "world_test_mem" }),
        "",
      ].join("\n"),
    );

    const incompleteGeneration = join(dirs.indexes, "generations", randomUUID());
    await mkdir(incompleteGeneration, { recursive: true });
    await utimes(incompleteGeneration, old, old);
    const oldQuarantine = join(root, "quarantine", "old.json");
    const currentQuarantine = join(root, "quarantine", "current.json");
    await mkdir(join(root, "quarantine"), { recursive: true });
    await writeFile(oldQuarantine, "old");
    await writeFile(currentQuarantine, "current");
    await utimes(oldQuarantine, old, old);
    await utimes(currentQuarantine, current, current);

    const config = {
      version: 1 as const,
      auditWindowDays: 7,
      usageRetentionDays: 30,
      receiptRetentionDays: 30,
      eventRetentionDays: 30,
      incompleteGenerationRetentionDays: 30,
      quarantineRetentionDays: 30,
    };
    const result = await runLongTermMemoryRetention({ root, now, config, force: true });

    assert.deepEqual(
      {
        usageEntries: result.usageEntries,
        receipts: result.receipts,
        events: result.events,
        incompleteGenerations: result.incompleteGenerations,
        quarantineArtifacts: result.quarantineArtifacts,
      },
      { usageEntries: 1, receipts: 1, events: 1, incompleteGenerations: 1, quarantineArtifacts: 1 },
    );
    assert.equal((await readLongTermMemoryUsage(root)).chats.chat_old, undefined);
    assert.ok((await readLongTermMemoryUsage(root)).chats.chat_current);
    await assert.rejects(readFile(longTermMemoryInjectionReceiptPath("chat_old", root), "utf8"));
    assert.doesNotReject(readFile(longTermMemoryInjectionReceiptPath("chat_current", root), "utf8"));
    assert.match(await readFile(dirs.eventLog, "utf8"), /2026-07-25/);
    assert.doesNotMatch(await readFile(dirs.eventLog, "utf8"), /2026-05-01/);
    assert.equal((await readdir(join(dirs.indexes, "generations"))).includes(rebuild.generation.generationId), true);
    assert.equal((await readdir(join(dirs.indexes, "generations"))).includes(basename(incompleteGeneration)), false);
    await assert.rejects(readFile(oldQuarantine, "utf8"));
    assert.equal(await readFile(currentQuarantine, "utf8"), "current");
    assert.equal(
      ltmRetentionConfigSchema.safeParse({ ...config, eventRetentionDays: 6 }).success,
      false,
      "retention cannot shorten the configured audit window",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault initialization schedules retention for expired operational artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-retention-initialize-"));
  try {
    await recordLongTermMemoryInjection(
      { chatId: "chat_expired", chunks: [budgetedChunk("expired_chunk")], serializedTokenCount: 8 },
      root,
    );
    const receiptPath = longTermMemoryInjectionReceiptPath("chat_expired", root);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    receipt.dispatchedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(receiptPath, JSON.stringify(receipt));

    const usage = await readLongTermMemoryUsage(root);
    const expiredUsage = usage.chats.chat_expired?.chunks.expired_chunk;
    assert.ok(expiredUsage);
    expiredUsage.lastRetrievedAt = "2000-01-01T00:00:00.000Z";
    expiredUsage.lastInjectedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(longTermMemoryUsagePath(root), JSON.stringify(usage));

    await new LongTermMemoryStorage(root).initializeLtmStore();

    await assert.rejects(readFile(receiptPath, "utf8"));
    assert.equal((await readLongTermMemoryUsage(root)).chats.chat_expired, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention never deletes artifacts while mutation recovery is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-retention-pending-"));
  try {
    const dirs = getLongTermMemoryDirectories(root);
    await recordLongTermMemoryInjection({ chatId: "chat_pending", chunks: [budgetedChunk("pending_chunk")], serializedTokenCount: 8 }, root);
    const receiptPath = longTermMemoryInjectionReceiptPath("chat_pending", root);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    receipt.dispatchedAt = "2026-01-01T00:00:00.000Z";
    await writeFile(receiptPath, JSON.stringify(receipt));
    await mkdir(dirs.transactions, { recursive: true });
    await writeFile(join(dirs.transactions, "pending.json"), "{}");

    const result = await runLongTermMemoryRetention({
      root,
      now: "2026-08-01T00:00:00.000Z",
      config: {
        version: 1,
        auditWindowDays: 7,
        usageRetentionDays: 30,
        receiptRetentionDays: 30,
        eventRetentionDays: 30,
        incompleteGenerationRetentionDays: 30,
        quarantineRetentionDays: 30,
      },
      force: true,
    });

    assert.equal(result.skippedPendingRecovery, true);
    assert.doesNotReject(readFile(receiptPath, "utf8"));
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
