import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function StatusPill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight",
        tone === "good" && "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
        tone === "warn" && "border-amber-400/40 bg-amber-500/10 text-amber-200",
        tone === "bad" && "border-rose-400/40 bg-rose-500/10 text-rose-200",
        tone === "neutral" && "border-[var(--border)] bg-[var(--muted)]/40 text-[var(--muted-foreground)]",
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
        "inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50",
        tone === "primary" && "bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90",
        tone === "secondary" &&
          "bg-[var(--secondary)] text-[var(--foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)]",
        tone === "danger" &&
          "bg-[var(--destructive)]/10 text-[var(--destructive)] ring-1 ring-[var(--destructive)]/25 hover:bg-[var(--destructive)]/15",
      )}
    >
      {children}
    </button>
  );
}
