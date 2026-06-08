import type { LtmScope } from "@marinara-engine/shared";
import type { LtmMemoryChunk } from "./chunking.js";

export interface LtmMetadataIndex {
  version: 1;
  chunks: Record<string, LtmMemoryChunk>;
  byNoteId: Record<string, string[]>;
  byType: Record<string, string[]>;
  byStatus: Record<string, string[]>;
  byTag: Record<string, string[]>;
  byScope: {
    universe: Record<string, string[]>;
    rpId: Record<string, string[]>;
    chatId: Record<string, string[]>;
    groupId: Record<string, string[]>;
    characterId: Record<string, string[]>;
  };
}

function addToBucket(index: Record<string, string[]>, key: string | undefined, chunkId: string) {
  if (!key) return;
  const bucket = index[key] ?? [];
  bucket.push(chunkId);
  index[key] = bucket;
}

function sortRecordBuckets(record: Record<string, string[]>) {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, values]) => [key, values.sort((a, b) => a.localeCompare(b))]),
  );
}

export function buildLtmMetadataIndex(chunks: LtmMemoryChunk[]): LtmMetadataIndex {
  const index: LtmMetadataIndex = {
    version: 1,
    chunks: {},
    byNoteId: {},
    byType: {},
    byStatus: {},
    byTag: {},
    byScope: {
      universe: {},
      rpId: {},
      chatId: {},
      groupId: {},
      characterId: {},
    },
  };

  for (const chunk of chunks.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    index.chunks[chunk.id] = chunk;
    addToBucket(index.byNoteId, chunk.noteId, chunk.id);
    addToBucket(index.byType, chunk.noteType, chunk.id);
    addToBucket(index.byStatus, chunk.status, chunk.id);
    for (const tag of chunk.tags) addToBucket(index.byTag, tag, chunk.id);
    addToBucket(index.byScope.universe, chunk.scope.universe, chunk.id);
    addToBucket(index.byScope.rpId, chunk.scope.rpId, chunk.id);
    addToBucket(index.byScope.chatId, chunk.scope.chatId, chunk.id);
    addToBucket(index.byScope.groupId, chunk.scope.groupId, chunk.id);
    for (const characterId of chunk.scope.characterIds ?? []) {
      addToBucket(index.byScope.characterId, characterId, chunk.id);
    }
  }

  return {
    ...index,
    chunks: Object.fromEntries(Object.entries(index.chunks).sort(([a], [b]) => a.localeCompare(b))),
    byNoteId: sortRecordBuckets(index.byNoteId),
    byType: sortRecordBuckets(index.byType),
    byStatus: sortRecordBuckets(index.byStatus),
    byTag: sortRecordBuckets(index.byTag),
    byScope: {
      universe: sortRecordBuckets(index.byScope.universe),
      rpId: sortRecordBuckets(index.byScope.rpId),
      chatId: sortRecordBuckets(index.byScope.chatId),
      groupId: sortRecordBuckets(index.byScope.groupId),
      characterId: sortRecordBuckets(index.byScope.characterId),
    },
  };
}

export function getLtmMetadataMatches(
  index: LtmMetadataIndex,
  query: { noteIds?: string[]; tags?: string[]; scope?: LtmScope; characterIds?: string[] },
) {
  const scores = new Map<string, { score: number; reasons: string[] }>();

  function add(chunkId: string, score: number, reason: string) {
    const existing = scores.get(chunkId) ?? { score: 0, reasons: [] };
    existing.score += score;
    existing.reasons.push(reason);
    scores.set(chunkId, existing);
  }

  for (const noteId of query.noteIds ?? []) {
    for (const chunkId of index.byNoteId[noteId] ?? []) add(chunkId, 1, `note:${noteId}`);
  }
  for (const tag of query.tags ?? []) {
    for (const chunkId of index.byTag[tag] ?? []) add(chunkId, 0.8, `tag:${tag}`);
  }

  const scope = query.scope;
  if (scope?.chatId) {
    for (const chunkId of index.byScope.chatId[scope.chatId] ?? []) add(chunkId, 1, `chat:${scope.chatId}`);
  }
  if (scope?.groupId) {
    for (const chunkId of index.byScope.groupId[scope.groupId] ?? []) add(chunkId, 0.8, `group:${scope.groupId}`);
  }
  for (const characterId of [...(scope?.characterIds ?? []), ...(query.characterIds ?? [])]) {
    for (const chunkId of index.byScope.characterId[characterId] ?? []) add(chunkId, 0.7, `character:${characterId}`);
  }
  if (scope?.rpId) {
    for (const chunkId of index.byScope.rpId[scope.rpId] ?? []) add(chunkId, 0.45, `rp:${scope.rpId}`);
  }
  if (scope?.universe) {
    for (const chunkId of index.byScope.universe[scope.universe] ?? []) add(chunkId, 0.35, `universe:${scope.universe}`);
  }

  return Array.from(scores.entries())
    .map(([chunkId, value]) => ({ chunkId, ...value }))
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
}
