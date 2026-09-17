import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { PanelsTopLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDashboardWindowVisibility } from "../context/DashboardWindowManagerContext";
import { useViewportMode } from "../hooks/useViewportMode";
import "./DashboardWindowVisibilityToggle.css";

const PORTAL_ROOT_ID = "dashboard-window-toggle-root";

interface PlaceholderRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function sameRect(left: PlaceholderRect | null, right: PlaceholderRect): boolean {
  return left?.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height;
}

/*
FNXC:DashboardWindowVisibility 2026-09-14-10:52:
The window visibility control reserves the footer's final flex slot but portals its interactive button into a dedicated body layer above the live window/plugin ceiling. Only the aligned button accepts pointer events; the remainder of the layer stays click-through so global hiding cannot expose unrelated footer controls through a modal.
*/
export function DashboardWindowVisibilityToggle() {
  const { t } = useTranslation("app");
  const viewportMode = useViewportMode();
  const controller = useDashboardWindowVisibility();
  const placeholderRef = useRef<HTMLSpanElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [rect, setRect] = useState<PlaceholderRect | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);

  const measure = useCallback(() => {
    frameRef.current = null;
    const placeholder = placeholderRef.current;
    if (!placeholder?.isConnected) {
      setRect(null);
      return;
    }
    const next = placeholder.getBoundingClientRect();
    if (![next.left, next.top, next.width, next.height].every(Number.isFinite)) {
      setRect(null);
      return;
    }
    const normalized = { left: next.left, top: next.top, width: next.width, height: next.height };
    setRect((current) => sameRect(current, normalized) ? current : normalized);
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(measure);
  }, [measure]);

  useLayoutEffect(() => {
    if (typeof document === "undefined" || viewportMode === "mobile") return;
    let host = document.getElementById(PORTAL_ROOT_ID);
    let ownsHost = false;
    if (!host) {
      host = document.createElement("div");
      host.id = PORTAL_ROOT_ID;
      document.body.appendChild(host);
      ownsHost = true;
    }
    setPortalHost(host);
    scheduleMeasure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    if (placeholderRef.current) observer?.observe(placeholderRef.current);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      setPortalHost(null);
      if (ownsHost) host?.remove();
    };
  }, [scheduleMeasure, viewportMode]);

  if (viewportMode === "mobile") return null;

  const hidden = controller?.hiddenSnapshotActive ?? false;
  const disabled = !controller || (!hidden && controller.visibleSurfaceCount === 0);
  const label = hidden
    ? t("windows.restore", "Restore windows")
    : t("windows.hide", "Hide all windows");
  const buttonStyle = rect ? ({
    "--dashboard-window-toggle-left": `${rect.left}px`,
    "--dashboard-window-toggle-top": `${rect.top}px`,
    "--dashboard-window-toggle-width": `${rect.width}px`,
    "--dashboard-window-toggle-height": `${rect.height}px`,
  } as CSSProperties) : undefined;

  return (
    <>
      <span
        ref={placeholderRef}
        className="dashboard-window-visibility-toggle__placeholder"
        aria-hidden="true"
        data-testid="dashboard-window-visibility-placeholder"
      />
      {portalHost && rect ? createPortal(
        <button
          ref={controller?.toggleControlRef}
          type="button"
          className="btn-icon dashboard-window-visibility-toggle__button"
          style={buttonStyle}
          aria-label={label}
          aria-pressed={hidden}
          disabled={disabled}
          onClick={controller?.toggleVisibility}
          data-testid="dashboard-window-visibility-toggle"
        >
          <PanelsTopLeft aria-hidden="true" />
        </button>,
        portalHost,
      ) : null}
    </>
  );
}
