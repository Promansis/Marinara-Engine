import { useRef } from "react";

import { cn } from "../../lib/utils";

export type LtmTabItem<T extends string> = {
  id: T;
  label: string;
  disabled?: boolean;
};

export function LtmTabRail<T extends string>({
  tabs,
  activeId,
  onChange,
  ariaLabel,
  idPrefix,
  className,
}: {
  tabs: readonly LtmTabItem<T>[];
  activeId: T;
  onChange: (id: T) => void | boolean | Promise<void | boolean>;
  ariaLabel: string;
  idPrefix: string;
  className?: string;
}) {
  const buttonRefs = useRef(new Map<T, HTMLButtonElement>());
  const enabledTabs = tabs.filter((tab) => !tab.disabled);

  const selectTab = async (id: T) => {
    const changed = await onChange(id);
    if (changed === false) return;
    requestAnimationFrame(() => buttonRefs.current.get(id)?.focus());
  };

  const selectRelativeTab = (currentId: T, delta: number) => {
    const currentIndex = enabledTabs.findIndex((tab) => tab.id === currentId);
    if (currentIndex < 0 || enabledTabs.length === 0) return;
    const next = enabledTabs[(currentIndex + delta + enabledTabs.length) % enabledTabs.length];
    void selectTab(next.id);
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("flex w-full overflow-x-auto border-b border-[var(--border)] [scrollbar-width:thin]", className)}
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) buttonRefs.current.set(tab.id, node);
              else buttonRefs.current.delete(tab.id);
            }}
            id={`${idPrefix}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => void selectTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                selectRelativeTab(tab.id, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                selectRelativeTab(tab.id, -1);
              } else if (event.key === "Home" && enabledTabs[0]) {
                event.preventDefault();
                void selectTab(enabledTabs[0].id);
              } else if (event.key === "End" && enabledTabs.at(-1)) {
                event.preventDefault();
                const last = enabledTabs.at(-1)!;
                void selectTab(last.id);
              }
            }}
            className={cn(
              "relative min-h-10 min-w-[5.5rem] shrink-0 whitespace-nowrap px-3 py-2.5 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-45",
              selected && "text-[var(--foreground)]",
            )}
          >
            {tab.label}
            {selected && (
              <span aria-hidden="true" className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-[var(--primary)]" />
            )}
          </button>
        );
      })}
    </div>
  );
}
