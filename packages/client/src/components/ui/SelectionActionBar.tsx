import type { ReactNode } from "react";
import { Trash2, Upload } from "lucide-react";
import { cn } from "../../lib/utils";

export type SelectionActionBarAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
  ariaLabel?: string;
  title?: string;
};

interface SelectionActionBarProps {
  selectedCount: number;
  onExport?: () => void;
  onDelete?: () => void;
  exportDisabled?: boolean;
  deleteDisabled?: boolean;
  exporting?: boolean;
  actions?: SelectionActionBarAction[];
  leading?: ReactNode;
  placement?: "sticky" | "panel";
  className?: string;
}

export function SelectionActionBar({
  selectedCount,
  onExport,
  onDelete,
  exportDisabled = false,
  deleteDisabled = false,
  exporting = false,
  actions,
  leading,
  placement = "sticky",
  className,
}: SelectionActionBarProps) {
  const isPanelFooter = placement === "panel";
  const legacyActions: SelectionActionBarAction[] = [
    {
      id: "export",
      label: "Export",
      icon: <Upload size="0.75rem" />,
      onClick: () => onExport?.(),
      disabled: exportDisabled || exporting || !onExport,
    },
    {
      id: "delete",
      label: "Delete",
      icon: <Trash2 size="0.75rem" />,
      onClick: () => onDelete?.(),
      disabled: deleteDisabled || exporting || !onDelete,
      tone: "danger",
    },
  ];
  const renderedActions =
    actions ??
    legacyActions;

  const actionBar = (
    <div
      className={cn(
        isPanelFooter
          ? "mari-selection-action-bar fixed bottom-0 right-0 z-[60] w-[min(var(--mari-right-panel-width,20rem),100vw)] px-3 pb-[calc(0.625rem+env(safe-area-inset-bottom))] pt-2.5"
          : "mari-selection-action-bar sticky bottom-0 z-20 -mx-3 mt-auto px-3 py-2.5",
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-center gap-2 text-center text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
        <span>{selectedCount} selected</span>
        {leading}
      </div>
      <div className="flex flex-wrap gap-2">
        {renderedActions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={action.onClick}
            disabled={selectedCount === 0 || action.disabled}
            aria-label={action.ariaLabel}
            title={action.title}
            className={cn(
              "mari-chrome-control min-w-[7rem] flex-1 px-3 py-2 text-xs",
              action.tone === "primary" && "mari-chrome-control--primary",
              action.tone === "danger" && "mari-chrome-control--danger",
            )}
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  if (isPanelFooter) {
    return (
      <>
        <div aria-hidden="true" className="h-[calc(6rem+env(safe-area-inset-bottom))] shrink-0" />
        {actionBar}
      </>
    );
  }

  return actionBar;
}
