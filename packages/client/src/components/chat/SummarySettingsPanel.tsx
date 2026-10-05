// ──────────────────────────────────────────────
// Summary settings — automatic summaries, prompt template CRUD, combine prompt.
// Rendered by ChatSettingsDrawer in every chat mode. The summary popover keeps
// only the compact template selector and the operational controls.
// ──────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, PenLine, Plus, Save, Trash2 } from "lucide-react";
import {
  CHAT_SUMMARY_OUTPUT_TOKENS,
  CHAT_SUMMARY_PROMPT_MAX_LENGTH,
  DEFAULT_CHAT_SUMMARY_COMBINE_PROMPT,
  DEFAULT_CHAT_SUMMARY_PROMPT,
  DEFAULT_LONG_TERM_MEMORY_CHAT_SUMMARY_PROMPT,
  LONG_TERM_MEMORY_CHAT_SUMMARY_PROMPT_ID,
  estimateTextTokens,
  normalizeSemanticSummaryRetrievalSettings,
  type ChatSummaryPromptSettings,
  type ChatSummaryPromptTemplate,
} from "@marinara-engine/shared";
import { useQueryClient } from "@tanstack/react-query";
import { cn, generateClientId } from "../../lib/utils";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { appendLocalSidecarConnectionOption, filterLanguageGenerationConnections } from "../../lib/connection-filters";
import type { ChatConnectionOption } from "../../features/chat-settings/sections/ConnectionSection";
import { MacroTextarea } from "../ui/MacroTextarea";
import { DraftNumberInput } from "../ui/DraftNumberInput";
import { SettingsSwitch } from "../panels/settings/SettingControls";
import {
  SemanticSummaryRetrievalControls,
  type SemanticSummaryRetrievalControlField,
} from "./SemanticSummaryRetrievalControls";
import { useChat, useUpdateChatMetadata } from "../../hooks/use-chats";
import { useConnections } from "../../hooks/use-connections";
import { chatSummaryPromptKeys } from "../../hooks/use-chat-summary-prompts";
import { useChatSummaryPromptPersist } from "../../hooks/use-chat-summary-prompt-persist";
import { useSidecarStore } from "../../stores/sidecar.store";

const SUMMARY_AGENT_ID = "chat-summary";
const DEFAULT_AUTOMATIC_SUMMARY_INTERVAL = 5;
const MIN_AUTOMATIC_SUMMARY_INTERVAL = 1;
const MAX_AUTOMATIC_SUMMARY_INTERVAL = 200;

function clampAutomaticSummaryInterval(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_AUTOMATIC_SUMMARY_INTERVAL;
  return Math.max(MIN_AUTOMATIC_SUMMARY_INTERVAL, Math.min(MAX_AUTOMATIC_SUMMARY_INTERVAL, Math.trunc(parsed)));
}

type SummaryPromptView = "summary" | "combine";

interface SummarySettingsPanelProps {
  chatId: string;
  longTermMemorySummaryPromptAvailable?: boolean;
  automaticSummariesAvailable?: boolean;
  automaticSummaryEnabled?: boolean;
  summaryRunInterval?: number;
  activeAgentIds?: string[];
  /** Legacy per-chat templates used until global prompt settings are persisted. */
  fallbackPromptTemplates?: ChatSummaryPromptTemplate[];
  fallbackActivePromptTemplateId?: string | null;
  className?: string;
}

export function SummarySettingsPanel({
  chatId,
  longTermMemorySummaryPromptAvailable = false,
  automaticSummariesAvailable = false,
  automaticSummaryEnabled = false,
  summaryRunInterval,
  activeAgentIds = [],
  fallbackPromptTemplates = [],
  fallbackActivePromptTemplateId = null,
  className,
}: SummarySettingsPanelProps) {
  const { t: localizeUi } = useTranslation();
  const queryClient = useQueryClient();
  const {
    query: globalPromptSettings,
    ready: globalPromptSettingsReady,
    saving: promptSettingsSaveLocked,
    persist: persistPromptTemplates,
    isLocked,
    whenIdle,
  } = useChatSummaryPromptPersist();
  const updateMeta = useUpdateChatMetadata();

  // Model connection and semantic retrieval settings are read straight off the
  // chat so this panel stays self-sufficient wherever it is mounted.
  const { data: chat } = useChat(chatId);
  const chatMetadata = useMemo<Record<string, unknown>>(() => {
    const raw = chat?.metadata;
    return (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as Record<string, unknown>;
  }, [chat?.metadata]);
  const { data: connections } = useConnections();
  const sidecarModelDownloaded = useSidecarStore((state) => state.modelDownloaded);
  const sidecarModelDisplayName = useSidecarStore((state) => state.modelDisplayName);
  const summaryConnections = useMemo(
    () =>
      appendLocalSidecarConnectionOption(
        filterLanguageGenerationConnections((connections ?? []) as ChatConnectionOption[]),
        chat?.mode !== "game" && sidecarModelDownloaded,
        sidecarModelDisplayName,
      ),
    [chat?.mode, connections, sidecarModelDisplayName, sidecarModelDownloaded],
  );
  const summaryConnectionId =
    typeof chatMetadata.summaryConnectionId === "string" ? chatMetadata.summaryConnectionId : "";
  const summaryConnectionMissing =
    summaryConnectionId.length > 0 && !summaryConnections.some((connection) => connection.id === summaryConnectionId);
  const summaryRetrievalSettings = normalizeSemanticSummaryRetrievalSettings(chatMetadata);

  const normalizedAutomaticSummaryInterval = clampAutomaticSummaryInterval(summaryRunInterval);
  const [summaryPromptView, setSummaryPromptView] = useState<SummaryPromptView>("summary");
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [templatePromptDraft, setTemplatePromptDraft] = useState("");
  const [combinePromptDraft, setCombinePromptDraft] = useState(DEFAULT_CHAT_SUMMARY_COMBINE_PROMPT);
  const [automaticIntervalDraft, setAutomaticIntervalDraft] = useState(String(normalizedAutomaticSummaryInterval));
  const combinePromptFocused = useRef(false);
  const combinePromptDraftRef = useRef(DEFAULT_CHAT_SUMMARY_COMBINE_PROMPT);
  const combinePromptSaveRef = useRef<{ prompt: string; promise: Promise<boolean> } | null>(null);
  const automaticIntervalFocused = useRef(false);

  const globalCombinePrompt = globalPromptSettings.data?.combinePrompt ?? DEFAULT_CHAT_SUMMARY_COMBINE_PROMPT;
  const hasPersistedSettings = globalPromptSettings.data?.hasPersistedSettings === true;
  const normalizedActivePromptTemplateId =
    (hasPersistedSettings
      ? (globalPromptSettings.data?.activeTemplateId ?? null)
      : fallbackActivePromptTemplateId
    )?.trim() || null;
  const cleanedPromptTemplates = useMemo(() => {
    const source = hasPersistedSettings ? (globalPromptSettings.data?.templates ?? []) : fallbackPromptTemplates;
    return source.filter(
      (template) =>
        typeof template.id === "string" &&
        template.id.trim().length > 0 &&
        typeof template.name === "string" &&
        typeof template.prompt === "string" &&
        template.prompt.trim().length > 0 &&
        template.id.trim() !== LONG_TERM_MEMORY_CHAT_SUMMARY_PROMPT_ID,
    );
  }, [fallbackPromptTemplates, globalPromptSettings.data?.templates, hasPersistedSettings]);
  const isLongTermMemoryPromptSelected =
    longTermMemorySummaryPromptAvailable &&
    normalizedActivePromptTemplateId === LONG_TERM_MEMORY_CHAT_SUMMARY_PROMPT_ID;
  const automaticSummariesOn = automaticSummaryEnabled;
  const isEditingExistingTemplate = !!editingTemplateId;
  const hasTemplateDraft = templateNameDraft.trim().length > 0 && templatePromptDraft.trim().length > 0;

  useEffect(() => {
    if (!combinePromptFocused.current) {
      combinePromptDraftRef.current = globalCombinePrompt;
      setCombinePromptDraft(globalCombinePrompt);
    }
  }, [globalCombinePrompt]);

  useEffect(() => {
    if (!automaticIntervalFocused.current) {
      setAutomaticIntervalDraft(String(normalizedAutomaticSummaryInterval));
    }
  }, [normalizedAutomaticSummaryInterval]);

  const readCurrentPromptSettings = useCallback(() => {
    const cached = queryClient.getQueryData<ChatSummaryPromptSettings & { hasPersistedSettings?: boolean }>(
      chatSummaryPromptKeys.settings,
    );
    if (cached?.hasPersistedSettings) {
      return {
        templates: cached.templates,
        activeTemplateId: cached.activeTemplateId?.trim() || null,
      };
    }
    return {
      templates: fallbackPromptTemplates,
      activeTemplateId: fallbackActivePromptTemplateId?.trim() || null,
    };
  }, [fallbackActivePromptTemplateId, fallbackPromptTemplates, queryClient]);

  const persistAutomaticSummaryInterval = useCallback(
    (value: number) => {
      const clamped = clampAutomaticSummaryInterval(value);
      setAutomaticIntervalDraft(String(clamped));
      updateMeta.mutate({ id: chatId, summaryRunInterval: clamped });
    },
    [chatId, updateMeta],
  );

  const handleAutomaticSummaryToggle = useCallback(
    (checked: boolean) => {
      updateMeta.mutate({
        id: chatId,
        automaticSummaryEnabled: checked,
        activeAgentIds: activeAgentIds.filter((agentId) => agentId !== SUMMARY_AGENT_ID),
        summaryRunInterval: normalizedAutomaticSummaryInterval,
      });
    },
    [activeAgentIds, chatId, normalizedAutomaticSummaryInterval, updateMeta],
  );

  const commitCombinePromptDraft = useCallback(async (): Promise<boolean> => {
    combinePromptFocused.current = false;
    let nextPrompt =
      combinePromptDraftRef.current.trim().slice(0, CHAT_SUMMARY_PROMPT_MAX_LENGTH) ||
      DEFAULT_CHAT_SUMMARY_COMBINE_PROMPT;
    const activeSave = combinePromptSaveRef.current;
    if (activeSave?.prompt === nextPrompt) return activeSave.promise;
    if (isLocked()) {
      await whenIdle();
      nextPrompt =
        combinePromptDraftRef.current.trim().slice(0, CHAT_SUMMARY_PROMPT_MAX_LENGTH) ||
        DEFAULT_CHAT_SUMMARY_COMBINE_PROMPT;
    }

    combinePromptDraftRef.current = nextPrompt;
    setCombinePromptDraft(nextPrompt);

    const pendingSave = combinePromptSaveRef.current;
    if (pendingSave?.prompt === nextPrompt) return pendingSave.promise;
    if (!pendingSave && nextPrompt === globalCombinePrompt) return true;

    const currentSettings = readCurrentPromptSettings();
    const promise = persistPromptTemplates(currentSettings.templates, currentSettings.activeTemplateId, nextPrompt);
    combinePromptSaveRef.current = { prompt: nextPrompt, promise };
    try {
      return await promise;
    } finally {
      if (combinePromptSaveRef.current?.promise === promise) {
        combinePromptSaveRef.current = null;
      }
    }
  }, [globalCombinePrompt, isLocked, persistPromptTemplates, readCurrentPromptSettings, whenIdle]);

  const handleCombinePromptBlur = useCallback(async () => {
    await commitCombinePromptDraft();
  }, [commitCombinePromptDraft]);

  const handlePromptTabsKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next: SummaryPromptView = summaryPromptView === "summary" ? "combine" : "summary";
      setSummaryPromptView(next);
      event.currentTarget.querySelector<HTMLButtonElement>(`[data-summary-prompt-tab="${next}"]`)?.focus();
    },
    [summaryPromptView],
  );

  const handleSelectPromptTemplate = useCallback(
    async (templateId: string | null) => {
      const currentSettings = readCurrentPromptSettings();
      await persistPromptTemplates(currentSettings.templates, templateId, combinePromptDraftRef.current);
    },
    [persistPromptTemplates, readCurrentPromptSettings],
  );

  const resetTemplateDraft = useCallback(() => {
    setEditingTemplateId(null);
    setTemplateNameDraft("");
    setTemplatePromptDraft("");
  }, []);

  const handleEditPromptTemplate = useCallback((template: ChatSummaryPromptTemplate) => {
    setEditingTemplateId(template.id);
    setTemplateNameDraft(template.name);
    setTemplatePromptDraft(template.prompt);
  }, []);

  const handleNewPromptTemplate = useCallback(() => {
    setEditingTemplateId(null);
    setTemplateNameDraft(
      localizeUi("chat.summary.template.defaultName", {
        number: cleanedPromptTemplates.length + 1,
      }),
    );
    setTemplatePromptDraft(DEFAULT_CHAT_SUMMARY_PROMPT);
  }, [cleanedPromptTemplates.length, localizeUi]);

  const handleDuplicatePromptTemplate = useCallback(
    (
      template: ChatSummaryPromptTemplate | null,
      builtInPrompt = isLongTermMemoryPromptSelected
        ? DEFAULT_LONG_TERM_MEMORY_CHAT_SUMMARY_PROMPT
        : DEFAULT_CHAT_SUMMARY_PROMPT,
    ) => {
      setEditingTemplateId(null);
      setTemplateNameDraft(
        localizeUi("chat.summary.template.copyName", {
          name: template?.name ?? localizeUi("ui.chat.summarypopover.builtInDefault"),
        }),
      );
      setTemplatePromptDraft(template?.prompt ?? builtInPrompt);
    },
    [isLongTermMemoryPromptSelected, localizeUi],
  );

  const handleSavePromptTemplate = useCallback(async () => {
    if (!hasTemplateDraft) return;
    const trimmedName = templateNameDraft.trim().slice(0, 80);
    const trimmedPrompt = templatePromptDraft.trim();
    const currentSettings = readCurrentPromptSettings();
    const nextTemplates = isEditingExistingTemplate
      ? currentSettings.templates.map((template) =>
          template.id === editingTemplateId ? { ...template, name: trimmedName, prompt: trimmedPrompt } : template,
        )
      : [
          ...currentSettings.templates,
          {
            id: generateClientId(),
            name: trimmedName,
            prompt: trimmedPrompt,
          },
        ];
    const nextActiveId = isEditingExistingTemplate
      ? currentSettings.activeTemplateId
      : nextTemplates[nextTemplates.length - 1]!.id;
    const saved = await persistPromptTemplates(nextTemplates, nextActiveId ?? null, combinePromptDraftRef.current);
    if (!saved) return;
    resetTemplateDraft();
  }, [
    editingTemplateId,
    hasTemplateDraft,
    isEditingExistingTemplate,
    persistPromptTemplates,
    readCurrentPromptSettings,
    resetTemplateDraft,
    templateNameDraft,
    templatePromptDraft,
  ]);

  const handleDeletePromptTemplate = useCallback(
    async (templateId: string) => {
      const target = cleanedPromptTemplates.find((template) => template.id === templateId);
      if (!target) return;
      const confirmed = await showConfirmDialog({
        title: localizeUi("ui.chat.summarypopover.deleteSummaryTemplate"),
        message: localizeUi("chat.summary.deleteTemplateConfirmation", {
          name: target.name,
        }),
        confirmLabel: localizeUi("lorebook.editor.batch.delete"),
        cancelLabel: localizeUi("chat.delete.dialog.cancel"),
        tone: "destructive",
      });
      if (!confirmed) return;
      const currentSettings = readCurrentPromptSettings();
      const nextTemplates = currentSettings.templates.filter((template) => template.id !== templateId);
      const saved = await persistPromptTemplates(
        nextTemplates,
        currentSettings.activeTemplateId === templateId ? null : currentSettings.activeTemplateId,
        combinePromptDraftRef.current,
      );
      if (!saved) return;
      if (editingTemplateId === templateId) resetTemplateDraft();
    },
    [
      cleanedPromptTemplates,
      editingTemplateId,
      persistPromptTemplates,
      readCurrentPromptSettings,
      resetTemplateDraft,
      localizeUi,
    ],
  );

  const templateEditorDisabled = !globalPromptSettingsReady || promptSettingsSaveLocked;
  const semanticSummaryRetrievalAvailable = import.meta.env.VITE_MARINARA_LITE !== "true";

  return (
    <div className={cn("space-y-2.5", className)}>
      <div
        className={cn(
          "grid items-start gap-2",
          automaticSummariesAvailable && semanticSummaryRetrievalAvailable && "md:grid-cols-2",
        )}
      >
        {automaticSummariesAvailable && (
          <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/35 p-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[0.6875rem] font-semibold text-[var(--popover-foreground)]">
                  {localizeUi("ui.chat.summarypopover.automaticSummaries")}
                </p>
                <p className="mt-0.5 text-[0.625rem] leading-snug text-[var(--muted-foreground)]">
                  {automaticSummariesOn
                    ? localizeUi("chat.summary.automatic.updateInterval", {
                        count: normalizedAutomaticSummaryInterval,
                      })
                    : localizeUi("ui.chat.summarypopover.offForThisRoleplayChat")}
                </p>
              </div>
              <SettingsSwitch
                label={localizeUi("ui.noodle.noodlehome.enabled")}
                checked={automaticSummariesOn}
                onChange={handleAutomaticSummaryToggle}
              />
            </div>
            <label className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--background)]/25 px-2 py-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">
              <span>{localizeUi("ui.chat.summarypopover.every")}</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={MIN_AUTOMATIC_SUMMARY_INTERVAL}
                  max={MAX_AUTOMATIC_SUMMARY_INTERVAL}
                  value={automaticIntervalDraft}
                  disabled={!automaticSummariesOn}
                  onFocus={() => {
                    automaticIntervalFocused.current = true;
                  }}
                  onChange={(event) => {
                    setAutomaticIntervalDraft(event.target.value);
                  }}
                  onBlur={() => {
                    automaticIntervalFocused.current = false;
                    persistAutomaticSummaryInterval(
                      clampAutomaticSummaryInterval(automaticIntervalDraft || DEFAULT_AUTOMATIC_SUMMARY_INTERVAL),
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  className="mari-chrome-field w-16 !rounded-md px-2 py-1 text-center text-xs tabular-nums disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span>{localizeUi("ui.chat.summarypopover.userMessages")}</span>
              </span>
            </label>
          </div>
        )}

        {/* Semantic retrieval */}
        {semanticSummaryRetrievalAvailable && (
          <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/35 p-2">
            <SettingsSwitch
              label={localizeUi("ui.chat.chatsettingsdrawer.semanticSummaryRetrieval")}
              description={localizeUi(
                "ui.chat.chatsettingsdrawer.keepRecentSummariesInContextAndRetrieveOnlyRelevantOlder",
              )}
              checked={chatMetadata.semanticSummaryRetrievalEnabled === true}
              onChange={(semanticSummaryRetrievalEnabled) =>
                updateMeta.mutate({ id: chatId, semanticSummaryRetrievalEnabled })
              }
              labelPosition="start"
              className="justify-between rounded-lg px-1 text-left"
              labelClassName="text-xs font-medium"
            />
            <SemanticSummaryRetrievalControls
              enabled={chatMetadata.semanticSummaryRetrievalEnabled === true}
              recentCount={summaryRetrievalSettings.semanticSummaryRecentCount}
              olderCount={summaryRetrievalSettings.semanticSummaryOlderCount}
              minSimilarity={summaryRetrievalSettings.semanticSummaryMinSimilarity}
              recentLabel={localizeUi("ui.chat.chatsettingsdrawer.recentWeeks")}
              olderLabel={localizeUi("ui.chat.chatsettingsdrawer.olderWeeks")}
              thresholdLabel={localizeUi("ui.chat.chatsettingsdrawer.summaryRelevanceThreshold")}
              onChange={(field: SemanticSummaryRetrievalControlField, value) =>
                updateMeta.mutate({ id: chatId, [field]: value })
              }
            />
          </div>
        )}
      </div>

      {/* Model connection and output size */}
      <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/35 p-2">
        <div className="space-y-1.5">
          <span className="text-xs font-medium">{localizeUi("ui.chat.summarypopover.summaryConnection_febe5c4")}</span>
          <select
            value={summaryConnectionId}
            onChange={(event) =>
              updateMeta.mutate({
                id: chatId,
                summaryConnectionId: event.target.value || null,
              })
            }
            className="mari-chrome-field w-full !rounded-md px-3 py-2 text-xs"
            aria-label={localizeUi("ui.chat.summarypopover.summaryConnection_febe5c4")}
          >
            <option value="">{localizeUi("chat.summary.connection.agentDefaultFallback")}</option>
            {summaryConnectionMissing && (
              <option value={summaryConnectionId}>
                {localizeUi("chat.summary.connection.missing", {
                  id: summaryConnectionId,
                })}
              </option>
            )}
            {summaryConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
                {connection.model ? localizeUi("ui.chat.datablock.value1", { value1: connection.model }) : ""}
              </option>
            ))}
          </select>
          <p className="text-[0.625rem] text-[var(--muted-foreground)]">
            {localizeUi("ui.chat.summarypopover.chooseTheModelConnectionUsedForManualAndAutomatic")}
          </p>
        </div>
        <div className="space-y-1.5">
          <span className="text-xs font-medium">{localizeUi("ui.chat.summarypopover.maximumOutputSize")}</span>
          <DraftNumberInput
            value={
              typeof chatMetadata.summaryMaxTokens === "number"
                ? chatMetadata.summaryMaxTokens
                : CHAT_SUMMARY_OUTPUT_TOKENS.DEFAULT
            }
            min={CHAT_SUMMARY_OUTPUT_TOKENS.MIN}
            max={CHAT_SUMMARY_OUTPUT_TOKENS.MAX}
            onCommit={(value) =>
              updateMeta.mutate({
                id: chatId,
                summaryMaxTokens: value,
              })
            }
            ariaLabel={localizeUi("ui.chat.summarypopover.summaryMaximumOutputSize")}
            className="mari-chrome-field w-full !rounded-md px-3 py-2 text-xs"
          />
        </div>
      </div>

      {/* @summary-prompt-controls-start */}
      <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/35 p-2">
        <p className="px-1 text-[0.6875rem] font-semibold text-[var(--popover-foreground)]">
          {localizeUi("ui.chat.summarypopover.summaryPrompt")}
        </p>

        <div
          role="tablist"
          aria-label={localizeUi("ui.chat.summarypopover.summaryPromptView")}
          onKeyDown={handlePromptTabsKeyDown}
          className="grid grid-cols-2 rounded-md bg-[var(--background)]/30 p-0.5 ring-1 ring-[var(--border)]"
        >
          <button
            type="button"
            role="tab"
            id="summary-prompt-tab-summary"
            data-summary-prompt-tab="summary"
            aria-selected={summaryPromptView === "summary"}
            aria-controls="summary-prompt-panel-summary"
            tabIndex={summaryPromptView === "summary" ? 0 : -1}
            onClick={() => setSummaryPromptView("summary")}
            className={cn(
              "rounded px-2 py-1 text-[0.625rem] font-semibold transition-colors",
              summaryPromptView === "summary"
                ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
            )}
          >
            {localizeUi("ui.chat.summarypopover.chatSummaryPrompt")}
          </button>
          <button
            type="button"
            role="tab"
            id="summary-prompt-tab-combine"
            data-summary-prompt-tab="combine"
            aria-selected={summaryPromptView === "combine"}
            aria-controls="summary-prompt-panel-combine"
            tabIndex={summaryPromptView === "combine" ? 0 : -1}
            onClick={() => setSummaryPromptView("combine")}
            className={cn(
              "rounded px-2 py-1 text-[0.625rem] font-semibold transition-colors",
              summaryPromptView === "combine"
                ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
            )}
          >
            {localizeUi("ui.chat.summarypopover.combinePrompt")}
          </button>
        </div>

        {summaryPromptView === "summary" ? (
          <div
            data-summary-prompt-view="summary"
            className="space-y-2"
            id="summary-prompt-panel-summary"
            role="tabpanel"
            aria-labelledby="summary-prompt-tab-summary"
          >
            <div className="space-y-1">
              <SummaryPromptTemplateRow
                active={!normalizedActivePromptTemplateId}
                name={localizeUi("ui.chat.summarypopover.builtInDefault")}
                detail={localizeUi("chat.summary.template.appDefault")}
                disabled={templateEditorDisabled}
                onSelect={() => void handleSelectPromptTemplate(null)}
                onCopy={() => handleDuplicatePromptTemplate(null, DEFAULT_CHAT_SUMMARY_PROMPT)}
              />
              {longTermMemorySummaryPromptAvailable && (
                <SummaryPromptTemplateRow
                  active={isLongTermMemoryPromptSelected}
                  name={localizeUi("chat.summary.template.longTermMemory")}
                  detail={localizeUi("chat.summary.template.appDefault")}
                  disabled={templateEditorDisabled}
                  onSelect={() => void handleSelectPromptTemplate(LONG_TERM_MEMORY_CHAT_SUMMARY_PROMPT_ID)}
                  onCopy={() => handleDuplicatePromptTemplate(null, DEFAULT_LONG_TERM_MEMORY_CHAT_SUMMARY_PROMPT)}
                />
              )}
              {cleanedPromptTemplates.map((template) => (
                <SummaryPromptTemplateRow
                  key={template.id}
                  active={normalizedActivePromptTemplateId === template.id}
                  name={template.name}
                  detail={localizeUi("chat.summary.template.tokenEstimate", {
                    count: estimateTextTokens(template.prompt),
                  })}
                  disabled={templateEditorDisabled}
                  onSelect={() => void handleSelectPromptTemplate(template.id)}
                  onCopy={() => handleDuplicatePromptTemplate(template)}
                  onEdit={() => handleEditPromptTemplate(template)}
                  onDelete={() => void handleDeletePromptTemplate(template.id)}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={handleNewPromptTemplate}
              disabled={templateEditorDisabled}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--border)] bg-[var(--accent)]/35 px-2 py-1.5 text-[0.625rem] font-semibold text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size="0.6875rem" />
              {localizeUi("ui.chat.summarypopover.newTemplate")}
            </button>

            {(templateNameDraft || templatePromptDraft) && (
              <div className="space-y-1.5 rounded-lg bg-[var(--background)]/30 p-2 ring-1 ring-[var(--border)]">
                <input
                  value={templateNameDraft}
                  onChange={(event) => setTemplateNameDraft(event.target.value)}
                  disabled={templateEditorDisabled}
                  maxLength={80}
                  placeholder={localizeUi("ui.chat.summarypopover.templateName")}
                  className="w-full rounded-md bg-[var(--card)] px-2 py-1 text-[0.6875rem] font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50"
                />
                <MacroTextarea
                  value={templatePromptDraft}
                  onChange={setTemplatePromptDraft}
                  rows={8}
                  title={localizeUi("ui.chat.summarypopover.chatSummaryPrompt")}
                  ariaLabel={localizeUi("ui.chat.summarypopover.promptInstructionsForSummaryGeneration")}
                  placeholder={localizeUi("ui.chat.summarypopover.promptInstructionsForSummaryGeneration")}
                  readOnly={templateEditorDisabled}
                  wrapperClassName="min-w-0"
                  className="mari-chrome-field max-h-48 !rounded-md bg-[var(--card)] px-2 py-1.5 font-mono text-[0.625rem] leading-relaxed read-only:cursor-not-allowed read-only:opacity-50"
                />
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    onClick={resetTemplateDraft}
                    disabled={templateEditorDisabled}
                    className="rounded-md px-2 py-1 text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {localizeUi("chat.delete.dialog.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSavePromptTemplate()}
                    disabled={!hasTemplateDraft || templateEditorDisabled}
                    className="flex items-center gap-1 rounded-md bg-[var(--secondary)] px-2 py-1 text-[0.625rem] font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Save size="0.625rem" />
                    {isEditingExistingTemplate
                      ? localizeUi("ui.noodle.noodlehome.save")
                      : localizeUi("ui.characters.metadatatab.add")}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            data-summary-prompt-view="combine"
            className="space-y-1"
            id="summary-prompt-panel-combine"
            role="tabpanel"
            aria-labelledby="summary-prompt-tab-combine"
          >
            <MacroTextarea
              value={combinePromptDraft}
              onFocus={() => {
                combinePromptFocused.current = true;
              }}
              onChange={(value) => {
                const nextValue = value.slice(0, CHAT_SUMMARY_PROMPT_MAX_LENGTH);
                combinePromptDraftRef.current = nextValue;
                setCombinePromptDraft(nextValue);
              }}
              onBlur={() => void handleCombinePromptBlur()}
              onExpandedClose={() => void handleCombinePromptBlur()}
              rows={5}
              title={localizeUi("ui.chat.summarypopover.combinePrompt")}
              ariaLabel={localizeUi("ui.chat.summarypopover.combinePrompt")}
              readOnly={!globalPromptSettingsReady || promptSettingsSaveLocked}
              wrapperClassName="min-w-0"
              className="mari-chrome-field h-28 resize-none !rounded-md bg-[var(--card)] px-2 py-1.5 font-mono text-[0.625rem] leading-relaxed read-only:cursor-not-allowed read-only:opacity-50"
            />
            <span className="block text-[0.5625rem] leading-snug text-[var(--muted-foreground)]">
              {localizeUi("ui.chat.summarypopover.combinePromptHelp")}
            </span>
          </div>
        )}
      </div>
      {/* @summary-prompt-controls-end */}
    </div>
  );
}

// @summary-prompt-row-start
interface SummaryPromptTemplateRowProps {
  active: boolean;
  name: string;
  detail: string;
  disabled?: boolean;
  onSelect: () => void;
  onCopy: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

function SummaryPromptTemplateRow({
  active,
  name,
  detail,
  disabled,
  onSelect,
  onCopy,
  onEdit,
  onDelete,
}: SummaryPromptTemplateRowProps) {
  const { t: localizeUi } = useTranslation();
  return (
    <div
      data-summary-template-row
      className={cn(
        "group flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors",
        active
          ? "bg-[var(--accent)] text-[var(--foreground)] ring-1 ring-[var(--border)]"
          : "hover:bg-[var(--accent)]/45",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
        title={localizeUi("chat.summary.template.use", { name })}
      >
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-1",
            active
              ? "bg-[var(--accent)] text-[var(--foreground)] ring-[var(--border)]"
              : "text-transparent ring-[var(--border)]",
          )}
        >
          <Check size="0.625rem" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[0.6875rem] font-semibold text-[var(--popover-foreground)]">{name}</span>
          <span className="block truncate text-[0.5625rem] text-[var(--muted-foreground)]">{detail}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={onCopy}
        disabled={disabled}
        className="shrink-0 rounded p-1 text-[var(--muted-foreground)] opacity-80 transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
        title={localizeUi("ui.chat.summaryprompttemplaterow.duplicateTemplate")}
        aria-label={localizeUi("ui.chat.summaryprompttemplaterow.duplicateTemplate")}
      >
        <Copy size="0.625rem" />
      </button>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          disabled={disabled}
          className="shrink-0 rounded p-1 text-[var(--muted-foreground)] opacity-80 transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
          title={localizeUi("ui.chat.summaryprompttemplaterow.editTemplate")}
          aria-label={localizeUi("ui.chat.summaryprompttemplaterow.editTemplate")}
        >
          <PenLine size="0.625rem" />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className="shrink-0 rounded p-1 text-[var(--muted-foreground)] opacity-80 transition-colors hover:bg-[var(--destructive)]/15 hover:text-[var(--destructive)] disabled:cursor-not-allowed disabled:opacity-50"
          title={localizeUi("ui.chat.summaryprompttemplaterow.deleteTemplate")}
          aria-label={localizeUi("ui.chat.summaryprompttemplaterow.deleteTemplate")}
        >
          <Trash2 size="0.625rem" />
        </button>
      )}
    </div>
  );
}
// @summary-prompt-row-end
