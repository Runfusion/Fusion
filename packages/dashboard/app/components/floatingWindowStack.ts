/*
FNXC:FloatingWindow 2026-06-22-21:30:
SHARED floating-utility z-index stack. This is the ONE source of z-index for utility floating modals in the dashboard (FloatingWindow utility callers, the right-dock pop-out, the floating terminal, the floating New Task dialog) so they interoperate in a SINGLE stack instead of each type owning a private counter. Utility windows claim `nextFloatingZ()` on mount/open and again on every panel pointerdown/focus, so the most-recently-interacted utility window is always on top REGARDLESS of type.

FNXC:FloatingWindow 2026-06-22-22:30:
Base band sits at 10100+ — ABOVE the page overlay/popover band (log viewer, workflow-editor modal, selection popover, static fullscreen fallbacks at z 10000-10001) so a utility floating window the user is dragging is never painted over by those. Transient top-right toasts are bumped to 10500 (styles.css) so system feedback still shows above a dragged utility window. The workflow prompt fullscreen overlay is itself a floating utility surface and claims `nextFloatingZ()` when opened, because a static z 10000 fallback is hidden by the workflow editor's full-screen mobile FloatingWindow sheet. The counter is module-level and intentionally monotonic: it only ever climbs, which is fine for a session-length dashboard. All floating overlays are `pointer-events: none` (click-through) so raising panels into this shared band never traps clicks on the page behind them. CRITICAL: every floating modal must be portaled to document.body so this shared z is compared in ONE root stacking context (an inline panel cannot beat siblings outside its own context no matter its z).

FNXC:TaskPopupLayer 2026-09-14-11:35:
Task-detail and Chat work windows are interaction-stack peers: the most recently mounted or engaged peer is on top.

FNXC:FloatingWindowStack 2026-09-14-21:10:
FN-394 merges the former lower task/Chat band into this ONE counter. A newly opened window must appear in
front of every other window whatever its type and whatever placement the others hold (snapped column,
filled work area, or floating), which a permanently lower band made impossible. The task-detail entry
points are kept as named aliases so existing callers and their contracts continue to compile, but there
are no longer two competing counters. `--fusion-max-z` still follows the single ceiling, so the plugin
layer stays above every dashboard-managed window.

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

/*
FNXC:FloatingWindowGestureLayer 2026-09-18-02:21:
FN-523 : « la modale qu'on drag devrait forcément avoir un z-index supérieur à la popover puisque c'est le dernier
élément sélectionné ». Une fenêtre ne peut pas y parvenir par une simple revendication au compteur : les surfaces
TRANSITOIRES dérivent leur couche du plafond VIVANT (`calc(var(--fusion-max-z) + N)`, styles.css) et `syncFusionMaxZ`
publie `Math.max(topZ, FUSION_MAX_Z_FLOOR)`, donc toute revendication au compteur reste structurellement SOUS elles.

Pendant un geste à pointeur CAPTURÉ — et pour sa durée exacte — la fenêtre saisie revendique donc une couche
strictement au-dessus de toute la bande transitoire documentée : panneau (`+ 3`), contrôle global de visibilité
(`+ 4`, réservé), menu d'action éphémère FN-521 (`+ 5` / `+ 6`), d'où `+ 7`. Aucun pas réservé n'est repris et aucune
règle CSS n'est déplacée. Recouvrir temporairement ces surfaces est sans conséquence d'interaction : le pointeur est
capturé par la fenêtre, donc aucune autre surface ne peut recevoir d'entrée, et une popover comme un menu éphémère se
referment de toute façon sur l'appui qui démarre le geste.

Deux invariants tiennent cette valeur : elle n'INCRÉMENTE PAS `topZ` et n'est JAMAIS publiée dans `--fusion-max-z`
(sinon la bande transitoire la poursuivrait à chaque geste, indéfiniment), et elle n'est pas publiée dans l'ordre de
pile du gestionnaire de fenêtres, qui continue de voir la revendication ordinaire.
*/
export const GESTURE_LAYER_OFFSET = 7;

/** Layer claimed by a window engaged in a pointer gesture, for the duration of that gesture only. Never published. */
export function engagedGestureZ(): number {
  return Math.max(topZ, FUSION_MAX_Z_FLOOR) + GESTURE_LAYER_OFFSET;
}

/*
FNXC:FloatingWindowStack 2026-09-15-04:01:
FN-401: the snap-zone preview claims the TOP of this single stack. It used to be painted inside its own
window's overlay, whose inline `z-index` opens a closed stacking context, so the board or any other window
could cover the very affordance that tells the operator where the window is about to land. As a top claim in
the one shared counter it always paints above the board and above every other window, and `--fusion-max-z`
keeps following the ceiling so the plugin layer remains above the whole dashboard.
*/
export function nextSnapPreviewZ(): number {
  return nextFloatingZ();
}

/** Claim the front of the shared window stack from a task/Chat work surface. Alias of `nextFloatingZ` since FN-394. */
export function nextTaskDetailFloatingZ(): number {
  return nextFloatingZ();
}

/** Current top of the shared window stack, read from a task/Chat work surface. Alias of `currentFloatingZ` since FN-394. */
export function currentTaskDetailFloatingZ(): number {
  return currentFloatingZ();
}
