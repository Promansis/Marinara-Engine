import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../../lib/logger.js";
import {
  ltmDebugEventSchema,
  type LtmDebugEvent,
  type LtmDebugPhase,
  type LtmDebugStatus,
} from "@marinara-engine/shared";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot } from "./paths.js";

const MAX_DEBUG_LOG_BYTES = 2 * 1024 * 1024;
const MAX_DEBUG_EVENTS = 2_000;
const MAX_STRING_LENGTH = 4_000;
const MAX_ARRAY_ITEMS = 80;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 5;

type LtmDebugDetails = Record<string, unknown>;

export type LtmDebugEventInput = {
  operationId?: string;
  phase: LtmDebugPhase;
  action: string;
  status: LtmDebugStatus;
  message?: string;
  durationMs?: number;
  source?: string;
  sourceId?: string;
  sourceNoteId?: string;
  draftId?: string;
  noteId?: string;
  mutationIds?: string[];
  counts?: Record<string, number>;
  diagnostics?: Array<Record<string, unknown>>;
  provider?: string;
  model?: string;
  error?: unknown;
  details?: LtmDebugDetails;
  root?: string;
};

export type LtmDebugLogFilter = {
  limit?: number;
  operationId?: string;
  sourceNoteId?: string;
  draftId?: string;
  status?: LtmDebugStatus;
  phase?: LtmDebugPhase;
};

function capString(value: string, max = MAX_STRING_LENGTH) {
  return value.length > max ? `${value.slice(0, max)}... [truncated ${value.length - max} chars]` : value;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return capString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return "[truncated depth]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const sanitized = sanitizeValue(child, depth + 1);
      if (typeof sanitized !== "undefined") out[key] = sanitized;
    }
    return out;
  }
  return String(value);
}

export function serializeLtmDebugError(error: unknown): LtmDebugEvent["error"] {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown };
    return {
      name: capString(error.name || "Error", 120),
      message: capString(error.message || "Unknown error", 2_000),
      ...(error.stack ? { stack: capString(error.stack, 6_000) } : {}),
      ...(typeof record.code === "string" ? { code: capString(record.code, 120) } : {}),
    };
  }
  if (typeof error === "string") return { message: capString(error, 2_000) };
  return { message: capString(JSON.stringify(sanitizeValue(error)) || "Unknown error", 2_000) };
}

function sanitizeCounts(counts: Record<string, number> | undefined) {
  if (!counts) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts).slice(0, MAX_OBJECT_KEYS)) {
    if (Number.isFinite(value)) out[key] = Math.max(0, Math.trunc(value));
  }
  return Object.keys(out).length ? out : undefined;
}

function buildEvent(input: LtmDebugEventInput): LtmDebugEvent {
  return ltmDebugEventSchema.parse({
    id: randomUUID(),
    ts: new Date().toISOString(),
    operationId: input.operationId ?? randomUUID(),
    phase: input.phase,
    action: input.action,
    status: input.status,
    message: input.message ? capString(input.message, 2_000) : undefined,
    durationMs:
      typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
        ? Math.max(0, Math.trunc(input.durationMs))
        : undefined,
    source: input.source ? capString(input.source, 120) : undefined,
    sourceId: input.sourceId ? capString(input.sourceId, 240) : undefined,
    sourceNoteId: input.sourceNoteId,
    draftId: input.draftId,
    noteId: input.noteId,
    mutationIds: input.mutationIds?.slice(0, 100),
    counts: sanitizeCounts(input.counts),
    diagnostics: input.diagnostics
      ?.slice(0, MAX_ARRAY_ITEMS)
      .map((diagnostic) => sanitizeValue(diagnostic) as Record<string, unknown>),
    provider: input.provider ? capString(input.provider, 120) : undefined,
    model: input.model ? capString(input.model, 240) : undefined,
    error: input.error ? serializeLtmDebugError(input.error) : undefined,
    details: input.details ? (sanitizeValue(input.details) as Record<string, unknown>) : undefined,
  });
}

async function rotateIfNeeded(path: string) {
  const info = await stat(path).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  });
  if (!info || info.size < MAX_DEBUG_LOG_BYTES) return;
  const rotated = `${path}.1`;
  await unlink(rotated).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
  await rename(path, rotated);
}

export async function recordLtmDebugEvent(input: LtmDebugEventInput): Promise<LtmDebugEvent | null> {
  try {
    const root = input.root ?? getLongTermMemoryRoot();
    const path = getLongTermMemoryDirectories(root).debugLog;
    const event = buildEvent(input);
    await mkdir(dirname(path), { recursive: true });
    await rotateIfNeeded(path);
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  } catch (err) {
    logger.warn(err, "Failed to record LTM debug event");
    return null;
  }
}

export async function withLtmDebugOperation<T>(
  base: Omit<LtmDebugEventInput, "status" | "durationMs">,
  fn: (operationId: string) => Promise<T>,
): Promise<T> {
  const operationId = base.operationId ?? randomUUID();
  const started = Date.now();
  await recordLtmDebugEvent({ ...base, operationId, status: "started" });
  try {
    const result = await fn(operationId);
    await recordLtmDebugEvent({ ...base, operationId, status: "ok", durationMs: Date.now() - started });
    return result;
  } catch (err) {
    await recordLtmDebugEvent({
      ...base,
      operationId,
      status: "error",
      durationMs: Date.now() - started,
      error: err,
    });
    throw err;
  }
}

export async function readLtmDebugLog(filter: LtmDebugLogFilter = {}, root = getLongTermMemoryRoot()) {
  const path = getLongTermMemoryDirectories(root).debugLog;
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1_000);
  const content = await readFile(path, "utf8").catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    logger.warn(err, "Failed to read LTM debug log at %s", path);
    throw err;
  });
  const events: LtmDebugEvent[] = [];
  const lines = content.split("\n").filter(Boolean).slice(-MAX_DEBUG_EVENTS);
  for (const line of lines) {
    try {
      const event = ltmDebugEventSchema.parse(JSON.parse(line));
      if (filter.operationId && event.operationId !== filter.operationId) continue;
      if (filter.sourceNoteId && event.sourceNoteId !== filter.sourceNoteId) continue;
      if (filter.draftId && event.draftId !== filter.draftId) continue;
      if (filter.status && event.status !== filter.status) continue;
      if (filter.phase && event.phase !== filter.phase) continue;
      events.push(event);
    } catch {
      continue;
    }
  }
  return events
    .sort((left, right) => right.ts.localeCompare(left.ts) || right.id.localeCompare(left.id))
    .slice(0, limit);
}

export async function clearLtmDebugLog(root = getLongTermMemoryRoot()) {
  const path = getLongTermMemoryDirectories(root).debugLog;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", "utf8");
  return { cleared: true };
}

export async function exportLtmDebugLog(root = getLongTermMemoryRoot()) {
  const path = getLongTermMemoryDirectories(root).debugLog;
  return readFile(path, "utf8").catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    logger.warn(err, "Failed to export LTM debug log at %s", path);
    throw err;
  });
}
