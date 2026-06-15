import { Modal } from "../ui/Modal";

export function LongTermMemoryWorkbenchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="LTM Workbench" width="max-w-4xl">
      <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/25 p-8 text-center">
        <p className="text-sm text-[var(--muted-foreground)]">
          LTM Workbench — coming soon
        </p>
      </div>
    </Modal>
  );
}
