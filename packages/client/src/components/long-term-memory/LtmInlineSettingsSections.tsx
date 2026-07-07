import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, FileText, Link2, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { cn, generateClientId } from "../../lib/utils";
import {
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE,
  DEFAULT_LTM_EXTRACTION_TEMPERATURE,
  type LtmMode,
  type LtmExtractionReasoningEffort,
  type LtmExtractionVerbosity,
} from "@marinara-engine/shared";
import { useConnections } from "../../hooks/use-connections";
import { showAlertDialog, showPromptDialog } from "../../lib/app-dialogs";
import { MODE_LABELS } from "./ltm-panel-shared";
import { MacroTextarea } from "../ui/MacroTextarea";
import { FieldGroup } from "../agents/AgentEditor";
import { SettingInfoLabel } from "./LtmFields";
import { SettingsCheckbox } from "../panels/settings/SettingControls";

type PromptTemplate = { id: string; name: string; prompt: string };
type ActivePromptTemplateIdsByMode = Partial<Record<LtmMode, string | null>>;

const LTM_EXTRACTION_MODES = ["roleplay", "conversation", "game"] as const satisfies readonly LtmMode[];

function sanitizeActivePromptTemplateIdsByMode(
  activeIds: ActivePromptTemplateIdsByMode,
  templates: readonly PromptTemplate[],
) {
  const next: ActivePromptTemplateIdsByMode = {};
  for (const mode of LTM_EXTRACTION_MODES) {
    const id = activeIds[mode];
    if (!id) continue;
    const template = templates.find((candidate) => candidate.id === id);
    if (template) next[mode] = id;
  }
  return next;
}

function normalizePromptTemplate(template: PromptTemplate): PromptTemplate {
  return {
    id: template.id,
    name: template.name,
    prompt: template.prompt,
  };
}

function createPromptName(mode: LtmMode, templates: readonly PromptTemplate[]) {
  const base = `${MODE_LABELS[mode]} prompt`;
  const names = new Set(templates.map((template) => template.name.trim().toLocaleLowerCase()).filter(Boolean));
  if (!names.has(base.toLocaleLowerCase())) return base;
  let suffix = 2;
  while (names.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix++;
  return `${base} ${suffix}`;
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

const ltmNumberInputClassName =
  "w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]";

function LtmDraftNumberInput({
  value,
  min,
  max,
  step,
  integer = false,
  placeholder,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  placeholder?: string;
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
      placeholder={placeholder}
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
      className={ltmNumberInputClassName}
    />
  );
}

/* ── Extraction Connection Section ── */

export function LtmExtractionConnectionSection({
  connectionId,
  onChangeConnectionId,
}: {
  connectionId: string;
  onChangeConnectionId: (value: string) => void;
}) {
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

  return (
    <FieldGroup
      label="Extraction Connection"
      icon={<Link2 size="0.875rem" className="text-[var(--primary)]" />}
      help="Use a different AI connection for extraction. For example, use a faster/cheaper model for background processing tasks."
    >
      <select
        value={connectionId}
        onChange={(e) => onChangeConnectionId(e.target.value)}
        className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
      >
        <option value="">Default extraction model</option>
        <option value="random">Random pool</option>
        {textConnections.map((conn) => (
          <option key={conn.id} value={conn.id}>
            {conn.name}
            {conn.model ? ` - ${conn.model}` : ""}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">
        When empty, uses the workspace default connection from Settings.
      </p>
    </FieldGroup>
  );
}

/* ── Extraction Prompt Section ── */

type ExtractionPromptSectionProps = {
  promptTemplates: readonly PromptTemplate[];
  activePromptTemplateIdsByMode: ActivePromptTemplateIdsByMode;
  aiKeywordExtraction: boolean;
  refinePass: boolean;
  onChangePromptTemplates: (templates: PromptTemplate[]) => void;
  onChangeActivePromptTemplateIdsByMode: (value: ActivePromptTemplateIdsByMode) => void;
  onChangeAiKeywordExtraction: (value: boolean) => void;
  onChangeRefinePass: (value: boolean) => void;
  onPromptDraftDirtyChange?: (dirty: boolean) => void;
};

export function LtmExtractionPromptSection({
  promptTemplates,
  activePromptTemplateIdsByMode,
  aiKeywordExtraction,
  refinePass,
  onChangePromptTemplates,
  onChangeActivePromptTemplateIdsByMode,
  onChangeAiKeywordExtraction,
  onChangeRefinePass,
  onPromptDraftDirtyChange,
}: ExtractionPromptSectionProps) {
  const [selectedMode, setSelectedMode] = useState<LtmMode>("conversation");
  const [localTemplates, setLocalTemplates] = useState<PromptTemplate[]>(promptTemplates.map(normalizePromptTemplate));

  useEffect(() => {
    setLocalTemplates(promptTemplates.map(normalizePromptTemplate));
  }, [promptTemplates]);

  const selectedTemplateId = activePromptTemplateIdsByMode[selectedMode] ?? "";
  const selectedTemplate = localTemplates.find((template) => template.id === selectedTemplateId) ?? null;
  const selectedPromptSource = selectedTemplate?.prompt ?? DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE[selectedMode];
  const isUsingDefaultPrompt = !selectedTemplate;
  const [localPrompt, setLocalPrompt] = useState(selectedPromptSource);

  useEffect(() => {
    setLocalPrompt(selectedPromptSource);
  }, [selectedPromptSource]);

  const hasPromptDraftEdits = localPrompt !== selectedPromptSource;
  const canSavePrompt = localPrompt.trim().length > 0;

  useEffect(() => {
    onPromptDraftDirtyChange?.(hasPromptDraftEdits);
  }, [hasPromptDraftEdits, onPromptDraftDirtyChange]);

  const publishTemplates = useCallback(
    (templates: PromptTemplate[], activeIds = activePromptTemplateIdsByMode) => {
      const normalized = templates.map(normalizePromptTemplate);
      setLocalTemplates(normalized);
      onChangePromptTemplates(normalized);
      onChangeActivePromptTemplateIdsByMode(sanitizeActivePromptTemplateIdsByMode(activeIds, normalized));
    },
    [activePromptTemplateIdsByMode, onChangePromptTemplates, onChangeActivePromptTemplateIdsByMode],
  );

  const confirmDiscardPromptEdits = useCallback(() => {
    return !hasPromptDraftEdits || confirm("Discard unsaved prompt edits?");
  }, [hasPromptDraftEdits]);

  const handleModeChange = useCallback(
    (mode: LtmMode) => {
      if (mode === selectedMode || !confirmDiscardPromptEdits()) return;
      setSelectedMode(mode);
    },
    [confirmDiscardPromptEdits, selectedMode],
  );

  const handleSelectPrompt = useCallback(
    (id: string) => {
      if (!confirmDiscardPromptEdits()) return;
      const next = { ...activePromptTemplateIdsByMode };
      if (id) next[selectedMode] = id;
      else delete next[selectedMode];
      onChangeActivePromptTemplateIdsByMode(sanitizeActivePromptTemplateIdsByMode(next, localTemplates));
    },
    [
      activePromptTemplateIdsByMode,
      confirmDiscardPromptEdits,
      localTemplates,
      onChangeActivePromptTemplateIdsByMode,
      selectedMode,
    ],
  );

  const handleAddTemplate = useCallback(() => {
    const template: PromptTemplate = {
      id: generateClientId(),
      name: createPromptName(selectedMode, localTemplates),
      prompt: localPrompt.trim() ? localPrompt : DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE[selectedMode],
    };
    const nextActiveIds = { ...activePromptTemplateIdsByMode, [selectedMode]: template.id };
    publishTemplates([...localTemplates, template], nextActiveIds);
  }, [activePromptTemplateIdsByMode, localPrompt, localTemplates, publishTemplates, selectedMode]);

  const handleSavePrompt = useCallback(() => {
    const prompt = localPrompt.trim() ? localPrompt : selectedPromptSource;
    if (!prompt.trim()) return;

    if (selectedTemplate) {
      publishTemplates(
        localTemplates.map((template) =>
          template.id === selectedTemplate.id ? { ...template, prompt } : template,
        ),
      );
      return;
    }

    const template: PromptTemplate = {
      id: generateClientId(),
      name: createPromptName(selectedMode, localTemplates),
      prompt,
    };
    const nextActiveIds = { ...activePromptTemplateIdsByMode, [selectedMode]: template.id };
    publishTemplates([...localTemplates, template], nextActiveIds);
  }, [
    activePromptTemplateIdsByMode,
    localPrompt,
    localTemplates,
    publishTemplates,
    selectedMode,
    selectedPromptSource,
    selectedTemplate,
  ]);

  const handleRenameTemplate = useCallback(async () => {
    if (!selectedTemplate) return;
    const nextName = await showPromptDialog({
      title: "Rename Prompt",
      message: "Set a display name for this extraction prompt option.",
      defaultValue: selectedTemplate.name,
      placeholder: "Prompt name",
      confirmLabel: "Rename",
    });
    if (nextName === null) return;
    const name = nextName.trim();
    if (!name || name === selectedTemplate.name) return;
    if (name.length > 120) {
      await showAlertDialog({
        title: "Name Too Long",
        message: "Prompt names must be 120 characters or fewer.",
      });
      return;
    }
    publishTemplates(
      localTemplates.map((template) =>
        template.id === selectedTemplate.id ? { ...template, name } : template,
      ),
    );
  }, [localTemplates, publishTemplates, selectedTemplate]);

  const handleRemoveTemplate = useCallback(
    (id: string | null) => {
      if (!id) return;
      const template = localTemplates.find((item) => item.id === id);
      if (!template || !confirm(`Remove "${template.name}"?`)) return;
      const nextTemplates = localTemplates.filter((item) => item.id !== id);
      const nextActiveIds: ActivePromptTemplateIdsByMode = {};
      for (const mode of LTM_EXTRACTION_MODES) {
        const activeId = activePromptTemplateIdsByMode[mode];
        if (activeId && activeId !== id) nextActiveIds[mode] = activeId;
      }
      publishTemplates(nextTemplates, nextActiveIds);
    },
    [activePromptTemplateIdsByMode, localTemplates, publishTemplates],
  );

  return (
    <FieldGroup
      label="Extraction Prompt"
      icon={<FileText size="0.875rem" className="text-[var(--primary)]" />}
      help="The system prompt used for the extraction process."
    >
      <div className="mari-chrome-segmented mb-3">
        {(["roleplay", "conversation", "game"] as LtmMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => handleModeChange(mode)}
            aria-pressed={selectedMode === mode}
            className={cn(
              "mari-chrome-segmented__button px-3 text-[0.6875rem]",
              selectedMode === mode && "mari-chrome-segmented__button--selected",
            )}
          >
            {MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      <div className="mb-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
        <label className="block">
          <span className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
            Prompt option
          </span>
          <select
            value={selectedTemplate?.id ?? ""}
            onChange={(event) => handleSelectPrompt(event.target.value)}
            className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
          >
            <option value="">Default {MODE_LABELS[selectedMode]} prompt</option>
            {localTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <button
            type="button"
            onClick={handleAddTemplate}
            className="mari-chrome-control mari-chrome-control--small h-10 text-[0.6875rem]"
          >
            <Plus size="0.6875rem" />
            Add
          </button>
          <button
            type="button"
            onClick={handleSavePrompt}
            disabled={!hasPromptDraftEdits || !canSavePrompt}
            className="mari-chrome-control mari-chrome-control--small mari-chrome-control--primary h-10 text-[0.6875rem]"
          >
            <Save size="0.6875rem" />
            Save Prompt
          </button>
          <button
            type="button"
            onClick={() => void handleRenameTemplate()}
            disabled={!selectedTemplate}
            className="mari-chrome-control mari-chrome-control--small h-10 text-[0.6875rem]"
            title={selectedTemplate ? "Rename prompt" : "Default prompts cannot be renamed"}
          >
            <Pencil size="0.6875rem" />
            Rename
          </button>
          <button
            type="button"
            onClick={() => handleRemoveTemplate(selectedTemplate?.id ?? null)}
            disabled={!selectedTemplate}
            className="mari-chrome-control mari-chrome-control--small mari-chrome-control--danger h-10 text-[0.6875rem]"
          >
            <Trash2 size="0.6875rem" />
            Remove
          </button>
        </div>
      </div>

      <div className="mb-2 flex items-center gap-2">
        {isUsingDefaultPrompt ? (
          <span className="flex items-center gap-1 rounded-lg bg-emerald-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-emerald-400">
            <Check size="0.625rem" /> Built-in default
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded-lg bg-amber-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-amber-400">
            <FileText size="0.625rem" /> Custom prompt
          </span>
        )}
        {hasPromptDraftEdits && (
          <span className="rounded-lg bg-amber-400/10 px-2.5 py-1 text-[0.625rem] font-medium text-amber-400">
            Unsaved prompt edit
          </span>
        )}
      </div>

      <MacroTextarea
        value={localPrompt}
        onChange={setLocalPrompt}
        rows={12}
        title="Extraction Prompt"
        placeholder="Write the extraction system prompt..."
        className="w-full resize-y rounded-xl bg-[var(--secondary)] px-4 py-3 font-mono text-xs leading-relaxed ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)] max-h-[40vh] overflow-y-auto"
      />

      <div className="mt-4 space-y-2">
        <SettingsCheckbox
          label="Ask AI to suggest keywords for extracted memories"
          checked={aiKeywordExtraction}
          onChange={onChangeAiKeywordExtraction}
        />
        <SettingsCheckbox
          label="Run a second refine pass over imported game summaries"
          checked={refinePass}
          onChange={onChangeRefinePass}
        />
      </div>
    </FieldGroup>
  );
}

/* ── LTM Inline Settings (Advanced collapsible content) ── */

export default function LtmInlineSettingsSections({
  extractionSettings,
  autoApplyLowRisk,
  onChangeExtraction,
  onChangeGlobal,
}: {
  extractionSettings: {
    reasoningEffort: string;
    verbosity: string;
    maxOutputTokens: number;
    temperature: number;
    maxExistingNoteTokens: number;
  };
  autoApplyLowRisk: boolean;
  onChangeExtraction: (patch: Record<string, unknown>) => void;
  onChangeGlobal: (patch: Record<string, unknown>) => void;
}) {
  return (
    <>
      <FieldGroup
        label="Token budgets"
        icon={<FileText size="0.875rem" className="text-[var(--primary)]" />}
        help="Control what extraction can read from existing memories and what it can write back."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
              <SettingInfoLabel
                label="Extraction output budget"
                help="How many tokens the AI can use for the extraction result, including summaries and proposed memory updates."
              />
            </span>
            <LtmDraftNumberInput
              min={512}
              max={32768}
              integer
              value={extractionSettings.maxOutputTokens}
              onChange={(value) => onChangeExtraction({ maxOutputTokens: value })}
              placeholder={String(DEFAULT_LTM_EXTRACTION_MAX_TOKENS)}
              ariaLabel="Extraction output budget"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
              <SettingInfoLabel
                label="Extraction context budget"
                help="How many tokens relevant existing memories can use during extraction. Source memory text is always read in full."
              />
            </span>
            <LtmDraftNumberInput
              min={128}
              max={32768}
              integer
              value={extractionSettings.maxExistingNoteTokens}
              onChange={(value) =>
                onChangeExtraction({
                  maxExistingNoteTokens: value,
                  existingNoteMaxTokens: value,
                })
              }
              placeholder={String(DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS)}
              ariaLabel="Extraction context budget"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup
        label="Extraction behavior"
        icon={<FileText size="0.875rem" className="text-[var(--primary)]" />}
        help="Expert tuning for how the AI reasons over source notes."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Reasoning effort</span>
            <select
              value={extractionSettings.reasoningEffort}
              onChange={(e) => onChangeExtraction({ reasoningEffort: e.target.value as LtmExtractionReasoningEffort })}
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
              value={extractionSettings.verbosity}
              onChange={(e) => onChangeExtraction({ verbosity: e.target.value as LtmExtractionVerbosity })}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Temperature</span>
            <LtmDraftNumberInput
              min={0}
              max={2}
              step={0.1}
              value={extractionSettings.temperature}
              onChange={(value) => onChangeExtraction({ temperature: value })}
              placeholder={String(DEFAULT_LTM_EXTRACTION_TEMPERATURE)}
            />
          </label>
        </div>

        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <SettingsCheckbox
            label="Auto-accept safe changes"
            description="Lets the AI accept obvious (low-risk) facts without asking. Medium/high-risk changes still need review."
            checked={autoApplyLowRisk}
            onChange={(checked) => onChangeGlobal({ autoApplyLowRisk: checked })}
          />
        </div>
      </FieldGroup>
    </>
  );
}
