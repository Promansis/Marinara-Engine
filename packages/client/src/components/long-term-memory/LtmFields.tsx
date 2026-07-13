import type { ReactNode } from "react";
import { HelpTooltip } from "../ui/HelpTooltip";

export const microLabelClassName =
  "text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]";

export const helperTextClassName = "text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]";

export const sectionCardClassName = "rounded-xl border border-[var(--border)] bg-[var(--secondary)]/25 p-3";

export const insetSectionCardClassName = "rounded-lg border border-[var(--border)]/80 bg-[var(--background)]/55 p-3";

export const modalIntroCardClassName = "rounded-xl bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]";

export const panelIntroCardClassName =
  "overflow-hidden rounded-xl bg-[var(--secondary)]/25 p-3 ring-1 ring-[var(--border)]";

export const listRowClassName =
  "rounded-lg p-2.5 transition-[background-color,box-shadow] hover:bg-[var(--marinara-chat-chrome-highlight-bg)]";

export const selectedListRowClassName =
  "bg-[var(--marinara-chat-chrome-highlight-bg)] ring-1 ring-[var(--marinara-chat-chrome-button-border-active)]";

export const emptyStateClassName =
  "rounded-xl border border-dashed border-[var(--border)] bg-[var(--secondary)]/20 p-4 text-center text-xs text-[var(--muted-foreground)]";

export const actionRowClassName = "flex flex-wrap items-center gap-2 border-t border-[var(--border)]/60 pt-4";

export function SettingInfoLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="min-w-0">{label}</span>
      <HelpTooltip text={help} />
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

export const inputClassName = "mari-chrome-field w-full px-3 py-2 text-sm";

export const compactInputClassName = "mari-chrome-field w-full px-3 py-2 text-sm";

export const textareaClassName = "mari-chrome-field min-h-24 w-full resize-y px-3 py-2 text-sm";
