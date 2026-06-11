import { useEffect, useMemo, useState } from "react";
import { BrainCircuit, Loader2, RotateCcw, Save, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import type { LtmExtractionReasoningEffort, LtmExtractionVerbosity } from "@marinara-engine/shared";
import {
  useLongTermMemoryExtractionSettings,
  useUpdateLongTermMemoryExtractionSettings,
  type LtmExtractionSettings,
  type LtmResolvedExtractionSettings,
} from "../../hooks/use-long-term-memory";
import { cn } from "../../lib/utils";
import { Modal } from "../ui/Modal";
import { SettingField, compactInputClassName, textareaClassName } from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";

type OptionalLevel<T extends string> = "default" | T;

type ExtractionSettingsDraft = {
  systemPrompt: string;
  extraInstruction: string;
  reasoningEffort: OptionalLevel<LtmExtractionReasoningEffort>;
  verbosity: OptionalLevel<LtmExtractionVerbosity>;
  maxOutputTokens: string;
  temperature: string;
  maxSourceChars: string;
  maxExistingNoteChars: string;
  existingNoteMaxChunks: string;
  existingNoteMaxTokens: string;
  rejectPlaceholderOutput: boolean;
};

const DEFAULT_SETTINGS = {
  reasoningEffort: "low",
  verbosity: "low",
  maxOutputTokens: 3200,
  temperature: 0,
  maxSourceChars: 24_000,
  maxExistingNoteChars: 12_000,
  existingNoteMaxChunks: 12,
  existingNoteMaxTokens: 2400,
  rejectPlaceholderOutput: true,
} as const;

const LEVEL_OPTIONS = ["default", "low", "medium", "high"] as const;

function draftFromSettings(settings: LtmResolvedExtractionSettings): ExtractionSettingsDraft {
  return {
    systemPrompt: settings.systemPrompt,
    extraInstruction: settings.extraInstruction,
    reasoningEffort:
      settings.reasoningEffort === DEFAULT_SETTINGS.reasoningEffort ? "default" : settings.reasoningEffort,
    verbosity: settings.verbosity === DEFAULT_SETTINGS.verbosity ? "default" : settings.verbosity,
    maxOutputTokens: String(settings.maxOutputTokens),
    temperature: String(settings.temperature),
    maxSourceChars: String(settings.maxSourceChars),
    maxExistingNoteChars: String(settings.maxExistingNoteChars),
    existingNoteMaxChunks: String(settings.existingNoteMaxChunks),
    existingNoteMaxTokens: String(settings.existingNoteMaxTokens),
    rejectPlaceholderOutput: settings.rejectPlaceholderOutput,
  };
}

function parseInteger(value: string, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseNumber(value: string, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function payloadFromDraft(draft: ExtractionSettingsDraft): LtmExtractionSettings {
  const payload: LtmExtractionSettings = { version: 1 };
  const systemPrompt = draft.systemPrompt.trim();
  const extraInstruction = draft.extraInstruction.trim();
  if (systemPrompt) payload.systemPrompt = systemPrompt;
  if (extraInstruction) payload.extraInstruction = extraInstruction;
  if (draft.reasoningEffort !== "default") payload.reasoningEffort = draft.reasoningEffort;
  if (draft.verbosity !== "default") payload.verbosity = draft.verbosity;
  payload.maxOutputTokens = parseInteger(draft.maxOutputTokens, 512, 32_768, DEFAULT_SETTINGS.maxOutputTokens);
  payload.temperature = parseNumber(draft.temperature, 0, 2, DEFAULT_SETTINGS.temperature);
  payload.maxSourceChars = parseInteger(draft.maxSourceChars, 1_000, 200_000, DEFAULT_SETTINGS.maxSourceChars);
  payload.maxExistingNoteChars = parseInteger(
    draft.maxExistingNoteChars,
    1_000,
    100_000,
    DEFAULT_SETTINGS.maxExistingNoteChars,
  );
  payload.existingNoteMaxChunks = parseInteger(
    draft.existingNoteMaxChunks,
    1,
    100,
    DEFAULT_SETTINGS.existingNoteMaxChunks,
  );
  payload.existingNoteMaxTokens = parseInteger(
    draft.existingNoteMaxTokens,
    128,
    16_384,
    DEFAULT_SETTINGS.existingNoteMaxTokens,
  );
  payload.rejectPlaceholderOutput = draft.rejectPlaceholderOutput;
  return payload;
}

function resolvedFromDraft(draft: ExtractionSettingsDraft, current: LtmResolvedExtractionSettings) {
  return {
    systemPrompt: draft.systemPrompt.trim(),
    extraInstruction: draft.extraInstruction.trim(),
    reasoningEffort: draft.reasoningEffort === "default" ? DEFAULT_SETTINGS.reasoningEffort : draft.reasoningEffort,
    verbosity: draft.verbosity === "default" ? DEFAULT_SETTINGS.verbosity : draft.verbosity,
    maxOutputTokens: parseInteger(draft.maxOutputTokens, 512, 32_768, DEFAULT_SETTINGS.maxOutputTokens),
    temperature: parseNumber(draft.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    maxSourceChars: parseInteger(draft.maxSourceChars, 1_000, 200_000, DEFAULT_SETTINGS.maxSourceChars),
    maxExistingNoteChars: parseInteger(
      draft.maxExistingNoteChars,
      1_000,
      100_000,
      DEFAULT_SETTINGS.maxExistingNoteChars,
    ),
    existingNoteMaxChunks: parseInteger(draft.existingNoteMaxChunks, 1, 100, DEFAULT_SETTINGS.existingNoteMaxChunks),
    existingNoteMaxTokens: parseInteger(
      draft.existingNoteMaxTokens,
      128,
      16_384,
      DEFAULT_SETTINGS.existingNoteMaxTokens,
    ),
    rejectPlaceholderOutput: draft.rejectPlaceholderOutput,
    version: current.version,
  };
}

function isDraftDirty(draft: ExtractionSettingsDraft, current: LtmResolvedExtractionSettings) {
  const resolved = resolvedFromDraft(draft, current);
  return (
    resolved.systemPrompt !== current.systemPrompt ||
    resolved.extraInstruction !== current.extraInstruction ||
    resolved.reasoningEffort !== current.reasoningEffort ||
    resolved.verbosity !== current.verbosity ||
    resolved.maxOutputTokens !== current.maxOutputTokens ||
    resolved.temperature !== current.temperature ||
    resolved.maxSourceChars !== current.maxSourceChars ||
    resolved.maxExistingNoteChars !== current.maxExistingNoteChars ||
    resolved.existingNoteMaxChunks !== current.existingNoteMaxChunks ||
    resolved.existingNoteMaxTokens !== current.existingNoteMaxTokens ||
    resolved.rejectPlaceholderOutput !== current.rejectPlaceholderOutput
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: string) => void;
}) {
  return (
    <SettingField label={label}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={compactInputClassName}
      />
    </SettingField>
  );
}

function LevelSelect<T extends string>({
  label,
  value,
  onChange,
}: {
  label: string;
  value: OptionalLevel<T>;
  onChange: (value: OptionalLevel<T>) => void;
}) {
  return (
    <SettingField label={label}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as OptionalLevel<T>)}
        className={compactInputClassName}
      >
        {LEVEL_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option === "default" ? "Default" : option.charAt(0).toUpperCase() + option.slice(1)}
          </option>
        ))}
      </select>
    </SettingField>
  );
}

export function LongTermMemoryExtractionSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useLongTermMemoryExtractionSettings({ enabled: open });
  const updateSettings = useUpdateLongTermMemoryExtractionSettings();
  const [draft, setDraft] = useState<ExtractionSettingsDraft | null>(null);

  useEffect(() => {
    if (open && settings.data) setDraft(draftFromSettings(settings.data));
  }, [open, settings.data]);

  const dirty = useMemo(
    () => Boolean(draft && settings.data && isDraftDirty(draft, settings.data)),
    [draft, settings.data],
  );

  const set = <K extends keyof ExtractionSettingsDraft>(key: K, value: ExtractionSettingsDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const save = () => {
    if (!draft) return;
    updateSettings
      .mutateAsync(payloadFromDraft(draft))
      .then((next) => {
        setDraft(draftFromSettings(next));
        toast.success("Extraction settings saved");
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const reset = () => {
    updateSettings
      .mutateAsync({ version: 1 })
      .then((next) => {
        setDraft(draftFromSettings(next));
        toast.success("Extraction settings reset");
      })
      .catch((err: Error) => toast.error(err.message));
  };

  return (
    <Modal open={open} onClose={onClose} title="Extraction Settings" width="max-w-4xl">
      {settings.isError ? (
        <div className="rounded-lg bg-[var(--secondary)]/35 p-3 text-xs text-[var(--destructive)] ring-1 ring-[var(--border)]">
          {(settings.error as Error).message}
        </div>
      ) : settings.isLoading || !draft ? (
        <div className="grid min-h-52 place-items-center text-[var(--muted-foreground)]">
          <Loader2 size="1.25rem" className="animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BrainCircuit size="1rem" className="text-rose-200" />
              <span className="text-xs font-medium text-[var(--foreground)]">Source note extractor</span>
              {dirty ? <StatusPill label="Unsaved" tone="warn" /> : <StatusPill label="Saved" tone="good" />}
            </div>
            <button
              type="button"
              onClick={() => setDraft(settings.data ? draftFromSettings(settings.data) : draft)}
              disabled={!dirty || updateSettings.isPending}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-all hover:bg-[var(--accent)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X size="0.875rem" />
              Discard
            </button>
          </div>

          <section className="space-y-3 border-t border-[var(--border)] pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--foreground)]">
                <SlidersHorizontal size="0.875rem" />
                Prompt
              </div>
              <button
                type="button"
                onClick={() => {
                  set("systemPrompt", "");
                  set("extraInstruction", "");
                }}
                className="rounded-md px-2 py-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
              >
                Reset prompt
              </button>
            </div>
            <SettingField label="System prompt override">
              <textarea
                value={draft.systemPrompt}
                onChange={(event) => set("systemPrompt", event.target.value)}
                className={cn(textareaClassName, "min-h-48 font-mono leading-relaxed")}
              />
            </SettingField>
            <SettingField label="Extra user instruction">
              <textarea
                value={draft.extraInstruction}
                onChange={(event) => set("extraInstruction", event.target.value)}
                className={cn(textareaClassName, "min-h-24")}
              />
            </SettingField>
          </section>

          <section className="space-y-3 border-t border-[var(--border)] pt-3">
            <div className="text-xs font-semibold text-[var(--foreground)]">Model Behavior</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <LevelSelect<LtmExtractionReasoningEffort>
                label="Reasoning effort"
                value={draft.reasoningEffort}
                onChange={(value) => set("reasoningEffort", value)}
              />
              <LevelSelect<LtmExtractionVerbosity>
                label="Verbosity"
                value={draft.verbosity}
                onChange={(value) => set("verbosity", value)}
              />
              <NumberField
                label="Max output tokens"
                value={draft.maxOutputTokens}
                min={512}
                max={32_768}
                step={128}
                onChange={(value) => set("maxOutputTokens", value)}
              />
              <NumberField
                label="Temperature"
                value={draft.temperature}
                min={0}
                max={2}
                step={0.1}
                onChange={(value) => set("temperature", value)}
              />
            </div>
          </section>

          <section className="space-y-3 border-t border-[var(--border)] pt-3">
            <div className="text-xs font-semibold text-[var(--foreground)]">Extraction Shape</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                label="Max source chars"
                value={draft.maxSourceChars}
                min={1_000}
                max={200_000}
                step={1000}
                onChange={(value) => set("maxSourceChars", value)}
              />
              <NumberField
                label="Existing note chars"
                value={draft.maxExistingNoteChars}
                min={1_000}
                max={100_000}
                step={1000}
                onChange={(value) => set("maxExistingNoteChars", value)}
              />
              <NumberField
                label="Existing note chunks"
                value={draft.existingNoteMaxChunks}
                min={1}
                max={100}
                step={1}
                onChange={(value) => set("existingNoteMaxChunks", value)}
              />
              <NumberField
                label="Existing note tokens"
                value={draft.existingNoteMaxTokens}
                min={128}
                max={16_384}
                step={128}
                onChange={(value) => set("existingNoteMaxTokens", value)}
              />
            </div>
            <label className="flex min-h-9 items-center justify-between gap-3 rounded-lg bg-[var(--secondary)]/35 px-3 py-2 ring-1 ring-[var(--border)]">
              <span className="text-xs font-medium text-[var(--foreground)]">Treat placeholder output as an error</span>
              <input
                type="checkbox"
                checked={draft.rejectPlaceholderOutput}
                onChange={(event) => set("rejectPlaceholderOutput", event.target.checked)}
                className="h-4 w-4 rounded border-[var(--border)] accent-[var(--primary)]"
              />
            </label>
          </section>

          <div className="flex flex-wrap justify-end gap-2">
            <ToolButton onClick={onClose} disabled={updateSettings.isPending}>
              Cancel
            </ToolButton>
            <ToolButton onClick={reset} disabled={updateSettings.isPending}>
              {updateSettings.isPending ? (
                <Loader2 size="0.875rem" className="animate-spin" />
              ) : (
                <RotateCcw size="0.875rem" />
              )}
              Reset
            </ToolButton>
            <ToolButton onClick={save} disabled={!dirty || updateSettings.isPending} tone="primary">
              {updateSettings.isPending ? (
                <Loader2 size="0.875rem" className="animate-spin" />
              ) : (
                <Save size="0.875rem" />
              )}
              Save
            </ToolButton>
          </div>
        </div>
      )}
    </Modal>
  );
}
