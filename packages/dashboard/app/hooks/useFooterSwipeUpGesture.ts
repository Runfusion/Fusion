import { useCallback, useEffect, useRef, type RefObject } from "react";

/*
FNXC:MobileNavGesture 2026-09-17-16:53:
FN-511 réaffecte ce hook : le glissement vers le haut du pied de page mobile n'ouvre plus le Chat (devenu une
destination ordinaire des cinq créneaux configurables) mais le MENU de navigation, sous l'option projet
`mobileNavMenuSwipeGesture`. Quand cette option est active, le bouton hamburger n'est pas rendu et le geste est la
seule affordance d'ouverture du menu ; quand elle est inactive, le hamburger est rendu et le geste reste désarmé. Le
hook n'ajoute donc jamais une SECONDE affordance pour la même surface, et il appelle le même propriétaire d'état de
menu que le hamburger — aucun second producteur d'ouverture.

Choix assumés :
- STRICTEMENT tactile. Aucun listener `pointer`/`mouse` : un glissement à la souris ou au trackpad ne doit jamais
  transformer un clic maladroit en ouverture de menu, et le footer large (non tactile par construction) n'adopte pas ce
  geste.
- Seuil d'intention avant toute réclamation, et `preventDefault()` seulement APRÈS réclamation, pour ne casser ni le
  tap sur un onglet ni le défilement natif.
- Dominance verticale ascendante : un geste descendant ou horizontal est rejeté immédiatement et définitivement pour
  ce contact, donc il ne peut pas « redevenir » un geste d'ouverture en cours de route.
- Nettoyage intégral AVANT le callback (même discipline que `useDrawerDismissGesture`), pour qu'aucun listener
  document, aucun état interne et aucun style ne survive à l'ouverture du menu. `touchcancel`, `enabled: false` et le
  démontage nettoient sans jamais déclencher.
- Suppression du clic fantôme : un geste réclamé neutralise exactement UN `click` suivant en phase de capture, sinon
  l'onglet situé sous le doigt naviguerait vers sa propre destination à la fin du glissement.
*/

/** Déplacement minimal, en pixels, avant qu'une direction soit considérée comme intentionnelle. */
export const FOOTER_SWIPE_INTENT_THRESHOLD = 6;
/** Distance ascendante suffisante pour déclencher, quelle que soit la vitesse. */
export const FOOTER_SWIPE_MIN_DISTANCE = 48;
/** Vitesse ascendante (px/ms) suffisante pour déclencher un flick court. */
export const FOOTER_SWIPE_VELOCITY_THRESHOLD = 0.6;

export type FooterSwipeUpIntent = "pending" | "rejected" | "claimed";

export interface FooterSwipeUpIntentInput {
  deltaX: number;
  deltaY: number;
}

/**
 * Classification PURE de l'intention d'un contact tactile, testable sans DOM.
 *
 * FNXC:MobileNavGesture 2026-09-17-16:53:
 * `rejected` est définitif pour ce contact : un mouvement descendant franc ou horizontalement dominant rend la main
 * au navigateur (défilement, tap) et ne peut plus revendiquer l'ouverture du menu.
 */
export function resolveFooterSwipeUpIntent({ deltaX, deltaY }: FooterSwipeUpIntentInput): FooterSwipeUpIntent {
  const upward = -deltaY;
  if (deltaY > FOOTER_SWIPE_INTENT_THRESHOLD) return "rejected";
  if (Math.abs(deltaX) > Math.max(FOOTER_SWIPE_INTENT_THRESHOLD, upward)) return "rejected";
  if (upward >= FOOTER_SWIPE_INTENT_THRESHOLD) return "claimed";
  return "pending";
}

export interface FooterSwipeUpCompletionInput {
  deltaY: number;
  elapsedMs: number;
}

/** Déclenchement de fin de geste : distance suffisante OU flick rapide. */
export function shouldTriggerFooterSwipeUp({ deltaY, elapsedMs }: FooterSwipeUpCompletionInput): boolean {
  const upward = -deltaY;
  if (upward <= 0) return false;
  const elapsed = Math.max(1, elapsedMs);
  return upward >= FOOTER_SWIPE_MIN_DISTANCE || upward / elapsed >= FOOTER_SWIPE_VELOCITY_THRESHOLD;
}

export interface UseFooterSwipeUpGestureOptions {
  /** Le geste n'est armé que lorsque la destination est réellement offerte par cet hôte. */
  enabled: boolean;
  /** Surface glissable : la `<nav class="mobile-nav-bar--native">` du shell mobile. */
  surfaceRef: RefObject<HTMLElement | null>;
  /** Ouverture de la destination — le même propriétaire de navigation que la ligne du menu. */
  onTrigger: () => void;
}

interface FooterSwipeDrag {
  identifier: number;
  startX: number;
  startY: number;
  startedAt: number;
  deltaY: number;
  claimed: boolean;
}

export function useFooterSwipeUpGesture({ enabled, surfaceRef, onTrigger }: UseFooterSwipeUpGestureOptions): void {
  const onTriggerRef = useRef(onTrigger);
  const dragRef = useRef<FooterSwipeDrag | null>(null);
  const removeMoveListenersRef = useRef<(() => void) | null>(null);
  const removeClickSuppressorRef = useRef<(() => void) | null>(null);
  onTriggerRef.current = onTrigger;

  const releaseClickSuppressor = useCallback(() => {
    removeClickSuppressorRef.current?.();
    removeClickSuppressorRef.current = null;
  }, []);

  const reset = useCallback(() => {
    dragRef.current = null;
    removeMoveListenersRef.current?.();
    removeMoveListenersRef.current = null;
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!enabled || !surface) return;

    /*
    FNXC:MobileNavGesture 2026-09-17-16:53:
    Un geste réclamé neutralise exactement UN `click` suivant, en phase de capture sur la surface, pour que l'onglet
    sous le doigt ne navigue pas. Le suppresseur est retiré dès consommation, au `touchstart` suivant, à la
    désactivation et au démontage : il ne peut donc jamais avaler un vrai tap ultérieur.
    */
    const armClickSuppressor = () => {
      releaseClickSuppressor();
      const onClickCapture = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        releaseClickSuppressor();
      };
      surface.addEventListener("click", onClickCapture, true);
      removeClickSuppressorRef.current = () => surface.removeEventListener("click", onClickCapture, true);
    };

    const onTouchStart = (event: TouchEvent) => {
      releaseClickSuppressor();
      if (dragRef.current) reset();
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      dragRef.current = {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: event.timeStamp,
        deltaY: 0,
        claimed: false,
      };

      const findTouch = (touches: TouchList) => Array.from(touches).find((candidate) => candidate.identifier === touch.identifier);

      const onTouchMove = (moveEvent: TouchEvent) => {
        const drag = dragRef.current;
        const current = findTouch(moveEvent.touches);
        if (!drag || !current) return;
        /* Un second doigt annule le geste : c'est un pincement ou une manipulation, pas une ouverture du menu. */
        if (moveEvent.touches.length !== 1) {
          reset();
          return;
        }
        const deltaX = current.clientX - drag.startX;
        const deltaY = current.clientY - drag.startY;
        if (!drag.claimed) {
          const intent = resolveFooterSwipeUpIntent({ deltaX, deltaY });
          if (intent === "rejected") {
            reset();
            return;
          }
          if (intent === "pending") return;
          drag.claimed = true;
        }
        drag.deltaY = deltaY;
        moveEvent.preventDefault();
      };

      const finish = (endEvent: TouchEvent, allowTrigger: boolean) => {
        const drag = dragRef.current;
        if (!drag || !findTouch(endEvent.changedTouches)) {
          if (!drag) reset();
          return;
        }
        const shouldTrigger = allowTrigger
          && drag.claimed
          && shouldTriggerFooterSwipeUp({ deltaY: drag.deltaY, elapsedMs: endEvent.timeStamp - drag.startedAt });
        const claimed = drag.claimed;
        reset();
        if (claimed) armClickSuppressor();
        if (shouldTrigger) onTriggerRef.current();
      };

      const onTouchEnd = (endEvent: TouchEvent) => finish(endEvent, true);
      const onTouchCancel = (cancelEvent: TouchEvent) => finish(cancelEvent, false);

      removeMoveListenersRef.current = () => {
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onTouchEnd);
        document.removeEventListener("touchcancel", onTouchCancel);
      };
      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend", onTouchEnd);
      document.addEventListener("touchcancel", onTouchCancel);
    };

    surface.addEventListener("touchstart", onTouchStart, { passive: true });
    return () => {
      surface.removeEventListener("touchstart", onTouchStart);
      reset();
      releaseClickSuppressor();
    };
  }, [enabled, releaseClickSuppressor, reset, surfaceRef]);
}
