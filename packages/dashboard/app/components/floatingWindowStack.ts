/*
FNXC:FloatingWindow 2026-06-22-21:30:
SHARED floating-utility z-index stack. This is the ONE source of z-index for utility floating modals in the dashboard (FloatingWindow utility callers, the right-dock pop-out, the floating terminal, the floating New Task dialog) so they interoperate in a SINGLE stack instead of each type owning a private counter. Utility windows claim `nextFloatingZ()` on mount/open and again on every panel pointerdown/focus, so the most-recently-interacted utility window is always on top REGARDLESS of type.

FNXC:FloatingWindow 2026-06-22-22:30:
Base band sits at 10100+ — ABOVE the page overlay/popover band (log viewer, workflow-editor modal, selection popover, static fullscreen fallbacks at z 10000-10001) so a utility floating window the user is dragging is never painted over by those. Transient top-right toasts are bumped to 10500 (styles.css) so system feedback still shows above a dragged utility window. The workflow prompt fullscreen overlay is itself a floating utility surface and claims `nextFloatingZ()` when opened, because a static z 10000 fallback is hidden by the workflow editor's full-screen mobile FloatingWindow sheet. The counter is module-level and intentionally monotonic: it only ever climbs, which is fine for a session-length dashboard. All floating overlays are `pointer-events: none` (click-through) so raising panels into this shared band never traps clicks on the page behind them. CRITICAL: every floating modal must be portaled to document.body so this shared z is compared in ONE root stacking context (an inline panel cannot beat siblings outside its own context no matter its z).

FNXC:TaskPopupLayer 2026-07-17-15:55:
Task-detail popups and Quick Chat are interaction-stack peers in this lower board-layer band: the
most recently mounted or pointer/focus-interacted peer is on top. Terminal, right-dock expand,
Files, New Task, and other utility surfaces continue to use the separate 10100+ utility band.

FNXC:PluginOverlayLayering 2026-07-23-01:21:
Plugins need a stable layer above every dashboard-managed utility window even though this stack is
session-monotonic and unbounded. Keep `--fusion-max-z` at the 11001 boot floor until this utility
counter exceeds it, then raise the inline root value after each claim. The floor sits one above the
tallest static dashboard overlay — the body-portaled model-combobox dropdown at 11000 — so it
dominates every fixed layer. The lower 220+ task-detail band is intentionally excluded; only
utility claims can grow past the dashboard's static layers.
*/
/** Boot value for `--fusion-max-z`: one above the tallest static dashboard layer (the body-portaled model-combobox dropdown at 11000). */
export const FUSION_MAX_Z_FLOOR = 11001;

let topZ = 10100;
let taskDetailTopZ = 220;
let lastSyncedFusionMaxZ: number | undefined;

/** Publish the current dashboard-managed z-index ceiling to `--fusion-max-z` on `:root`, skipping redundant writes. No-op outside a DOM. */
function syncFusionMaxZ(): void {
  if (typeof document === "undefined") return;

  const value = Math.max(topZ, FUSION_MAX_Z_FLOOR);
  if (value === lastSyncedFusionMaxZ) return;

  document.documentElement.style.setProperty("--fusion-max-z", String(value));
  lastSyncedFusionMaxZ = value;
}

syncFusionMaxZ();

/** Claim the front of the shared floating-utility stack. Monotonic, session-length. */
export function nextFloatingZ(): number {
  const nextZ = ++topZ;
  syncFusionMaxZ();
  return nextZ;
}

/** Current top of the floating-utility stack (read-only). Lets a utility window skip a needless bump when already on top. */
export function currentFloatingZ(): number {
  return topZ;
}

/** Claim the front of the task-popup peer stack (task details and Quick Chat). Monotonic, session-length. */
export function nextTaskDetailFloatingZ(): number {
  return ++taskDetailTopZ;
}

/** Current top of the task-popup peer stack (read-only). */
export function currentTaskDetailFloatingZ(): number {
  return taskDetailTopZ;
}
