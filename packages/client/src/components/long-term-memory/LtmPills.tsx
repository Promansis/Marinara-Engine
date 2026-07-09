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
        "mari-chrome-control max-w-full overflow-hidden whitespace-nowrap text-xs",
        size === "small" ? "mari-chrome-control--small" : tone !== "primary" && "px-3 py-2",
        tone === "primary" && "mari-chrome-control--primary",
        tone === "danger" && "mari-chrome-control--danger",
      )}
    >
      {children}
    </button>
  );
}
