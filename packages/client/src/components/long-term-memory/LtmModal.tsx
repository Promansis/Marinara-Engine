import { useCallback, useEffect, useRef, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

import { Modal } from "../ui/Modal";

const openLtmModals: symbol[] = [];

interface LtmModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  contentRef?: Ref<HTMLDivElement>;
  contentClassName?: string;
}

export function LtmModal({ open, onClose, title, children, width, contentRef, contentClassName }: LtmModalProps) {
  const modalId = useRef(Symbol(title));

  useEffect(() => {
    const id = modalId.current;
    const removeFromStack = () => {
      const index = openLtmModals.lastIndexOf(id);
      if (index >= 0) openLtmModals.splice(index, 1);
    };

    removeFromStack();
    if (open) openLtmModals.push(id);
    return removeFromStack;
  }, [open]);

  const closeIfTopmost = useCallback(() => {
    if (openLtmModals.at(-1) === modalId.current) onClose();
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <Modal
      open={open}
      onClose={closeIfTopmost}
      title={title}
      width={width}
      contentRef={contentRef}
      contentClassName={contentClassName}
      mobileFullscreen
    >
      {children}
    </Modal>,
    document.body,
  );
}
