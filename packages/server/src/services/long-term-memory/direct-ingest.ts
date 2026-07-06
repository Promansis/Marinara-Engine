import {
  isLtmSourceLikeNote,
  withMergedLtmScopeLinks,
  type LtmDraftMutation,
  type LtmEvidenceUnit,
  type LtmExtractionDraft,
  type LtmExtractionDroppedCandidate,
  type LtmExtractionOutcome,
  type LtmExtractionResponse,
  type LtmNote,
  type LtmScope,
  type SessionSummary,
} from "@marinara-engine/shared";
import { getLtmScopeChatIds } from "@marinara-engine/shared";
import { LOCAL_SIDECAR_CONNECTION_ID } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import type { DB } from "../../db/connection.js";
import type { Journal } from "../game/journal.service.js";
import { createLLMProvider } from "../llm/provider-registry.js";
import { getLocalSidecarProvider, LOCAL_SIDECAR_MODEL } from "../llm/local-sidecar.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createConnectionsStorage } from "../storage/connections.storage.js";
import { mapGameJournalToEvidenceUnits, computeGameSourceHash, renderGameSourceText } from "./game-journal-mapper.js";
import { compileEvidenceUnitExtraction, runLongTermMemoryEvidenceUnitExtraction } from "./evidence-unit-extraction.js";
import { LongTermMemoryDraftStore } from "./draft-store.js";
import { getLtmExtractionConfig } from "./extraction-config.js";
import { nowIso, uniqueStrings } from "./ltm-utils.js";
import { getLongTermMemoryRoot } from "./paths.js";
import { recordLtmDebugEvent, withLtmDebugOperation } from "./debug-log.js";
import { isLowRiskSourceExtractionMutation } from "./reconciliation.js";
import { canUpdateLtmScopedTarget, resolveScopedEvidenceUnitTargets } from "./scoped-targets.js";
import { LongTermMemoryStorage, type UpdateLtmNotePatch } from "./storage.js";
import type { LtmExtractionDiagnostic } from "./diagnostics.js";

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
    const key = `${link.target}\u0000${link.relation}\u0000${link.aspect ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveBaseUrl(connection: { baseUrl: string | null; provider: string }): string {
  if (connection.baseUrl) return connection.baseUrl.replace(/\/+$/, "");
  if (connection.provider === "claude_subscription") return "claude-agent-sdk://local";
  if (connection.provider === "openai_chatgpt") return "openai-chatgpt://codex-auth";
  const providerDefaults: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
    anthropic: "https://api.anthropic.com/v1",
    cohere: "https://api.cohere.ai/compatibility/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
    google_vertex: "https://generativelanguage.googleapis.com/v1beta",
    mistral: "https://api.mistral.ai/v1",
    xai: "https://api.x.ai/v1",
    nanogpt: "https://api.nanogpt.com/v1",
    custom: "",
  };
  return providerDefaults[connection.provider] ?? "";
}

async function resolveGameJournalExtractionProvider(db: DB, chatConnectionId: string | null | undefined) {
  if (chatConnectionId === LOCAL_SIDECAR_CONNECTION_ID) {
    return { provider: getLocalSidecarProvider(), model: LOCAL_SIDECAR_MODEL };
  }
  const connections = createConnectionsStorage(db);
  const defaultAgentConn = await connections.getDefaultForAgents();
  let conn = chatConnectionId ? await connections.getWithKey(chatConnectionId) : defaultAgentConn;

  if (!conn) {
    const defaultConn = await connections.getDefault();
    conn = defaultConn ? await connections.getWithKey(defaultConn.id) : null;
  }

  if (!conn) {
    throw new Error("No API connection configured for LTM source extraction");
  }

  if (conn.id === LOCAL_SIDECAR_CONNECTION_ID) {
    return { provider: getLocalSidecarProvider(), model: LOCAL_SIDECAR_MODEL };
  }

  return {
    provider: createLLMProvider(
      conn.provider,
      resolveBaseUrl(conn),
      conn.apiKey,
      conn.maxContext,
      conn.openrouterProvider,
      conn.maxTokensOverride,
      conn.claudeFastMode === "true",
    ),
    model: conn.model,
  };
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
  section: LtmNote["sections"][string],
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
      importance: incoming.importance ?? existing?.importance,
      dimensions: incoming.dimensions ?? existing?.dimensions,
      dimensionChanges: incoming.dimensionChanges ?? existing?.dimensionChanges,
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
    if (!canUpdateLtmScopedTarget(existing.scope, mutation.note.scope)) {
      throw new Error(
        `Direct LTM ingest cannot merge scoped create ${mutation.note.id} into an existing note from another scope.`,
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
    throw new Error(`Direct-ingest target note not found: ${mutation.noteId}`);
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
            importance: mutation.importance ?? existingSection?.importance,
            dimensions: mutation.dimensions ?? existingSection?.dimensions,
            dimensionChanges: mutation.dimensionChanges ?? existingSection?.dimensionChanges,
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

function noteIdForMutation(mutation: LtmDraftMutation) {
  return mutation.kind === "create_note" ? mutation.note.id : mutation.noteId;
}

function isLowRiskGameJournalAutoApplyMutation(mutation: LtmDraftMutation) {
  return isLowRiskSourceExtractionMutation(mutation);
}

export type AutoApplyGameJournalDraftResult = {
  draft: LtmExtractionDraft;
  appliedMutationIds: string[];
  skippedMutationIds: string[];
  diagnostics: LtmExtractionDiagnostic[];
};

export async function autoApplyGameJournalDraft(options: {
  draftId: string;
  root?: string;
}): Promise<AutoApplyGameJournalDraftResult> {
  const root = options.root ?? getLongTermMemoryRoot();
  const store = new LongTermMemoryDraftStore(root);
  return store.withDraftLock(options.draftId, async () => {
    const draft = await store.getDraft(options.draftId);
    if (!draft) {
      throw new Error(`Long-term memory draft not found: ${options.draftId}`);
    }
    if (draft.status !== "pending") {
      throw new Error(`Long-term memory draft is not pending: ${options.draftId}`);
    }
    if (!draft.source.sourceNoteId) {
      throw new Error(`Long-term memory draft is not tied to a source note: ${options.draftId}`);
    }

    const storage = new LongTermMemoryStorage(root);
    const selectedMutations = draft.mutations.filter(isLowRiskGameJournalAutoApplyMutation);
    const selectedMutationIds = new Set(selectedMutations.map((mutation) => mutation.id));
    const appliedMutationIds: string[] = [];
    const skippedMutationIds = draft.mutations
      .filter((mutation) => !selectedMutationIds.has(mutation.id))
      .map((mutation) => mutation.id);
    const diagnostics: LtmExtractionDiagnostic[] = [];

    for (const mutation of selectedMutations) {
      try {
        await applyMutation(storage, mutation, draft.source.sourceNoteId);
        appliedMutationIds.push(mutation.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to auto-apply game journal mutation";
        logger.error(
          err,
          "[ltm] directIngestGameJournal: failed to auto-apply mutation %s for draft %s",
          mutation.id,
          draft.id,
        );
        skippedMutationIds.push(mutation.id);
        diagnostics.push({
          severity: "error",
          code: "game_journal_auto_apply_failed",
          mutationId: mutation.id,
          noteId: noteIdForMutation(mutation),
          message,
        });
      }
    }

    const uniqueSkippedMutationIds = Array.from(new Set(skippedMutationIds));
    const partialApply = uniqueSkippedMutationIds.length > 0;
    const remainingMutations = partialApply
      ? draft.mutations.filter((mutation) => uniqueSkippedMutationIds.includes(mutation.id))
      : draft.mutations;
    const updated = await store.updateDraftStatus(draft.id, partialApply ? "pending" : "auto_applied", {
      appliedAt: appliedMutationIds.length > 0 ? nowIso() : draft.appliedAt,
      mutations: remainingMutations,
      appliedMutationIds: Array.from(new Set([...(draft.appliedMutationIds ?? []), ...appliedMutationIds])),
      skippedMutationIds: uniqueSkippedMutationIds,
    });
    if (!updated) {
      throw new Error(`Long-term memory draft disappeared during direct game journal auto-apply: ${draft.id}`);
    }

    return {
      draft: updated,
      appliedMutationIds,
      skippedMutationIds: uniqueSkippedMutationIds,
      diagnostics,
    };
  });
}

export interface DirectIngestGameJournalResult {
  units: LtmEvidenceUnit[];
  draft: LtmExtractionDraft | null;
  diagnostics: LtmExtractionDiagnostic[];
  outcome: LtmExtractionOutcome;
  response: LtmExtractionResponse;
  appliedMutationIds: string[];
  skippedMutationIds: string[];
}

export async function directIngestGameJournal(
  db: DB,
  sourceNote: LtmNote,
  root?: string,
  operationId?: string,
  options: { refinePass?: boolean; applyLowRisk?: boolean } = {},
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
      const draftStore = new LongTermMemoryDraftStore(rootDir);

      const chat = await createChatsStorage(db).getById(chatId);
      if (!chat) {
        logger.warn("[ltm] directIngestGameJournal: chat %s not found, aborting", chatId);
        return {
          units: [],
          draft: null,
          diagnostics: [],
          outcome: {
            state: "no_suggestions_created",
            totalCandidates: 0,
            keptUnits: 0,
            droppedUnits: 0,
            droppedCandidates: [],
          },
          response: { summary: "", mutations: [] },
          appliedMutationIds: [],
          skippedMutationIds: [],
        };
      }

      const metadata = readJsonObject(chat.metadata);
      const gameJournal = metadata.gameJournal ?? null;
      const gamePreviousSessionSummaries = metadata.gamePreviousSessionSummaries ?? [];

      const sessionSummaries = Array.isArray(gamePreviousSessionSummaries) ? gamePreviousSessionSummaries : [];

      if (!gameJournal && sessionSummaries.length === 0) {
        logger.warn("[ltm] directIngestGameJournal: no game data found for chat %s, aborting", chatId);
        return {
          units: [],
          draft: null,
          diagnostics: [],
          outcome: {
            state: "no_suggestions_created",
            totalCandidates: 0,
            keptUnits: 0,
            droppedUnits: 0,
            droppedCandidates: [],
          },
          response: { summary: "", mutations: [] },
          appliedMutationIds: [],
          skippedMutationIds: [],
        };
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
        return {
          units: [],
          draft: null,
          diagnostics: [],
          outcome: {
            state: "no_suggestions_created",
            totalCandidates: 0,
            keptUnits: 0,
            droppedUnits: 0,
            droppedCandidates: [],
          },
          response: { summary: "", mutations: [] },
          appliedMutationIds: [],
          skippedMutationIds: [],
        };
      }

      const sourceEvidence = `source_note:${sourceNote.id}`;
      const structuralUnits = units.map((unit) =>
        unit.evidence.includes(sourceEvidence)
          ? unit
          : { ...unit, evidence: [...unit.evidence, sourceEvidence] },
      );
      const extractionConfig = await getLtmExtractionConfig(rootDir, "game");
      const refinePass = options.refinePass ?? (metadata.refinePass === true || extractionConfig.refinePass === true);
      const existingNotes = (await storage.listNotes({ scope, includeGlobal: true })).filter(
        (note) => !isLtmSourceLikeNote(note) && note.type !== "scene",
      );
      const sourceText = renderGameSourceText(gameJournal as Journal | null, sessionSummaries as SessionSummary[]);
      const structuralSummary = `Direct ingestion of game journal + ${sessionSummaries.length} session summaries`;
      const structuralTargetResolution = await resolveScopedEvidenceUnitTargets({
        storage,
        existingNotes,
        units: structuralUnits,
        scope,
      });
      const structuralCompiled = compileEvidenceUnitExtraction({
        unitResponse: {
          summary: structuralSummary,
          units: structuralTargetResolution.units,
        },
        totalCandidates: structuralUnits.length,
        sourceText,
        sourceNote,
        existingNotes: structuralTargetResolution.existingNotes,
        scope,
        modes: ["game"],
        mode: "game",
        sourceHash,
      });
      let response = structuralCompiled.compiledResponse;
      let diagnostics = [...structuralCompiled.diagnostics, ...structuralTargetResolution.diagnostics];
      let outcome = structuralCompiled.outcome;

      if (refinePass) {
        try {
          const { provider, model } = await resolveGameJournalExtractionProvider(db, chat.connectionId);
          const refined = await runLongTermMemoryEvidenceUnitExtraction({
            sourceNote,
            sourceText,
            existingNotes,
            candidateUnits: structuralUnits,
            provider,
            model,
            root: rootDir,
            scope,
            modes: ["game"],
            sourceHash,
            systemPrompt: extractionConfig.systemPrompt,
            reasoningEffort: extractionConfig.reasoningEffort,
            verbosity: extractionConfig.verbosity,
            maxOutputTokens: extractionConfig.maxOutputTokens,
            temperature: extractionConfig.temperature,
            maxSourceTokens: extractionConfig.maxSourceTokens,
            maxExistingNoteTokens: extractionConfig.maxExistingNoteTokens,
            operationId: opId,
            mode: "game",
            aiKeywordExtraction: extractionConfig.aiKeywordExtraction,
            refinePass: true,
          });
          const refinedTargetResolution = await resolveScopedEvidenceUnitTargets({
            storage,
            existingNotes,
            units: refined.response.units,
            scope,
          });
          const refinedCompiled = compileEvidenceUnitExtraction({
            unitResponse: {
              ...refined.response,
              units: refinedTargetResolution.units,
            },
            totalCandidates: refined.totalCandidates,
            parserDroppedCandidates: refined.droppedCandidates,
            sourceText,
            sourceNote,
            existingNotes: refinedTargetResolution.existingNotes,
            scope,
            modes: ["game"],
            mode: "game",
            sourceHash,
          });
          if (refinedCompiled.compiledResponse.mutations.length > 0) {
            response = refinedCompiled.compiledResponse;
            diagnostics = [...refinedCompiled.diagnostics, ...refinedTargetResolution.diagnostics];
            outcome = refinedCompiled.outcome;
          }
        } catch (err) {
          logger.warn(err, "[ltm] Game journal refine pass failed, falling back to structural ingestion for %s", chatId);
        }
      }

      if (response.mutations.length === 0) {
        logger.info("[ltm] directIngestGameJournal: compiler produced no mutations for chat %s", chatId);
        return {
          units: structuralUnits,
          draft: null,
          diagnostics,
          outcome,
          response,
          appliedMutationIds: [],
          skippedMutationIds: [],
        };
      }

      const draft = await draftStore.createDraft({
        scope,
        modes: ["game"],
        source: {
          chatId,
          sourceNoteId: sourceNote.id,
          sourceHash,
        },
        summary: response.summary,
        response,
      });

      let updatedDraft: LtmExtractionDraft | null = draft;
      let appliedMutationIds: string[] = [];
      let skippedMutationIds: string[] = [];

      if (options.applyLowRisk) {
        const autoApplyResult = await autoApplyGameJournalDraft({ draftId: draft.id, root: rootDir });
        updatedDraft = autoApplyResult.draft;
        appliedMutationIds = autoApplyResult.appliedMutationIds;
        skippedMutationIds = autoApplyResult.skippedMutationIds;
        diagnostics = [...diagnostics, ...autoApplyResult.diagnostics];
      }

      const debugStatus =
        diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
        (options.applyLowRisk === true && skippedMutationIds.length > 0)
          ? "warning"
          : "ok";
      await recordLtmDebugEvent({
        root: rootDir,
        operationId: opId,
        phase: "extraction",
        action: "direct_ingest_completed",
        status: debugStatus,
        sourceNoteId: sourceNote.id,
        draftId: updatedDraft?.id ?? undefined,
        mutationIds: response.mutations.map((mutation) => mutation.id),
        message: `Direct-ingested ${outcome.keptUnits}/${structuralUnits.length} units → ${response.mutations.length} mutations, ${appliedMutationIds.length} applied`,
        counts: {
          units: structuralUnits.length,
          keptUnits: outcome.keptUnits,
          droppedUnits: outcome.droppedUnits,
          mutations: response.mutations.length,
          applied: appliedMutationIds.length,
          skipped: skippedMutationIds.length,
        },
        diagnostics,
        details: {
          applyLowRisk: options.applyLowRisk === true,
          skippedMutationIds,
        },
      });

      return {
        units: structuralUnits,
        draft: updatedDraft,
        diagnostics,
        outcome,
        response,
        appliedMutationIds,
        skippedMutationIds,
      };
    },
  );
}
