import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DashboardWindowSurfaceRoot } from "../context/DashboardWindowManagerContext";
import { useOutsidePointerDismiss } from "../hooks/useOutsidePointerDismiss";
import "./DashboardToolPopover.css";

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
const DEFAULT_WIDTH = 420;
/** Floor the panel never shrinks below; also the threshold under which the space below an anchor is unusable. */
const MIN_PANEL_BLOCK_SIZE = 200;

/**
 * Horizontal alignment strategy. `anchor-end` aligns the panel's right edge with the trigger's right edge;
 * `viewport-end` aligns it with the viewport's right edge (minus `VIEWPORT_MARGIN`).
 */
export type ToolPopoverAlign = "anchor-end" | "viewport-end";

export interface ToolPopoverGeometryInput {
  anchorRect: DOMRect | null;
  viewport: { width: number; height: number };
  width: number;
  preferredHeight?: number;
  align?: ToolPopoverAlign;
}

export interface ToolPopoverGeometry {
  placement: "above" | "below";
  /** Emitted only for `below`; `above` panels are anchored by `bottom` so the two are never written together. */
  top?: number;
  /** Emitted only for `above`. */
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
  /** Emitted only when a caller asked for a definite height; otherwise the panel stays content-sized. */
  height?: number;
}

/*
FNXC:ToolSurfaces 2026-09-15-20:24:
FN-433: this panel is anchored to a HEADER trigger (Activity, Notes) in two cases and to the BOTTOM-BAR trigger
(`desktop-nav-chat-panel` in DesktopActionBar, whose bar is `position: fixed; bottom: 0`) in the third. The original
geometry placed the panel unconditionally below its anchor, which is correct only for a header trigger: for the footer
trigger `anchorRect.bottom` is ~`window.innerHeight`, so the panel was laid out flush against the bottom edge with its
height collapsed to the floor — present in the DOM, entirely off-screen. The operator clicked Chat and saw nothing.

Placement is therefore resolved from MEASURED geometry, never from a CSS `@media` guess: stay `below` by default, and
flip to `above` only when the space below the anchor is unusable (< MIN_PANEL_BLOCK_SIZE) AND there is more room above.
The `below` branch keeps the exact prior arithmetic so header anchors are a byte-for-byte non-regression.

FNXC:ToolSurfaces 2026-09-15-22:15:
FN-436 : l'alignement horizontal devient une option explicite. Aligner le bord droit du panneau sur celui de l'ANCRE
est correct pour les déclencheurs d'en-tête (Activité, Notes), mais pas pour Chat : son bouton `desktop-nav-chat-panel`
vit dans `.desktop-action-bar__right` et est SUIVI de Terminal (FN-469 a retiré Réglages de ce groupe) puis de la
réserve de la bascule de visibilité des fenêtres,
donc son bord droit est à plusieurs centaines de pixels de la bordure de l'écran et la popover s'ouvrait « trop à
gauche ». `viewport-end` colle le panneau au bord droit du viewport (à `VIEWPORT_MARGIN` près) ; l'option reste opt-in
et le défaut `anchor-end` conserve exactement l'arithmétique précédente, pour que les ancres d'en-tête ne régressent pas.
Les deux branches restent bornées au viewport, donc aucune ne peut faire déborder le panneau.
*/
export function resolveToolPopoverGeometry({ anchorRect, viewport, width, preferredHeight, align = "anchor-end" }: ToolPopoverGeometryInput): ToolPopoverGeometry {
  const resolvedWidth = Math.min(width, Math.max(240, viewport.width - VIEWPORT_MARGIN * 2));
  const anchorBottom = anchorRect?.bottom ?? VIEWPORT_MARGIN;
  const anchorRight = anchorRect?.right ?? viewport.width - VIEWPORT_MARGIN;
  const left = align === "viewport-end"
    ? Math.max(VIEWPORT_MARGIN, viewport.width - resolvedWidth - VIEWPORT_MARGIN)
    : Math.max(VIEWPORT_MARGIN, Math.min(anchorRight - resolvedWidth, viewport.width - resolvedWidth - VIEWPORT_MARGIN));

  // A stale rect can report an anchor below the current viewport; clamping keeps the flipped panel inside it.
  const anchorTop = Math.min(anchorRect?.top ?? VIEWPORT_MARGIN, viewport.height);
  const spaceBelow = viewport.height - anchorBottom - ANCHOR_GAP - VIEWPORT_MARGIN;
  const spaceAbove = anchorTop - ANCHOR_GAP - VIEWPORT_MARGIN;

  if (spaceBelow < MIN_PANEL_BLOCK_SIZE && spaceAbove > spaceBelow) {
    const maxHeight = Math.max(MIN_PANEL_BLOCK_SIZE, spaceAbove);
    return {
      placement: "above",
      bottom: Math.max(VIEWPORT_MARGIN, viewport.height - anchorTop + ANCHOR_GAP),
      left,
      width: resolvedWidth,
      maxHeight,
      height: resolveDefiniteHeight(preferredHeight, maxHeight),
    };
  }

  const top = Math.max(VIEWPORT_MARGIN, anchorBottom + ANCHOR_GAP);
  const maxHeight = Math.max(MIN_PANEL_BLOCK_SIZE, viewport.height - top - VIEWPORT_MARGIN);
  return {
    placement: "below",
    top,
    left,
    width: resolvedWidth,
    maxHeight,
    height: resolveDefiniteHeight(preferredHeight, maxHeight),
  };
}

/*
FNXC:ToolSurfaces 2026-09-15-20:24:
FN-433: `preferredHeight` is opt-in because Activity and Notes are content-sized and must stay so — when it is absent no
`height` style is emitted at all. Chat needs it: `.chat-view` declares `height: 100%` and its conversation list is
virtualized through `useVirtualizedList`, which measures `container.clientHeight`. Inside a parent of indefinite height
the `min-block-size: 0` / `overflow: hidden` flex body collapses, so the list would have no measurable viewport and
render no visible rows. The available space always wins, so a definite height can never push the panel off-screen.
*/
function resolveDefiniteHeight(preferredHeight: number | undefined, maxHeight: number): number | undefined {
  if (preferredHeight === undefined) return undefined;
  return Math.min(preferredHeight, maxHeight);
}

export interface DashboardToolPopoverProps {
  /** Rendered only while true; the body is unmounted on close so it holds no polling or subscriptions. */
  open: boolean;
  onClose: () => void;
  /** Live rect of the trigger. Re-read on every open so a moved header re-anchors correctly. */
  anchorRect: DOMRect | null;
  /** Accessible name of the panel. */
  ariaLabel: string;
  /** Id shared with the trigger's `aria-controls`. */
  id: string;
  testId?: string;
  width?: number;
  /** Opt-in definite block size, bounded by the available space. Omit it to keep the panel content-sized. */
  preferredHeight?: number;
  /** Opt-in horizontal alignment; defaults to aligning the panel's right edge with the trigger's. */
  align?: ToolPopoverAlign;
  children: ReactNode;
}

/*
FNXC:ToolSurfaces 2026-09-15-16:04:
FN-426 needs a reusable header-anchored panel for Activity and Notes, the two tools whose canonical host used to be
the right dock. It reuses the SHAPE the Usage popover established — body portal, `--fusion-max-z` derived layering —
rather than its business logic or its hard-coded sizing constants, which belong to Usage.

Contract:
- The body mounts only while open, so a closed panel runs no polling, no timers, and no subscriptions.
- Geometry is bounded to the viewport and recomputed on resize, so a narrow or short window never pushes the panel
  off-screen; the panel owns a bounded internal scroll (`min-block-size: 0` on its body) instead of growing.
- Escape and an outside pointer close it and return focus to the trigger, and a portalled CHILD (a select popup, a
  nested menu) must not trigger that dismissal.

FNXC:ToolSurfaces 2026-09-17-05:48:
FN-491 : le panneau est NON modal (`aria-modal="false"`) et ne doit donc JAMAIS geler le tableau derrière lui. La
protection précédente était une vitre plein écran (`.dashboard-tool-popover__backdrop`, `position: fixed; inset: 0`)
dont le seul rôle était de recevoir le clic extérieur ; elle interceptait du même coup la molette, le défilement
tactile et tous les clics, si bien qu'un clic sur une carte ne faisait que refermer le panneau sans atteindre sa
cible. Cet élément est supprimé : plus aucun calque n'est monté, et la fermeture au clic extérieur appartient
désormais au hook partagé `useOutsidePointerDismiss`, seul propriétaire de la règle pour les quatre panneaux
concernés (Conversations, Activité, Notes, Usage). L'appartenance « intérieur » y est marquée par IDENTITÉ
D'ÉVÉNEMENT à travers l'arbre React — portails compris — ce qui garde un enfant portalisé utilisable, et la garde
`triggerSelector` (l'`aria-controls` du déclencheur) évite le cycle fermeture-puis-réouverture d'un déclencheur à
bascule. Le défilement ne ferme jamais.
*/
export function DashboardToolPopover({ open, onClose, anchorRect, ariaLabel, id, testId, width = DEFAULT_WIDTH, preferredHeight, align, children }: DashboardToolPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Called unconditionally, before the closed early-return, so the hook order never changes between renders.
  const { onPointerDownCapture } = useOutsidePointerDismiss({
    open,
    onDismiss: onClose,
    surfaceRefs: [panelRef],
    triggerSelector: `[aria-controls="${id}"]`,
  });
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));

  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  Re-anchoring on resize is what keeps the panel usable when a virtual keyboard shrinks the visual viewport or the
  window is narrowed; without it the panel keeps the geometry of the width it was opened at.
  */
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  Capture and move focus in ONE layout effect, in that order. Capturing in a passive effect reads `document.activeElement`
  AFTER the panel has already taken focus, so dismissal would "restore" focus to the panel that is being unmounted and
  the operator would lose their place in the header.
  */
  useLayoutEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const trigger = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  }, [onClose]);

  if (!open) return null;

  const geometry = resolveToolPopoverGeometry({ anchorRect, viewport, width, preferredHeight, align });

  return createPortal(
    <DashboardWindowSurfaceRoot logicalId={id} group="dialog" className="dashboard-window-surface-root--contents">
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-label={ariaLabel}
        aria-modal="false"
        tabIndex={-1}
        className="dashboard-tool-popover"
        data-testid={testId}
        data-placement={geometry.placement}
        onKeyDown={handleKeyDown}
        onPointerDownCapture={onPointerDownCapture}
        style={{ top: geometry.top, bottom: geometry.bottom, left: geometry.left, width: geometry.width, maxHeight: geometry.maxHeight, height: geometry.height }}
      >
        <div className="dashboard-tool-popover__body">{children}</div>
      </div>
    </DashboardWindowSurfaceRoot>,
    document.body,
  );
}

export default DashboardToolPopover;
