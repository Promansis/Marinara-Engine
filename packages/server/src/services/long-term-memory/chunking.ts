import { createHash } from "node:crypto";
import {
  getLtmScopeChatIds,
  type LtmGate,
  type LtmNote,
  type LtmNoteType,
  type LtmScope,
  type LtmStatus,
} from "@marinara-engine/shared";

export interface LtmMemoryChunk {
  id: string;
  noteId: string;
  sectionKey: string;
  text: string;
  noteType: LtmNoteType;
  status: LtmStatus;
  scope: LtmScope;
  tags: string[];
  gates: LtmGate[];
  salience?: number;
  confidence?: number;
  updatedAt: string;
  sourceHash: string;
}

export interface ChunkLtmNotesOptions {
  includeSourceNotes?: boolean;
  sourceNotesOnly?: boolean;
}

export function stableJsonHash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function compactLabels(note: LtmNote, sectionKey: string) {
  const labels = [`note:${note.id}`, `type:${note.type}`, `section:${sectionKey}`, `status:${note.status}`];
  if (note.tags.length > 0) labels.push(`tags:${note.tags.join(",")}`);
  if (note.scope.universe) labels.push(`universe:${note.scope.universe}`);
  if (note.scope.rpId) labels.push(`rp:${note.scope.rpId}`);
  const chatIds = getLtmScopeChatIds(note.scope);
  if (chatIds.length) labels.push(`chat:${chatIds.join(",")}`);
  if (note.scope.groupId) labels.push(`group:${note.scope.groupId}`);
  if (note.scope.characterIds?.length) labels.push(`characters:${note.scope.characterIds.join(",")}`);
  return labels.join(" ");
}

export function isLtmSourceSummaryNote(note: Pick<LtmNote, "type" | "tags">) {
  return note.type === "scene" && (note.tags.includes("source_summary") || note.tags.includes("chat_summary"));
}

export function chunkNoteSections(note: LtmNote): LtmMemoryChunk[] {
  return Object.entries(note.sections)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sectionKey, section]) => {
      const text = `${section.text.trim()}\n\n[${compactLabels(note, sectionKey)}]`;
      return {
        id: `${note.id}::${sectionKey}`,
        noteId: note.id,
        sectionKey,
        text,
        noteType: note.type,
        status: note.status,
        scope: note.scope,
        tags: [...note.tags].sort((a, b) => a.localeCompare(b)),
        gates: [...(section.gates ?? [])].sort((a, b) => a.localeCompare(b)),
        salience: section.salience,
        confidence: section.confidence,
        updatedAt: section.updatedAt,
        sourceHash: stableJsonHash({
          noteId: note.id,
          noteType: note.type,
          status: note.status,
          scope: note.scope,
          tags: note.tags,
          sectionKey,
          section,
        }),
      };
    });
}

export function chunkNotes(notes: LtmNote[], options: ChunkLtmNotesOptions = {}) {
  return notes
    .slice()
    .filter((note) => {
      const isSource = isLtmSourceSummaryNote(note);
      if (options.sourceNotesOnly) return isSource;
      return options.includeSourceNotes === true || !isSource;
    })
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((note) => chunkNoteSections(note));
}
