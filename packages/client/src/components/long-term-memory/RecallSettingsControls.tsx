import { type ReactNode } from "react";
import { Info, RotateCcw } from "lucide-react";
import { LTM_RECALL_STYLE_WEIGHTS } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import {
  compactInputClassName,
  sectionCardClassName,
  SettingField,
} from "./LtmFields";
import { ToolButton } from "./LtmPills";
import {
  LTM_RECALL_STYLES,
  LTM_WEIGHT_MIN,
  LTM_WEIGHT_STEP,
} from "./ltm-panel-shared";

export type RecallSettingsValues = {
  longTermMemoryBudgetTokens: number;
  longTermMemoryMaxChunks: number;
  longTermMemoryScoreThreshold: number;
  longTermMemoryRecallContextMessages: number;
  longTermMemoryRecallStyle: "balanced" | "exact" | "broad" | "story";
  longTermMemorySemanticWeight: number | null;
  longTermMemoryLexicalWeight: number | null;
  longTermMemoryGraphWeight: number | null;
  longTermMemoryIncludeResolved: boolean;
  longTermMemoryDebug: boolean;
};

type RecallSettingsControlsProps = {
  values: Partial<RecallSettingsValues>;
  onChange: (patch: Partial<RecallSettingsValues>) => void;
  showExpert?: boolean;
  showStylesOnly?: boolean;
};

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

export function RecallSettingsControls({
  values,
  onChange,
  showExpert = true,
  showStylesOnly = false,
}: RecallSettingsControlsProps) {
  const recallStyle = values.longTermMemoryRecallStyle ?? "balanced";
  const budgetTokens = values.longTermMemoryBudgetTokens ?? 4096;
  const maxChunks = values.longTermMemoryMaxChunks ?? 20;
  const scoreThreshold = values.longTermMemoryScoreThreshold ?? 0;
  const contextMessages = values.longTermMemoryRecallContextMessages ?? 4;
  const includeResolved = values.longTermMemoryIncludeResolved ?? false;
  const debugEnabled = values.longTermMemoryDebug ?? false;

  const semanticWeight = values.longTermMemorySemanticWeight ?? LTM_RECALL_STYLE_WEIGHTS[recallStyle].semanticWeight;
  const lexicalWeight = values.longTermMemoryLexicalWeight ?? LTM_RECALL_STYLE_WEIGHTS[recallStyle].lexicalWeight;
  const graphWeight = values.longTermMemoryGraphWeight ?? LTM_RECALL_STYLE_WEIGHTS[recallStyle].graphWeight;

  const resetWeightOverrides = () => {
    onChange({
      longTermMemorySemanticWeight: null,
      longTermMemoryLexicalWeight: null,
      longTermMemoryGraphWeight: null,
    });
  };

  if (showStylesOnly) {
    return (
      <SettingGroup label="Recall style">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--background)] p-1 ring-1 ring-[var(--border)]">
          {LTM_RECALL_STYLES.map((style) => (
            <div key={style.id} className="grid grid-cols-[1fr_auto] overflow-hidden rounded-md">
              <button
                type="button"
                onClick={() => onChange({ longTermMemoryRecallStyle: style.id })}
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
    );
  }

  return (
    <div className={cn(sectionCardClassName, "space-y-3")}>

      <SettingField label="Memory budget">
        <div className="grid grid-cols-[1fr_5.5rem] items-center gap-3">
          <input
            type="range"
            min={128}
            max={16384}
            step={128}
            value={budgetTokens}
            onChange={(event) => onChange({ longTermMemoryBudgetTokens: Number(event.target.value) })}
            className="min-w-0 accent-[var(--primary)]"
          />
          <input
            type="number"
            min={128}
            max={16384}
            step={128}
            value={budgetTokens}
            onChange={(event) => onChange({ longTermMemoryBudgetTokens: Number(event.target.value) })}
            className={compactInputClassName}
          />
        </div>
      </SettingField>

      <div className="grid gap-3 sm:grid-cols-2">
        <SettingField label="Max memories">
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={maxChunks}
            onChange={(event) => onChange({ longTermMemoryMaxChunks: Number(event.target.value) })}
            className={compactInputClassName}
          />
        </SettingField>
        <SettingField label="Context messages">
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={contextMessages}
            onChange={(event) => onChange({ longTermMemoryRecallContextMessages: Number(event.target.value) })}
            className={compactInputClassName}
          />
        </SettingField>
      </div>

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
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={scoreThreshold}
            onChange={(event) => onChange({ longTermMemoryScoreThreshold: Number(event.target.value) })}
            className={compactInputClassName}
          />
        </div>
      </SettingGroup>

      {showExpert && (
        <SettingGroup label="Ranking Weights">
          <div className="space-y-2">
            {[
              { label: "Meaning", key: "longTermMemorySemanticWeight" as const, value: semanticWeight, max: 1 },
              { label: "Exact Words", key: "longTermMemoryLexicalWeight" as const, value: lexicalWeight, max: 1 },
              { label: "Memory Links", key: "longTermMemoryGraphWeight" as const, value: graphWeight, max: 1 },
            ].map((item) => (
              <div key={item.key} className="grid grid-cols-[4.5rem_1fr_4.75rem] items-center gap-3">
                <label className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
                  {item.label}
                </label>
                <input
                  type="range"
                  min={LTM_WEIGHT_MIN}
                  max={item.max}
                  step={LTM_WEIGHT_STEP}
                  value={item.value}
                  onChange={(event) => onChange({ [item.key]: Number(event.target.value) })}
                  className="min-w-0 accent-[var(--primary)]"
                />
                <input
                  type="number"
                  min={LTM_WEIGHT_MIN}
                  max={item.max}
                  step={LTM_WEIGHT_STEP}
                  value={item.value}
                  onChange={(event) => onChange({ [item.key]: Number(event.target.value) })}
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
      )}

      <SettingToggle
        label="Include resolved threads"
        checked={includeResolved}
        onChange={(checked) => onChange({ longTermMemoryIncludeResolved: checked })}
      />

      <SettingToggle
        label="Debug retrieval logs"
        checked={debugEnabled}
        onChange={(checked) => onChange({ longTermMemoryDebug: checked })}
      />
    </div>
  );
}
