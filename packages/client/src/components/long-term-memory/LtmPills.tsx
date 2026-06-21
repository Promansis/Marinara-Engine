import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function StatusPill({
  label,
  tone = "neutral",
  title,
}: {
  label: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  title?: string;
}) {
  return (
    <span
      title={title ?? label}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center truncate rounded-md border px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight",
        tone === "good" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-200",
        tone === "warn" && "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-200",
        tone === "bad" &&
          "border-[var(--destructive)]/30 bg-[var(--destructive)]/10 text-[var(--destructive)]",
        tone === "neutral" && "border-[var(--border)] bg-[var(--secondary)]/70 text-[var(--muted-foreground)]",
      )}
    >
      {label}
    </span>
  );
}

export function ToolButton({
  onClick,
  disabled,
  children,
  tone = "secondary",
  type = "button",
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  tone?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex min-h-8 max-w-full min-w-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold shadow-sm transition-[background-color,color,box-shadow,transform] hover:shadow-md active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-sm",
        tone === "primary" &&
          "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-sm hover:brightness-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60",
        tone === "secondary" &&
          "bg-[var(--secondary)] text-[var(--foreground)] ring-1 ring-[var(--border)] shadow-sm hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60",
        tone === "danger" &&
          "bg-[var(--destructive)]/10 text-[var(--destructive)] ring-1 ring-[var(--destructive)]/25 shadow-sm hover:bg-[var(--destructive)]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--destructive)]/30",
      )}
    >
      {children}
    </button>
  );
}
