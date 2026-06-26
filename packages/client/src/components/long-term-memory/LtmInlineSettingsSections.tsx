import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Circle, CircleDot, FileText, Link2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS,
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_PROMPT,
  DEFAULT_LTM_EXTRACTION_TEMPERATURE,
  type LtmExtractionReasoningEffort,
  type LtmExtractionVerbosity,
} from "@marinara-engine/shared";
import { useConnections } from "../../hooks/use-connections";
import { MacroTextarea } from "../ui/MacroTextarea";
import { textareaClassName } from "./LtmFields";
import { FieldGroup } from "../agents/AgentEditor";

type PromptTemplate = { id: string; name: string; prompt: string };

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
            {conn.name}{conn.model ? ` - ${conn.model}` : ""}
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
  systemPrompt: string;
  promptTemplates: readonly PromptTemplate[];
  activePromptTemplateId: string | null;
  extraInstruction: string;
  aiKeywordExtraction: boolean;
  onChangeSystemPrompt: (value: string) => void;
  onChangePromptTemplates: (templates: PromptTemplate[]) => void;
  onChangeActivePromptTemplateId: (id: string | null) => void;
  onChangeExtraInstruction: (value: string) => void;
  onChangeAiKeywordExtraction: (value: boolean) => void;
};

export function LtmExtractionPromptSection({
  systemPrompt,
  promptTemplates,
  activePromptTemplateId,
  extraInstruction,
  aiKeywordExtraction,
  onChangeSystemPrompt,
  onChangePromptTemplates,
  onChangeActivePromptTemplateId,
  onChangeExtraInstruction,
  onChangeAiKeywordExtraction,
}: ExtractionPromptSectionProps) {
  const isUsingDefaultPrompt = !systemPrompt.trim() || systemPrompt === DEFAULT_LTM_EXTRACTION_PROMPT;
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [localPrompt, setLocalPrompt] = useState(systemPrompt);

  useEffect(() => {
    if (!editingPrompt) {
      setLocalPrompt(systemPrompt);
    }
  }, [systemPrompt, editingPrompt]);

  // Local state for prompt templates (responsive typing mirror)
  const [localTemplates, setLocalTemplates] = useState<PromptTemplate[]>([...promptTemplates]);

  useEffect(() => {
    setLocalTemplates([...promptTemplates]);
  }, [promptTemplates]);

  const handleLoadDefault = useCallback(() => {
    setEditingPrompt(true);
    setLocalPrompt(DEFAULT_LTM_EXTRACTION_PROMPT);
    onChangeSystemPrompt(DEFAULT_LTM_EXTRACTION_PROMPT);
  }, [onChangeSystemPrompt]);

  const handleResetPrompt = useCallback(() => {
    setEditingPrompt(false);
    setLocalPrompt(DEFAULT_LTM_EXTRACTION_PROMPT);
    // undefined means "use default" on the server
    onChangeSystemPrompt("");
  }, [onChangeSystemPrompt]);

  const handlePromptChange = useCallback(
    (value: string) => {
      setLocalPrompt(value);
      onChangeSystemPrompt(value);
    },
    [onChangeSystemPrompt],
  );

  const syncTemplates = useCallback(
    (next: PromptTemplate[]) => {
      const adjusted = [...next];
      if (activePromptTemplateId && !adjusted.some((t) => t.id === activePromptTemplateId)) {
        onChangeActivePromptTemplateId(null);
      }
      onChangePromptTemplates(adjusted);
    },
    [activePromptTemplateId, onChangePromptTemplates, onChangeActivePromptTemplateId],
  );

  const handleAddTemplate = useCallback(() => {
    setLocalTemplates((prev) => {
      const next = [...prev, { id: crypto.randomUUID(), name: "New template", prompt: "" }];
      return next;
    });
  }, []);

  const handleUpdateTemplate = useCallback(
    (id: string, patch: Partial<{ name: string; prompt: string }>) => {
      setLocalTemplates((prev) => {
        const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
        const allValid = next.every((t) => t.name.trim().length > 0 && t.prompt.trim().length > 0);
        if (allValid) {
          syncTemplates(next);
        }
        return next;
      });
    },
    [syncTemplates],
  );

  const handleRemoveTemplate = useCallback(
    (id: string) => {
      setLocalTemplates((prev) => {
        const next = prev.filter((t) => t.id !== id);
        const allValid = next.every((t) => t.name.trim().length > 0 && t.prompt.trim().length > 0);
        if (allValid) {
          syncTemplates(next);
        }
        return next;
      });
    },
    [syncTemplates],
  );

  const handleSetActiveTemplate = useCallback(
    (id: string | null) => {
      onChangeActivePromptTemplateId(id);
    },
    [onChangeActivePromptTemplateId],
  );

  return (
    <FieldGroup
      label="Extraction Prompt"
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
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          >
            <RotateCcw size="0.625rem" /> Reset to default
          </button>
        )}
        {isUsingDefaultPrompt && !editingPrompt && (
          <button
            onClick={handleLoadDefault}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
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
            Default — click "Copy default to edit" to customize
          </span>
        </div>
      ) : (
        <MacroTextarea
          value={localPrompt}
          onChange={handlePromptChange}
          rows={12}
          title="Extraction Prompt"
          placeholder="Write the extraction system prompt…"
          className="w-full resize-y rounded-xl bg-[var(--secondary)] px-4 py-3 font-mono text-xs leading-relaxed ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)] max-h-[40vh] overflow-y-auto"
        />
      )}

      <p className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">
        {isUsingDefaultPrompt && !editingPrompt
          ? "Leave as default to use the built-in extraction prompt. Edit to override."
          : "The system prompt used for extraction."}
      </p>

      {/* Named prompt options */}
      <div className="mt-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold text-[var(--foreground)]">Named prompt options</p>
            <p className="text-[0.625rem] text-[var(--muted-foreground)]">
              Extraction can use a named option instead of the prompt above.
            </p>
          </div>
          <button
            type="button"
            onClick={handleAddTemplate}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2.5 py-1.5 text-[0.6875rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
          >
            <Plus size="0.6875rem" />
            Add option
          </button>
        </div>

        {localTemplates.length === 0 ? (
          <p className="rounded-xl bg-[var(--secondary)]/60 px-3 py-2 text-[0.6875rem] text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
            No named options yet. Extraction will use the prompt above.
          </p>
        ) : (
          <div className="space-y-3">
            {localTemplates.map((template) => (
              <div
                key={template.id}
                className="rounded-xl bg-[var(--secondary)]/70 p-3 ring-1 ring-[var(--border)]"
              >
                <div className="mb-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleSetActiveTemplate(activePromptTemplateId === template.id ? null : template.id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center"
                    title={activePromptTemplateId === template.id ? "Active extraction prompt" : "Set as active extraction prompt"}
                  >
                    {activePromptTemplateId === template.id ? (
                      <CircleDot size="0.75rem" className="text-[var(--primary)]" />
                    ) : (
                      <Circle size="0.75rem" className="text-[var(--muted-foreground)]" />
                    )}
                  </button>
                  <input
                    value={template.name}
                    onChange={(e) => handleUpdateTemplate(template.id, { name: e.target.value })}
                    className="min-w-0 flex-1 rounded-lg bg-[var(--background)] px-2.5 py-1.5 text-sm ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                    placeholder="Option name"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveTemplate(template.id)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)]/15 hover:text-[var(--destructive)]"
                    title="Remove prompt option"
                  >
                    <Trash2 size="0.75rem" />
                  </button>
                </div>
                <MacroTextarea
                  value={template.prompt}
                  onChange={(value) => handleUpdateTemplate(template.id, { prompt: value })}
                  rows={7}
                  title={template.name || "Prompt Option"}
                  className="w-full resize-y rounded-lg bg-[var(--background)] px-3 py-2 font-mono text-xs leading-relaxed ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  placeholder="Write the prompt for this option…"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <label className="block">
          <span className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Extra user instruction</span>
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
          <span>Ask AI extraction to propose keywords for each evidence unit</span>
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
              onChange={(e) => onChangeExtraction({ maxOutputTokens: Math.max(512, Math.min(32768, parseInt(e.target.value) || 0)) })}
              placeholder={String(DEFAULT_LTM_EXTRACTION_MAX_TOKENS)}
              className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm tabular-nums ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">How much text the AI reads at once</span>
            <input
              type="number"
              min={128}
              max={65536}
              value={extractionSettings.maxSourceTokens}
              onChange={(e) => onChangeExtraction({ maxSourceTokens: Math.max(128, Math.min(65536, parseInt(e.target.value) || 0)) })}
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
              onChange={(e) => onChangeExtraction({ temperature: Math.max(0, Math.min(2, Number(e.target.value) || 0)) })}
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
              onChange={(e) => onChangeExtraction({ maxExistingNoteTokens: Math.max(128, Math.min(32768, parseInt(e.target.value) || 0)) })}
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
              value={extractionSettings.existingNoteMaxChunks}
              onChange={(e) => onChangeExtraction({ existingNoteMaxChunks: Math.max(1, Math.min(100, parseInt(e.target.value) || 0)) })}
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
              value={extractionSettings.existingNoteMaxTokens}
              onChange={(e) => onChangeExtraction({ existingNoteMaxTokens: Math.max(128, Math.min(16384, parseInt(e.target.value) || 0)) })}
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
