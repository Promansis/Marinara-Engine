import { useMemo } from "react";
import { Loader2, Pencil, Search } from "lucide-react";
import type { Chat, LtmDraftMutation, LtmExtractionDraft, LtmExtractionDroppedCandidate, LtmLink, LtmNote } from "@marinara-engine/shared";
import {
  dedupeEvidenceEntries,
  displayNoteTitle,
  friendlyEvidence,
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
import { type LtmManagedExtractionPrefs } from "./ltm-managed-extraction-prefs";
import { Modal } from "../ui/Modal";
import { cn } from "../../lib/utils";
import type { LtmSearchResponse } from "../../hooks/use-long-term-memory";
import type { LongTermMemoryLatestExtractionResult } from "../../stores/ltm-extraction-results.store";
import {
  emptyStateClassName,
  inputClassName,
  listRowClassName,
} from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";
import {
  compactLtmText,
  draftRiskSummary,
  derivedSourceGroups,
  EvidencePills,
  isDerivedFromSource,
  isSourceSummaryNote,
  MemoryModalMode,
  MemoryModalTab,
  mutationKindLabel,
  mutationRiskLabel,
  mutationRiskTone,
  mutationTarget,
  mutationText,
  noteReferenceLabel,
  noteTextPreview,
  pendingConflictCount,
  sourceLinkIds,
  sourceReferenceLabel,
  sourceTypeLabel,
} from "./ltm-panel-shared";

export function MutationPreview({ mutation }: { mutation: LtmDraftMutation }) {
  return (
    <article className="rounded-lg bg-[var(--secondary)]/45 p-3 ring-1 ring-[var(--border)]">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill label={mutationKindLabel(mutation.kind)} />
          <StatusPill label={mutationRiskLabel(mutation.risk)} tone={mutationRiskTone(mutation.risk)} />
        </div>
        <div className="flex flex-wrap gap-1.5 sm:justify-end">
          <StatusPill label={`Risk ${mutationRiskLabel(mutation.risk)}`} tone={mutationRiskTone(mutation.risk)} />
          <StatusPill label={`Confidence ${Math.round(mutation.confidence * 100)}%`} />
          <StatusPill label={`${mutation.evidence.length} evidence`} />
        </div>
      </div>
      <div className="mt-2 text-xs font-medium text-[var(--foreground)]">{mutation.summary}</div>
      <div className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">Applies to: {mutationTarget(mutation)}</div>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--background)] p-2 text-[0.6875rem] leading-relaxed text-[var(--foreground)] ring-1 ring-[var(--border)]">
        {mutationText(mutation)}
      </pre>
      {mutation.evidence.length > 0 && (
        <div className="mt-2 rounded-md bg-[var(--background)]/70 p-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
          <span className="font-medium text-[var(--foreground)]">Evidence:</span>{" "}
          {mutation.evidence.map(friendlyEvidence).join(", ")}
        </div>
      )}
    </article>
  );
}

export function SourceNoteReference({
  sourceNoteId,
  noteLookup,
  chatLookup,
  onOpenSourceNote,
}: {
  sourceNoteId?: string;
  noteLookup?: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  if (!sourceNoteId) return null;
  const label = noteLookup ? sourceReferenceLabel(sourceNoteId, noteLookup, chatLookup) : friendlyIdentifier(sourceNoteId);
  if (onOpenSourceNote) {
    return (
      <button
        type="button"
        onClick={() => onOpenSourceNote(sourceNoteId)}
        className="min-w-0 truncate rounded-md bg-[var(--muted)]/40 px-1.5 py-0.5 text-left text-[0.625rem] font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
        title={`Open source note ${sourceNoteId}`}
      >
        From: {label}
      </button>
    );
  }
  return <StatusPill label={`From: ${label}`} />;
}

function DraftMetadataPills({
  draft,
  noteLookup,
  chatLookup,
  onOpenSourceNote,
}: {
  draft: LtmExtractionDraft;
  noteLookup?: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  onOpenSourceNote?: (noteId: string) => void;
}) {
  const { highestRisk, averageConfidence, evidenceCount } = draftRiskSummary(draft);
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      <StatusPill label={`Mutation risk ${mutationRiskLabel(highestRisk)}`} tone={mutationRiskTone(highestRisk)} />
      <StatusPill label={`Confidence ${Math.round(averageConfidence * 100)}%`} />
      <StatusPill label={`${evidenceCount} evidence`} />
      <SourceNoteReference
        sourceNoteId={draft.source.sourceNoteId}
        noteLookup={noteLookup}
        chatLookup={chatLookup}
        onOpenSourceNote={onOpenSourceNote}
      />
    </div>
  );
}

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
    return (
      <p className={emptyStateClassName}>
        No related memories yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {links.map((link, index) => {
        const label = noteReferenceLabel(link.target, noteLookup, chatLookup);
        const content = (
          <>
          <span className="shrink-0 rounded-md bg-[var(--muted)]/50 px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
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
        <p className={emptyStateClassName}>
          No active memories link back to this source note yet.
        </p>
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
  const derivedCount = activeNotes.filter((candidate) => candidate.id !== note.id && isDerivedFromSource(candidate, note.id)).length;

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
        <div className="mt-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {humanScopeLabel(note, chatLookup, displayContext.groups)} · updated {new Date(note.updatedAt).toLocaleString()}
        </div>
      </div>

      <div className="rounded-lg bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]">
        <div className="text-xs font-semibold text-[var(--foreground)]">What this memory is about</div>
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">
          {noteTextPreview(note, 600) || "No memory text has been written yet."}
        </p>
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
}: {
  note: LtmNote;
  displayContext: LtmDisplayLookupContext;
}) {
  return (
    <div className="space-y-2">
      {Object.entries(note.sections).map(([key, section]) => (
        <details
          key={key}
          open={Object.keys(note.sections).length <= 3}
          className="rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]"
        >
          <summary className="cursor-pointer list-none">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-[var(--foreground)]">{friendlySectionKey(key)}</span>
              {typeof section.salience === "number" && <StatusPill label={`Importance: ${humanScoreLabel(section.salience)}`} />}
              {typeof section.confidence === "number" && <StatusPill label={`Confidence: ${humanScoreLabel(section.confidence)}`} />}
            </div>
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground)]">{section.text}</p>
          {(section.evidence ?? []).length > 0 && (
            <div className="mt-2 rounded-md bg-[var(--background)]/55 p-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
              <div className="mb-1 font-medium text-[var(--foreground)]">Evidence</div>
              <div className="flex flex-wrap gap-1.5">
                {dedupeEvidenceEntries(section.evidence ?? [], displayContext).map((entry) => {
                  const resolved = resolveEvidenceDisplay(entry, displayContext);
                  return <StatusPill key={`${key}-${entry}`} label={resolved.label} title={resolved.tooltip ?? resolved.label} />;
                })}
              </div>
            </div>
          )}
        </details>
      ))}
    </div>
  );
}

function MemoryRecallPanel({
  note,
  result,
  pending,
  query,
  onQueryChange,
  onRun,
}: {
  note: LtmNote;
  result: LtmSearchResponse | null;
  pending: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onRun: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onRun();
          }}
          placeholder="Test a recall query"
          className={inputClassName}
        />
        <ToolButton onClick={onRun} disabled={!query.trim() || pending} tone="primary">
          {pending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Search size="0.875rem" />}
          Test
        </ToolButton>
      </div>
      <div className="rounded-lg bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill label={`Focused on ${friendlyNoteType(note.type)}`} />
          <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
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
            <p key={warning} className="rounded-md bg-amber-500/10 px-2 py-1 text-[0.6875rem] text-amber-200">
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

function _MemorySuggestionsPanel({
  note,
  drafts,
  noteLookup,
  chatLookup,
  _onViewDraft,
  onOpenSourceNote,
}: {
  note: LtmNote;
  drafts: LtmExtractionDraft[];
  noteLookup: Map<string, LtmNote>;
  chatLookup?: Map<string, Chat>;
  _onViewDraft: (draftId: string) => void;
  onOpenSourceNote: (noteId: string) => void;
}) {
  if (!isSourceSummaryNote(note)) {
    return (
      <p className={emptyStateClassName}>
        Suggestions live on source notes. Open a source note to review extracted memory drafts.
      </p>
    );
  }

  if (drafts.length === 0) {
    return (
      <p className={emptyStateClassName}>
        No pending suggestions for this source.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {drafts.map((draft) => (
        <button
          key={draft.id}
          type="button"
          onClick={() => _onViewDraft(draft.id)}
          className={cn("w-full text-left", listRowClassName)}
        >
          <div className="truncate text-xs font-semibold text-[var(--foreground)]">
            {draft.summary || "Untitled suggestion"}
          </div>
          <DraftMetadataPills draft={draft} noteLookup={noteLookup} chatLookup={chatLookup} onOpenSourceNote={onOpenSourceNote} />
        </button>
      ))}
    </div>
  );
}

export function defaultMemoryModalTab(note: LtmNote): MemoryModalTab {
  return isSourceSummaryNote(note) ? "suggestions" : "overview";
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
    const hasLinks = note.links.length > 0 || sourceLinkIds(note).length > 0 || isSourceNote;
    return [
      { id: "overview" as const, label: "Overview" },
      { id: "content" as const, label: "Content" },
      ...(hasLinks || mode === "edit" ? [{ id: "links" as const, label: "Links" }] : []),
      ...(!isSourceNote ? [{ id: "recall" as const, label: "Recall" }] : []),
      ...(isSourceNote ? [{ id: "suggestions" as const, label: "Suggestions" }] : []),
    ];
  }, [isSourceNote, mode, note]);
  const safeActiveTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : tabs[0]?.id ?? "overview";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={note ? humanMemoryTitle(note, chatLookup) : "Long-Term Memory"}
      width="max-w-4xl"
    >
      {note && (
        <div className="grid gap-4">
          <div className="grid gap-3 rounded-lg bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[var(--foreground)]" title={humanMemoryTitle(note, chatLookup)}>
                {humanMemoryTitle(note, chatLookup)}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <StatusPill label={isSourceNote ? sourceTypeLabel(note) : friendlyNoteType(note.type)} />
                <StatusPill label={friendlyStatus(note.status)} tone={note.status === "active" ? "good" : "neutral"} />
                {note.modes.map((item) => (
                  <StatusPill key={item} label={friendlyMode(item)} />
                ))}
                {note.links.length > 0 && <StatusPill label={`${note.links.length} linked memor${note.links.length === 1 ? "y" : "ies"}`} />}
                {editorDirty && <StatusPill label="Unsaved changes" tone="warn" />}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              {mode === "view" ? (
                <ToolButton onClick={() => onModeChange("edit")}>
                  <Pencil size="0.875rem" />
                  Edit
                </ToolButton>
              ) : (
                <ToolButton onClick={() => onModeChange("view")}>
                  Cancel
                </ToolButton>
              )}
            </div>
          </div>

          {mode === "view" && (
            <>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--secondary)]/45 p-1 ring-1 ring-[var(--border)] sm:grid-cols-5">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => onTabChange(tab.id)}
                    className={cn(
                      "min-h-9 rounded-lg px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60",
                      safeActiveTab === tab.id
                        ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm ring-1 ring-[var(--border)]"
                        : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {safeActiveTab === "overview" && (
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
              )}
              {safeActiveTab === "content" && <MemoryContentsPanel note={note} displayContext={displayContext} />}
              {safeActiveTab === "links" && (
                <GraphLinks links={note.links} noteLookup={noteLookup} chatLookup={chatLookup} onOpenNote={onOpenNote} />
              )}
              {safeActiveTab === "recall" && !isSourceNote && (
                <MemoryRecallPanel
                  note={note}
                  result={recallResult}
                  pending={recallPending}
                  query={recallQuery}
                  onQueryChange={onRecallQueryChange}
                  onRun={onRunRecall}
                />
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
            </>
          )}

          {mode === "edit" && (
            <LongTermMemoryNoteEditor
              note={note}
              onCancel={() => onModeChange("view")}
              onDirtyChange={onEditorDirtyChange}
              onSaved={onSaved}
              onRecoverDroppedCandidate={onRecoverDroppedCandidate}
              extractionPrefs={extractionPrefs}
              embedded
              displayContext={displayContext}
            />
          )}
        </div>
      )}
    </Modal>
  );
}
