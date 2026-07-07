import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../../app.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";

test("LTM routes — guarded endpoints return 403 from non-loopback without auth", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-routes-auth-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousBasicAuthUser = process.env.BASIC_AUTH_USER;
  const previousBasicAuthPass = process.env.BASIC_AUTH_PASS;
  const previousAdminSecret = process.env.ADMIN_SECRET;

  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    app = await buildApp();

    const expect403 = async (url: string, method: "GET" | "POST" | "DELETE") => {
      const response = await app!.inject({ method, url, remoteAddress: "10.0.0.1" });
      assert.equal(response.statusCode, 403, `Expected 403 for ${method} ${url}, got ${response.statusCode}`);
    };

    await expect403("/api/long-term-memory/status", "GET");
    await expect403("/api/long-term-memory/notes", "GET");
    await expect403("/api/long-term-memory/notes/nonexistent", "GET");
    await expect403("/api/long-term-memory/settings", "GET");
    await expect403("/api/long-term-memory/extraction-settings", "GET");
    await expect403("/api/long-term-memory/debug-log", "GET");
    await expect403("/api/long-term-memory/drafts", "GET");
    await expect403("/api/long-term-memory/drafts/pending-count", "GET");
    await expect403("/api/long-term-memory/drafts/nonexistent", "GET");
    await expect403("/api/long-term-memory/search", "POST");
    await expect403("/api/long-term-memory/notes", "POST");
    await expect403("/api/long-term-memory/notes/nonexistent", "DELETE");
    await expect403("/api/long-term-memory/debug-log", "DELETE");
    await expect403("/api/long-term-memory/rebuild", "POST");
    await expect403("/api/long-term-memory/repair", "POST");
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousBasicAuthUser === undefined) delete process.env.BASIC_AUTH_USER;
    else process.env.BASIC_AUTH_USER = previousBasicAuthUser;
    if (previousBasicAuthPass === undefined) delete process.env.BASIC_AUTH_PASS;
    else process.env.BASIC_AUTH_PASS = previousBasicAuthPass;
    if (previousAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = previousAdminSecret;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("LTM routes — guarded endpoints work from loopback without auth", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-routes-loopback-"));
  const previousDataDir = process.env.DATA_DIR;

  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    app = await buildApp();

    const status = await app.inject({
      method: "GET",
      url: "/api/long-term-memory/status",
      remoteAddress: "127.0.0.1",
    });
    assert.equal(status.statusCode, 200);
    const body = JSON.parse(status.body);
    assert.equal(body.initialized, true);
    assert.ok(body.indexes !== undefined);

    const notes = await app.inject({
      method: "GET",
      url: "/api/long-term-memory/notes",
      remoteAddress: "127.0.0.1",
    });
    assert.equal(notes.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(notes.body)));

    const drafts = await app.inject({
      method: "GET",
      url: "/api/long-term-memory/drafts",
      remoteAddress: "127.0.0.1",
    });
    assert.equal(drafts.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(drafts.body)));
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("LTM routes — GET /drafts/pending-count can be scoped to a chat", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-routes-pending-count-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousBasicAuthUser = process.env.BASIC_AUTH_USER;
  const previousBasicAuthPass = process.env.BASIC_AUTH_PASS;
  const previousAdminSecret = process.env.ADMIN_SECRET;

  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    app = await buildApp();
    const draftStore = new LongTermMemoryDraftStore(join(dataDir, "long-term-memory"));
    let sourceIndex = 0;
    const createDraft = async (chatId: string) => {
      sourceIndex += 1;
      const sourceNoteId = `source_${chatId}_${sourceIndex}`;
      return draftStore.createDraft({
        source: { chatId, sourceNoteId },
        modes: ["roleplay"],
        response: {
          summary: "Pending suggestions",
          mutations: [
            {
              id: randomUUID(),
              kind: "append_section",
              noteId: "world_pending_count",
              sectionKey: "facts",
              text: `Memory from ${chatId}`,
              risk: "medium",
              confidence: 0.8,
              summary: "Append chat-scoped detail",
              evidence: [`source_note:${sourceNoteId}`],
            },
          ],
        },
      });
    };

    await createDraft("chat_a");
    await createDraft("chat_a");
    const acceptedDraft = await createDraft("chat_a");
    await draftStore.updateDraftStatus(acceptedDraft.id, "accepted");
    await createDraft("chat_b");

    const fetchCount = async (query = "") => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/long-term-memory/drafts/pending-count${query}`,
        remoteAddress: "127.0.0.1",
      });
      assert.equal(response.statusCode, 200, response.body);
      return JSON.parse(response.body) as { count: number };
    };

    assert.deepEqual(await fetchCount(), { count: 3 });
    assert.deepEqual(await fetchCount("?chatId=chat_a"), { count: 2 });
    assert.deepEqual(await fetchCount("?chatId=chat_b"), { count: 1 });
    assert.deepEqual(await fetchCount("?chatId=chat_c"), { count: 0 });
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousBasicAuthUser === undefined) delete process.env.BASIC_AUTH_USER;
    else process.env.BASIC_AUTH_USER = previousBasicAuthUser;
    if (previousBasicAuthPass === undefined) delete process.env.BASIC_AUTH_PASS;
    else process.env.BASIC_AUTH_PASS = previousBasicAuthPass;
    if (previousAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = previousAdminSecret;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("LTM routes — POST /notes returns 400 on invalid body", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-routes-validation-"));
  const previousDataDir = process.env.DATA_DIR;

  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/long-term-memory/notes",
      payload: { invalid: true },
      remoteAddress: "127.0.0.1",
    });
    assert.equal(response.statusCode, 400);
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("LTM routes — POST /repair accepts the full 3-action repair payload", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-routes-repair-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousBasicAuthUser = process.env.BASIC_AUTH_USER;
  const previousBasicAuthPass = process.env.BASIC_AUTH_PASS;
  const previousAdminSecret = process.env.ADMIN_SECRET;

  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/long-term-memory/repair",
      payload: {
        actions: [
          "quarantine_malformed_notes",
          "backfill_imported_source_titles",
          "rebuild_indexes",
        ],
      },
      remoteAddress: "127.0.0.1",
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.actions.length, 3);
    assert.deepEqual(
      body.actions.map((entry: { action: string }) => entry.action),
      [
        "quarantine_malformed_notes",
        "backfill_imported_source_titles",
        "rebuild_indexes",
      ],
    );
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousBasicAuthUser === undefined) delete process.env.BASIC_AUTH_USER;
    else process.env.BASIC_AUTH_USER = previousBasicAuthUser;
    if (previousBasicAuthPass === undefined) delete process.env.BASIC_AUTH_PASS;
    else process.env.BASIC_AUTH_PASS = previousBasicAuthPass;
    if (previousAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = previousAdminSecret;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("LTM routes — GET /notes/:id returns 404 for missing note", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-routes-404-"));
  const previousDataDir = process.env.DATA_DIR;

  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/long-term-memory/notes/world_nonexistent",
      remoteAddress: "127.0.0.1",
    });
    assert.equal(response.statusCode, 404);
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("LTM routes — POST /notes creates and GET /notes/:id retrieves it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-routes-crud-"));
  const previousDataDir = process.env.DATA_DIR;

  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    app = await buildApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/long-term-memory/notes",
      payload: {
        id: "world_route_test",
        type: "world",
        status: "active",
        modes: ["roleplay"],
        scope: {},
        tags: [],
        links: [],
        sections: { facts: { text: "Route test memory.", updatedAt: new Date().toISOString() } },
        version: 1,
      },
      remoteAddress: "127.0.0.1",
    });
    assert.equal(create.statusCode, 201);
    const created = JSON.parse(create.body);
    assert.equal(created.id, "world_route_test");

    const get = await app.inject({
      method: "GET",
      url: "/api/long-term-memory/notes/world_route_test",
      remoteAddress: "127.0.0.1",
    });
    assert.equal(get.statusCode, 200);
    assert.equal(JSON.parse(get.body).id, "world_route_test");
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("LTM routes — DELETE /notes/:id/scope removes the selected context links", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-routes-unscope-context-"));
  const previousDataDir = process.env.DATA_DIR;

  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    app = await buildApp();
    const updatedAt = new Date().toISOString();
    const baseNote = {
      type: "world",
      status: "active",
      modes: ["roleplay"],
      tags: [],
      links: [],
      sections: { facts: { text: "Scoped route test memory.", updatedAt } },
      version: 1,
    };
    const createScoped = async (id: string, scope: Record<string, unknown>) => {
      const response = await app!.inject({
        method: "POST",
        url: "/api/long-term-memory/notes",
        payload: { ...baseNote, id, scope },
        remoteAddress: "127.0.0.1",
      });
      assert.equal(response.statusCode, 201, response.body);
    };

    await createScoped("world_route_context_keep", {
      chatId: "branch_a",
      chatIds: ["branch_a", "branch_b"],
      groupId: "thread_alpha",
      characterIds: ["char_mara", "char_else"],
    });
    await createScoped("world_route_context_delete", {
      chatId: "branch_a",
      chatIds: ["branch_a"],
      groupId: "thread_alpha",
      characterIds: ["char_mara"],
    });
    await createScoped("world_route_context_noop", {
      chatId: "branch_c",
      chatIds: ["branch_c"],
    });
    await createScoped("world_route_context_global", {});

    const removePayload = {
      chatIds: ["branch_a"],
      groupId: "thread_alpha",
      characterIds: ["char_mara"],
    };

    const keep = await app.inject({
      method: "DELETE",
      url: "/api/long-term-memory/notes/world_route_context_keep/scope",
      payload: removePayload,
      remoteAddress: "127.0.0.1",
    });
    assert.equal(keep.statusCode, 200, keep.body);
    const keepBody = JSON.parse(keep.body);
    assert.equal(keepBody.deleted, false);
    assert.equal(keepBody.unscoped, true);
    assert.deepEqual(keepBody.note.scope, {
      chatId: "branch_b",
      chatIds: ["branch_b"],
      characterIds: ["char_else"],
    });

    const noop = await app.inject({
      method: "DELETE",
      url: "/api/long-term-memory/notes/world_route_context_noop/scope",
      payload: removePayload,
      remoteAddress: "127.0.0.1",
    });
    assert.equal(noop.statusCode, 200, noop.body);
    const noopBody = JSON.parse(noop.body);
    assert.equal(noopBody.deleted, false);
    assert.equal(noopBody.unscoped, false);
    assert.deepEqual(noopBody.note.scope, {
      chatId: "branch_c",
      chatIds: ["branch_c"],
    });

    const globalNoop = await app.inject({
      method: "DELETE",
      url: "/api/long-term-memory/notes/world_route_context_global/scope",
      payload: removePayload,
      remoteAddress: "127.0.0.1",
    });
    assert.equal(globalNoop.statusCode, 200, globalNoop.body);
    const globalNoopBody = JSON.parse(globalNoop.body);
    assert.equal(globalNoopBody.deleted, false);
    assert.equal(globalNoopBody.unscoped, false);
    assert.deepEqual(globalNoopBody.note.scope, {});

    const scopedList = await app.inject({
      method: "GET",
      url: "/api/long-term-memory/notes?scopeChatIds=branch_a&scopeGroupId=thread_alpha&scopeCharacterIds=char_mara&includeGlobal=false",
      remoteAddress: "127.0.0.1",
    });
    assert.equal(scopedList.statusCode, 200, scopedList.body);
    assert.deepEqual(
      JSON.parse(scopedList.body).map((note: { id: string }) => note.id),
      ["world_route_context_delete"],
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/long-term-memory/notes/world_route_context_delete/scope",
      payload: removePayload,
      remoteAddress: "127.0.0.1",
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    const deletedBody = JSON.parse(deleted.body);
    assert.equal(deletedBody.deleted, true);
    assert.equal(deletedBody.unscoped, false);

    const getDeleted = await app.inject({
      method: "GET",
      url: "/api/long-term-memory/notes/world_route_context_delete",
      remoteAddress: "127.0.0.1",
    });
    assert.equal(getDeleted.statusCode, 404, getDeleted.body);
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("LTM routes — read endpoints tolerate legacy previousHash notes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-routes-legacy-note-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousBasicAuthUser = process.env.BASIC_AUTH_USER;
  const previousBasicAuthPass = process.env.BASIC_AUTH_PASS;
  const previousAdminSecret = process.env.ADMIN_SECRET;

  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    const vaultDir = join(dataDir, "long-term-memory", "vault", "world");
    const timestamp = new Date().toISOString();
    await mkdir(vaultDir, { recursive: true });
    await writeFile(
      join(vaultDir, "world_legacy_previous_hash.json"),
      `${JSON.stringify(
        {
          id: "world_legacy_previous_hash",
          type: "world",
          status: "active",
          modes: ["roleplay"],
          scope: {},
          tags: [],
          createdAt: timestamp,
          updatedAt: timestamp,
          links: [],
          sections: { facts: { text: "Legacy previousHash note.", updatedAt: timestamp } },
          version: 2,
          previousHash: "a".repeat(64),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    app = await buildApp();

    const status = await app.inject({
      method: "GET",
      url: "/api/long-term-memory/status",
      remoteAddress: "127.0.0.1",
    });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(JSON.parse(status.body).notes.total, 1);

    const notes = await app.inject({
      method: "GET",
      url: "/api/long-term-memory/notes?status=active",
      remoteAddress: "127.0.0.1",
    });
    assert.equal(notes.statusCode, 200, notes.body);
    const body = JSON.parse(notes.body);
    assert.equal(body.length, 1);
    assert.equal(body[0].id, "world_legacy_previous_hash");
    assert.equal(body[0].previousHash, undefined);
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousBasicAuthUser === undefined) delete process.env.BASIC_AUTH_USER;
    else process.env.BASIC_AUTH_USER = previousBasicAuthUser;
    if (previousBasicAuthPass === undefined) delete process.env.BASIC_AUTH_PASS;
    else process.env.BASIC_AUTH_PASS = previousBasicAuthPass;
    if (previousAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = previousAdminSecret;
    await rm(dataDir, { recursive: true, force: true });
  }
});
