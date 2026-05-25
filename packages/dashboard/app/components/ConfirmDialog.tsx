import { useEffect, useRef } from "react";
import type { ConfirmOptions } from "../hooks/useConfirm";
import "./ConfirmDialog.css";

export interface ConfirmDialogProps {
  isOpen: boolean;
  options: ConfirmOptions | null;
  onConfirm: () => void;
  onTertiary?: () => void;
  onCancel: () => void;
  checkboxLabel?: string;
  checkboxDescription?: string;
  checkboxChecked?: boolean;
  onCheckboxChange?: (next: boolean) => void;
}

export function ConfirmDialog({
  isOpen,
  options,
  onConfirm,
  onTertiary,
  onCancel,
  checkboxLabel,
  checkboxDescription,
  checkboxChecked = false,
  onCheckboxChange,
}: ConfirmDialogProps) {
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
    <div className="modal-overlay open confirm-dialog-overlay" onClick={onCancel}>
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

        {checkboxLabel ? (
          <label className="checkbox-label confirm-dialog__checkbox">
            <input
              type="checkbox"
              checked={checkboxChecked}
              onChange={(event) => onCheckboxChange?.(event.target.checked)}
            />
            <span>{checkboxLabel}</span>
            {checkboxDescription ? <small className="confirm-dialog__checkbox-description">{checkboxDescription}</small> : null}
          </label>
        ) : null}

        <div className="modal-actions confirm-dialog__actions">
          <button ref={cancelButtonRef} className="btn" onClick={onCancel}>
            {options.cancelLabel ?? "Cancel"}
          </button>
          {options.tertiaryLabel && onTertiary ? (
            <button className={`btn ${options.tertiaryDanger ? "btn-danger" : ""}`.trim()} onClick={onTertiary}>
              {options.tertiaryLabel}
            </button>
          ) : null}
          <button className={`btn ${options.danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {options.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
