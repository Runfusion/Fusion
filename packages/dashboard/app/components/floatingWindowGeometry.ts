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
- SNAP: dragging a window header into a 24px band at the left/right edge halves the work area for it;
  the top band fills the work area. Top wins in a corner. Snapped rects are always derived from the
  LIVE work area, so opening/closing a sidebar re-splits the halves immediately.
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
/** Shared cascade step for the pristine-window cohort. Identical for every window type (DRY with chats). */
export const FLOATING_WINDOW_CASCADE_STEP_PX = 28;
/** CSS-pixel band around the work-area edges that arms a snap preview while dragging a header. */
export const FLOATING_WINDOW_SNAP_BAND_PX = 24;
/** Pointer travel below this stays a click: it must not mark the window as user-adjusted or snap it. */
export const FLOATING_WINDOW_DRAG_THRESHOLD_PX = 6;
/** Downward travel required to detach a snapped window back to its pre-snap floating rect. */
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

/** The window's own standard size, clamped to the live work area. Never derived from another window. */
export function resolveStandardSize(
  defaultSize: FloatingWindowSize | undefined,
  minSize: FloatingWindowSize,
  bounds: DashboardWindowBounds,
): FloatingWindowSize {
  const requested = defaultSize && finite(defaultSize.width, defaultSize.height)
    ? defaultSize
    : { width: FLOATING_WINDOW_STANDARD_WIDTH, height: FLOATING_WINDOW_STANDARD_HEIGHT };
  return clampFloatingWindowSize(requested, minSize, bounds);
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
FNXC:FloatingWindowSnap 2026-09-14-21:10:
Zone detection follows the POINTER inside the dragged header, not the panel rectangle, so a large
window cannot arm a zone merely by being wide. The top band wins in both top corners.
*/
export function detectSnapZone(
  pointer: FloatingWindowPosition,
  bounds: DashboardWindowBounds,
  band: number = FLOATING_WINDOW_SNAP_BAND_PX,
): FloatingWindowSnapMode | null {
  if (!finite(pointer.x, pointer.y, bounds.left, bounds.top, bounds.right, bounds.bottom)) return null;
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  if (pointer.y < bounds.top - band || pointer.y > bounds.bottom + band) return null;
  if (pointer.x < bounds.left - band || pointer.x > bounds.right + band) return null;
  if (pointer.y <= bounds.top + band) return "maximized";
  if (pointer.x <= bounds.left + band) return "left";
  if (pointer.x >= bounds.right - band) return "right";
  return null;
}

/*
FNXC:FloatingWindowSnap 2026-09-14-21:10:
Detaching restores the floating rect captured before the first snap and re-centres it horizontally
under the pointer so the window follows the finger/cursor, then clamps to the live work area.
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
