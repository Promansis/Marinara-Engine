import {
  isLtmSourceLikeNote,
  type LtmEvidenceUnit,
  type LtmExtractionDraft,
  type LtmExtractionAccounting,
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
import { getLongTermMemoryRoot } from "./paths.js";
import { recordLtmDebugEvent, withLtmDebugOperation } from "./debug-log.js";
import { applyLongTermMemoryDraft } from "./reconciliation.js";
import { resolveScopedEvidenceUnitTargets } from "./scoped-targets.js";
import { sourceHashForLtmSourceNote } from "./source-hash.js";
import { LongTermMemoryStorage } from "./storage.js";
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
  const result = await applyLongTermMemoryDraft(options.draftId, {
    root: options.root,
    actor: "direct_ingest",
    autoApplyLowRiskOnly: true,
    rebuildIndexes: false,
  });
  return {
    draft: result.draft,
    appliedMutationIds: result.appliedMutationIds,
    skippedMutationIds: result.skippedMutationIds,
    diagnostics: [],
  };
}

export interface DirectIngestGameJournalResult {
  operationId: string;
  units: LtmEvidenceUnit[];
  draft: LtmExtractionDraft | null;
  diagnostics: LtmExtractionDiagnostic[];
  outcome: LtmExtractionOutcome;
  accounting: LtmExtractionAccounting;
  response: LtmExtractionResponse;
  appliedMutationIds: string[];
  skippedMutationIds: string[];
}

function emptyExtractionAccounting(): LtmExtractionAccounting {
  return {
    providerCandidates: 0,
    normalizedAdditions: 0,
    parserRejections: 0,
    validationRejections: 0,
    deduplications: 0,
    keptUnits: 0,
  };
}

function directIngestAbortError() {
  const error = new Error("Long-term memory import was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfDirectIngestAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw directIngestAbortError();
}

function isDirectIngestAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export async function directIngestGameJournal(
  db: DB,
  sourceNote: LtmNote,
  root?: string,
  operationId?: string,
  options: { refinePass?: boolean; applyLowRisk?: boolean; persistDraft?: boolean; signal?: AbortSignal } = {},
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
      throwIfDirectIngestAborted(options.signal);
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
          operationId: opId,
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
          accounting: emptyExtractionAccounting(),
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
          operationId: opId,
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
          accounting: emptyExtractionAccounting(),
          response: { summary: "", mutations: [] },
          appliedMutationIds: [],
          skippedMutationIds: [],
        };
      }

      const sourceHash = computeGameSourceHash(gameJournal as Journal | null, sessionSummaries as SessionSummary[]);
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
          operationId: opId,
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
          accounting: emptyExtractionAccounting(),
          response: { summary: "", mutations: [] },
          appliedMutationIds: [],
          skippedMutationIds: [],
        };
      }

      const sourceEvidence = `source_note:${sourceNote.id}`;
      const structuralUnits = units.map((unit) =>
        unit.evidence.includes(sourceEvidence) ? unit : { ...unit, evidence: [...unit.evidence, sourceEvidence] },
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
      let accounting = structuralCompiled.accounting;

      if (refinePass) {
        try {
          throwIfDirectIngestAborted(options.signal);
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
            maxExistingNoteTokens: extractionConfig.maxExistingNoteTokens,
            operationId: opId,
            mode: "game",
            aiKeywordExtraction: extractionConfig.aiKeywordExtraction,
            refinePass: true,
            signal: options.signal,
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
            accounting = refinedCompiled.accounting;
          }
        } catch (err) {
          if (options.signal?.aborted || isDirectIngestAbortError(err)) throw err;
          logger.warn(
            err,
            "[ltm] Game journal refine pass failed, falling back to structural ingestion for %s",
            chatId,
          );
        }
      }

      if (response.mutations.length === 0) {
        logger.info("[ltm] directIngestGameJournal: compiler produced no mutations for chat %s", chatId);
      }

      throwIfDirectIngestAborted(options.signal);
      const draft =
        options.persistDraft === false
          ? null
          : await draftStore.createDraft({
              scope,
              modes: ["game"],
              source: {
                chatId,
                sourceNoteId: sourceNote.id,
                sourceHash: sourceHashForLtmSourceNote(sourceNote),
              },
              summary: response.summary,
              response,
              operationId: opId,
              diagnostics,
              outcome,
              accounting,
            });

      let updatedDraft: LtmExtractionDraft | null = draft;
      let appliedMutationIds: string[] = [];
      let skippedMutationIds: string[] = [];

      if (options.applyLowRisk && draft && draft.mutations.length > 0) {
        throwIfDirectIngestAborted(options.signal);
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
          draftPersistence: options.persistDraft === false ? "deferred" : "created",
          skippedMutationIds,
        },
      });

      return {
        operationId: opId,
        units: structuralUnits,
        draft: updatedDraft,
        diagnostics,
        outcome,
        accounting,
        response,
        appliedMutationIds,
        skippedMutationIds,
      };
    },
  );
}
