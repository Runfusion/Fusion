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
  area for it; its top edge touching the top wall fills the area. Since FN-493 an unambiguous CORNER (one side
  wall plus one horizontal wall) takes a quarter instead, so four windows tile the area as a 2x2 grid; top still
  wins whenever the vertical axis is ambiguous. Snapped rects are always derived from the LIVE work area, so
  opening/closing a sidebar re-splits the halves and the quadrants immediately.
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

/*
FNXC:FloatingWindowSnap 2026-09-16-18:31:
FN-469 adds `bottom` to the SHARED snap contract rather than to any single host. The operator asked for the
terminal's bottom dock to behave "comme une modale classique à la seule différence que je peux l'ancrer en bas",
and explicitly for conversations to gain the same affordance. Expressing the band here is the DRY way to give it
to EVERY dashboard window at once (terminal, chats, task pop-outs, migrated dialogs) instead of re-implementing a
per-host panel. The band is the full width of the live work area over its lower half.

OUT OF SCOPE, deliberately: the terminal's in-flow `below` presentation (which reserves shell height through
`onPinnedLayoutChange`) is untouched and remains its default, strongest bottom dock; `bottom` does not replace it.

FNXC:FloatingWindowSnap 2026-09-17-07:21:
FN-493 adds the FOUR CORNER QUADRANTS to this same shared contract, for the operator intent "si je mets une
modale dans chaque angle ça me fait une grille 2x2": a corner takes exactly half the live work area on each
axis, so four windows — one per corner — tile the area with no gap and no overlap.

A corner is armed ONLY when BOTH axes are unambiguous: the panel touches exactly one side wall (left XOR right)
AND exactly one horizontal wall (top XOR bottom). That condition DELIBERATELY REPLACES two earlier corner
priorities, and only inside it:
- FN-394's "the top wall wins in a corner" (a top corner used to return `maximized`);
- FN-469's "the side walls win in a bottom corner" (a bottom corner used to return the column).
Both rules were arbitrations made on the operator's behalf, which made a quadrant unreachable.

OUTSIDE that condition NOTHING changes, and the historical rule order applies verbatim:
- VERTICAL AMBIGUITY (a panel as tall as the work area, touching top AND bottom — including a full-height panel
  pressed against a side wall) arms no corner, so the top rule still wins and the result is still `maximized`;
- HORIZONTAL AMBIGUITY (a panel touching left AND right) arms no corner, so the existing side refusal applies as
  before: `maximized` when it also touches the top, else `bottom` when it rests on the bottom wall, else null.
*/
/** Placement of a window inside the dashboard work area. `floating` is free geometry. */
export type FloatingWindowSnapMode =
  | "floating"
  | "left"
  | "right"
  | "bottom"
  | "maximized"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** The four quadrant modes (FN-493), in reading order. Read-only so no consumer can mutate the contract. */
export const FLOATING_WINDOW_CORNER_SNAP_MODES = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const satisfies readonly FloatingWindowSnapMode[];

/** True for the four quadrant modes. */
export function isCornerSnapMode(mode: FloatingWindowSnapMode | null | undefined): boolean {
  return mode === "top-left" || mode === "top-right" || mode === "bottom-left" || mode === "bottom-right";
}

/** True for every mode whose rectangle rests ON the bottom wall (band and both bottom quadrants). */
export function isBottomAnchoredSnapMode(mode: FloatingWindowSnapMode | null | undefined): boolean {
  return mode === "bottom" || mode === "bottom-left" || mode === "bottom-right";
}

/*
FNXC:FloatingWindowGeometry 2026-09-16-05:45:
FN-456: the operator asked that EVERY modal open at the SAME landscape shape — width / height = 1.43 —
because each host declared its own `defaultSize` (520x320, 800x680, 900x660, 1100x720, 1200x720...), so the
opening ratio ranged from ~1.18 to >1.9 and every dialog looked arbitrarily shaped. The rule is DRY: it lives
ONLY here, applied by `resolveStandardSize`, so no host has to restate it.

SCOPE — OPENING ONLY. "Après le redimensionnement est libre": manual resize, drag, snap/dock, restore after
dock, cascade, re-clamp on bounds change, and mobile full-screen sheets are all untouched by the ratio.

EXEMPTION 1 — FULL VIEWS (`openingSizePolicy: "full-view"`). A view that deliberately FILLS the work area
(Git Manager opened from the header/footer "more" menu, Planning mode) would be shrunk and cropped by the
ratio; the operator explicitly excluded them, so their opening geometry stays bit-for-bit pre-FN-456.

EXEMPTION 2 — NESTED CSS DIALOGS. The raw `modal-overlay open` overlays inside `SettingsModal.tsx` (path
pickers, nested confirmations) and the mobile drawer overlay of `NewTaskModal.tsx` own NO window geometry:
their size comes from CSS flow (`.modal.modal-lg`), they are neither draggable nor resizable, so "resizing is
free afterwards" does not apply to them. They stay out of scope deliberately, not accidentally.
*/
export const FLOATING_WINDOW_OPENING_ASPECT_RATIO = 1.43;

/**
 * Opening size policy for a window host.
 * - `aspect-ratio` (default): normalized to {@link FLOATING_WINDOW_OPENING_ASPECT_RATIO} (FN-456).
 * - `full-view`: exempt full-work-area views; opening geometry is exactly the pre-FN-456 behaviour.
 */
export type FloatingWindowOpeningSizePolicy = "aspect-ratio" | "full-view";

/** Standard opening size used when a host declares no `defaultSize`. */
export const FLOATING_WINDOW_STANDARD_WIDTH = 720;
/** Derived from the shared opening ratio (FN-456) so the fallback cannot drift from the rule. */
export const FLOATING_WINDOW_STANDARD_HEIGHT = Math.round(
  FLOATING_WINDOW_STANDARD_WIDTH / FLOATING_WINDOW_OPENING_ASPECT_RATIO,
);
/*
FNXC:FloatingWindowGeometry 2026-09-15-04:01:
FN-401: a detached conversation used to open at 980x680 while a task window opened at 800x680, so every
chat pop-out looked oversized next to the task windows it sits beside. Task and Chat windows now share
ONE standard opening size expressed by these constants, and every host (Task Detail modal, task pop-out,
detached chat) reads them instead of repeating a literal. `minSize` stays per host: Chat keeps a narrower
minimum so it remains usable inside a half-width snap column.

FNXC:FloatingWindowGeometry 2026-09-16-05:45:
FN-456 keeps the shared task/chat WIDTH as the host intent and DERIVES its height from the shared opening
ratio, so the one place that states 1.43 stays the seam constant above (the former literal 680 opened at ~1.18).
*/
export const FLOATING_WINDOW_TASK_STANDARD_WIDTH = 800;
export const FLOATING_WINDOW_TASK_STANDARD_HEIGHT = Math.round(
  FLOATING_WINDOW_TASK_STANDARD_WIDTH / FLOATING_WINDOW_OPENING_ASPECT_RATIO,
);
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

FNXC:FloatingWindowGeometry 2026-09-16-05:45:
FN-456 keeps this cap but changes HOW it is applied per opening policy:
- `aspect-ratio`: the cap is applied THROUGH the ratio normalization, as a single scale factor reducing BOTH
  axes, so an over-tall opening shrinks without breaking the 1.43 shape the operator asked for.
- `full-view`: unchanged, still a plain `Math.min` on the height alone with the width left intact.
*/
export const FLOATING_WINDOW_STANDARD_HEIGHT_RATIO = 0.62;
/*
FNXC:FloatingWindowGeometry 2026-09-16-07:38:
FN-460: after FN-456 every modal opened at the right SHAPE but the operator judged them too small —
"augmente la taille de 20%. même ratio". This single shared constant is the TARGET scale factor of the
`aspect-ratio` opening formula, so both axes grow together and 1.43 is preserved by construction.

WHY IT IS ALSO APPLIED THROUGH THE FN-418 CAP: on any real work area the opening size is already bound by
the 62% proportional height cap (a 1024x768 laptop leaves 668px, and the cap is the binding constraint for
every task/chat/settings host). Scaling only the un-capped branch would be entirely absorbed by that cap and
the operator would see NO change on a laptop, which is exactly the surface the request came from. The cap is
therefore carried by the same factor.

ASSUMED CONSEQUENCE: the effective opening height cap moves from 62% to 74.4% of the live work area. The
FN-418 intent ("a window never fills the band between header and footer") still holds because `bounds.height`
remains a HARD bound in the `Math.min` below and in the final `clampFloatingWindowSize`.

OUT OF SCOPE, deliberately: the `full-view` policy (Git Manager, Planning mode) keeps its FN-456 exemption
bit-for-bit, and every non-opening trajectory (manual resize, drag, snap/dock, restore, cascade, mobile
sheets) is untouched — the factor lives only in the opening branch.
*/
export const FLOATING_WINDOW_OPENING_SIZE_SCALE = 1.2;
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
 * The window's own standard size. Never derived from another window.
 *
 * - `aspect-ratio` (default, FN-456): the host's requested WIDTH carries its intent, the height is derived
 *   from {@link FLOATING_WINDOW_OPENING_ASPECT_RATIO}, then BOTH axes are scaled by one shared factor so the
 *   FN-418 proportional height cap and the live work-area width still hold without breaking the shape.
 *   FN-460: that shared factor now TARGETS {@link FLOATING_WINDOW_OPENING_SIZE_SCALE} instead of 1, so the
 *   host's requested width is a scaled BASE rather than a ceiling — the opening box is 20% larger on both
 *   axes wherever no clamp binds, and the proportional cap is carried by the same factor.
 * - `full-view` (FN-456 exemption): the pre-FN-456 branch verbatim — the FN-418 cap on the height alone, the
 *   width untouched — so a work-area-filling view is never shrunk or cropped by the ratio.
 *
 * Both policies end on the existing `clampFloatingWindowSize` (max-then-min), so `minSize` and then the live
 * work area keep exactly the priority they have today, and degenerate bounds behave exactly as before.
 */
export function resolveStandardSize(
  defaultSize: FloatingWindowSize | undefined,
  minSize: FloatingWindowSize,
  bounds: DashboardWindowBounds,
  openingSizePolicy: FloatingWindowOpeningSizePolicy = "aspect-ratio",
): FloatingWindowSize {
  const requested = defaultSize && finite(defaultSize.width, defaultSize.height)
    ? defaultSize
    : { width: FLOATING_WINDOW_STANDARD_WIDTH, height: FLOATING_WINDOW_STANDARD_HEIGHT };
  const hasHeightBound = Number.isFinite(bounds.height) && bounds.height > 0;

  if (openingSizePolicy === "full-view") {
    const proportional = hasHeightBound
      ? Math.min(requested.height, Math.round(bounds.height * FLOATING_WINDOW_STANDARD_HEIGHT_RATIO))
      : requested.height;
    return clampFloatingWindowSize({ width: requested.width, height: proportional }, minSize, bounds);
  }

  const ratioWidth = requested.width;
  const ratioHeight = ratioWidth / FLOATING_WINDOW_OPENING_ASPECT_RATIO;
  const maxHeight = hasHeightBound
    ? Math.min(
        bounds.height,
        Math.round(bounds.height * FLOATING_WINDOW_STANDARD_HEIGHT_RATIO) * FLOATING_WINDOW_OPENING_SIZE_SCALE,
      )
    : Number.POSITIVE_INFINITY;
  const maxWidth = Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : Number.POSITIVE_INFINITY;
  const scales = [FLOATING_WINDOW_OPENING_SIZE_SCALE];
  if (Number.isFinite(maxHeight) && Number.isFinite(ratioHeight) && ratioHeight > 0) scales.push(maxHeight / ratioHeight);
  if (Number.isFinite(maxWidth) && Number.isFinite(ratioWidth) && ratioWidth > 0) scales.push(maxWidth / ratioWidth);
  const scale = Math.min(...scales);
  const scaled = {
    width: Math.round(ratioWidth * scale),
    height: Math.round(ratioHeight * scale),
  };
  return clampFloatingWindowSize(scaled, minSize, bounds);
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
  /** FN-456 opening policy; omitted or unrecognized means `aspect-ratio`, so no existing host changes. */
  openingSizePolicy?: FloatingWindowOpeningSizePolicy;
}): FloatingWindowRect {
  const policy: FloatingWindowOpeningSizePolicy = input.openingSizePolicy === "full-view" ? "full-view" : "aspect-ratio";
  const size = resolveStandardSize(input.defaultSize, input.minSize, input.bounds, policy);
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
  // FNXC:FloatingWindowSnap 2026-09-16-18:31: FN-469 — the bottom band is full width over the lower half, mirroring the columns' half split on the other axis.
  if (mode === "bottom") return { position: { x: bounds.left, y: bounds.top + height / 2 }, size: { width, height: height / 2 } };
  const half = width / 2;
  /*
  FNXC:FloatingWindowSnap 2026-09-17-07:21:
  FN-493 quadrant rectangle: half the LIVE work area on each axis, so opening/closing a sidebar re-splits the
  grid immediately like every other mode. The right-hand origin reuses the existing column form
  (`left + (width - half)`) rather than `left + half` so the four rectangles keep tiling exactly — no floating
  drift can open a seam between the two columns.
  */
  if (isCornerSnapMode(mode)) {
    const halfHeight = height / 2;
    const atLeft = mode === "top-left" || mode === "bottom-left";
    const atTop = mode === "top-left" || mode === "top-right";
    return {
      position: {
        x: atLeft ? bounds.left : bounds.left + (width - half),
        y: atTop ? bounds.top : bounds.top + (height - halfHeight),
      },
      size: { width: half, height: halfHeight },
    };
  }
  return {
    position: { x: mode === "left" ? bounds.left : bounds.left + (width - half), y: bounds.top },
    size: { width: half, height },
  };
}

/*
FNXC:FloatingWindowSnap 2026-09-17-07:21:
FN-493 exposes the bottom-wall contact test used by `detectSnapZoneForRect` so the gesture layer can describe
EXACTLY the same condition rather than restating it — the FN-469 undock artifact is defined as "the restored
rectangle rests on the bottom wall", and a second, drifting definition would silently re-arm the band.
*/
export function rectRestsOnBottomWall(
  rect: FloatingWindowRect,
  bounds: DashboardWindowBounds,
  contact: number = FLOATING_WINDOW_SNAP_CONTACT_PX,
): boolean {
  if (!finite(rect.position.y, rect.size.height, bounds.bottom)) return false;
  return rect.position.y + rect.size.height >= bounds.bottom - contact;
}

/*
FNXC:FloatingWindowSnap 2026-09-17-07:21:
FN-493: the undock artifact only ever plasters a window's BOTTOM edge against the bottom wall
(`resolveDetachedRect` anchors vertically 24px under the pointer), so disarming it must remove ONLY the bottom
component of a detected zone. Demoting a bottom quadrant to its column keeps a legitimate side contact — which the
operator really did aim at — instead of turning it into a quarter the artifact invented.
*/
export function demoteBottomAnchoredSnapMode(mode: FloatingWindowSnapMode | null): FloatingWindowSnapMode | null {
  if (mode === "bottom") return null;
  if (mode === "bottom-left") return "left";
  if (mode === "bottom-right") return "right";
  return mode;
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

FNXC:FloatingWindowSnap 2026-09-16-18:31:
FN-469 appends `bottom` as the LAST rule, and the ordering is the whole point. A `left`/`right` column occupies the
FULL height of the work area, so its bottom edge ALWAYS rests on the bottom wall; evaluating `bottom` before the
sides would silently re-route every existing column snap to the band. Evaluating it last means no existing result
changes and `bottom` is armed only where nothing was armed before — including the bottom corners, where the side
still wins. The both-walls ambiguity refusal stays a SIDE rule: a panel as wide as the work area sitting on the
bottom wall is unambiguous about the bottom, so it does arm `bottom`.
*/
export function detectSnapZoneForRect(
  rect: FloatingWindowRect,
  bounds: DashboardWindowBounds,
  contact: number = FLOATING_WINDOW_SNAP_CONTACT_PX,
): FloatingWindowSnapMode | null {
  if (!finite(rect.position.x, rect.position.y, rect.size.width, rect.size.height)) return null;
  if (!finite(bounds.left, bounds.top, bounds.right, bounds.bottom, bounds.width, bounds.height)) return null;
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const touchesLeft = rect.position.x <= bounds.left + contact;
  const touchesRight = rect.position.x + rect.size.width >= bounds.right - contact;
  const touchesTop = rect.position.y <= bounds.top + contact;
  const touchesBottom = rect.position.y + rect.size.height >= bounds.bottom - contact;
  /*
  FNXC:FloatingWindowSnap 2026-09-17-07:21:
  FN-493 corner quadrants, checked FIRST and ONLY when both axes are unambiguous (exactly one side wall AND
  exactly one horizontal wall). This is the deliberate replacement of FN-394's "top wins in a corner" and
  FN-469's "the side wins in a bottom corner"; every other configuration falls through to the historical rule
  order below, word for word, so no existing non-corner result changes.
  */
  const sideUnambiguous = touchesLeft !== touchesRight;
  const verticalUnambiguous = touchesTop !== touchesBottom;
  if (sideUnambiguous && verticalUnambiguous) {
    if (touchesTop) return touchesLeft ? "top-left" : "top-right";
    return touchesLeft ? "bottom-left" : "bottom-right";
  }
  if (touchesTop) return "maximized";
  if (touchesLeft && !touchesRight) return "left";
  if (touchesRight && !touchesLeft) return "right";
  if (touchesBottom) return "bottom";
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
FNXC:FloatingWindowSnap 2026-09-16-18:31:
FN-469 gesture handoff. When a host tears its own docked presentation down and replaces it with a floating window
MID-DRAG (today: the terminal leaving its in-flow `below` panel), the new window must appear UNDER THE POINTER at
the proportional grab point the operator was holding — not at the standard centred opening rectangle, which is
exactly the reported "ça crée un élément centré" defect.

`grabOffset` is the point INSIDE the panel that must land on the pointer, so the window is "recropped" around the
finger rather than re-centred. It defaults to the same anchor `resolveDetachedRect` uses (horizontally centred,
{@link FLOATING_WINDOW_DETACH_PX} below the top edge) so a host that cannot measure its own header — jsdom, an
unpainted panel — degrades to the familiar undock placement instead of throwing. Non-finite pointer input falls
back to the centred rectangle; every result is clamped into the live work area.
*/
export function resolveHandoffRect(input: {
  size: FloatingWindowSize;
  pointer: FloatingWindowPosition;
  grabOffset?: FloatingWindowPosition;
  minSize: FloatingWindowSize;
  bounds: DashboardWindowBounds;
}): FloatingWindowRect {
  const requested = finite(input.size.width, input.size.height) ? input.size : input.minSize;
  const size = clampFloatingWindowSize(requested, input.minSize, input.bounds);
  if (!finite(input.pointer.x, input.pointer.y)) return { size, position: resolveCenteredPosition(size, input.bounds) };
  const fallback = { x: size.width / 2, y: FLOATING_WINDOW_DETACH_PX };
  const grab = input.grabOffset && finite(input.grabOffset.x, input.grabOffset.y) ? input.grabOffset : fallback;
  const grabX = Math.min(Math.max(0, grab.x), Math.max(0, size.width));
  const grabY = Math.min(Math.max(0, grab.y), Math.max(0, size.height));
  return {
    size,
    position: clampFloatingWindowPosition({ x: input.pointer.x - grabX, y: input.pointer.y - grabY }, size, input.bounds),
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
