import {
  getLtmScopeChatIds,
  hasLtmSourceSummarySceneTag,
  isLtmSourceLikeNote,
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
  return Array.from(groups.values());
}

function appendSection(
  existing: LtmSection | undefined,
  mutation: Extract<LtmDraftMutation, { kind: "append_section" }>,
) {
  const timestamp = nowIso();
  const nextText = existing?.text ? `${existing.text.trim()}\n\n${mutation.text.trim()}`.trim() : mutation.text.trim();
  return withEvidence(
    {
      text: nextText,
      updatedAt: timestamp,
      salience: mutation.salience ?? existing?.salience,
      confidence: Math.max(existing?.confidence ?? 0, mutation.confidence),
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
    },
    [...(existing?.evidence ?? []), ...(incoming.evidence ?? [])],
  );
}

function uniqueLinks(links: LtmLink[]) {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.target}\u0000${link.relation}`;
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

async function preflightDraftMutations(
  storage: LongTermMemoryStorage,
  draft: LtmExtractionDraft,
  mutations: LtmDraftMutation[],
): Promise<void> {
  const createIds = new Set<string>();
  const requiredNoteIds = new Set<string>();
  const sourceExtractionDraft = Boolean(draft.source.sourceNoteId);
  const sourceLikeMutationIds = new Set<string>();

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
      continue;
    }
    if (sourceExtractionDraft && (mutation.noteId.startsWith("source_") || mutation.noteId.startsWith("scene_"))) {
      sourceLikeMutationIds.add(mutation.noteId);
    }
    requiredNoteIds.add(mutation.noteId);
  }

  const sourceLikeNotes = await storage.getNotesByIds(Array.from(sourceLikeMutationIds));
  for (const noteId of sourceLikeMutationIds) {
    const existing = sourceLikeNotes.get(noteId);
    if (!existing || isSourceSummaryNote(existing) || existing.type === "scene") {
      throw new Error(`Long-term memory source extraction draft cannot mutate scene/source notes: ${noteId}`);
    }
  }

  // Notes with status "archived" are returned by getNote/listNotes — nothing to check.
  void requiredNoteIds;
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

    const storage = new LongTermMemoryStorage(options.root);
    const actor = options.actor ?? (options.autoApplyLowRiskOnly ? "auto_low_risk" : "maintenance_api");
    const appliedMutationIds: string[] = [];
    const selectedMutationIds = options.mutationIds ? new Set(options.mutationIds) : null;
    const unknownMutationIds = options.mutationIds?.filter(
      (mutationId) => !draft.mutations.some((mutation) => mutation.id === mutationId),
    );
    if (unknownMutationIds?.length) {
      throw new Error(`Long-term memory draft mutation not found: ${unknownMutationIds.join(", ")}`);
    }
    if (options.editedMutations?.length) {
      const editedById = new Map(options.editedMutations.map((edit) => [edit.id as string, edit]));
      draft.mutations = draft.mutations.map((mutation) => {
        const edit = editedById.get(mutation.id);
        if (!edit) return mutation;
        const { id, kind, ...patch } = edit;
        return { ...mutation, ...patch } as typeof mutation;
      });
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

    const skippedMutationIds = draft.mutations
      .filter((mutation) => !mutationsToApply.some((candidate) => candidate.id === mutation.id))
      .map((mutation) => mutation.id);
    await recordLtmDebugEvent({
      root: options.root,
      operationId: options.operationId,
      phase: "apply",
      action: "mutations_selected",
      status: mutationsToApply.length > 0 ? "ok" : options.autoApplyLowRiskOnly ? "skipped" : "warning",
      draftId,
      sourceNoteId: draft.source.sourceNoteId,
      mutationIds: mutationsToApply.map((mutation) => mutation.id),
      counts: {
        totalMutations: draft.mutations.length,
        selectedMutations: mutationsToApply.length,
        skippedMutations: skippedMutationIds.length,
      },
      details: {
        skippedMutationIds,
        selectedKinds: mutationsToApply.reduce<Record<string, number>>((counts, mutation) => {
          counts[mutation.kind] = (counts[mutation.kind] ?? 0) + 1;
          return counts;
        }, {}),
      },
    });

    if (mutationsToApply.length === 0) {
      if (options.autoApplyLowRiskOnly) {
        return { draft, appliedMutationIds, skippedMutationIds, autoIncludedMutationIds };
      }
      throw new Error(`Long-term memory draft has no mutations selected for apply: ${draftId}`);
    }

    await preflightDraftMutations(storage, draft, mutationsToApply);

    const groups = groupMutationsByNote(mutationsToApply);
    const groupResults = await Promise.all(
      groups.map(async (group) => {
        const ids: string[] = [];
        for (const mutation of group) {
          await applyMutation(storage, draft, mutation, actor);
          ids.push(mutation.id);
        }
        return ids;
      }),
    );
    for (const ids of groupResults) {
      appliedMutationIds.push(...ids);
    }

    const partialApply = skippedMutationIds.length > 0;
    const status = options.autoApplyLowRiskOnly && !partialApply ? "auto_applied" : partialApply ? "pending" : "accepted";
    const remainingMutations = partialApply
      ? draft.mutations.filter((mutation) => skippedMutationIds.includes(mutation.id))
      : draft.mutations;
    const updated = await store.updateDraftStatus(draft.id, status, {
      appliedAt: appliedMutationIds.length > 0 ? nowIso() : undefined,
      mutations: remainingMutations,
      appliedMutationIds: Array.from(new Set([...(draft.appliedMutationIds ?? []), ...appliedMutationIds])),
      skippedMutationIds,
    });
    if (!updated) {
      throw new Error(`Long-term memory draft disappeared during apply: ${draftId}`);
    }

    if (appliedMutationIds.length > 0 && options.rebuildIndexes !== false) {
      await rebuildLongTermMemoryIndexes({ root: options.root, scope: "typed" });
      await recordLtmDebugEvent({
        root: options.root,
        operationId: options.operationId,
        phase: "rebuild",
        action: "apply_rebuild_indexes",
        status: "ok",
        draftId,
        counts: { appliedMutations: appliedMutationIds.length },
        details: { scope: "typed" },
      });
    }

    return { draft: updated, appliedMutationIds, skippedMutationIds, autoIncludedMutationIds };
  });
}
