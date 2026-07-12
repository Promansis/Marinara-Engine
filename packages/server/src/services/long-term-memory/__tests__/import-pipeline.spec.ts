import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ltmImportSourceNotesResponseSchema,
  type CharacterData,
  type LtmMode,
  type LtmSourceProvenance,
} from "@marinara-engine/shared";
import { buildApp } from "../../../app.js";
import type { BaseLLMProvider } from "../../llm/base-provider.js";
import {
  createLongTermMemoryInteropSourceNotes,
  previewLongTermMemoryInterop,
} from "../maintenance.js";
import { LongTermMemoryStorage } from "../storage.js";
import { createCharactersStorage } from "../../storage/characters.storage.js";
import { createChatsStorage } from "../../storage/chats.storage.js";
import { createLorebooksStorage } from "../../storage/lorebooks.storage.js";
import { createConnectionsStorage } from "../../storage/connections.storage.js";
import { sourceNoteIdForProvenance } from "../source-identity.js";
import { readLtmDebugLog } from "../debug-log.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import { applyLongTermMemoryDraft } from "../reconciliation.js";
import { extractLongTermMemoryFromSourceNote } from "../source-extraction.js";
import { extractionFingerprintForLtmSourceNote } from "../source-hash.js";
import { directIngestGameJournal } from "../direct-ingest.js";

async function withTestApp(run: (app: Awaited<ReturnType<typeof buildApp>>, dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-import-pipeline-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    app = await buildApp();
    await run(app, dataDir);
  } finally {
    if (app) await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
}

function rosterCharacter(name: string): CharacterData {
  return {
    name,
    description: `${name} is part of the canonical identity fixture.`,
    personality: "Observant and steady.",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    tags: [],
    creator: "",
    character_version: "1.0",
    alternate_greetings: [],
    extensions: {
      talkativeness: 0.5,
      fav: false,
      world: "",
      depth_prompt: { prompt: "", depth: 4, role: "system" },
      backstory: "",
      appearance: "",
    },
    character_book: null,
  };
}

async function withCanonicalImportProvider(
  run: (baseUrl: string, completionOrder: string[]) => Promise<void>,
) {
  const completionOrder: string[] = [];
  let receivedRequests = 0;
  let releaseResponses!: () => void;
  const allRequestsReceived = new Promise<void>((resolve) => {
    releaseResponses = resolve;
  });
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const userMessage = body.messages?.find((message) => message.role === "user")?.content;
      assert(userMessage);
      const payload = JSON.parse(userMessage) as {
        requiredEvidence: string[];
        sourceNote: { id: string; sourceHash: string };
        sourceText: string;
      };
      const common = {
        importance: "major",
        keywords: ["Damo Korvak", "Lisa Imai", "foundry reunion"],
        evidence: payload.requiredEvidence,
        confidence: 0.94,
        salience: 0.84,
        status: "active",
        sourceHash: payload.sourceNote.sourceHash,
      };

      let rangeId: string;
      let delayMs: number;
      let units: Array<Record<string, unknown>>;
      if (payload.sourceText.includes("kept the foundry vigil")) {
        rangeId = "range_one";
        delayMs = 90;
        units = [
          {
            ...common,
            id: randomUUID(),
            bucket: "timeline_event",
            subjectId: "foundry_reunion",
            subjectNames: [],
            sectionKey: "event",
            text: "Damo and Lisa reunited at the foundry after the long absence.",
            links: [],
          },
          {
            ...common,
            id: randomUUID(),
            bucket: "character_fact",
            subjectId: "damo",
            subjectNames: ["Damo"],
            sectionKey: "facts",
            text: "Damo meticulously documents every foundry vigil.",
            links: [],
          },
          {
            ...common,
            id: randomUUID(),
            bucket: "relationship_state",
            subjectId: "lisa_damo",
            subjectNames: ["Lisa", "Damo"],
            sectionKey: "state",
            text: "Lisa and Damo trust each other after their foundry reunion.",
            links: [{ target: "timeline_foundry_reunion", relation: "caused_by" }],
            dimensions: { trust: 70 },
            dimensionChanges: { trust: 5 },
          },
        ];
      } else if (payload.sourceText.includes("returned the silver key")) {
        rangeId = "range_two";
        delayMs = 45;
        units = [
          {
            ...common,
            id: randomUUID(),
            bucket: "timeline_event",
            subjectId: "silver_key_return",
            subjectNames: [],
            sectionKey: "event",
            text: "Lisa returned the silver key to Damo before dawn.",
            links: [],
          },
          {
            ...common,
            id: randomUUID(),
            bucket: "character_fact",
            subjectId: "damo_korvak",
            subjectNames: ["Damo"],
            sectionKey: "facts",
            text: "Damo bears a permanent silver key tattoo on his right wrist.",
            links: [],
          },
          {
            ...common,
            id: randomUUID(),
            bucket: "relationship_state",
            subjectId: "damo_lisa",
            subjectNames: ["Damo", "Lisa"],
            sectionKey: "state",
            text: "Damo and Lisa renewed their trust when Lisa returned the silver key.",
            links: [{ target: "timeline_silver_key_return", relation: "caused_by" }],
            dimensions: { trust: 76 },
            dimensionChanges: { trust: 6 },
          },
        ];
      } else {
        assert(payload.sourceText.includes("considerate nature"));
        rangeId = "range_three";
        delayMs = 0;
        units = [
          {
            ...common,
            id: randomUUID(),
            bucket: "character_fact",
            subjectId: "damo_considerate_nature",
            subjectNames: ["Damo"],
            sectionKey: "facts",
            text: "Damo's considerate nature shows when he returns borrowed equipment precisely.",
            links: [],
          },
          {
            ...common,
            id: randomUUID(),
            bucket: "character_fact",
            subjectId: "roselia_damo",
            sectionKey: "facts",
            text: "Roselia and Damo protected the archive together.",
            links: [],
          },
        ];
      }

      receivedRequests += 1;
      if (receivedRequests === 3) releaseResponses();
      await allRequestsReceived;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const content = JSON.stringify({ summary: `Canonical import ${rangeId}`, units });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        })}\n\n`,
      );
      completionOrder.push(rangeId);
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}/v1`, completionOrder);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

type StructuralRefineRequest = {
  systemPrompt: string;
  candidateUnits: Array<Record<string, unknown>>;
  requiredUnitFields: string[];
};

async function withStructuralRefineProvider(
  run: (baseUrl: string, requests: StructuralRefineRequest[]) => Promise<void>,
) {
  const requests: StructuralRefineRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: string }>;
        response_format?: {
          json_schema?: { schema?: { properties?: { units?: { items?: { required?: string[] } } } } };
        };
      };
      const systemPrompt = body.messages?.find((message) => message.role === "system")?.content;
      const userMessage = body.messages?.find((message) => message.role === "user")?.content;
      assert(systemPrompt);
      assert(userMessage);
      const payload = JSON.parse(userMessage) as { candidateUnits?: Array<Record<string, unknown>> };
      assert(payload.candidateUnits);
      requests.push({
        systemPrompt,
        candidateUnits: payload.candidateUnits,
        requiredUnitFields:
          body.response_format?.json_schema?.schema?.properties?.units?.items?.required ?? [],
      });

      const content = JSON.stringify({ summary: "Structural game refinement", units: payload.candidateUnits });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
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

test("import preflights the extraction connection before writing source notes", async () => {
  await withTestApp(async (app, dataDir) => {
    const character = await createCharactersStorage(app.db).create({
      name: "Mara",
      description: "A patient navigator who never abandons the crew.",
      personality: "Steady and observant.",
      scenario: "",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      tags: [],
      creator: "",
      character_version: "1.0",
      alternate_greetings: [],
      extensions: {
        talkativeness: 0.5,
        fav: false,
        world: "",
        depth_prompt: { prompt: "", depth: 4, role: "system" },
        backstory: "",
        appearance: "",
      },
      character_book: null,
    });
    assert(character);

    const response = await app.inject({
      method: "POST",
      url: "/api/long-term-memory/import/source-notes",
      remoteAddress: "127.0.0.1",
      payload: {
        source: "characters",
        sourceIds: [character.id],
        limit: 1,
        connectionId: "missing-connection",
      },
    });

    assert.equal(response.statusCode, 400);
    const notes = await new LongTermMemoryStorage(join(dataDir, "long-term-memory")).listNotes();
    assert.deepEqual(notes, []);

    const modelLessConnection = await createConnectionsStorage(app.db).create({
      name: "Missing model",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "",
      imagePath: null,
      maxContext: 128_000,
      isDefault: false,
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
      treatAsLocalEndpoint: false,
      claudeFastMode: false,
    });
    assert(modelLessConnection);
    const missingModel = await app.inject({
      method: "POST",
      url: "/api/long-term-memory/import/source-notes",
      remoteAddress: "127.0.0.1",
      payload: {
        source: "characters",
        sourceIds: [character.id],
        limit: 1,
        connectionId: modelLessConnection.id,
      },
    });
    assert.equal(missingModel.statusCode, 400);
    assert.deepEqual(await new LongTermMemoryStorage(join(dataDir, "long-term-memory")).listNotes(), []);
  });
});

test("lorebook import creates stable source units for every non-empty entry", async () => {
  await withTestApp(async (app, dataDir) => {
    const lorebooks = createLorebooksStorage(app.db);
    const book = await lorebooks.create({ name: "Archive", description: "Complete archive lore." });
    assert(book);
    const bookId = String((book as { id?: unknown }).id ?? "");
    assert(bookId);
    for (let index = 1; index <= 10; index += 1) {
      await lorebooks.createEntry({
        lorebookId: bookId,
        name: `Entry ${index}`,
        content: `Archive fact ${index}.`,
      });
    }

    const preview = await previewLongTermMemoryInterop(
      app.db,
      "lorebooks",
      100,
      join(dataDir, "long-term-memory"),
    );
    const entryRows = preview.samples.filter((sample) => sample.title.includes("Entry "));
    assert.equal(entryRows.length, 10);
    assert.equal(new Set(entryRows.map((sample) => sample.sourceId)).size, 10);

    const result = await createLongTermMemoryInteropSourceNotes(
      app.db,
      "lorebooks",
      { sourceIds: entryRows.map((sample) => sample.sourceId), limit: entryRows.length },
      join(dataDir, "long-term-memory"),
    );
    assert.equal(result.imported.length, 10);
    assert.deepEqual(
      result.imported.map((item) => item.note.sections.source?.text),
      Array.from({ length: 10 }, (_, index) => `Archive fact ${index + 1}.`),
    );
  });
});

test("large lorebook entries split deterministically below the 6,000-token source budget", async () => {
  await withTestApp(async (app, dataDir) => {
    const lorebooks = createLorebooksStorage(app.db);
    const book = await lorebooks.create({ name: "Long Archive" });
    assert(book);
    const bookId = String((book as { id?: unknown }).id ?? "");
    const content = `${"A".repeat(23_000)}\n\n${"B".repeat(2_500)}`;
    await lorebooks.createEntry({ lorebookId: bookId, name: "Long entry", content });

    const root = join(dataDir, "long-term-memory");
    const firstPreview = await previewLongTermMemoryInterop(app.db, "lorebooks", 100, root);
    const secondPreview = await previewLongTermMemoryInterop(app.db, "lorebooks", 100, root);
    const rows = firstPreview.samples.filter((sample) => sample.title.includes("Long entry"));
    assert.equal(rows.length, 2);
    assert.deepEqual(
      secondPreview.samples.filter((sample) => sample.title.includes("Long entry")).map((sample) => sample.sourceId),
      rows.map((sample) => sample.sourceId),
    );

    const imported = await createLongTermMemoryInteropSourceNotes(
      app.db,
      "lorebooks",
      { sourceIds: rows.map((sample) => sample.sourceId), limit: rows.length },
      root,
    );
    const sourceTexts = imported.imported.map((item) => item.note.sections.source?.text ?? "");
    assert(sourceTexts.every((text) => Math.ceil(text.length / 4) <= 6_000));
    assert.equal(sourceTexts.join("\n\n"), content);
  });
});

test("character source imports include durable card fields", async () => {
  await withTestApp(async (app, dataDir) => {
    const data = rosterCharacter("Mara");
    data.description = "A meticulous archivist.";
    data.personality = "Quietly decisive.";
    data.scenario = "The archive is under siege.";
    data.first_mes = "Keep your voice down.";
    data.mes_example = "<START>\nMara: The key stays with me.";
    data.creator_notes = "Preserve her exacting voice.";
    data.system_prompt = "Never break archive protocol.";
    data.post_history_instructions = "Prioritize continuity.";
    data.alternate_greetings = ["The stacks are closed."];
    data.extensions.backstory = "She inherited the archive from her mother.";
    data.extensions.appearance = "Silver hair and ink-stained hands.";
    const character = await createCharactersStorage(app.db).create(data);
    assert(character);

    const imported = await createLongTermMemoryInteropSourceNotes(
      app.db,
      "characters",
      { sourceIds: [character.id], limit: 1 },
      join(dataDir, "long-term-memory"),
    );
    const sourceText = imported.imported[0]?.note.sections.source?.text ?? "";
    for (const expected of [
      "Example messages",
      "Creator notes",
      "System prompt",
      "Post-history instructions",
      "Alternate greetings",
      "Backstory",
      "Appearance",
    ]) {
      assert.match(sourceText, new RegExp(expected));
    }
  });
});

test("renamed imported sources refresh their title and can become current again", async () => {
  await withTestApp(async (app, dataDir) => {
    const characters = createCharactersStorage(app.db);
    const character = await characters.create({
      ...rosterCharacter("Mara"),
      description: "A disciplined musician with meticulous rehearsal habits.",
    });
    assert(character);
    const root = join(dataDir, "long-term-memory");
    const storage = new LongTermMemoryStorage(root);
    const first = await createLongTermMemoryInteropSourceNotes(
      app.db,
      "characters",
      { sourceIds: [character.id], limit: 1 },
      root,
    );
    const firstNote = first.imported[0]?.note;
    assert(firstNote);
    await storage.updateNote(
      firstNote.id,
      { extractionFingerprint: extractionFingerprintForLtmSourceNote(firstNote, { extractionMode: "roleplay" }) },
      { suppressEvent: true },
    );
    assert.equal(
      (await previewLongTermMemoryInterop(app.db, "characters", 100, root)).samples[0]?.freshness,
      "current",
    );

    await characters.update(character.id, { name: "Roselia" }, undefined, { skipVersionSnapshot: true });
    const stale = await previewLongTermMemoryInterop(app.db, "characters", 100, root);
    assert.equal(stale.samples[0]?.freshness, "stale");
    assert.equal(stale.samples[0]?.title, "Roselia");

    const refreshed = await createLongTermMemoryInteropSourceNotes(
      app.db,
      "characters",
      { sourceIds: [character.id], limit: 1 },
      root,
    );
    const refreshedNote = refreshed.imported[0]?.note;
    assert(refreshedNote);
    assert.equal(refreshed.imported[0]?.created, false);
    assert.equal(refreshedNote.title, "Roselia");
    assert.equal(refreshedNote.extractionFingerprint, undefined);
    const currentNote = await storage.updateNote(
      refreshedNote.id,
      { extractionFingerprint: extractionFingerprintForLtmSourceNote(refreshedNote, { extractionMode: "roleplay" }) },
      { suppressEvent: true },
    );
    assert.equal(currentNote.title, "Roselia");
    const current = await previewLongTermMemoryInterop(app.db, "characters", 100, root);
    assert.equal(current.samples[0]?.freshness, "current");
    assert.equal(current.samples[0]?.existingNoteTitle, "Roselia");
  });
});

test("identical chat summaries remain distinct import candidates", async () => {
  await withTestApp(async (app, dataDir) => {
    const chats = createChatsStorage(app.db);
    const first = await chats.create({
      name: "First branch",
      mode: "roleplay",
      characterIds: [],
      groupId: null,
      personaId: null,
      promptPresetId: null,
      connectionId: null,
    });
    const second = await chats.create({
      name: "Second branch",
      mode: "roleplay",
      characterIds: [],
      groupId: null,
      personaId: null,
      promptPresetId: null,
      connectionId: null,
    });
    assert(first && second);
    const summaryEntry = {
      id: "shared_entry",
      kind: "rolling",
      origin: "manual",
      title: "Shared recap",
      content: "Mara returned the archive key to Jules.",
      enabled: true,
      sourceMode: "range",
      rangeStartIndex: 1,
      rangeEndIndex: 4,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    await chats.updateMetadata(first.id, { summaryEntries: [summaryEntry] });
    await chats.updateMetadata(second.id, { summaryEntries: [summaryEntry] });

    const preview = await previewLongTermMemoryInterop(
      app.db,
      "chats",
      100,
      join(dataDir, "long-term-memory"),
    );
    assert.deepEqual(
      new Set(preview.samples.map((sample) => sample.sourceId)),
      new Set([`${first.id}:shared_entry`, `${second.id}:shared_entry`]),
    );
  });
});

test("visual novel chat imports use the roleplay LTM lane", async () => {
  await withTestApp(async (app, dataDir) => {
    const chats = createChatsStorage(app.db);
    const chat = await chats.create({
      name: "Visual novel branch",
      mode: "visual_novel",
      characterIds: [],
      groupId: null,
      personaId: null,
      promptPresetId: null,
      connectionId: null,
    });
    assert(chat);
    await chats.updateMetadata(chat.id, {
      summaryEntries: [
        {
          id: "visual_novel_recap",
          kind: "rolling",
          origin: "manual",
          title: "Visual novel recap",
          content: "Mara returned the archive key before dawn.",
          enabled: true,
          sourceMode: "range",
          rangeStartIndex: 1,
          rangeEndIndex: 4,
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      ],
    });

    const result = await createLongTermMemoryInteropSourceNotes(
      app.db,
      "chats",
      { sourceIds: [`${chat.id}:visual_novel_recap`], limit: 1 },
      join(dataDir, "long-term-memory"),
    );

    assert.deepEqual(result.imported[0]?.note.modes, ["roleplay"]);
  });
});

test("source-visible character names resolve new NPCs for every LLM source and extraction mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-source-identities-"));
  const modes = ["conversation", "roleplay", "game"] as const satisfies readonly LtmMode[];
  const sources = [
    {
      kind: "chat_summary",
      title: "Chat recap",
      sourceText: "Roselia prefers quiet rehearsal rooms and keeps meticulous practice notes.",
      tags: ["source_summary", "imported_chat"],
      provenance: { kind: "chat_summary", sourceId: "chat_identity", entryId: "recap" },
    },
    {
      kind: "lorebook",
      title: "Lorebook - Roselia",
      sourceText: "Roselia has perfect pitch and follows a disciplined rehearsal routine.",
      tags: ["source_summary", "imported_lorebook"],
      provenance: { kind: "lorebook", sourceId: "lorebook_identity", entryId: "roselia" },
    },
    {
      kind: "character_card",
      title: "Roselia",
      sourceText: "A disciplined musician with perfect pitch and meticulous rehearsal habits.",
      tags: ["source_summary", "imported_character"],
      provenance: { kind: "character", sourceId: "character_identity" },
    },
    {
      kind: "manual",
      title: "Manual memory note",
      sourceText: "Roselia values precise arrangements and quiet preparation before a performance.",
      tags: ["source_summary"],
      provenance: undefined,
    },
  ] as const satisfies ReadonlyArray<{
    kind: string;
    title: string;
    sourceText: string;
    tags: readonly string[];
    provenance?: LtmSourceProvenance;
  }>;
  const requests: Array<{ sourceNoteId: string; title?: string; modes: LtmMode[]; sourceText: string }> = [];
  const provider = {
    maxTokensOverrideValue: undefined,
    chatComplete: async (messages: Array<{ role: string; content: string }>) => {
      const userMessage = messages.find((message) => message.role === "user")?.content;
      assert(userMessage);
      const payload = JSON.parse(userMessage) as {
        requiredEvidence: string[];
        sourceNote: { id: string; title?: string; sourceHash: string };
        sourceText: string;
        modes: LtmMode[];
        unitFields: { subjectNames?: string };
      };
      assert.match(payload.unitFields.subjectNames ?? "", /source-visible character name/i);
      requests.push({
        sourceNoteId: payload.sourceNote.id,
        title: payload.sourceNote.title,
        modes: payload.modes,
        sourceText: payload.sourceText,
      });
      return {
        content: JSON.stringify({
          summary: "Roselia identity fact",
          units: [
            {
              id: randomUUID(),
              bucket: "character_fact",
              subjectId: "roselia",
              subjectNames: ["Roselia"],
              sectionKey: "facts",
              text: payload.sourceText,
              importance: "major",
              keywords: ["Roselia", "rehearsal"],
              evidence: payload.requiredEvidence,
              confidence: 0.95,
              salience: 0.8,
              status: "active",
              links: [],
              sourceHash: payload.sourceNote.sourceHash,
            },
          ],
        }),
      };
    },
  } as unknown as BaseLLMProvider;

  try {
    const storage = new LongTermMemoryStorage(root);
    for (const source of sources) {
      for (const mode of modes) {
        const noteId = `source_identity_${source.kind}_${mode}`;
        const chatId = `chat_identity_${source.kind}_${mode}`;
        await storage.createNote(
          {
            id: noteId,
            title: source.title,
            type: "source",
            status: "active",
            modes: [mode],
            scope: { chatId, chatIds: [chatId] },
            tags: [...source.tags],
            keywords: [],
            links: [],
            ...(source.provenance ? { provenance: source.provenance } : {}),
            sections: {
              source: {
                text: source.sourceText,
                updatedAt: "2026-07-12T00:00:00.000Z",
                evidence: [`source_fixture:${source.kind}`, `chat:${chatId}`],
              },
            },
          },
          { suppressEvent: true },
        );

        const result = await extractLongTermMemoryFromSourceNote({
          noteId,
          provider,
          model: "test-model",
          root,
          mode,
          trustedSubjectCatalog: { entries: [], notes: [] },
          persistDraft: false,
          embeddingSource: {
            label: "test",
            embed: async (texts) => texts.map(() => []),
          },
        });
        const create = result.response.mutations.find(
          (mutation) => mutation.kind === "create_note" && mutation.note.id === "char_roselia",
        );
        assert(create && create.kind === "create_note", `${source.kind}/${mode} did not create char_roselia`);
        assert.equal(result.extractionMode, mode);
        assert.equal(create.note.title, "Roselia");
        assert.deepEqual(create.note.subjects, [{ key: "npc:roselia" }]);
        assert.equal(create.risk, "medium");
      }
    }

    assert.equal(requests.length, sources.length * modes.length);
    assert.deepEqual(new Set(requests.flatMap((request) => request.modes)), new Set(modes));
    const cardRequests = requests.filter((request) => request.sourceNoteId.includes("character_card"));
    assert.equal(cardRequests.length, modes.length);
    assert(cardRequests.every((request) => request.title === "Roselia"));
    assert(cardRequests.every((request) => !request.sourceText.includes("Roselia")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct game refinement preserves structural character and relationship identities", async () => {
  await withStructuralRefineProvider(async (baseUrl, requests) => {
    await withTestApp(async (app, dataDir) => {
      const connection = await createConnectionsStorage(app.db).create({
        name: "Structural game refine loopback",
        provider: "openai",
        baseUrl,
        apiKey: "local-test-key",
        model: "test-model",
        imagePath: null,
        maxContext: 128_000,
        isDefault: false,
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
      const chats = createChatsStorage(app.db);
      const chat = await chats.create({
        name: "Structural game refine fixture",
        mode: "game",
        characterIds: [],
        groupId: null,
        personaId: null,
        promptPresetId: null,
        connectionId: connection.id,
      });
      assert(chat);
      await chats.updateMetadata(chat.id, {
        gamePreviousSessionSummaries: [
          {
            sessionNumber: 1,
            summary: "Mirelle reinforced the archive gate before the siege.",
            resumePoint: "The party regrouped inside the secured archive.",
            partyDynamics: "The party trusted each other after defending the gate together.",
            partyState: "The archive remains secure.",
            keyDiscoveries: ["The gate can be reinforced from inside."],
            characterMoments: [],
            littleDetails: [],
            statsSnapshot: {},
            npcUpdates: ["Mirelle: permanently took command of the archive guard."],
            timestamp: "2026-07-12T00:00:00.000Z",
          },
        ],
      });

      const root = join(dataDir, "long-term-memory");
      const imported = await createLongTermMemoryInteropSourceNotes(
        app.db,
        "chats",
        { sourceIds: [`${chat.id}:game_journal`], limit: 1 },
        root,
      );
      const sourceNote = imported.imported[0]?.note;
      assert(sourceNote);
      const result = await directIngestGameJournal(app.db, sourceNote, root, randomUUID(), {
        refinePass: true,
        persistDraft: false,
      });

      assert.equal(requests.length, 1);
      const request = requests[0]!;
      assert.match(request.systemPrompt, /Preserve character_fact and relationship_state subjectId values/);
      assert.match(request.systemPrompt, /Never add subjectNames or choose database subject keys/);
      assert.equal(request.requiredUnitFields.includes("subjectNames"), false);
      assert(request.candidateUnits.some((unit) => unit.bucket === "character_fact" && unit.subjectId === "npc_mirelle"));
      assert(request.candidateUnits.some((unit) => unit.bucket === "relationship_state" && unit.subjectId === "party"));
      assert(
        result.response.mutations.some(
          (mutation) => mutation.kind === "create_note" && mutation.note.id === "char_npc_mirelle",
        ),
      );
      assert(
        result.response.mutations.some(
          (mutation) => mutation.kind === "create_note" && mutation.note.id === "rel_party",
        ),
      );
      assert.equal(result.response.summary, "Structural game refinement");
    });
  });
});

test("manual source extraction persists successful retry state", async () => {
  await withTestApp(async (app, dataDir) => {
    const chats = createChatsStorage(app.db);
    const chat = await chats.create({
      name: "Retryable game import",
      mode: "game",
      characterIds: [],
      groupId: null,
      personaId: null,
      promptPresetId: null,
      connectionId: null,
    });
    assert(chat);
    await chats.updateMetadata(chat.id, {
      gamePreviousSessionSummaries: [
        {
          sessionNumber: 1,
          summary: "The party recovered the archive key.",
          resumePoint: "Outside the archive at dawn.",
          partyDynamics: "The party worked together without conflict.",
          partyState: "Everyone is ready to continue.",
          keyDiscoveries: ["Archive key"],
          characterMoments: [],
          littleDetails: [],
          statsSnapshot: {},
          npcUpdates: [],
          timestamp: "2026-07-10T00:00:00.000Z",
        },
      ],
    });
    const root = join(dataDir, "long-term-memory");
    const imported = await createLongTermMemoryInteropSourceNotes(
      app.db,
      "chats",
      { sourceIds: [`${chat.id}:game_journal`], limit: 1 },
      root,
    );
    const sourceNote = imported.imported[0]?.note;
    assert(sourceNote);
    assert.equal(sourceNote.extractionFingerprint, undefined);

    const response = await app.inject({
      method: "POST",
      url: `/api/long-term-memory/notes/${sourceNote.id}/extract`,
      remoteAddress: "127.0.0.1",
      payload: {},
    });

    assert.equal(response.statusCode, 200);
    const extraction = response.json() as { operationId: string };
    const events = await readLtmDebugLog({ operationId: extraction.operationId, limit: 1_000 }, root);
    assert.equal(events.some((event) => event.action === "evidence_unit_request"), false);
    assert.equal(events.some((event) => event.action === "direct_ingest_completed"), true);
    assert((await new LongTermMemoryStorage(root).getNote(sourceNote.id))?.extractionFingerprint);
    const preview = await previewLongTermMemoryInterop(app.db, "chats", 100, root);
    const currentSample = preview.samples.find((sample) => sample.sourceId === `${chat.id}:game_journal`);
    assert.equal(currentSample?.status, "imported");
    assert.equal(currentSample?.freshness, "current");

    await chats.updateMetadata(chat.id, {
      gamePreviousSessionSummaries: [
        {
          sessionNumber: 1,
          summary: "The party recovered the archive key and mapped the sealed annex.",
          resumePoint: "Outside the archive at dawn.",
          partyDynamics: "The party worked together without conflict.",
          partyState: "Everyone is ready to continue.",
          keyDiscoveries: ["Archive key", "Sealed annex"],
          characterMoments: [],
          littleDetails: [],
          statsSnapshot: {},
          npcUpdates: [],
          timestamp: "2026-07-11T00:00:00.000Z",
        },
      ],
    });
    const stalePreview = await previewLongTermMemoryInterop(app.db, "chats", 100, root);
    const staleSample = stalePreview.samples.find((sample) => sample.sourceId === `${chat.id}:game_journal`);
    assert.equal(staleSample?.status, "pending");
    assert.equal(staleSample?.freshness, "stale");
  });
});

test("direct game extraction persists a diagnostic-only draft when every candidate is rejected", async () => {
  await withTestApp(async (app, dataDir) => {
    const chats = createChatsStorage(app.db);
    const chat = await chats.create({
      name: "Diagnostic-only game import",
      mode: "game",
      characterIds: [],
      groupId: null,
      personaId: null,
      promptPresetId: null,
      connectionId: null,
    });
    assert(chat);
    await chats.updateMetadata(chat.id, {
      gamePreviousSessionSummaries: [
        {
          sessionNumber: 1,
          summary: "",
          resumePoint: "",
          partyDynamics: "Tension between Alice and Bob softened after they solved the puzzle.",
          partyState: "",
          keyDiscoveries: [],
          characterMoments: [],
          littleDetails: [],
          statsSnapshot: {},
          npcUpdates: [],
          timestamp: "2026-07-11T00:00:00.000Z",
        },
      ],
    });
    const root = join(dataDir, "long-term-memory");
    const imported = await createLongTermMemoryInteropSourceNotes(
      app.db,
      "chats",
      { sourceIds: [`${chat.id}:game_journal`], limit: 1 },
      root,
    );
    const sourceNote = imported.imported[0]?.note;
    assert(sourceNote);

    const response = await app.inject({
      method: "POST",
      url: `/api/long-term-memory/notes/${sourceNote.id}/extract`,
      remoteAddress: "127.0.0.1",
      payload: {},
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert(body.draft);
    assert.deepEqual(body.draft.mutations, []);
    assert.equal(body.accounting.keptUnits, 0);
    assert.equal(body.accounting.validationRejections, 1);
    assert(
      body.diagnostics.some(
        (diagnostic: { code?: string }) => diagnostic.code === "candidate_dropped_unsupported_bucket",
      ),
    );
    assert.equal((await new LongTermMemoryStorage(root).getNote(sourceNote.id))?.extractionFingerprint, undefined);
  });
});

test("post-preflight extraction failure is reported as retryable per source", async () => {
  await withTestApp(async (app) => {
    const character = await createCharactersStorage(app.db).create({
      name: "Jules",
      description: "An archivist who protects the tower key.",
      personality: "Careful and candid.",
      scenario: "",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      tags: [],
      creator: "",
      character_version: "1.0",
      alternate_greetings: [],
      extensions: {
        talkativeness: 0.5,
        fav: false,
        world: "",
        depth_prompt: { prompt: "", depth: 4, role: "system" },
        backstory: "",
        appearance: "",
      },
      character_book: null,
    });
    assert(character);
    const connection = await createConnectionsStorage(app.db).create({
      name: "Unavailable test provider",
      provider: "openai",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "test-key",
      model: "test-model",
      imagePath: null,
      maxContext: 128_000,
      isDefault: false,
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
      treatAsLocalEndpoint: false,
      claudeFastMode: false,
    });
    assert(connection);

    const response = await app.inject({
      method: "POST",
      url: "/api/long-term-memory/import/source-notes",
      remoteAddress: "127.0.0.1",
      payload: {
        source: "characters",
        sourceIds: [character.id],
        limit: 1,
        connectionId: connection.id,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(ltmImportSourceNotesResponseSchema.safeParse(body).success, true);
    assert.equal(body.batchStatus, "failed");
    assert.equal(body.imported[0]?.sourceWriteStatus, "created");
    assert.equal(body.imported[0]?.extractionStatus, "failed");
    assert.equal(body.imported[0]?.retryable, true);
    assert.equal(body.imported[0]?.error?.code, "extract_failed");

    const failedPreview = await previewLongTermMemoryInterop(app.db, "characters", 100);
    assert.equal(failedPreview.samples.find((sample) => sample.sourceId === character.id)?.status, "pending");

    const retry = await app.inject({
      method: "POST",
      url: "/api/long-term-memory/import/source-notes",
      remoteAddress: "127.0.0.1",
      payload: {
        source: "characters",
        sourceIds: [character.id],
        limit: 1,
        connectionId: connection.id,
      },
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().imported[0]?.sourceWriteStatus, "refreshed");
    assert.equal((await new LongTermMemoryStorage().listNotes({ type: "source" })).length, 1);
  });
});

test("source write failures are isolated and returned with retry metadata", async () => {
  await withTestApp(async (app, dataDir) => {
    const character = await createCharactersStorage(app.db).create({
      name: "Blocked source",
      description: "A source whose target path cannot be written.",
      personality: "",
      scenario: "",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      tags: [],
      creator: "",
      character_version: "1.0",
      alternate_greetings: [],
      extensions: {
        talkativeness: 0.5,
        fav: false,
        world: "",
        depth_prompt: { prompt: "", depth: 4, role: "system" },
        backstory: "",
        appearance: "",
      },
      character_book: null,
    });
    assert(character);
    const root = join(dataDir, "long-term-memory");
    const noteId = sourceNoteIdForProvenance({ kind: "character", sourceId: character.id });
    await mkdir(join(root, "vault", "sources"), { recursive: true });
    await writeFile(join(root, "vault", "sources", `${noteId}.json`), "{malformed", "utf8");

    const result = await createLongTermMemoryInteropSourceNotes(
      app.db,
      "characters",
      { sourceIds: [character.id], limit: 1 },
      root,
    );
    assert.equal(result.imported.length, 0);
    assert.deepEqual(result.writeFailures.map((failure) => ({
      sourceId: failure.sourceId,
      sourceWriteStatus: failure.sourceWriteStatus,
      extractionStatus: failure.extractionStatus,
      retryable: failure.retryable,
      code: failure.error.code,
    })), [{
      sourceId: character.id,
      sourceWriteStatus: "failed",
      extractionStatus: "not_started",
      retryable: true,
      code: "source_write_failed",
    }]);
  });
});

test("multi-source direct import publishes one rebuild for the completed batch", async () => {
  await withTestApp(async (app, dataDir) => {
    const chats = createChatsStorage(app.db);
    const sourceIds: string[] = [];
    for (const [index, discovery] of ["Archive key", "Moonlit map"].entries()) {
      const chat = await chats.create({
        name: `Batch game ${index + 1}`,
        mode: "game",
        characterIds: [],
        groupId: null,
        personaId: null,
        promptPresetId: null,
        connectionId: null,
      });
      assert(chat);
      await chats.updateMetadata(chat.id, {
        gamePreviousSessionSummaries: [
          {
            sessionNumber: 1,
            summary: `The party recovered the ${discovery.toLocaleLowerCase()}.`,
            resumePoint: "Outside the archive at dawn.",
            partyDynamics: "The party worked together without conflict.",
            partyState: "Everyone is ready to continue.",
            keyDiscoveries: [discovery],
            characterMoments: [],
            littleDetails: [],
            statsSnapshot: {},
            npcUpdates: [],
            timestamp: `2026-07-1${index}T00:00:00.000Z`,
          },
        ],
      });
      sourceIds.push(`${chat.id}:game_journal`);
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/long-term-memory/import/source-notes",
      remoteAddress: "127.0.0.1",
      payload: {
        source: "chats",
        sourceIds,
        limit: sourceIds.length,
        importConcurrency: 2,
        applyLowRisk: true,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = ltmImportSourceNotesResponseSchema.parse(response.json());
    assert.equal(body.batchStatus, "success");
    assert.equal(body.counts.succeeded, 2);
    const events = await readLtmDebugLog(
      { operationId: body.operationId, limit: 1_000 },
      join(dataDir, "long-term-memory"),
    );
    assert.equal(events.filter((event) => event.action === "import_batch_rebuild").length, 1);
    assert.equal(events.filter((event) => event.action === "apply_rebuild_indexes").length, 0);
  });
});

test("three chat summary ranges converge on canonical subjects regardless of provider completion order", async () => {
  await withCanonicalImportProvider(async (baseUrl, completionOrder) => {
    await withTestApp(async (app, dataDir) => {
      const characters = createCharactersStorage(app.db);
      const lisa = await characters.create(rosterCharacter("Lisa Imai"));
      const roselia = await characters.create(rosterCharacter("Roselia"));
      const damo = await characters.createPersona("Damo Korvak", "A considerate field researcher.");
      assert(lisa && roselia && damo);

      const chats = createChatsStorage(app.db);
      const chat = await chats.create({
        name: "Canonical import fixture",
        mode: "roleplay",
        characterIds: [lisa.id, roselia.id],
        groupId: null,
        personaId: damo.id,
        promptPresetId: null,
        connectionId: null,
      });
      assert(chat);
      const rangeIds = ["range_one", "range_two", "range_three"];
      await chats.updateMetadata(chat.id, {
        summaryEntries: [
          {
            id: rangeIds[0],
            kind: "rolling",
            origin: "manual",
            title: "Foundry reunion",
            content:
              "Damo kept the foundry vigil until Lisa arrived, and their trust began to recover. Damo meticulously documents every foundry vigil.",
            enabled: true,
            sourceMode: "range",
            rangeStartIndex: 1,
            rangeEndIndex: 12,
            createdAt: "2026-07-11T00:00:00.000Z",
            updatedAt: "2026-07-11T00:00:00.000Z",
          },
          {
            id: rangeIds[1],
            kind: "rolling",
            origin: "manual",
            title: "Silver key",
            content:
              "Lisa returned the silver key to Damo before dawn, renewing their trust. Damo bears a permanent silver key tattoo on his right wrist.",
            enabled: true,
            sourceMode: "range",
            rangeStartIndex: 13,
            rangeEndIndex: 24,
            createdAt: "2026-07-11T00:01:00.000Z",
            updatedAt: "2026-07-11T00:01:00.000Z",
          },
          {
            id: rangeIds[2],
            kind: "rolling",
            origin: "manual",
            title: "Borrowed equipment",
            content: "Damo's considerate nature showed in how he returned borrowed equipment; Roselia also helped him.",
            enabled: true,
            sourceMode: "range",
            rangeStartIndex: 25,
            rangeEndIndex: 36,
            createdAt: "2026-07-11T00:02:00.000Z",
            updatedAt: "2026-07-11T00:02:00.000Z",
          },
        ],
      });

      const connection = await createConnectionsStorage(app.db).create({
        name: "Canonical import loopback",
        provider: "openai",
        baseUrl,
        apiKey: "local-test-key",
        model: "test-model",
        imagePath: null,
        maxContext: 128_000,
        isDefault: false,
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
        maxParallelJobs: 3,
        treatAsLocalEndpoint: true,
        claudeFastMode: false,
      });
      assert(connection);
      const sourceIds = rangeIds.map((rangeId) => `${chat.id}:${rangeId}`);
      const response = await app.inject({
        method: "POST",
        url: "/api/long-term-memory/import/source-notes",
        remoteAddress: "127.0.0.1",
        payload: {
          source: "chats",
          sourceIds,
          limit: sourceIds.length,
          connectionId: connection.id,
          importConcurrency: 3,
          applyLowRisk: true,
        },
      });

      assert.equal(response.statusCode, 200, response.body);
      const body = ltmImportSourceNotesResponseSchema.parse(response.json());
      assert.equal(body.batchStatus, "success");
      assert.deepEqual(body.imported.map((item) => item.sourceId), sourceIds);
      assert.deepEqual(completionOrder, ["range_three", "range_two", "range_one"]);
      for (const item of body.imported) {
        assert.equal(item.extractionStatus, "succeeded");
        assert.equal(
          item.accounting.providerCandidates + item.accounting.normalizedAdditions,
          item.accounting.parserRejections +
            item.accounting.validationRejections +
            item.accounting.deduplications +
            item.accounting.keptUnits,
        );
      }
      const root = join(dataDir, "long-term-memory");
      for (const item of body.imported.slice(0, 2)) {
        assert.equal(item.diagnostics.some((diagnostic) => diagnostic.severity === "error"), false);
      }
      const pendingDrafts = body.imported.flatMap((item) =>
        item.draft?.status === "pending" ? [item.draft] : [],
      );
      assert.equal(pendingDrafts.length, 2);
      for (const draft of pendingDrafts) {
        const accepted = await applyLongTermMemoryDraft(draft.id, { root, rebuildIndexes: false });
        assert(accepted.appliedMutationIds.length > 0);
      }
      await rebuildLongTermMemoryIndexes({ root });

      const storage = new LongTermMemoryStorage(root);
      const notes = await storage.listNotes();
      const characterNotes = notes.filter((note) => note.type === "character");
      assert.equal(characterNotes.length, 1);
      const damoNote = characterNotes[0]!;
      assert.equal(damoNote.id, "char_damo_korvak");
      assert.deepEqual(damoNote.subjects, [
        { key: `persona:${damo.id}`, ref: { kind: "persona", id: damo.id } },
      ]);
      assert.match(damoNote.sections.facts?.text ?? "", /meticulously documents every foundry vigil/);
      assert.match(damoNote.sections.facts?.text ?? "", /permanent silver key tattoo/);
      assert.match(damoNote.sections.facts?.text ?? "", /considerate nature/);
      assert.equal(characterNotes.some((note) => note.id.includes("considerate_nature")), false);

      const relationships = notes.filter((note) => note.type === "relationship");
      assert.equal(relationships.length, 1);
      assert.equal(relationships[0]?.id, "rel_damo_korvak_lisa_imai");
      assert.deepEqual(relationships[0]?.subjects, [
        { key: `character:${lisa.id}`, ref: { kind: "character", id: lisa.id } },
        { key: `persona:${damo.id}`, ref: { kind: "persona", id: damo.id } },
      ]);

      const warnedImport = body.imported.find((item) => item.sourceId.endsWith(":range_three"));
      assert(warnedImport?.draft);
      assert.equal(
        warnedImport.diagnostics.some((diagnostic) => diagnostic.code === "composite_character_subject"),
        true,
      );
      const persistedDraft = await new LongTermMemoryDraftStore(root).getDraft(warnedImport.draft.id);
      assert.equal(persistedDraft?.operationId, body.operationId);
      assert.equal(
        persistedDraft?.diagnostics?.some((diagnostic) => diagnostic.code === "composite_character_subject"),
        true,
      );

      const events = await readLtmDebugLog({ operationId: body.operationId, limit: 1_000 }, root);
      assert.equal(events.filter((event) => event.action === "import_batch_rebuild").length, 1);
      assert.equal(events.filter((event) => event.action === "apply_rebuild_indexes").length, 0);
      const finalizedDraftEvents = events.filter((event) => event.phase === "draft" && event.action === "draft_created");
      assert.equal(finalizedDraftEvents.length, body.imported.length);
      assert(finalizedDraftEvents.every((event) => event.draftId));
      assert(finalizedDraftEvents.every((event) => typeof event.counts?.mutations === "number"));

      const statusResponse = await app.inject({
        method: "GET",
        url: "/api/long-term-memory/status",
        remoteAddress: "127.0.0.1",
      });
      assert.equal(statusResponse.statusCode, 200, statusResponse.body);
      const status = statusResponse.json();
      assert.equal(status.indexes.health, "healthy");
      assert.equal(status.indexes.dirty, false);
      assert.equal(status.indexes.noteCount, notes.length);
    });
  });
});
