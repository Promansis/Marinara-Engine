import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
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
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";

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

test("checkLongTermMemoryIntegrity — valid note passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-integrity-valid-"));
  try {
    await writeNote(root, validNote());
    const result = await checkLongTermMemoryIntegrity(root);
    assert.equal(result.ok, true);
    assert.equal(result.issues.length, 0);
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
