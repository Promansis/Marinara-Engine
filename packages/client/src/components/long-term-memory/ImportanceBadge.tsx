import { IMPORTANCE_LEVELS, type LtmImportance } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";

const toneClassName: Record<LtmImportance, string> = {
  critical: "bg-[var(--destructive)]/15 text-[var(--destructive)] ring-[var(--destructive)]/25",
  major: "bg-[var(--primary)]/15 text-[var(--foreground)] ring-[var(--primary)]/30",
  moderate: "bg-[var(--secondary)]/60 text-[var(--foreground)] ring-[var(--border)]",
  minor: "bg-[var(--background)]/70 text-[var(--muted-foreground)] ring-[var(--border)]",
};

export function ImportanceBadge({
  importance,
  className,
}: {
  importance: LtmImportance;
  className?: string;
}) {
  const level = IMPORTANCE_LEVELS[importance];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ring-1",
        toneClassName[importance],
        className,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      <span>{level.label}</span>
    </span>
  );
}
