import { Loader2, BrainCircuit, DatabaseZap, Import, FileJson, Plug, RefreshCw, Hammer, AlertCircle, RotateCcw, AlertTriangle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { StatusPill, ToolButton } from "./LtmPills";
import LtmInlineSettingsSections, { LtmExtractionConnectionSection, LtmExtractionPromptSection } from "./LtmInlineSettingsSections";
import {
  RecallStylePresets,
  RecallBudgetControls,
  RecallThresholdControls,
  RecallRankingWeights,
  RecallToggles,
} from "./RecallSettingsControls";
import {
  DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  DEFAULT_LTM_EXTRACTION_VERBOSITY,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_TEMPERATURE,
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
} from "@marinara-engine/shared";
import type { UseLtmAgentSectionResult } from "../../hooks/use-ltm-agent-section";

function FieldGroup({
  label,
  icon,
  help,
  collapsible,
  expanded,
  onExpandedChange,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  help?: string;
  collapsible?: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  if (collapsible) {
    return (
      <details open={expanded} className="group rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30">
        <summary
          className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]"
          onClick={(e) => {
            if (onExpandedChange) {
              e.preventDefault();
              onExpandedChange(!expanded);
            }
          }}
        >
          {icon}
          {label}
        </summary>
        <div className="space-y-3 border-t border-[var(--border)] px-3 py-3">{children}</div>
      </details>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-xs font-semibold text-[var(--foreground)]">{label}</span>
        {help && <span className="text-[0.5625rem] text-[var(--muted-foreground)]">— {help}</span>}
      </div>
      {children}
    </div>
  );
}

export function LongTermMemoryAgentSection({
  ltm,
  connections,
}: {
  ltm: UseLtmAgentSectionResult;
  connections: Array<{ id: string }> | undefined;
}) {
  const {
    setVaultOpen,
    ltmAdvancedOpen,
    setLtmAdvancedOpen,
    recallAdvancedOpen,
    setRecallAdvancedOpen,
    maintenanceOpen,
    setMaintenanceOpen,
    ltmStatus,
    integrity,
    ltmDraft,
    ltmRecallDraft,
    lastRepairResult,
    ltmHasMemories,
    ltmIndexHealth,
    ltmSmartSearchAvailable,
    ltmSmartSearchReady,
    ltmSearchStatusLabel,
    ltmSearchStatusTitle,
    ltmIndexStatus,
    indexedMemoryChunkLabel,
    updateLtmDraft,
    updateLtmRecallDraft,
    handleLtmPromptDraftDirtyChange,
    rebuildMemories,
    repairMemories,
    runMemoryRepair,
  } = ltm;

  return (
    <section className="space-y-5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 shadow-sm sm:p-4">
      <div className="flex items-start gap-3 border-b border-[var(--border)]/70 pb-4">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--primary)]/10 text-[var(--primary)] ring-1 ring-[var(--primary)]/25">
          <BrainCircuit size="1.125rem" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">Long-Term Memory</h2>
          <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-[var(--muted-foreground)]">
            Manage the memory vault, extraction prompts, recall defaults, and store maintenance.
          </p>
        </div>
      </div>

      <FieldGroup
        label="Memories"
        icon={<DatabaseZap size="0.875rem" className="text-[var(--primary)]" />}
        help="Browse, search, import, and manage long-term memories."
      >
        {(() => {
          const connectionId = ltmDraft?.connectionId ?? "";
          const hasConnection =
            !!connectionId &&
            (connections ?? []).some((item) => item.id === connectionId);
          if (!hasConnection) {
            return (
              <div className="mb-3 rounded-xl border border-[var(--primary)]/20 bg-[var(--primary)]/8 p-4">
                <div className="flex items-center gap-2">
                  <Plug size="1rem" className="text-[var(--primary)]" />
                  <p className="text-sm font-medium text-[var(--foreground)]">
                    Memory needs an AI connection to extract facts
                  </p>
                </div>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Pick one in the extraction connection control below.
                </p>
              </div>
            );
          }
          if (ltmStatus.isLoading) {
            return (
              <div className="mb-3 flex items-center gap-2 rounded-lg bg-[var(--secondary)]/45 p-3 text-xs text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
                <Loader2 size="0.875rem" className="animate-spin" />
                Loading memory status...
              </div>
            );
          }
          if (ltmStatus.isError && !ltmStatus.data) {
            return (
              <div
                role="alert"
                className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--destructive)]/25 bg-[var(--destructive)]/5 p-3 text-xs"
              >
                <span className="flex items-center gap-2">
                  <AlertCircle size="0.875rem" className="text-[var(--destructive)]" />
                  Memory status could not load.
                </span>
                <ToolButton onClick={() => void ltmStatus.refetch()}>
                  <RotateCcw size="0.75rem" />
                  Retry
                </ToolButton>
              </div>
            );
          }
          if (!ltmHasMemories) {
            return (
              <div className="mb-3 rounded-xl border border-[var(--primary)]/20 bg-[var(--primary)]/8 p-4">
                <div className="flex items-center gap-2">
                  <FileJson size="1rem" className="text-[var(--primary)]" />
                  <p className="text-sm font-medium text-[var(--foreground)]">Ready to import</p>
                </div>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Bring in characters, lorebooks, or chats to get started.
                </p>
                <div className="mt-3">
                  <ToolButton
                    onClick={() => setVaultOpen({ initialTab: "import" })}
                    tone="primary"
                    size="default"
                  >
                    <Import size="0.875rem" />
                    Import
                  </ToolButton>
                </div>
              </div>
            );
          }
          return null;
        })()}
        {ltmHasMemories && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {ltmStatus.data && (
              <StatusPill
                label={ltmSearchStatusLabel}
                tone={ltmSmartSearchReady ? "good" : ltmSmartSearchAvailable ? "warn" : "neutral"}
                title={ltmSearchStatusTitle}
              />
            )}
            {ltmIndexHealth && (
              <StatusPill
                label={ltmIndexStatus.label}
                tone={ltmIndexStatus.tone}
                title={ltmIndexStatus.title}
              />
            )}
          </div>
        )}
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <ToolButton onClick={() => setVaultOpen({ initialTab: "notes" })} tone="primary" size="default">
            <DatabaseZap size="0.875rem" />
            Manage Memories
          </ToolButton>
          <ToolButton onClick={() => setVaultOpen({ initialTab: "import" })} size="default">
            <Import size="0.875rem" />
            Import
          </ToolButton>
        </div>
      </FieldGroup>

      <LtmExtractionConnectionSection
        connectionId={ltmDraft?.connectionId ?? ""}
        onChangeConnectionId={(value) => updateLtmDraft({ connectionId: value })}
      />
      <LtmExtractionPromptSection
        promptTemplates={ltmDraft?.promptTemplates ?? []}
        activePromptTemplateIdsByMode={ltmDraft?.activePromptTemplateIdsByMode ?? {}}
        aiKeywordExtraction={ltmDraft?.aiKeywordExtraction ?? false}
        refinePass={ltmDraft?.refinePass ?? false}
        onChangePromptTemplates={(promptTemplates) => updateLtmDraft({ promptTemplates })}
        onChangeActivePromptTemplateIdsByMode={(activePromptTemplateIdsByMode) =>
          updateLtmDraft({ activePromptTemplateIdsByMode })
        }
        onChangeAiKeywordExtraction={(aiKeywordExtraction) => updateLtmDraft({ aiKeywordExtraction })}
        onChangeRefinePass={(refinePass) => updateLtmDraft({ refinePass })}
        onPromptDraftDirtyChange={handleLtmPromptDraftDirtyChange}
      />

      <FieldGroup
        label="Long-Term Memory defaults"
        icon={<BrainCircuit size="0.875rem" className="text-[var(--primary)]" />}
      >
        {ltmRecallDraft ? (
          <div className="space-y-4">
            <RecallStylePresets
              values={{ longTermMemoryRecallStyle: ltmRecallDraft.longTermMemoryRecallStyle }}
              onChange={updateLtmRecallDraft}
            />
            <RecallBudgetControls
              values={{
                longTermMemoryBudgetTokens: ltmRecallDraft.longTermMemoryBudgetTokens,
                longTermMemoryMaxChunks: ltmRecallDraft.longTermMemoryMaxChunks,
              }}
              onChange={updateLtmRecallDraft}
            />
            <FieldGroup
              label="Advanced Long-Term Memory"
              collapsible
              expanded={recallAdvancedOpen}
              onExpandedChange={setRecallAdvancedOpen}
            >
              <RecallThresholdControls
                values={{
                  longTermMemoryScoreThreshold: ltmRecallDraft.longTermMemoryScoreThreshold,
                  longTermMemoryRecallContextMessages: ltmRecallDraft.longTermMemoryRecallContextMessages,
                }}
                onChange={updateLtmRecallDraft}
              />
              <RecallRankingWeights
                values={{
                  longTermMemoryRecallStyle: ltmRecallDraft.longTermMemoryRecallStyle,
                  longTermMemorySemanticWeight: ltmRecallDraft.longTermMemorySemanticWeight,
                  longTermMemoryLexicalWeight: ltmRecallDraft.longTermMemoryLexicalWeight,
                  longTermMemoryGraphWeight: ltmRecallDraft.longTermMemoryGraphWeight,
                  longTermMemoryKeywordWeight: ltmRecallDraft.longTermMemoryKeywordWeight,
                }}
                onChange={updateLtmRecallDraft}
              />
              <RecallToggles
                values={{
                  longTermMemoryIncludeResolved: ltmRecallDraft.longTermMemoryIncludeResolved,
                  longTermMemoryDebug: ltmRecallDraft.longTermMemoryDebug,
                }}
                onChange={updateLtmRecallDraft}
              />
            </FieldGroup>
          </div>
        ) : (
          <p className="rounded-xl bg-[var(--secondary)]/60 px-3 py-2 text-xs text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
            Loading recall defaults...
          </p>
        )}
      </FieldGroup>

      <FieldGroup
        label="Advanced"
        icon={<DatabaseZap size="0.875rem" className="text-[var(--primary)]" />}
        collapsible
        expanded={ltmAdvancedOpen}
        onExpandedChange={setLtmAdvancedOpen}
      >
        <LtmInlineSettingsSections
          extractionSettings={{
            reasoningEffort: ltmDraft?.reasoningEffort ?? DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
            verbosity: ltmDraft?.verbosity ?? DEFAULT_LTM_EXTRACTION_VERBOSITY,
            maxOutputTokens: ltmDraft?.maxOutputTokens ?? DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
            temperature: ltmDraft?.temperature ?? DEFAULT_LTM_EXTRACTION_TEMPERATURE,
            maxExistingNoteTokens:
              ltmDraft?.maxExistingNoteTokens ?? DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
          }}
          autoApplyLowRisk={ltmDraft?.autoApplyLowRisk ?? false}
          onChange={updateLtmDraft}
        />
      </FieldGroup>

      <FieldGroup
        label="Maintenance"
        icon={<DatabaseZap size="0.875rem" className="text-[var(--primary)]" />}
        collapsible
        expanded={maintenanceOpen}
        onExpandedChange={setMaintenanceOpen}
      >
        <div className="mb-3 flex flex-wrap gap-1.5">
          <StatusPill
            label={indexedMemoryChunkLabel}
            title="Memory search splits saved memories into chunks before indexing."
          />
          {ltmIndexHealth && (
            <StatusPill label={ltmIndexStatus.label} tone={ltmIndexStatus.tone} title={ltmIndexStatus.title} />
          )}
          {(ltmStatus.isLoading || integrity.isLoading) && <StatusPill label="Checking memory store" />}
        </div>
        {(ltmStatus.isError || integrity.isError) && (
          <div
            role="alert"
            className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--destructive)]/25 bg-[var(--destructive)]/5 p-3 text-xs"
          >
            <div className="flex min-w-0 items-center gap-2">
              <AlertCircle size="0.875rem" className="shrink-0 text-[var(--destructive)]" />
              <span>
                {ltmStatus.data || integrity.data
                  ? "Memory maintenance status could not refresh. Showing the last known result."
                  : "Memory maintenance status could not load."}
              </span>
            </div>
            <ToolButton
              onClick={() => {
                void ltmStatus.refetch();
                void integrity.refetch();
              }}
            >
              <RotateCcw size="0.75rem" />
              Retry
            </ToolButton>
          </div>
        )}
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <ToolButton
            onClick={() =>
              rebuildMemories
                .mutateAsync()
                .then(() => {
                  toast.success("Memory search refreshed");
                })
                .catch((error: Error) => toast.error(error.message))
            }
            disabled={rebuildMemories.isPending}
            tone="primary"
          >
            <RefreshCw size="0.875rem" />
            Reindex Memories
          </ToolButton>
          <ToolButton onClick={() => void runMemoryRepair()} disabled={repairMemories.isPending} tone="danger">
            {repairMemories.isPending ? (
              <Loader2 size="0.875rem" className="animate-spin" />
            ) : (
              <Hammer size="0.875rem" />
            )}
            Repair Memory Store
          </ToolButton>
        </div>
        {lastRepairResult && (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 space-y-2 rounded-lg bg-[var(--secondary)]/45 p-3 text-xs ring-1 ring-[var(--border)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-[var(--foreground)]">Latest repair</span>
              <StatusPill
                label={lastRepairResult.integrity.ok ? "Store healthy" : "Issues remain"}
                tone={lastRepairResult.integrity.ok ? "good" : "warn"}
              />
            </div>
            {lastRepairResult.actions.map((action) => (
              <div key={action.action} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[var(--muted-foreground)]">
                  {action.action === "quarantine_malformed_notes"
                    ? "Malformed files"
                    : action.action === "backfill_imported_source_titles"
                      ? "Imported-source titles"
                      : "Memory index"}
                </span>
                <span className="font-medium text-[var(--foreground)]">
                  {action.result.replaceAll("_", " ")}
                  {typeof action.count === "number" ? ` (${action.count})` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 space-y-2">
          {(integrity.data?.issues ?? [])
            .filter((issue: { severity: string }) => issue.severity !== "info")
            .slice(0, 8)
            .map(
              (issue: { code: string; path?: string; noteId?: string; message: string; severity: string }) => (
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
              ),
            )}
        </div>
      </FieldGroup>
    </section>
  );
}
