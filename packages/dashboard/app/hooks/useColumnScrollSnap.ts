import { useEffect, useState } from "react";
import { BOARD_SCROLL_RESTORE_EVENT } from "../utils/boardScrollSnapshot";
import { isMobileViewport } from "./useViewportMode";

/*
FNXC:BoardNavigation 2026-07-22-18:00:
Wrong-way snaps came from (1) settle direction using the last micro scroll tick — iOS
rubber-band/fling end often reverses for a frame — and (2) origin±nearest hybrid targets.
Direction is locked at finger-up from net gesture delta only (never post-lift ticks). Target
is always the next column in that scroll direction from the current viewport (classic
directional page snap). The controlled animation kills residual fling, and a BOUNDED pin
(FN-398: PIN_MAX_REASSERT_MS, PIN_DRIFT_TOLERANCE_PX, released by any user intent) closes the
last compositor write without ever vetoing a real scroll.

FNXC:BoardNavigation 2026-07-22-15:10:
A tap during post-lift momentum must cancel the pending directional settle and re-baseline
the gesture at the current scrollLeft (pointerHeld true). Otherwise the original swipe's
idle timer would settle the board away from where the user stopped.

FNXC:BoardNavigation 2026-07-22-15:26:
After any user touch sequence ends, the board must rest on exactly one column center — never
between columns. Tap-to-stop and zero-pan lifts animate to the nearest center (not the cancelled
swipe's directional page), with hard writes reserved for reduced motion, unavailable animation,
negligible distance, and compositor fencing. Directional paging still applies only when the settle
gesture itself had pan intent.
*/
/*
FNXC:BoardNavigation 2026-09-17-09:49:
FN-500 : ce repli d'inactivité est RÉSERVÉ aux flux sans événement de lever — molette horizontale en
premier lieu. Un swipe touch/pen terminé ne l'attend jamais (il pagine au lever), donc la fenêtre peut
être assez longue pour qu'une rafale de molette compte comme UN geste au lieu d'une page par cran.
*/
/**
 * Fallback quiet window for settles that cannot page at lift (wheel, net-zero direction).
 * Directional finger swipes never wait on it — see `commitDirectionalPage`.
 */
const SCROLL_IDLE_SETTLE_MS = 120;
const CENTER_TOLERANCE_PX = 1;
/** Minimum finger travel to count as a horizontal pan (short swipe still commits). */
const MIN_PAN_CLIENT_PX = 12;
/** Keep a WebKit compositor write from outliving the main-thread hard jump. */
const PIN_REASSERT_INTERVAL_MS = 16;
/*
FNXC:BoardNavigation 2026-09-14-20:19:
FN-398 : l'épingle est une CLÔTURE BORNÉE du dernier write compositeur, pas un veto permanent. Elle ne durait
auparavant que « jusqu'au prochain toucher » : un pan souris, un défilement clavier ou une restauration
programmatique (`restoreBoardScroll`) était donc annulé et le tableau se remettait de force sur la colonne
aimée. Le write compositeur tardif qu'elle corrige arrive en quelques frames, ce qui est borné.
*/
export const PIN_MAX_REASSERT_MS = 160;
/**
 * Écart maximal, en px, encore attribuable à une dérive compositeur.
 *
 * Au-delà, l'écart décrit un défilement réel : l'épingle est libérée et le défilement n'est jamais annulé.
 * La valeur doit rester au-dessus de la dérive réellement observée sur WebKit — les fixtures iOS existantes
 * modélisent un tick de fling résiduel de 40 px — tout en restant très en deçà d'un saut de colonne, pour qu'une
 * restauration programmatique ou un pan souris soit toujours classé comme défilement réel.
 */
export const PIN_DRIFT_TOLERANCE_PX = 48;

/*
FNXC:BoardNavigation 2026-07-24-11:20:
Board paging must feel fast, and the slow part was never the settle timer — it was waiting for the
BROWSER's fling to decelerate before paging (native inertia can coast for most of a second, so a
flick sat visibly drifting before it committed). The hook owns the momentum: at finger-up a
directional swipe kills native inertia and animates to its target column itself, so the page starts
moving on lift instead of after the coast.

Trade-off accepted: tap-to-stop-during-momentum no longer exists as an interaction (there is no
long coast left to interrupt). A re-touch during the page animation cancels it and hands control
back to the finger, which covers the same corrective intent.

FNXC:BoardNavigation 2026-09-17-09:49:
FN-500 : la REACH dérivée de la vitesse est supprimée. Un téléphone se déplace colonne par colonne, pas
librement comme un ordinateur : un geste validé depuis une colonne au repos rejoint SA SEULE voisine,
quelle que soit la vitesse ou la longueur du geste (plusieurs colonnes = plusieurs gestes). Le quota
1–3 pages faisait sauter le tableau par-dessus la colonne visée, ce que l'opérateur décrit comme un
déplacement « sec ». La durée unique passe de 190 à 280 ms avec un profil accelération/décélération,
parce qu'une seule constante de durée ne suffisait pas : c'est le couple « une voisine + courbe douce
depuis la position réellement atteinte » qui rend le mouvement fluide.
*/
/** Duration of the owned single-column transition, in ms. */
export const PAGE_ANIMATION_MS = 280;
/** Below this the animation is pointless — jump. */
const MIN_ANIMATED_DISTANCE_PX = 2;

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/**
 * Ease-in-out cubic: progressive departure and progressive arrival.
 *
 * FNXC:BoardNavigation 2026-09-17-09:49:
 * FN-500 : l'ancien ease-out démarrait à pleine vitesse, donc la reprise de l'axe au lever se voyait
 * comme un à-coup même quand aucune téléportation n'avait lieu. La courbe reste monotone et sans
 * dépassement entre la position de lever et l'ancrage, avec arrivée exacte.
 */
export function easeInOutCubic(progress: number): number {
  const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2;
}

export interface UseColumnScrollSnapOptions {
  /** Restrict magnetic snapping to phone-class viewports. */
  mobileOnly?: boolean;
  /** Test seam; production callers must use the default trusted-event predicate. */
  isUserInteraction?: (event: Event) => boolean;
  /*
  FNXC:BoardNavigation 2026-09-17-09:49:
  FN-500 : le tableau n'est pas toujours la vue visible (`MainViewKeepAlive` conserve des vues montées)
  et son contenu change de projet ou de sélection de workflow. `enabled` retire complètement le
  propriétaire d'une vue inactive, `contextKey` fait d'un changement de contexte une annulation
  propre : l'ancienne interaction est clôturée et ses callbacks deviennent inertes avant que les
  nouvelles colonnes soient arbitrées.
  */
  enabled?: boolean;
  contextKey?: string;
}

function defaultIsUserInteraction(event: Event): boolean {
  return event.isTrusted;
}

function isMousePointerEvent(event: Event): boolean {
  return "pointerType" in event && (event as PointerEvent).pointerType === "mouse";
}

function addMediaChangeListener(query: MediaQueryList, listener: () => void): () => void {
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }
  query.addListener(listener);
  return () => query.removeListener(listener);
}

function getClientPoint(event: Event): { x: number; y: number } | null {
  if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  if ("clientX" in event && typeof (event as PointerEvent).clientX === "number") {
    return { x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY };
  }
  return null;
}

/*
FNXC:BoardNavigation 2026-09-17-09:49:
FN-500 : les ancrages magnétiques doivent être des COLONNES RÉELLES, toujours. L'ancien repli
« moins de deux `.column` → tous les enfants » faisait d'un élément de chrome (bandeau, message vide,
espaceur) une cible d'aimant dès qu'un tableau n'avait qu'une colonne, donc le board pouvait se figer
sur une position qui n'est pas une colonne. Zéro ou une colonne est maintenant un résultat légitime :
l'appelant traite l'absence de cible comme « ne rien animer » plutôt que comme une invitation à viser
n'importe quel enfant. Les éléments explicitement masqués sont exclus ; la mesure (largeur nulle en DOM
de test) ne sert PAS de critère d'exclusion, sinon un vrai `Board` rendu sans layout perdrait ses cibles.
*/
export function getSnapColumns(scroller: HTMLElement): HTMLElement[] {
  return Array.from(scroller.children).filter(
    (node): node is HTMLElement =>
      node instanceof HTMLElement
      && node.classList.contains("column")
      && !node.hidden
      && node.getAttribute("aria-hidden") !== "true"
      && node.style.display !== "none",
  );
}

/*
FNXC:BoardNavigation 2026-09-17-09:49:
FN-500 : sélection ET validation partagent désormais une seule géométrie — la liste des positions
ATTEIGNABLES (`scrollLeft` bornés) des colonnes réelles. Un pas fixe, une largeur d'écran globale ou une
borne infinie produisaient des cibles que le navigateur ré-écrête ensuite, donc un arrêt « entre deux
colonnes ». Les positions confondues après bornage (colonnes de bord plus étroites que le viewport) ne
sont qu'un seul arrêt atteignable : c'est cette liste dédoublonnée qui définit la « voisine ».
*/
export function resolveColumnAnchors(scroller: HTMLElement, columns: HTMLElement[]): number[] {
  return columns.map((column) => scrollLeftToCenterColumn(scroller, column));
}

/**
 * Index of the reachable column anchor closest to the current scroll position.
 *
 * FNXC:BoardNavigation 2026-09-17-09:49:
 * FN-500 : À ÉGALE DISTANCE SEULEMENT, la direction nette du geste courant départage les deux cibles
 * (les ancrages sont croissants, donc un geste vers la droite prend l'index supérieur). Hors égalité,
 * la distance seule décide : les derniers petits rebonds ne changent pas la décision.
 */
export function nearestAnchorIndex(scrollLeft: number, anchors: number[], direction = 0): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < anchors.length; index++) {
    const distance = Math.abs(anchors[index] - scrollLeft);
    if (distance < nearestDistance - CENTER_TOLERANCE_PX / 2) {
      nearestIndex = index;
      nearestDistance = distance;
    } else if (direction > 0 && Math.abs(distance - nearestDistance) <= CENTER_TOLERANCE_PX / 2) {
      nearestIndex = index;
      nearestDistance = Math.min(nearestDistance, distance);
    }
  }
  return nearestIndex;
}

/** Index of the column whose reachable anchor is closest to the current scroll position. */
export function nearestColumnIndex(scroller: HTMLElement, columns: HTMLElement[]): number {
  const scrollerRect = scroller.getBoundingClientRect();
  const viewportWidth = scroller.clientWidth || scrollerRect.width;
  if (viewportWidth <= 0 || columns.length === 0) return 0;
  return nearestAnchorIndex(scroller.scrollLeft, resolveColumnAnchors(scroller, columns));
}

/**
 * Reachable anchor of the single neighbouring column in `direction` from `originIndex`.
 *
 * FNXC:BoardNavigation 2026-09-17-09:49:
 * FN-500 : « colonne par colonne » se mesure sur les ancrages DISTINCTS. Aux extrémités, plusieurs
 * colonnes partagent la même position atteignable ; avancer d'un index y serait un déplacement nul et
 * le geste suivant paraîtrait perdu. On avance donc jusqu'au premier ancrage réellement différent, et
 * on reste sur place quand il n'y en a plus (borne du tableau).
 */
export function resolveNeighborAnchor(options: {
  anchors: number[];
  originIndex: number;
  direction: number;
  tolerance?: number;
}): number | null {
  const { anchors, originIndex, direction, tolerance = CENTER_TOLERANCE_PX } = options;
  if (anchors.length === 0) return null;
  const origin = Math.min(Math.max(originIndex, 0), anchors.length - 1);
  const originAnchor = anchors[origin];
  if (direction === 0) return originAnchor;
  for (
    let index = origin + direction;
    index >= 0 && index < anchors.length;
    index += direction
  ) {
    if (Math.abs(anchors[index] - originAnchor) > tolerance) return anchors[index];
  }
  return originAnchor;
}

/*
FNXC:BoardNavigation 2026-07-26-09:15:
A swipe starting on the FAR-LEFT column jumped two columns while the same swipe mid-board moved one.
Cause: columns are narrower than the phone viewport, so the edge columns' ideal centered scrollLeft
falls OUTSIDE the reachable range (negative at the left edge, past max at the right edge). The board
therefore never read as "centered" while resting at an edge, `gestureStartCentered` was false, and
`commitDirectionalPage` fell back to taking its origin at RELEASE — which had already advanced onto
the next column — so the +1 page landed two columns over.
Clamping the centering target to the reachable scroll range makes an edge rest count as centered
(rest position IS the column's reachable center), so edge swipes page exactly one column like every
other position. It also stops `applySnapTo` from pinning an unreachable value, which left the pin
watchdog hard-jumping to a scrollLeft the browser keeps clamping away.
*/
/**
 * scrollLeft that centers `column` in the scroller viewport (integer pixels), clamped to the
 * scroller's reachable range so edge columns resolve to the position they actually rest at.
 *
 * FNXC:BoardNavigation 2026-09-17-09:49:
 * FN-500 : le bornage supérieur n'est plus conditionnel. L'ancienne exception « `scrollWidth`
 * inutilisable → borne infinie » existait pour des fixtures jsdom qui omettaient `scrollWidth` ; en
 * production elle autorisait une cible inatteignable, que le navigateur ramène ailleurs — exactement
 * l'arrêt intermédiaire que ce correctif interdit. Les fixtures déclarent désormais leur `scrollWidth`.
 * Un tableau sans débordement a donc un seul ancrage atteignable : 0.
 */
export function scrollLeftToCenterColumn(scroller: HTMLElement, column: HTMLElement): number {
  const scrollerRect = scroller.getBoundingClientRect();
  const viewportWidth = scroller.clientWidth || scrollerRect.width;
  const viewportCenter = scrollerRect.left + viewportWidth / 2;
  const columnRect = column.getBoundingClientRect();
  const ideal = Math.round(
    scroller.scrollLeft + columnRect.left + columnRect.width / 2 - viewportCenter,
  );
  const upperBound = Math.max(0, scroller.scrollWidth - viewportWidth);
  return Math.min(Math.max(ideal, 0), upperBound);
}

/** Whether the viewport is already resting on one of its reachable column anchors. */
export function isColumnCentered(
  scroller: HTMLElement,
  columns: HTMLElement[],
  tolerance = CENTER_TOLERANCE_PX,
): boolean {
  if (columns.length === 0) return false;
  const anchors = resolveColumnAnchors(scroller, columns);
  const nearest = nearestAnchorIndex(scroller.scrollLeft, anchors);
  return Math.abs(scroller.scrollLeft - anchors[nearest]) <= tolerance;
}

/**
 * Resolve pan direction from the full gesture (net deltas only).
 * Do NOT pass last micro-tick direction for settle — rubber-band flips it.
 * +1 = scroll right / next columns, -1 = scroll left / previous.
 *
 * FNXC:BoardNavigation 2026-07-22-21:40:
 * Finger travel counts as horizontal pan intent only when it dominates the vertical axis —
 * a vertical card-list scroll with incidental diagonal drift must not page the board.
 * The board's own horizontal scrollDelta stays authoritative regardless of finger axis.
 */
export function resolvePanDirection(options: {
  scrollDelta: number;
  /** gestureStartClientX - endClientX: finger left → positive → next column */
  clientDelta: number;
  /** gestureStartClientY - endClientY: vertical finger travel for axis dominance. */
  clientDeltaY?: number;
}): number {
  const { scrollDelta, clientDelta, clientDeltaY = 0 } = options;
  if (scrollDelta > CENTER_TOLERANCE_PX) return 1;
  if (scrollDelta < -CENTER_TOLERANCE_PX) return -1;
  if (Math.abs(clientDelta) <= Math.abs(clientDeltaY)) return 0;
  if (clientDelta >= MIN_PAN_CLIENT_PX) return 1;
  if (clientDelta <= -MIN_PAN_CLIENT_PX) return -1;
  return 0;
}

/**
 * Kill residual scroll inertia and jump to an integer scrollLeft.
 */
function hardJumpScrollLeft(scroller: HTMLElement, targetLeft: number): void {
  const target = Math.round(targetLeft);
  const priorOverflowX = scroller.style.overflowX;
  const priorBehavior = scroller.style.scrollBehavior;
  const priorWebkit = scroller.style.getPropertyValue("-webkit-overflow-scrolling");

  scroller.style.scrollBehavior = "auto";
  scroller.style.scrollSnapType = "none";
  scroller.style.overflowX = "hidden";
  scroller.style.setProperty("-webkit-overflow-scrolling", "auto");
  scroller.scrollLeft = target;
  void scroller.offsetWidth;
  scroller.scrollLeft = target;

  scroller.style.overflowX = priorOverflowX;
  scroller.style.scrollBehavior = priorBehavior;
  if (priorWebkit) {
    scroller.style.setProperty("-webkit-overflow-scrolling", priorWebkit);
  } else {
    scroller.style.removeProperty("-webkit-overflow-scrolling");
  }
  scroller.scrollLeft = target;
}

/**
 * Mobile board: free-scroll while held, then settle to one reachable column in the locked
 * direction.
 *
 * FNXC:BoardNavigation 2026-07-22-18:00:
 * Lock settle direction at finger-up from net gesture deltas. Pin until next touch.
 *
 * FNXC:BoardNavigation 2026-07-22-21:05:
 * Target via resolveSettleTargetIndex: nearest (mostly-on-screen) column, clamped to at least
 * one column of progress from the gesture's origin column — commits short swipes without
 * overshooting a fling that already decelerated onto a column.
 *
 * FNXC:BoardNavigation 2026-08-18-19:10:
 * Phone releases use one controlled normal-motion settle for both directional and nearest-column
 * corrections. Exact reachable landing, reduced-motion immediacy, and compositor pin fencing stay
 * unchanged while the release no longer visibly hard-jumps.
 */
export function useColumnScrollSnap(
  scroller: HTMLElement | null,
  {
    mobileOnly = false,
    isUserInteraction = defaultIsUserInteraction,
    enabled = true,
    contextKey = "",
  }: UseColumnScrollSnapOptions = {},
): void {
  const [isEligibleViewport, setIsEligibleViewport] = useState(() => !mobileOnly || isMobileViewport());

  useEffect(() => {
    if (!mobileOnly || typeof window === "undefined") return;

    const updateEligibility = () => setIsEligibleViewport(isMobileViewport());
    const widthQuery = window.matchMedia("(max-width: 768px)");
    const heightQuery = window.matchMedia("(max-height: 480px)");
    const removeWidthListener = addMediaChangeListener(widthQuery, updateEligibility);
    const removeHeightListener = addMediaChangeListener(heightQuery, updateEligibility);
    const visualViewport = window.visualViewport;

    window.addEventListener("resize", updateEligibility);
    window.addEventListener("orientationchange", updateEligibility);
    visualViewport?.addEventListener("resize", updateEligibility);
    updateEligibility();

    return () => {
      removeWidthListener();
      removeHeightListener();
      window.removeEventListener("resize", updateEligibility);
      window.removeEventListener("orientationchange", updateEligibility);
      visualViewport?.removeEventListener("resize", updateEligibility);
    };
  }, [mobileOnly]);

  useEffect(() => {
    if (!scroller || !isEligibleViewport || !enabled) return;

    let interactionActive = false;
    let pointerHeld = false;
    /*
    FNXC:BoardNavigation 2026-07-22-20:10:
    iOS/Android fire `pointercancel` when the native scroll pan claims a touch, but the TOUCH
    stream (touchmove/touchend) keeps going. Treating that pointercancel as gesture end either
    orphaned the gesture (early cancel, no movement yet → interactionActive false → the later
    touchend no-ops and the board rests mid-column until the next tap) or armed the idle settle
    while the finger was still down (slow drag with a brief pause hard-jumped/fought the finger,
    worst at the edge columns where rubber-band makes WebKit claim the pan aggressively).
    Track whether a touch sequence is live and ignore pointercancel while it is — touchend is
    the real finger lift. touchcancel remains a genuine gesture cancel.
    */
    let touchSequenceActive = false;
    let gestureStartScrollLeft = scroller.scrollLeft;
    /** Column the viewport rested on when the gesture began — the paging baseline. */
    let gestureStartColumnIndex = 0;
    /*
    FNXC:BoardNavigation 2026-07-22-21:40:
    The commit-one-column paging rule assumes the gesture began AT REST centered on its origin
    column. A re-touch mid-transit (tap-to-stop during momentum, then drag) is not at rest: the
    forced min-one-column progress from a mid-transit origin overrode the user's corrective drag
    and paged past where they dragged. Such gestures settle on the plain nearest column instead —
    the new drag's landing point always wins over the interrupted scroll.
    */
    let gestureStartCentered = true;
    let lastScrollLeft = scroller.scrollLeft;
    let gestureStartClientX: number | null = null;
    let lastClientX: number | null = null;
    let gestureStartClientY: number | null = null;
    let lastClientY: number | null = null;
    /** Locked at finger-up / cancel — never updated by post-lift rubber-band ticks. */
    let lockedDirection = 0;
    let sawHorizontalMovement = false;
    let nativeSnapSuspended = false;
    let priorInlineScrollSnapType = "";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let capturedPointerId: number | null = null;
    /** Bounded compositor fence: force scrollLeft only for late compositor drift, never a real scroll. */
    let pinnedScrollLeft: number | null = null;
    /** Corrects late WebKit compositor writes, bounded by PIN_MAX_REASSERT_MS. */
    let pinReassertTimer: ReturnType<typeof setTimeout> | null = null;
    /** Wall-clock start of the current pin, used to close the bounded fence. */
    let pinStartedAt = 0;
    /*
    FNXC:BoardNavigation 2026-09-17-09:49:
    FN-500 : une rafale de molette horizontale n'a pas d'événement de lever. Ses crans successifs
    doivent donc prolonger le MÊME geste — origine conservée, repli d'inactivité réarmé — et non
    rebaseliner une nouvelle origine à chaque tick, ce qui aurait validé une page par cran.
    */
    let wheelBurstActive = false;
    /*
    FNXC:BoardNavigation 2026-09-17-09:49:
    FN-500 : chaque interaction porte une génération. Un nouveau toucher, une souris, une intention
    clavier, une rafale de molette, une restauration programmatique ou un changement de contexte
    l'incrémentent, ce qui rend inertes les callbacks différés (frames d'animation, échéances) de
    l'ancien propriétaire avant toute écriture.
    */
    let interactionGeneration = 0;
    /** rAF handle for the hook-owned page animation. */
    let pageAnimationFrame: number | null = null;
    /** Inline styles frozen for the duration of the page animation. */
    let animationStyleRestore: (() => void) | null = null;

    const clearIdleTimer = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
    };

    const clearPinReassertion = () => {
      if (pinReassertTimer !== null) clearTimeout(pinReassertTimer);
      pinReassertTimer = null;
    };

    const restoreNativeSnap = () => {
      if (!nativeSnapSuspended) return;
      scroller.style.scrollSnapType = priorInlineScrollSnapType;
      nativeSnapSuspended = false;
    };

    const suspendNativeSnap = () => {
      if (nativeSnapSuspended) return;
      priorInlineScrollSnapType = scroller.style.scrollSnapType;
      scroller.style.scrollSnapType = "none";
      nativeSnapSuspended = true;
    };

    const releasePointerCapture = () => {
      if (capturedPointerId === null) return;
      try {
        if (scroller.hasPointerCapture?.(capturedPointerId)) {
          scroller.releasePointerCapture(capturedPointerId);
        }
      } catch {
        // already released
      }
      capturedPointerId = null;
    };

    const clearPin = () => {
      clearPinReassertion();
      pinnedScrollLeft = null;
      pinStartedAt = 0;
    };

    /**
     * True when `scrollLeft` differs from the pin by more than late compositor drift.
     *
     * FNXC:BoardNavigation 2026-09-14-20:19:
     * FN-398: a difference beyond the tolerance describes a REAL scroll (mouse pan, keyboard, or a
     * programmatic board-scroll restore). Rewriting it was the board-side "my scroll is taken away".
     */
    const isRealScrollAwayFromPin = (): boolean =>
      pinnedScrollLeft !== null && Math.abs(scroller.scrollLeft - pinnedScrollLeft) > PIN_DRIFT_TOLERANCE_PX;

    /** Applies the bounded fence to a scroll/scrollend tick. Returns true when the tick was absorbed. */
    const absorbTickWithPin = (): boolean => {
      if (pinnedScrollLeft === null) return false;
      if (now() - pinStartedAt > PIN_MAX_REASSERT_MS || isRealScrollAwayFromPin()) {
        clearPin();
        return false;
      }
      scroller.scrollLeft = pinnedScrollLeft;
      return true;
    };

    /**
     * Freeze direction from the whole gesture (net scroll + finger travel).
     * Called once at lift/cancel — not on later scroll ticks.
     */
    const lockDirectionFromGesture = () => {
      const scrollDelta = scroller.scrollLeft - gestureStartScrollLeft;
      const clientDelta =
        gestureStartClientX !== null && lastClientX !== null
          ? gestureStartClientX - lastClientX
          : 0;
      const clientDeltaY =
        gestureStartClientY !== null && lastClientY !== null
          ? gestureStartClientY - lastClientY
          : 0;
      lockedDirection = resolvePanDirection({ scrollDelta, clientDelta, clientDeltaY });
    };

    /*
    FNXC:BoardNavigation 2026-07-22-19:15:
    On phone-class WebKit, `scrollend` can precede a final compositor fling write that has no
    usable `scroll` callback. Two post-jump tasks can both run before that late write, so retain a
    lightweight pin watchdog. It corrects only a changed value, preserving free-scroll while held
    and CSS proximity rather than making snap mandatory.

    FNXC:BoardNavigation 2026-09-14-20:19:
    FN-398 bounds that watchdog. It now stops after PIN_MAX_REASSERT_MS (~10 frames, the lifetime of
    the compositor write it exists to correct) and releases immediately when scrollLeft differs by
    more than PIN_DRIFT_TOLERANCE_PX, because such a difference is a real scroll — a mouse pan, a
    keyboard scroll, or `restoreBoardScroll` — and rewriting it took the scroll away from the user.
    */
    const reassertPinnedScrollLeft = () => {
      pinReassertTimer = setTimeout(() => {
        pinReassertTimer = null;
        if (pinnedScrollLeft === null) return;
        // FN-398: the fence closes on its own; it never outlives the compositor write it corrects.
        if (now() - pinStartedAt > PIN_MAX_REASSERT_MS) {
          clearPin();
          return;
        }
        if (isRealScrollAwayFromPin()) {
          clearPin();
          return;
        }
        if (scroller.scrollLeft !== pinnedScrollLeft) {
          hardJumpScrollLeft(scroller, pinnedScrollLeft);
        }
        reassertPinnedScrollLeft();
      }, PIN_REASSERT_INTERVAL_MS);
    };

    const applySnapTo = (targetLeft: number) => {
      const target = Math.round(targetLeft);
      pointerHeld = false;
      suspendNativeSnap();
      hardJumpScrollLeft(scroller, target);
      pinnedScrollLeft = target;
      pinStartedAt = now();
      scroller.scrollLeft = target;
      clearPinReassertion();
      reassertPinnedScrollLeft();
    };

    /**
     * Stop the hook-owned page animation and give the axis back to the browser.
     *
     * FNXC:BoardNavigation 2026-07-24-11:20:
     * A re-touch during the animation must hand control straight back to the finger — this is the
     * corrective seam that replaces tap-to-stop-during-momentum.
     */
    const cancelPageAnimation = () => {
      if (pageAnimationFrame !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(pageAnimationFrame);
      }
      pageAnimationFrame = null;
      if (animationStyleRestore) {
        const restore = animationStyleRestore;
        animationStyleRestore = null;
        restore();
      }
    };

    /*
    FNXC:BoardNavigation 2026-07-24-11:20:
    `overflow-x: hidden` stays on for the WHOLE animation, not just the first frame: it is what
    makes the compositor drop the native fling, and a fling left alive fights every per-frame
    scrollLeft write (the board visibly stutters and can land off-center). Programmatic scrollLeft
    still applies while the axis is hidden, so the animation itself is unaffected.
    */
    const freezeScrollerForAnimation = () => {
      if (animationStyleRestore) return;
      const priorOverflowX = scroller.style.overflowX;
      const priorBehavior = scroller.style.scrollBehavior;
      const priorWebkit = scroller.style.getPropertyValue("-webkit-overflow-scrolling");
      scroller.style.scrollBehavior = "auto";
      scroller.style.overflowX = "hidden";
      scroller.style.setProperty("-webkit-overflow-scrolling", "auto");
      animationStyleRestore = () => {
        scroller.style.overflowX = priorOverflowX;
        scroller.style.scrollBehavior = priorBehavior;
        if (priorWebkit) {
          scroller.style.setProperty("-webkit-overflow-scrolling", priorWebkit);
        } else {
          scroller.style.removeProperty("-webkit-overflow-scrolling");
        }
      };
    };

    /**
     * Animate to a reachable column anchor over `durationMs`, then pin as a normal settle.
     *
     * Falls back to an instant hard write when motion is reduced, `requestAnimationFrame` is
     * unavailable, or the distance is not worth animating.
     *
     * FNXC:BoardNavigation 2026-09-17-09:49:
     * FN-500 : le départ est la position RÉELLEMENT atteinte au lever (`scroller.scrollLeft`), jamais
     * l'origine du geste : aucune remise à zéro ni saut préalable n'est écrit avant la transition, y
     * compris pour le retour d'une longue traction qui a dépassé la voisine. Une génération clôt chaque
     * animation : une frame tardive appartenant à un geste annulé n'écrit plus rien.
     */
    const animateSnapTo = (targetLeft: number, durationMs: number = PAGE_ANIMATION_MS) => {
      const target = Math.round(targetLeft);
      const from = scroller.scrollLeft;
      const distance = target - from;

      pointerHeld = false;
      suspendNativeSnap();
      cancelPageAnimation();

      if (
        Math.abs(distance) < MIN_ANIMATED_DISTANCE_PX ||
        durationMs <= 0 ||
        prefersReducedMotion() ||
        typeof window.requestAnimationFrame !== "function"
      ) {
        applySnapTo(target);
        return;
      }

      freezeScrollerForAnimation();
      const startedAt = now();
      const generation = interactionGeneration;

      const step = () => {
        pageAnimationFrame = null;
        if (generation !== interactionGeneration) return;
        const elapsed = now() - startedAt;
        const progress = elapsed / durationMs;
        if (progress >= 1) {
          // FNXC:BoardNavigation 2026-08-18-19:26: Complete the final normal-motion frame before
          // compositor fencing so a late animation frame cannot turn the remaining distance into
          // the abrupt hard release jump this phone interaction forbids.
          scroller.scrollLeft = target;
          cancelPageAnimation();
          applySnapTo(target);
          return;
        }
        scroller.scrollLeft = Math.round(from + distance * easeInOutCubic(progress));
        pageAnimationFrame = window.requestAnimationFrame(step);
      };

      pageAnimationFrame = window.requestAnimationFrame(step);
    };

    /**
     * Reachable anchors of the columns rendered right now, or `null` when nothing is snappable.
     *
     * FNXC:BoardNavigation 2026-09-17-09:49:
     * FN-500 : relu à chaque validation. Une colonne retirée, réordonnée ou redimensionnée entre le
     * début du geste et sa fin doit être arbitrée contre la disposition COURANTE, jamais contre une
     * géométrie mémorisée. Aucune colonne ou viewport non mesurable → retour sûr, sans write ni boucle.
     */
    const readAnchors = (): number[] | null => {
      const columns = getSnapColumns(scroller);
      if (columns.length === 0) return null;
      const viewportWidth = scroller.clientWidth || scroller.getBoundingClientRect().width;
      if (viewportWidth <= 0) return null;
      // FN-500: sans débordement il n'y a rien à parcourir — ne rien animer plutôt que forcer un 0.
      if (scroller.scrollWidth - viewportWidth <= 0) return null;
      return resolveColumnAnchors(scroller, columns);
    };

    /** Drop every per-gesture signal; the next interaction re-baselines from scratch. */
    const resetGestureState = () => {
      interactionActive = false;
      wheelBurstActive = false;
      sawHorizontalMovement = false;
      lockedDirection = 0;
      gestureStartClientX = null;
      lastClientX = null;
      gestureStartClientY = null;
      lastClientY = null;
    };

    /**
     * Land this gesture on exactly one reachable anchor and animate there.
     *
     * FNXC:BoardNavigation 2026-09-17-09:49:
     * FN-500 : c'est le SEUL arbitrage de fin de geste. Depuis une origine au repos, un geste
     * directionnel valide sa SEULE voisine distincte, bornée aux extrémités — la vitesse et la longueur
     * du geste n'achètent plus de pages. Tap, direction nulle et départ déjà décentré (retouche en
     * cours d'animation) rejoignent l'ancrage courant le plus proche, sans hériter d'une page annulée
     * ni ajouter une page obligatoire ; à égale distance seulement, la direction nette départage.
     */
    const commitToAnchor = (direction: number, startedCentered: boolean): boolean => {
      const anchors = readAnchors();
      if (anchors === null) {
        resetGestureState();
        restoreNativeSnap();
        return false;
      }
      const releaseLeft = scroller.scrollLeft;
      /*
      FNXC:BoardNavigation 2026-09-17-09:49:
      FN-500 : départ déjà décentré (retouche pendant une correction) → ancrage le plus proche, mais
      jamais à CONTRE-SENS du geste correctif : un glissement vers la gauche qui interrompt une
      transition ne doit pas continuer vers la destination annulée, même si elle est géométriquement
      plus proche. Aucune page n'est héritée ni ajoutée : on reste sur l'ancrage immédiat de ce côté.
      */
      const directionalCandidates = direction === 0
        ? []
        : anchors.filter((anchor) => direction > 0
          ? anchor >= releaseLeft - CENTER_TOLERANCE_PX
          : anchor <= releaseLeft + CENTER_TOLERANCE_PX);
      const currentAnchor = directionalCandidates.length > 0
        ? directionalCandidates[nearestAnchorIndex(releaseLeft, directionalCandidates, direction)]
        : anchors[nearestAnchorIndex(releaseLeft, anchors, direction)];
      const originIndex = Math.min(Math.max(gestureStartColumnIndex, 0), anchors.length - 1);
      const target = direction !== 0 && startedCentered
        ? resolveNeighborAnchor({ anchors, originIndex, direction }) ?? currentAnchor
        : currentAnchor;
      resetGestureState();
      animateSnapTo(target);
      return true;
    };

    /**
     * FNXC:BoardNavigation 2026-08-18-19:10:
     * Smoothly settle to the nearest reachable anchor when normal motion is meaningful. The
     * animation helper still chooses an immediate hard write for reduced motion, unavailable rAF,
     * or negligible distance, and keeps the final compositor pin as the single authority.
     * Returns true when a snap applied (or already resting on an anchor); false only when there are
     * no usable snap columns.
     */
    const snapToNearestColumnIfNeeded = (): boolean => {
      const anchors = readAnchors();
      if (anchors === null) {
        restoreNativeSnap();
        return false;
      }
      const nearest = anchors[nearestAnchorIndex(scroller.scrollLeft, anchors)];
      if (Math.abs(scroller.scrollLeft - nearest) <= CENTER_TOLERANCE_PX) {
        restoreNativeSnap();
        return true;
      }
      animateSnapTo(nearest);
      return true;
    };

    /**
     * Settle a flow that has no explicit end event (horizontal wheel burst, net-zero pan).
     *
     * FNXC:BoardNavigation 2026-09-17-09:49:
     * FN-500 : une rafale conserve son origine jusqu'à CETTE validation, donc elle vaut un seul geste
     * et une seule colonne, pas une page par cran de molette.
     */
    const snapInScrollDirection = () => {
      clearIdleTimer();
      if (!interactionActive) return;
      if (pointerHeld) return;

      const scrollDelta = scroller.scrollLeft - gestureStartScrollLeft;
      const clientDelta =
        gestureStartClientX !== null && lastClientX !== null
          ? gestureStartClientX - lastClientX
          : 0;
      const clientDeltaY =
        gestureStartClientY !== null && lastClientY !== null
          ? gestureStartClientY - lastClientY
          : 0;

      // Prefer direction locked at lift; recompute only if never locked.
      const direction =
        lockedDirection !== 0
          ? lockedDirection
          : resolvePanDirection({ scrollDelta, clientDelta, clientDeltaY });

      // FNXC:BoardNavigation 2026-07-22-21:40: finger travel implies pan only when horizontal dominates.
      const hadPanIntent =
        sawHorizontalMovement ||
        Math.abs(scrollDelta) > CENTER_TOLERANCE_PX ||
        (Math.abs(clientDelta) >= MIN_PAN_CLIENT_PX && Math.abs(clientDelta) > Math.abs(clientDeltaY));

      const startedCentered = gestureStartCentered;

      /*
      FNXC:BoardNavigation 2026-07-22-15:26:
      No pan on this settle gesture (tap-to-stop after re-baseline, pure tap): still never
      rest between columns — nearest anchor only, without reusing a cancelled swipe's direction.
      */
      if (!hadPanIntent) {
        resetGestureState();
        snapToNearestColumnIfNeeded();
        return;
      }

      commitToAnchor(direction, startedCentered);
    };

    const armIdleSettle = () => {
      clearIdleTimer();
      idleTimer = setTimeout(snapInScrollDirection, SCROLL_IDLE_SETTLE_MS);
    };

    /**
     * Page immediately at finger-up, animating the board there ourselves.
     *
     * FNXC:BoardNavigation 2026-09-17-09:49:
     * FN-500 : le hook reprend l'axe au lever d'un swipe reconnu — il n'attend pas une longue inertie
     * libre de type ordinateur — et anime depuis la position courante vers la SEULE voisine de
     * l'origine au repos. Un geste long qui a dépassé cette voisine revient donc vers elle par la même
     * transition, jamais par un retour sec à l'origine.
     */
    const commitDirectionalPage = (direction: number) => {
      clearIdleTimer();
      commitToAnchor(direction, gestureStartCentered);
    };

    /*
    FNXC:BoardNavigation 2026-07-22-15:10:
    A second touch during post-lift momentum must cancel the pending directional settle and start a fresh gesture at the current scrollLeft.
    Previously, re-touch while interactionActive only re-captured the pointer and returned early — pointerHeld stayed false, the idle timer kept the original swipe direction, and the board hard-jumped away from where the user tapped to stop.
    */
    const beginInteraction = (event: Event) => {
      if (!isUserInteraction(event)) return;
      /*
      FNXC:BoardNavigation 2026-09-17-09:49:
      FN-500 : une molette VERTICALE (listes de cartes, page) n'est pas un geste de tableau. Elle ne
      doit ni ouvrir une rafale, ni suspendre le snap, ni armer une validation horizontale.
      */
      if (event.type === "wheel") {
        const wheel = event as WheelEvent;
        if (Math.abs(wheel.deltaX) <= Math.abs(wheel.deltaY)) return;
      }
      /*
      FNXC:BoardNavigation 2026-09-14-20:19:
      FN-398: ANY user intent releases the fence, including mouse input. Releasing it only after the
      mouse early-return below meant a mouse pan was vetoed by a pin the finger had left behind.
      */
      clearPin();
      /*
      FNXC:BoardNavigation 2026-07-24-11:20:
      A touch landing mid-animation takes the axis back immediately (overflow restored, rAF
      dropped) so the finger drags from wherever the page had reached.

      FNXC:BoardNavigation 2026-09-17-09:49:
      FN-500 : l'ordre est annulation de l'ancien travail → restitution des styles → écriture du
      nouveau propriétaire, et il vaut AUSSI pour la souris, qui cède ensuite la main à son propre
      propriétaire de pan sans jamais être capturée ici.
      */
      interactionGeneration++;
      cancelPageAnimation();
      /*
      FNXC:BoardNavigation 2026-08-30-07:01:
      The mobile column-snap owner must never capture mouse input. A non-touch desktop browser at
      <=768 CSS px resolves to mobile, and ancestor capture retargets the compatibility click away
      from the button beneath the cursor; FN-9219 fixed only Electron's drag-region variant.
      */
      if (isMousePointerEvent(event)) {
        clearIdleTimer();
        resetGestureState();
        restoreNativeSnap();
        return;
      }

      if (event.type === "touchstart") touchSequenceActive = true;

      /*
      FNXC:BoardNavigation 2026-09-17-09:49:
      FN-500 : cran suivant d'une rafale de molette déjà ouverte — même geste. On prolonge seulement le
      repli d'inactivité ; l'origine, elle, est conservée jusqu'à la validation.
      */
      if (event.type === "wheel" && interactionActive && wheelBurstActive && !pointerHeld) {
        pointerHeld = false;
        suspendNativeSnap();
        armIdleSettle();
        return;
      }

      // Mid-momentum re-touch (or duplicate pointerdown+touchstart): cancel pending snap and re-baseline.
      if (interactionActive) {
        clearIdleTimer();
        lockedDirection = 0;
        sawHorizontalMovement = false;
        gestureStartScrollLeft = scroller.scrollLeft;
        const columns = getSnapColumns(scroller);
        gestureStartColumnIndex = nearestColumnIndex(scroller, columns);
        gestureStartCentered = isColumnCentered(scroller, columns);
        lastScrollLeft = scroller.scrollLeft;
        const point = getClientPoint(event);
        gestureStartClientX = point?.x ?? null;
        lastClientX = point?.x ?? null;
        gestureStartClientY = point?.y ?? null;
        lastClientY = point?.y ?? null;

        if (event.type === "wheel") {
          pointerHeld = false;
          wheelBurstActive = true;
          suspendNativeSnap();
          armIdleSettle();
          return;
        }

        wheelBurstActive = false;
        pointerHeld = true;
        if (event.type === "pointerdown" && "pointerId" in event) {
          try {
            scroller.setPointerCapture((event as PointerEvent).pointerId);
            capturedPointerId = (event as PointerEvent).pointerId;
          } catch {
            // ignore
          }
        }
        return;
      }

      interactionActive = true;
      sawHorizontalMovement = false;
      lockedDirection = 0;
      gestureStartScrollLeft = scroller.scrollLeft;
      const columns = getSnapColumns(scroller);
      gestureStartColumnIndex = nearestColumnIndex(scroller, columns);
      gestureStartCentered = isColumnCentered(scroller, columns);
      lastScrollLeft = scroller.scrollLeft;
      const point = getClientPoint(event);
      gestureStartClientX = point?.x ?? null;
      lastClientX = point?.x ?? null;
      gestureStartClientY = point?.y ?? null;
      lastClientY = point?.y ?? null;

      if (event.type === "wheel") {
        pointerHeld = false;
        wheelBurstActive = true;
        suspendNativeSnap();
        armIdleSettle();
        return;
      }

      wheelBurstActive = false;
      pointerHeld = true;
      if (event.type === "pointerdown" && "pointerId" in event) {
        try {
          scroller.setPointerCapture((event as PointerEvent).pointerId);
          capturedPointerId = (event as PointerEvent).pointerId;
        } catch {
          // ignore
        }
      }
    };

    const markMoved = () => {
      if (!sawHorizontalMovement) {
        suspendNativeSnap();
      }
      sawHorizontalMovement = true;
    };

    const handlePointerMove = (event: Event) => {
      if (isMousePointerEvent(event)) return;
      if (!interactionActive || pinnedScrollLeft !== null) return;
      const point = getClientPoint(event);
      if (point === null) return;
      lastClientX = point.x;
      lastClientY = point.y;
      // FNXC:BoardNavigation 2026-07-22-21:40: only dominant-horizontal travel is a board pan.
      const dx = gestureStartClientX !== null ? Math.abs(gestureStartClientX - point.x) : 0;
      const dy = gestureStartClientY !== null ? Math.abs(gestureStartClientY - point.y) : 0;
      if (dx >= MIN_PAN_CLIENT_PX && dx > dy) {
        markMoved();
      }
    };

    /*
    FNXC:BoardNavigation 2026-09-17-09:49:
    FN-500 : seuls les événements du SCROLLER lui-même décrivent un déplacement du tableau. Un `scroll`
    ou `scrollend` remonté depuis une `.column-body` (défilement vertical des cartes) ne doit jamais
    paginer le board.
    */
    const isScrollerOwnTick = (event: Event): boolean =>
      event.target === scroller || event.target === null || event.target === undefined;

    const handleScroll = (event: Event) => {
      if (!isScrollerOwnTick(event)) return;
      if (absorbTickWithPin()) return;
      if (!interactionActive) return;
      const current = scroller.scrollLeft;
      if (current === lastScrollLeft) return;
      lastScrollLeft = current;
      markMoved();

      // While finger is down: free-scroll only. The hook takes the axis back at lift.
      if (pointerHeld) return;
      // Post-lift ticks (residual inertia before our page takes over): keep the fallback armed.
      armIdleSettle();
    };

    const handleFingerLift = (event: Event) => {
      // Clear before any early return so a stale flag can't outlive the touch sequence.
      if (event.type === "touchend") touchSequenceActive = false;
      if (isMousePointerEvent(event)) return;
      if (!interactionActive || pinnedScrollLeft !== null) return;
      if ("isPrimary" in event && (event as PointerEvent).isPrimary === false) return;

      pointerHeld = false;
      releasePointerCapture();
      // FNXC:BoardNavigation 2026-07-22-18:00: Lock direction now from net gesture only.
      lockDirectionFromGesture();

      if (!sawHorizontalMovement && lockedDirection === 0) {
        clearIdleTimer();
        snapInScrollDirection();
        return;
      }
      /*
      FNXC:BoardNavigation 2026-07-24-11:20:
      Directional lift pages NOW instead of arming the idle settle — the whole point of owning the
      momentum.

      FNXC:BoardNavigation 2026-09-17-09:49:
      FN-500 : un swipe touch/pen TERMINÉ n'attend plus le repli d'inactivité, même sans direction
      nette. Le lever est une fin explicite ; le repli est réservé aux flux qui n'en ont pas (molette).
      */
      if (lockedDirection !== 0) {
        commitDirectionalPage(lockedDirection);
        return;
      }
      clearIdleTimer();
      snapInScrollDirection();
    };

    const handleGestureCancel = (event: Event) => {
      if (event.type === "touchcancel") {
        touchSequenceActive = false;
      }
      if (isMousePointerEvent(event)) return;
      if (touchSequenceActive) {
        /*
        FNXC:BoardNavigation 2026-07-22-20:10:
        pointercancel from native scroll takeover while the finger is still down: the gesture
        continues on the touch stream. Only drop the (now dead) pointer capture; touchend or
        touchcancel will end the gesture.
        */
        releasePointerCapture();
        return;
      }
      if (!interactionActive || pinnedScrollLeft !== null) return;
      pointerHeld = false;
      releasePointerCapture();
      lockDirectionFromGesture();
      if (lockedDirection !== 0) {
        // Genuine cancel with pan intent: page like a lift rather than coasting to an idle settle.
        commitDirectionalPage(lockedDirection);
      } else if (sawHorizontalMovement) {
        // FN-500: a genuine cancel is an explicit end too — settle now, never on the wheel fallback.
        clearIdleTimer();
        snapInScrollDirection();
      } else {
        // FNXC:BoardNavigation 2026-07-22-15:26: Cancelled zero-pan touch must not leave mid-column.
        interactionActive = false;
        snapToNearestColumnIfNeeded();
      }
    };

    const handleScrollEnd = (event: Event) => {
      if (!isScrollerOwnTick(event)) return;
      if (absorbTickWithPin()) return;
      if (pointerHeld) return;
      if (!interactionActive) return;
      snapInScrollDirection();
    };

    /*
    FNXC:BoardNavigation 2026-09-14-20:19:
    FN-398: keyboard scrolling is user intent too. It never went through `beginInteraction`, so a
    keyboard scroll landed inside a live pin and was rewritten back to the snapped column.

    FNXC:BoardNavigation 2026-09-17-09:49:
    FN-500 : cette intention annule aussi une correction en cours et rend inertes ses callbacks.
    */
    const releasePinOnKeyboardIntent = () => {
      clearPin();
      interactionGeneration++;
      cancelPageAnimation();
      clearIdleTimer();
      resetGestureState();
      restoreNativeSnap();
    };

    /*
    FNXC:BoardNavigation 2026-09-17-09:49:
    FN-500 : une restauration programmatique (`restoreBoardScrollSnapshot`) est annoncée par un signal
    DOM local AVANT ses écritures. Le hook cède alors complètement la main — y compris pour un
    déplacement inférieur à la tolérance compositeur, que l'épingle bornée aurait sinon ré-écrit. La
    provenance vient de ce signal, jamais de `scroll.isTrusted` ni de l'amplitude du déplacement.
    */
    const handleExternalRestore = () => {
      interactionGeneration++;
      clearIdleTimer();
      clearPin();
      cancelPageAnimation();
      releasePointerCapture();
      resetGestureState();
      pointerHeld = false;
      touchSequenceActive = false;
      restoreNativeSnap();
    };

    scroller.addEventListener(BOARD_SCROLL_RESTORE_EVENT, handleExternalRestore);
    scroller.addEventListener("keydown", releasePinOnKeyboardIntent);
    scroller.addEventListener("pointerdown", beginInteraction);
    scroller.addEventListener("touchstart", beginInteraction, { passive: true });
    scroller.addEventListener("wheel", beginInteraction, { passive: true });
    scroller.addEventListener("pointermove", handlePointerMove, { passive: true });
    scroller.addEventListener("touchmove", handlePointerMove, { passive: true });
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    scroller.addEventListener("scrollend", handleScrollEnd);
    scroller.addEventListener("pointerup", handleFingerLift);
    scroller.addEventListener("touchend", handleFingerLift);
    scroller.addEventListener("pointercancel", handleGestureCancel);
    scroller.addEventListener("touchcancel", handleGestureCancel);

    return () => {
      clearIdleTimer();
      clearPin();
      // Unmount mid-animation must not leave the scroller frozen at `overflow-x: hidden`.
      cancelPageAnimation();
      releasePointerCapture();
      restoreNativeSnap();
      scroller.removeEventListener(BOARD_SCROLL_RESTORE_EVENT, handleExternalRestore);
      scroller.removeEventListener("keydown", releasePinOnKeyboardIntent);
      scroller.removeEventListener("pointerdown", beginInteraction);
      scroller.removeEventListener("touchstart", beginInteraction);
      scroller.removeEventListener("wheel", beginInteraction);
      scroller.removeEventListener("pointermove", handlePointerMove);
      scroller.removeEventListener("touchmove", handlePointerMove);
      scroller.removeEventListener("scroll", handleScroll);
      scroller.removeEventListener("scrollend", handleScrollEnd);
      scroller.removeEventListener("pointerup", handleFingerLift);
      scroller.removeEventListener("touchend", handleFingerLift);
      scroller.removeEventListener("pointercancel", handleGestureCancel);
      scroller.removeEventListener("touchcancel", handleGestureCancel);
      // FN-500: `contextKey` participe aux dépendances, donc un changement de contexte passe par ce nettoyage.
    };
  }, [contextKey, enabled, isEligibleViewport, isUserInteraction, scroller]);
}
