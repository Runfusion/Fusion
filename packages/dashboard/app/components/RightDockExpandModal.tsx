import { useEffect, useRef, type RefObject } from "react";
import { Maximize2, X } from "lucide-react";
import { findOverflowViewEntry, type OverflowViewEntry, type OverflowViewKey, type OverflowViewRenderProps, type OverflowViewVisibilityOptions } from "./overflowViewRegistry";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import "./RightDock.css";

const RIGHT_DOCK_EXPAND_MODAL_SIZE_STORAGE_KEY = "fusion:right-dock-expand-modal-size";

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
*/
export function RightDockExpandModal({
  viewKey,
  renderProps,
  visibilityOptions = {},
  onClose,
  returnFocusRef,
}: RightDockExpandModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const resolvedEntry = viewKey ? findOverflowViewEntry(viewKey, visibilityOptions) : undefined;
  const entry: RenderableOverflowViewEntry | undefined = resolvedEntry?.render ? { ...resolvedEntry, render: resolvedEntry.render } : undefined;
  const closeAndRestoreFocus = () => {
    onClose();
    window.setTimeout(() => returnFocusRef?.current?.focus(), 0);
  };
  const overlayDismissProps = useOverlayDismiss(closeAndRestoreFocus);
  useModalResizePersist(modalRef, Boolean(entry), RIGHT_DOCK_EXPAND_MODAL_SIZE_STORAGE_KEY);

  useEffect(() => {
    if (entry) return undefined;
    return () => {
      returnFocusRef?.current?.focus();
    };
  }, [entry, returnFocusRef]);

  if (!entry) {
    return null;
  }

  const Icon = entry.icon;

  return (
    <div className="modal-overlay open" {...overlayDismissProps} role="dialog" aria-modal="true" aria-label={`${entry.label} expanded`} data-testid="right-dock-expand-modal">
      <div className="modal right-dock-expand-modal" ref={modalRef}>
        <div className="modal-header right-dock-expand-modal__header">
          <div className="right-dock-expand-modal__title">
            <Maximize2 size={16} />
            <Icon size={16} />
            <span>{entry.label}</span>
          </div>
          <button className="modal-close" onClick={closeAndRestoreFocus} aria-label="Close expanded right dock view" data-testid="right-dock-expand-close">
            <X size={20} />
          </button>
        </div>
        {/*
        FNXC:RightDockFiles 2026-06-22-15:00:
        Tag the render props with `surface="expand"` so registry entries (notably Files) deterministically choose their pop-out layout instead of guessing from a measured container width. DockFilesView reads this to force its LEFT|RIGHT two-pane layout.
        */}
        <div className="right-dock-expand-modal__body" data-testid="right-dock-expand-body">
          {entry.render({ ...renderProps, surface: "expand" })}
        </div>
      </div>
    </div>
  );
}
