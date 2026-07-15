import { useMemo } from "react";
import { Loader2, Pencil, Search } from "lucide-react";
import type {
  Chat,
  LtmExtractionDraft,
  LtmExtractionDroppedCandidate,
  LtmLink,
  LtmMode,
  LtmNote,
} from "@marinara-engine/shared";
import {
  dedupeEvidenceEntries,
  displayNoteTitle,
  friendlyIdentifier,
  friendlyMode,
  friendlyNoteType,
  friendlySectionKey,
  friendlyStatus,
  humanMemoryTitle,
  humanRelationLabel,
  humanScopeLabel,
  humanScoreLabel,
  resolveEvidenceDisplay,
  type LtmDisplayLookupContext,
} from "./ltm-editor-utils";
import { LongTermMemoryNoteEditor } from "./LongTermMemoryNoteEditor";
import { LongTermMemorySuggestionsTab } from "./LongTermMemorySuggestionsTab";
import { LtmTabRail } from "./LtmTabRail";
import { type LtmManagedExtractionPrefs } from "./ltm-managed-extraction-prefs";
import { LtmModal } from "./LtmModal";
import type { LtmSearchResponse } from "../../hooks/use-long-term-memory";
import type { LongTermMemoryLatestExtractionResult } from "../../hooks/use-long-term-memory";
import { emptyStateClassName, inputClassName } from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";
import {
  compactLtmText,
  derivedSourceGroups,
  EvidencePills,
  isDerivedFromSource,
  isSourceSummaryNote,
  MemoryModalMode,
  MemoryModalTab,
  noteReferenceLabel,
  noteTextPreview,
  pendingConflictCount,
  sourceLinkIds,
  sourceReferenceLabel,
  sourceTypeLabel,
} from "./ltm-panel-shared";

function GraphLinks({
  links,
  noteLookup,
  chatLookup,
  onOpenNote,
}: {
  links: LtmLink[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  onOpenNote?: (noteId: string) => void;
}) {
  if (links.length === 0) {
    return <p className={emptyStateClassName}>No related memories yet.</p>;
  }

  return (
    <div className="space-y-2">
      {links.map((link, index) => {
        const label = noteReferenceLabel(link.target, noteLookup, chatLookup);
        const content = (
          <>
            <span className="shrink-0 rounded-md bg-[var(--muted)]/50 px-1.5 py-0.5 text-[0.6875rem] text-[var(--muted-foreground)]">
              {humanRelationLabel(link.relation)}
            </span>
            <span className="min-w-0 truncate text-[var(--foreground)]" title={label}>
              {label}
            </span>
          </>
        );
        if (onOpenNote) {
          return (
            <button
              key={`${link.relation}-${link.target}-${index}`}
              type="button"
              onClick={() => onOpenNote(link.target)}
              className="flex w-full min-w-0 items-center gap-2 rounded-lg bg-[var(--secondary)]/45 px-3 py-2 text-left text-xs ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
            >
              {content}
            </button>
          );
        }
        return (
          <div
            key={`${link.relation}-${link.target}-${index}`}
            className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--secondary)]/45 px-3 py-2 text-xs ring-1 ring-[var(--border)]"
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}

function DerivedActiveMemories({
  sourceNote,
  activeNotes,
  noteLookup,
  chatLookup,
  loading,
  onOpenNote,
}: {
  sourceNote: LtmNote;
  activeNotes: LtmNote[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  loading: boolean;
  onOpenNote?: (noteId: string) => void;
}) {
  const derivedNotes = useMemo(
    () =>
      activeNotes.filter(
        (candidate) =>
          candidate.id !== sourceNote.id &&
          candidate.status === "active" &&
          !isSourceSummaryNote(candidate) &&
          isDerivedFromSource(candidate, sourceNote.id),
      ),
    [activeNotes, sourceNote.id],
  );
  const groups = useMemo(() => derivedSourceGroups(derivedNotes), [derivedNotes]);
  const derivedCount = derivedNotes.length;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-[var(--foreground)]">Extracted Active Memories</h3>
        <StatusPill
          label={`${derivedCount} active memor${derivedCount === 1 ? "y" : "ies"}`}
          tone={derivedCount ? "good" : "neutral"}
        />
      </div>
      {loading ? (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-3 text-xs text-[var(--muted-foreground)]">
          <Loader2 className="mr-2 animate-spin" size="0.875rem" />
          Loading extracted memories...
        </div>
      ) : groups.length === 0 ? (
        <p className={emptyStateClassName}>No active memories link back to this source note yet.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={`${group.type}:${group.status}`} className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5 px-1">
                <StatusPill label={friendlyNoteType(group.type)} />
                <StatusPill
                  label={friendlyStatus(group.status)}
                  tone={group.status === "active" ? "good" : "neutral"}
                />
                <StatusPill label={`${group.notes.length} memor${group.notes.length === 1 ? "y" : "ies"}`} />
              </div>
              <div className="space-y-2">
                {group.notes.map((derivedNote) => (
                  <button
                    key={derivedNote.id}
                    type="button"
                    onClick={() => onOpenNote?.(derivedNote.id)}
                    disabled={!onOpenNote}
                    className="w-full rounded-lg bg-[var(--card)] p-3 text-left ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:cursor-default disabled:hover:bg-[var(--card)]"
                  >
                    <div className="truncate text-xs font-medium text-[var(--foreground)]">
                      {displayNoteTitle(derivedNote)}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                      {noteTextPreview(derivedNote) || "No summary text."}
                    </p>
                    <EvidencePills note={derivedNote} noteLookup={noteLookup} chatLookup={chatLookup} />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function MemoryOverviewPanel({
  note,
  activeNotes,
  noteLookup,
  chatLookup,
  displayContext,
  activeNotesLoading,
  pendingSuggestionCount,
  onOpenNote,
}: {
  note: LtmNote;
  activeNotes: LtmNote[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  displayContext: LtmDisplayLookupContext;
  activeNotesLoading: boolean;
  pendingSuggestionCount: number;
  onOpenNote: (noteId: string) => void;
}) {
  const sourceIds = sourceLinkIds(note);
  const conflictCount = pendingConflictCount(note);
  const isSourceNote = isSourceSummaryNote(note);
  const derivedCount = activeNotes.filter(
    (candidate) => candidate.id !== note.id && isDerivedFromSource(candidate, note.id),
  ).length;

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={isSourceNote ? sourceTypeLabel(note) : friendlyNoteType(note.type)} />
          <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
          {note.modes.map((mode) => (
            <StatusPill key={mode} label={friendlyMode(mode)} />
          ))}
          {isSourceNote && <StatusPill label={`${derivedCount} linked memor${derivedCount === 1 ? "y" : "ies"}`} />}
          {pendingSuggestionCount > 0 && (
            <StatusPill
              label={`${pendingSuggestionCount} pending suggestion${pendingSuggestionCount === 1 ? "" : "s"}`}
              tone="warn"
            />
          )}
          {conflictCount > 0 && <StatusPill label={`${conflictCount} needs review`} tone="warn" />}
        </div>
        <div className="mt-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
          {humanScopeLabel(note, chatLookup, displayContext.groups)} · updated{" "}
          {new Date(note.updatedAt).toLocaleString()}
        </div>
      </div>

      <section className="space-y-2">
        <h3 className="px-1 text-xs font-semibold text-[var(--foreground)]">Where it comes from</h3>
        {sourceIds.length > 0 ? (
          <div className="space-y-2">
            {sourceIds.map((sourceId) => {
              const source = noteLookup.get(sourceId);
              return (
                <button
                  key={sourceId}
                  type="button"
                  onClick={() => onOpenNote(sourceId)}
                  className="w-full rounded-lg bg-[var(--secondary)]/35 p-3 text-left ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
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
            })}
          </div>
        ) : (
          <GraphLinks links={note.links} noteLookup={noteLookup} chatLookup={chatLookup} onOpenNote={onOpenNote} />
        )}
      </section>

      {isSourceNote && (
        <DerivedActiveMemories
          sourceNote={note}
          activeNotes={activeNotes}
          noteLookup={noteLookup}
          chatLookup={chatLookup}
          loading={activeNotesLoading}
          onOpenNote={onOpenNote}
        />
      )}
    </div>
  );
}

function MemoryContentsPanel({
  note,
  displayContext,
  variant = "content",
}: {
  note: LtmNote;
  displayContext: LtmDisplayLookupContext;
  variant?: "content" | "metadata";
}) {
  return (
    <div className="space-y-2">
      {Object.entries(note.sections).map(([key, section]) => (
        <section key={key} className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-[var(--foreground)]">{friendlySectionKey(key)}</span>
            {variant === "metadata" && typeof section.salience === "number" && (
              <StatusPill label={`Importance: ${humanScoreLabel(section.salience)}`} />
            )}
            {variant === "metadata" && typeof section.confidence === "number" && (
              <StatusPill label={`Confidence: ${humanScoreLabel(section.confidence)}`} />
            )}
          </div>
          {variant === "content" && (
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">{section.text}</p>
          )}
          {variant === "metadata" && (section.evidence ?? []).length > 0 && (
            <div className="mt-2 rounded-md bg-[var(--background)]/55 p-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
              <div className="mb-1 font-medium text-[var(--foreground)]">Evidence</div>
              <div className="flex flex-wrap gap-1.5">
                {dedupeEvidenceEntries(section.evidence ?? [], displayContext).map((entry) => {
                  const resolved = resolveEvidenceDisplay(entry, displayContext);
                  return (
                    <StatusPill
                      key={`${key}-${entry}`}
                      label={resolved.label}
                      title={resolved.tooltip ?? resolved.label}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {variant === "metadata" && (section.evidence ?? []).length === 0 && (
            <p className="mt-2 text-[0.6875rem] text-[var(--muted-foreground)]">No section evidence.</p>
          )}
        </section>
      ))}
    </div>
  );
}

function MemoryRecallPanel({
  result,
  pending,
  query,
  context,
  onQueryChange,
  onRun,
}: {
  result: LtmSearchResponse | null;
  pending: boolean;
  query: string;
  context: { chatLabel: string | null; mode: LtmMode | null; enabled: boolean };
  onQueryChange: (query: string) => void;
  onRun: () => void;
}) {
  const canRun = Boolean(context.chatLabel && context.enabled && query.trim() && !pending);
  return (
    <div className="space-y-3">
      {!context.chatLabel ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-100"
        >
          Choose a specific chat branch in the memory navigator before testing recall.
        </p>
      ) : !context.enabled ? (
        <p
          role="status"
          className="rounded-lg bg-[var(--secondary)]/35 p-3 text-xs text-[var(--muted-foreground)] ring-1 ring-[var(--border)]"
        >
          Long-Term Memory is off for {context.chatLabel}. Turn it on in Chat Settings before testing recall.
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canRun) onRun();
          }}
          placeholder="Test a recall query"
          aria-label={context.chatLabel ? `Test recall query for ${context.chatLabel}` : "Test recall query"}
          disabled={!context.chatLabel || !context.enabled}
          className={inputClassName}
        />
        <ToolButton onClick={onRun} disabled={!canRun} tone="primary">
          {pending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Search size="0.875rem" />}
          Test Recall
        </ToolButton>
      </div>
      <div className="rounded-lg bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={context.chatLabel ? `Selected chat: ${context.chatLabel}` : "No chat selected"} />
          {context.mode && <StatusPill label={friendlyMode(context.mode)} />}
          <StatusPill label="Debug funnel on" />
        </div>
      </div>
      {!result && (
        <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-4 text-center text-xs text-[var(--muted-foreground)]">
          Run a query to see selected chunks, rejected candidates, scores, and token use for this memory.
        </p>
      )}
      {result && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill label={`${result.chunks.length} selected`} tone={result.chunks.length ? "good" : "neutral"} />
            <StatusPill label={`${result.usedTokens}/${result.maxTokens} tokens`} />
            <StatusPill
              label={result.embeddingsAvailable ? "Smart search" : "Basic search"}
              tone={result.embeddingsAvailable ? "good" : "warn"}
            />
          </div>
          {result.warnings.map((warning) => (
            <p
              key={warning}
              className="rounded-md bg-amber-500/10 px-2 py-1 text-[0.6875rem] text-amber-700 dark:text-amber-200"
            >
              {warning}
            </p>
          ))}
          {result.debug?.weights && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(result.debug.weights).map(([key, value]) => (
                <StatusPill key={key} label={`${friendlyIdentifier(key)} ${value}`} />
              ))}
            </div>
          )}
          {result.debug?.funnel && (
            <div className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]">
              <div className="mb-2 text-xs font-semibold text-[var(--foreground)]">Funnel</div>
              <div className="grid grid-cols-2 gap-1.5">
                {Object.entries(result.debug.funnel).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-[var(--background)]/45 px-2 py-1 text-[0.6875rem] ring-1 ring-[var(--border)]/70"
                  >
                    <span className="truncate text-[var(--muted-foreground)]">{friendlyIdentifier(key)}</span>
                    <span className="font-medium text-[var(--foreground)]">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            {result.chunks.length === 0 && (
              <p className="rounded-md bg-[var(--secondary)]/50 px-2 py-2 text-xs text-[var(--muted-foreground)]">
                No chunks matched this memory-focused query.
              </p>
            )}
            {result.chunks.map((item, index) => (
              <article
                key={`${item.chunk?.id ?? "chunk"}-${index}`}
                className="rounded-md bg-[var(--secondary)]/45 p-2 ring-1 ring-[var(--border)]"
              >
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 truncate font-mono text-[0.6875rem] text-[var(--foreground)]">
                    {item.chunk?.noteId ?? "memory"} · {item.chunk?.sectionKey ?? "section"}
                  </span>
                  {typeof item.score === "number" && <StatusPill label={`Score ${item.score.toFixed(2)}`} />}
                  {item.estimatedTokens !== undefined && <StatusPill label={`~${item.estimatedTokens} tokens`} />}
                  {item.lanes?.map((lane) => (
                    <StatusPill key={lane} label={lane} />
                  ))}
                </div>
                <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                  {compactLtmText(item.chunk?.text, 360)}
                </p>
              </article>
            ))}
          </div>
          {result.debug?.rejected && result.debug.rejected.length > 0 && (
            <details className="rounded-md bg-[var(--secondary)]/35 p-2 text-xs text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
              <summary className="cursor-pointer font-medium text-[var(--foreground)]">
                Rejected candidates ({result.debug.rejected.length})
              </summary>
              <div className="mt-2 grid gap-1">
                {result.debug.rejected.slice(0, 12).map((candidate) => (
                  <div key={candidate.chunkId} className="flex flex-wrap gap-1.5">
                    <span className="font-mono">{candidate.noteId ?? candidate.chunkId}</span>
                    <span>{candidate.rejectionReason ?? "lower_rank"}</span>
                    {candidate.estimatedTokens !== undefined && <span>~{candidate.estimatedTokens} tokens</span>}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function defaultMemoryModalTab(_note: LtmNote): MemoryModalTab {
  return "overview";
}

export function MemoryNoteModal({
  note,
  open,
  mode,
  activeTab,
  extractionPrefs,
  activeNotes,
  noteLookup,
  chatLookup,
  displayContext,
  activeNotesLoading,
  pendingDrafts,
  recallQuery,
  recallResult,
  recallPending,
  recallContext,
  editorDirty,
  latestExtractionResult,
  onClose,
  onModeChange,
  onTabChange,
  onOpenNote,
  onRecallQueryChange,
  onRunRecall,
  onEditorDirtyChange,
  onSaved,
  onLatestExtractionResultChange,
  onRecoverDroppedCandidate,
}: {
  note: LtmNote | null;
  open: boolean;
  mode: MemoryModalMode;
  activeTab: MemoryModalTab;
  extractionPrefs?: LtmManagedExtractionPrefs;
  activeNotes: LtmNote[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  displayContext: LtmDisplayLookupContext;
  activeNotesLoading: boolean;
  pendingDrafts: LtmExtractionDraft[];
  recallQuery: string;
  recallResult: LtmSearchResponse | null;
  recallPending: boolean;
  recallContext: { chatLabel: string | null; mode: LtmMode | null; enabled: boolean };
  editorDirty: boolean;
  latestExtractionResult: LongTermMemoryLatestExtractionResult | null;
  onClose: () => void;
  onModeChange: (mode: MemoryModalMode) => void;
  onTabChange: (tab: MemoryModalTab) => void;
  onOpenNote: (noteId: string) => void;
  onRecallQueryChange: (query: string) => void;
  onRunRecall: () => void;
  onEditorDirtyChange: (dirty: boolean) => void;
  onSaved: (note: LtmNote) => void;
  onLatestExtractionResultChange: (result: LongTermMemoryLatestExtractionResult | null) => void;
  onRecoverDroppedCandidate: (candidate: LtmExtractionDroppedCandidate, note: LtmNote) => void;
}) {
  const isSourceNote = note ? isSourceSummaryNote(note) : false;
  const tabs = useMemo(() => {
    if (!note) return [] as Array<{ id: MemoryModalTab; label: string }>;
    return isSourceNote
      ? [
          { id: "overview" as const, label: "Overview" },
          { id: "suggestions" as const, label: "Suggestions" },
        ]
      : [{ id: "overview" as const, label: "Overview" }];
  }, [isSourceNote, note]);
  const safeActiveTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : (tabs[0]?.id ?? "overview");

  return (
    <LtmModal
      open={open}
      onClose={onClose}
      title={note ? humanMemoryTitle(note, chatLookup) : "Long-Term Memory"}
      width="max-w-4xl"
    >
      {note && (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-start justify-end gap-3 border-b border-[var(--border)]/70 pb-3">
            {editorDirty && <StatusPill label="Unsaved changes" tone="warn" />}
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              {mode === "view" ? (
                <ToolButton onClick={() => onModeChange("edit")}>
                  <Pencil size="0.875rem" />
                  Edit
                </ToolButton>
              ) : (
                <ToolButton onClick={() => onModeChange("view")}>Cancel</ToolButton>
              )}
            </div>
          </div>

          {mode === "view" && (
            <>
              {isSourceNote && (
                <LtmTabRail
                  tabs={tabs}
                  activeId={safeActiveTab}
                  onChange={onTabChange}
                  ariaLabel="Memory detail views"
                  idPrefix="ltm-note"
                  equalWidth
                />
              )}

              <div
                id={`ltm-note-panel-${safeActiveTab}`}
                role="tabpanel"
                aria-labelledby={`ltm-note-tab-${safeActiveTab}`}
                tabIndex={0}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60"
              >
                {safeActiveTab === "overview" && (
                  <div className="space-y-3">
                    <MemoryOverviewPanel
                      note={note}
                      activeNotes={activeNotes}
                      noteLookup={noteLookup}
                      chatLookup={chatLookup}
                      displayContext={displayContext}
                      activeNotesLoading={activeNotesLoading}
                      pendingSuggestionCount={pendingDrafts.length}
                      onOpenNote={onOpenNote}
                    />
                    <section className="space-y-2">
                      <h3 className="px-1 text-xs font-semibold text-[var(--foreground)]">Memory text</h3>
                      <MemoryContentsPanel note={note} displayContext={displayContext} />
                    </section>
                    {note.links.length > 0 && (
                      <section className="space-y-2">
                        <h3 className="px-1 text-xs font-semibold text-[var(--foreground)]">Relationships</h3>
                        <GraphLinks
                          links={note.links}
                          noteLookup={noteLookup}
                          chatLookup={chatLookup}
                          onOpenNote={onOpenNote}
                        />
                      </section>
                    )}
                    <details className="rounded-lg bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]">
                      <summary className="cursor-pointer text-xs font-semibold text-[var(--foreground)]">
                        Advanced details
                      </summary>
                      <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
                        <MemoryContentsPanel note={note} displayContext={displayContext} variant="metadata" />
                        {!isSourceNote && (
                          <MemoryRecallPanel
                            result={recallResult}
                            pending={recallPending}
                            query={recallQuery}
                            context={recallContext}
                            onQueryChange={onRecallQueryChange}
                            onRun={onRunRecall}
                          />
                        )}
                      </div>
                    </details>
                  </div>
                )}
                {safeActiveTab === "suggestions" && isSourceNote && (
                  <LongTermMemorySuggestionsTab
                    note={note}
                    extractionPrefs={extractionPrefs}
                    latestExtractionResult={latestExtractionResult}
                    onLatestExtractionResultChange={onLatestExtractionResultChange}
                    onRecoverDroppedCandidate={onRecoverDroppedCandidate}
                  />
                )}
              </div>
            </>
          )}

          {mode === "edit" && (
            <LongTermMemoryNoteEditor
              note={note}
              onCancel={() => onModeChange("view")}
              onDirtyChange={onEditorDirtyChange}
              onSaved={onSaved}
              embedded
              displayContext={displayContext}
            />
          )}
        </div>
      )}
    </LtmModal>
  );
}
