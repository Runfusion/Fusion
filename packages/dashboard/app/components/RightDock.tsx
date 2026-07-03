import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import { ArrowLeft, Maximize2, Pin, PinOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  findOverflowViewEntry,
  getVisibleOverflowViewEntries,
  isOverflowViewKeyVisible,
  type OverflowViewKey,
  type OverflowViewRenderProps,
  type OverflowViewVisibilityOptions,
} from "./overflowViewRegistry";
import "./RightDock.css";

export const RIGHT_DOCK_DEFAULT_WIDTH = 360;
export const RIGHT_DOCK_MIN_WIDTH = 280;
/*
FNXC:RightDock 2026-06-23-00:50:
The right-dock resize cap was raised 720 -> 1280 so the user can drag the dock MUCH wider (e.g. to run the Files view as a true two-pane tree|viewer split). The clamp and the persisted-width read both funnel through clampRightDockWidth/RIGHT_DOCK_MAX_WIDTH, so a single constant governs the drag clamp, the keyboard-step clamp, the stored-width read, and the resize-handle aria-valuemax. The CSS still wraps the rendered width in min(100%, ...), so the dock can never exceed the viewport even at the larger cap.
*/
export const RIGHT_DOCK_MAX_WIDTH = 1280;
export const RIGHT_DOCK_WIDTH_STORAGE_KEY = "fusion:right-dock-width";
export const RIGHT_DOCK_VIEW_STORAGE_KEY = "fusion:right-dock-view";
export const RIGHT_DOCK_OPEN_STORAGE_KEY = "fusion:right-dock-open";
export const RIGHT_DOCK_PINNED_STORAGE_KEY = "fusion:right-dock-pinned";

function clampRightDockWidth(width: number): number {
  return Math.max(RIGHT_DOCK_MIN_WIDTH, Math.min(RIGHT_DOCK_MAX_WIDTH, width));
}

export function readStoredRightDockWidth(): number {
  if (typeof window === "undefined") return RIGHT_DOCK_DEFAULT_WIDTH;
  const stored = window.localStorage.getItem(RIGHT_DOCK_WIDTH_STORAGE_KEY);
  const parsed = stored ? Number(stored) : NaN;
  return Number.isFinite(parsed) ? clampRightDockWidth(parsed) : RIGHT_DOCK_DEFAULT_WIDTH;
}

/*
 * FNXC:Navigation 2026-07-03-09:40:
 * The right dock now defaults to HIDDEN when the operator has no stored preference, so first-run and
 * onboarding land on an uncluttered board rather than the full sidebar. Users opt in via the canonical
 * Header right-sidebar toggle, which persists "true"; an explicit stored "false" also stays hidden.
 * Only an explicit "true" opens it. This replaces the previous visible-by-default behavior at the
 * request of the product owner ("make sure right sidebar isn't shown by default ... on first run").
 */
export function readStoredRightDockOpen(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(RIGHT_DOCK_OPEN_STORAGE_KEY) === "true";
}

export function persistRightDockOpen(open: boolean): void {
  try {
    window.localStorage.setItem(RIGHT_DOCK_OPEN_STORAGE_KEY, String(open));
  } catch {
    // Ignore storage errors.
  }
}

/*
FNXC:RightDockPin 2026-06-27-00:00:
Right-dock push mode is a local, reversible UI preference. Default missing/invalid storage to unpinned so existing overlay behavior remains unchanged, and keep the same SSR-safe localStorage pattern used by the dock open flag.
*/
export function readStoredRightDockPinned(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(RIGHT_DOCK_PINNED_STORAGE_KEY) === "true";
}

export function persistRightDockPinned(pinned: boolean): void {
  try {
    window.localStorage.setItem(RIGHT_DOCK_PINNED_STORAGE_KEY, String(pinned));
  } catch {
    // Ignore storage errors.
  }
}

function isInlineOverflowViewKey(key: string, options: OverflowViewVisibilityOptions): key is OverflowViewKey {
  const entry = findOverflowViewEntry(key as OverflowViewKey, options);
  return Boolean(entry?.render);
}

export function readStoredRightDockView(options: OverflowViewVisibilityOptions): OverflowViewKey {
  if (typeof window === "undefined") return "files";
  const stored = window.localStorage.getItem(RIGHT_DOCK_VIEW_STORAGE_KEY);
  return stored && isOverflowViewKeyVisible(stored, options) && isInlineOverflowViewKey(stored, options) ? stored : "files";
}

function persistRightDockWidth(width: number): void {
  try {
    window.localStorage.setItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Ignore storage errors.
  }
}

function persistRightDockView(key: OverflowViewKey): void {
  try {
    window.localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, key);
  } catch {
    // Ignore storage errors.
  }
}

export interface RightDockProps {
  open: boolean;
  renderProps: OverflowViewRenderProps;
  visibilityOptions?: OverflowViewVisibilityOptions;
  onExpand?: (key: OverflowViewKey) => void;
  footerVisible?: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  dockTask?: Task | TaskDetail | null;
  dockTaskContent?: ReactNode;
  onCloseDockTask?: () => void;
}

/*
FNXC:Navigation 2026-06-21-00:00:
The right dock is an auxiliary tablet/desktop surface: it remembers the last overflow destination, starts on Files when none is valid, and resizes from its left edge without changing the canonical Header/MobileNavBar active navigation state.

FNXC:Navigation 2026-06-21-20:14:
FN-6882 splits right-dock entries into launcher actions and inline views. Action tabs invoke their existing Header handlers without replacing the Files body; only inline entries persist selection or expand into the modal.

FNXC:Navigation 2026-06-22-09:00 (updated 2026-07-03-09:40):
The right dock is HIDDEN by default on tablet/desktop project screens (no stored preference -> closed; see readStoredRightDockOpen) so first-run/onboarding lands on an uncluttered board. Show/hide is owned solely by the canonical Header right-sidebar toggle (the in-dock collapse toggle was removed); the dock takes only `open` and renders null when closed so the main content reclaims the space.

FNXC:i18n 2026-06-22-00:00:
Right-dock affordance labels are user-facing accessibility copy, so route them through the app namespace and keep English defaults colocated with the component for tests and fallback rendering.
*/
export function RightDock({
  open,
  renderProps,
  visibilityOptions = {},
  onExpand,
  footerVisible = false,
  pinned,
  onTogglePin,
  dockTask = null,
  dockTaskContent = null,
  onCloseDockTask,
}: RightDockProps) {
  const { t } = useTranslation("app");
  const entries = useMemo(() => getVisibleOverflowViewEntries(visibilityOptions), [visibilityOptions]);
  const [selectedKey, setSelectedKey] = useState<OverflowViewKey>(() => readStoredRightDockView(visibilityOptions));
  const [width, setWidth] = useState(readStoredRightDockWidth);
  /*
  FNXC:Navigation 2026-06-22-09:00:
  The dock renders null while closed, so a resize drag that is still mid-flight when the dock closes (or the component unmounts) would leave document pointer listeners and a frozen body.userSelect behind. Store the active drag teardown in a ref and run it from an unmount-cleanup effect to plug that leak.
  */
  const resizeTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeTeardownRef.current?.(), []);

  useEffect(() => {
    if (!isOverflowViewKeyVisible(selectedKey, visibilityOptions) || !isInlineOverflowViewKey(selectedKey, visibilityOptions)) {
      setSelectedKey("files");
      persistRightDockView("files");
    }
  }, [selectedKey, visibilityOptions]);

  useEffect(() => {
    if (!dockTask) return;
    /*
    FNXC:RightDockTasks 2026-06-28-16:55:
    Programmatic dock-task opens (for example board-card clicks) land on the dedicated Tasks tab without lifting selectedKey to the controller. Persisting `tasks` restores the same first-class dock surface while keeping the no-storage default as Files.
    */
    setSelectedKey("tasks");
    persistRightDockView("tasks");
  }, [dockTask]);

  const selectedEntry = (findOverflowViewEntry(selectedKey, visibilityOptions)?.render
    ? findOverflowViewEntry(selectedKey, visibilityOptions)
    : findOverflowViewEntry("files", visibilityOptions)) ?? entries.find((entry) => entry.render);

  const selectEntry = useCallback((key: OverflowViewKey) => {
    const entry = findOverflowViewEntry(key, visibilityOptions);
    if (entry?.onActivate) {
      entry.onActivate(renderProps);
      return;
    }
    if (!entry?.render) return;
    /*
    FNXC:RightDockTasks 2026-06-28-16:58:
    Tab switches no longer clear the dock-task snapshot. Detail is anchored to the Tasks tab, so selecting Files/Chat hides the detail while preserving the last-viewed task for when the user returns to Tasks.
    */
    setSelectedKey(key);
    persistRightDockView(key);
  }, [renderProps, visibilityOptions]);

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const resizeHandle = event.currentTarget;
    if (typeof resizeHandle.setPointerCapture === "function") {
      resizeHandle.setPointerCapture(event.pointerId);
    }

    const startX = event.clientX;
    const startWidth = width;
    let latestWidth = startWidth;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampRightDockWidth(startWidth + startX - moveEvent.clientX);
      latestWidth = nextWidth;
      setWidth(nextWidth);
    };

    /*
    FNXC:Navigation 2026-06-22-09:00:
    teardown restores body.userSelect, drops the document pointermove/up/cancel listeners, and persists the final width. It runs on pointerup, pointercancel (touch/pen interruption), and on unmount/dock-close via resizeTeardownRef so listeners never leak.
    */
    const teardown = (upEvent?: PointerEvent) => {
      if (upEvent && typeof resizeHandle.releasePointerCapture === "function") {
        resizeHandle.releasePointerCapture(upEvent.pointerId);
      }
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      resizeTeardownRef.current = null;
      persistRightDockWidth(latestWidth);
    };

    const onPointerUp = (upEvent: PointerEvent) => teardown(upEvent);

    resizeTeardownRef.current = () => teardown();
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
  }, [width]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 16;
    const delta = event.key === "ArrowLeft" ? step : -step;
    const nextWidth = clampRightDockWidth(width + delta);
    setWidth(nextWidth);
    persistRightDockWidth(nextWidth);
  }, [width]);

  if (!selectedEntry) {
    return null;
  }

  /*
  FNXC:Navigation 2026-06-22-00:00:
  The right dock is no longer a persistent rail: when closed it renders nothing so the main content reclaims the space (the shell is flex, so a null dock simply reflows). The Header right-sidebar toggle is the canonical show/hide control.
  */
  if (!open) {
    return null;
  }

  const SelectedIcon = selectedEntry.icon;
  /*
  FNXC:RightDockTasks 2026-06-28-17:00:
  Task detail is visible only on the Tasks tab; other tabs render their own registry bodies while the task snapshot persists in the controller. Back/close clears the snapshot and leaves the selected Tasks body to render the list.
  */
  const showingDockTask = Boolean(dockTask && dockTaskContent && selectedKey === "tasks");
  const dockWidth = `${width}px`;
  const expandSelectedViewLabel = t("rightDock.expandView", "Expand {{label}}", { label: selectedEntry.label });
  const closeDockTaskLabel = t("rightDock.closeTaskDetail", "Back to right dock views");
  const pinLabel = pinned
    ? t("rightDock.unpin", "Unpin sidebar (overlay content)")
    : t("rightDock.pin", "Pin sidebar (push content)");
  const PinIcon = pinned ? PinOff : Pin;

  return (
    <aside
      className={`right-dock${open ? "" : " right-dock--collapsed"}${footerVisible ? " right-dock--with-footer" : ""}${pinned ? " right-dock--pinned" : ""}`}
      style={dockWidth ? { width: dockWidth } : undefined}
      aria-label={t("rightDock.label", "Right dock")}
      data-testid="right-dock"
    >
      {open ? (
        <div
          className="right-dock__resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={RIGHT_DOCK_MIN_WIDTH}
          aria-valuemax={RIGHT_DOCK_MAX_WIDTH}
          aria-valuenow={width}
          aria-label={t("rightDock.resize", "Resize right dock")}
          tabIndex={0}
          data-testid="right-dock-resize-handle"
          onPointerDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
        />
      ) : null}
      <div className="right-dock__toolbar">
        <div className="right-dock__tabs" role="tablist" aria-label={t("rightDock.views", "Right dock views")}>
          {entries.map((entry) => {
            const Icon = entry.icon;
            const selected = Boolean(entry.render && entry.key === selectedEntry.key);
            return (
              <button
                key={entry.key}
                type="button"
                className={`btn-icon right-dock__tab${selected ? " right-dock__tab--active" : ""}`}
                aria-label={entry.label}
                title={entry.label}
                aria-selected={selected}
                role="tab"
                data-testid={entry.testId}
                onClick={() => selectEntry(entry.key)}
              >
                <Icon size={16} />
              </button>
            );
          })}
        </div>
        <div className="right-dock__actions">
          {/*
          FNXC:RightDockPin 2026-06-27-00:00:
          The pin affordance belongs only to the in-dock toolbar, not the floating pop-out. It toggles overlay vs push layout while preserving open/close and expanded-modal independence, and aria-pressed mirrors the persisted push-mode state.
          */}
          <button
            type="button"
            className="btn-icon right-dock__pin"
            aria-label={pinLabel}
            title={pinLabel}
            aria-pressed={pinned}
            data-testid="right-dock-pin"
            onClick={onTogglePin}
          >
            <PinIcon size={16} />
          </button>
          {showingDockTask ? (
            <button
              type="button"
              className="btn-icon right-dock__expand"
              aria-label={closeDockTaskLabel}
              title={closeDockTaskLabel}
              data-testid="right-dock-close-task"
              onClick={onCloseDockTask}
            >
              <ArrowLeft size={16} />
            </button>
          ) : open && selectedEntry.render ? (
            <button
              type="button"
              className="btn-icon right-dock__expand"
              aria-label={expandSelectedViewLabel}
              title={expandSelectedViewLabel}
              data-testid="right-dock-expand"
              onClick={() => onExpand?.(selectedEntry.key)}
            >
              <Maximize2 size={16} />
            </button>
          ) : null}
        </div>
      </div>
      {open ? (
        <>
          <div className="right-dock__header">
            {showingDockTask ? (
              /*
              FNXC:RightDockTasks 2026-06-28-18:31:
              The task-detail header arrow is a real back button and shares the same close path as the top-right return affordance, so either visible control returns the dock to the Tasks list without leaving an inert icon or stale detail shell.
              */
              <button
                type="button"
                className="btn-icon right-dock__header-back"
                aria-label={closeDockTaskLabel}
                title={closeDockTaskLabel}
                data-testid="right-dock-header-back-task"
                onClick={onCloseDockTask}
              >
                <ArrowLeft size={16} />
              </button>
            ) : <SelectedIcon size={16} />}
            <div className="right-dock__title" role="heading" aria-level={3}>{showingDockTask ? t("rightDock.taskDetailTitle", "Task detail") : selectedEntry.label}</div>
          </div>
          <div className="right-dock__body" role="tabpanel" aria-label={showingDockTask ? t("rightDock.taskDetailTitle", "Task detail") : selectedEntry.label} data-testid="right-dock-body">
            {/*
            FNXC:RightDockFiles 2026-06-23-00:50:
            Thread the live dock width down to registry render functions as `dockWidth` (alongside surface="dock") so a view can deterministically choose its wide layout from the actual dock size. The Files entry uses this to force two-pane when the dock is wide enough, sidestepping the @container query that never reliably fired in the narrow-vs-wide dock body.

            FNXC:RightDockTasks 2026-06-28-17:02:
            The Tasks tab without an active snapshot falls through to its registry render, which is the compact DockTaskList. Only a selected Tasks tab with live dockTaskContent replaces this body with TaskDetailContent.
            */}
            {showingDockTask ? dockTaskContent : selectedEntry.render?.({ ...renderProps, surface: "dock", dockWidth: width })}
          </div>
        </>
      ) : null}
    </aside>
  );
}
