import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ConfirmOptions } from "../hooks/useConfirm";
import { nextFloatingZ } from "./floatingWindowStack";
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
  const { t } = useTranslation("app");
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  /*
  FNXC:Confirm 2026-06-23-01:30:
  The confirm dialog (e.g. the "discard changes" prompt when cancelling New Task) MUST sit above the floating modal stack. Floating windows (New Task, pop-outs) live at the shared floating z-band (nextFloatingZ) and are portaled to document.body, so a confirm rendered inline at the page .modal-overlay z (~10000) paints BEHIND them. Portal the confirm to body and claim the TOP of the shared stack each time it opens so it always appears over whatever floating window triggered it.
  */
  const [overlayZ, setOverlayZ] = useState<number | undefined>(undefined);
  const backdropPressStartedHereRef = useRef(false);
  useLayoutEffect(() => {
    if (isOpen) {
      setOverlayZ(nextFloatingZ());
    }
  }, [isOpen]);

  /*
  FNXC:Confirm 2026-07-16-10:00:
  A confirm opened from a task delete must remain visible until an explicit user
  action. The trigger's trailing click can reach this newly portaled backdrop,
  so outside-dismiss is valid only after a press that began on the backdrop.
  */
  const recordBackdropPress = (event: React.SyntheticEvent<HTMLDivElement>) => {
    backdropPressStartedHereRef.current = event.target === event.currentTarget;
  };

  const dismissFromBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const startedOnBackdrop = backdropPressStartedHereRef.current;
    backdropPressStartedHereRef.current = false;
    if (startedOnBackdrop && event.target === event.currentTarget) {
      onCancel();
    }
  };

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

  return createPortal(
    <div
      className="modal-overlay open confirm-dialog-overlay"
      onPointerDown={recordBackdropPress}
      onMouseDown={recordBackdropPress}
      onTouchStart={recordBackdropPress}
      onClick={dismissFromBackdropClick}
      style={overlayZ ? { zIndex: overlayZ } : undefined}
    >
      <div
        className="modal confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
      >
        <div className="modal-header">
          <h3>{options.title}</h3>
          <button className="modal-close" onClick={onCancel} aria-label={t("confirm.closeDialog", "Close confirmation dialog")}>
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
            {options.cancelLabel ?? t("confirm.cancel", "Cancel")}
          </button>
          {options.tertiaryLabel && onTertiary ? (
            <button className={`btn ${options.tertiaryDanger ? "btn-danger" : ""}`.trim()} onClick={onTertiary}>
              {options.tertiaryLabel}
            </button>
          ) : null}
          <button className={`btn ${options.danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {options.confirmLabel ?? t("confirm.confirm", "Confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
