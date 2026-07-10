import {
  ltmNoteSchema,
  ltmScopeSchema,
  withMergedLtmScopeLinks,
} from "@marinara-engine/shared";

export function parseStoredLtmNote(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ltmNoteSchema.parse(raw);
  }
  const { previousHash: _previousHash, ...note } = raw as Record<string, unknown>;
  const scope = ltmScopeSchema.parse(
    note.scope && typeof note.scope === "object" && !Array.isArray(note.scope) ? note.scope : {},
  );
  return ltmNoteSchema.parse({
    ...note,
    scope: withMergedLtmScopeLinks(scope, {}),
  });
}
