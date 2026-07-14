import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, ChevronRight, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { LtmIdentityRepairCandidate, LtmScope } from "@marinara-engine/shared";
import {
  useApplyLongTermMemoryIdentityRepairs,
  useLongTermMemoryIdentityRepairPreview,
} from "../../hooks/use-long-term-memory";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { cn } from "../../lib/utils";
import { emptyStateClassName, helperTextClassName } from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";

type CandidateDecision = {
  selected: boolean;
  canonicalNoteId: string;
  excludedNoteIds: string[];
  sectionChoices: Record<string, string>;
};

interface LongTermMemoryIdentityRepairSectionProps {
  scope: LtmScope;
  scopeLabel: string;
  enabled: boolean;
}

function defaultDecision(candidate: LtmIdentityRepairCandidate): CandidateDecision {
  return {
    selected: false,
    canonicalNoteId: candidate.canonicalNoteId,
    excludedNoteIds: [],
    sectionChoices: Object.fromEntries(
      candidate.supersedingConflicts.map((conflict) => {
        const canonicalOption = conflict.options.find((option) => option.noteIds.includes(candidate.canonicalNoteId));
        return [conflict.sectionKey, canonicalOption?.noteIds[0] ?? conflict.options[0]!.noteIds[0]!];
      }),
    ),
  };
}

function basisLabel(basis: LtmIdentityRepairCandidate["matchBasis"][number]) {
  if (basis === "bound_subjects") return "Already bound";
  if (basis === "exact_name") return "Exact name";
  if (basis === "unique_alias") return "Unique alias";
  if (basis === "trait_or_qualified_alias") return "Qualified alias";
  return "Same pair";
}

function unresolvedReasonLabel(reason: "ambiguous" | "untrusted" | "invalid_cardinality") {
  if (reason === "ambiguous") return "Ambiguous identity";
  if (reason === "invalid_cardinality") return "Invalid subject count";
  return "No trusted match";
}

export function LongTermMemoryIdentityRepairSection({
  scope,
  scopeLabel,
  enabled,
}: LongTermMemoryIdentityRepairSectionProps) {
  const preview = useLongTermMemoryIdentityRepairPreview(scope, { enabled });
  const applyRepairs = useApplyLongTermMemoryIdentityRepairs();
  const [decisions, setDecisions] = useState<Record<string, CandidateDecision>>({});

  useEffect(() => {
    if (!preview.data) return;
    setDecisions((current) => {
      const next: Record<string, CandidateDecision> = {};
      for (const candidate of preview.data.candidates) {
        const existing = current[candidate.id];
        const noteIds = new Set(candidate.notes.map((note) => note.noteId));
        next[candidate.id] =
          existing && noteIds.has(existing.canonicalNoteId)
            ? {
                ...existing,
                excludedNoteIds: existing.excludedNoteIds.filter(
                  (noteId) => noteIds.has(noteId) && noteId !== existing.canonicalNoteId,
                ),
              }
            : defaultDecision(candidate);
      }
      return next;
    });
  }, [preview.data]);

  const selectedCandidates = useMemo(
    () =>
      (preview.data?.candidates ?? []).filter(
        (candidate) => decisions[candidate.id]?.selected && candidate.blockingReasons.length === 0,
      ),
    [decisions, preview.data?.candidates],
  );

  const patchDecision = (candidateId: string, patch: Partial<CandidateDecision>) => {
    setDecisions((current) => {
      const existing = current[candidateId];
      if (!existing) return current;
      return { ...current, [candidateId]: { ...existing, ...patch } };
    });
  };

  const selectCanonical = (candidate: LtmIdentityRepairCandidate, noteId: string) => {
    const decision = decisions[candidate.id] ?? defaultDecision(candidate);
    const sectionChoices = { ...decision.sectionChoices };
    for (const conflict of candidate.supersedingConflicts) {
      const option = conflict.options.find((candidateOption) => candidateOption.noteIds.includes(noteId));
      if (option) sectionChoices[conflict.sectionKey] = noteId;
    }
    patchDecision(candidate.id, {
      canonicalNoteId: noteId,
      excludedNoteIds: decision.excludedNoteIds.filter((excludedId) => excludedId !== noteId),
      sectionChoices,
    });
  };

  const setNoteIncluded = (candidate: LtmIdentityRepairCandidate, noteId: string, included: boolean) => {
    const decision = decisions[candidate.id] ?? defaultDecision(candidate);
    if (noteId === decision.canonicalNoteId) return;
    const excluded = new Set(decision.excludedNoteIds);
    if (included) excluded.delete(noteId);
    else excluded.add(noteId);
    const sectionChoices = { ...decision.sectionChoices };
    for (const conflict of candidate.supersedingConflicts) {
      const selectedNoteId = sectionChoices[conflict.sectionKey];
      if (!selectedNoteId || !excluded.has(selectedNoteId)) continue;
      const replacement = conflict.options
        .flatMap((option) => option.noteIds)
        .find((candidateNoteId) => !excluded.has(candidateNoteId));
      if (replacement) sectionChoices[conflict.sectionKey] = replacement;
    }
    patchDecision(candidate.id, { excludedNoteIds: [...excluded], sectionChoices });
  };

  const applySelected = async () => {
    if (selectedCandidates.length === 0) return;
    const confirmed = await showConfirmDialog({
      title: "Apply Identity Repairs?",
      message: `This will repair ${selectedCandidates.length} selected identit${selectedCandidates.length === 1 ? "y" : "ies"}, archive included duplicates, update references, and create a complete memory backup first.`,
      confirmLabel: "Apply repairs",
      tone: "destructive",
    });
    if (!confirmed) return;

    try {
      const result = await applyRepairs.mutateAsync({
        scope,
        repairs: selectedCandidates.map((candidate) => {
          const decision = decisions[candidate.id] ?? defaultDecision(candidate);
          return {
            candidateId: candidate.id,
            canonicalNoteId: decision.canonicalNoteId,
            excludedNoteIds: decision.excludedNoteIds,
            sectionChoices: candidate.supersedingConflicts.map((conflict) => ({
              sectionKey: conflict.sectionKey,
              noteId: decision.sectionChoices[conflict.sectionKey]!,
            })),
          };
        }),
      });
      const archivedCount = result.repairs.reduce((count, repair) => count + repair.archivedNoteIds.length, 0);
      toast.success(
        `Repaired ${result.repairs.length} identit${result.repairs.length === 1 ? "y" : "ies"} and archived ${archivedCount} duplicate${archivedCount === 1 ? "" : "s"}.`,
      );
      setDecisions({});
      await preview.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Identity repair failed");
    }
  };

  if (!enabled) {
    return <p className={emptyStateClassName}>Select a chat context to review identity repairs.</p>;
  }

  return (
    <div className="space-y-3" aria-label="Canonical identity repair">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)]/70 pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold text-[var(--foreground)]">Identity repair</h3>
            <StatusPill label={scopeLabel} />
            {preview.data ? (
              <StatusPill
                label={`${preview.data.counts.candidateCount} candidate${preview.data.counts.candidateCount === 1 ? "" : "s"}`}
              />
            ) : null}
          </div>
          {preview.data && preview.data.counts.unresolvedNotes > 0 ? (
            <p className={cn("mt-1", helperTextClassName)}>
              {preview.data.counts.unresolvedNotes} note{preview.data.counts.unresolvedNotes === 1 ? "" : "s"} need
              manual identity review.
            </p>
          ) : null}
        </div>
        <ToolButton onClick={() => void preview.refetch()} disabled={preview.isFetching || applyRepairs.isPending}>
          <RotateCcw size="0.8rem" className={preview.isFetching ? "animate-spin" : undefined} />
          Refresh
        </ToolButton>
      </div>

      {preview.isLoading ? (
        <div className="space-y-2" aria-label="Loading identity repair candidates">
          <div className="h-20 animate-pulse rounded-lg bg-[var(--secondary)]/45" />
          <div className="h-20 animate-pulse rounded-lg bg-[var(--secondary)]/35" />
        </div>
      ) : null}

      {preview.isError ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-[var(--destructive)]/10 p-3 ring-1 ring-[var(--destructive)]/30"
        >
          <AlertTriangle size="0.9rem" className="mt-0.5 shrink-0 text-[var(--destructive)]" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-[var(--foreground)]">Identity preview unavailable</p>
            <p className={cn("mt-1 break-words", helperTextClassName)}>{(preview.error as Error).message}</p>
          </div>
        </div>
      ) : null}

      {!preview.isLoading && !preview.isError && preview.data?.candidates.length === 0 ? (
        <p className={emptyStateClassName}>No trusted identity repairs found in this scope.</p>
      ) : null}

      <div className="space-y-2">
        {preview.data?.candidates.map((candidate) => {
          const decision = decisions[candidate.id] ?? defaultDecision(candidate);
          const excluded = new Set(decision.excludedNoteIds);
          const blocked = candidate.blockingReasons.length > 0;
          return (
            <details
              key={candidate.id}
              className="group rounded-lg bg-[var(--secondary)]/25 ring-1 ring-[var(--border)]"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-xs font-semibold text-[var(--foreground)]">
                      {candidate.subjectNames.join(" + ")}
                    </span>
                    <StatusPill label={candidate.noteType === "character" ? "Character" : "Relationship"} />
                    <StatusPill
                      label={
                        candidate.duplicateNoteIds.length > 0
                          ? `${candidate.duplicateNoteIds.length} duplicate${candidate.duplicateNoteIds.length === 1 ? "" : "s"}`
                          : "Metadata only"
                      }
                      tone={candidate.duplicateNoteIds.length > 0 ? "warn" : "neutral"}
                    />
                    {decision.selected ? <StatusPill label="Selected" tone="good" /> : null}
                  </div>
                  <p className={cn("mt-1 truncate", helperTextClassName)}>
                    Canonical:{" "}
                    {candidate.notes.find((note) => note.noteId === decision.canonicalNoteId)?.title ??
                      decision.canonicalNoteId}
                  </p>
                </div>
                <ChevronRight
                  size="0.9rem"
                  className="shrink-0 text-[var(--primary)] transition-transform duration-200 ease-out group-open:rotate-90"
                />
              </summary>

              <div className="space-y-4 border-t border-[var(--border)]/70 p-3">
                <label className="inline-flex min-h-8 items-center gap-2 text-xs font-semibold text-[var(--foreground)]">
                  <input
                    type="checkbox"
                    checked={decision.selected}
                    disabled={blocked || applyRepairs.isPending}
                    onChange={(event) => patchDecision(candidate.id, { selected: event.target.checked })}
                    className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                  />
                  Include this repair
                </label>
                {blocked ? (
                  <div
                    role="alert"
                    className="space-y-1 rounded-lg bg-[var(--destructive)]/10 p-3 text-xs text-[var(--destructive)] ring-1 ring-[var(--destructive)]/25"
                  >
                    {candidate.blockingReasons.map((reason) => (
                      <p key={reason}>{reason}</p>
                    ))}
                  </div>
                ) : null}

                <fieldset className="space-y-2">
                  <legend className="text-xs font-semibold text-[var(--foreground)]">Notes and canonical copy</legend>
                  {candidate.notes.map((matchedNote) => {
                    const isCanonical = decision.canonicalNoteId === matchedNote.noteId;
                    const included = !excluded.has(matchedNote.noteId);
                    return (
                      <div
                        key={matchedNote.noteId}
                        className="flex flex-wrap items-center gap-3 border-t border-[var(--border)]/60 py-2 first:border-t-0"
                      >
                        <label className="inline-flex min-w-0 flex-1 items-center gap-2 text-xs text-[var(--foreground)]">
                          <input
                            type="checkbox"
                            checked={included}
                            disabled={isCanonical || applyRepairs.isPending}
                            onChange={(event) => setNoteIncluded(candidate, matchedNote.noteId, event.target.checked)}
                            className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                          />
                          <span className="min-w-0 truncate">{matchedNote.title}</span>
                        </label>
                        <StatusPill
                          label={basisLabel(matchedNote.basis)}
                          tone={matchedNote.exactFullName ? "good" : "neutral"}
                        />
                        <label className="inline-flex items-center gap-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">
                          <input
                            type="radio"
                            name={`identity-canonical-${candidate.id}`}
                            checked={isCanonical}
                            disabled={!included || applyRepairs.isPending}
                            onChange={() => selectCanonical(candidate, matchedNote.noteId)}
                            className="h-4 w-4 accent-[var(--primary)]"
                          />
                          Canonical
                        </label>
                      </div>
                    );
                  })}
                </fieldset>

                {candidate.additiveContent.length > 0 ? (
                  <div className="space-y-2 border-t border-[var(--border)]/70 pt-3">
                    <h4 className="text-xs font-semibold text-[var(--foreground)]">Additive content</h4>
                    {candidate.additiveContent.map((addition) => (
                      <div key={addition.sectionKey}>
                        <StatusPill label={addition.sectionKey.replace(/_/g, " ")} tone="good" />
                        <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-[var(--background)]/65 p-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)] ring-1 ring-[var(--border)]/70">
                          {addition.addedLines.join("\n")}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {candidate.supersedingConflicts.map((conflict) => (
                  <fieldset key={conflict.sectionKey} className="space-y-2 border-t border-[var(--border)]/70 pt-3">
                    <legend className="text-xs font-semibold text-[var(--foreground)]">
                      Choose {conflict.sectionKey.replace(/_/g, " ")}
                    </legend>
                    {conflict.options.map((option) => {
                      const availableNoteId = option.noteIds.find((noteId) => !excluded.has(noteId));
                      const optionId = `${candidate.id}-${conflict.sectionKey}-${option.noteIds.join("-")}`;
                      return (
                        <label
                          key={optionId}
                          className={cn(
                            "flex items-start gap-2 rounded-lg p-2 text-xs ring-1 ring-[var(--border)]",
                            availableNoteId ? "bg-[var(--background)]/55" : "opacity-45",
                          )}
                        >
                          <input
                            type="radio"
                            name={`identity-conflict-${candidate.id}-${conflict.sectionKey}`}
                            checked={Boolean(
                              availableNoteId &&
                              option.noteIds.includes(decision.sectionChoices[conflict.sectionKey] ?? ""),
                            )}
                            disabled={!availableNoteId || applyRepairs.isPending}
                            onChange={() =>
                              availableNoteId &&
                              patchDecision(candidate.id, {
                                sectionChoices: { ...decision.sectionChoices, [conflict.sectionKey]: availableNoteId },
                              })
                            }
                            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]"
                          />
                          <span className="min-w-0 whitespace-pre-wrap text-[var(--foreground)]">{option.text}</span>
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
              </div>
            </details>
          );
        })}
      </div>

      {preview.data && preview.data.unresolved.length > 0 ? (
        <details className="group rounded-lg bg-amber-500/10 ring-1 ring-amber-500/30">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-xs font-semibold text-amber-700 dark:text-amber-100">
            <AlertTriangle size="0.85rem" />
            {preview.data.unresolved.length} unresolved note{preview.data.unresolved.length === 1 ? "" : "s"}
            <ChevronRight
              size="0.85rem"
              className="ml-auto shrink-0 transition-transform duration-200 ease-out group-open:rotate-90"
            />
          </summary>
          <div className="border-t border-amber-500/25 px-3 pb-3">
            {preview.data.unresolved.map((item) => (
              <div
                key={item.noteId}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 py-2 last:border-b-0"
              >
                <span className="min-w-0 truncate text-xs text-[var(--foreground)]">{item.title}</span>
                <StatusPill label={unresolvedReasonLabel(item.reason)} tone="warn" />
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {selectedCandidates.length > 0 || applyRepairs.isPending ? (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--card)] p-3 shadow-lg ring-1 ring-[var(--border)]">
          <div className="flex items-center gap-2 text-xs text-[var(--foreground)]">
            <ShieldCheck size="0.9rem" className="text-[var(--primary)]" />
            {selectedCandidates.length} selected
          </div>
          <ToolButton onClick={() => void applySelected()} disabled={applyRepairs.isPending} tone="primary">
            {applyRepairs.isPending ? <Loader2 size="0.85rem" className="animate-spin" /> : <Archive size="0.85rem" />}
            Apply repairs
          </ToolButton>
        </div>
      ) : null}
    </div>
  );
}
