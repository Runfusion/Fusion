import type { DashboardWindowBounds } from "../context/DashboardWindowManagerContext";

/*
FNXC:FloatingWindowGeometry 2026-09-14-21:10:
FN-394 gives every dashboard window ONE shared geometry contract, expressed here as pure functions so
no host re-implements opening, cascading, snapping, or restoring:

- OPENING: a new window always opens at its own standard size, centered in the live work area. Stored
  geometry is never restored, and neither another window's position/size nor an occupied snap zone can
  influence it.
- CASCADE: the single exception to centering is a cohort of still-pristine floating windows. Each new
  member takes the first free 28px step. The cascade only ever MOVES a window; it never shrinks one
  (overlap is preferable to a smaller window), and it flips to a negative step when forward travel is
  unavailable.
- SNAP: dragging a window until its OWN left/right edge touches the matching work-area wall halves that
  area for it; its top edge touching the top wall fills the area. Top wins in a corner. Snapped rects are
  always derived from the LIVE work area, so opening/closing a sidebar re-splits the halves immediately.
- RESTORE: dragging a snapped window down by 24px restores the floating rect captured before the FIRST
  snap, so left → right → maximized → down never restores a snapped rectangle.
*/

export interface FloatingWindowSize {
  width: number;
  height: number;
}

export interface FloatingWindowPosition {
  x: number;
  y: number;
}

export interface FloatingWindowRect {
  position: FloatingWindowPosition;
  size: FloatingWindowSize;
}

/** Placement of a window inside the dashboard work area. `floating` is free geometry. */
export type FloatingWindowSnapMode = "floating" | "left" | "right" | "maximized";

/** Standard opening size used when a host declares no `defaultSize`. */
export const FLOATING_WINDOW_STANDARD_WIDTH = 720;
export const FLOATING_WINDOW_STANDARD_HEIGHT = 560;
/*
FNXC:FloatingWindowGeometry 2026-09-15-04:01:
FN-401: a detached conversation used to open at 980x680 while a task window opened at 800x680, so every
chat pop-out looked oversized next to the task windows it sits beside. Task and Chat windows now share
ONE standard opening size expressed by these constants, and every host (Task Detail modal, task pop-out,
detached chat) reads them instead of repeating a literal. `minSize` stays per host: Chat keeps a narrower
minimum so it remains usable inside a half-width snap column.
*/
export const FLOATING_WINDOW_TASK_STANDARD_WIDTH = 800;
export const FLOATING_WINDOW_TASK_STANDARD_HEIGHT = 680;
/*
FNXC:FloatingWindowGeometry 2026-09-15-13:41:
FN-418: an opening height expressed in FIXED PIXELS was only ever clamped DOWN to the work area, so any
work area shorter than the requested height produced a window filling 100% of the band between header and
footer — the exact "why do modals open that large?" report. A laptop work area is commonly 600-700px while
hosts request 720 (Settings) or 680 (task/chat), so the clamp hit constantly.

The standard OPENING height is therefore additionally capped to a proportion of the LIVE work area (62%,
inside the 60/65% the operator asked for). The cap applies at opening only: `minSize` still wins over it
(`clampFloatingWindowSize` keeps its max-then-min order), the live work area still has the last word, and
snapping, manual resizing, restore-after-snap, and mobile full-screen sheets are untouched. Width is never
capped — the request was about height alone.
*/
export const FLOATING_WINDOW_STANDARD_HEIGHT_RATIO = 0.62;
/** Shared cascade step for the pristine-window cohort. Identical for every window type (DRY with chats). */
export const FLOATING_WINDOW_CASCADE_STEP_PX = 28;
/*
FNXC:FloatingWindowSnap 2026-09-15-04:01:
FN-401 replaces the former 24px pointer band (`FLOATING_WINDOW_SNAP_BAND_PX`, deleted with `detectSnapZone`)
with exact WALL CONTACT of the dragged panel. No tolerance band is needed once the panel decides: the
position clamp pins an over-dragged window's edge exactly on the wall, so "push it against the wall" is
always achievable. A band would instead arm a zone for any large window merely sitting near a wall — an
800x680 window in a 1280x700 work area is almost always within 24px of something. This value is only a
sub-pixel guard for fractional work areas, never a reach-in band.
*/
export const FLOATING_WINDOW_SNAP_CONTACT_PX = 0.5;
/** Pointer travel below this stays a click: it must not mark the window as user-adjusted or snap it. */
export const FLOATING_WINDOW_DRAG_THRESHOLD_PX = 6;
/**
 * Vertical offset used to RE-ANCHOR a detached window under the pointer (see `resolveDetachedRect`).
 * It is no longer a gesture threshold: since FN-422 the detach itself is omnidirectional and triggers at
 * `FLOATING_WINDOW_DRAG_THRESHOLD_PX`.
 */
export const FLOATING_WINDOW_DETACH_PX = 24;

function finite(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

/*
FNXC:FloatingWindowBounds 2026-09-14-21:10:
Size is clamped before position, and the live work area wins over a caller's declared minimum whenever
the area is smaller (a half-width column is allowed to be narrower than `minSize`); the window body
stays scrollable instead of overflowing the shell.
*/
export function clampFloatingWindowSize(
  size: FloatingWindowSize,
  minSize: FloatingWindowSize,
  bounds: DashboardWindowBounds,
): FloatingWindowSize {
  return {
    width: Math.min(Math.max(0, size.width, minSize.width), Math.max(0, bounds.width)),
    height: Math.min(Math.max(0, size.height, minSize.height), Math.max(0, bounds.height)),
  };
}

export function clampFloatingWindowPosition(
  position: FloatingWindowPosition,
  size: FloatingWindowSize,
  bounds: DashboardWindowBounds,
): FloatingWindowPosition {
  return {
    x: Math.min(Math.max(position.x, bounds.left), Math.max(bounds.left, bounds.right - size.width)),
    y: Math.min(Math.max(position.y, bounds.top), Math.max(bounds.top, bounds.bottom - size.height)),
  };
}

export function clampFloatingWindowRect(
  rect: FloatingWindowRect,
  minSize: FloatingWindowSize,
  bounds: DashboardWindowBounds,
): FloatingWindowRect {
  const size = clampFloatingWindowSize(rect.size, minSize, bounds);
  return { size, position: clampFloatingWindowPosition(rect.position, size, bounds) };
}

/**
 * The window's own standard size: capped to {@link FLOATING_WINDOW_STANDARD_HEIGHT_RATIO} of the live work
 * area (height only, FN-418) and then clamped to that area. Never derived from another window.
 */
export function resolveStandardSize(
  defaultSize: FloatingWindowSize | undefined,
  minSize: FloatingWindowSize,
  bounds: DashboardWindowBounds,
): FloatingWindowSize {
  const requested = defaultSize && finite(defaultSize.width, defaultSize.height)
    ? defaultSize
    : { width: FLOATING_WINDOW_STANDARD_WIDTH, height: FLOATING_WINDOW_STANDARD_HEIGHT };
  const proportional = Number.isFinite(bounds.height) && bounds.height > 0
    ? Math.min(requested.height, Math.round(bounds.height * FLOATING_WINDOW_STANDARD_HEIGHT_RATIO))
    : requested.height;
  return clampFloatingWindowSize({ width: requested.width, height: proportional }, minSize, bounds);
}

/** Centre of the live work area for a given size. */
export function resolveCenteredPosition(size: FloatingWindowSize, bounds: DashboardWindowBounds): FloatingWindowPosition {
  return clampFloatingWindowPosition(
    { x: bounds.left + (bounds.width - size.width) / 2, y: bounds.top + (bounds.height - size.height) / 2 },
    size,
    bounds,
  );
}

function cascadeAxis(base: number, distance: number, lowerBound: number, upperBound: number): number {
  const maximum = Math.max(lowerBound, upperBound);
  const forward = Math.min(base + distance, maximum);
  if (forward - base >= distance) return forward;
  const backward = base - distance;
  if (backward >= lowerBound) return backward;
  // Not enough room either way: clamp the offset rather than shrink the window.
  return Math.max(lowerBound, Math.min(forward, maximum));
}

/*
FNXC:FloatingWindowCascade 2026-09-14-21:10:
A cascade slot only ever displaces a window. When neither forward nor backward travel fits, the offset
is clamped and the windows overlap; FN-394 explicitly prefers overlap over a reduced window size.
*/
export function resolveCascadedPosition(
  base: FloatingWindowPosition,
  size: FloatingWindowSize,
  bounds: DashboardWindowBounds,
  cascadeSlot: number,
): FloatingWindowPosition {
  if (!Number.isFinite(cascadeSlot) || cascadeSlot <= 0) return base;
  if (!finite(base.x, base.y, size.width, size.height, bounds.left, bounds.top, bounds.right, bounds.bottom)) return base;
  const distance = cascadeSlot * FLOATING_WINDOW_CASCADE_STEP_PX;
  return {
    x: cascadeAxis(base.x, distance, bounds.left, bounds.right - size.width),
    y: cascadeAxis(base.y, distance, bounds.top, bounds.bottom - size.height),
  };
}

/** Full standard opening geometry: own size, centered, displaced only by this window's cascade slot. */
export function resolveOpeningRect(input: {
  defaultSize?: FloatingWindowSize;
  defaultPosition?: FloatingWindowPosition;
  minSize: FloatingWindowSize;
  bounds: DashboardWindowBounds;
  cascadeSlot?: number;
}): FloatingWindowRect {
  const size = resolveStandardSize(input.defaultSize, input.minSize, input.bounds);
  const base = input.defaultPosition && finite(input.defaultPosition.x, input.defaultPosition.y)
    ? clampFloatingWindowPosition(input.defaultPosition, size, input.bounds)
    : resolveCenteredPosition(size, input.bounds);
  return { size, position: resolveCascadedPosition(base, size, input.bounds, input.cascadeSlot ?? 0) };
}

/*
FNXC:FloatingWindowSnap 2026-09-14-21:10:
Columns are exactly half of the CURRENT work area each, whether one or both halves are occupied, and
`maximized` fills that same area — never the browser full screen. There is no exclusivity: any number
of windows may share a zone.
*/
export function resolveSnapRect(mode: FloatingWindowSnapMode, bounds: DashboardWindowBounds): FloatingWindowRect | null {
  if (mode === "floating") return null;
  if (!finite(bounds.left, bounds.top, bounds.right, bounds.bottom, bounds.width, bounds.height)) return null;
  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height);
  if (mode === "maximized") return { position: { x: bounds.left, y: bounds.top }, size: { width, height } };
  const half = width / 2;
  return {
    position: { x: mode === "left" ? bounds.left : bounds.left + (width - half), y: bounds.top },
    size: { width: half, height },
  };
}

/*
FNXC:FloatingWindowSnap 2026-09-15-04:01:
FN-401: zone detection follows the DRAGGED PANEL RECTANGLE, not the pointer. The operator's mental model is
"push the window against a wall": a wide panel whose right edge was already pinned to the right wall by the
position clamp offered nothing until the CURSOR also entered a 24px band, which could be hundreds of pixels
further right and therefore unreachable. Callers must pass the CLAMPED candidate rectangle, because an
unclamped position never lands exactly on a wall.

Rules, in order:
- non-finite input or a degenerate work area arms nothing;
- the top edge ON the top wall wins in both top corners (`maximized`);
- otherwise the left edge on the left wall arms `left`, the right edge on the right wall arms `right`;
- AMBIGUITY: a panel as wide as the work area touches BOTH walls at once. Guessing a side there would snap a
  window the operator only meant to move, and such a panel is already equivalent to the filled work area, so
  nothing is armed; it detaches first like any docked window.
*/
export function detectSnapZoneForRect(
  rect: FloatingWindowRect,
  bounds: DashboardWindowBounds,
  contact: number = FLOATING_WINDOW_SNAP_CONTACT_PX,
): FloatingWindowSnapMode | null {
  if (!finite(rect.position.x, rect.position.y, rect.size.width, rect.size.height)) return null;
  if (!finite(bounds.left, bounds.top, bounds.right, bounds.bottom, bounds.width, bounds.height)) return null;
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  if (rect.position.y <= bounds.top + contact) return "maximized";
  const touchesLeft = rect.position.x <= bounds.left + contact;
  const touchesRight = rect.position.x + rect.size.width >= bounds.right - contact;
  if (touchesLeft && touchesRight) return null;
  if (touchesLeft) return "left";
  if (touchesRight) return "right";
  return null;
}

/*
FNXC:FloatingWindowSnap 2026-09-14-21:10:
Detaching restores the floating rect captured before the first snap and re-centres it horizontally
under the pointer so the window follows the finger/cursor, then clamps to the live work area.

FNXC:FloatingWindowSnap 2026-09-15-14:07:
FN-422: the gesture that triggers this restore no longer has an imposed direction. `FLOATING_WINDOW_DETACH_PX`
survives here ONLY as the vertical offset placing the restored rect just under the pointer.
*/
export function resolveDetachedRect(
  restore: FloatingWindowRect,
  pointer: FloatingWindowPosition,
  minSize: FloatingWindowSize,
  bounds: DashboardWindowBounds,
): FloatingWindowRect {
  const size = clampFloatingWindowSize(restore.size, minSize, bounds);
  return {
    size,
    position: clampFloatingWindowPosition({ x: pointer.x - size.width / 2, y: pointer.y - FLOATING_WINDOW_DETACH_PX }, size, bounds),
  };
}

/*
FNXC:FloatingWindowSnap 2026-09-15-14:07:
FN-422: a docked window (`left`, `right`, `maximized`) used to come loose ONLY by dragging DOWN 24px. Pulling it
up, left, right, or diagonally did nothing at all, so a column or full-screen window simply looked stuck. A
docked window is now released as soon as the gesture stops being a click, in ANY direction, reusing the
existing drag threshold. Below the threshold the gesture stays a click and the dock is preserved; non-finite
input never detaches.
*/
export function shouldDetachSnappedWindow(
  start: FloatingWindowPosition,
  pointer: FloatingWindowPosition,
  threshold: number = FLOATING_WINDOW_DRAG_THRESHOLD_PX,
): boolean {
  if (!finite(start.x, start.y, pointer.x, pointer.y, threshold)) return false;
  return Math.hypot(pointer.x - start.x, pointer.y - start.y) >= threshold;
}
