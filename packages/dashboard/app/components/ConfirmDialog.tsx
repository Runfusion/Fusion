import { ViewHeader } from "./ViewHeader";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ConfirmOptions } from "../hooks/useConfirm";
import "./ConfirmDialog.css";
import { FloatingWindow } from "./FloatingWindow";

const OPENING_GESTURE_SETTLE_MS = 500;

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
  selectValue?: string;
  onSelectChange?: (next: string) => void;
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
  selectValue,
  onSelectChange,
}: ConfirmDialogProps) {
  const { t } = useTranslation("app");
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  /*
  FNXC:Confirm 2026-06-23-01:30:
  The confirm dialog (e.g. the "discard changes" prompt when cancelling New Task) MUST sit above the floating modal stack.

  FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
  FN-394 hosts the confirmation in the shared FloatingWindow, which owns the body portal and claims the top of
  the shared floating stack on every open. It stays a BLOCKING window (`modal`), so a confirmation raised from a
  snapped or maximized window still covers it and still requires an explicit decision; snapping never confirms
  or abandons anything implicitly.
  */
  const backdropPressStartedHereRef = useRef(false);
  const backdropPressStartedAtRef = useRef(0);
  const openedAtRef = useRef(0);
  useEffect(() => {
    if (isOpen) {
      openedAtRef.current = Date.now();
      backdropPressStartedHereRef.current = false;
      backdropPressStartedAtRef.current = 0;
    }
  }, [isOpen]);

  /*
  FNXC:Confirm 2026-07-16-10:00:
  A confirm opened from a task delete must remain visible until an explicit user
  action. The trigger's trailing click can reach this newly portaled backdrop,
  so outside-dismiss is valid only after a press that began on the backdrop.

  FNXC:Confirm 2026-07-17-00:15 (FN-8192):
  Mobile touch activation may emit a delayed touch-to-mouse compatibility burst
  after the confirm portal mounts. Its synthetic mousedown starts on the
  backdrop and defeats the press-origin guard, so only accept backdrop dismissal
  when that press began after the opening gesture settle window. This uses stored
  timestamps rather than a timer and preserves deliberate post-open dismissal.
  */
  const recordBackdropPress = (event: React.SyntheticEvent<HTMLDivElement>) => {
    const startedOnBackdrop = event.target === event.currentTarget;
    backdropPressStartedHereRef.current = startedOnBackdrop;
    backdropPressStartedAtRef.current = startedOnBackdrop ? Date.now() : 0;
  };

  const dismissFromBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const startedOnBackdrop = backdropPressStartedHereRef.current;
    const pressStartedAt = backdropPressStartedAtRef.current;
    backdropPressStartedHereRef.current = false;
    backdropPressStartedAtRef.current = 0;
    const wasPostOpenPress = pressStartedAt - openedAtRef.current >= OPENING_GESTURE_SETTLE_MS;
    if (startedOnBackdrop && wasPostOpenPress && event.target === event.currentTarget) {
      onCancel();
    }
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    cancelButtonRef.current?.focus();
  }, [isOpen]);

  if (!isOpen || !options) {
    return null;
  }

  return (
    <FloatingWindow
      windowKey="confirm-dialog"
      modal
      hideHeader
      surfaceGroup="dialog"
      title={options.title}
      ariaLabel={options.title}
      onClose={onCancel}
      dragHandleSelector=".confirm-dialog .modal-header"
      className="floating-window--dialog floating-window--confirm"
      overlayClassName="confirm-dialog-overlay"
      defaultSize={{ width: 520, height: 320 }}
      minSize={{ width: 320, height: 200 }}
      suspendGeometryPersistenceOnMobile
      suspendGeometryPersistenceOnShortViewport
      backdropMouseHandlers={{ onMouseDown: recordBackdropPress, onClick: dismissFromBackdropClick }}
    >
      <div
        className="modal confirm-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        {/* FNXC:StandardizedViewLayout 2026-09-13-21:49: Shared chrome for the global confirmation; cancel remains its only close semantics. */}
        <ViewHeader
          className="modal-header"
          headingLevel={3}
          title={options.title}
          onClose={onCancel}
          closeButtonProps={{ "aria-label": t("confirm.closeDialog", "Close confirmation dialog") }}
        />

        <div className="confirm-dialog__body">{options.message}</div>

        {options.select ? (
          <div className="confirm-dialog__select">
            <label htmlFor="confirm-dialog-select">{options.select.label}</label>
            <select
              id="confirm-dialog-select"
              className="select"
              data-testid="confirm-dialog-select"
              value={selectValue}
              onChange={(event) => onSelectChange?.(event.target.value)}
            >
              {options.select.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        ) : null}

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
    </FloatingWindow>
  );
}
