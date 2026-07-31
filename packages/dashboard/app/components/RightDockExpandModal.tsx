import { useCallback, useEffect, type RefObject } from "react";
import { Maximize2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FloatingWindow } from "./FloatingWindow";
import { findOverflowViewEntry, type OverflowViewEntry, type OverflowViewKey, type OverflowViewRenderProps, type OverflowViewVisibilityOptions } from "./overflowViewRegistry";
import "./RightDock.css";

const EXPAND_DEFAULT_WIDTH = 960;
const EXPAND_DEFAULT_HEIGHT = 600;
const EXPAND_MIN_WIDTH = 360;
const EXPAND_MIN_HEIGHT = 280;

type RenderableOverflowViewEntry = OverflowViewEntry & Required<Pick<OverflowViewEntry, "render">>;

export interface RightDockExpandModalProps {
  viewKey: OverflowViewKey | null;
  renderProps: OverflowViewRenderProps;
  visibilityOptions?: OverflowViewVisibilityOptions;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/*
FNXC:Navigation 2026-06-21-00:00:
Expanded right-dock views reuse the same overflow registry render function as the dock body, so expanding changes only available space and never swaps to a divergent component or prop contract.

FNXC:Navigation 2026-06-21-20:16:
FN-6882 makes most right-dock entries launcher actions. The expand modal is restricted to inline view entries so action-only tools cannot open an empty modal body.

FNXC:i18n 2026-06-22-00:00:
Expanded right-dock modal affordance labels are accessibility copy and must use the app namespace so locale catalogs and fallback tests cover the modal surface with the dock controls.
*/
export function RightDockExpandModal({
  viewKey,
  renderProps,
  visibilityOptions = {},
  onClose,
  returnFocusRef,
}: RightDockExpandModalProps) {
  const { t } = useTranslation("app");
  const resolvedEntry = viewKey ? findOverflowViewEntry(viewKey, visibilityOptions) : undefined;
  const entry: RenderableOverflowViewEntry | undefined = resolvedEntry?.render ? { ...resolvedEntry, render: resolvedEntry.render } : undefined;

  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    window.setTimeout(() => returnFocusRef?.current?.focus(), 0);
  }, [onClose, returnFocusRef]);

  useEffect(() => {
    if (entry) return undefined;
    return () => {
      returnFocusRef?.current?.focus();
    };
  }, [entry, returnFocusRef]);

  if (!entry) return null;

  const Icon = entry.icon;
  const expandedViewLabel = t("rightDock.viewExpanded", "{{label}} expanded", { label: entry.label });

  /*
  FNXC:ModalTouchGeometry 2026-07-27-17:00:
  FN-8620 replaces this pop-out's duplicate captured-pointer geometry engine with FloatingWindow.
  Its custom header stays the delegated drag surface, while the shared host owns clamping, stack
  claims, tablet touch targets, and teardown. The old size/position key pair intentionally resets
  once to this single geometry record.
  */
  return (
    <FloatingWindow
      title={expandedViewLabel}
      onClose={closeAndRestoreFocus}
      windowKey="right-dock-expand"
      defaultSize={{ width: EXPAND_DEFAULT_WIDTH, height: EXPAND_DEFAULT_HEIGHT }}
      minSize={{ width: EXPAND_MIN_WIDTH, height: EXPAND_MIN_HEIGHT }}
      hideHeader
      dragHandleSelector=".right-dock-expand-modal__header"
      persistGeometryKey="fusion:right-dock-expand-modal-geometry"
      suspendGeometryPersistenceOnMobile
      suspendGeometryPersistenceOnShortViewport
      ariaLabel={expandedViewLabel}
      className="modal right-dock-expand-modal right-dock-expand-modal--floating"
      testId="right-dock-expand-modal"
    >
      <div
        className="modal-header right-dock-expand-modal__header right-dock-expand-modal__header--draggable"
        data-testid="right-dock-expand-drag-handle"
      >
        <div className="right-dock-expand-modal__title">
          <Maximize2 size={16} />
          <Icon size={16} />
          <span>{entry.label}</span>
        </div>
        <button className="modal-close" onClick={closeAndRestoreFocus} aria-label={t("rightDock.closeExpandedView", "Close expanded right dock view")} data-testid="right-dock-expand-close">
          <X size={20} />
        </button>
      </div>
      <div className="right-dock-expand-modal__body" data-testid="right-dock-expand-body">
        {entry.render({ ...renderProps, surface: "expand" })}
      </div>
    </FloatingWindow>
  );
}
