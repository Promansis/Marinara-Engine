import { Modal } from "../ui/Modal";
import { helperTextClassName, modalIntroCardClassName, sectionCardClassName } from "./LtmFields";

export function LongTermMemoryWorkbenchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="LTM Workbench" width="max-w-4xl">
      <div className="space-y-4">
        <div className={modalIntroCardClassName}>
          <div className="text-sm font-semibold text-[var(--foreground)]">Workbench</div>
          <p className={`mt-2 ${helperTextClassName}`}>
            This space is reserved for deeper memory tooling that does not fit the regular panel tabs.
          </p>
        </div>
        <div className={`${sectionCardClassName} border border-dashed text-center`}>
          <p className="text-sm text-[var(--muted-foreground)]">LTM Workbench, coming soon.</p>
        </div>
      </div>
    </Modal>
  );
}
