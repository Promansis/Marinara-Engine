import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import type { LtmNote } from "@marinara-engine/shared";
import { helperTextClassName, insetSectionCardClassName, microLabelClassName } from "./LtmFields";
import { displayNoteTitle, friendlyIdentifier, humanRelationLabel, type LtmNoteLookup } from "./ltm-editor-utils";

export function LinkedContextPanel({
  note,
  notes,
  onNavigate,
}: {
  note: LtmNote;
  notes?: LtmNoteLookup;
  onNavigate?: (noteId: string) => void;
}) {
  const linkedNotes = useMemo(
    () =>
      (note.links ?? [])
        .map((link) => {
          const target = notes?.get(link.target);
          return target ? { link, target } : null;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    [note.links, notes],
  );

  if (linkedNotes.length === 0) return null;

  return (
    <div className={insetSectionCardClassName}>
      <div className="mb-3">
        <div className={microLabelClassName}>Linked Context</div>
        <p className={helperTextClassName}>Related note-level memories for this memory.</p>
      </div>
      <div className="grid gap-2">
        {linkedNotes.map(({ link, target }) => {
          const preview = Object.values(target.sections)[0]?.text.trim() ?? "";
          return (
            <button
              key={`${link.target}-${link.relation}-${link.aspect ?? ""}`}
              type="button"
              onClick={() => onNavigate?.(target.id)}
              disabled={!onNavigate}
              className="grid gap-1 rounded-lg bg-[var(--background)]/55 p-2 text-left ring-1 ring-[var(--border)]/70 transition-colors enabled:hover:bg-[var(--accent)]/35 disabled:cursor-default"
            >
              <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[var(--foreground)]">
                <ExternalLink size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
                <span className="truncate">{displayNoteTitle(target)}</span>
              </span>
              <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                {humanRelationLabel(link.relation)}
                {link.aspect ? `, ${friendlyIdentifier(link.aspect)}` : ""}
              </span>
              {preview && <span className="line-clamp-2 text-xs text-[var(--foreground)]/80">{preview}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
