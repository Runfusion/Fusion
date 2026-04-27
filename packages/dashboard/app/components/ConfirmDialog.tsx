import { useEffect, useRef } from "react";
import type { ConfirmOptions } from "../hooks/useConfirm";
import "./ConfirmDialog.css";

export interface ConfirmDialogProps {
  isOpen: boolean;
  options: ConfirmOptions | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ isOpen, options, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    cancelButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen || !options) {
    return null;
  }

  return (
    <div className="modal-overlay open" onClick={onCancel}>
      <div
        className="modal confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
      >
        <div className="modal-header">
          <h3>{options.title}</h3>
          <button className="modal-close" onClick={onCancel} aria-label="Close confirmation dialog">
            &times;
          </button>
        </div>

        <div className="confirm-dialog__body">{options.message}</div>

        <div className="modal-actions confirm-dialog__actions">
          <button ref={cancelButtonRef} className="btn" onClick={onCancel}>
            {options.cancelLabel ?? "Cancel"}
          </button>
          <button className={`btn ${options.danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {options.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
