import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ltmImportSourceNotesResponseSchema } from "@marinara-engine/shared";
import { buildApp } from "../../../app.js";
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

test("lorebook import includes every non-empty entry", async () => {
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

    const result = await createLongTermMemoryInteropSourceNotes(
      app.db,
      "lorebooks",
      { sourceIds: [bookId], limit: 1 },
      join(dataDir, "long-term-memory"),
    );
    assert.equal(result.imported.length, 1);
    const sourceText = result.imported[0]?.note.sections.source?.text ?? "";
    assert.match(sourceText, /Entry 1: Archive fact 1\./);
    assert.match(sourceText, /Entry 10: Archive fact 10\./);
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
    assert.equal(sourceNote.extracted, false);

    const response = await app.inject({
      method: "POST",
      url: `/api/long-term-memory/notes/${sourceNote.id}/extract`,
      remoteAddress: "127.0.0.1",
      payload: {},
    });

    assert.equal(response.statusCode, 200);
    assert.equal((await new LongTermMemoryStorage(root).getNote(sourceNote.id))?.extracted, true);
    const preview = await previewLongTermMemoryInterop(app.db, "chats", 100, root);
    assert.equal(preview.samples.find((sample) => sample.sourceId === `${chat.id}:game_journal`)?.status, "imported");
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
