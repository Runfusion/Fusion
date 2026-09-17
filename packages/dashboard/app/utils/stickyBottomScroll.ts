/*
FNXC:StickyBottomScroll 2026-09-14-20:19:
FN-398 : le suivi automatique du bas (chat, transcriptions de tâche, journaux) était décidé UNIQUEMENT par la géométrie
(« suis-je à moins de 48–50 px du bas ? ») puis réaffirmé par des boucles d'écriture (frames `requestAnimationFrame`,
`MutationObserver`/`ResizeObserver` `followTail`, propriété d'alignement terminal du virtualiseur). Un petit geste de
défilement (molette de 30 px) restait dans la fenêtre de tolérance, ne désengageait donc rien, et la boucle suivante
réécrivait `scrollTop` en bas : l'utilisateur était « raccroché à l'ancre » et ne pouvait plus remonter.

Ce module est le propriétaire pur de la décision. Deux règles remplacent la décision géométrique :
1. L'INTENTION utilisateur (molette, `touchmove`, touche de navigation, glissement de barre de défilement) désengage le
   suivi immédiatement et indépendamment de la géométrie. Le seuil de proximité ne sert plus qu'au RÉENGAGEMENT.
2. Les écritures programmatiques sont identifiées par leur POSITION ATTENDUE (`expectedScrollTop`), jamais par une
   fenêtre temporelle de grâce : une fenêtre de 100 ms classe mal la fin de chaque défilement lissé, les glissements de
   barre de défilement et les « rechercher dans la page ».

Piège inverse (shadcn/ui #11223, #11224) : un geste qui ne PEUT PAS déplacer le viewport (momentum résiduel au bas déjà
clampé, conteneur non défilable, molette vers le haut alors que `scrollTop <= 0`) ne doit PAS désengager le suivi, sinon
le lecteur reste bloqué « visuellement en bas mais plus suivi ». Ces cas sont résolus SYNCHRONIQUEMENT ici, au moment de
l'intention, plutôt que par une réconciliation différée qui courrait contre le défilement lissé du navigateur.
*/

/** Distance au bas, en px, sous laquelle un défilement réel réengage le suivi. */
export const STICKY_BOTTOM_REARM_THRESHOLD_PX = 48;
/** Tolérance d'attribution d'un événement `scroll` à notre propre écriture programmatique. */
export const STICKY_BOTTOM_ECHO_EPSILON_PX = 2;
/** Déplacement minimal, en px, qu'un défilement doit produire pour compter comme intention. */
export const STICKY_BOTTOM_USER_SCROLL_EPSILON_PX = 1;

export interface StickyBottomGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface StickyBottomState {
  following: boolean;
  geometry: StickyBottomGeometry;
  /** Position attendue de la dernière écriture programmatique non encore consommée, si connue. */
  expectedScrollTop?: number | null;
  /** `scrollTop` observé lors du dernier événement `scroll` traité. */
  previousScrollTop?: number | null;
}

export type StickyBottomIntentDirection = "up" | "down" | "none";

export type StickyBottomEvent =
  /** Molette ou pan tactile. `direction: "up"` = le lecteur veut remonter. */
  | { kind: "wheel" | "touch"; direction: StickyBottomIntentDirection }
  /** Touche de navigation verticale déjà résolue par l'appelant. */
  | { kind: "key"; direction: StickyBottomIntentDirection; toEnd?: boolean; defaultPrevented?: boolean }
  /** Événement `scroll` natif, après mise à jour de `state.geometry`. */
  | { kind: "scroll" }
  /** Croissance de contenu (nouveau message, delta de streaming, mesure tardive). */
  | { kind: "growth" }
  /** Réengagement explicite (bouton « aller en bas », changement de fil). */
  | { kind: "explicit-follow" }
  /** Désengagement explicite (restauration d'une lecture détachée). */
  | { kind: "explicit-detach" };

export interface StickyBottomDecision {
  following: boolean;
  /** Vrai quand l'événement est attribué à notre propre écriture et ne doit rien changer. */
  isEcho: boolean;
  /** Vrai quand l'événement exprime une intention utilisateur ayant réellement pris la main. */
  isUserIntent: boolean;
}

export function distanceToBottom(geometry: StickyBottomGeometry): number {
  return geometry.scrollHeight - (geometry.scrollTop + geometry.clientHeight);
}

export function isScrollable(geometry: StickyBottomGeometry): boolean {
  return geometry.scrollHeight > geometry.clientHeight + STICKY_BOTTOM_USER_SCROLL_EPSILON_PX;
}

export function isWithinBottomRearmWindow(
  geometry: StickyBottomGeometry,
  thresholdPx: number = STICKY_BOTTOM_REARM_THRESHOLD_PX,
): boolean {
  return distanceToBottom(geometry) <= thresholdPx;
}

/** Vrai quand le viewport est déjà collé au bas, à l'epsilon de sous-pixel près. */
export function isAtClampedBottom(geometry: StickyBottomGeometry): boolean {
  return distanceToBottom(geometry) <= STICKY_BOTTOM_USER_SCROLL_EPSILON_PX;
}

export function isProgrammaticScrollEcho(args: {
  scrollTop: number;
  expectedScrollTop?: number | null;
  epsilon?: number;
}): boolean {
  const { scrollTop, expectedScrollTop } = args;
  if (expectedScrollTop === null || expectedScrollTop === undefined) return false;
  const epsilon = args.epsilon ?? STICKY_BOTTOM_ECHO_EPSILON_PX;
  return Math.abs(scrollTop - expectedScrollTop) <= epsilon;
}

/**
 * Vrai quand un geste dans `direction` ne peut déplacer aucun pixel du viewport.
 *
 * C'est le piège inverse : désengager sur un tel geste laisse le lecteur visuellement en bas mais
 * plus suivi, ce qui est exactement la sensation de blocage que FN-398 corrige.
 */
export function isIntentUnableToMove(
  geometry: StickyBottomGeometry,
  direction: StickyBottomIntentDirection,
): boolean {
  if (direction === "none") return true;
  if (!isScrollable(geometry)) return true;
  if (direction === "up") return geometry.scrollTop <= 0;
  return isAtClampedBottom(geometry);
}

function decide(following: boolean, isUserIntent = false, isEcho = false): StickyBottomDecision {
  return { following, isUserIntent, isEcho };
}

/**
 * Résout l'état de suivi pour un événement.
 *
 * L'ordre est significatif : l'écho programmatique est neutralisé AVANT toute lecture de direction,
 * puis un défilement réel vers le haut désengage même à l'intérieur de la fenêtre de réengagement.
 */
export function resolveStickyBottomFollow(
  state: StickyBottomState,
  event: StickyBottomEvent,
  thresholdPx: number = STICKY_BOTTOM_REARM_THRESHOLD_PX,
): StickyBottomDecision {
  const { following, geometry } = state;

  switch (event.kind) {
    case "explicit-follow":
      return decide(true);
    case "explicit-detach":
      return decide(false);
    /*
    Une croissance ne décide jamais du suivi : c'est le contenu qui bouge, pas le lecteur. C'est ce
    couplage (croissance -> recalcul géométrique -> réengagement) qui raccrochait l'utilisateur.
    */
    case "growth":
      return decide(following);
    case "wheel":
    case "touch": {
      if (isIntentUnableToMove(geometry, event.direction)) return decide(following);
      if (event.direction === "down") {
        // Un geste vers le bas ne détache jamais ; il peut seulement réengager en atteignant la fenêtre.
        return decide(following || isWithinBottomRearmWindow(geometry, thresholdPx), true);
      }
      return decide(false, true);
    }
    case "key": {
      if (event.defaultPrevented) return decide(following);
      if (event.toEnd) return decide(true, true);
      if (isIntentUnableToMove(geometry, event.direction)) return decide(following);
      if (event.direction === "down") {
        return decide(following || isWithinBottomRearmWindow(geometry, thresholdPx), true);
      }
      return decide(false, true);
    }
    case "scroll": {
      if (isProgrammaticScrollEcho({ scrollTop: geometry.scrollTop, expectedScrollTop: state.expectedScrollTop })) {
        return decide(following, false, true);
      }
      const previousScrollTop = state.previousScrollTop;
      const hasPrevious = previousScrollTop !== null && previousScrollTop !== undefined;
      const movedUp = hasPrevious && geometry.scrollTop < previousScrollTop - STICKY_BOTTOM_USER_SCROLL_EPSILON_PX;
      if (movedUp) return decide(false, true);
      /*
      Le réengagement exige un déplacement VERS LE BAS, pas la simple présence dans la fenêtre. Sinon
      l'événement `scroll` produit par le geste de détachement lui-même (molette de 30 px, qui laisse le
      lecteur à 30 px du bas, donc dans la fenêtre de 48 px) annulerait immédiatement ce détachement.
      */
      const movedDown = hasPrevious && geometry.scrollTop > previousScrollTop + STICKY_BOTTOM_USER_SCROLL_EPSILON_PX;
      if (movedDown && isWithinBottomRearmWindow(geometry, thresholdPx)) return decide(true);
      if (!hasPrevious) return decide(following);
      return decide(following && isWithinBottomRearmWindow(geometry, thresholdPx));
    }
    default:
      return decide(following);
  }
}

/** Traduit une touche en direction d'intention ; `null` quand la touche n'est pas une navigation verticale. */
export function resolveKeyIntentDirection(
  key: string,
): { direction: StickyBottomIntentDirection; toEnd: boolean } | null {
  switch (key) {
    case "ArrowUp":
    case "PageUp":
    case "Home":
      return { direction: "up", toEnd: false };
    case "ArrowDown":
    case "PageDown":
      return { direction: "down", toEnd: false };
    case "End":
      return { direction: "down", toEnd: true };
    default:
      return null;
  }
}
