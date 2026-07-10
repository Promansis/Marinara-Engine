import {
  getLtmScopeChatIds,
  hasLtmSourceSummarySceneTag,
  isLtmSourceLikeNote,
  ltmDraftMutationSchema,
  withMergedLtmScopeLinks,
  type LtmDraftMutation,
  type LtmExtractionDraft,
  type LtmLink,
  type LtmNote,
  type LtmSection,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { nowIso, uniqueStrings } from "./ltm-utils.js";
import { recordLtmDebugEvent, withLtmDebugOperation } from "./debug-log.js";
import { LongTermMemoryDraftStore } from "./draft-store.js";
import { rebuildLongTermMemoryIndexes } from "./rebuild.js";
import { canUpdateLtmScopedTarget } from "./scoped-targets.js";
import { LongTermMemoryStorage, type UpdateLtmNotePatch } from "./storage.js";

export interface ApplyLtmDraftOptions {
  root?: string;
  actor?: string;
  rebuildIndexes?: boolean;
  autoApplyLowRiskOnly?: boolean;
  mutationIds?: string[];
  editedMutations?: Array<{ id: string } & Record<string, unknown>>;
  operationId?: string;
}

export interface ApplyLtmDraftResult {
  draft: LtmExtractionDraft;
  appliedMutationIds: string[];
  skippedMutationIds: string[];
  autoIncludedMutationIds: string[];
  indexRebuild:
    | { status: "not_requested" }
    | { status: "succeeded" }
    | { status: "failed"; error: string };
}



function withEvidence(section: LtmSection, evidence: string[]) {
  return {
    ...section,
    evidence: Array.from(new Set([...(section.evidence ?? []), ...evidence])).slice(0, 100),
  } satisfies LtmSection;
}

function noteIdForMutation(mutation: LtmDraftMutation): string {
  if (mutation.kind === "create_note") return mutation.note.id;
  return mutation.noteId;
}

function groupMutationsByNote(mutations: LtmDraftMutation[]): LtmDraftMutation[][] {
  const groups = new Map<string, LtmDraftMutation[]>();
  for (const mutation of mutations) {
    const id = noteIdForMutation(mutation);
    const group = groups.get(id);
    if (group) {
      group.push(mutation);
    } else {
      groups.set(id, [mutation]);
    }
  }
  return Array.from(groups.values()).map((group) => [
    ...group.filter((mutation) => mutation.kind === "create_note"),
    ...group.filter((mutation) => mutation.kind !== "create_note"),
  ]);
}

function appendSection(
  existing: LtmSection | undefined,
  mutation: Extract<LtmDraftMutation, { kind: "append_section" }>,
) {
  const timestamp = nowIso();
  const nextText = appendText(existing?.text, mutation.text);
  return withEvidence(
    {
      text: nextText,
      updatedAt: timestamp,
      salience: mutation.salience ?? existing?.salience,
      confidence: Math.max(existing?.confidence ?? 0, mutation.confidence),
      importance: mutation.importance ?? existing?.importance,
      dimensions: mutation.dimensions ?? existing?.dimensions,
      dimensionChanges: mutation.dimensionChanges ?? existing?.dimensionChanges,
    },
    mutation.evidence,
  );
}

function appendText(existing: string | undefined, incoming: string) {
  const trimmedIncoming = incoming.trim();
  const trimmedExisting = existing?.trim();
  if (!trimmedIncoming) return trimmedExisting ?? "";
  if (!trimmedExisting) return trimmedIncoming;
  if (trimmedExisting.includes(trimmedIncoming)) return trimmedExisting;
  return `${trimmedExisting}\n\n${trimmedIncoming}`;
}

function shouldAppendCreateNoteSection(note: Pick<LtmNote, "type" | "tags">, sectionKey: string) {
  if (note.type === "timeline_event") return true;
  if (note.type === "relationship" && sectionKey === "history") return true;
  if (note.type === "tone" && sectionKey === "observations") return true;
  if (note.tags.includes("anchor")) return true;
  return false;
}

function mergeSection(existing: LtmSection | undefined, incoming: LtmSection, append: boolean): LtmSection {
  return withEvidence(
    {
      text: append ? appendText(existing?.text, incoming.text) : incoming.text.trim(),
      updatedAt: nowIso(),
      salience: Math.max(existing?.salience ?? 0, incoming.salience ?? 0) || undefined,
      confidence: Math.max(existing?.confidence ?? 0, incoming.confidence ?? 0) || undefined,
      importance: incoming.importance ?? existing?.importance,
      dimensions: incoming.dimensions ?? existing?.dimensions,
      dimensionChanges: incoming.dimensionChanges ?? existing?.dimensionChanges,
    },
    [...(existing?.evidence ?? []), ...(incoming.evidence ?? [])],
  );
}

function uniqueLinks(links: LtmLink[]) {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.target}\u0000${link.relation}\u0000${link.aspect ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceLinkFromDraft(draft: LtmExtractionDraft): LtmLink | null {
  return draft.source.sourceNoteId ? { target: draft.source.sourceNoteId, relation: "extracted_from" } : null;
}

function withSourceLink(noteId: string, links: LtmLink[], draft: LtmExtractionDraft) {
  const sourceLink = sourceLinkFromDraft(draft);
  if (!sourceLink || sourceLink.target === noteId) return uniqueLinks(links);
  return uniqueLinks([...links, sourceLink]);
}



function mergeScopes(existing: LtmNote["scope"], incoming: LtmNote["scope"]) {
  return {
    ...withMergedLtmScopeLinks(existing, {
      chatIds: getLtmScopeChatIds(incoming),
      characterIds: incoming.characterIds ?? [],
    }),
    groupId: existing.groupId ?? incoming.groupId,
  };
}

function isSourceSummaryNote(note: Pick<LtmNote, "type" | "tags">) {
  return isLtmSourceLikeNote(note);
}

function applyEditedDraftMutations(
  mutations: LtmDraftMutation[],
  edits: NonNullable<ApplyLtmDraftOptions["editedMutations"]>,
) {
  const mutationsById = new Map(mutations.map((mutation) => [mutation.id, mutation]));
  const editedById = new Map<string, LtmDraftMutation>();

  for (const edit of edits) {
    const original = mutationsById.get(edit.id);
    if (!original) {
      throw new Error(`Long-term memory edited mutation not found: ${edit.id}`);
    }
    if (editedById.has(edit.id)) {
      throw new Error(`Long-term memory edited mutation appears more than once: ${edit.id}`);
    }
    if (edit.kind !== undefined && edit.kind !== original.kind) {
      throw new Error(`Long-term memory edited mutation cannot change kind: ${edit.id}`);
    }

    const { id: _id, kind: _kind, ...patch } = edit;
    const parsed = ltmDraftMutationSchema.safeParse({
      ...original,
      ...patch,
      id: original.id,
      kind: original.kind,
    });
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? "schema validation failed";
      throw new Error(`Long-term memory edited mutation is invalid (${edit.id}): ${reason}`);
    }
    editedById.set(edit.id, parsed.data);
  }

  return mutations.map((mutation) => editedById.get(mutation.id) ?? mutation);
}

async function preflightDraftMutations(
  storage: LongTermMemoryStorage,
  draft: LtmExtractionDraft,
  mutations: LtmDraftMutation[],
): Promise<void> {
  const sourceNoteId = draft.source.sourceNoteId;
  const sourceNote = sourceNoteId ? await storage.getNote(sourceNoteId) : null;
  if (!sourceNote) {
    throw new Error(`Long-term memory draft source note not found: ${sourceNoteId ?? "unknown"}`);
  }
  if (!isSourceSummaryNote(sourceNote)) {
    throw new Error(`Long-term memory draft source is not a source note: ${sourceNote.id}`);
  }
  const createIds = new Set<string>();
  const requiredNoteIds = new Set<string>();
  const linkTargetIds = new Set<string>();
  const sourceExtractionDraft = Boolean(draft.source.sourceNoteId);

  for (const mutation of mutations) {
    if (mutation.kind === "create_note") {
      if (sourceExtractionDraft && (isSourceSummaryNote(mutation.note) || mutation.note.type === "scene")) {
        throw new Error(
          `Long-term memory source extraction draft cannot create scene/source notes: ${mutation.note.id}`,
        );
      }
      if (createIds.has(mutation.note.id)) {
        throw new Error(`Long-term memory draft creates the same note more than once: ${mutation.note.id}`);
      }
      createIds.add(mutation.note.id);
      for (const link of mutation.note.links) linkTargetIds.add(link.target);
      continue;
    }
    requiredNoteIds.add(mutation.noteId);
    if (mutation.kind === "add_link") linkTargetIds.add(mutation.link.target);
  }

  const externalLinkTargetIds = Array.from(linkTargetIds).filter((noteId) => !createIds.has(noteId));
  const externalRequiredNoteIds = Array.from(requiredNoteIds).filter((noteId) => !createIds.has(noteId));
  const existingNotes = await storage.getNotesByIds(
    Array.from(new Set([...externalLinkTargetIds, ...externalRequiredNoteIds, ...createIds])),
  );
  for (const noteId of externalLinkTargetIds) {
    if (!existingNotes.has(noteId)) {
      throw new Error(`Long-term memory draft link target not found: ${noteId}`);
    }
  }

  for (const noteId of externalRequiredNoteIds) {
    const existing = existingNotes.get(noteId);
    if (!existing) {
      throw new Error(`Long-term memory draft mutation target not found: ${noteId}`);
    }
    if (sourceExtractionDraft && (isSourceSummaryNote(existing) || existing.type === "scene")) {
      throw new Error(`Long-term memory source extraction draft cannot mutate scene/source notes: ${noteId}`);
    }
    if (!canUpdateLtmScopedTarget(existing.scope, draft.scope)) {
      throw new Error(`Long-term memory draft cannot mutate ${noteId} because it belongs to another scope.`);
    }
  }

  for (const mutation of mutations) {
    if (mutation.kind !== "create_note") continue;
    if (!canUpdateLtmScopedTarget(mutation.note.scope, draft.scope)) {
      throw new Error(
        `Long-term memory draft cannot create ${mutation.note.id} because its scope does not match the draft.`,
      );
    }
    const existing = existingNotes.get(mutation.note.id);
    if (existing && !canUpdateLtmScopedTarget(existing.scope, mutation.note.scope)) {
      throw new Error(
        `Long-term memory draft cannot merge scoped create ${mutation.note.id} into an existing note from another scope.`,
      );
    }
  }
}

function mutationTouchesSceneId(mutation: LtmDraftMutation) {
  if (mutation.kind === "create_note") return mutation.note.id.startsWith("scene_");
  return (
    mutation.noteId.startsWith("scene_") || (mutation.kind === "add_link" && mutation.link.target.startsWith("scene_"))
  );
}

function mutationHasSourceSummaryTag(mutation: LtmDraftMutation) {
  return mutation.kind === "create_note" && hasLtmSourceSummarySceneTag(mutation.note.tags);
}

export function isLowRiskSourceExtractionMutation(mutation: LtmDraftMutation) {
  if (mutation.risk !== "low") return false;
  if (mutationTouchesSceneId(mutation) || mutationHasSourceSummaryTag(mutation)) return false;
  if (mutation.kind === "create_note" && mutation.note.conflicts?.length) return false;
  return true;
}

export const isLowRiskAutoApplyMutation = isLowRiskSourceExtractionMutation;

async function filterAutoApplyMutationsWithDependencies(storage: LongTermMemoryStorage, mutations: LtmDraftMutation[]) {
  const selectedCreateIds = new Set(
    mutations.flatMap((mutation) => (mutation.kind === "create_note" ? [mutation.note.id] : [])),
  );
  const linkMutations = mutations.filter((mutation) => mutation.kind === "add_link");
  const createLinks = mutations.flatMap((mutation) =>
    mutation.kind === "create_note" ? mutation.note.links.map((link) => link.target) : [],
  );
  if (linkMutations.length === 0 && createLinks.length === 0) return mutations;

  const targetExists = new Map<string, boolean>();
  const targets = Array.from(new Set([...linkMutations.map((mutation) => mutation.link.target), ...createLinks]));
  const existingTargets = await storage.getNotesByIds(targets.filter((target) => !selectedCreateIds.has(target)));
  for (const target of targets) {
    if (selectedCreateIds.has(target)) {
      targetExists.set(target, true);
      continue;
    }
    targetExists.set(target, existingTargets.has(target));
  }

  let selected = mutations;
  while (true) {
    const selectedCreates = new Set(
      selected.flatMap((mutation) => (mutation.kind === "create_note" ? [mutation.note.id] : [])),
    );
    const next = selected.filter((mutation) => {
      if (mutation.kind === "add_link") {
        return targetExists.get(mutation.link.target) === true || selectedCreates.has(mutation.link.target);
      }
      if (mutation.kind === "create_note") {
        return mutation.note.links.every(
          (link) => targetExists.get(link.target) === true || selectedCreates.has(link.target),
        );
      }
      return true;
    });
    if (next.length === selected.length) return selected;
    selected = next;
  }
}

async function applyMutation(
  storage: LongTermMemoryStorage,
  draft: LtmExtractionDraft,
  mutation: LtmDraftMutation,
  actor: string,
) {
  const eventContext = {
    actor,
    cause: `draft.${draft.id}`,
    summary: mutation.summary,
    payload: {
      draftId: draft.id,
      mutationId: mutation.id,
      mutationKind: mutation.kind,
      evidence: mutation.evidence,
    },
  };

  if (mutation.kind === "create_note") {
    const existing = await storage.getNote(mutation.note.id);
    if (!existing) {
      await storage.createNote(
        {
          ...mutation.note,
          links: withSourceLink(mutation.note.id, mutation.note.links, draft),
        },
        eventContext,
      );
      return;
    }
    if (!canUpdateLtmScopedTarget(existing.scope, mutation.note.scope)) {
      throw new Error(
        `Long-term memory draft cannot merge scoped create ${mutation.note.id} into an existing note from another scope.`,
      );
    }

    const sections: LtmNote["sections"] = { ...existing.sections };
    for (const [sectionKey, section] of Object.entries(mutation.note.sections)) {
      sections[sectionKey] = mergeSection(
        existing.sections[sectionKey],
        section,
        shouldAppendCreateNoteSection(mutation.note, sectionKey),
      );
    }

    await storage.updateNote(
      existing.id,
      {
        status: existing.status === "archived" ? existing.status : mutation.note.status,
        modes: uniqueStrings([...existing.modes, ...mutation.note.modes]) as LtmNote["modes"],
        scope: mergeScopes(existing.scope, mutation.note.scope),
        tags: uniqueStrings([...existing.tags, ...mutation.note.tags]),
        links: withSourceLink(existing.id, uniqueLinks([...existing.links, ...mutation.note.links]), draft),
        sections,
        conflicts: mutation.note.conflicts?.length
          ? [...(existing.conflicts ?? []), ...mutation.note.conflicts]
          : existing.conflicts,
      },
      eventContext,
    );
    return;
  }

  const existing = await storage.getNote(mutation.noteId);
  if (!existing) {
    throw new Error(`Long-term memory note not found for draft mutation: ${mutation.noteId}`);
  }
  if (!canUpdateLtmScopedTarget(existing.scope, draft.scope)) {
    throw new Error(
      `Long-term memory draft cannot mutate ${mutation.noteId} because it belongs to another scope.`,
    );
  }

  let patch: UpdateLtmNotePatch;
  if (mutation.kind === "append_section") {
    patch = {
      sections: {
        ...existing.sections,
        [mutation.sectionKey]: appendSection(existing.sections[mutation.sectionKey], mutation),
      },
    };
  } else if (mutation.kind === "update_section") {
    patch = {
      sections: {
        ...existing.sections,
        [mutation.sectionKey]: withEvidence(mutation.section, mutation.evidence),
      },
    };
  } else if (mutation.kind === "add_link") {
    patch = { links: uniqueLinks([...existing.links, mutation.link]) };
  } else if (mutation.kind === "set_keywords") {
    patch = { keywords: mutation.keywords };
  } else if (mutation.kind === "set_status") {
    patch = { status: mutation.status };
  } else {
    const _exhaustive: never = mutation;
    throw new Error(`Unsupported mutation kind: ${(_exhaustive as LtmDraftMutation).kind}`);
  }

  patch = {
    ...patch,
    links: withSourceLink(existing.id, patch.links ?? existing.links, draft),
  };

  try {
    await storage.updateNote(existing.id, patch, eventContext);
  } catch (err) {
    logger.error(err, "[ltm] Failed to apply draft mutation %s to note %s", mutation.id, mutation.noteId);
    throw err;
  }
}

export async function applyLongTermMemoryDraft(
  draftId: string,
  options: ApplyLtmDraftOptions = {},
): Promise<ApplyLtmDraftResult> {
  return withLtmDebugOperation(
    {
      root: options.root,
      operationId: options.operationId,
      phase: "apply",
      action: "apply_draft",
      draftId,
      details: {
        actor: options.actor,
        mutationIds: options.mutationIds,
        autoApplyLowRiskOnly: options.autoApplyLowRiskOnly,
      },
    },
    async (operationId) => applyLongTermMemoryDraftInner(draftId, { ...options, operationId }),
  );
}

async function applyLongTermMemoryDraftInner(
  draftId: string,
  options: ApplyLtmDraftOptions & { operationId: string },
): Promise<ApplyLtmDraftResult> {
  const store = new LongTermMemoryDraftStore(options.root);
  return store.withDraftLock(draftId, async () => {
    const draft = await store.getDraft(draftId);
    if (!draft) {
      throw new Error(`Long-term memory draft not found: ${draftId}`);
    }
    if (draft.status !== "pending") {
      throw new Error(`Long-term memory draft is not pending: ${draftId}`);
    }
    if (!draft.source.sourceNoteId) {
      throw new Error(`Long-term memory draft is not tied to a source note: ${draftId}`);
    }
    const mutationIds = new Set<string>();
    for (const mutation of draft.mutations) {
      if (mutationIds.has(mutation.id)) {
        throw new Error(`Long-term memory draft has duplicate mutation id: ${mutation.id}`);
      }
      mutationIds.add(mutation.id);
    }

    const storage = new LongTermMemoryStorage(options.root);
    const actor = options.actor ?? (options.autoApplyLowRiskOnly ? "auto_low_risk" : "maintenance_api");
    const appliedMutationIds: string[] = [];
    const selectedMutationIds = options.mutationIds ? new Set(options.mutationIds) : null;
    const previouslyAppliedMutationIds = new Set(draft.appliedMutationIds ?? []);
    const unknownMutationIds = options.mutationIds?.filter(
      (mutationId) => !draft.mutations.some((mutation) => mutation.id === mutationId),
    );
    if (unknownMutationIds?.length) {
      throw new Error(`Long-term memory draft mutation not found: ${unknownMutationIds.join(", ")}`);
    }
    if (options.editedMutations?.length) {
      for (const edit of options.editedMutations) {
        if (selectedMutationIds && !selectedMutationIds.has(edit.id)) {
          throw new Error(`Long-term memory edited mutation was not selected: ${edit.id}`);
        }
        if (previouslyAppliedMutationIds.has(edit.id)) {
          throw new Error(`Long-term memory edited mutation was already applied: ${edit.id}`);
        }
      }
      draft.mutations = applyEditedDraftMutations(draft.mutations, options.editedMutations);
    }
    const lowRiskMutations = draft.mutations.filter((mutation) => {
      if (selectedMutationIds && !selectedMutationIds.has(mutation.id)) return false;
      if (options.autoApplyLowRiskOnly && !isLowRiskSourceExtractionMutation(mutation)) return false;
      return true;
    });
    let mutationsToApply = options.autoApplyLowRiskOnly
      ? await filterAutoApplyMutationsWithDependencies(storage, lowRiskMutations)
      : lowRiskMutations;

    const autoIncludedMutationIds: string[] = [];
    if (
      options.mutationIds &&
      options.mutationIds.length > 0 &&
      !options.autoApplyLowRiskOnly
    ) {
      const selectedSet = new Set(options.mutationIds);
      const targetNoteIds = new Set(
        mutationsToApply
          .filter((m) => m.kind !== "create_note")
          .map((m) => (m as { noteId: string }).noteId),
      );
      const depCreateMutations = (
        draft.mutations.filter(
          (m) => m.kind === "create_note",
        ) as Extract<LtmDraftMutation, { kind: "create_note" }>[]
      ).filter(
        (m) => !selectedSet.has(m.id) && targetNoteIds.has(m.note.id),
      );
      if (depCreateMutations.length > 0) {
        const existingDepNotes = await storage.getNotesByIds(depCreateMutations.map((m) => m.note.id));
        const toInclude = depCreateMutations.filter((m) => !existingDepNotes.has(m.note.id));
        if (toInclude.length > 0) {
          autoIncludedMutationIds.push(...toInclude.map((m) => m.id));
          mutationsToApply = [...toInclude, ...mutationsToApply];
        }
      }
    }

    const selectedMutations = mutationsToApply;
    mutationsToApply = selectedMutations.filter((mutation) => !previouslyAppliedMutationIds.has(mutation.id));
    const skippedMutationIds = draft.mutations
      .filter(
        (mutation) =>
          !previouslyAppliedMutationIds.has(mutation.id) &&
          !selectedMutations.some((candidate) => candidate.id === mutation.id),
      )
      .map((mutation) => mutation.id);
    await recordLtmDebugEvent({
      root: options.root,
      operationId: options.operationId,
      phase: "apply",
      action: "mutations_selected",
      status: mutationsToApply.length > 0 ? "ok" : options.autoApplyLowRiskOnly ? "skipped" : "warning",
      draftId,
      sourceNoteId: draft.source.sourceNoteId,
      mutationIds: selectedMutations.map((mutation) => mutation.id),
      counts: {
        totalMutations: draft.mutations.length,
        selectedMutations: selectedMutations.length,
        pendingMutations: mutationsToApply.length,
        skippedMutations: skippedMutationIds.length,
      },
      details: {
        skippedMutationIds,
        selectedKinds: selectedMutations.reduce<Record<string, number>>((counts, mutation) => {
          counts[mutation.kind] = (counts[mutation.kind] ?? 0) + 1;
          return counts;
        }, {}),
      },
    });

    if (selectedMutations.length === 0) {
      if (options.autoApplyLowRiskOnly) {
        return {
          draft,
          appliedMutationIds,
          skippedMutationIds,
          autoIncludedMutationIds,
          indexRebuild: { status: "not_requested" },
        };
      }
      throw new Error(`Long-term memory draft has no mutations selected for apply: ${draftId}`);
    }

    await preflightDraftMutations(storage, draft, selectedMutations);

    const groups = groupMutationsByNote(mutationsToApply);
    let progressDraft = draft;
    if (mutationsToApply.length > 0) {
      const applyingDraft = await store.updateDraft(draft.id, {
        applyState: "applying",
        mutations: draft.mutations,
      });
      if (!applyingDraft) {
        throw new Error(`Long-term memory draft disappeared during apply: ${draftId}`);
      }
      progressDraft = applyingDraft;
    }
    for (const group of groups) {
      for (const mutation of group) {
        await applyMutation(storage, draft, mutation, actor);
        appliedMutationIds.push(mutation.id);
        const checkpoint = await store.updateDraft(draft.id, {
          applyState: "applying",
          appliedAt: progressDraft.appliedAt ?? nowIso(),
          appliedMutationIds: Array.from(
            new Set([...(progressDraft.appliedMutationIds ?? []), mutation.id]),
          ),
        });
        if (!checkpoint) {
          throw new Error(`Long-term memory draft disappeared during apply: ${draftId}`);
        }
        progressDraft = checkpoint;
      }
    }

    const partialApply = skippedMutationIds.length > 0;
    const status = options.autoApplyLowRiskOnly && !partialApply ? "auto_applied" : partialApply ? "pending" : "accepted";
    const remainingMutations = partialApply
      ? draft.mutations.filter((mutation) => skippedMutationIds.includes(mutation.id))
      : draft.mutations;
    const committedMutationIds = new Set(progressDraft.appliedMutationIds ?? []);
    const committedSelectedMutationCount = selectedMutations.filter((mutation) =>
      committedMutationIds.has(mutation.id),
    ).length;
    const shouldRebuild =
      options.rebuildIndexes !== false &&
      selectedMutations.some((mutation) => committedMutationIds.has(mutation.id));
    const updated = await store.updateDraftStatus(draft.id, status, {
      appliedAt: progressDraft.appliedAt,
      applyState: partialApply ? "not_started" : "complete",
      indexRebuildStatus: shouldRebuild ? "pending" : "not_requested",
      indexRebuildAt: shouldRebuild ? nowIso() : undefined,
      indexRebuildError: undefined,
      mutations: remainingMutations,
      appliedMutationIds: Array.from(
        new Set([...(progressDraft.appliedMutationIds ?? []), ...appliedMutationIds]),
      ),
      skippedMutationIds,
    });
    if (!updated) {
      throw new Error(`Long-term memory draft disappeared during apply: ${draftId}`);
    }

    let finalDraft = updated;
    let indexRebuild: ApplyLtmDraftResult["indexRebuild"] = { status: "not_requested" };
    if (shouldRebuild) {
      let rebuildFailure: { error: unknown } | null = null;
      try {
        await rebuildLongTermMemoryIndexes({ root: options.root, scope: "typed" });
      } catch (error) {
        rebuildFailure = { error };
      }

      if (!rebuildFailure) {
        const rebuiltDraft = await store
          .updateDraft(draft.id, {
            indexRebuildStatus: "succeeded",
            indexRebuildAt: nowIso(),
            indexRebuildError: undefined,
          })
          .catch((persistError) => {
            logger.error(persistError, "[ltm] Failed to persist rebuild success for draft %s", draft.id);
            return null;
          });
        if (rebuiltDraft) finalDraft = rebuiltDraft;
        indexRebuild = { status: "succeeded" };
        await recordLtmDebugEvent({
          root: options.root,
          operationId: options.operationId,
          phase: "rebuild",
          action: "apply_rebuild_indexes",
          status: "ok",
          draftId,
          counts: { appliedMutations: committedSelectedMutationCount },
          details: { scope: "typed" },
        });
      } else {
        const err = rebuildFailure.error;
        const rawError = err instanceof Error ? err.message : String(err);
        const error = (rawError.trim() || "Long-term memory index rebuild failed").slice(0, 2_000);
        const failedDraft = await store
          .updateDraft(draft.id, {
            indexRebuildStatus: "failed",
            indexRebuildAt: nowIso(),
            indexRebuildError: error,
          })
          .catch((persistError) => {
            logger.error(persistError, "[ltm] Failed to persist rebuild failure for draft %s", draft.id);
            return null;
          });
        if (failedDraft) finalDraft = failedDraft;
        indexRebuild = { status: "failed", error };
        logger.error(err, "[ltm] Index rebuild failed after committing draft %s", draft.id);
        await recordLtmDebugEvent({
          root: options.root,
          operationId: options.operationId,
          phase: "rebuild",
          action: "apply_rebuild_indexes",
          status: "error",
          draftId,
          counts: { appliedMutations: committedSelectedMutationCount },
          details: { scope: "typed", mutationsCommitted: true },
          error: err,
        });
      }
    }

    return {
      draft: finalDraft,
      appliedMutationIds,
      skippedMutationIds,
      autoIncludedMutationIds,
      indexRebuild,
    };
  });
}
