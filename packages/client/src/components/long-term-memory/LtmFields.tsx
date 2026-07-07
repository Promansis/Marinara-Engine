import type { ReactNode } from "react";
import { Info } from "lucide-react";

export const microLabelClassName =
  "text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]";

export const helperTextClassName = "text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]";

export const sectionCardClassName =
  "rounded-xl bg-[var(--secondary)]/35 p-3 shadow-sm ring-1 ring-[var(--border)]";

export const insetSectionCardClassName =
  "rounded-xl bg-[var(--background)]/70 p-3 shadow-inner ring-1 ring-[var(--border)]/80";

export const modalIntroCardClassName =
  "rounded-xl bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]";

export const panelIntroCardClassName =
  "overflow-hidden rounded-xl bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]";

export const listRowClassName =
  "rounded-lg bg-[var(--card)]/70 p-3 ring-1 ring-[var(--border)] transition-[background-color,box-shadow] hover:bg-[var(--accent)]/25 hover:ring-[var(--ring)]/25";

export const selectedListRowClassName = "bg-[var(--accent)]/45 ring-[var(--ring)]/35";

export const emptyStateClassName =
  "rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/20 p-4 text-center text-xs text-[var(--muted-foreground)]";

export const actionRowClassName = "flex flex-wrap items-center gap-2 border-t border-[var(--border)]/60 pt-4";

export function SettingInfoLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="min-w-0">{label}</span>
      <button
        type="button"
        title={help}
        aria-label={`${label}: ${help}`}
        onClick={(event) => event.preventDefault()}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60"
      >
        <Info size="0.7rem" />
      </button>
    </span>
  );
}

export function SettingField({ label, children }: { label: ReactNode; children: ReactNode }) {
  if (typeof label === "string") {
    return (
      <label className="block">
        <span className={`mb-1.5 block ${microLabelClassName}`}>{label}</span>
        {children}
      </label>
    );
  }

  return (
    <div className="block">
      <div className={`mb-1.5 block ${microLabelClassName}`}>{label}</div>
      {children}
    </div>
  );
}

export const inputClassName =
  "w-full rounded-xl bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] shadow-sm outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/60 transition-[border-color,box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60";

export const compactInputClassName =
  "w-full rounded-lg bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] shadow-sm outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/60 transition-[border-color,box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60";

export const textareaClassName =
  "min-h-24 w-full resize-y rounded-xl bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] shadow-sm outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/60 transition-[border-color,box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60";
