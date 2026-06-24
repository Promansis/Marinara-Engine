import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  ChevronRight,
  Copy,
  Hammer,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS,
  DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  DEFAULT_LTM_EXTRACTION_TEMPERATURE,
  DEFAULT_LTM_EXTRACTION_VERBOSITY,
  type LtmExtractionReasoningEffort,
  type LtmExtractionVerbosity,
} from "@marinara-engine/shared";
import {
  useLongTermMemoryExtractionSettings,
  useLongTermMemoryIntegrity,
  useLongTermMemorySettings,
  useRebuildLongTermMemory,
  useRepairLongTermMemory,
  useUpdateLongTermMemoryExtractionSettings,
  useUpdateLongTermMemorySettings,
  type LtmGlobalSettings,
  type LtmExtractionSettings,
  type LtmResolvedExtractionSettings,
} from "../../hooks/use-long-term-memory";
import { cn, generateClientId } from "../../lib/utils";
import {
  actionRowClassName,
  helperTextClassName,
  insetSectionCardClassName,
  modalIntroCardClassName,
  panelIntroCardClassName,
  sectionCardClassName,
  SettingField,
  textareaClassName,
} from "./LtmFields";
import { StatusPill, ToolButton } from "./LtmPills";
import { RecallSettingsControls } from "./RecallSettingsControls";

type OptionalLevel<T extends string> = "default" | T;
type ExtractionPromptTemplate = LtmResolvedExtractionSettings["promptTemplates"][number];

type ExtractionSettingsDraft = {
  systemPrompt: string;
  extraInstruction: string;
  reasoningEffort: OptionalLevel<LtmExtractionReasoningEffort>;
  verbosity: OptionalLevel<LtmExtractionVerbosity>;
  maxOutputTokens: string;
  temperature: string;
  maxSourceTokens: string;
  maxExistingNoteTokens: string;
  existingNoteMaxChunks: string;
  existingNoteMaxTokens: string;
};

const DEFAULT_SETTINGS = {
  reasoningEffort: DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  verbosity: DEFAULT_LTM_EXTRACTION_VERBOSITY,
  maxOutputTokens: DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  temperature: DEFAULT_LTM_EXTRACTION_TEMPERATURE,
  maxSourceTokens: DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
  maxExistingNoteTokens: DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  existingNoteMaxChunks: DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_CHUNKS,
  existingNoteMaxTokens: DEFAULT_LTM_EXTRACTION_EXISTING_NOTE_MAX_TOKENS,
} as const;

function draftFromSettings(settings: LtmResolvedExtractionSettings): ExtractionSettingsDraft {
  return {
    systemPrompt: settings.systemPrompt,
    extraInstruction: settings.extraInstruction,
    reasoningEffort:
      settings.reasoningEffort === DEFAULT_SETTINGS.reasoningEffort ? "default" : settings.reasoningEffort,
    verbosity: settings.verbosity === DEFAULT_SETTINGS.verbosity ? "default" : settings.verbosity,
    maxOutputTokens: String(settings.maxOutputTokens),
    temperature: String(settings.temperature),
    maxSourceTokens: String(settings.maxSourceTokens),
    maxExistingNoteTokens: String(settings.maxExistingNoteTokens),
    existingNoteMaxChunks: String(settings.existingNoteMaxChunks),
    existingNoteMaxTokens: String(settings.existingNoteMaxTokens),
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
  payload.maxSourceTokens = parseInteger(draft.maxSourceTokens, 128, 65_536, DEFAULT_SETTINGS.maxSourceTokens);
  payload.maxExistingNoteTokens = parseInteger(
    draft.maxExistingNoteTokens,
    128,
    32_768,
    DEFAULT_SETTINGS.maxExistingNoteTokens,
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
    maxSourceTokens: parseInteger(draft.maxSourceTokens, 128, 65_536, DEFAULT_SETTINGS.maxSourceTokens),
    maxExistingNoteTokens: parseInteger(
      draft.maxExistingNoteTokens,
      128,
      32_768,
      DEFAULT_SETTINGS.maxExistingNoteTokens,
    ),
    existingNoteMaxChunks: parseInteger(draft.existingNoteMaxChunks, 1, 100, DEFAULT_SETTINGS.existingNoteMaxChunks),
    existingNoteMaxTokens: parseInteger(
      draft.existingNoteMaxTokens,
      128,
      16_384,
      DEFAULT_SETTINGS.existingNoteMaxTokens,
    ),
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
    resolved.maxSourceTokens !== current.maxSourceTokens ||
    resolved.maxExistingNoteTokens !== current.maxExistingNoteTokens ||
    resolved.existingNoteMaxChunks !== current.existingNoteMaxChunks ||
    resolved.existingNoteMaxTokens !== current.existingNoteMaxTokens
  );
}

type LongTermMemoryExtractionSettingsEditorProps = {
  enabled?: boolean;
  mode?: "embedded" | "modal";
  onClose?: () => void;
};

export function LongTermMemoryExtractionSettingsEditor({
  enabled = true,
  mode = "embedded",
  onClose,
}: LongTermMemoryExtractionSettingsEditorProps) {
  const settings = useLongTermMemoryExtractionSettings({ enabled });
  const globalSettings = useLongTermMemorySettings({ enabled });
  const updateSettings = useUpdateLongTermMemoryExtractionSettings();
  const updateGlobalSettings = useUpdateLongTermMemorySettings();
  const [draft, setDraft] = useState<ExtractionSettingsDraft | null>(null);
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [templateSelectOpen, setTemplateSelectOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [templatePromptDraft, setTemplatePromptDraft] = useState("");

  const promptTemplates = useMemo(() => settings.data?.promptTemplates ?? [], [settings.data?.promptTemplates]);
  const integrity = useLongTermMemoryIntegrity();
  const rebuild = useRebuildLongTermMemory();
  const repair = useRepairLongTermMemory();
  const activePromptTemplateId = settings.data?.activePromptTemplateId ?? null;
  const activePromptTemplate = promptTemplates.find((template) => template.id === activePromptTemplateId) ?? null;
  const isEditingExistingTemplate = Boolean(editingTemplateId);
  const hasTemplateDraft = Boolean(templateNameDraft.trim() && templatePromptDraft.trim());
  const introCardClassName = mode === "modal" ? modalIntroCardClassName : panelIntroCardClassName;
  const patchGlobalSettings = useCallback(
    (patch: LtmGlobalSettings) => {
      updateGlobalSettings.mutate(patch, {
        onError: (err) => toast.error((err as Error).message),
      });
    },
    [updateGlobalSettings],
  );

  useEffect(() => {
    if (enabled && settings.data) {
      setDraft(draftFromSettings(settings.data));
      setTemplateEditorOpen(false);
      setTemplateSelectOpen(false);
      setEditingTemplateId(null);
      setTemplateNameDraft("");
      setTemplatePromptDraft("");
    }
  }, [enabled, settings.data]);

  const dirty = useMemo(
    () => Boolean(draft && settings.data && isDraftDirty(draft, settings.data)),
    [draft, settings.data],
  );

  const set = useCallback(<K extends keyof ExtractionSettingsDraft>(key: K, value: ExtractionSettingsDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }, []);

  const persistSettings = useCallback(
    (patch: Record<string, unknown>) => {
      updateSettings
        .mutateAsync(patch as LtmExtractionSettings)
        .then((next) => {
          setDraft(draftFromSettings(next));
          toast.success("Extraction settings saved");
        })
        .catch((err: Error) => toast.error(err.message));
    },
    [updateSettings],
  );

  const handleSelectPromptTemplate = useCallback(
    (templateId: string | null) => {
      if (!settings.data) return;
      const template = templateId ? promptTemplates.find((candidate) => candidate.id === templateId) : null;
      set("systemPrompt", template?.prompt ?? "");
      persistSettings({
        ...payloadFromDraft(draft ?? draftFromSettings(settings.data)),
        activePromptTemplateId: templateId,
      });
      setTemplateSelectOpen(false);
    },
    [settings.data, promptTemplates, draft, set, persistSettings],
  );

  const resetTemplateDraft = useCallback(() => {
    setEditingTemplateId(null);
    setTemplateNameDraft("");
    setTemplatePromptDraft("");
  }, []);

  const handleEditPromptTemplate = useCallback((template: ExtractionPromptTemplate) => {
    setEditingTemplateId(template.id);
    setTemplateNameDraft(template.name);
    setTemplatePromptDraft(template.prompt);
    setTemplateEditorOpen(true);
  }, []);

  const handleNewPromptTemplate = useCallback(() => {
    setEditingTemplateId(null);
    setTemplateNameDraft(`Extraction Style ${promptTemplates.length + 1}`);
    setTemplatePromptDraft(draft?.systemPrompt.trim() || "");
    setTemplateEditorOpen(true);
  }, [draft?.systemPrompt, promptTemplates.length]);

  const handleDuplicatePromptTemplate = useCallback(
    (template: ExtractionPromptTemplate | null) => {
      setEditingTemplateId(null);
      setTemplateNameDraft(`${template?.name ?? "Built-in Extraction Prompt"} copy`);
      setTemplatePromptDraft(template?.prompt ?? draft?.systemPrompt.trim() ?? "");
      setTemplateEditorOpen(true);
    },
    [draft?.systemPrompt],
  );

  const handleSavePromptTemplate = useCallback(() => {
    if (!hasTemplateDraft || !settings.data) return;
    const trimmedName = templateNameDraft.trim().slice(0, 120);
    const trimmedPrompt = templatePromptDraft.trim();
    const currentTemplates = [...promptTemplates];
    const nextTemplates = isEditingExistingTemplate
      ? currentTemplates.map((template) =>
          template.id === editingTemplateId ? { ...template, name: trimmedName, prompt: trimmedPrompt } : template,
        )
      : [...currentTemplates, { id: generateClientId(), name: trimmedName, prompt: trimmedPrompt }];
    const nextActiveId = isEditingExistingTemplate ? activePromptTemplateId : (nextTemplates.at(-1)?.id ?? null);
    persistSettings({
      ...(draft ? payloadFromDraft(draft) : {}),
      promptTemplates: nextTemplates,
      activePromptTemplateId: nextActiveId,
    });
    resetTemplateDraft();
    setTemplateEditorOpen(false);
  }, [
    activePromptTemplateId,
    draft,
    editingTemplateId,
    hasTemplateDraft,
    isEditingExistingTemplate,
    persistSettings,
    promptTemplates,
    resetTemplateDraft,
    settings.data,
    templateNameDraft,
    templatePromptDraft,
  ]);

  const handleDeletePromptTemplate = useCallback(
    (templateId: string) => {
      if (!settings.data) return;
      const nextTemplates = promptTemplates.filter((template) => template.id !== templateId);
      persistSettings({
        ...payloadFromDraft(draft ?? draftFromSettings(settings.data)),
        promptTemplates: nextTemplates,
        activePromptTemplateId: activePromptTemplateId === templateId ? null : activePromptTemplateId,
      });
      if (editingTemplateId === templateId) resetTemplateDraft();
    },
    [
      activePromptTemplateId,
      draft,
      editingTemplateId,
      persistSettings,
      promptTemplates,
      resetTemplateDraft,
      settings.data,
    ],
  );

  const save = () => {
    if (!draft) return;
    persistSettings(payloadFromDraft(draft!));
  };

  const reset = () => {
    persistSettings({ version: 1 });
  };

  if (settings.isError) {
    return (
      <div className="rounded-lg bg-[var(--secondary)]/35 p-3 text-xs text-[var(--destructive)] ring-1 ring-[var(--border)]">
        {(settings.error as Error).message}
      </div>
    );
  }

  if (settings.isLoading || globalSettings.isLoading || !draft || !globalSettings.data) {
    return (
      <div className="grid min-h-52 place-items-center text-[var(--muted-foreground)]">
        <Loader2 size="1.25rem" className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className={introCardClassName}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BrainCircuit size="1rem" className="text-[var(--primary)]" />
            <span className="text-sm font-semibold text-[var(--foreground)]">Source note extractor</span>
            {dirty ? <StatusPill label="Autosaving" tone="warn" /> : <StatusPill label="Saved" tone="good" />}
          </div>
          <button
            type="button"
            onClick={() => setDraft(settings.data ? draftFromSettings(settings.data) : draft)}
            disabled={!dirty || updateSettings.isPending}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-[var(--secondary)] px-3 py-2 text-xs font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)] transition-all hover:bg-[var(--accent)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size="0.875rem" />
            Discard
          </button>
        </div>
        <p className={cn("mt-2", helperTextClassName)}>
          Tune how source notes become memory streams while keeping the same dense settings vocabulary used elsewhere in
          Marinara.
        </p>
      </div>

      <section className={cn("space-y-3", sectionCardClassName)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--foreground)]">
            <SlidersHorizontal size="0.875rem" />
            Extraction Prompt
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                set("systemPrompt", "");
              }}
              className="rounded-md px-2 py-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
            >
              Reset Extraction Prompt
            </button>
            <button
              type="button"
              onClick={() => {
                setTemplateEditorOpen((current) => !current);
                if (templateEditorOpen) resetTemplateDraft();
              }}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-xs transition-colors",
                templateEditorOpen
                  ? "bg-[var(--accent)] text-[var(--foreground)] ring-1 ring-[var(--border)]"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
              )}
            >
              {templateEditorOpen ? "Done" : "Manage"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-1">
          <div className="relative min-w-0">
            <button
              type="button"
              onClick={() => setTemplateSelectOpen((current) => !current)}
              className="flex w-full min-w-0 items-center justify-between gap-2 rounded-md bg-[var(--card)] py-1 pl-2 pr-2 text-left text-xs font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              aria-haspopup="listbox"
              aria-expanded={templateSelectOpen}
              aria-label="Extraction prompt template"
            >
              <span className="min-w-0 truncate">
                {activePromptTemplate ? activePromptTemplate.name : "Built-in Extraction Prompt"}
              </span>
              <ChevronRight
                size="0.75rem"
                className={cn(
                  "shrink-0 text-[var(--muted-foreground)] transition-transform",
                  templateSelectOpen && "rotate-90",
                )}
              />
            </button>
            {templateSelectOpen ? (
              <div
                role="listbox"
                className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-20 max-h-40 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--popover)] p-1 text-[var(--popover-foreground)] shadow-xl shadow-black/25"
              >
                <button
                  role="option"
                  aria-selected={!activePromptTemplateId}
                  onClick={() => handleSelectPromptTemplate(null)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1 text-[0.6875rem] transition-colors",
                    !activePromptTemplateId
                      ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                      : "hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                  )}
                >
                  Built-in Extraction Prompt
                </button>
                {promptTemplates.map((template) => (
                  <button
                    key={template.id}
                    role="option"
                    aria-selected={activePromptTemplateId === template.id}
                    onClick={() => handleSelectPromptTemplate(template.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1 text-[0.6875rem] transition-colors",
                      activePromptTemplateId === template.id
                        ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                        : "hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
                    )}
                  >
                    {template.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => handleDuplicatePromptTemplate(activePromptTemplate)}
            className="rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
            title="Copy current extraction prompt to a new template"
            aria-label="Copy current extraction prompt to a new template"
          >
            <Copy size="0.75rem" />
          </button>
        </div>

        {templateEditorOpen ? (
          <div className="space-y-2 border-t border-[var(--border)] pt-3">
            <div className="max-h-28 space-y-1 overflow-y-auto pr-0.5">
              {promptTemplates.map((template) => (
                <div
                  key={template.id}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 text-[0.6875rem] transition-colors",
                    activePromptTemplateId === template.id
                      ? "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/30"
                      : "hover:bg-[var(--accent)]",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSelectPromptTemplate(template.id)}
                    className="min-w-0 flex-1 truncate text-left font-medium text-[var(--foreground)]"
                  >
                    {template.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDuplicatePromptTemplate(template)}
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    title="Copy"
                  >
                    <Copy size="0.625rem" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEditPromptTemplate(template)}
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    title="Edit"
                  >
                    <Pencil size="0.625rem" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeletePromptTemplate(template.id)}
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                    title="Delete"
                  >
                    <Trash2 size="0.625rem" />
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={handleNewPromptTemplate}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--border)] bg-[var(--accent)]/35 px-2 py-1.5 text-[0.625rem] font-semibold text-[var(--foreground)] transition-colors hover:bg-[var(--accent)]"
            >
              <Plus size="0.6875rem" />
              New Extraction Template
            </button>

            {templateNameDraft || templatePromptDraft ? (
              <div className={cn("space-y-1.5", insetSectionCardClassName)}>
                <input
                  value={templateNameDraft}
                  onChange={(event) => setTemplateNameDraft(event.target.value)}
                  maxLength={120}
                  placeholder="Template name"
                  className="w-full rounded-md bg-[var(--card)] px-2 py-1 text-[0.6875rem] font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
                <textarea
                  value={templatePromptDraft}
                  onChange={(event) => setTemplatePromptDraft(event.target.value)}
                  rows={8}
                  placeholder="Extraction prompt instructions..."
                  className="max-h-48 w-full resize-y rounded-md bg-[var(--card)] px-2 py-1.5 font-mono text-[0.625rem] leading-relaxed text-[var(--foreground)] ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    onClick={resetTemplateDraft}
                    className="rounded-md px-2 py-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSavePromptTemplate}
                    disabled={!hasTemplateDraft || updateSettings.isPending}
                    className="flex items-center gap-1 rounded-md bg-[var(--secondary)] px-2 py-1 text-[0.625rem] font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Save size="0.625rem" />
                    {isEditingExistingTemplate ? "Save" : "Add"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <SettingField label="Extra user instruction">
          <textarea
            value={draft.extraInstruction}
            onChange={(event) => set("extraInstruction", event.target.value)}
            className={cn(textareaClassName, "min-h-24")}
          />
        </SettingField>
      </section>

      <section className={cn("space-y-3", sectionCardClassName)}>
        <div className="text-xs font-semibold text-[var(--foreground)]">Default recall settings</div>
        <p className={helperTextClassName}>
          These are the workspace-level defaults. Each chat can override them in its settings drawer.
        </p>
        <RecallSettingsControls
          values={globalSettings.data}
          onChange={(patch) => patchGlobalSettings({ version: 1, ...patch })}
          showExpert={true}
        />
      </section>

      <section className={cn("space-y-3", sectionCardClassName)}>
        <div className="text-xs font-semibold text-[var(--foreground)]">Maintenance</div>
        <div className="flex flex-wrap gap-2">
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
        </div>
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
      </section>

      <div className={cn(actionRowClassName, "justify-end")}>
        {mode === "modal" && onClose ? (
          <ToolButton onClick={onClose} disabled={updateSettings.isPending}>
            Cancel
          </ToolButton>
        ) : null}
        <ToolButton onClick={reset} disabled={updateSettings.isPending}>
          {updateSettings.isPending ? (
            <Loader2 size="0.875rem" className="animate-spin" />
          ) : (
            <RotateCcw size="0.875rem" />
          )}
          Reset
        </ToolButton>
        <ToolButton onClick={save} disabled={!dirty || updateSettings.isPending} tone="primary">
          {updateSettings.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Save size="0.875rem" />}
          Save now
        </ToolButton>
      </div>
    </div>
  );
}

