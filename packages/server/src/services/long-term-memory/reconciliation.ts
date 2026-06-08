import type { LtmDraftMutation, LtmExtractionDraft, LtmLink, LtmSection } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { rebuildLongTermMemoryIndexes } from "./rebuild.js";
import { LongTermMemoryDraftStore } from "./extraction.js";
import { LongTermMemoryStorage, type UpdateLtmNotePatch } from "./storage.js";

export interface ApplyLtmDraftOptions {
  root?: string;
  actor?: string;
  rebuildIndexes?: boolean;
  autoApplyLowRiskOnly?: boolean;
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

function appendSection(existing: LtmSection | undefined, mutation: Extract<LtmDraftMutation, { kind: "append_section" }>) {
  const timestamp = nowIso();
  const nextText = existing?.text
    ? `${existing.text.trim()}\n\n${mutation.text.trim()}`.trim()
    : mutation.text.trim();
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

async function preflightDraftMutations(
  storage: LongTermMemoryStorage,
  draft: LtmExtractionDraft,
  mutations: LtmDraftMutation[],
) {
  const createIds = new Set<string>();
  const requiredNoteIds = new Set<string>();

  for (const mutation of mutations) {
    if (mutation.kind === "create_note") {
      if (createIds.has(mutation.note.id)) {
        throw new Error(`Long-term memory draft creates the same note more than once: ${mutation.note.id}`);
      }
      createIds.add(mutation.note.id);
      continue;
    }
    requiredNoteIds.add(mutation.noteId);
  }

  for (const noteId of createIds) {
    const existing = await storage.getNote(noteId);
    if (existing) {
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

export function isLowRiskAutoApplyMutation(mutation: LtmDraftMutation) {
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
    await storage.createNote(mutation.note, eventContext);
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

  await storage.updateNote(existing.id, patch, eventContext);
}

export async function applyLongTermMemoryDraft(
  draftId: string,
  options: ApplyLtmDraftOptions = {},
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
  const skippedMutationIds = draft.mutations
    .filter((mutation) => options.autoApplyLowRiskOnly && !isLowRiskAutoApplyMutation(mutation))
    .map((mutation) => mutation.id);
  const mutationsToApply = options.autoApplyLowRiskOnly
    ? draft.mutations.filter(isLowRiskAutoApplyMutation)
    : draft.mutations;

  await preflightDraftMutations(storage, draft, mutationsToApply);

  for (const mutation of mutationsToApply) {
    await applyMutation(storage, draft, mutation, actor);
    appliedMutationIds.push(mutation.id);
  }

  const status = options.autoApplyLowRiskOnly ? "auto_applied" : "accepted";
  const updated = await store.updateDraftStatus(draft.id, status, {
    appliedAt: appliedMutationIds.length > 0 ? nowIso() : undefined,
  });
  if (!updated) {
    throw new Error(`Long-term memory draft disappeared during apply: ${draftId}`);
  }

  if (appliedMutationIds.length > 0 && options.rebuildIndexes !== false) {
    await rebuildLongTermMemoryIndexes({ root: options.root });
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
  options: { root?: string; reason?: string } = {},
) {
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
