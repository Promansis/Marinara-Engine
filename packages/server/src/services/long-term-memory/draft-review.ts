import {
  isLtmSourceLikeNote,
  ltmDraftReviewResponseSchema,
  type LtmDraftBlockReason,
  type LtmDraftFreshness,
  type LtmDraftReviewDraft,
  type LtmDraftReviewMutation,
  type LtmDraftReviewResponse,
  type LtmDraftReviewSource,
  type LtmDraftReviewTarget,
  type LtmDraftStatus,
  type LtmExtractionDiagnostic,
  type LtmNote,
} from "@marinara-engine/shared";
import { noteIdForLtmDraftMutation, projectLtmDraftOntoNotes } from "./draft-projector.js";
import { LongTermMemoryDraftStore } from "./draft-store.js";
import { nowIso, uniqueStrings } from "./ltm-utils.js";
import { sourceHashForLtmSourceNote } from "./source-hash.js";
import { LongTermMemoryStorage } from "./storage.js";

export type ProjectLtmDraftReviewOptions = {
  root?: string;
  sourceNoteId?: string;
  chatId?: string;
  status?: LtmDraftStatus;
};

type MutableReviewSource = {
  sourceNoteId: string;
  modes: Set<LtmNote["modes"][number]>;
  drafts: LtmDraftReviewDraft[];
  targets: Map<string, LtmDraftReviewTarget>;
};

export async function projectLongTermMemoryDraftReview(
  options: ProjectLtmDraftReviewOptions = {},
): Promise<LtmDraftReviewResponse> {
  const store = new LongTermMemoryDraftStore(options.root);
  const storage = new LongTermMemoryStorage(options.root);
  const drafts = (await store.listDrafts({ status: options.status ?? "pending", chatId: options.chatId })).sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const targetNoteIds = uniqueStrings(drafts.flatMap((draft) => draft.mutations.map(noteIdForLtmDraftMutation)));
  const overlay = await storage.getNotesByIds(targetNoteIds);
  const sources = new Map<string, MutableReviewSource>();

  for (const draft of drafts) {
    const sourceNoteId = draft.source.sourceNoteId;
    if (!sourceNoteId) continue;
    const includeInResponse = !options.sourceNoteId || sourceNoteId === options.sourceNoteId;
    const source = includeInResponse
      ? (sources.get(sourceNoteId) ?? {
          sourceNoteId,
          modes: new Set<LtmNote["modes"][number]>(),
          drafts: [],
          targets: new Map<string, LtmDraftReviewTarget>(),
        })
      : null;
    if (source) {
      sources.set(sourceNoteId, source);
      for (const mode of draft.modes) source.modes.add(mode);
    }

    const sourceNote = await storage.getNote(sourceNoteId);
    const freshness = draftFreshness(draft, sourceNote);
    const blockReasons = blockReasonsForDraft(draft, freshness);
    const mutationIds = new Set(draft.mutations.map((mutation) => mutation.id));
    const rowDiagnostics = new Map<string, LtmExtractionDiagnostic[]>();
    const deduplications: LtmExtractionDiagnostic[] = [];
    const draftDiagnostics: LtmExtractionDiagnostic[] = [];
    for (const diagnostic of draft.diagnostics ?? []) {
      if (diagnostic.code === "deduplicated_evidence_unit") {
        deduplications.push(diagnostic);
        continue;
      }
      if (diagnostic.mutationId && mutationIds.has(diagnostic.mutationId)) {
        const current = rowDiagnostics.get(diagnostic.mutationId) ?? [];
        current.push(diagnostic);
        rowDiagnostics.set(diagnostic.mutationId, current);
        continue;
      }
      draftDiagnostics.push(diagnostic);
    }

    if (draft.mutations.length > 0) {
      try {
        const draftProjection = projectLtmDraftOntoNotes({
          notes: overlay,
          mutations: draft.mutations,
          context: { source: draft.source, scope: draft.scope, modes: draft.modes },
          timestamp: nowIso(),
        });
        const mutationsById = new Map(draft.mutations.map((mutation) => [mutation.id, mutation]));
        for (const noteProjection of draftProjection.projections) {
          const rows: LtmDraftReviewMutation[] = noteProjection.mutations.map((mutationProjection) => ({
            draftId: draft.id,
            mutation: mutationsById.get(mutationProjection.mutationId)!,
            disposition: mutationProjection.disposition,
            diagnostics: rowDiagnostics.get(mutationProjection.mutationId) ?? [],
            changes: mutationProjection.changes,
          }));
          if (source) {
            const target = source.targets.get(noteProjection.noteId);
            if (target) {
              target.rows.push(...rows);
              target.title = target.title ?? noteProjection.after.title;
            } else {
              source.targets.set(noteProjection.noteId, {
                noteId: noteProjection.noteId,
                title: noteProjection.after.title,
                noteType: noteProjection.after.type,
                rows,
              });
            }
          }
        }
        if (blockReasons.length === 0) {
          for (const projection of draftProjection.projections) overlay.set(projection.noteId, projection.after);
        }
      } catch (error) {
        blockReasons.push({
          code: "projection_failed",
          message: error instanceof Error ? error.message : "Draft projection failed.",
        });
      }
    }

    if (source) {
      source.drafts.push({
        draft,
        freshness,
        blockReasons,
        diagnostics: draftDiagnostics,
        candidateRejections: draft.extractionOutcome?.droppedCandidates ?? [],
        deduplications,
      });
    }
  }

  const projectedSources: LtmDraftReviewSource[] = [...sources.values()].map((source) => ({
    sourceNoteId: source.sourceNoteId,
    modes: [...source.modes],
    drafts: source.drafts,
    targets: [...source.targets.values()],
  }));
  const result = {
    generatedAt: nowIso(),
    sources: projectedSources,
    counts: {
      sources: projectedSources.length,
      drafts: projectedSources.reduce((sum, source) => sum + source.drafts.length, 0),
      mutations: projectedSources.reduce(
        (sum, source) => sum + source.drafts.reduce((draftSum, draft) => draftSum + draft.draft.mutations.length, 0),
        0,
      ),
      blockedDrafts: projectedSources.reduce(
        (sum, source) => sum + source.drafts.filter((draft) => draft.blockReasons.length > 0).length,
        0,
      ),
      candidateRejections: projectedSources.reduce(
        (sum, source) =>
          sum + source.drafts.reduce((draftSum, draft) => draftSum + draft.candidateRejections.length, 0),
        0,
      ),
      deduplications: projectedSources.reduce(
        (sum, source) => sum + source.drafts.reduce((draftSum, draft) => draftSum + draft.deduplications.length, 0),
        0,
      ),
    },
  };
  return ltmDraftReviewResponseSchema.parse(result);
}

function draftFreshness(draft: LtmDraftReviewDraft["draft"], sourceNote: LtmNote | null): LtmDraftFreshness {
  if (draft.status === "superseded") return "superseded";
  if (draft.status !== "pending") return "not_pending";
  if (!sourceNote) return "missing";
  if (!isLtmSourceLikeNote(sourceNote)) return "invalid";
  if (!draft.source.sourceHash) return "hashless";
  return sourceHashForLtmSourceNote(sourceNote) === draft.source.sourceHash ? "fresh" : "stale";
}

function blockReasonsForDraft(
  draft: LtmDraftReviewDraft["draft"],
  freshness: LtmDraftFreshness,
): LtmDraftBlockReason[] {
  const reasons: LtmDraftBlockReason[] = [];
  if (freshness === "missing") {
    reasons.push({ code: "source_missing", message: "The source note no longer exists." });
  } else if (freshness === "invalid") {
    reasons.push({ code: "source_invalid", message: "The source is no longer a source note." });
  } else if (freshness === "stale") {
    reasons.push({ code: "source_stale", message: "The source changed after this extraction." });
  } else if (freshness === "superseded") {
    reasons.push({ code: "draft_superseded", message: "A newer extraction superseded this draft." });
  } else if (freshness === "not_pending") {
    reasons.push({ code: "draft_not_pending", message: "This draft is no longer pending review." });
  }
  if (draft.mutations.length === 0) {
    reasons.push({ code: "no_mutations", message: "No mutation survived extraction." });
  }
  return reasons;
}
