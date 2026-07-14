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
      aria-label={title ? `${label}: ${title}` : undefined}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center break-words rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-medium leading-tight",
        tone === "good" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
        tone === "warn" && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200",
        tone === "bad" && "border-[var(--destructive)]/30 bg-[var(--destructive)]/10 text-[var(--destructive)]",
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
  size = "small",
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  tone?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
  size?: "default" | "small";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex max-w-full items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm transition-[background-color,color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45",
        size === "small" ? "min-h-8 py-1.5 max-md:min-h-10" : "min-h-10",
        tone === "secondary" &&
          "border-[var(--border)] bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]",
        tone === "primary" &&
          "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 hover:shadow-md",
        tone === "danger" &&
          "border-[var(--destructive)]/30 bg-transparent text-[var(--destructive)] hover:bg-[var(--destructive)]/10",
      )}
    >
      {children}
    </button>
  );
}
