// ──────────────────────────────────────────────
// LTM test harness
// ──────────────────────────────────────────────
// Shared fixture helpers for deterministic long-term-memory tests.
// Provides temp-root isolation, recording providers, note factories,
// and persisted-data helpers.
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  ltmNoteSchema,
  ltmNoteTypeSchema,
  type LtmNote,
  type LtmNoteType,
  type LtmScope,
  type LtmMode,
  type LtmExtractionResponse,
} from "@marinara-engine/shared";
import { LongTermMemoryStorage } from "../../storage.js";
import { LongTermMemoryDraftStore } from "../../draft-store.js";
import { getLongTermMemoryRoot } from "../../paths.js";

// ═══════════════════════════════════════════════
//  Temp-root helpers
// ═══════════════════════════════════════════════

export const REFERENCE_TS = "2026-07-14T00:00:00.000Z";

let tempCounter = 0;

export async function withTempRoot(run: (root: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), `marinara-ltm-test-${tempCounter++}-`));
  const previous = process.env.DATA_DIR;
  delete process.env.ADMIN_SECRET;
  try {
    process.env.DATA_DIR = dir;
    await run(getLongTermMemoryRoot(dir));
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

export async function withTempApp(
  run: (dataDir: string) => Promise<void>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), "marinara-ltm-app-"));
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

// ═══════════════════════════════════════════════
//  Recording provider
// ═══════════════════════════════════════════════

export interface ProviderCall {
  messages: Array<{ role?: string; content?: string }>;
  extraction: boolean;
}

export interface RecordingProvider {
  baseUrl: string;
  calls: ProviderCall[];
  rejectGeneration: boolean;
  rejectExtraction: boolean;
}

export async function withRecordingProvider(
  run: (provider: RecordingProvider) => Promise<void>,
) {
  const provider: RecordingProvider = {
    baseUrl: "",
    calls: [],
    rejectGeneration: false,
    rejectExtraction: false,
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: string }>;
        stream?: boolean;
      };
      const messages = body.messages ?? [];
      const extraction = JSON.stringify(body).includes("sourceText");
      provider.calls.push({ messages, extraction });

      if (extraction && provider.rejectExtraction) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "Recording provider extraction rejection." } }),
        );
        return;
      }
      if (!extraction && provider.rejectGeneration) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "Recording provider generation rejection." } }),
        );
        return;
      }

      const content = extraction
        ? JSON.stringify({
            summary: "One recorded extraction fact.",
            units: [
              {
                id: "550e8400-e29b-41d4-a716-446655440000",
                bucket: "world_fact",
                subjectId: "recorded_subject",
                sectionKey: "facts",
                text: "The recorded extraction yielded one durable fact.",
                importance: "critical",
                keywords: ["recorded", "fact"],
                evidence: ["source_note:source_recorded"],
                confidence: 0.98,
                salience: 0.98,
                status: "active",
                links: [],
                sourceHash: "a".repeat(64),
                subjectKeys: [],
              },
            ],
          })
        : "The provider accepted the recorded prompt.";

      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "recorded-req",
            object: "chat.completion.chunk",
            created: 0,
            model: "recorded-model",
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "recorded-req",
            object: "chat.completion.chunk",
            created: 0,
            model: "recorded-model",
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
          id: "recorded-req",
          object: "chat.completion",
          created: 0,
          model: "recorded-model",
          choices: [
            { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        }),
      );
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  });

  await listenServer(server);

  try {
    await run(provider);
  } finally {
    await closeServer(server);
  }
}

async function listenServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert(address && typeof address !== "string");
  const provider = (server as Server & { _provider?: RecordingProvider })._provider;
  if (!provider) throw new Error("Provider not attached");
  provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// ═══════════════════════════════════════════════
//  Deterministic note factories
// ═══════════════════════════════════════════════

export interface NoteInput {
  id: string;
  type: LtmNoteType;
  title?: string;
  status?: "active" | "resolved" | "archived";
  modes?: LtmMode[];
  scope?: LtmScope;
  tags?: string[];
  keywords?: string[];
  links?: Array<{ target: string; relation: string }>;
  sections?: Record<string, { text: string; updatedAt?: string }>;
  provenance?: Record<string, unknown> | null;
}

export function makeNote(input: NoteInput): LtmNote {
  return ltmNoteSchema.parse({
    id: input.id,
    type: input.type,
    title: input.title,
    status: input.status ?? "active",
    modes: input.modes ?? ["roleplay"],
    scope: input.scope ?? {},
    tags: input.tags ?? [],
    keywords: input.keywords ?? [],
    links: input.links ?? [],
    sections: input.sections ?? {},
    provenance: input.provenance ?? undefined,
    createdAt: REFERENCE_TS,
    updatedAt: REFERENCE_TS,
    version: 1,
  }) as LtmNote;
}

export function sourceNote(id: string, text: string, overrides?: Partial<NoteInput>): LtmNote {
  return makeNote({
    id,
    type: "source",
    tags: ["source_summary"],
    sections: {
      source: {
        text,
        updatedAt: REFERENCE_TS,
      },
    },
    ...overrides,
  });
}

export function worldNote(
  id: string,
  facts: string,
  overrides?: Partial<NoteInput>,
): LtmNote {
  return makeNote({
    id,
    type: "world",
    sections: { facts: { text: facts, updatedAt: REFERENCE_TS } },
    ...overrides,
  });
}

export function characterNote(
  id: string,
  facts: string,
  overrides?: Partial<NoteInput>,
): LtmNote {
  return makeNote({
    id,
    type: "character",
    sections: { facts: { text: facts, updatedAt: REFERENCE_TS } },
    ...overrides,
  });
}

// ═══════════════════════════════════════════════
//  Persisted-data helpers
// ═══════════════════════════════════════════════

export async function seedStorage(root: string, notes: LtmNote[]) {
  const storage = new LongTermMemoryStorage(root);
  for (const note of notes) {
    await storage.createNote(note);
  }
}

export async function seedDraft(
  root: string,
  draftInput: {
    id?: string;
    sourceNoteId: string;
    chatId?: string;
    mutations?: Array<Record<string, unknown>>;
    summary?: string;
    status?: string;
  },
) {
  const draftStore = new LongTermMemoryDraftStore(root);
  return draftStore.createDraft({
    scope: draftInput.chatId ? { chatId: draftInput.chatId } : {},
    modes: ["roleplay"],
    source: {
      sourceNoteId: draftInput.sourceNoteId,
      chatId: draftInput.chatId ?? "chat_default",
    },
    response: {
      summary: draftInput.summary ?? "Test draft",
      mutations:
        (draftInput.mutations as LtmExtractionResponse["mutations"]) ??
        ([
          {
            id: "550e8400-e29b-41d4-a716-446655440001",
            kind: "create_note",
            risk: "low",
            confidence: 0.95,
            evidence: [],
            summary: "Test mutation",
            note: {
              id: "note_draft_created",
              type: "world",
              status: "active",
              modes: ["roleplay"],
              scope: {},
              tags: [],
              keywords: [],
              links: [],
              sections: {
                facts: {
                  text: "Created from draft.",
                  updatedAt: REFERENCE_TS,
                },
              },
            },
          },
        ] as unknown[]),
    },
  });
}

export async function writeMalformedNote(
  root: string,
  notePath: string,
  content: string,
) {
  const { join } = await import("node:path");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const fullPath = join(root, notePath);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

export async function readStorageNotes(root: string) {
  const storage = new LongTermMemoryStorage(root);
  return storage.listNotes();
}
