import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, FileText, RotateCcw } from "lucide-react";
import {
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS,
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_PROMPT,
  DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  DEFAULT_LTM_EXTRACTION_TEMPERATURE,
  DEFAULT_LTM_EXTRACTION_VERBOSITY,
  type LtmExtractionReasoningEffort,
  type LtmExtractionVerbosity,
} from "@marinara-engine/shared";
import {
  useLongTermMemoryExtractionSettings,
  useLongTermMemorySettings,
  useUpdateLongTermMemoryExtractionSettings,
  useUpdateLongTermMemorySettings,
} from "../../hooks/use-long-term-memory";
import { useConnections } from "../../hooks/use-connections";
import { MacroTextarea } from "../ui/MacroTextarea";
import { FieldGroup } from "../agents/AgentEditor";
import { StatusPill } from "./LtmPills";

type Props = {
  onOpenAdvancedSettings: () => void;
};

export function LtmInlineSettingsSections({ onOpenAdvancedSettings }: Props) {
  const { data: globalSettings } = useLongTermMemorySettings();
  const { data: extractionSettings } = useLongTermMemoryExtractionSettings();
  const updateGlobalSettings = useUpdateLongTermMemorySettings();
  const updateExtractionSettings = useUpdateLongTermMemoryExtractionSettings();
  const connectionsQuery = useConnections();

  const textConnections = useMemo(
    () =>
      (
        (connectionsQuery.data as
          | Array<{ id: string; name: string; model?: string | null; provider?: string }>
          | undefined) ?? []
      )
        .filter((connection) => connection.provider !== "image_generation")
        .sort((left, right) => left.name.localeCompare(right.name)),
    [connectionsQuery.data],
  );

  const [globalSaveState, setGlobalSaveState] = useState<"saved" | "saving" | null>(null);
  const [extractionSaveState, setExtractionSaveState] = useState<"saved" | "saving" | null>(null);
  const globalTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const extractionTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const persistGlobal = useCallback(
    (patch: Record<string, unknown>) => {
      setGlobalSaveState("saving");
      clearTimeout(globalTimerRef.current);
      globalTimerRef.current = setTimeout(() => {
        updateGlobalSettings.mutate(
          { version: 1, ...globalSettings, ...patch } as Parameters<typeof updateGlobalSettings.mutate>[0],
          {
            onSettled: () => setGlobalSaveState("saved"),
          },
        );
      }, 400);
    },
    [globalSettings, updateGlobalSettings],
  );

  const persistExtraction = useCallback(
    (patch: Record<string, unknown>) => {
      setExtractionSaveState("saving");
      clearTimeout(extractionTimerRef.current);
      extractionTimerRef.current = setTimeout(() => {
        updateExtractionSettings.mutate(
          { version: 1, ...extractionSettings, ...patch } as Parameters<typeof updateExtractionSettings.mutate>[0],
          {
            onSettled: () => setExtractionSaveState("saved"),
          },
        );
      }, 400);
    },
    [extractionSettings, updateExtractionSettings],
  );

  const debouncedPersistExtraction = useCallback(
    (patch: Record<string, unknown>) => {
      setExtractionSaveState("saving");
      clearTimeout(extractionTimerRef.current);
      extractionTimerRef.current = setTimeout(() => {
        updateExtractionSettings.mutate(
          { version: 1, ...extractionSettings, ...patch } as Parameters<typeof updateExtractionSettings.mutate>[0],
          {
            onSettled: () => setExtractionSaveState("saved"),
          },
        );
      }, 800);
    },
    [extractionSettings, updateExtractionSettings],
  );

  // Section 1 — Extraction Connection
  const connectionId = globalSettings?.connectionId ?? "";
  const modelOverride = globalSettings?.model ?? "";
  const autoApplyLowRisk = globalSettings?.autoApplyLowRisk ?? false;

  // Section 2 — Extraction Budget
  const maxOutputTokens = extractionSettings?.maxOutputTokens ?? DEFAULT_LTM_EXTRACTION_MAX_TOKENS;
  const maxSourceTokens = extractionSettings?.maxSourceTokens ?? DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS;

  // Section 2b — Extraction Behavior (moved from modal per A5)
  const reasoningEffort = extractionSettings?.reasoningEffort ?? DEFAULT_LTM_EXTRACTION_REASONING_EFFORT;
  const verbosity = extractionSettings?.verbosity ?? DEFAULT_LTM_EXTRACTION_VERBOSITY;
  const temperature = extractionSettings?.temperature ?? DEFAULT_LTM_EXTRACTION_TEMPERATURE;
  const maxExistingNoteTokens = extractionSettings?.maxExistingNoteTokens ?? DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS;
  const existingNoteMaxChunks = extractionSettings?.existingNoteMaxChunks ?? DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS;
  const existingNoteMaxTokens = extractionSettings?.existingNoteMaxTokens ?? DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS;

  // Section 3 — Extraction Prompt
  const systemPrompt = extractionSettings?.systemPrompt ?? "";
  const isUsingDefaultPrompt = systemPrompt === DEFAULT_LTM_EXTRACTION_PROMPT || !systemPrompt.trim();
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [localPrompt, setLocalPrompt] = useState(systemPrompt);

  useEffect(() => {
    if (!editingPrompt) {
      setLocalPrompt(systemPrompt);
    }
  }, [systemPrompt, editingPrompt]);

  const handleLoadDefault = useCallback(() => {
    setEditingPrompt(true);
    setLocalPrompt(DEFAULT_LTM_EXTRACTION_PROMPT);
    debouncedPersistExtraction({ systemPrompt: DEFAULT_LTM_EXTRACTION_PROMPT });
  }, [debouncedPersistExtraction]);

  const handleResetPrompt = useCallback(() => {
    setEditingPrompt(false);
    setLocalPrompt(DEFAULT_LTM_EXTRACTION_PROMPT);
    debouncedPersistExtraction({ systemPrompt: undefined });
  }, [debouncedPersistExtraction]);

  const handlePromptChange = useCallback(
    (value: string) => {
      setLocalPrompt(value);
      debouncedPersistExtraction({ systemPrompt: value });
    },
    [debouncedPersistExtraction],
  );

  return (
    <>
      {/* Section 1 — AI Connection */}
      <FieldGroup
        label="AI connection"
        icon={<FileText size="0.875rem" className="text-[var(--primary)]" />}
        help="Pick which AI reads your characters, lorebooks, and chats to pull out facts."
      >
        <div className="space-y-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Connection</span>
            <select
              value={connectionId}
              onChange={(e) => persistGlobal({ connectionId: e.target.value })}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            >
              <option value="">Default extraction model</option>
              <option value="random">Random pool</option>
              {textConnections.map((conn) => (
                <option key={conn.id} value={conn.id}>
                  {conn.name}{conn.model ? ` - ${conn.model}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Model override</span>
            <input
              type="text"
              value={modelOverride}
              onChange={(e) => persistGlobal({ model: e.target.value })}
              placeholder="Optional model override"
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoApplyLowRisk}
              onChange={(e) => persistGlobal({ autoApplyLowRisk: e.target.checked })}
              className="rounded border-[var(--border)] accent-[var(--primary)]"
            />
            <span className="text-xs text-[var(--foreground)]">Auto-accept safe changes</span>
          </label>
          <p className="text-[0.625rem] text-[var(--muted-foreground)]">Lets the AI accept obvious (low-risk) facts without asking. Medium/high-risk changes still need review.</p>
          {globalSaveState && <StatusPill label={globalSaveState === "saving" ? "Saving\u2026" : "Saved"} tone={globalSaveState === "saving" ? "warn" : "good"} />}
        </div>
      </FieldGroup>

      {/* Section 2 — AI Limits */}
      <FieldGroup
        label="AI limits"
        icon={<FileText size="0.875rem" className="text-[var(--primary)]" />}
        help="Control token budgets for the extraction process."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Max AI response length</span>
            <input
              type="number"
              min={512}
              max={32768}
              value={maxOutputTokens}
              onChange={(e) => persistExtraction({ maxOutputTokens: Math.max(512, Math.min(32768, parseInt(e.target.value) || 0)) })}
              placeholder={String(DEFAULT_LTM_EXTRACTION_MAX_TOKENS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">How much text the AI reads at once</span>
            <input
              type="number"
              min={250}
              max={50000}
              value={maxSourceTokens}
              onChange={(e) => persistExtraction({ maxSourceTokens: Math.max(250, Math.min(50000, parseInt(e.target.value) || 0)) })}
              placeholder={String(DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
        </div>
        {extractionSaveState && <StatusPill label={extractionSaveState === "saving" ? "Saving\u2026" : "Saved"} tone={extractionSaveState === "saving" ? "warn" : "good"} />}
      </FieldGroup>

      {/* Section 2b — Extraction Behavior (moved from modal per A5) */}
      <FieldGroup
        label="Extraction behavior"
        icon={<FileText size="0.875rem" className="text-[var(--primary)]" />}
        help="Expert tuning for how the AI reasons over source notes and existing memories."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Reasoning effort</span>
            <select
              value={reasoningEffort}
              onChange={(e) => persistExtraction({ reasoningEffort: e.target.value as LtmExtractionReasoningEffort })}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            >
              <option value="none">None</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Verbosity</span>
            <select
              value={verbosity}
              onChange={(e) => persistExtraction({ verbosity: e.target.value as LtmExtractionVerbosity })}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Temperature</span>
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => persistExtraction({ temperature: Math.max(0, Math.min(2, Number(e.target.value) || 0)) })}
              placeholder={String(DEFAULT_LTM_EXTRACTION_TEMPERATURE)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Max existing-note text</span>
            <input
              type="number"
              min={250}
              max={25000}
              value={maxExistingNoteTokens}
              onChange={(e) => persistExtraction({ maxExistingNoteTokens: Math.max(250, Math.min(25000, parseInt(e.target.value) || 0)) })}
              placeholder={String(DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Existing-note max chunks</span>
            <input
              type="number"
              min={1}
              max={100}
              value={existingNoteMaxChunks}
              onChange={(e) => persistExtraction({ existingNoteMaxChunks: Math.max(1, Math.min(100, parseInt(e.target.value) || 0)) })}
              placeholder={String(DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Existing-note max tokens</span>
            <input
              type="number"
              min={128}
              max={16384}
              value={existingNoteMaxTokens}
              onChange={(e) => persistExtraction({ existingNoteMaxTokens: Math.max(128, Math.min(16384, parseInt(e.target.value) || 0)) })}
              placeholder={String(DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
        </div>
        {extractionSaveState && <StatusPill label={extractionSaveState === "saving" ? "Saving\u2026" : "Saved"} tone={extractionSaveState === "saving" ? "warn" : "good"} />}
      </FieldGroup>

      {/* Section 3 — AI Instructions */}
      <FieldGroup
        label="AI instructions"
        icon={<FileText size="0.875rem" className="text-[var(--primary)]" />}
        help="The system prompt used for the extraction process."
      >
        <div className="flex items-center gap-2 mb-2">
          {isUsingDefaultPrompt && !editingPrompt ? (
            <span className="flex items-center gap-1 rounded-lg bg-emerald-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-emerald-400">
              <Check size="0.625rem" /> Using built-in default
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-lg bg-amber-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-amber-400">
              <FileText size="0.625rem" /> Custom override
            </span>
          )}
          <div className="flex-1" />
          {!isUsingDefaultPrompt && !editingPrompt && (
            <button
              onClick={handleResetPrompt}
              className="flex items-center gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            >
              <RotateCcw size="0.625rem" /> Reset to default
            </button>
          )}
          {isUsingDefaultPrompt && !editingPrompt && (
            <button
              onClick={handleLoadDefault}
              className="flex items-center gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            >
              <FileText size="0.625rem" /> Copy default to edit
            </button>
          )}
        </div>

        {isUsingDefaultPrompt && !editingPrompt ? (
          <div className="relative">
            <pre className="w-full max-h-[30vh] overflow-y-auto resize-y rounded-xl bg-[var(--secondary)] px-4 py-3 font-mono text-xs leading-relaxed ring-1 ring-[var(--border)] text-[var(--muted-foreground)] whitespace-pre-wrap">
              {DEFAULT_LTM_EXTRACTION_PROMPT}
            </pre>
            <span className="absolute right-3 top-2 rounded-md bg-[var(--card)] px-1.5 py-0.5 text-[0.5625rem] font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
              Default \u2014 click "Copy default to edit" to customize
            </span>
          </div>
        ) : (
          <MacroTextarea
            value={localPrompt}
            onChange={handlePromptChange}
            rows={12}
            title="Extraction Prompt"
            placeholder="Write the extraction system prompt\u2026"
            className="w-full resize-y rounded-xl bg-[var(--secondary)] px-4 py-3 font-mono text-xs leading-relaxed ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)] max-h-[40vh] overflow-y-auto"
          />
        )}

        <p className="mt-2">
          <button
            onClick={onOpenAdvancedSettings}
            className="text-[0.625rem] text-[var(--muted-foreground)] underline-offset-4 hover:underline"
          >
            Manage templates \u2192
          </button>
        </p>
      </FieldGroup>
    </>
  );
}
