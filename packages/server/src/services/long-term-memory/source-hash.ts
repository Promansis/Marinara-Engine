import type { LtmNote } from "@marinara-engine/shared";
import { stableJsonHash } from "./chunking.js";

export function sourceHashForLtmSourceNote(note: LtmNote) {
  const section = note.sections.source ?? note.sections.summary;
  return stableJsonHash({
    noteId: note.id,
    sourceText: section?.text.trim() ?? "",
    evidence: Array.from(new Set(section?.evidence ?? [])).sort(),
  });
}
