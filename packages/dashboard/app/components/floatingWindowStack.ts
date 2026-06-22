/*
FNXC:FloatingWindow 2026-06-22-21:30:
SHARED floating-window z-index stack. This is the ONE source of z-index for every floating modal in the dashboard (FloatingWindow, the right-dock pop-out, the floating terminal, the floating New Task dialog) so they interoperate in a SINGLE stack instead of each type owning a private counter. Previously each modal type managed z-index independently, so tapping e.g. the terminal could not raise it above a popped-out task-detail FloatingWindow. Now every floating modal claims `nextFloatingZ()` on mount/open and again on every panel pointerdown/focus, so the most-recently-interacted window is always on top REGARDLESS of type.

FNXC:FloatingWindow 2026-06-22-22:30:
Base band sits at 10100+ — ABOVE the page overlay/popover band (log viewer, workflow-editor modal, selection popover, fullscreen overlay at z 10000-10001) so a floating window the user is dragging is never painted over by those. Transient top-right toasts are bumped to 10500 (styles.css) so system feedback still shows above a dragged window. The counter is module-level and intentionally monotonic: it only ever climbs, which is fine for a session-length dashboard. All floating overlays are `pointer-events: none` (click-through) so raising panels into this shared band never traps clicks on the page behind them. CRITICAL: every floating modal must be portaled to document.body so this shared z is compared in ONE root stacking context (an inline panel cannot beat siblings outside its own context no matter its z).
*/
let topZ = 10100;

/** Claim the front of the shared floating-window stack. Monotonic, session-length. */
export function nextFloatingZ(): number {
  return ++topZ;
}

/** Current top of the stack (read-only). Lets a window skip a needless bump when already on top. */
export function currentFloatingZ(): number {
  return topZ;
}
