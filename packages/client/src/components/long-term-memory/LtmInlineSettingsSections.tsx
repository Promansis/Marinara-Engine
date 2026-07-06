import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, FileText, Link2, Plus, Save, Trash2 } from "lucide-react";
import { cn, generateClientId } from "../../lib/utils";
import {
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS,
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE,
  DEFAULT_LTM_EXTRACTION_TEMPERATURE,
  type LtmMode,
  type LtmExtractionReasoningEffort,
  type LtmExtractionVerbosity,
} from "@marinara-engine/shared";
import { useConnections } from "../../hooks/use-connections";
import { MODE_LABELS } from "./ltm-panel-shared";
import { MacroTextarea } from "../ui/MacroTextarea";
import { textareaClassName } from "./LtmFields";
import { FieldGroup } from "../agents/AgentEditor";

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
  extraInstruction: string;
  aiKeywordExtraction: boolean;
  refinePass: boolean;
  onChangePromptTemplates: (templates: PromptTemplate[]) => void;
  onChangeActivePromptTemplateIdsByMode: (value: ActivePromptTemplateIdsByMode) => void;
  onChangeExtraInstruction: (value: string) => void;
  onChangeAiKeywordExtraction: (value: boolean) => void;
  onChangeRefinePass: (value: boolean) => void;
  onPromptDraftDirtyChange?: (dirty: boolean) => void;
};

export function LtmExtractionPromptSection({
  promptTemplates,
  activePromptTemplateIdsByMode,
  extraInstruction,
  aiKeywordExtraction,
  refinePass,
  onChangePromptTemplates,
  onChangeActivePromptTemplateIdsByMode,
  onChangeExtraInstruction,
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
  const selectedNameSource = selectedTemplate?.name ?? `${MODE_LABELS[selectedMode]} default`;
  const isUsingDefaultPrompt = !selectedTemplate;
  const [localPrompt, setLocalPrompt] = useState(selectedPromptSource);
  const [localName, setLocalName] = useState(selectedNameSource);

  useEffect(() => {
    setLocalPrompt(selectedPromptSource);
    setLocalName(selectedNameSource);
  }, [selectedNameSource, selectedPromptSource]);

  const hasPromptDraftEdits = localPrompt !== selectedPromptSource || localName !== selectedNameSource;
  const canSavePrompt = localPrompt.trim().length > 0 && (isUsingDefaultPrompt || localName.trim().length > 0);

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
      const name = localName.trim() || selectedTemplate.name;
      publishTemplates(
        localTemplates.map((template) =>
          template.id === selectedTemplate.id ? { ...template, name, prompt } : template,
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
    localName,
    localPrompt,
    localTemplates,
    publishTemplates,
    selectedMode,
    selectedPromptSource,
    selectedTemplate,
  ]);

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
      <div className="flex gap-1 mb-3">
        {(["roleplay", "conversation", "game"] as LtmMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => handleModeChange(mode)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium transition-colors",
              selectedMode === mode
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
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
            className="flex h-10 items-center gap-1.5 rounded-lg bg-[var(--secondary)] px-3 text-[0.6875rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
          >
            <Plus size="0.6875rem" />
            Add
          </button>
          <button
            type="button"
            onClick={handleSavePrompt}
            disabled={!hasPromptDraftEdits || !canSavePrompt}
            className="flex h-10 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 text-[0.6875rem] font-medium text-[var(--primary-foreground)] transition-colors hover:bg-[var(--primary)]/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save size="0.6875rem" />
            Save Prompt
          </button>
          <button
            type="button"
            onClick={() => handleRemoveTemplate(selectedTemplate?.id ?? null)}
            disabled={!selectedTemplate}
            className="flex h-10 items-center gap-1.5 rounded-lg bg-[var(--secondary)] px-3 text-[0.6875rem] font-medium text-[var(--destructive)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--destructive)]/15 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[var(--secondary)]"
          >
            <Trash2 size="0.6875rem" />
            Remove
          </button>
        </div>
      </div>

      {selectedTemplate && (
        <label className="mb-3 block">
          <span className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
            Prompt name
          </span>
          <input
            value={localName}
            onChange={(event) => setLocalName(event.target.value)}
            className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            placeholder="Prompt name"
          />
        </label>
      )}

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
        <label className="block">
          <span className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
            Extra user instruction
          </span>
          <textarea
            value={extraInstruction}
            onChange={(event) => onChangeExtraInstruction(event.target.value)}
            className={cn(textareaClassName, "min-h-20")}
          />
        </label>
        <label className="flex items-center gap-2 rounded-lg px-1 py-1 text-xs text-[var(--foreground)]">
          <input
            type="checkbox"
            checked={aiKeywordExtraction}
            onChange={(event) => onChangeAiKeywordExtraction(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
          />
          <span>Ask AI to suggest keywords for extracted memories</span>
        </label>
        <label className="flex items-center gap-2 rounded-lg px-1 py-1 text-xs text-[var(--foreground)]">
          <input
            type="checkbox"
            checked={refinePass}
            onChange={(event) => onChangeRefinePass(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
          />
          <span>Run a second refine pass over imported game summaries</span>
        </label>
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
    maxSourceTokens: number;
    maxExistingNoteTokens: number;
    existingNoteMaxChunks: number;
    existingNoteMaxTokens: number;
  };
  autoApplyLowRisk: boolean;
  onChangeExtraction: (patch: Record<string, unknown>) => void;
  onChangeGlobal: (patch: Record<string, unknown>) => void;
}) {
  return (
    <>
      {/* Section 1 — AI Limits */}
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
              value={extractionSettings.maxOutputTokens}
              onChange={(e) =>
                onChangeExtraction({ maxOutputTokens: Math.max(512, Math.min(32768, parseInt(e.target.value) || 0)) })
              }
              placeholder={String(DEFAULT_LTM_EXTRACTION_MAX_TOKENS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
              How much text the AI reads at once
            </span>
            <input
              type="number"
              min={128}
              max={65536}
              value={extractionSettings.maxSourceTokens}
              onChange={(e) =>
                onChangeExtraction({ maxSourceTokens: Math.max(128, Math.min(65536, parseInt(e.target.value) || 0)) })
              }
              placeholder={String(DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
        </div>
      </FieldGroup>

      {/* Section 2 — Extraction Behavior */}
      <FieldGroup
        label="Extraction behavior"
        icon={<FileText size="0.875rem" className="text-[var(--primary)]" />}
        help="Expert tuning for how the AI reasons over source notes and existing memories."
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
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={extractionSettings.temperature}
              onChange={(e) =>
                onChangeExtraction({ temperature: Math.max(0, Math.min(2, Number(e.target.value) || 0)) })
              }
              placeholder={String(DEFAULT_LTM_EXTRACTION_TEMPERATURE)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">Max existing-note text</span>
            <input
              type="number"
              min={128}
              max={32768}
              value={extractionSettings.maxExistingNoteTokens}
              onChange={(e) =>
                onChangeExtraction({
                  maxExistingNoteTokens: Math.max(128, Math.min(32768, parseInt(e.target.value) || 0)),
                })
              }
              placeholder={String(DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
              Existing-note max chunks
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={extractionSettings.existingNoteMaxChunks}
              onChange={(e) =>
                onChangeExtraction({ existingNoteMaxChunks: Math.max(1, Math.min(100, parseInt(e.target.value) || 0)) })
              }
              placeholder={String(DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
              Existing-note max tokens
            </span>
            <input
              type="number"
              min={128}
              max={16384}
              value={extractionSettings.existingNoteMaxTokens}
              onChange={(e) =>
                onChangeExtraction({
                  existingNoteMaxTokens: Math.max(128, Math.min(16384, parseInt(e.target.value) || 0)),
                })
              }
              placeholder={String(DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
        </div>

        <label className="mt-3 flex items-start gap-2 border-t border-[var(--border)] pt-3">
          <input
            type="checkbox"
            checked={autoApplyLowRisk}
            onChange={(e) => onChangeGlobal({ autoApplyLowRisk: e.target.checked })}
            className="mt-0.5 rounded border-[var(--border)] accent-[var(--primary)]"
          />
          <div>
            <span className="text-xs font-medium text-[var(--foreground)]">Auto-accept safe changes</span>
            <p className="text-[0.625rem] text-[var(--muted-foreground)]">
              Lets the AI accept obvious (low-risk) facts without asking. Medium/high-risk changes still need review.
            </p>
          </div>
        </label>
      </FieldGroup>
    </>
  );
}
