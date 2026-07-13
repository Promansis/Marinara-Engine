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
      className={cn("mari-chrome-segmented !flex w-full overflow-x-auto", className)}
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
              "mari-chrome-segmented__button min-w-[5.5rem] flex-1 whitespace-nowrap px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)] disabled:cursor-not-allowed disabled:opacity-45",
              selected && "mari-chrome-segmented__button--selected",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
