/*
FNXC:FloatingWindow 2026-06-22-21:30:
SHARED floating-utility z-index stack. This is the ONE source of z-index for utility floating modals in the dashboard (FloatingWindow utility callers, the right-dock pop-out, the floating terminal, the floating New Task dialog) so they interoperate in a SINGLE stack instead of each type owning a private counter. Utility windows claim `nextFloatingZ()` on mount/open and again on every panel pointerdown/focus, so the most-recently-interacted utility window is always on top REGARDLESS of type.

FNXC:FloatingWindow 2026-06-22-22:30:
Base band sits at 10100+ — ABOVE the page overlay/popover band (log viewer, workflow-editor modal, selection popover, static fullscreen fallbacks at z 10000-10001) so a utility floating window the user is dragging is never painted over by those. Transient top-right toasts are bumped to 10500 (styles.css) so system feedback still shows above a dragged utility window. The workflow prompt fullscreen overlay is itself a floating utility surface and claims `nextFloatingZ()` when opened, because a static z 10000 fallback is hidden by the workflow editor's full-screen mobile FloatingWindow sheet. The counter is module-level and intentionally monotonic: it only ever climbs, which is fine for a session-length dashboard. All floating overlays are `pointer-events: none` (click-through) so raising panels into this shared band never traps clicks on the page behind them. CRITICAL: every floating modal must be portaled to document.body so this shared z is compared in ONE root stacking context (an inline panel cannot beat siblings outside its own context no matter its z).

FNXC:TaskPopupLayer 2026-07-04-18:36:
Task-detail popups are ordinary board/task-detail surfaces, not global utilities. Keep their focus stack in a lower board-layer band so task popups can raise among themselves without covering terminal, right-dock expand, Quick Chat, file browser, workflow editor, or other utility windows that intentionally use the 10100+ band.
*/
let topZ = 10100;
let taskDetailTopZ = 220;

/** Claim the front of the shared floating-utility stack. Monotonic, session-length. */
export function nextFloatingZ(): number {
  return ++topZ;
}

/** Current top of the floating-utility stack (read-only). Lets a utility window skip a needless bump when already on top. */
export function currentFloatingZ(): number {
  return topZ;
}

/** Claim the front of the board/task-detail popup stack. Monotonic, session-length. */
export function nextTaskDetailFloatingZ(): number {
  return ++taskDetailTopZ;
}

/** Current top of the board/task-detail popup stack (read-only). */
export function currentTaskDetailFloatingZ(): number {
  return taskDetailTopZ;
}
