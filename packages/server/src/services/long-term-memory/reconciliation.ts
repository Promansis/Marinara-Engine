import type { LtmDraftMutation, LtmExtractionDraft, LtmLink, LtmNote, LtmSection } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { recordLtmDebugEvent, withLtmDebugOperation } from "./debug-log.js";
import { rebuildLongTermMemoryIndexes } from "./rebuild.js";
import { LongTermMemoryDraftStore } from "./extraction.js";
import { LongTermMemoryStorage, type UpdateLtmNotePatch } from "./storage.js";

export interface ApplyLtmDraftOptions {
  root?: string;
  actor?: string;
  rebuildIndexes?: boolean;
  autoApplyLowRiskOnly?: boolean;
  autoApplyPolicy?: "turn" | "source_extraction";
  mutationIds?: string[];
  operationId?: string;
}

export interface ApplyLtmDraftResult {
  draft: LtmExtractionDraft;
  appliedMutationIds: string[];
  skippedMutationIds: string[];
}

function nowIso() {
  return new Date().toISOString();
}

function withEvidence(section: LtmSection, evidence: string[]) {
  return {
    ...section,
    evidence: Array.from(new Set([...(section.evidence ?? []), ...evidence])).slice(0, 100),
  } satisfies LtmSection;
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
      gates: mutation.gates ?? existing?.gates,
    },
    mutation.evidence,
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

async function preflightDraftMutations(
  storage: LongTermMemoryStorage,
  draft: LtmExtractionDraft,
  mutations: LtmDraftMutation[],
) {
  const createIds = new Set<string>();
  const requiredNoteIds = new Set<string>();
  const sourceExtractionDraft = Boolean(draft.source.sourceNoteId);

  for (const mutation of mutations) {
    if (mutation.kind === "create_note") {
      if (
        sourceExtractionDraft &&
        (mutation.note.tags.includes("source_summary") ||
          mutation.note.tags.includes("chat_summary") ||
          mutation.note.type === "source" ||
          mutation.note.type === "scene")
      ) {
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
      const existing = await storage.getNote(mutation.noteId);
      if (!existing || existing.type === "source" || existing.type === "scene") {
        throw new Error(
          `Long-term memory source extraction draft cannot mutate scene/source notes: ${mutation.noteId}`,
        );
      }
    }
    requiredNoteIds.add(mutation.noteId);
  }

  for (const noteId of createIds) {
    const existing = await storage.getNote(noteId);
    const createMutation = mutations.find((mutation) => mutation.kind === "create_note" && mutation.note.id === noteId);
    if (
      existing &&
      (existing.status !== "archived" ||
        createMutation?.kind !== "create_note" ||
        existing.type !== createMutation.note.type)
    ) {
      throw new Error(`Long-term memory note already exists for draft ${draft.id}: ${noteId}`);
    }
  }

  for (const noteId of requiredNoteIds) {
    if (createIds.has(noteId)) {
      throw new Error(`Long-term memory draft cannot mutate a note it creates in the same apply batch: ${noteId}`);
    }
    const existing = await storage.getNote(noteId);
    if (!existing) {
      throw new Error(`Long-term memory note not found for draft ${draft.id}: ${noteId}`);
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
  return (
    mutation.kind === "create_note" &&
    (mutation.note.tags.includes("source_summary") || mutation.note.tags.includes("chat_summary"))
  );
}

function mutationHasGates(mutation: LtmDraftMutation) {
  if (mutation.kind === "create_note") {
    return Object.values(mutation.note.sections).some((section) => (section.gates?.length ?? 0) > 0);
  }
  if (mutation.kind === "append_section") return (mutation.gates?.length ?? 0) > 0;
  if (mutation.kind === "update_section") return (mutation.section.gates?.length ?? 0) > 0;
  return false;
}

const GATED_CONTENT_PATTERNS = [
  /\b(spoiler|twist|reveal|secret ending)\b/i,
  /\b(secret|unknown to|hiding|concealed|private knowledge)\b/i,
  /\b(private|confidential|intimate)\b/i,
  /\b(nsfw|explicit|sexual|sex)\b/i,
];

function mutationText(mutation: LtmDraftMutation) {
  if (mutation.kind === "create_note") {
    return Object.values(mutation.note.sections)
      .map((section) => section.text)
      .join("\n");
  }
  if (mutation.kind === "append_section") return mutation.text;
  if (mutation.kind === "update_section") return mutation.section.text;
  if (mutation.kind === "flag_conflict") return mutation.conflict.proposed;
  return "";
}

function mutationHasPotentialGatedContent(mutation: LtmDraftMutation) {
  const text = mutationText(mutation);
  return text.length > 0 && GATED_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function isLowRiskTurnMutation(mutation: LtmDraftMutation) {
  if (mutation.risk !== "low") return false;
  if (mutation.kind === "append_section") {
    return mutation.noteId.startsWith("scene_") && mutation.confidence >= 0.7;
  }
  if (mutation.kind === "add_link") {
    return mutation.confidence >= 0.75;
  }
  if (mutation.kind === "create_note") {
    return mutation.note.type === "callback" && mutation.confidence >= 0.85 && !mutation.note.conflicts?.length;
  }
  return false;
}

export function isLowRiskSourceExtractionMutation(mutation: LtmDraftMutation) {
  if (mutation.risk !== "low") return false;
  if (mutationTouchesSceneId(mutation) || mutationHasSourceSummaryTag(mutation)) return false;
  if (mutationHasGates(mutation) || mutationHasPotentialGatedContent(mutation)) return false;
  if (mutation.kind === "append_section") return false;
  if (mutation.kind === "create_note") {
    return mutation.note.type === "callback" && mutation.confidence >= 0.85 && !mutation.note.conflicts?.length;
  }
  if (mutation.kind === "add_link") {
    return mutation.confidence >= 0.75;
  }
  if (mutation.kind === "set_status") {
    return (
      mutation.status === "resolved" &&
      mutation.confidence >= 0.85 &&
      (mutation.noteId.startsWith("cb_") || mutation.noteId.startsWith("thread_"))
    );
  }
  return false;
}

export const isLowRiskAutoApplyMutation = isLowRiskTurnMutation;

function isLowRiskMutationForPolicy(mutation: LtmDraftMutation, policy: ApplyLtmDraftOptions["autoApplyPolicy"]) {
  return policy === "source_extraction" ? isLowRiskSourceExtractionMutation(mutation) : isLowRiskTurnMutation(mutation);
}

async function applyMutation(
  storage: LongTermMemoryStorage,
  draft: LtmExtractionDraft,
  mutation: LtmDraftMutation,
  actor: string,
) {
  const eventContext = {
    actor,
    turn: draft.source.turn,
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
    if (existing?.status === "archived" && existing.type === mutation.note.type) {
      await storage.updateNote(
        existing.id,
        {
          status: mutation.note.status,
          modes: mutation.note.modes,
          scope: mutation.note.scope,
          tags: mutation.note.tags,
          links: withSourceLink(mutation.note.id, mutation.note.links, draft),
          sections: mutation.note.sections,
          conflicts: mutation.note.conflicts,
        },
        eventContext,
      );
      return;
    }
    await storage.createNote(
      {
        ...mutation.note,
        links: withSourceLink(mutation.note.id, mutation.note.links, draft),
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
    patch = { conflicts: [...(existing.conflicts ?? []), mutation.conflict] };
  }

  patch = {
    ...patch,
    links: withSourceLink(existing.id, patch.links ?? existing.links, draft),
  };

  await storage.updateNote(existing.id, patch, eventContext);
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
        autoApplyPolicy: options.autoApplyPolicy,
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
  const draft = await store.getDraft(draftId);
  if (!draft) {
    throw new Error(`Long-term memory draft not found: ${draftId}`);
  }
  if (draft.status !== "pending") {
    throw new Error(`Long-term memory draft is not pending: ${draftId}`);
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
  const autoApplyPolicy = options.autoApplyPolicy ?? (draft.source.sourceNoteId ? "source_extraction" : "turn");
  const mutationsToApply = draft.mutations.filter((mutation) => {
    if (selectedMutationIds && !selectedMutationIds.has(mutation.id)) return false;
    if (options.autoApplyLowRiskOnly && !isLowRiskMutationForPolicy(mutation, autoApplyPolicy)) return false;
    return true;
  });
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
      return { draft, appliedMutationIds, skippedMutationIds };
    }
    throw new Error(`Long-term memory draft has no mutations selected for apply: ${draftId}`);
  }

  await preflightDraftMutations(storage, draft, mutationsToApply);

  for (const mutation of mutationsToApply) {
    await applyMutation(storage, draft, mutation, actor);
    appliedMutationIds.push(mutation.id);
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
    await rebuildLongTermMemoryIndexes({ root: options.root });
    await recordLtmDebugEvent({
      root: options.root,
      operationId: options.operationId,
      phase: "rebuild",
      action: "apply_rebuild_indexes",
      status: "ok",
      draftId,
      counts: { appliedMutations: appliedMutationIds.length },
    });
  }

  logger.info(
    "[ltm] Applied draft %s (%d applied, %d skipped)",
    draft.id,
    appliedMutationIds.length,
    skippedMutationIds.length,
  );

  return { draft: updated, appliedMutationIds, skippedMutationIds };
}

export async function rejectLongTermMemoryDraft(
  draftId: string,
  options: { root?: string; reason?: string; operationId?: string } = {},
) {
  return withLtmDebugOperation(
    {
      root: options.root,
      operationId: options.operationId,
      phase: "draft",
      action: "reject_draft",
      draftId,
      details: { reason: options.reason },
    },
    async () => rejectLongTermMemoryDraftInner(draftId, options),
  );
}

async function rejectLongTermMemoryDraftInner(draftId: string, options: { root?: string; reason?: string } = {}) {
  const store = new LongTermMemoryDraftStore(options.root);
  const draft = await store.getDraft(draftId);
  if (!draft) {
    throw new Error(`Long-term memory draft not found: ${draftId}`);
  }
  if (draft.status !== "pending") {
    throw new Error(`Long-term memory draft is not pending: ${draftId}`);
  }
  const updated = await store.updateDraftStatus(draftId, "rejected", {
    rejectedReason: options.reason,
  });
  if (!updated) {
    throw new Error(`Long-term memory draft not found: ${draftId}`);
  }
  return updated;
}
