import { useState } from "react";
import { BrainCircuit, ChevronDown, ChevronRight } from "lucide-react";
import { useLastInjection } from "../../hooks/use-long-term-memory";

type Props = {
  chatId: string;
  onViewAll?: () => void;
};

export function MemoryOverviewNotice({ chatId, onViewAll }: Props) {
  const { data, isLoading } = useLastInjection(chatId);
  const [expanded, setExpanded] = useState(false);

  if (isLoading || !data || data.memoryCount === 0) return null;

  const count = data.memoryCount;
  const tokens = data.tokenCount;
  const memories = data.memories;
  const hasMore = memories.length < count;

  return (
    <div className="mb-2 rounded-lg p-2 text-xs ring-1 ring-[var(--border)]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-xs ring-1 ring-[var(--border)] hover:bg-[var(--accent)]"
      >
        <BrainCircuit size="0.75rem" className="text-[var(--primary)]" />
        <span className="min-w-0 flex-1 text-left font-medium text-[var(--foreground)]">
          {count} memor{count === 1 ? "y" : "ies"} · ~{tokens.toLocaleString()} tokens
        </span>
        {expanded ? <ChevronDown size="0.75rem" /> : <ChevronRight size="0.75rem" />}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1">
          {memories.slice(0, 5).map((mem) => (
            <div
              key={mem.noteId}
              className="truncate rounded-md px-2 py-1 text-[0.625rem] text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
              title={mem.title}
            >
              {mem.title}
            </div>
          ))}
          {hasMore && (
            <button
              type="button"
              onClick={onViewAll}
              className="w-full rounded-md px-2 py-1 text-left text-[0.625rem] font-medium text-[var(--primary)] hover:bg-[var(--accent)]"
            >
              View all {count} →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
