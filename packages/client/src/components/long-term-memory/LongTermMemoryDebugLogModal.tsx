import { useMemo, useState } from "react";
import {
  Bug,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Download,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { LtmDebugEvent, LtmDebugPhase, LtmDebugStatus } from "@marinara-engine/shared";
import { toast } from "sonner";
import { cn } from "../../lib/utils";
import {
  useClearLongTermMemoryDebugLog,
  useExportLongTermMemoryDebugLog,
  useLongTermMemoryDebugLog,
} from "../../hooks/use-long-term-memory";
import { Modal } from "../ui/Modal";
import { StatusPill, ToolButton } from "./LtmPills";
import { labelLtmLane, labelLtmTier, labelRejectionReason } from "./ltm-debug-utils";

const PHASE_FILTERS: Array<"all" | LtmDebugPhase | "errors"> = [
  "all",
  "import",
  "extraction",
  "llm",
  "compiler",
  "draft",
  "apply",
  "injection",
  "rebuild",
  "errors",
];

const EMPTY_EVENTS: LtmDebugEvent[] = [];

const STATUS_TONE: Record<LtmDebugStatus, "neutral" | "good" | "warn" | "bad"> = {
  started: "neutral",
  ok: "good",
  skipped: "neutral",
  warning: "warn",
  error: "bad",
};

type OperationTab = "summary" | "events" | "raw";

type DebugRecord = Record<string, unknown>;

type OperationSummary = {
  operationId: string;
  events: LtmDebugEvent[];
  firstTs: string;
  lastTs: string;
  finalStatus: LtmDebugStatus;
  phases: string[];
  actions: string[];
  sourceIds: string[];
  counts: Record<string, number>;
  totalDurationMs?: number;
  hasWarning: boolean;
  hasError: boolean;
};

function phaseLabel(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTime(ts: string) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number | undefined) {
  if (typeof ms !== "number") return null;
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
  return `${ms} ms`;
}

function eventSummary(event: LtmDebugEvent) {
  return event.message || phaseLabel(event.action);
}

function compactIds(event: LtmDebugEvent) {
  return [
    event.source ? `${event.source}${event.sourceId ? `:${event.sourceId}` : ""}` : null,
    event.sourceNoteId ? `source ${event.sourceNoteId}` : null,
    event.draftId ? `draft ${event.draftId.slice(0, 8)}` : null,
    event.noteId ? `note ${event.noteId}` : null,
  ].filter((item): item is string => Boolean(item));
}

function countChips(event: LtmDebugEvent) {
  return Object.entries(event.counts ?? {})
    .filter(([, value]) => value > 0)
    .slice(0, 4)
    .map(([key, value]) => `${phaseLabel(key)} ${value}`);
}

function detailsForEvent(event: LtmDebugEvent) {
  return {
    operationId: event.operationId,
    ids: {
      source: event.source,
      sourceId: event.sourceId,
      sourceNoteId: event.sourceNoteId,
      draftId: event.draftId,
      noteId: event.noteId,
      mutationIds: event.mutationIds,
    },
    provider: event.provider,
    model: event.model,
    counts: event.counts,
    diagnostics: event.diagnostics,
    error: event.error,
    details: event.details,
  };
}

function isRecord(value: unknown): value is DebugRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getRecord(value: unknown, key: string): DebugRecord | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function getArray(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const child = value[key];
  return Array.isArray(child) ? child : [];
}

function getNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === "string" ? child : undefined;
}

function getWarnings(event: LtmDebugEvent | undefined) {
  const detailWarnings = getArray(event?.details, "warnings").filter((item): item is string => typeof item === "string");
  const decisionWarnings = getArray(getRecord(event?.details, "decision"), "warnings").filter(
    (item): item is string => typeof item === "string",
  );
  return [...new Set([...detailWarnings, ...decisionWarnings])];
}

function latestInjectionEvent(events: LtmDebugEvent[]) {
  return [...events].find((event) => event.phase === "injection" && event.action === "prompt_injection" && event.status !== "started");
}

function aggregateOperation(operationId: string, events: LtmDebugEvent[]): OperationSummary {
  const ordered = [...events].sort((left, right) => left.ts.localeCompare(right.ts));
  const counts: Record<string, number> = {};
  const sourceIds = new Set<string>();
  let totalDurationMs: number | undefined;

  for (const event of ordered) {
    for (const [key, value] of Object.entries(event.counts ?? {})) {
      counts[key] = Math.max(counts[key] ?? 0, value);
    }
    for (const id of compactIds(event)) sourceIds.add(id);
    if (typeof event.durationMs === "number") totalDurationMs = Math.max(totalDurationMs ?? 0, event.durationMs);
  }

  const final = ordered.findLast((event) => event.status !== "started") ?? ordered[ordered.length - 1]!;
  return {
    operationId,
    events: ordered,
    firstTs: ordered[0]?.ts ?? "",
    lastTs: ordered.at(-1)?.ts ?? "",
    finalStatus: final.status,
    phases: [...new Set(ordered.map((event) => event.phase))],
    actions: [...new Set(ordered.map((event) => event.action))],
    sourceIds: [...sourceIds].slice(0, 5),
    counts,
    totalDurationMs,
    hasWarning: ordered.some((event) => event.status === "warning" || getWarnings(event).length > 0),
    hasError: ordered.some((event) => event.status === "error"),
  };
}

function operationHeadline(summary: OperationSummary) {
  const parts = [
    `Operation ${summary.operationId.slice(0, 8)}`,
    summary.phases.map(phaseLabel).join(", "),
    phaseLabel(summary.finalStatus),
  ];
  if (summary.counts.chunks !== undefined) parts.push(`${summary.counts.chunks} chunks`);
  if (summary.counts.usedTokens !== undefined && summary.counts.maxTokens !== undefined) {
    parts.push(`${summary.counts.usedTokens}/${summary.counts.maxTokens} tokens`);
  }
  return parts.filter(Boolean).join(" · ");
}

function importantCountChips(summary: OperationSummary) {
  const keys = [
    "chunks",
    "usedTokens",
    "maxTokens",
    "warnings",
    "insertedAt",
    "selectedCandidates",
    "rankedCandidates",
    "tokenBudgetSkippedCandidates",
    "mutationIds",
    "drafts",
  ];
  return keys
    .flatMap((key) => {
      const value = summary.counts[key];
      if (value === undefined) return [];
      if (key === "usedTokens" && summary.counts.maxTokens !== undefined) return [];
      if (key === "maxTokens" && summary.counts.usedTokens !== undefined) {
        return [`Tokens ${summary.counts.usedTokens}/${value}`];
      }
      return [`${phaseLabel(key)} ${value}`];
    })
    .slice(0, 6);
}

function EventRow({ event }: { event: LtmDebugEvent }) {
  const [expanded, setExpanded] = useState(false);
  const ids = compactIds(event);
  const counts = countChips(event);
  return (
    <article className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--secondary)]/35"
      >
        <span className="mt-0.5 text-[var(--muted-foreground)]">
          {expanded ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
        </span>
        <span className="min-w-0 space-y-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-[0.6875rem] tabular-nums text-[var(--muted-foreground)]">{formatTime(event.ts)}</span>
            <StatusPill label={phaseLabel(event.phase)} />
            <StatusPill label={phaseLabel(event.status)} tone={STATUS_TONE[event.status]} />
            {event.durationMs !== undefined && <StatusPill label={`${event.durationMs} ms`} />}
          </span>
          <span className="block truncate text-xs font-medium text-[var(--foreground)]">{eventSummary(event)}</span>
          {(ids.length > 0 || counts.length > 0) && (
            <span className="flex flex-wrap gap-1.5">
              {[...ids, ...counts].map((item) => (
                <span
                  key={item}
                  className="rounded-md bg-[var(--secondary)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]"
                >
                  {item}
                </span>
              ))}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--border)]/70 px-3 py-2">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--background)] p-2 text-[0.6875rem] leading-relaxed text-[var(--foreground)] ring-1 ring-[var(--border)]">
            {JSON.stringify(detailsForEvent(event), null, 2)}
          </pre>
        </div>
      )}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded-lg bg-[var(--secondary)]/45 px-3 py-2 ring-1 ring-[var(--border)]/70">
      <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{label}</div>
      <div className="mt-1 text-sm font-semibold text-[var(--foreground)]">{value ?? "None"}</div>
    </div>
  );
}

function CandidateRow({ item, rejected = false }: { item: unknown; rejected?: boolean }) {
  const lanes = getArray(item, "lanes").filter((lane): lane is string => typeof lane === "string");
  const reasons = getArray(item, "reasons").filter((reason): reason is string => typeof reason === "string");
  const noteId = getString(item, "noteId") ?? getString(item, "chunkId") ?? "unknown";
  const sectionKey = getString(item, "sectionKey") ?? "section";
  const score = getNumber(item, "score");
  return (
    <div className="rounded-lg bg-[var(--background)] px-3 py-2 ring-1 ring-[var(--border)]/70">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs font-semibold text-[var(--foreground)]">{noteId}</span>
        <StatusPill label={sectionKey} />
        <StatusPill label={labelLtmTier(getNumber(item, "tier"))} tone={getNumber(item, "tier") === 1 ? "good" : "neutral"} />
        {getNumber(item, "estimatedTokens") !== undefined && (
          <StatusPill label={`${getNumber(item, "estimatedTokens")} tokens`} />
        )}
        {score !== undefined && <StatusPill label={`Score ${score.toFixed(3)}`} />}
        {rejected && <StatusPill label={labelRejectionReason(getString(item, "rejectionReason"))} tone="warn" />}
      </div>
      {lanes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {lanes.map((lane) => (
            <span
              key={lane}
              title={lane}
              className="rounded-md bg-[var(--secondary)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]"
            >
              {labelLtmLane(lane)}
            </span>
          ))}
        </div>
      )}
      {reasons.length > 0 && (
        <div className="mt-2 line-clamp-2 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
          {reasons.join(" · ")}
        </div>
      )}
    </div>
  );
}

function FunnelSummary({ decision }: { decision: DebugRecord | undefined }) {
  const funnel = getRecord(decision, "funnel");
  if (!funnel) return null;
  const rows = [
    ["Total chunks", getNumber(funnel, "totalChunks")],
    ["Ranked", getNumber(funnel, "rankedCandidates")],
    ["Selected", getNumber(funnel, "selectedCandidates")],
    ["Budget skipped", getNumber(funnel, "tokenBudgetSkippedCandidates")],
    ["Vector", getNumber(funnel, "vectorCandidates")],
    ["BM25", getNumber(funnel, "bm25Candidates")],
    ["Graph", getNumber(funnel, "graphCandidates")],
    ["Filtered", (getNumber(funnel, "scopeFiltered") ?? 0) + (getNumber(funnel, "statusFiltered") ?? 0)],
  ].filter(([, value]) => typeof value === "number");
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      {rows.map(([label, value]) => (
        <Metric key={label as string} label={label as string} value={value as number} />
      ))}
    </div>
  );
}

function InjectionDecisionSummary({ summary }: { summary: OperationSummary }) {
  const event = latestInjectionEvent(summary.events);
  const decision = getRecord(event?.details, "decision");
  const selected = getArray(decision, "selectedChunks");
  const rejected = getArray(decision, "rejectedCandidates");
  const legacyChunks = selected.length > 0 ? selected : getArray(event?.details, "chunks");
  const budget = getRecord(decision, "budget");
  const insertion = getRecord(decision, "promptInsertion");
  const warnings = getWarnings(event);
  const outcome = getString(decision, "outcome") ?? event?.status ?? summary.finalStatus;
  const usedTokens = getNumber(budget, "usedTokens") ?? summary.counts.usedTokens;
  const maxTokens = getNumber(budget, "maxTokens") ?? summary.counts.maxTokens;
  const insertedAt = getNumber(insertion, "insertedAt") ?? summary.counts.insertedAt;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <Metric label="Outcome" value={phaseLabel(outcome)} />
        <Metric label="Memories" value={legacyChunks.length} />
        <Metric label="Token budget" value={usedTokens !== undefined && maxTokens !== undefined ? `${usedTokens}/${maxTokens}` : null} />
        <Metric label="Prompt placement" value={insertedAt !== undefined ? `Message ${insertedAt}` : "Not inserted"} />
      </div>

      {warnings.length > 0 && (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100 ring-1 ring-amber-400/30">
          {warnings.join(" ")}
        </div>
      )}

      <FunnelSummary decision={decision} />

      <section className="space-y-2">
        <div className="text-xs font-semibold text-[var(--foreground)]">Selected memories</div>
        {legacyChunks.length > 0 ? (
          <div className="space-y-2">
            {legacyChunks.map((item, index) => (
              <CandidateRow key={`${getString(item, "noteId") ?? getString(item, "chunkId") ?? index}-${index}`} item={item} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg bg-[var(--background)] px-3 py-2 text-xs text-[var(--muted-foreground)] ring-1 ring-[var(--border)]/70">
            No memories were selected for this prompt.
          </div>
        )}
      </section>

      {rejected.length > 0 && (
        <section className="space-y-2">
          <div className="text-xs font-semibold text-[var(--foreground)]">Rejected candidates</div>
          <div className="space-y-2">
            {rejected.slice(0, 20).map((item, index) => (
              <CandidateRow key={`${getString(item, "chunkId") ?? index}-${index}`} item={item} rejected />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function GenericOperationSummary({ summary }: { summary: OperationSummary }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <Metric label="Status" value={phaseLabel(summary.finalStatus)} />
        <Metric label="Events" value={summary.events.length} />
        <Metric label="Duration" value={formatDuration(summary.totalDurationMs)} />
        <Metric label="Window" value={`${formatTime(summary.firstTs)} to ${formatTime(summary.lastTs)}`} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {summary.phases.map((phase) => (
          <StatusPill key={phase} label={phaseLabel(phase)} />
        ))}
        {importantCountChips(summary).map((chip) => (
          <StatusPill key={chip} label={chip} />
        ))}
      </div>
      {summary.sourceIds.length > 0 && (
        <div className="text-xs leading-relaxed text-[var(--muted-foreground)]">
          Sources: {summary.sourceIds.join(", ")}
        </div>
      )}
    </div>
  );
}

function OperationDrawer({ summary, defaultOpen }: { summary: OperationSummary; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<OperationTab>("summary");
  const isInjection = summary.phases.includes("injection");
  const duration = formatDuration(summary.totalDurationMs);
  const chips = importantCountChips(summary);

  return (
    <section className="overflow-hidden rounded-lg bg-[var(--card)] ring-1 ring-[var(--border)]">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 px-3 py-3 text-left transition-colors hover:bg-[var(--secondary)]/35"
      >
        <span className="mt-0.5 text-[var(--muted-foreground)]">
          {open ? <ChevronDown size="1rem" /> : <ChevronRight size="1rem" />}
        </span>
        <span className="min-w-0 space-y-1.5">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-[var(--foreground)]">{operationHeadline(summary)}</span>
            <StatusPill label={phaseLabel(summary.finalStatus)} tone={STATUS_TONE[summary.finalStatus]} />
            {duration && <StatusPill label={duration} />}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[0.6875rem] tabular-nums text-[var(--muted-foreground)]">
              {formatTime(summary.firstTs)} to {formatTime(summary.lastTs)}
            </span>
            <StatusPill label={`${summary.events.length} events`} />
            {chips.map((chip) => (
              <StatusPill key={chip} label={chip} />
            ))}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--border)]/70 p-3">
          <div className="mb-3 flex flex-wrap gap-1 rounded-lg bg-[var(--background)] p-1 ring-1 ring-[var(--border)]/70">
            {(["summary", "events", "raw"] as OperationTab[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTab(item)}
                className={cn(
                  "min-h-7 rounded-md px-2.5 text-xs font-medium transition-colors",
                  tab === item
                    ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                    : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)]",
                )}
              >
                {phaseLabel(item)}
              </button>
            ))}
          </div>

          {tab === "summary" && (isInjection ? <InjectionDecisionSummary summary={summary} /> : <GenericOperationSummary summary={summary} />)}
          {tab === "events" && (
            <div className="space-y-1.5">
              {summary.events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </div>
          )}
          {tab === "raw" && (
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md bg-[var(--background)] p-3 text-[0.6875rem] leading-relaxed text-[var(--foreground)] ring-1 ring-[var(--border)]">
              {JSON.stringify(summary.events, null, 2)}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

export function LongTermMemoryDebugLogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<(typeof PHASE_FILTERS)[number]>("all");
  const filter = useMemo(
    () => ({
      limit: 200,
      ...(phase === "errors" ? { status: "error" as const } : {}),
      ...(phase !== "all" && phase !== "errors" ? { phase } : {}),
    }),
    [phase],
  );
  const log = useLongTermMemoryDebugLog(filter, { enabled: open });
  const clearLog = useClearLongTermMemoryDebugLog();
  const exportLog = useExportLongTermMemoryDebugLog();
  const events = log.data?.events ?? EMPTY_EVENTS;
  const grouped = useMemo(() => {
    const groups = new Map<string, LtmDebugEvent[]>();
    for (const event of events) {
      const group = groups.get(event.operationId) ?? [];
      group.push(event);
      groups.set(event.operationId, group);
    }
    return [...groups.entries()]
      .map(([operationId, groupEvents]) => aggregateOperation(operationId, groupEvents))
      .sort((left, right) => right.lastTs.localeCompare(left.lastTs));
  }, [events]);
  const latestAlertOperationId = grouped.find((group) => group.hasError || group.hasWarning)?.operationId;

  const copyVisible = async () => {
    await navigator.clipboard.writeText(events.map((event) => JSON.stringify(event)).join("\n"));
    toast.success("Debug log copied");
  };

  const clearVisible = () => {
    if (!confirm("Clear the LTM debug log?")) return;
    clearLog
      .mutateAsync()
      .then(() => toast.success("Debug log cleared"))
      .catch((err: Error) => toast.error(err.message));
  };

  return (
    <Modal open={open} onClose={onClose} title="LTM Debug Log" width="max-w-5xl">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <select
            value={phase}
            onChange={(event) => setPhase(event.target.value as (typeof PHASE_FILTERS)[number])}
            className="min-h-8 rounded-lg bg-[var(--secondary)] px-2.5 py-1.5 text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] focus:ring-[var(--primary)]"
            aria-label="Filter debug log phase"
          >
            {PHASE_FILTERS.map((item) => (
              <option key={item} value={item}>
                {item === "all" ? "All events" : item === "errors" ? "Errors only" : phaseLabel(item)}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap items-center gap-2">
            <ToolButton onClick={() => log.refetch()} disabled={log.isFetching}>
              {log.isFetching ? <Loader2 size="0.875rem" className="animate-spin" /> : <RefreshCw size="0.875rem" />}
              Refresh
            </ToolButton>
            <ToolButton onClick={copyVisible} disabled={events.length === 0}>
              <Clipboard size="0.875rem" />
              Copy
            </ToolButton>
            <ToolButton
              onClick={() => exportLog.mutate(undefined, { onError: (err) => toast.error((err as Error).message) })}
              disabled={exportLog.isPending}
            >
              {exportLog.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Download size="0.875rem" />}
              Export
            </ToolButton>
            <ToolButton onClick={clearVisible} disabled={clearLog.isPending} tone="danger">
              {clearLog.isPending ? <Loader2 size="0.875rem" className="animate-spin" /> : <Trash2 size="0.875rem" />}
              Clear
            </ToolButton>
          </div>
        </div>

        <div className="rounded-lg bg-[var(--secondary)]/25 p-2 ring-1 ring-[var(--border)]">
          {log.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((item) => (
                <div key={item} className="h-16 animate-pulse rounded-lg bg-[var(--muted)]/45" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="flex min-h-44 flex-col items-center justify-center gap-2 text-center text-[var(--muted-foreground)]">
              <Bug size="1.25rem" />
              <div className="text-sm font-medium text-[var(--foreground)]">No LTM debug events yet.</div>
              <div className="max-w-md text-xs leading-relaxed">
                Import a source, run extraction, accept a suggestion, or rebuild indexes to populate this timeline.
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {grouped.map((summary, index) => (
                <OperationDrawer
                  key={summary.operationId}
                  summary={summary}
                  defaultOpen={
                    summary.operationId === latestAlertOperationId ||
                    (latestAlertOperationId === undefined && index === 0 && summary.finalStatus !== "ok")
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
