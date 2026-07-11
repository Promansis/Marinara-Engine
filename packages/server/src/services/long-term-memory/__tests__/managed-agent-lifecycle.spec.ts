import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../../../app.js";
import { resolveAgentPipelineAgents } from "../../generation/agent-resolution.js";
import { createAgentsStorage } from "../../storage/agents.storage.js";

test("LTM managed agent remains a singleton and rejects generic removal or copies", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-managed-agent-"));
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
    const initial = (await app.inject({ method: "GET", url: "/api/agents" })).json() as Array<{
      id: string;
      type: string;
      enabled: string;
    }>;
    const managed = initial.find((agent) => agent.type === "long-term-memory");
    assert(managed, "startup should retain the managed LTM config row");

    const storage = createAgentsStorage(app.db);
    const directCreate = await storage.create({
      type: "long-term-memory",
      name: "Long-Term Memory (Copy)",
      description: "The lifecycle store must retain the existing managed row.",
      phase: "pre_generation",
      connectionId: null,
      imagePath: null,
      promptTemplate: "",
      settings: { longTermMemoryDebug: true },
    });
    assert.equal(directCreate?.id, managed.id);

    const update = await app.inject({
      method: "PATCH",
      url: `/api/agents/${managed.id}`,
      payload: { enabled: false, settings: { longTermMemoryDebug: true } },
    });
    assert.equal(update.statusCode, 200, update.body);
    assert.equal((update.json() as { enabled: string }).enabled, "true");

    const updateByType = await app.inject({
      method: "PATCH",
      url: "/api/agents/type/long-term-memory",
      payload: { settings: { longTermMemoryMaxChunks: 12 } },
    });
    assert.equal(updateByType.statusCode, 200, updateByType.body);
    assert.equal((updateByType.json() as { id: string }).id, managed.id);

    const duplicateInput = {
      name: "Long-Term Memory (Copy)",
      description: "A generic copy must not create another managed lifecycle row.",
      phase: "pre_generation",
      enabled: true,
      connectionId: null,
      imagePath: null,
      promptTemplate: "",
      settings: { longTermMemoryDebug: true },
    };
    const duplicateManaged = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { ...duplicateInput, type: "long-term-memory" },
    });
    assert.equal(duplicateManaged.statusCode, 409, duplicateManaged.body);

    const duplicateVariant = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { ...duplicateInput, type: "long-term-memory-copy" },
    });
    assert.equal(duplicateVariant.statusCode, 409, duplicateVariant.body);

    const deleteById = await app.inject({ method: "DELETE", url: `/api/agents/${managed.id}` });
    assert.equal(deleteById.statusCode, 403, deleteById.body);

    const deleteByType = await app.inject({ method: "DELETE", url: "/api/agents/long-term-memory" });
    assert.equal(deleteByType.statusCode, 403, deleteByType.body);

    const after = (await app.inject({ method: "GET", url: "/api/agents" })).json() as Array<{
      id: string;
      type: string;
      enabled: string;
    }>;
    const managedRows = after.filter((agent) => agent.type === "long-term-memory");
    assert.equal(managedRows.length, 1);
    assert.equal(managedRows[0]?.id, managed.id);
    assert.equal(managedRows[0]?.enabled, "true");
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

test("LTM managed agent is excluded from generic agent resolution", async () => {
  const result = await resolveAgentPipelineAgents({
    connections: {
      getWithKey: async () => null,
      getDefaultForAgents: async () => null,
    },
    configuredAgents: [
      {
        id: "managed:long-term-memory",
        type: "long-term-memory",
        name: "Long-Term Memory",
        phase: "pre_generation",
        connectionId: null,
        promptTemplate: "",
        settings: { longTermMemoryDebug: true },
      },
    ],
    chatId: "managed-agent-resolution",
    chatEnableAgents: true,
    hasPerChatAgentList: true,
    perChatAgentSet: new Set(["long-term-memory"]),
    agentPromptTemplateSelections: {},
    chatProvider: {} as never,
    chatModel: "unused",
    chatCustomParameters: {},
    chatMaxOutputTokens: null,
    chatMaxParallelJobs: 1,
    resolveBaseUrl: () => "",
  });

  assert.deepEqual(result.enabledConfigs, []);
  assert.deepEqual(result.resolvedAgents, []);
});
