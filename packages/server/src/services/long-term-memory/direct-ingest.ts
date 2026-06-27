import { withMergedLtmScopeLinks, type LtmDraftMutation, type LtmEvidenceUnit, type LtmNote, type LtmScope, type SessionSummary } from "@marinara-engine/shared";
import { getLtmScopeChatIds } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import type { DB } from "../../db/connection.js";
import type { Journal } from "../game/journal.service.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { compileLtmEvidenceUnits } from "./evidence-unit-compiler.js";
import { mapGameJournalToEvidenceUnits, computeGameSourceHash } from "./game-journal-mapper.js";
import { nowIso, uniqueStrings } from "./ltm-utils.js";
import { getLongTermMemoryRoot } from "./paths.js";
import { recordLtmDebugEvent, withLtmDebugOperation } from "./debug-log.js";
import { LongTermMemoryStorage, type UpdateLtmNotePatch } from "./storage.js";

function readJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function uniqueLinks(links: LtmNote["links"]) {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.target}\u0000${link.relation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function withEvidence(
  section: Pick<LtmNote["sections"][string], "text" | "updatedAt" | "salience" | "confidence">,
  evidence: string[],
): LtmNote["sections"][string] {
  return {
    ...section,
    evidence: Array.from(
      new Set([...(section as { evidence?: string[] }).evidence ?? [], ...evidence]),
    ).slice(0, 100),
  };
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

function mergeSection(
  existing: LtmNote["sections"][string] | undefined,
  incoming: LtmNote["sections"][string],
  append: boolean,
): LtmNote["sections"][string] {
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

async function applyMutation(
  storage: LongTermMemoryStorage,
  mutation: LtmDraftMutation,
  sourceNoteId: string,
) {
  const eventContext = {
    actor: "direct_ingest",
    cause: `source:${sourceNoteId}`,
    summary: mutation.summary,
    payload: {
      mutationId: mutation.id,
      mutationKind: mutation.kind,
      evidence: mutation.evidence,
    },
  };

  if (mutation.kind === "create_note") {
    const existing = await storage.getNote(mutation.note.id);
    if (!existing) {
      await storage.createNote(mutation.note, eventContext);
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
        links: uniqueLinks([
          ...existing.links,
          ...mutation.note.links,
          { target: sourceNoteId, relation: "extracted_from" },
        ]),
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
    logger.warn("[ltm] Direct-ingest target note not found, skipping mutation %s on note %s", mutation.id, mutation.noteId);
    return;
  }

  let patch: UpdateLtmNotePatch;
  if (mutation.kind === "append_section") {
    const existingSection = existing.sections[mutation.sectionKey];
    const nextText = existingSection?.text
      ? `${existingSection.text.trim()}\n\n${mutation.text.trim()}`.trim()
      : mutation.text.trim();
    patch = {
      sections: {
        ...existing.sections,
        [mutation.sectionKey]: withEvidence(
          {
            text: nextText,
            updatedAt: nowIso(),
            salience: mutation.salience ?? existingSection?.salience,
            confidence: Math.max(existingSection?.confidence ?? 0, mutation.confidence),
          },
          mutation.evidence,
        ),
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
    patch = {
      links: uniqueLinks([
        ...existing.links,
        mutation.link,
        { target: sourceNoteId, relation: "extracted_from" },
      ]),
    };
  } else if (mutation.kind === "set_keywords") {
    patch = { keywords: mutation.keywords };
  } else if (mutation.kind === "set_status") {
    patch = { status: mutation.status };
  } else {
    const _exhaustive: never = mutation;
    throw new Error(`Unsupported mutation kind: ${(_exhaustive as LtmDraftMutation).kind}`);
  }

  try {
    await storage.updateNote(existing.id, patch, eventContext);
  } catch (err) {
    logger.error(err, "[ltm] Failed to apply direct-ingest mutation %s to note %s", mutation.id, mutation.noteId);
    throw err;
  }
}

export interface DirectIngestGameJournalResult {
  units: LtmEvidenceUnit[];
  mutations: LtmDraftMutation[];
  appliedMutationIds: string[];
}

export async function directIngestGameJournal(
  db: DB,
  sourceNote: LtmNote,
  root?: string,
  operationId?: string,
): Promise<DirectIngestGameJournalResult> {
  return withLtmDebugOperation(
    {
      operationId,
      root: root ?? getLongTermMemoryRoot(),
      phase: "extraction",
      action: "direct_ingest_game_journal",
      sourceNoteId: sourceNote.id,
      message: "Direct ingest game journal into LTM vault",
    },
    async (opId) => {
      const chatId = sourceNote.scope?.chatId ?? getLtmScopeChatIds(sourceNote.scope)[0];
      if (!chatId) {
        throw new Error("Cannot direct-ingest game journal: source note has no chatId in scope");
      }

      const rootDir = root ?? getLongTermMemoryRoot();
      const storage = new LongTermMemoryStorage(rootDir);

      const chat = await createChatsStorage(db).getById(chatId);
      if (!chat) {
        logger.warn("[ltm] directIngestGameJournal: chat %s not found, aborting", chatId);
        return { units: [], mutations: [], appliedMutationIds: [] };
      }

      const metadata = readJsonObject(chat.metadata);
      const gameJournal = metadata.gameJournal ?? null;
      const gamePreviousSessionSummaries = metadata.gamePreviousSessionSummaries ?? [];

      const sessionSummaries = Array.isArray(gamePreviousSessionSummaries) ? gamePreviousSessionSummaries : [];

      if (!gameJournal && sessionSummaries.length === 0) {
        logger.warn("[ltm] directIngestGameJournal: no game data found for chat %s, aborting", chatId);
        return { units: [], mutations: [], appliedMutationIds: [] };
      }

      const sourceHash = computeGameSourceHash(
        gameJournal as Journal | null,
        sessionSummaries as SessionSummary[],
      );
      const scope = sourceNote.scope;
      const ctx = { chatId, scope, sourceHash };

      const units = mapGameJournalToEvidenceUnits(
        gameJournal as Journal | null,
        sessionSummaries as SessionSummary[],
        ctx,
      );

      if (units.length === 0) {
        logger.info("[ltm] directIngestGameJournal: no evidence units from game data for chat %s", chatId);
        return { units: [], mutations: [], appliedMutationIds: [] };
      }

      const compiled = compileLtmEvidenceUnits({
        units,
        existingNotes: [],
        scope,
        modes: ["game"],
        mode: "game",
        summary: `Direct ingestion of game journal + ${sessionSummaries.length} session summaries`,
      });

      if (compiled.mutations.length === 0) {
        logger.info("[ltm] directIngestGameJournal: compiler produced no mutations for chat %s", chatId);
        return { units, mutations: [], appliedMutationIds: [] };
      }

      const appliedMutationIds: string[] = [];
      for (const mutation of compiled.mutations) {
        try {
          await applyMutation(storage, mutation, sourceNote.id);
          appliedMutationIds.push(mutation.id);
        } catch (err) {
          logger.error(err, "[ltm] directIngestGameJournal: failed to apply mutation %s for chat %s", mutation.id, chatId);
        }
      }

      await recordLtmDebugEvent({
        root: rootDir,
        operationId: opId,
        phase: "extraction",
        action: "direct_ingest_completed",
        status: "ok",
        sourceNoteId: sourceNote.id,
        message: `Direct-ingested ${units.length} units → ${compiled.mutations.length} mutations, ${appliedMutationIds.length} applied`,
        counts: { units: units.length, mutations: compiled.mutations.length, applied: appliedMutationIds.length },
      });

      return { units, mutations: compiled.mutations, appliedMutationIds };
    },
  );
}
