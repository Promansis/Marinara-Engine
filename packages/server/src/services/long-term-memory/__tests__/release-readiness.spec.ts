import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../../../app.js";
import { createChatsStorage } from "../../storage/chats.storage.js";
import { createConnectionsStorage } from "../../storage/connections.storage.js";
import { copyLongTermMemoryBackupSnapshot, restoreLongTermMemoryBackup } from "../backup-restore.js";
import { getLongTermMemoryRoot } from "../paths.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import { LongTermMemoryStorage } from "../storage.js";
import { readLongTermMemoryInjectionReceipt, readLongTermMemoryUsage } from "../usage.js";

type ProviderMessage = { role?: string; content?: string };

type RecordingProvider = {
  baseUrl: string;
  calls: Array<{ messages: ProviderMessage[]; extraction: boolean }>;
  rejectGeneration: boolean;
};

const releaseFact = "The phase eleven archive opens only with the cobalt key.";
const outOfScopeFact = "The other group must never receive the phase eleven archive key.";

async function withRecordingProvider(run: (provider: RecordingProvider) => Promise<void>) {
  const provider: RecordingProvider = {
    baseUrl: "",
    calls: [],
    rejectGeneration: false,
  };
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");

      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: ProviderMessage[];
        stream?: boolean;
      };
      const messages = body.messages ?? [];
      const extraction = JSON.stringify(body).includes("sourceText");
      provider.calls.push({ messages, extraction });

      if (!extraction && provider.rejectGeneration) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Release-readiness provider rejection." } }));
        return;
      }

      const content = extraction
        ? JSON.stringify({
            summary: "One durable archive fact.",
            units: [
              {
                id: "550e8400-e29b-41d4-a716-446655440000",
                bucket: "world_fact",
                subjectId: "phase_eleven_archive",
                sectionKey: "facts",
                text: releaseFact,
                importance: "critical",
                keywords: ["cobalt key", "archive"],
                evidence: ["source_note:source_phase_eleven_archive"],
                confidence: 0.98,
                salience: 0.98,
                status: "active",
                links: [],
                sourceHash: "provider-owned-placeholder",
                subjectKeys: [],
              },
            ],
          })
        : "The provider accepted the fitted release-readiness prompt.";

      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "phase-eleven-extraction",
            object: "chat.completion.chunk",
            created: 0,
            model: "phase-eleven-model",
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "phase-eleven-extraction",
            object: "chat.completion.chunk",
            created: 0,
            model: "phase-eleven-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "phase-eleven-generation",
          object: "chat.completion",
          created: 0,
          model: "phase-eleven-model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        }),
      );
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await run(provider);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function withTestData(run: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-release-readiness-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousBasicAuthUser = process.env.BASIC_AUTH_USER;
  const previousBasicAuthPass = process.env.BASIC_AUTH_PASS;
  const previousAdminSecret = process.env.ADMIN_SECRET;
  process.env.DATA_DIR = dataDir;
  delete process.env.BASIC_AUTH_USER;
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.ADMIN_SECRET;

  try {
    await run(dataDir);
  } finally {
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
}

async function createTestConnection(app: Awaited<ReturnType<typeof buildApp>>, baseUrl: string) {
  const connections = createConnectionsStorage(app.db);
  const connection = await connections.create({
    name: "Phase 11 provider",
    provider: "custom",
    baseUrl,
    apiKey: "",
    model: "phase-eleven-model",
    imagePath: null,
    maxContext: 16_384,
    isDefault: true,
    useForRandom: false,
    defaultForAgents: false,
    enableCaching: false,
    cachingAtDepth: 5,
    embeddingModel: "",
    embeddingBaseUrl: "",
    embeddingConnectionId: null,
    openrouterProvider: null,
    imageGenerationSource: null,
    comfyuiWorkflow: null,
    imageService: null,
    imageEndpointId: null,
    promptPresetId: null,
    maxTokensOverride: null,
    maxParallelJobs: 1,
    treatAsLocalEndpoint: true,
    claudeFastMode: false,
  });
  assert(connection);
  return connection;
}

async function createEnabledConversation(app: Awaited<ReturnType<typeof buildApp>>, connectionId: string, groupId: string) {
  const chats = createChatsStorage(app.db);
  const chat = await chats.create({
    name: "Phase 11 release readiness",
    mode: "conversation",
    characterIds: [],
    groupId,
    personaId: null,
    promptPresetId: null,
    connectionId,
  });
  assert(chat);
  await chats.patchMetadata(chat.id, {
    enableAgents: false,
    enableLongTermMemory: true,
    longTermMemoryBudgetTokens: 4096,
    longTermMemoryMaxChunks: 4,
    longTermMemoryScoreThreshold: 0,
  });
  return chat;
}

async function generate(
  app: Awaited<ReturnType<typeof buildApp>>,
  chatId: string,
  userMessage = "Which key opens the phase eleven archive?",
) {
  return app.inject({
    method: "POST",
    url: "/api/generate",
    remoteAddress: "127.0.0.1",
    payload: {
      chatId,
      userMessage,
      streaming: false,
    },
  });
}

function latestGenerationText(provider: RecordingProvider) {
  const call = provider.calls.filter((candidate) => !candidate.extraction).at(-1);
  assert(call, "generation should reach the provider");
  return call.messages.map((message) => message.content ?? "").join("\n");
}

test("release readiness matrix follows capture through restart, deletion, and restore", async () => {
  await withRecordingProvider(async (provider) => {
    await withTestData(async (dataDir) => {
      const root = getLongTermMemoryRoot(dataDir);
      const backupRoot = join(dataDir, "release-readiness-backup");
      const groupId = "phase-eleven-group";
      let app: Awaited<ReturnType<typeof buildApp>> | null = null;

      try {
        app = await buildApp();
        const connection = await createTestConnection(app, provider.baseUrl);
        const chat = await createEnabledConversation(app, connection.id, groupId);

        const source = await app.inject({
          method: "POST",
          url: "/api/long-term-memory/notes",
          remoteAddress: "127.0.0.1",
          payload: {
            id: "source_phase_eleven_archive",
            title: "Phase Eleven Source",
            type: "source",
            status: "active",
            modes: ["conversation"],
            scope: { groupId },
            tags: ["source_summary"],
            links: [],
            sections: {
              source: {
                text: releaseFact,
                updatedAt: "2026-07-12T00:00:00.000Z",
                evidence: [`chat:${chat.id}`],
              },
            },
            version: 1,
          },
        });
        assert.equal(source.statusCode, 201, source.body);

        const extracted = await app.inject({
          method: "POST",
          url: "/api/long-term-memory/notes/source_phase_eleven_archive/extract",
          remoteAddress: "127.0.0.1",
          payload: { chatId: chat.id, applyLowRisk: false },
        });
        assert.equal(extracted.statusCode, 200, extracted.body);
        assert.equal(provider.calls.filter((call) => call.extraction).length, 1, JSON.stringify(provider.calls));
        const draft = JSON.parse(extracted.body).draft as { id: string; mutations: Array<{ id: string }> } | null;
        assert.ok(draft);
        assert.equal(draft.mutations.length, 1, extracted.body);

        const accepted = await app.inject({
          method: "POST",
          url: `/api/long-term-memory/drafts/${draft.id}/accept`,
          remoteAddress: "127.0.0.1",
          payload: {},
        });
        assert.equal(accepted.statusCode, 200, accepted.body);
        assert.deepEqual(JSON.parse(accepted.body).appliedMutationIds, [draft.mutations[0]!.id]);

        const rebuilt = await app.inject({
          method: "POST",
          url: "/api/long-term-memory/rebuild",
          remoteAddress: "127.0.0.1",
          payload: {},
        });
        assert.equal(rebuilt.statusCode, 200, rebuilt.body);

        const outOfScope = await app.inject({
          method: "POST",
          url: "/api/long-term-memory/notes",
          remoteAddress: "127.0.0.1",
          payload: {
            id: "world_phase_eleven_other_group",
            type: "world",
            status: "active",
            modes: ["conversation"],
            scope: { groupId: "phase-eleven-other-group" },
            tags: ["typed_memory"],
            keywords: ["cobalt", "archive"],
            links: [],
            sections: {
              facts: { text: outOfScopeFact, updatedAt: "2026-07-12T00:00:00.000Z" },
            },
            version: 1,
          },
        });
        assert.equal(outOfScope.statusCode, 201, outOfScope.body);

        const firstGeneration = await generate(app, chat.id);
        assert.equal(firstGeneration.statusCode, 200, firstGeneration.body);
        const firstPayload = latestGenerationText(provider);
        assert.match(firstPayload, new RegExp(releaseFact));
        assert.doesNotMatch(firstPayload, new RegExp(outOfScopeFact));

        const receipt = await readLongTermMemoryInjectionReceipt(chat.id, root);
        assert.ok(receipt, "accepted provider dispatch should write a durable receipt");
        assert.ok(receipt.chunks.some((chunk) => chunk.noteId === "world_phase_eleven_archive"));
        assert.ok(receipt.serializedTokenCount > 0);
        assert.equal((await readLongTermMemoryUsage(root)).chats[chat.id]?.chunks[receipt.chunks[0]!.chunkId]?.injectionCount, 1);

        const lastInjection = await app.inject({
          method: "GET",
          url: `/api/long-term-memory/last-injection/${chat.id}`,
          remoteAddress: "127.0.0.1",
        });
        assert.equal(lastInjection.statusCode, 200, lastInjection.body);
        assert.equal(JSON.parse(lastInjection.body).memoryCount, 1);

        assert.equal(await copyLongTermMemoryBackupSnapshot(root, backupRoot), true);

        await app.close();
        app = await buildApp();
        const restartedGeneration = await generate(app, chat.id);
        assert.equal(restartedGeneration.statusCode, 200, restartedGeneration.body);
        assert.match(latestGenerationText(provider), new RegExp(releaseFact));
        assert.ok(await readLongTermMemoryInjectionReceipt(chat.id, root));

        const deleted = await app.inject({
          method: "DELETE",
          url: "/api/long-term-memory/notes/world_phase_eleven_archive/permanent",
          remoteAddress: "127.0.0.1",
        });
        assert.equal(deleted.statusCode, 200, deleted.body);
        assert.equal((await new LongTermMemoryStorage(root).getNote("world_phase_eleven_archive")), null);

        const deletedGeneration = await generate(app, chat.id);
        assert.equal(deletedGeneration.statusCode, 200, deletedGeneration.body);
        assert.doesNotMatch(latestGenerationText(provider), new RegExp(releaseFact));

        await app.close();
        app = null;
        const restored = await restoreLongTermMemoryBackup({
          root,
          stage: (stagingRoot) => cp(backupRoot, stagingRoot, { recursive: true, errorOnExist: true, force: false }),
          rebuildOptions: { localEmbedder: async (texts) => texts.map(() => []) },
        });
        assert.equal(restored.integrity.ok, true);
        assert.ok(await readLongTermMemoryInjectionReceipt(chat.id, root));

        app = await buildApp();
        const restoredGeneration = await generate(app, chat.id);
        assert.equal(restoredGeneration.statusCode, 200, restoredGeneration.body);
        assert.match(latestGenerationText(provider), new RegExp(releaseFact));
      } finally {
        if (app) await app.close();
      }
    });
  });
});

test("release readiness matrix writes no receipt when the provider rejects the fitted payload", async () => {
  await withRecordingProvider(async (provider) => {
    await withTestData(async (dataDir) => {
      const root = getLongTermMemoryRoot(dataDir);
      let app: Awaited<ReturnType<typeof buildApp>> | null = null;
      try {
        app = await buildApp();
        const connection = await createTestConnection(app, provider.baseUrl);
        const chat = await createEnabledConversation(app, connection.id, "phase-eleven-failure-group");
        const storage = new LongTermMemoryStorage(root);
        await storage.createNote(
          {
            id: "world_phase_eleven_dispatch_failure",
            type: "world",
            status: "active",
            modes: ["conversation"],
            scope: { groupId: "phase-eleven-failure-group" },
            tags: ["typed_memory"],
            keywords: ["dispatch", "failure"],
            links: [],
            sections: {
              facts: {
                text: "Provider rejection must not create a long-term-memory receipt.",
                updatedAt: "2026-07-12T00:00:00.000Z",
              },
            },
          },
          { suppressEvent: true },
        );
        await rebuildLongTermMemoryIndexes({ root, localEmbedder: async (texts) => texts.map(() => []) });

        provider.rejectGeneration = true;
        const response = await generate(app, chat.id, "Which dispatch failure needs release-readiness proof?");
        assert.equal(response.statusCode, 200, response.body);
        assert.match(latestGenerationText(provider), /Provider rejection must not create a long-term-memory receipt\./);
        assert.equal(await readLongTermMemoryInjectionReceipt(chat.id, root), null);
        assert.equal((await readLongTermMemoryUsage(root)).chats[chat.id], undefined);
      } finally {
        if (app) await app.close();
      }
    });
  });
});

test("release readiness matrix rejects unauthenticated remote LTM mutation before capture", async () => {
  await withTestData(async () => {
    let app: Awaited<ReturnType<typeof buildApp>> | null = null;
    try {
      app = await buildApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/long-term-memory/notes",
        remoteAddress: "10.0.0.1",
        payload: {
          id: "world_phase_eleven_remote_denied",
          type: "world",
          status: "active",
          modes: ["conversation"],
          scope: {},
          tags: [],
          links: [],
          sections: { facts: { text: "This write must be denied.", updatedAt: "2026-07-12T00:00:00.000Z" } },
        },
      });
      assert.equal(response.statusCode, 403, response.body);
    } finally {
      if (app) await app.close();
    }
  });
});
