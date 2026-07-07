import { Check, Import, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  listRowClassName,
  selectedListRowClassName,
} from "./LtmFields";
import {
  rowActionButtonClassName,
  rowActionGroupClassName,
  type ImportPreviewRow,
} from "./ltm-panel-shared";
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
  return (
    <article
      className={cn(
        "group relative grid grid-cols-[auto_minmax(0,1fr)] gap-3 pr-12",
        listRowClassName,
        selected && selectedListRowClassName,
        imported && "bg-amber-500/5 ring-amber-500/20",
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={disabled || imported}
        onChange={(event) => onSelect(event.target.checked)}
        className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
        aria-label={`Select ${sample.title}`}
      />
      <div className="min-w-0 self-center">
        <div className="flex items-center gap-2">
          <div className="truncate text-xs font-medium text-[var(--foreground)]" title={sample.title}>
            {sample.title}
          </div>
          {imported && <StatusPill label="Imported" tone="warn" title={sample.existingNoteTitle ?? sample.title} />}
        </div>
        {sample.snippet && (
          <div className="mt-1 truncate text-[10px] leading-relaxed text-[var(--muted-foreground)]" title={sample.snippet}>
            {sample.snippet}
          </div>
        )}
        {imported && sample.existingNoteTitle && (
          <div className="mt-1 truncate text-[10px] leading-relaxed text-[var(--muted-foreground)]">
            Already exists as {sample.existingNoteTitle}
          </div>
        )}
      </div>
      <div className={rowActionGroupClassName}>
        <button
          type="button"
          onClick={onImport}
          disabled={disabled || importing || imported}
          className={cn(
            rowActionButtonClassName,
            "mari-chrome-control--primary",
          )}
          aria-label={`Import ${sample.title}`}
          title="Import"
        >
          {importing ? <Loader2 size="0.75rem" className="animate-spin" /> : imported ? <Check size="0.75rem" /> : <Import size="0.75rem" />}
        </button>
      </div>
    </article>
  );
}
