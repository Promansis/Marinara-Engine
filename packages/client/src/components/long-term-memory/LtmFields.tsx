import type { ReactNode } from "react";

export const microLabelClassName =
  "text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]";

export const helperTextClassName = "text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]";

export const sectionCardClassName = "rounded-xl bg-[var(--secondary)]/35 p-3 ring-1 ring-[var(--border)]";

export const insetSectionCardClassName = "rounded-xl bg-[var(--background)]/70 p-3 ring-1 ring-[var(--border)]/80";

export const modalIntroCardClassName = "rounded-xl bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]";

export const actionRowClassName = "flex flex-wrap items-center gap-2 border-t border-[var(--border)]/60 pt-4";

export function SettingField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={`mb-1.5 block ${microLabelClassName}`}>{label}</span>
      {children}
    </label>
  );
}

export const inputClassName =
  "w-full rounded-xl bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] shadow-sm outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/60 transition-[border-color,box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60";

export const compactInputClassName =
  "w-full rounded-lg bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] shadow-sm outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/60 transition-[border-color,box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60";

export const textareaClassName =
  "min-h-24 w-full resize-y rounded-xl bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] shadow-sm outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/60 transition-[border-color,box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60";
