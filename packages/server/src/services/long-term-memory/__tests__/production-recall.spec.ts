import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatMode } from "@marinara-engine/shared";
import { buildApp } from "../../../app.js";
import { createChatsStorage } from "../../storage/chats.storage.js";
import { createConnectionsStorage } from "../../storage/connections.storage.js";
import { createPromptsStorage } from "../../storage/prompts.storage.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import { LongTermMemoryStorage } from "../storage.js";
import { readLongTermMemoryInjectionReceipt } from "../usage.js";

type ProviderMessage = { role?: string; content?: string };

async function withTestApp(run: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-production-recall-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    app = await buildApp();
    await run(app);
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function withRecordingProvider(
  run: (baseUrl: string, requests: ProviderMessage[][]) => Promise<void>,
) {
  const requests: ProviderMessage[][] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");

      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: ProviderMessage[] };
      requests.push(body.messages ?? []);

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "phase-seven-provider-response",
          object: "chat.completion",
          created: 0,
          model: "phase-seven-model",
          choices: [{ index: 0, message: { role: "assistant", content: "Acknowledged." }, finish_reason: "stop" }],
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
    await run(`http://127.0.0.1:${address.port}/v1`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function createMarkerPreset(app: Awaited<ReturnType<typeof buildApp>>) {
  const prompts = createPromptsStorage(app.db);
  const preset = await prompts.create({ name: "Phase 7 LTM Marker", wrapFormat: "xml" });
  assert(preset);

  const system = await prompts.createSection({
    presetId: preset.id,
    identifier: "phase-seven-system",
    name: "System",
    content: "Phase seven prompt setup.",
    role: "system",
  });
  const ltm = await prompts.createSection({
    presetId: preset.id,
    identifier: "phase-seven-ltm",
    name: "Long-Term Memory",
    content: "",
    role: "system",
    isMarker: true,
    markerConfig: { type: "long_term_memory" },
  });
  const history = await prompts.createSection({
    presetId: preset.id,
    identifier: "phase-seven-history",
    name: "Chat History",
    content: "",
    role: "user",
    isMarker: true,
    markerConfig: { type: "chat_history" },
  });
  assert(system && ltm && history);

  await prompts.update(preset.id, { sectionOrder: [system.id, ltm.id, history.id] });
  return preset.id;
}

test("generation route dispatches LTM in every mode with and without a preset", async () => {
  await withRecordingProvider(async (baseUrl, providerRequests) => {
    await withTestApp(async (app) => {
      const connections = createConnectionsStorage(app.db);
      const connection = await connections.create({
        name: "Phase 7 provider",
        provider: "custom",
        baseUrl,
        apiKey: "",
        model: "phase-seven-model",
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

      const sharedGroupId = "phase-seven-recall-group";
      const storage = new LongTermMemoryStorage();
      await storage.createNote(
        {
          id: "world_phase_seven_observatory_key",
          type: "world",
          status: "active",
          modes: ["conversation", "roleplay", "game"],
          scope: { groupId: sharedGroupId },
          tags: ["typed_memory"],
          keywords: ["observatory", "key"],
          links: [],
          sections: {
            facts: {
              text: "Phase seven observatory key is hidden beneath the east clock.",
              updatedAt: "2026-07-12T00:00:00.000Z",
            },
          },
        },
        { suppressEvent: true },
      );
      await storage.createNote(
        {
          id: "world_phase_seven_other_group",
          type: "world",
          status: "active",
          modes: ["conversation", "roleplay", "game"],
          scope: { groupId: "other-group" },
          tags: ["typed_memory"],
          keywords: ["observatory", "key"],
          links: [],
          sections: {
            facts: {
              text: "Other group memory must not reach this provider payload.",
              updatedAt: "2026-07-12T00:00:00.000Z",
            },
          },
        },
        { suppressEvent: true },
      );
      await rebuildLongTermMemoryIndexes({ localEmbedder: async (texts) => texts.map(() => []) });

      const markerPresetId = await createMarkerPreset(app);
      const chats = createChatsStorage(app.db);
      const modes: ChatMode[] = ["conversation", "roleplay", "visual_novel", "game"];

      for (const mode of modes) {
        for (const preset of [false, true]) {
          const chat = await chats.create({
            name: `Phase 7 ${mode} ${preset ? "preset" : "fallback"}`,
            mode,
            characterIds: [],
            groupId: sharedGroupId,
            personaId: null,
            promptPresetId: preset ? markerPresetId : null,
            connectionId: connection.id,
          });
          assert(chat);
          await chats.patchMetadata(chat.id, {
            enableAgents: false,
            enableLongTermMemory: true,
            longTermMemoryBudgetTokens: 4096,
            longTermMemoryMaxChunks: 4,
            longTermMemoryScoreThreshold: 0,
          });

          const requestCount = providerRequests.length;
          const response = await app.inject({
            method: "POST",
            url: "/api/generate",
            remoteAddress: "127.0.0.1",
            payload: {
              chatId: chat.id,
              userMessage: "Where is the phase seven observatory key?",
              streaming: false,
            },
          });

          assert.equal(response.statusCode, 200, response.body);
          assert.equal(providerRequests.length, requestCount + 1, `${mode} ${preset ? "preset" : "fallback"}`);
          const providerPayload = providerRequests.at(-1) ?? [];
          const providerText = providerPayload.map((message) => message.content ?? "").join("\n");
          assert.match(providerText, /Phase seven observatory key is hidden beneath the east clock\./);
          assert.doesNotMatch(providerText, /Other group memory must not reach this provider payload\./);

          // Receipt creation is intentionally post-dispatch. Checking it here
          // proves the provider-visible final payload, not a helper-only plan.
          const receipt = await readLongTermMemoryInjectionReceipt(chat.id);
          assert.ok(receipt, `${mode} ${preset ? "preset" : "fallback"} dispatch should write a receipt`);
          assert.ok(receipt.chunks.some((chunk) => chunk.noteId === "world_phase_seven_observatory_key"));
        }
      }
    });
  });
});
