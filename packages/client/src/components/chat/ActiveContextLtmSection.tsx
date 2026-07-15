import { BrainCircuit, FileWarning, ArrowUpRight } from "lucide-react";
import { usePendingDraftsCount, useLastInjection } from "../../hooks/use-long-term-memory";
import { cn } from "../../lib/utils";
import { ROLEPLAY_POPOVER_SUBTITLE, ROLEPLAY_POPOVER_CLOSE_ICON_SIZE } from "./roleplay-popover-styles";

const ITEM_BASE =
  "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[0.625rem] text-[var(--marinara-chat-chrome-panel-muted)] transition-colors";

export function useActiveContextLtmBadge(chatId: string | null | undefined): {
  pendingCount: number;
  hasPending: boolean;
} {
  const { data: pending } = usePendingDraftsCount(
    { chatId: chatId ?? undefined, enabled: !!chatId },
  );
  const pendingCount = pending?.count ?? 0;

  return {
    pendingCount,
    hasPending: pendingCount > 0,
  };
}

export function ActiveContextLtmSection({
  chatId,
  onOpenVault,
}: {
  chatId: string | null | undefined;
  onOpenVault?: () => void;
}) {
  const { data: pending } = usePendingDraftsCount(
    { chatId: chatId ?? undefined, enabled: !!chatId },
  );
  const { data: lastInjection } = useLastInjection(chatId ?? undefined, {
    enabled: !!chatId,
  });

  const pendingCount = pending?.count ?? 0;
  const lastInjectionCount = lastInjection?.memoryCount ?? 0;
  const lastInjectionTokens = lastInjection?.tokenCount ?? 0;

  const hasPending = pendingCount > 0;
  const hasLastInjection = lastInjectionCount > 0;

  if (!hasPending && !hasLastInjection && !onOpenVault) return null;

  return (
    <div className="mt-2 space-y-1.5 border-t border-[var(--border)] pt-2">
      <h4 className={cn(ROLEPLAY_POPOVER_SUBTITLE, "mb-1")}>Long-Term Memory</h4>

      {hasPending && (
        <div className={cn(ITEM_BASE, "hover:bg-amber-500/10")}>
          <FileWarning size={ROLEPLAY_POPOVER_CLOSE_ICON_SIZE} className="shrink-0 text-amber-300" />
          <span className="min-w-0 flex-1 truncate text-amber-100">
            {pendingCount} pending draft{pendingCount === 1 ? "" : "s"}
          </span>
          {onOpenVault && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenVault?.(); }}
              className="shrink-0 rounded px-1 py-0.5 text-[0.5rem] font-semibold text-amber-200 ring-1 ring-amber-400/30 hover:bg-amber-500/15"
            >
              Review
            </button>
          )}
        </div>
      )}

      {hasLastInjection && (
        <div className={cn(ITEM_BASE, "hover:bg-cyan-500/10")}>
          <BrainCircuit size={ROLEPLAY_POPOVER_CLOSE_ICON_SIZE} className="shrink-0 text-cyan-300" />
          <span className="min-w-0 flex-1 truncate text-cyan-100">
            {lastInjectionCount} memor{lastInjectionCount === 1 ? "y" : "ies"} · ~{lastInjectionTokens.toLocaleString()} tokens
          </span>
        </div>
      )}

      {!hasPending && !hasLastInjection && (
        <div className={cn(ITEM_BASE, "hover:bg-white/5")}>
          <BrainCircuit size={ROLEPLAY_POPOVER_CLOSE_ICON_SIZE} className="shrink-0 text-[var(--muted-foreground)]" />
          <span className="min-w-0 flex-1 truncate text-[var(--muted-foreground)]">
            No recent memory activity
          </span>
        </div>
      )}

      {onOpenVault && (
        <div className={cn(ITEM_BASE, "justify-center hover:bg-white/5")} onClick={onOpenVault}>
          <span className="font-medium text-[var(--foreground)]/80">
            Open memory vault
          </span>
          <ArrowUpRight size="0.625rem" className="text-[var(--muted-foreground)]" />
        </div>
      )}
    </div>
  );
}
