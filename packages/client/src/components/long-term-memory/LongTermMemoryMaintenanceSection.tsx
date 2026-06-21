import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { AlertTriangle, Hammer, Info, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import type { Chat } from "@marinara-engine/shared";
import { DEFAULT_LTM_RECALL_PREAMBLE, LTM_RECALL_STYLE_WEIGHTS } from "@marinara-engine/shared";
import {
  useLongTermMemoryIntegrity,
  useLongTermMemorySettings,
  useRebuildLongTermMemory,
  useRepairLongTermMemory,
  useUpdateLongTermMemorySettings,
  type LtmGlobalSettings,
} from "../../hooks/use-long-term-memory";
import { api } from "../../lib/api-client";
import { cn } from "../../lib/utils";
import { LongTermMemoryExtractionSettingsEditor } from "./LongTermMemoryExtractionSettingsModal";
import {
  compactInputClassName,
  sectionCardClassName,
  SettingField,
  textareaClassName,
} from "./LtmFields";
import { ToolButton } from "./LtmPills";
import {
  DEFAULT_LTM_BUDGET_TOKENS,
  DEFAULT_LTM_CONTEXT_MESSAGES,
  DEFAULT_LTM_MAX_CHUNKS,
  DEFAULT_LTM_SCORE_THRESHOLD,
  DisclosureHeader,
  LTM_RECALL_STYLES,
  LTM_WEIGHT_MAX,
  LTM_WEIGHT_MIN,
  LTM_WEIGHT_PATCH_KEY_MAP,
  LTM_WEIGHT_STEP,
  readLongTermMemoryRecallSearchSettings,
} from "./ltm-panel-shared";

function SettingToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2.5 rounded-lg p-1 transition-colors hover:bg-[var(--secondary)]/50",
        disabled && "pointer-events-none opacity-45",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 shrink-0 rounded border-[var(--border)] accent-[var(--primary)]"
      />
      <span className="min-w-0 flex-1 text-xs text-[var(--foreground)]">{label}</span>
    </label>
  );
}

function SettingGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">{label}</div>
      {children}
    </div>
  );
}

export function ChatMemorySettings({
  activeChat,
  integrity,
  rebuild,
  repair,
}: {
  activeChat?: Chat | null;
  integrity: ReturnType<typeof useLongTermMemoryIntegrity>;
  rebuild: ReturnType<typeof useRebuildLongTermMemory>;
  repair: ReturnType<typeof useRepairLongTermMemory>;
}) {
  const settings = useLongTermMemorySettings();
  const updateSettings = useUpdateLongTermMemorySettings();
  const globalSettings = settings.data;
  const enabled = globalSettings?.enableLongTermMemory ?? true;
  const debug = globalSettings?.longTermMemoryDebug ?? false;
  const recallSearchSettings = useMemo(() => readLongTermMemoryRecallSearchSettings(globalSettings), [globalSettings]);
  const budgetValue = recallSearchSettings.maxTokens;
  const maxChunksValue = recallSearchSettings.maxChunks;
  const scoreThresholdValue = recallSearchSettings.minScore;
  const recallStyle = globalSettings?.longTermMemoryRecallStyle ?? "balanced";
  const includeResolved = globalSettings?.longTermMemoryIncludeResolved ?? false;
  const recallPreamble = globalSettings?.longTermMemoryRecallPreamble ?? DEFAULT_LTM_RECALL_PREAMBLE;
  const weights = recallSearchSettings;
  const contextMessagesValue = recallSearchSettings.contextMessages;
  const [budgetDraft, setBudgetDraft] = useState(String(budgetValue));
  const [maxChunksDraft, setMaxChunksDraft] = useState(String(maxChunksValue));
  const [scoreThresholdDraft, setScoreThresholdDraft] = useState(scoreThresholdValue);
  const [contextMessagesDraft, setContextMessagesDraft] = useState(String(contextMessagesValue));
  const [recallPreambleDraft, setRecallPreambleDraft] = useState(recallPreamble);
  const [editingRecallPreamble, setEditingRecallPreamble] = useState(false);
  const [semanticWeightDraft, setSemanticWeightDraft] = useState(String(weights.semanticWeight));
  const [lexicalWeightDraft, setLexicalWeightDraft] = useState(String(weights.lexicalWeight));
  const [graphWeightDraft, setGraphWeightDraft] = useState(String(weights.graphWeight));
  const [recallOpen, setRecallOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [extractionOpen, setExtractionOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const patchTimersRef = useRef<Partial<Record<"budget" | "maxChunks" | "contextMessages" | "scoreThreshold" | "recallPreamble" | "semantic" | "lexical" | "graph", ReturnType<typeof setTimeout>>>>({});
  const latestPatchValueRef = useRef<Partial<Record<"budget" | "maxChunks" | "contextMessages" | "scoreThreshold" | "recallPreamble" | "semantic" | "lexical" | "graph", string | number>>>({});
  const sliderBudget = Number.isFinite(Number(budgetDraft))
    ? Math.max(128, Math.min(16_384, Math.floor(Number(budgetDraft))))
    : budgetValue;

  useEffect(() => {
    setBudgetDraft(String(budgetValue));
    setMaxChunksDraft(String(maxChunksValue));
    setScoreThresholdDraft(scoreThresholdValue);
    setContextMessagesDraft(String(contextMessagesValue));
    if (!editingRecallPreamble) setRecallPreambleDraft(recallPreamble);
    setSemanticWeightDraft(String(weights.semanticWeight));
    setLexicalWeightDraft(String(weights.lexicalWeight));
    setGraphWeightDraft(String(weights.graphWeight));
  }, [
    budgetValue,
    contextMessagesValue,
    editingRecallPreamble,
    maxChunksValue,
    recallPreamble,
    scoreThresholdValue,
    weights.graphWeight,
    weights.lexicalWeight,
    weights.semanticWeight,
  ]);

  const patch = useCallback((next: LtmGlobalSettings) => {
    return updateSettings
      .mutateAsync(next)
      .then(() => toast.success("Memory settings updated"))
      .catch((err: Error) => toast.error(err.message));
  }, [updateSettings]);

  const clearPatchTimer = useCallback(
    (key: keyof typeof latestPatchValueRef.current) => {
      const timer = patchTimersRef.current[key];
      if (timer) {
        clearTimeout(timer);
        delete patchTimersRef.current[key];
      }
    },
    [],
  );

  const takePendingPatchValue = useCallback((key: keyof typeof latestPatchValueRef.current) => {
    const nextValue = latestPatchValueRef.current[key];
    delete latestPatchValueRef.current[key];
    return nextValue;
  }, []);

  const schedulePatch = useCallback(
    (
      key: keyof typeof latestPatchValueRef.current,
      value: string | number,
      commit: (nextValue: string | number) => Promise<unknown>,
    ) => {
      latestPatchValueRef.current[key] = value;
      clearPatchTimer(key);
      patchTimersRef.current[key] = setTimeout(() => {
        delete patchTimersRef.current[key];
        const nextValue = takePendingPatchValue(key);
        if (nextValue === undefined) return;
        void commit(nextValue);
      }, 450);
    },
    [clearPatchTimer, takePendingPatchValue],
  );

  const flushPatch = useCallback(
    (
      key: keyof typeof latestPatchValueRef.current,
      commit: (nextValue: string | number) => Promise<unknown>,
    ) => {
      clearPatchTimer(key);
      const nextValue = takePendingPatchValue(key);
      if (nextValue === undefined) return;
      void commit(nextValue);
    },
    [clearPatchTimer, takePendingPatchValue],
  );

  const dispatchKeepaliveSettingsPatch = useCallback((patchData: Record<string, unknown>) => {
    api.putKeepalive("/long-term-memory/settings", { version: 1, ...patchData });
  }, []);

  const commitBudget = useCallback((value: string) => {
    const numeric = Number(value);
    const next = Number.isFinite(numeric)
      ? Math.max(128, Math.min(16_384, Math.floor(numeric)))
      : DEFAULT_LTM_BUDGET_TOKENS;
    setBudgetDraft(String(next));
    if (next === budgetValue) return Promise.resolve();
    return patch({ version: 1, longTermMemoryBudgetTokens: next });
  }, [budgetValue, patch]);

  const commitMaxChunks = useCallback((value: string) => {
    const numeric = Number(value);
    const next = Number.isFinite(numeric) ? Math.max(1, Math.min(100, Math.floor(numeric))) : DEFAULT_LTM_MAX_CHUNKS;
    setMaxChunksDraft(String(next));
    if (next === maxChunksValue) return Promise.resolve();
    return patch({ version: 1, longTermMemoryMaxChunks: next });
  }, [maxChunksValue, patch]);

  const commitContextMessages = useCallback((value: string) => {
    const numeric = Number(value);
    const next = Number.isFinite(numeric)
      ? Math.max(1, Math.min(20, Math.floor(numeric)))
      : DEFAULT_LTM_CONTEXT_MESSAGES;
    setContextMessagesDraft(String(next));
    if (next === contextMessagesValue) return Promise.resolve();
    return patch({ version: 1, longTermMemoryRecallContextMessages: next });
  }, [contextMessagesValue, patch]);

  const commitScoreThreshold = useCallback((value: number) => {
    const numeric = Number.isFinite(value) ? value : DEFAULT_LTM_SCORE_THRESHOLD;
    const next = Math.max(0, Math.min(1, Number(numeric.toFixed(2))));
    setScoreThresholdDraft(next);
    if (next === scoreThresholdValue) return Promise.resolve();
    return patch({ version: 1, longTermMemoryScoreThreshold: next });
  }, [patch, scoreThresholdValue]);

  const commitRecallPreamble = useCallback((value: string) => {
    const next = value.slice(0, 500);
    setRecallPreambleDraft(next);
    if (next === recallPreamble) return Promise.resolve();
    return patch({ version: 1, longTermMemoryRecallPreamble: next });
  }, [patch, recallPreamble]);

  const readWeightDraft = (value: string, fallback: number, max = LTM_WEIGHT_MAX) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(LTM_WEIGHT_MIN, Math.min(max, Number(numeric.toFixed(2)))) : fallback;
  };

  const commitWeight = useCallback((key: "semantic" | "lexical" | "graph", value: string) => {
    const fallback = weights[`${key}Weight` as const];
    const next = readWeightDraft(value, fallback, 1);
    if (next === fallback) return Promise.resolve();
    return patch({ version: 1, [LTM_WEIGHT_PATCH_KEY_MAP[key]]: next });
  }, [patch, weights]);

  useEffect(() => {
    const patchTimers = patchTimersRef.current;

    const flushPending = () => {
      flushPatch("budget", (value) => commitBudget(String(value)));
      flushPatch("maxChunks", (value) => commitMaxChunks(String(value)));
      flushPatch("contextMessages", (value) => commitContextMessages(String(value)));
      flushPatch("scoreThreshold", (value) => commitScoreThreshold(Number(value)));
      flushPatch("recallPreamble", (value) => commitRecallPreamble(String(value)));
      flushPatch("semantic", (value) => commitWeight("semantic", String(value)));
      flushPatch("lexical", (value) => commitWeight("lexical", String(value)));
      flushPatch("graph", (value) => commitWeight("graph", String(value)));
    };

    const flushKeepalive = () => {
      const patchData: Record<string, unknown> = {};
      const budget = latestPatchValueRef.current.budget;
      if (budget !== undefined) {
        patchData.longTermMemoryBudgetTokens = Math.max(
          128,
          Math.min(16_384, Math.floor(Number(budget) || DEFAULT_LTM_BUDGET_TOKENS)),
        );
      }
      const maxChunks = latestPatchValueRef.current.maxChunks;
      if (maxChunks !== undefined) {
        patchData.longTermMemoryMaxChunks = Number.isFinite(Number(maxChunks))
          ? Math.max(1, Math.min(100, Math.floor(Number(maxChunks))))
          : DEFAULT_LTM_MAX_CHUNKS;
      }
      const contextMessages = latestPatchValueRef.current.contextMessages;
      if (contextMessages !== undefined) {
        patchData.longTermMemoryRecallContextMessages = Number.isFinite(Number(contextMessages))
          ? Math.max(1, Math.min(20, Math.floor(Number(contextMessages))))
          : DEFAULT_LTM_CONTEXT_MESSAGES;
      }
      const scoreThreshold = latestPatchValueRef.current.scoreThreshold;
      if (scoreThreshold !== undefined) {
        const numeric = Number.isFinite(Number(scoreThreshold)) ? Number(scoreThreshold) : DEFAULT_LTM_SCORE_THRESHOLD;
        patchData.longTermMemoryScoreThreshold = Math.max(0, Math.min(1, Number(numeric.toFixed(2))));
      }
      const recallPreamble = latestPatchValueRef.current.recallPreamble;
      if (recallPreamble !== undefined) {
        patchData.longTermMemoryRecallPreamble = String(recallPreamble).slice(0, 500);
      }
      const semantic = latestPatchValueRef.current.semantic;
      if (semantic !== undefined) {
        patchData[LTM_WEIGHT_PATCH_KEY_MAP.semantic] = readWeightDraft(String(semantic), weights.semanticWeight, 1);
      }
      const lexical = latestPatchValueRef.current.lexical;
      if (lexical !== undefined) {
        patchData[LTM_WEIGHT_PATCH_KEY_MAP.lexical] = readWeightDraft(String(lexical), weights.lexicalWeight, 1);
      }
      const graph = latestPatchValueRef.current.graph;
      if (graph !== undefined) {
        patchData[LTM_WEIGHT_PATCH_KEY_MAP.graph] = readWeightDraft(String(graph), weights.graphWeight, 1);
      }
      if (Object.keys(patchData).length > 0) {
        dispatchKeepaliveSettingsPatch(patchData);
      }
    };

    const handleBeforeUnload = () => {
      flushKeepalive();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushKeepalive();
        flushPending();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      Object.keys(patchTimers).forEach((key) => {
        clearPatchTimer(key as keyof typeof latestPatchValueRef.current);
      });
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    clearPatchTimer,
    commitBudget,
    commitContextMessages,
    commitMaxChunks,
    commitRecallPreamble,
    commitScoreThreshold,
    commitWeight,
    dispatchKeepaliveSettingsPatch,
    flushPatch,
    weights.graphWeight,
    weights.lexicalWeight,
    weights.semanticWeight,
  ]);

  const resetWeightOverrides = () => {
    setSemanticWeightDraft(String(LTM_RECALL_STYLE_WEIGHTS[recallStyle].semanticWeight));
    setLexicalWeightDraft(String(LTM_RECALL_STYLE_WEIGHTS[recallStyle].lexicalWeight));
    setGraphWeightDraft(String(LTM_RECALL_STYLE_WEIGHTS[recallStyle].graphWeight));
    return patch({
      version: 1,
      longTermMemorySemanticWeight: null,
      longTermMemoryLexicalWeight: null,
      longTermMemoryGraphWeight: null,
      longTermMemoryMetadataWeight: null,
    });
  };

  const resetRecallDefaults = () => {
    setBudgetDraft(String(DEFAULT_LTM_BUDGET_TOKENS));
    setMaxChunksDraft(String(DEFAULT_LTM_MAX_CHUNKS));
    setScoreThresholdDraft(DEFAULT_LTM_SCORE_THRESHOLD);
    setContextMessagesDraft(String(DEFAULT_LTM_CONTEXT_MESSAGES));
    setRecallPreambleDraft(DEFAULT_LTM_RECALL_PREAMBLE);
    return patch({
      version: 1,
      enableLongTermMemory: true,
      longTermMemoryBudgetTokens: DEFAULT_LTM_BUDGET_TOKENS,
      longTermMemoryMaxChunks: DEFAULT_LTM_MAX_CHUNKS,
      longTermMemoryScoreThreshold: DEFAULT_LTM_SCORE_THRESHOLD,
      longTermMemoryRecallContextMessages: DEFAULT_LTM_CONTEXT_MESSAGES,
      longTermMemoryRecallStyle: "balanced",
      longTermMemorySemanticWeight: null,
      longTermMemoryLexicalWeight: null,
      longTermMemoryGraphWeight: null,
      longTermMemoryMetadataWeight: null,
      longTermMemoryIncludeResolved: false,
      longTermMemoryRecallPreamble: DEFAULT_LTM_RECALL_PREAMBLE,
    });
  };

  return (
    <div className="space-y-2">
      {!activeChat && (
        <p className="text-xs text-[var(--muted-foreground)]">Open a chat to edit its long-term memory settings.</p>
      )}

      {activeChat && (
        <>
          <DisclosureHeader
            title="Recall"
            open={recallOpen}
            onToggle={() => setRecallOpen((v) => !v)}
          />
          {recallOpen && (
            <div className={sectionCardClassName}>
              <SettingToggle
                label="Use memory in prompts"
                checked={enabled}
                onChange={(checked) => patch({ version: 1, enableLongTermMemory: checked })}
              />
              <SettingField label="Memory preamble">
                <textarea
                  value={recallPreambleDraft}
                  maxLength={500}
                  rows={2}
                  placeholder={DEFAULT_LTM_RECALL_PREAMBLE}
                  onFocus={() => setEditingRecallPreamble(true)}
                  onChange={(event) => {
                    const nextValue = event.target.value.slice(0, 500);
                    setRecallPreambleDraft(nextValue);
                    latestPatchValueRef.current.recallPreamble = nextValue;
                  }}
                  onBlur={(event) => {
                    setEditingRecallPreamble(false);
                    commitRecallPreamble(event.target.value);
                  }}
                  className={cn(textareaClassName, "min-h-16")}
                />
              </SettingField>
              <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                Appears before recalled memories in the prompt. Leave blank to inject only the memory sections.
              </p>
              <SettingGroup label="Recall style">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--background)] p-1 ring-1 ring-[var(--border)]">
                  {LTM_RECALL_STYLES.map((style) => (
                    <div key={style.id} className="grid grid-cols-[1fr_auto] overflow-hidden rounded-md">
                      <button
                        type="button"
                        onClick={() => patch({ version: 1, longTermMemoryRecallStyle: style.id })}
                        aria-pressed={recallStyle === style.id}
                        className={cn(
                          "min-h-8 px-2 text-left text-xs font-medium transition-colors",
                          recallStyle === style.id
                            ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                            : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                        )}
                      >
                        {style.label}
                      </button>
                      <button
                        type="button"
                        title={style.description}
                        aria-label={`${style.label} recall style: ${style.description}`}
                        onClick={(event) => event.preventDefault()}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center transition-colors",
                          recallStyle === style.id
                            ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                            : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                        )}
                      >
                        <Info size="0.75rem" />
                      </button>
                    </div>
                  ))}
                </div>
              </SettingGroup>
              <div className="grid gap-3 sm:grid-cols-[1fr_6.5rem]">
                <SettingField label="Max tokens">
                  <div className="grid grid-cols-[1fr_5.5rem] items-center gap-3">
                    <input
                      type="range"
                      min={128}
                      max={16384}
                      step={128}
                      value={sliderBudget}
                      onChange={(event) => {
                        setBudgetDraft(event.target.value);
                        schedulePatch("budget", event.target.value, (value) => commitBudget(String(value)));
                      }}
                      onPointerUp={() => flushPatch("budget", (value) => commitBudget(String(value)))}
                      onBlur={() => flushPatch("budget", (value) => commitBudget(String(value)))}
                      className="min-w-0 accent-[var(--primary)]"
                    />
                    <input
                      type="number"
                      min={128}
                      max={16384}
                      step={128}
                      value={budgetDraft}
                      onChange={(event) => {
                        setBudgetDraft(event.target.value);
                        schedulePatch("budget", event.target.value, (value) => commitBudget(String(value)));
                      }}
                      onBlur={() => flushPatch("budget", (value) => commitBudget(String(value)))}
                      className={compactInputClassName}
                    />
                  </div>
                </SettingField>
                <SettingField label="Max memories">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={maxChunksDraft}
                    onChange={(event) => {
                      setMaxChunksDraft(event.target.value);
                      schedulePatch("maxChunks", event.target.value, (value) => commitMaxChunks(String(value)));
                    }}
                    onBlur={() => flushPatch("maxChunks", (value) => commitMaxChunks(String(value)))}
                    className={compactInputClassName}
                  />
                </SettingField>
              </div>
              <SettingField label="Context messages for search">
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={contextMessagesDraft}
                  onChange={(event) => {
                    setContextMessagesDraft(event.target.value);
                    schedulePatch("contextMessages", event.target.value, (value) => commitContextMessages(String(value)));
                  }}
                  onBlur={() => flushPatch("contextMessages", (value) => commitContextMessages(String(value)))}
                  className={compactInputClassName}
                />
              </SettingField>
              <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                Search uses recent chat text plus scope filters. Max memories is only a ceiling; relevance still decides what appears.
              </p>
              <DisclosureHeader
                title="Advanced recall"
                description="Resolved threads and score threshold"
                open={advancedOpen}
                onToggle={() => setAdvancedOpen((v) => !v)}
              />
              {advancedOpen && (
                <div className="grid gap-2 rounded-xl bg-[var(--background)]/75 p-2 shadow-inner ring-1 ring-[var(--border)]">
                  <SettingToggle
                    label="Include resolved threads"
                    checked={includeResolved}
                    onChange={(checked) => patch({ version: 1, longTermMemoryIncludeResolved: checked })}
                  />
                  <SettingGroup label="Minimum relevance">
                    <div className="grid grid-cols-[1fr_4.5rem] items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={scoreThresholdDraft}
                        onChange={(event) => {
                          const nextValue = Number(event.target.value);
                          setScoreThresholdDraft(nextValue);
                          schedulePatch("scoreThreshold", nextValue, (value) => commitScoreThreshold(Number(value)));
                        }}
                        onPointerUp={() => flushPatch("scoreThreshold", (value) => commitScoreThreshold(Number(value)))}
                        onBlur={() => flushPatch("scoreThreshold", (value) => commitScoreThreshold(Number(value)))}
                        className="min-w-0 accent-[var(--primary)]"
                      />
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={scoreThresholdDraft}
                        onChange={(event) => {
                          const nextValue = Number(event.target.value);
                          setScoreThresholdDraft(nextValue);
                          schedulePatch("scoreThreshold", nextValue, (value) => commitScoreThreshold(Number(value)));
                        }}
                        onBlur={() => flushPatch("scoreThreshold", (value) => commitScoreThreshold(Number(value)))}
                        className={compactInputClassName}
                      />
                    </div>
                    <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                      0 keeps all ranked matches. Higher values drop memories whose final weighted relevance is lower.
                    </p>
                  </SettingGroup>
                  <SettingGroup label="Ranking Weights">
                    <div className="space-y-2">
                      {[
                        {
                          label: "Meaning",
                          draft: semanticWeightDraft,
                          setDraft: setSemanticWeightDraft,
                          fallback: weights.semanticWeight,
                          max: 1,
                          key: "semantic" as const,
                        },
                        {
                          label: "Exact Words",
                          draft: lexicalWeightDraft,
                          setDraft: setLexicalWeightDraft,
                          fallback: weights.lexicalWeight,
                          max: 1,
                          key: "lexical" as const,
                        },
                        {
                          label: "Memory Links",
                          draft: graphWeightDraft,
                          setDraft: setGraphWeightDraft,
                          fallback: weights.graphWeight,
                          max: 1,
                          key: "graph" as const,
                        },
                      ].map((item) => {
                        const inputId = `ltm-${item.key}-weight`;
                        return (
                          <div key={item.key} className="grid grid-cols-[4.5rem_1fr_4.75rem] items-center gap-3">
                            <label htmlFor={inputId} className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
                              {item.label}
                            </label>
                            <input
                              id={inputId}
                              type="range"
                              min={LTM_WEIGHT_MIN}
                              max={item.max}
                              step={LTM_WEIGHT_STEP}
                              value={item.draft}
                              onChange={(event) => {
                                item.setDraft(event.target.value);
                                schedulePatch(item.key, event.target.value, (value) => commitWeight(item.key, String(value)));
                              }}
                              onPointerUp={() => flushPatch(item.key, (value) => commitWeight(item.key, String(value)))}
                              onBlur={() => flushPatch(item.key, (value) => commitWeight(item.key, String(value)))}
                              className="min-w-0 accent-[var(--primary)]"
                            />
                            <input
                              type="number"
                              min={LTM_WEIGHT_MIN}
                              max={item.max}
                              step={LTM_WEIGHT_STEP}
                              value={item.draft}
                              onChange={(event) => {
                                item.setDraft(event.target.value);
                                schedulePatch(item.key, event.target.value, (value) => commitWeight(item.key, String(value)));
                              }}
                              onBlur={() => flushPatch(item.key, (value) => commitWeight(item.key, String(value)))}
                              className={compactInputClassName}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                      The selected recall style sets the default mix. Set all three weights to 0 to disable LTM prompt injection. Metadata scopes only filter eligible memories.
                    </p>
                    <div className="mt-2">
                      <ToolButton onClick={resetWeightOverrides}>
                        <RotateCcw size="0.875rem" />
                        Reset lane weights
                      </ToolButton>
                    </div>
                  </SettingGroup>
                  <div>
                    <ToolButton onClick={resetRecallDefaults}>
                      <RotateCcw size="0.875rem" />
                      Reset recall defaults
                    </ToolButton>
                  </div>
                </div>
              )}
            </div>
          )}

          <DisclosureHeader
            title="Extraction"
            open={extractionOpen}
            onToggle={() => setExtractionOpen((v) => !v)}
          />
          {extractionOpen && <LongTermMemoryExtractionSettingsEditor enabled={extractionOpen} />}

          <DisclosureHeader
            title="Maintenance"
            open={maintenanceOpen}
            onToggle={() => setMaintenanceOpen((v) => !v)}
          />
          {maintenanceOpen && (
            <div className={sectionCardClassName}>
              <ToolButton
                onClick={() =>
                  rebuild
                    .mutateAsync()
                    .then(() => toast.success("Memory search refreshed"))
                    .catch((err: Error) => toast.error(err.message))
                }
                disabled={rebuild.isPending}
                tone="primary"
              >
                <RefreshCw size="0.875rem" />
                Reindex Memories
              </ToolButton>
              <ToolButton
                onClick={() =>
                  repair
                    .mutateAsync(["quarantine_malformed_notes", "rebuild_indexes"])
                    .then(() => toast.success("Repair actions finished"))
                    .catch((err: Error) => toast.error(err.message))
                }
                disabled={repair.isPending}
                tone="danger"
              >
                <Hammer size="0.875rem" />
                Repair Memory Store
              </ToolButton>
              <div className="mt-3 space-y-2">
                {(integrity.data?.issues ?? [])
                  .filter((issue) => issue.severity !== "info")
                  .slice(0, 8).map((issue) => (
                  <div
                    key={`${issue.code}-${issue.path ?? issue.noteId ?? issue.message}`}
                    className="rounded-lg bg-[var(--secondary)]/50 p-3 text-xs ring-1 ring-[var(--border)]"
                  >
                    <div className="flex items-center gap-2 font-medium">
                      {issue.severity === "error" ? (
                        <AlertTriangle size="0.875rem" className="text-rose-300" />
                      ) : (
                        <ShieldCheck size="0.875rem" />
                      )}
                      {issue.code}
                    </div>
                    <p className="mt-1 text-xs text-[var(--muted-foreground)]">{issue.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DisclosureHeader
            title="Debug"
            open={debugOpen}
            onToggle={() => setDebugOpen((v) => !v)}
          />
          {debugOpen && (
            <div className={sectionCardClassName}>
              <SettingToggle
                label="Debug retrieval logs"
                checked={debug}
                onChange={(checked) => patch({ version: 1, longTermMemoryDebug: checked })}
              />
              <p className="text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                Detailed extraction diagnostics now stay in debug surfaces. Use source-memory Suggestions for kept and
                dropped candidate recovery.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
