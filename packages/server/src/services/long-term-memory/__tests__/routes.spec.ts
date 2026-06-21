import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../../app.js";

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
