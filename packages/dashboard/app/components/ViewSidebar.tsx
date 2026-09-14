import {
  useEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { VIEW_SIDEBAR_DEFAULT_WIDTH } from "../context/ViewLayoutContext";
import { useViewSidebarWidth, type UseViewSidebarWidthOptions } from "../hooks/useViewSidebarWidth";
import { useViewportMode } from "../hooks/useViewportMode";
import "./ViewSidebar.css";

const VIEW_SIDEBAR_KEYBOARD_STEP = 16;

type ActiveResize = {
  pointerId: number;
  startX: number;
  startWidth: number;
  latestWidth: number;
  scopeIdentity: string;
  hostIdentity: string;
  handle: HTMLElement;
  previousUserSelect: string;
  cleanup: (restorePreview: boolean) => void;
};

export interface ViewSidebarProps extends Omit<HTMLAttributes<HTMLElement>, "children">, UseViewSidebarWidthOptions {
  children: ReactNode;
  ariaLabel: string;
  resizeLabel?: string;
  resizable?: boolean;
  /** Distinguishes two hosts that can reuse the same mounted collection controller. */
  hostIdentity?: string;
  /** Test/bridge override; ordinary views use the canonical viewport classifier. */
  mobile?: boolean;
  panelTestId?: string;
  panelClassName?: string;
  separatorTestId?: string;
}

/*
FNXC:StandardizedViewSidebar 2026-09-13-16:12:
Every full dashboard destination uses this controlled collection rail and separator. Pointer and keyboard resize share one preference authority; cancellation, host/project replacement, unmount, and phone transition release capture/listeners without committing a stale gesture.
*/
export function ViewSidebar({
  children,
  ariaLabel,
  resizeLabel = "Resize sidebar",
  resizable = true,
  hostIdentity = "default",
  mobile: mobileOverride,
  hostMinWidth,
  hostMaxWidth,
  className,
  panelClassName,
  panelTestId,
  separatorTestId = "view-sidebar-resize-handle",
  ...asideProps
}: ViewSidebarProps) {
  const viewportMode = useViewportMode();
  const mobile = mobileOverride ?? viewportMode === "mobile";
  const controller = useViewSidebarWidth({ hostMinWidth, hostMaxWidth });
  const activeResizeRef = useRef<ActiveResize | null>(null);
  const liveRef = useRef({
    mobile,
    hostIdentity,
    scopeIdentity: controller.scopeIdentity,
    previewWidth: controller.previewWidth,
    commitWidth: controller.commitWidth,
  });
  liveRef.current = {
    mobile,
    hostIdentity,
    scopeIdentity: controller.scopeIdentity,
    previewWidth: controller.previewWidth,
    commitWidth: controller.commitWidth,
  };

  useEffect(() => {
    const active = activeResizeRef.current;
    if (!active) return;
    const restorePreview = liveRef.current.scopeIdentity === active.scopeIdentity;
    active.cleanup(restorePreview);
  }, [controller.scopeIdentity, hostIdentity, mobile]);

  useEffect(() => () => {
    activeResizeRef.current?.cleanup(false);
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mobile || !resizable || activeResizeRef.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const active: ActiveResize = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: controller.width,
      latestWidth: controller.width,
      scopeIdentity: controller.scopeIdentity,
      hostIdentity,
      handle,
      previousUserSelect: document.body.style.userSelect,
      cleanup: () => {},
    };

    const stillOwnsHost = () => {
      const live = liveRef.current;
      return !live.mobile
        && live.scopeIdentity === active.scopeIdentity
        && live.hostIdentity === active.hostIdentity;
    };
    const release = () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleEnd);
      document.removeEventListener("pointercancel", handleCancel);
      document.body.style.userSelect = active.previousUserSelect;
      if (typeof active.handle.releasePointerCapture === "function") {
        try {
          active.handle.releasePointerCapture(active.pointerId);
        } catch {
          // FNXC:StandardizedViewSidebar 2026-09-13-16:12: Losing capture during a responsive transition is already a completed cancellation.
        }
      }
      if (activeResizeRef.current === active) activeResizeRef.current = null;
    };
    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== active.pointerId) return;
      if (!stillOwnsHost()) {
        release();
        return;
      }
      moveEvent.preventDefault();
      active.latestWidth = liveRef.current.previewWidth(active.startWidth + moveEvent.clientX - active.startX);
    };
    const handleEnd = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== active.pointerId) return;
      const ownsHost = stillOwnsHost();
      release();
      if (ownsHost) liveRef.current.commitWidth(active.latestWidth);
    };
    const handleCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== active.pointerId) return;
      const ownsHost = stillOwnsHost();
      release();
      if (ownsHost) liveRef.current.previewWidth(active.startWidth);
    };
    active.cleanup = (restorePreview) => {
      release();
      if (restorePreview) liveRef.current.previewWidth(active.startWidth);
    };

    activeResizeRef.current = active;
    document.body.style.userSelect = "none";
    handle.setPointerCapture?.(event.pointerId);
    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleEnd);
    document.addEventListener("pointercancel", handleCancel);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (mobile || !resizable) return;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = controller.width - VIEW_SIDEBAR_KEYBOARD_STEP;
    if (event.key === "ArrowRight") next = controller.width + VIEW_SIDEBAR_KEYBOARD_STEP;
    if (event.key === "Home") next = controller.minWidth;
    if (event.key === "End") next = controller.maxWidth;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    controller.commitWidth(next);
  };

  const style = {
    "--view-sidebar-current-width": `${controller.width}px`,
  } as CSSProperties;

  return (
    <div
      className={["view-sidebar", mobile ? "view-sidebar--mobile" : "", className].filter(Boolean).join(" ")}
      style={style}
      data-view-sidebar-width={controller.width}
      data-view-sidebar-scope={controller.scopeIdentity}
    >
      <aside {...asideProps} className={["view-sidebar__panel", panelClassName].filter(Boolean).join(" ")} aria-label={ariaLabel} data-testid={panelTestId}>
        {children}
      </aside>
      {!mobile && resizable ? (
        <div
          className="view-sidebar__separator"
          role="separator"
          aria-orientation="vertical"
          aria-label={resizeLabel}
          aria-valuemin={controller.minWidth}
          aria-valuemax={controller.maxWidth}
          aria-valuenow={Math.round(controller.width)}
          tabIndex={0}
          data-testid={separatorTestId}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
          onDoubleClick={() => controller.commitWidth(VIEW_SIDEBAR_DEFAULT_WIDTH)}
        />
      ) : null}
    </div>
  );
}
