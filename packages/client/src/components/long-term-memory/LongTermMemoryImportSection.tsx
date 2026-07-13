import { Check, Import, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { listRowClassName, selectedListRowClassName } from "./LtmFields";
import { rowActionButtonClassName, rowActionGroupClassName, type ImportPreviewRow } from "./ltm-panel-shared";
import { StatusPill } from "./LtmPills";

export function ImportPreviewRowItem({
  sample,
  selected,
  disabled,
  importing,
  onSelect,
  onImport,
}: {
  sample: ImportPreviewRow;
  selected: boolean;
  disabled?: boolean;
  importing?: boolean;
  onSelect: (selected: boolean) => void;
  onImport: () => void;
}) {
  const imported = sample.status === "imported";
  const stale = sample.freshness === "stale";
  const importLabel = stale ? `Refresh memory from ${sample.title}` : `Import ${sample.title}`;
  return (
    <article
      className={cn(
        "group relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 pr-12 max-md:pr-14",
        listRowClassName,
        selected && selectedListRowClassName,
        imported && "bg-emerald-500/5 ring-1 ring-emerald-500/20",
        stale && "bg-amber-500/5 ring-1 ring-amber-500/20",
      )}
    >
      <label className="flex h-8 w-8 shrink-0 items-center justify-center max-md:h-10 max-md:w-10">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled || imported}
          onChange={(event) => onSelect(event.target.checked)}
          className="h-4 w-4 rounded border-[var(--border)] accent-[var(--primary)]"
          aria-label={`Select ${sample.title}`}
        />
      </label>
      <div className="min-w-0 self-center">
        <div className="flex items-center gap-2">
          <div className="truncate text-xs font-medium text-[var(--foreground)]" title={sample.title}>
            {sample.title}
          </div>
          {imported && <StatusPill label="Current" tone="good" title={sample.existingNoteTitle ?? sample.title} />}
          {stale && <StatusPill label="Source changed" tone="warn" title={sample.existingNoteTitle ?? sample.title} />}
        </div>
        {sample.snippet && (
          <div
            className="mt-1 truncate text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]"
            title={sample.snippet}
          >
            {sample.snippet}
          </div>
        )}
        {imported && sample.existingNoteTitle && (
          <div className="mt-1 truncate text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
            Current as {sample.existingNoteTitle}
          </div>
        )}
        {stale && sample.existingNoteTitle && (
          <div className="mt-1 truncate text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
            Refreshes {sample.existingNoteTitle} with the changed source
          </div>
        )}
      </div>
      <div className={rowActionGroupClassName}>
        <button
          type="button"
          onClick={onImport}
          disabled={disabled || importing || imported}
          className={cn(rowActionButtonClassName, "mari-chrome-control--primary")}
          aria-label={importLabel}
          title={stale ? "Refresh memory" : "Import"}
        >
          {importing ? (
            <Loader2 size="0.75rem" className="animate-spin" />
          ) : imported ? (
            <Check size="0.75rem" />
          ) : (
            <Import size="0.75rem" />
          )}
        </button>
      </div>
    </article>
  );
}
