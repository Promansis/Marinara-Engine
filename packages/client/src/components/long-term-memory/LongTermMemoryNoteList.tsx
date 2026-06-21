import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Eye, RotateCcw, Trash2 } from "lucide-react";
import type { Chat, LtmNote } from "@marinara-engine/shared";
import {
  displayNoteTitle,
  friendlyIdentifier,
  friendlyNoteTitle,
  friendlyNoteType,
  friendlyStatus,
  sentenceCaseIdentifier,
} from "./ltm-editor-utils";
import { cn } from "../../lib/utils";
import {
  emptyStateClassName,
  listRowClassName,
  selectedListRowClassName,
} from "./LtmFields";
import { StatusPill } from "./LtmPills";
import {
  DisclosureHeader,
  EvidencePills,
  isChatSummarySourceNote,
  isSourceSummaryNote,
  memoryRowTitle,
  noteTextPreview,
  pendingConflictCount,
  rowActionButtonClassName,
  rowActionGroupClassName,
  rowActionOverlayClassName,
  sourceGroupNoteIds,
  sourceLinkIds,
  sourceNoteTitle,
  sourceReferenceLabel,
  sourceTypeLabel,
  type LtmBucketGroup,
  type SourceSummaryGroup,
} from "./ltm-panel-shared";

export function NoteRow({
  note,
  open,
  onOpen,
  onRestore,
  onDelete,
  bulkSelected,
  onSelect,
  title,
  primaryLabel,
  hideTags,
  children,
}: {
  note: LtmNote;
  open: boolean;
  onOpen: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
  bulkSelected?: boolean;
  onSelect?: (selected: boolean) => void;
  title?: string;
  primaryLabel?: string;
  hideTags?: boolean;
  children?: ReactNode;
}) {
  const sectionCount = Object.keys(note.sections).length;
  const primaryText =
    note.sections.summary?.text.trim() ||
    note.sections.core?.text.trim() ||
    Object.values(note.sections)[0]?.text.trim() ||
    "";
  const displayTitle = title ?? friendlyNoteTitle(note);
  const showSourceSummary = isSourceSummaryNote(note);
  return (
    <article
      className={cn("group", listRowClassName, (open || bulkSelected) && selectedListRowClassName)}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <div className={cn("grid min-w-0 gap-2", onSelect && "grid-cols-[auto_minmax(0,1fr)]")}>
          {onSelect && (
            <input
              type="checkbox"
              checked={bulkSelected ?? false}
              onChange={(event) => onSelect(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
              aria-label={`Select ${displayTitle}`}
            />
          )}
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-[var(--foreground)]" title={displayTitle}>
              {displayTitle}
            </div>
            {primaryText && !showSourceSummary && (
              <div className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                {primaryText}
              </div>
            )}
            <div className="mt-1 flex min-w-0 flex-wrap gap-1">
              <StatusPill label={primaryLabel ?? (showSourceSummary ? "Source summary" : friendlyNoteType(note.type))} />
              {!showSourceSummary && (
                <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
              )}
              {note.extracted && <StatusPill label="Extracted" />}
              {sectionCount > 1 && <StatusPill label={`${sectionCount} details`} />}
            </div>
            {children}
          </div>
        </div>
        <div className={rowActionGroupClassName}>
          <button
            type="button"
            onClick={onOpen}
            className={cn(rowActionButtonClassName, open && "bg-[var(--accent)] text-[var(--foreground)]")}
            aria-label={`Open ${displayTitle}`}
            title="Open memory"
          >
            <Eye size="0.875rem" />
          </button>
          {onRestore && (
            <button
              type="button"
              onClick={onRestore}
              className={cn(rowActionButtonClassName, "hover:bg-emerald-500/10 hover:text-emerald-200")}
              aria-label={`Restore ${displayTitle}`}
              title="Restore memory"
            >
              <RotateCcw size="0.875rem" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className={cn(rowActionButtonClassName, "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]")}
              aria-label={`Delete ${displayTitle}`}
              title="Delete memory"
            >
              <Trash2 size="0.875rem" />
            </button>
          )}
        </div>
      </div>
      {!hideTags && note.tags.length > 0 && (
        <div className="mt-2 truncate text-[0.625rem] text-[var(--muted-foreground)]" title={displayTitle}>
          {note.tags.map(friendlyIdentifier).join(", ")}
        </div>
      )}
    </article>
  );
}


export function TypeMemoryGroups({
  groups,
  noteLookup,
  expandedMemoryIds,
  expandedTypeIds,
  openNoteId,
  selectedNoteIds,
  derivedCountBySource,
  onToggleMemory,
  onToggleType,
  onOpen,
  onOpenSource,
  onSelect,
  onDelete,
  chatLookup,
}: {
  groups: LtmBucketGroup[];
  noteLookup: Map<string, LtmNote>;
  expandedMemoryIds: Set<string>;
  expandedTypeIds: Set<string>;
  openNoteId: string | null;
  selectedNoteIds: Set<string>;
  derivedCountBySource: Map<string, number>;
  onToggleMemory: (id: string) => void;
  onToggleType: (type: string) => void;
  onOpen: (id: string) => void;
  onOpenSource: (id: string) => void;
  onSelect: (id: string, selected: boolean) => void;
  onDelete: (note: LtmNote) => void;
  chatLookup?: Map<string, Chat>;
}) {
  if (groups.length === 0) {
    return (
      <p className={emptyStateClassName}>
        No memory streams match these filters.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const sourceIds = [...new Set(group.notes.flatMap(sourceLinkIds))];
        const sourceCount = sourceIds.length;
        const activeSourceCount = sourceIds.filter((sourceId) => noteLookup.get(sourceId)?.status === "active").length;
        const archivedSourceCount = sourceIds.filter(
          (sourceId) => noteLookup.get(sourceId)?.status === "archived",
        ).length;
        const missingSourceCount = sourceIds.filter((sourceId) => !noteLookup.has(sourceId)).length;
        const conflictCount = group.notes.reduce((total, note) => total + pendingConflictCount(note), 0);
        const typeExpanded = expandedTypeIds.has(group.type);
        return (
          <section key={group.type}>
            <DisclosureHeader
              title={friendlyNoteType(group.type)}
              description={`${group.notes.length} memor${group.notes.length === 1 ? "y" : "ies"}`}
              open={typeExpanded}
              onToggle={() => onToggleType(group.type)}
            >
              {sourceCount > 0 && <StatusPill label={`${activeSourceCount}/${sourceCount} active sources`} />}
              {archivedSourceCount > 0 && (
                <StatusPill
                  label={`${archivedSourceCount} archived source${archivedSourceCount === 1 ? "" : "s"}`}
                  tone="warn"
                />
              )}
              {missingSourceCount > 0 && (
                <StatusPill
                  label={`${missingSourceCount} missing source${missingSourceCount === 1 ? "" : "s"}`}
                  tone="warn"
                />
              )}
              {conflictCount > 0 && <StatusPill label={`${conflictCount} needs review`} tone="warn" />}
            </DisclosureHeader>
            {typeExpanded && (
              <div className="mt-2 space-y-2">
                {group.notes.map((note) => {
                  const expanded = expandedMemoryIds.has(note.id);
                  const sourcesCount = sourceLinkIds(note).length;
                  const derivedCount = derivedCountBySource.get(note.id) ?? 0;
                  const selected = selectedNoteIds.has(note.id);
                  return (
                    <article
                      key={note.id}
                      className={cn(
                        "group relative",
                        listRowClassName,
                        (openNoteId === note.id || selected) && selectedListRowClassName,
                      )}
                    >
                      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2">
                        <div className="grid min-h-16 w-7 shrink-0 grid-rows-[auto_1fr] justify-items-center">
                          <button
                            type="button"
                            onClick={() => onToggleMemory(note.id)}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                            aria-label={expanded ? "Hide source details" : "Show source details"}
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
                          </button>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(event) => onSelect(note.id, event.target.checked)}
                            className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                            aria-label={`Select ${memoryRowTitle(note, chatLookup)}`}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="min-w-0">
                            <div
                              className="truncate text-xs font-semibold text-[var(--foreground)]"
                              title={memoryRowTitle(note, chatLookup)}
                            >
                              {memoryRowTitle(note, chatLookup)}
                            </div>
                          </div>
                          {note.type !== "source" && (
                            <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                              {noteTextPreview(note) || "No summary text."}
                            </p>
                          )}
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {note.type === "source" ? (
                              <StatusPill label={sourceTypeLabel(note)} />
                            ) : (
                              <StatusPill
                                label={friendlyStatus(note.status)}
                                tone={note.status === "active" ? "good" : "neutral"}
                              />
                            )}
                            {sourcesCount === 0 && note.type !== "source" && <StatusPill label="Manual" />}
                            {isSourceSummaryNote(note) && derivedCount > 0 && (
                              <StatusPill label={`${derivedCount} memory stream${derivedCount === 1 ? "" : "s"}`} />
                            )}
                          </div>
                          <EvidencePills
                            note={note}
                            noteLookup={noteLookup}
                            chatLookup={chatLookup}
                            onOpenSource={onOpenSource}
                          />
                          {expanded && (
                            <div className="mt-2 space-y-1.5 rounded-lg bg-[var(--background)]/35 p-2 ring-1 ring-[var(--border)]/70">
                              {sourcesCount === 0 ? (
                                <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
                                  No source evidence is linked to this memory.
                                </p>
                              ) : (
                                sourceLinkIds(note).map((sourceId) => {
                                  const source = noteLookup.get(sourceId);
                                  return (
                                    <button
                                      key={sourceId}
                                      type="button"
                                      onClick={() => onOpen(sourceId)}
                                      className="w-full rounded-md bg-[var(--secondary)]/45 p-2 text-left ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
                                    >
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="min-w-0 truncate text-xs font-medium text-[var(--foreground)]">
                                          {sourceReferenceLabel(sourceId, noteLookup, chatLookup)}
                                        </span>
                                        {source && <StatusPill label={friendlyStatus(source.status)} tone="neutral" />}
                                      </div>
                                      {source && (
                                        <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                                          {noteTextPreview(source) || "Source has no summary text."}
                                        </p>
                                      )}
                                    </button>
                                  );
                                })
                              )}
                              {(note.conflicts ?? [])
                                .filter((conflict) => conflict.resolution === "pending")
                                .map((conflict) => (
                                  <div
                                    key={`${conflict.field}:${conflict.policy}`}
                                    className="rounded-md bg-amber-500/10 p-2 text-[0.6875rem] leading-relaxed text-amber-100 ring-1 ring-amber-400/30"
                                  >
                                    Needs review: {sentenceCaseIdentifier(conflict.field)}
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className={rowActionOverlayClassName}>
                        <button
                          type="button"
                          onClick={() => onOpen(note.id)}
                          className={cn(
                            rowActionButtonClassName,
                            openNoteId === note.id && "bg-[var(--accent)] text-[var(--foreground)]",
                          )}
                          aria-label={`Open ${memoryRowTitle(note, chatLookup)}`}
                          title="Open memory"
                        >
                          <Eye size="0.875rem" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(note)}
                          className={cn(
                            rowActionButtonClassName,
                            "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]",
                          )}
                          aria-label={`Delete ${memoryRowTitle(note, chatLookup)}`}
                          title="Delete memory"
                        >
                          <Trash2 size="0.875rem" />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function _ArchivedSourceSummaryGroupRow({
  group,
  openNoteId,
  selectedNoteIds,
  onSelect,
  onOpen,
  onRestore,
  onDelete,
  chatLookup,
}: {
  group: SourceSummaryGroup;
  openNoteId: string | null;
  selectedNoteIds: Set<string>;
  onSelect: (ids: string[], selected: boolean) => void;
  onOpen: (id: string) => void;
  onRestore: (note: LtmNote) => void;
  onDelete: (note: LtmNote) => void;
  chatLookup?: Map<string, Chat>;
}) {
  const groupIds = sourceGroupNoteIds(group);
  const allSelected = groupIds.every((id) => selectedNoteIds.has(id));

  if (group.orphaned) {
    return (
      <NoteRow
        note={group.source}
        open={openNoteId === group.source.id}
        bulkSelected={selectedNoteIds.has(group.source.id)}
        onSelect={(selected) => onSelect([group.source.id], selected)}
        onOpen={() => onOpen(group.source.id)}
        onRestore={() => onRestore(group.source)}
        onDelete={() => onDelete(group.source)}
      />
    );
  }

  const sourceTitle = sourceNoteTitle(group.source, chatLookup);
  return (
    <article className={cn("group relative", listRowClassName)}>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2">
        <div className="grid min-h-12 w-8 shrink-0 justify-items-center">
          <label className="flex h-8 w-8 shrink-0 self-center items-center justify-center rounded-lg bg-[var(--background)]/55 ring-1 ring-[var(--border)]">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) => onSelect(groupIds, event.target.checked)}
              className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
              aria-label={`Select ${sourceTitle} group`}
            />
          </label>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-[var(--foreground)]" title={sourceTitle}>
            {sourceTitle}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusPill label={isChatSummarySourceNote(group.source) ? "Source summary" : "Source note"} />
            <StatusPill label={`${group.derived.length} memory stream${group.derived.length === 1 ? "" : "s"}`} />
          </div>
        </div>
      </div>
      <div className={rowActionOverlayClassName}>
        <button
          type="button"
          onClick={() => onOpen(group.source.id)}
          className={cn(
            rowActionButtonClassName,
            openNoteId === group.source.id && "bg-[var(--accent)] text-[var(--foreground)]",
          )}
          aria-label={`Open ${sourceTitle}`}
          title="Open source memory"
        >
          <Eye size="0.875rem" />
        </button>
        <button
          type="button"
          onClick={() => onRestore(group.source)}
          className={cn(rowActionButtonClassName, "hover:bg-emerald-500/10 hover:text-emerald-200")}
          aria-label={`Restore ${sourceTitle}`}
          title="Restore source memory"
        >
          <RotateCcw size="0.875rem" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(group.source)}
          className={cn(rowActionButtonClassName, "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]")}
          aria-label={`Delete ${sourceTitle}`}
          title="Delete source memory"
        >
          <Trash2 size="0.875rem" />
        </button>
      </div>
      {group.derived.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-[var(--border)]/70 pt-2">
          {group.derived.map((derivedNote) => (
            <div
              key={derivedNote.id}
              className="flex min-w-0 items-start gap-2 rounded-lg bg-[var(--background)]/35 p-2 ring-1 ring-[var(--border)]/70"
            >
              <label className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--secondary)]/55 ring-1 ring-[var(--border)]">
                <input
                  type="checkbox"
                  checked={selectedNoteIds.has(derivedNote.id)}
                  onChange={(event) => onSelect([derivedNote.id], event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
                  aria-label={`Select ${displayNoteTitle(derivedNote)}`}
                />
              </label>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-[var(--foreground)]">
                  {displayNoteTitle(derivedNote)}
                </div>
                <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                  {derivedNote.sections.summary?.text.trim() ||
                    derivedNote.sections.core?.text.trim() ||
                    Object.values(derivedNote.sections)[0]?.text.trim() ||
                    "No summary text."}
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <StatusPill label={friendlyNoteType(derivedNote.type)} />
                  <StatusPill label={friendlyStatus(derivedNote.status)} tone="neutral" />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onOpen(derivedNote.id)}
                  className={cn(
                    rowActionButtonClassName,
                    openNoteId === derivedNote.id && "bg-[var(--accent)] text-[var(--foreground)]",
                  )}
                  aria-label={`Open ${displayNoteTitle(derivedNote)}`}
                  title="Open memory"
                >
                  <Eye size="0.875rem" />
                </button>
                <button
                  type="button"
                  onClick={() => onRestore(derivedNote)}
                  className={cn(rowActionButtonClassName, "hover:bg-emerald-500/10 hover:text-emerald-200")}
                  aria-label={`Restore ${displayNoteTitle(derivedNote)}`}
                  title="Restore memory"
                >
                  <RotateCcw size="0.875rem" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(derivedNote)}
                  className={cn(
                    rowActionButtonClassName,
                    "hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]",
                  )}
                  aria-label={`Delete ${displayNoteTitle(derivedNote)}`}
                  title="Delete memory"
                >
                  <Trash2 size="0.875rem" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
