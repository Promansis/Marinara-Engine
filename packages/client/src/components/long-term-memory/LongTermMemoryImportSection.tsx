import { Import, Loader2 } from "lucide-react";
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
  return (
    <article
      className={cn(
        "group grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3",
        listRowClassName,
        selected && selectedListRowClassName,
      )}
    >
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.checked)}
          className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
          aria-label={`Select ${sample.title}`}
        />
      <div className="min-w-0 self-center">
        <div className="truncate text-xs font-medium text-[var(--foreground)]" title={sample.title}>
          {sample.title}
        </div>
        {sample.snippet && (
          <div className="mt-1 truncate text-[10px] leading-relaxed text-[var(--muted-foreground)]" title={sample.snippet}>
            {sample.snippet}
          </div>
        )}
      </div>
      <div className={rowActionGroupClassName}>
        <button
          type="button"
          onClick={onImport}
          disabled={disabled || importing}
          className={cn(
            rowActionButtonClassName,
            "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/85",
          )}
          aria-label={`Import ${sample.title}`}
          title="Import"
        >
          {importing ? <Loader2 size="0.875rem" className="animate-spin" /> : <Import size="0.875rem" />}
        </button>
      </div>
    </article>
  );
}
