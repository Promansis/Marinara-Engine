import { withMergedLtmScopeLinks } from "@marinara-engine/shared";
import { rebuildLongTermMemoryIndexes } from "./rebuild.js";
import { LongTermMemoryStorage } from "./storage.js";

export type ApplyLtmScopeLinksToDerivedResult = {
  sourceNoteId: string;
  count: number;
  affectedNoteIds: string[];
  rebuild: Awaited<ReturnType<typeof rebuildLongTermMemoryIndexes>> | null;
};

export async function applyLtmScopeLinksToDerivedNotes(
  sourceNoteId: string,
  links: { chatIds?: string[]; characterIds?: string[] },
  options: { root?: string; rebuildIndexes?: boolean } = {},
): Promise<ApplyLtmScopeLinksToDerivedResult | null> {
  const storage = new LongTermMemoryStorage(options.root);
  const sourceNote = await storage.getNote(sourceNoteId);
  if (!sourceNote) return null;

  const affectedNoteIds: string[] = [];
  const notes = await storage.listNotes();
  for (const note of notes) {
    if (!note.links.some((link) => link.target === sourceNoteId && link.relation === "extracted_from")) continue;
    const nextScope = withMergedLtmScopeLinks(note.scope, links);
    if (JSON.stringify(nextScope) === JSON.stringify(note.scope)) continue;
    const updated = await storage.updateNote(
      note.id,
      { scope: nextScope },
      {
        actor: "maintenance_api",
        cause: "api.apply_scope_to_derived",
        summary: `Applied source memory scope links from ${sourceNoteId}`,
      },
    );
    affectedNoteIds.push(updated.id);
  }

  const rebuild =
    affectedNoteIds.length && options.rebuildIndexes !== false
      ? await rebuildLongTermMemoryIndexes({ root: options.root })
      : null;

  return {
    sourceNoteId,
    count: affectedNoteIds.length,
    affectedNoteIds,
    rebuild,
  };
}
