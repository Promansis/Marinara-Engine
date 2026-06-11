import { useMemo, useState } from "react";
import { Bug, ChevronDown, ChevronRight, Clipboard, Download, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { LtmDebugEvent, LtmDebugPhase, LtmDebugStatus } from "@marinara-engine/shared";
import { toast } from "sonner";
import {
  useClearLongTermMemoryDebugLog,
  useExportLongTermMemoryDebugLog,
  useLongTermMemoryDebugLog,
} from "../../hooks/use-long-term-memory";
import { cn } from "../../lib/utils";
import { Modal } from "../ui/Modal";
import { StatusPill, ToolButton } from "./LtmPills";

const PHASE_FILTERS: Array<"all" | LtmDebugPhase | "errors"> = [
  "all",
  "import",
  "extraction",
  "llm",
  "compiler",
  "draft",
  "apply",
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

function eventSummary(event: LtmDebugEvent) {
  return event.message || phaseLabel(event.action);
}

function compactIds(event: LtmDebugEvent) {
  return [
    event.source ? `${event.source}${event.sourceId ? `:${event.sourceId}` : ""}` : null,
    event.sourceNoteId ? `source ${event.sourceNoteId}` : null,
    event.draftId ? `draft ${event.draftId.slice(0, 8)}` : null,
    event.noteId ? `note ${event.noteId}` : null,
  ].filter(Boolean);
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
    return [...groups.entries()].map(([operationId, groupEvents]) => ({ operationId, events: groupEvents }));
  }, [events]);

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

        <div className="flex flex-wrap gap-1.5">
          {PHASE_FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setPhase(item)}
              className={cn(
                "rounded-md border px-2 py-1 text-[0.6875rem] font-medium transition-colors",
                phase === item
                  ? "border-rose-300/35 bg-rose-300/15 text-[var(--foreground)]"
                  : "border-[var(--border)] bg-[var(--secondary)]/40 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
              )}
            >
              {item === "all" ? "All" : item === "errors" ? "Errors" : phaseLabel(item)}
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/25 p-2">
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
            <div className="space-y-3">
              {grouped.map((group) => (
                <section key={group.operationId} className="space-y-1.5">
                  <div className="flex items-center gap-2 px-1">
                    <div className="h-px flex-1 bg-[var(--border)]" />
                    <div className="text-[0.625rem] text-[var(--muted-foreground)]">
                      Operation {group.operationId.slice(0, 8)}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {group.events.map((event) => (
                      <EventRow key={event.id} event={event} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
