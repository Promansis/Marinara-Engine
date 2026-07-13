import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { LTM_RECALL_STYLE_WEIGHTS } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { compactInputClassName, SettingField, SettingInfoLabel } from "./LtmFields";
import { ToolButton } from "./LtmPills";
import { LTM_RECALL_STYLES, LTM_WEIGHT_MIN, LTM_WEIGHT_STEP } from "./ltm-panel-shared";
import { SettingsSwitch } from "../panels/settings/SettingControls";

export type RecallSettingsValues = {
  longTermMemoryBudgetTokens: number;
  longTermMemoryMaxChunks: number;
  longTermMemoryScoreThreshold: number;
  longTermMemoryRecallContextMessages: number;
  longTermMemoryRecallStyle: "balanced" | "exact" | "broad" | "story";
  longTermMemorySemanticWeight: number | null;
  longTermMemoryLexicalWeight: number | null;
  longTermMemoryGraphWeight: number | null;
  longTermMemoryKeywordWeight: number | null;
  longTermMemoryIncludeResolved: boolean;
  longTermMemoryDebug: boolean;
};

function SettingGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">{label}</div>
      {children}
    </div>
  );
}

function parseDraftNumber(value: string, integer: boolean) {
  if (!value.trim()) return null;
  const parsed = integer ? parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return integer ? Math.trunc(parsed) : parsed;
}

function clampDraftNumber(value: number, min: number, max: number, integer: boolean) {
  const normalized = integer ? Math.trunc(value) : value;
  return Math.max(min, Math.min(max, normalized));
}

function DraftNumberInput({
  value,
  min,
  max,
  step,
  integer = false,
  className,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  className: string;
  ariaLabel?: string;
  onChange: (value: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [focused, value]);

  const commit = useCallback(
    (rawValue: string, mode: "valid-only" | "clamp") => {
      const parsed = parseDraftNumber(rawValue, integer);
      if (parsed === null) {
        if (mode === "clamp") setDraft(String(value));
        return;
      }
      if (mode === "valid-only") {
        if (parsed >= min && parsed <= max) onChange(parsed);
        return;
      }
      const next = clampDraftNumber(parsed, min, max, integer);
      setDraft(String(next));
      onChange(next);
    },
    [integer, max, min, onChange, value],
  );

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={focused ? draft : value}
      aria-label={ariaLabel}
      onFocus={() => {
        setFocused(true);
        setDraft(String(value));
      }}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        commit(next, "valid-only");
      }}
      onBlur={() => {
        setFocused(false);
        commit(draft, "clamp");
      }}
      className={className}
    />
  );
}

/* ── Sub-components ── */

export function RecallStylePresets({
  values,
  onChange,
}: {
  values: Partial<RecallSettingsValues>;
  onChange: (patch: Partial<RecallSettingsValues>) => void;
}) {
  const recallStyle = values.longTermMemoryRecallStyle ?? "balanced";
  const selectedStyle = LTM_RECALL_STYLES.find((style) => style.id === recallStyle) ?? LTM_RECALL_STYLES[0];
  return (
    <SettingGroup label="Recall style">
      <div className="mari-chrome-segmented mari-chrome-segmented--four">
        {LTM_RECALL_STYLES.map((style) => (
          <button
            key={style.id}
            type="button"
            aria-label={`${style.label} recall style: ${style.description}`}
            aria-pressed={recallStyle === style.id}
            onClick={() =>
              onChange({
                longTermMemoryRecallStyle: style.id,
                longTermMemorySemanticWeight: null,
                longTermMemoryLexicalWeight: null,
                longTermMemoryGraphWeight: null,
                longTermMemoryKeywordWeight: null,
              })
            }
            className={cn(
              "mari-chrome-segmented__button px-2.5 text-xs",
              recallStyle === style.id && "mari-chrome-segmented__button--selected",
            )}
          >
            <span>{style.label}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
        {selectedStyle.description}
      </p>
    </SettingGroup>
  );
}

export function RecallBudgetControls({
  values,
  onChange,
}: {
  values: Partial<RecallSettingsValues>;
  onChange: (patch: Partial<RecallSettingsValues>) => void;
}) {
  const budgetTokens = values.longTermMemoryBudgetTokens ?? 4096;
  const maxChunks = values.longTermMemoryMaxChunks ?? 20;
  return (
    <>
      <SettingField
        label={
          <SettingInfoLabel
            label="Recall context budget"
            help="How many tokens recalled memories can use in the next prompt."
          />
        }
      >
        <div className="grid grid-cols-[1fr_5.5rem] items-center gap-3">
          <input
            type="range"
            min={128}
            max={16384}
            step={128}
            value={budgetTokens}
            onChange={(event) => onChange({ longTermMemoryBudgetTokens: Number(event.target.value) })}
            aria-label="Recall context budget"
            className="min-w-0 accent-[var(--primary)]"
          />
          <DraftNumberInput
            min={128}
            max={16384}
            step={128}
            integer
            value={budgetTokens}
            onChange={(value) => onChange({ longTermMemoryBudgetTokens: value })}
            className={compactInputClassName}
            ariaLabel="Recall context budget"
          />
        </div>
      </SettingField>
      <SettingField
        label={
          <SettingInfoLabel
            label="Max memories injected"
            help="The maximum number of memories recall may inject, even when token budget remains."
          />
        }
      >
        <DraftNumberInput
          min={1}
          max={100}
          step={1}
          integer
          value={maxChunks}
          onChange={(value) => onChange({ longTermMemoryMaxChunks: value })}
          className={compactInputClassName}
          ariaLabel="Max memories injected"
        />
      </SettingField>
    </>
  );
}

export function RecallThresholdControls({
  values,
  onChange,
}: {
  values: Partial<RecallSettingsValues>;
  onChange: (patch: Partial<RecallSettingsValues>) => void;
}) {
  const scoreThreshold = values.longTermMemoryScoreThreshold ?? 0;
  const contextMessages = values.longTermMemoryRecallContextMessages ?? 4;
  return (
    <>
      <SettingField label="Context messages">
        <DraftNumberInput
          min={1}
          max={20}
          step={1}
          integer
          value={contextMessages}
          onChange={(value) => onChange({ longTermMemoryRecallContextMessages: value })}
          className={compactInputClassName}
        />
      </SettingField>

      <SettingGroup label="Minimum relevance">
        <div className="grid grid-cols-[1fr_4.5rem] items-center gap-3">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={scoreThreshold}
            onChange={(event) => onChange({ longTermMemoryScoreThreshold: Number(event.target.value) })}
            className="min-w-0 accent-[var(--primary)]"
          />
          <DraftNumberInput
            min={0}
            max={1}
            step={0.05}
            value={scoreThreshold}
            onChange={(value) => onChange({ longTermMemoryScoreThreshold: value })}
            className={compactInputClassName}
          />
        </div>
      </SettingGroup>
    </>
  );
}

export function RecallRankingWeights({
  values,
  onChange,
}: {
  values: Partial<RecallSettingsValues>;
  onChange: (patch: Partial<RecallSettingsValues>) => void;
}) {
  const recallStyle = values.longTermMemoryRecallStyle ?? "balanced";
  const semanticWeight = values.longTermMemorySemanticWeight ?? LTM_RECALL_STYLE_WEIGHTS[recallStyle].semanticWeight;
  const lexicalWeight = values.longTermMemoryLexicalWeight ?? LTM_RECALL_STYLE_WEIGHTS[recallStyle].lexicalWeight;
  const graphWeight = values.longTermMemoryGraphWeight ?? LTM_RECALL_STYLE_WEIGHTS[recallStyle].graphWeight;
  const keywordWeight = values.longTermMemoryKeywordWeight ?? LTM_RECALL_STYLE_WEIGHTS[recallStyle].keywordWeight;

  const resetWeightOverrides = () => {
    onChange({
      longTermMemorySemanticWeight: null,
      longTermMemoryLexicalWeight: null,
      longTermMemoryGraphWeight: null,
      longTermMemoryKeywordWeight: null,
    });
  };

  return (
    <SettingGroup label="Ranking weights">
      <p className="mb-2 text-[0.6875rem] text-[var(--muted-foreground)]">
        Fine-tune how memories are found. Leave at default unless recall feels off.
      </p>
      <div className="space-y-2">
        {[
          { label: "Meaning", key: "longTermMemorySemanticWeight" as const, value: semanticWeight, max: 1 },
          { label: "Exact words", key: "longTermMemoryLexicalWeight" as const, value: lexicalWeight, max: 1 },
          { label: "Memory links", key: "longTermMemoryGraphWeight" as const, value: graphWeight, max: 1 },
          { label: "Keywords", key: "longTermMemoryKeywordWeight" as const, value: keywordWeight, max: 1 },
        ].map((item) => (
          <div key={item.key} className="grid grid-cols-[4.5rem_1fr_4.75rem] items-center gap-3">
            <label className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">{item.label}</label>
            <input
              type="range"
              min={LTM_WEIGHT_MIN}
              max={item.max}
              step={LTM_WEIGHT_STEP}
              value={item.value}
              onChange={(event) => onChange({ [item.key]: Number(event.target.value) })}
              className="min-w-0 accent-[var(--primary)]"
            />
            <DraftNumberInput
              min={LTM_WEIGHT_MIN}
              max={item.max}
              step={LTM_WEIGHT_STEP}
              value={item.value}
              onChange={(value) => onChange({ [item.key]: value })}
              className={compactInputClassName}
            />
          </div>
        ))}
      </div>
      <div className="mt-2">
        <ToolButton onClick={resetWeightOverrides}>
          <RotateCcw size="0.875rem" />
          Reset lane weights
        </ToolButton>
      </div>
    </SettingGroup>
  );
}

export function RecallToggles({
  values,
  onChange,
}: {
  values: Partial<RecallSettingsValues>;
  onChange: (patch: Partial<RecallSettingsValues>) => void;
}) {
  const includeResolved = values.longTermMemoryIncludeResolved ?? false;
  const debugEnabled = values.longTermMemoryDebug ?? false;
  return (
    <>
      <SettingsSwitch
        label="Include resolved threads"
        checked={includeResolved}
        onChange={(checked) => onChange({ longTermMemoryIncludeResolved: checked })}
        labelPosition="start"
        className="justify-between gap-3 p-1.5"
        labelClassName="text-xs"
      />
      <SettingsSwitch
        label="Debug retrieval logs"
        checked={debugEnabled}
        onChange={(checked) => onChange({ longTermMemoryDebug: checked })}
        labelPosition="start"
        className="justify-between gap-3 p-1.5"
        labelClassName="text-xs"
      />
    </>
  );
}

/* ── Debounce hook ── */

export function useDebouncedRecallSettings(
  onChange: (patch: Partial<RecallSettingsValues>) => void,
  delay = 400,
  scopeKey?: string,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{
    patch: Partial<RecallSettingsValues>;
    onChange: (patch: Partial<RecallSettingsValues>) => void;
  } | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) pending.onChange(pending.patch);
  }, []);

  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush, scopeKey]);

  const schedule = useCallback(
    (patch: Partial<RecallSettingsValues>) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const pending = pendingRef.current;
      pendingRef.current = {
        patch: { ...(pending?.patch ?? {}), ...patch },
        onChange,
      };
      timerRef.current = setTimeout(flush, delay);
    },
    [delay, flush, onChange],
  );

  return { flush, schedule };
}
