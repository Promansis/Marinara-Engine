import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { showConfirmDialog } from "../lib/app-dialogs";
import type { AgentConfigRow } from "./use-agents";
import { useConnections } from "./use-connections";
import {
  type LtmExtractionReasoningEffort,
  type LtmExtractionVerbosity,
  type LtmIndexHealth,
  type LtmMode,
  type LtmRepairResponse,
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  DEFAULT_LTM_EXTRACTION_TEMPERATURE,
  DEFAULT_LTM_EXTRACTION_VERBOSITY,
  DEFAULT_LTM_GLOBAL_SETTINGS,
  type LtmExtractionSettings,
  type LtmGlobalSettings,
} from "@marinara-engine/shared";
import {
  useLongTermMemoryStatus,
  useLongTermMemoryExtractionSettings,
  useUpdateLongTermMemoryExtractionSettings,
  useLongTermMemorySettings,
  useUpdateLongTermMemorySettings,
  useRebuildLongTermMemory,
  useRepairLongTermMemory,
  useLongTermMemoryIntegrity,
} from "./use-long-term-memory";
import {
  useDebouncedRecallSettings,
  type RecallSettingsValues,
} from "../components/long-term-memory/RecallSettingsControls";
import { parseAgentSettingsRecord } from "@marinara-engine/shared";

export type LtmPromptTemplate = { id: string; name: string; prompt: string };
export type LtmActivePromptTemplateIdsByMode = Partial<Record<LtmMode, string | null>>;

const LTM_EXTRACTION_MODES = ["roleplay", "conversation", "game"] as const satisfies readonly LtmMode[];

function normalizeBoundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  options: { integer?: boolean } = {},
) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const normalized = options.integer === false ? numeric : Math.trunc(numeric);
  return Math.max(min, Math.min(max, normalized));
}

function normalizeNullableRecallWeight(value: number | null | undefined) {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

export function createLtmRecallDraft(settings?: Partial<RecallSettingsValues> | null): RecallSettingsValues {
  return {
    longTermMemoryBudgetTokens: normalizeBoundedNumber(
      settings?.longTermMemoryBudgetTokens,
      DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryBudgetTokens,
      128,
      16_384,
    ),
    longTermMemoryMaxChunks: normalizeBoundedNumber(
      settings?.longTermMemoryMaxChunks,
      DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryMaxChunks,
      1,
      100,
    ),
    longTermMemoryScoreThreshold: normalizeBoundedNumber(
      settings?.longTermMemoryScoreThreshold,
      DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryScoreThreshold,
      0,
      1,
      { integer: false },
    ),
    longTermMemoryRecallContextMessages: normalizeBoundedNumber(
      settings?.longTermMemoryRecallContextMessages,
      DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryRecallContextMessages,
      1,
      20,
    ),
    longTermMemoryRecallStyle:
      settings?.longTermMemoryRecallStyle ?? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryRecallStyle,
    longTermMemorySemanticWeight: normalizeNullableRecallWeight(settings?.longTermMemorySemanticWeight),
    longTermMemoryLexicalWeight: normalizeNullableRecallWeight(settings?.longTermMemoryLexicalWeight),
    longTermMemoryGraphWeight: normalizeNullableRecallWeight(settings?.longTermMemoryGraphWeight),
    longTermMemoryKeywordWeight: normalizeNullableRecallWeight(settings?.longTermMemoryKeywordWeight),
    longTermMemoryIncludeResolved:
      settings?.longTermMemoryIncludeResolved ?? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryIncludeResolved,
    longTermMemoryDebug: settings?.longTermMemoryDebug ?? DEFAULT_LTM_GLOBAL_SETTINGS.longTermMemoryDebug,
  };
}

function createLtmRecallSettingsPayload(values: RecallSettingsValues): LtmGlobalSettings {
  return { version: 1, ...values };
}

export interface LtmAgentDraft {
  connectionId: string;
  model: string;
  instruction: string;
  importConcurrency: number;
  autoApplyLowRisk: boolean;
  reasoningEffort: LtmExtractionReasoningEffort;
  verbosity: LtmExtractionVerbosity;
  maxOutputTokens: number;
  temperature: number;
  maxSourceTokens: number;
  maxExistingNoteTokens: number;
  existingNoteMaxChunks: number;
  existingNoteMaxTokens: number;
  promptTemplates: LtmPromptTemplate[];
  activePromptTemplateIdsByMode: LtmActivePromptTemplateIdsByMode;
  aiKeywordExtraction: boolean;
  refinePass: boolean;
}

export interface UseLtmAgentSectionResult {
  vaultOpen: {
    initialTab?: "notes" | "import" | "review" | "suggestions";
    initialAddMemoryView?: "choose" | "write" | "sources";
    sourceNoteId?: string;
  } | null;
  setVaultOpen: (
    value: {
      initialTab?: "notes" | "import" | "review" | "suggestions";
      initialAddMemoryView?: "choose" | "write" | "sources";
      sourceNoteId?: string;
    } | null,
  ) => void;
  memoriesModalOpen: boolean;
  ltmAdvancedOpen: boolean;
  setLtmAdvancedOpen: (open: boolean) => void;
  recallAdvancedOpen: boolean;
  setRecallAdvancedOpen: (open: boolean) => void;
  maintenanceOpen: boolean;
  setMaintenanceOpen: (open: boolean) => void;
  ltmStatus: ReturnType<typeof useLongTermMemoryStatus>;
  integrity: ReturnType<typeof useLongTermMemoryIntegrity>;
  ltmDraft: LtmAgentDraft | null;
  ltmRecallDraft: RecallSettingsValues | null;
  lastRepairResult: LtmRepairResponse | null;
  ltmHasMemories: boolean;
  ltmIndexHealth: LtmIndexHealth | undefined;
  ltmSmartSearchAvailable: boolean;
  ltmSmartSearchReady: boolean;
  ltmSearchStatusLabel: string;
  ltmSearchStatusTitle: string;
  ltmIndexStatus: { label: string; tone: "good" | "warn" | "bad" | "neutral"; title: string };
  indexedMemoryChunkLabel: string;
  updateLtmDraft: (patch: Record<string, unknown>) => void;
  updateLtmRecallDraft: (patch: Partial<RecallSettingsValues>) => void;
  handleLtmPromptDraftDirtyChange: (nextDirty: boolean) => void;
  rebuildMemories: ReturnType<typeof useRebuildLongTermMemory>;
  repairMemories: ReturnType<typeof useRepairLongTermMemory>;
  runMemoryRepair: () => Promise<void>;
  flushLtmRecallDraft: () => void;
  ltmPromptDraftDirty: boolean;
  saveLtm: () => Promise<void>;
  consumeLaunchIntent: () => void;
}

export function useLtmAgentSection(
  isLtmAgent: boolean,
  dbConfig: AgentConfigRow | null,
  markDirty: () => void,
  connections: ReturnType<typeof useConnections>["data"],
): UseLtmAgentSectionResult {
  const [vaultOpen, setVaultOpen] = useState<{
    initialTab?: "notes" | "import" | "review" | "suggestions";
    initialAddMemoryView?: "choose" | "write" | "sources";
    sourceNoteId?: string;
  } | null>(null);
  const memoriesModalOpen = vaultOpen !== null;
  const [ltmAdvancedOpen, setLtmAdvancedOpen] = useState(false);
  const [recallAdvancedOpen, setRecallAdvancedOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const ltmStatus = useLongTermMemoryStatus({ enabled: isLtmAgent });
  const integrity = useLongTermMemoryIntegrity({ enabled: isLtmAgent });
  const { data: ltmExtractionSettings } = useLongTermMemoryExtractionSettings({ enabled: isLtmAgent });
  const updateExtractionSettings = useUpdateLongTermMemoryExtractionSettings();
  const ltmGlobalSettingsResult = useLongTermMemorySettings({ enabled: isLtmAgent });
  const updateGlobalSettings = useUpdateLongTermMemorySettings();
  const [ltmRecallDraft, setLtmRecallDraft] = useState<RecallSettingsValues | null>(null);
  const ltmRecallHasLocalEditsRef = useRef(false);
  const ltmRecallRevisionRef = useRef(0);
  const rebuildMemories = useRebuildLongTermMemory();
  const repairMemories = useRepairLongTermMemory();
  const [lastRepairResult, setLastRepairResult] = useState<LtmRepairResponse | null>(null);
  const [ltmDraft, setLtmDraft] = useState<LtmAgentDraft | null>(null);
  const [ltmPromptDraftDirty, setLtmPromptDraftDirty] = useState(false);
  const ltmSeededAgentRef = useRef<string | null>(null);

  const ltmHasMemories = (ltmStatus.data?.notes.total ?? 0) > 0;
  const ltmIndexHealth = integrity.data?.health ?? ltmStatus.data?.indexes.health;
  const ltmSmartSearchAvailable = ltmStatus.data?.indexes.embeddingsAvailable === true;
  const ltmSmartSearchReady =
    ltmSmartSearchAvailable && (ltmIndexHealth === "healthy" || ltmIndexHealth === "degraded");
  const ltmSearchStatusLabel = ltmSmartSearchReady
    ? "Smart Search Ready"
    : ltmSmartSearchAvailable
      ? "Smart Search Stale"
      : "Basic Search Only";
  const ltmSearchStatusTitle = ltmSmartSearchReady
    ? "Memory search can match related memories by meaning."
    : ltmSmartSearchAvailable
      ? "Smart matching exists, but the memory index needs maintenance before it is current."
      : "Memory search is available, but smart matching has not been built yet.";
  const ltmIndexStatus = ((health: LtmIndexHealth | undefined) => {
    if (health === "healthy")
      return { label: "Memory Index Healthy", tone: "good" as const, title: "The active memory index is current." };
    if (health === "degraded")
      return {
        label: "Memory Index Degraded",
        tone: "warn" as const,
        title: "A recovered or rebuilding index is active. Check Maintenance for details.",
      };
    if (health === "stale")
      return {
        label: "Memory Index Stale",
        tone: "warn" as const,
        title: "Saved memories changed after the active index was built.",
      };
    if (health === "corrupt")
      return {
        label: "Memory Index Corrupt",
        tone: "bad" as const,
        title: "No valid current memory index is available. Open Maintenance to repair it.",
      };
    if (health === "not_built")
      return {
        label: "Memory Index Not Built",
        tone: "neutral" as const,
        title: "Build the memory index to enable indexed recall.",
      };
    return {
      label: "Memory Index Unknown",
      tone: "neutral" as const,
      title: "Memory index status could not be determined.",
    };
  })(ltmIndexHealth);
  const indexedMemoryChunkCount = ltmStatus.data?.indexes.chunkCount;
  const indexedMemoryChunkLabel =
    typeof indexedMemoryChunkCount === "number"
      ? `${indexedMemoryChunkCount.toLocaleString()} indexed memory chunk${indexedMemoryChunkCount === 1 ? "" : "s"}`
      : "Memory index not built";

  useEffect(() => {
    if (!isLtmAgent) {
      ltmRecallHasLocalEditsRef.current = false;
      setLtmRecallDraft(null);
      return;
    }
    if (!ltmGlobalSettingsResult.data || ltmRecallHasLocalEditsRef.current) return;
    setLtmRecallDraft(createLtmRecallDraft(ltmGlobalSettingsResult.data));
  }, [isLtmAgent, ltmGlobalSettingsResult.data]);

  const patchGlobalSettings = useCallback(
    (values: RecallSettingsValues) => {
      const revision = ltmRecallRevisionRef.current;
      updateGlobalSettings.mutate(createLtmRecallSettingsPayload(values), {
        onSuccess: (settings) => {
          if (revision !== ltmRecallRevisionRef.current) return;
          ltmRecallHasLocalEditsRef.current = false;
          setLtmRecallDraft(createLtmRecallDraft(settings));
        },
        onError: (err) => {
          if (revision !== ltmRecallRevisionRef.current) return;
          toast.error(err instanceof Error ? err.message : "Failed to save memory recall settings");
        },
      });
    },
    [updateGlobalSettings],
  );
  const autosaveLtmRecallDraft = useCallback(
    (values: Partial<RecallSettingsValues>) => patchGlobalSettings(createLtmRecallDraft(values)),
    [patchGlobalSettings],
  );
  const { flush: flushLtmRecallDraft, schedule: debouncedPatchGlobal } = useDebouncedRecallSettings(
    autosaveLtmRecallDraft,
    400,
  );

  useEffect(() => {
    if (!isLtmAgent) {
      setLtmDraft(null);
      setLtmPromptDraftDirty(false);
      ltmSeededAgentRef.current = null;
      return;
    }
    if (!dbConfig || !ltmExtractionSettings) return;
    const agentKey = dbConfig.id || dbConfig.type;
    if (ltmSeededAgentRef.current === agentKey) return;
    ltmSeededAgentRef.current = agentKey;
    const settings = parseAgentSettingsRecord(dbConfig.settings);
    setLtmDraft({
      connectionId: typeof settings.connectionId === "string" ? settings.connectionId : "",
      model: typeof settings.model === "string" ? settings.model : "",
      instruction: typeof settings.instruction === "string" ? settings.instruction : "",
      importConcurrency:
        typeof settings.importConcurrency === "number"
          ? Math.max(1, Math.min(10, Math.round(settings.importConcurrency)))
          : 3,
      autoApplyLowRisk: settings.autoApplyLowRisk === true,
      reasoningEffort: ltmExtractionSettings.reasoningEffort,
      verbosity: ltmExtractionSettings.verbosity,
      maxOutputTokens: ltmExtractionSettings.maxOutputTokens,
      temperature: ltmExtractionSettings.temperature,
      maxSourceTokens: ltmExtractionSettings.maxSourceTokens,
      maxExistingNoteTokens: ltmExtractionSettings.maxExistingNoteTokens,
      existingNoteMaxChunks: ltmExtractionSettings.existingNoteMaxChunks,
      existingNoteMaxTokens: ltmExtractionSettings.existingNoteMaxTokens,
      promptTemplates: ltmExtractionSettings.promptTemplates,
      activePromptTemplateIdsByMode: { ...ltmExtractionSettings.activePromptTemplateIdsByMode },
      aiKeywordExtraction: ltmExtractionSettings.aiKeywordExtraction,
      refinePass: ltmExtractionSettings.refinePass,
    });
    setLtmPromptDraftDirty(false);
  }, [isLtmAgent, dbConfig, ltmExtractionSettings]);

  const runMemoryRepair = useCallback(async () => {
    const confirmed = await showConfirmDialog({
      title: "Repair Memory Store?",
      message:
        "Malformed memory files will be moved into quarantine, missing imported-source titles will be restored, and the memory index will be rebuilt once.",
      confirmLabel: "Repair",
      tone: "destructive",
    });
    if (!confirmed) return;
    try {
      const result = await repairMemories.mutateAsync([
        "quarantine_malformed_notes",
        "backfill_imported_source_titles",
        "rebuild_indexes",
      ]);
      setLastRepairResult(result);
      const remaining = result.integrity.issues.filter((issue) => issue.severity !== "info").length;
      if (result.integrity.ok) toast.success("Memory repair completed");
      else toast.warning(`Memory repair completed with ${remaining} remaining issue${remaining === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Memory repair failed");
    }
  }, [repairMemories]);

  const updateLtmDraft = useCallback(
    (patch: Record<string, unknown>) => {
      setLtmDraft((current) => (current ? { ...current, ...patch } : current));
      markDirty();
    },
    [markDirty],
  );

  const updateLtmRecallDraft = useCallback(
    (patch: Partial<RecallSettingsValues>) => {
      setLtmRecallDraft((current) => {
        if (!current) return current;
        const next = createLtmRecallDraft({ ...current, ...patch });
        ltmRecallRevisionRef.current += 1;
        ltmRecallHasLocalEditsRef.current = true;
        debouncedPatchGlobal(next);
        return next;
      });
      markDirty();
    },
    [debouncedPatchGlobal, markDirty],
  );

  const handleLtmPromptDraftDirtyChange = useCallback(
    (nextDirty: boolean) => {
      setLtmPromptDraftDirty(nextDirty);
      if (nextDirty) markDirty();
    },
    [markDirty],
  );

  const saveLtm = useCallback(async () => {
    if (!ltmDraft) return;
    const extractionPayload: LtmExtractionSettings = { version: 1 };
    const maxOutputTokens = normalizeBoundedNumber(
      ltmDraft.maxOutputTokens,
      DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
      512,
      32_768,
    );
    const temperature = normalizeBoundedNumber(ltmDraft.temperature, DEFAULT_LTM_EXTRACTION_TEMPERATURE, 0, 2, {
      integer: false,
    });
    const maxExistingNoteTokens = normalizeBoundedNumber(
      ltmDraft.maxExistingNoteTokens,
      DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
      128,
      32_768,
    );
    const activePromptTemplateIdsByMode = Object.fromEntries(
      LTM_EXTRACTION_MODES.flatMap((mode) => {
        const id = ltmDraft.activePromptTemplateIdsByMode[mode];
        return id ? [[mode, id]] : [];
      }),
    );
    if (ltmDraft.reasoningEffort !== DEFAULT_LTM_EXTRACTION_REASONING_EFFORT)
      extractionPayload.reasoningEffort = ltmDraft.reasoningEffort;
    if (ltmDraft.verbosity !== DEFAULT_LTM_EXTRACTION_VERBOSITY) extractionPayload.verbosity = ltmDraft.verbosity;
    if (maxOutputTokens !== DEFAULT_LTM_EXTRACTION_MAX_TOKENS) extractionPayload.maxOutputTokens = maxOutputTokens;
    if (temperature !== DEFAULT_LTM_EXTRACTION_TEMPERATURE) extractionPayload.temperature = temperature;
    if (maxExistingNoteTokens !== DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS)
      extractionPayload.maxExistingNoteTokens = maxExistingNoteTokens;
    if (ltmDraft.existingNoteMaxTokens !== DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS)
      extractionPayload.existingNoteMaxTokens = ltmDraft.existingNoteMaxTokens;
    if (ltmDraft.promptTemplates.length > 0) extractionPayload.promptTemplates = ltmDraft.promptTemplates;
    if (Object.keys(activePromptTemplateIdsByMode).length > 0)
      extractionPayload.activePromptTemplateIdsByMode = activePromptTemplateIdsByMode;
    if (ltmDraft.aiKeywordExtraction) extractionPayload.aiKeywordExtraction = true;
    if (ltmDraft.refinePass) extractionPayload.refinePass = true;
    await updateExtractionSettings.mutateAsync(extractionPayload);
  }, [ltmDraft, updateExtractionSettings]);

  const consumeLaunchIntent = useCallback(() => {
    // Consume is handled by the component via useUIStore directly
  }, []);

  void connections;

  return {
    vaultOpen,
    setVaultOpen,
    memoriesModalOpen,
    ltmAdvancedOpen,
    setLtmAdvancedOpen,
    recallAdvancedOpen,
    setRecallAdvancedOpen,
    maintenanceOpen,
    setMaintenanceOpen,
    ltmStatus,
    integrity,
    ltmDraft,
    ltmRecallDraft,
    lastRepairResult,
    ltmHasMemories,
    ltmIndexHealth,
    ltmSmartSearchAvailable,
    ltmSmartSearchReady,
    ltmSearchStatusLabel,
    ltmSearchStatusTitle,
    ltmIndexStatus,
    indexedMemoryChunkLabel,
    updateLtmDraft,
    updateLtmRecallDraft,
    handleLtmPromptDraftDirtyChange,
    rebuildMemories,
    repairMemories,
    runMemoryRepair,
    flushLtmRecallDraft,
    ltmPromptDraftDirty,
    saveLtm,
    consumeLaunchIntent,
  };
}
