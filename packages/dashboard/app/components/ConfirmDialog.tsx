import { ViewHeader } from "./ViewHeader";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ConfirmOptions } from "../hooks/useConfirm";
import { nextFloatingZ } from "./floatingWindowStack";
import "./ConfirmDialog.css";
import { useDashboardWindowSurface } from "../context/DashboardWindowManagerContext";

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
  The confirm dialog (e.g. the "discard changes" prompt when cancelling New Task) MUST sit above the floating modal stack. Floating windows (New Task, pop-outs) live at the shared floating z-band (nextFloatingZ) and are portaled to document.body, so a confirm rendered inline at the page .modal-overlay z (~10000) paints BEHIND them. Portal the confirm to body and claim the TOP of the shared stack each time it opens so it always appears over whatever floating window triggered it.
  */
  const [overlayZ, setOverlayZ] = useState<number | undefined>(undefined);
  const backdropPressStartedHereRef = useRef(false);
  const backdropPressStartedAtRef = useRef(0);
  const openedAtRef = useRef(0);
  const windowSurface = useDashboardWindowSurface({
    logicalId: "confirm-dialog",
    group: "dialog",
    locallyVisible: isOpen && Boolean(options),
    stackOrder: overlayZ,
  });
  const surfaceActiveRef = useRef(windowSurface.surfaceActive);
  surfaceActiveRef.current = windowSurface.surfaceActive;
  useLayoutEffect(() => {
    if (isOpen) {
      openedAtRef.current = Date.now();
      backdropPressStartedHereRef.current = false;
      backdropPressStartedAtRef.current = 0;
      setOverlayZ(nextFloatingZ());
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
    if (surfaceActiveRef.current && startedOnBackdrop && wasPostOpenPress && event.target === event.currentTarget) {
      onCancel();
    }
  };

  useEffect(() => {
    if (!isOpen || !surfaceActiveRef.current) {
      return;
    }

    cancelButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (surfaceActiveRef.current && event.key === "Escape") {
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
      ref={windowSurface.rootRef}
      className="modal-overlay open confirm-dialog-overlay"
      aria-hidden={windowSurface.surfaceAttributes["aria-hidden"]}
      inert={windowSurface.surfaceAttributes.inert}
      data-dashboard-window-surface={windowSurface.surfaceAttributes["data-dashboard-window-surface"]}
      data-dashboard-window-globally-hidden={windowSurface.surfaceAttributes["data-dashboard-window-globally-hidden"]}
      onPointerDown={windowSurface.surfaceActive ? recordBackdropPress : undefined}
      onMouseDown={windowSurface.surfaceActive ? recordBackdropPress : undefined}
      onTouchStart={windowSurface.surfaceActive ? recordBackdropPress : undefined}
      onClick={windowSurface.surfaceActive ? dismissFromBackdropClick : undefined}
      style={overlayZ ? { zIndex: overlayZ } : undefined}
    >
      <div
        className="modal confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
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
    </div>,
    document.body,
  );
}
