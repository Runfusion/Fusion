import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import {
  STICKY_BOTTOM_REARM_THRESHOLD_PX,
  isWithinBottomRearmWindow,
  resolveKeyIntentDirection,
  resolveStickyBottomFollow,
  type StickyBottomGeometry,
  type StickyBottomIntentDirection,
} from "../utils/stickyBottomScroll";

/*
FNXC:StickyBottomScroll 2026-09-14-20:19:
FN-398 : propriétaire UNIQUE du suivi du bas pour un conteneur de défilement. Quatre systèmes qui se disputent le même
conteneur (effet de croissance, `MutationObserver`, `ResizeObserver`, boucle de frames) sont la cause racine habituelle
du « raccrochage à l'ancre » : chacun relisait la géométrie et se réengageait tout seul.

Le hook attache UN écouteur de chaque type (`scroll`, `wheel`, `touchstart`/`touchmove`, `keydown`) et publie
`isFollowingRef` de façon SYNCHRONE, avant tout rendu React, pour que les gardes existantes (`if (!isFollowingRef.current)
return` dans les `followTail`) deviennent effectives dès la frame du geste. `intentGenerationRef` s'incrémente à chaque
intention pour qu'une boucle multi-frames déjà lancée puisse s'interrompre.

Les écritures programmatiques sont fencées par POSITION ATTENDUE (`followBottom`, `noteProgrammaticWrite`), jamais par
une fenêtre temporelle de grâce : c'est l'anti-pattern qui classe mal la fin de chaque défilement lissé.
*/

export interface StickyBottomFollowOptions {
  /** Distance au bas sous laquelle un défilement réel réengage le suivi. */
  rearmThresholdPx?: number;
  /** Quand faux, aucun écouteur n'est attaché et aucune écriture n'est faite. */
  enabled?: boolean;
  /**
   * Valeur changeante qui force le rattachement des écouteurs.
   *
   * Optionnelle : le hook détecte lui-même l'arrivée tardive du conteneur (voir la synchronisation
   * d'élément ci-dessous). Cette clé reste utile pour forcer un rattachement quand l'élément DOM est
   * identique mais que l'hôte veut repartir d'un état propre.
   */
  attachKey?: unknown;
  /** Suivi initial (par défaut : vrai — le bas est suivi tant que le lecteur ne s'en éloigne pas). */
  initialFollowing?: boolean;
  /** Appelé de façon synchrone à chaque transition, avant le rendu React. */
  onFollowingChange?: (following: boolean) => void;
  /** Appelé de façon synchrone quand une intention utilisateur prend la main. */
  onUserIntent?: () => void;
}

export interface StickyBottomFollow {
  /** Valeur courante du suivi, lue au rendu depuis le ref synchrone. */
  readonly isFollowing: boolean;
  isFollowingRef: RefObject<boolean>;
  /** Incrémenté à chaque intention utilisateur ; une boucle de frames doit abandonner sur changement. */
  intentGenerationRef: RefObject<number>;
  /** Écrit une fois en bas, mémorise la position attendue et engage le suivi. */
  followBottom: () => void;
  /** Fence une écriture faite par l'hôte (restauration d'ancre, pagination par préfixe). */
  noteProgrammaticWrite: (expectedScrollTop?: number) => void;
  setFollowing: (following: boolean) => void;
  /** Compatibilité `onScroll` React ; l'écouteur natif reste l'autorité. */
  handleScroll: () => void;
}

function readGeometry(container: HTMLElement): StickyBottomGeometry {
  return {
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  };
}

/** Vrai quand le geste est consommé par un scroller imbriqué qui peut encore bouger dans cette direction. */
function isConsumedByNestedScroller(
  container: HTMLElement,
  target: EventTarget | null,
  direction: StickyBottomIntentDirection,
): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== container) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const distance = node.scrollHeight - (node.scrollTop + node.clientHeight);
      if (direction === "up" ? node.scrollTop > 0 : distance > 0) return true;
    }
    node = node.parentElement;
  }
  return false;
}

export function useStickyBottomFollow(
  containerRef: RefObject<HTMLElement | null>,
  options: StickyBottomFollowOptions = {},
): StickyBottomFollow {
  const {
    rearmThresholdPx = STICKY_BOTTOM_REARM_THRESHOLD_PX,
    enabled = true,
    initialFollowing = true,
    attachKey,
  } = options;

  const [isFollowing, setIsFollowing] = useState(initialFollowing);
  const isFollowingRef = useRef(initialFollowing);
  const intentGenerationRef = useRef(0);
  const expectedScrollTopRef = useRef<number | null>(null);
  const previousScrollTopRef = useRef<number | null>(null);
  const touchOriginYRef = useRef<number | null>(null);
  const subscriptionRef = useRef<{
    element: HTMLElement;
    key: unknown;
    subscribe: (container: HTMLElement) => () => void;
    cleanup: () => void;
  } | null>(null);

  // Les callbacks vivent dans un ref pour que l'effet d'abonnement ne se rattache pas à chaque rendu.
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const applyFollowing = useCallback((next: boolean) => {
    if (isFollowingRef.current !== next) {
      isFollowingRef.current = next;
      setIsFollowing(next);
      callbacksRef.current.onFollowingChange?.(next);
    }
  }, []);

  const setFollowing = useCallback((next: boolean) => {
    applyFollowing(next);
  }, [applyFollowing]);

  const noteProgrammaticWrite = useCallback((expectedScrollTop?: number) => {
    const container = containerRef.current;
    const resolved = expectedScrollTop ?? (container ? container.scrollTop : null);
    expectedScrollTopRef.current = resolved;
    previousScrollTopRef.current = resolved;
  }, [containerRef]);

  const followBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      applyFollowing(true);
      return;
    }
    container.scrollTop = container.scrollHeight;
    noteProgrammaticWrite(container.scrollTop);
    applyFollowing(true);
  }, [applyFollowing, containerRef, noteProgrammaticWrite]);

  const resolveAndApply = useCallback((
    container: HTMLElement,
    event: Parameters<typeof resolveStickyBottomFollow>[1],
  ) => {
    const decision = resolveStickyBottomFollow(
      {
        following: isFollowingRef.current,
        geometry: readGeometry(container),
        expectedScrollTop: expectedScrollTopRef.current,
        previousScrollTop: previousScrollTopRef.current,
      },
      event,
      rearmThresholdPx,
    );
    if (decision.isUserIntent) {
      intentGenerationRef.current += 1;
      // L'écriture programmatique en cours perd son fence : le lecteur possède désormais le viewport.
      expectedScrollTopRef.current = null;
      callbacksRef.current.onUserIntent?.();
    }
    /*
    Une intention rebaseline la position de référence sur la géométrie observée au moment du geste.
    Sans cela, un `previousScrollTop` périmé (conteneur mesuré après l'abonnement, contenu chargé plus
    tard) ferait lire l'événement `scroll` du geste lui-même comme un retour VERS LE BAS et réengagerait
    le suivi que le geste venait de relâcher.
    */
    if (event.kind === "wheel" || event.kind === "touch" || event.kind === "key") {
      previousScrollTopRef.current = container.scrollTop;
    }
    applyFollowing(decision.following);
    return decision;
  }, [applyFollowing, rearmThresholdPx]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;
    /*
    Une livraison sans déplacement réel ne décide de rien. Cela neutralise aussi une double
    livraison (écouteur natif + `onScroll` React du même conteneur) : sans cette garde, la seconde
    livraison relirait la géométrie et réengagerait le suivi que la première venait de relâcher.
    */
    if (previousScrollTopRef.current !== null && container.scrollTop === previousScrollTopRef.current) return;
    const decision = resolveAndApply(container, { kind: "scroll" });
    if (decision.isEcho) {
      // L'écho est consommé : le prochain scroll sera jugé contre la position réellement atteinte.
      expectedScrollTopRef.current = null;
    }
    previousScrollTopRef.current = container.scrollTop;
  }, [containerRef, enabled, resolveAndApply]);

  /*
  FNXC:StickyBottomScroll 2026-09-14-21:29:
  FN-398 : un `RefObject` n'est PAS réactif. Les journaux (agent, dev server, workflow) rendent une branche
  « vide / chargement » AVANT leur conteneur de défilement : un effet d'abonnement à dépendances fixes ne
  voyait donc jamais l'élément finalement monté, aucun écouteur n'était attaché et `isFollowingRef` restait
  vrai à vie — le lecteur ne pouvait plus quitter la queue du tout.

  L'abonnement est donc réconcilié impérativement après CHAQUE rendu, en comparant l'élément courant à
  l'élément déjà abonné. Aucun `setState` n'est utilisé ici : un rendu supplémentaire par montée
  reclasserait les rendus des hôtes (notamment la première réponse de transcript) et ferait disparaître
  l'état « vide » que ces hôtes doivent rendre une fois.
  */
  const subscribe = useCallback((container: HTMLElement) => {
    previousScrollTopRef.current = container.scrollTop;

    const onScroll = () => { handleScroll(); };

    const onWheel = (event: WheelEvent) => {
      const direction: StickyBottomIntentDirection = event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : "none";
      if (direction === "none") return;
      if (isConsumedByNestedScroller(container, event.target, direction)) return;
      resolveAndApply(container, { kind: "wheel", direction });
    };

    const onTouchStart = (event: TouchEvent) => {
      touchOriginYRef.current = event.touches[0]?.clientY ?? null;
    };

    const onTouchMove = (event: TouchEvent) => {
      const originY = touchOriginYRef.current;
      const currentY = event.touches[0]?.clientY ?? null;
      if (originY === null || currentY === null) return;
      const delta = currentY - originY;
      // Un doigt qui descend fait remonter le contenu : direction d'intention = "up".
      const direction: StickyBottomIntentDirection = delta > 1 ? "up" : delta < -1 ? "down" : "none";
      if (direction === "none") return;
      if (isConsumedByNestedScroller(container, event.target, direction)) return;
      resolveAndApply(container, { kind: "touch", direction });
    };

    const onTouchEnd = () => { touchOriginYRef.current = null; };

    const onKeyDown = (event: KeyboardEvent) => {
      const intent = resolveKeyIntentDirection(event.key);
      if (!intent) return;
      resolveAndApply(container, {
        kind: "key",
        direction: intent.direction,
        toEnd: intent.toEnd,
        defaultPrevented: event.defaultPrevented,
      });
      if (intent.toEnd && isFollowingRef.current) followBottom();
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });
    container.addEventListener("keydown", onKeyDown);

    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [followBottom, handleScroll, resolveAndApply]);

  // Sans tableau de dépendances : se réexécute après chaque rendu pour rattraper un conteneur tardif.
  useEffect(() => {
    const container = enabled ? containerRef.current ?? null : null;
    const active = subscriptionRef.current;
    if (active && active.element === container && active.key === attachKey && active.subscribe === subscribe) return;
    active?.cleanup();
    subscriptionRef.current = container
      ? { element: container, key: attachKey, subscribe, cleanup: subscribe(container) }
      : null;
  });

  useEffect(() => () => {
    subscriptionRef.current?.cleanup();
    subscriptionRef.current = null;
  }, []);

  /*
  FNXC:StickyBottomScroll 2026-09-14-20:19:
  L'objet retourné doit être STABLE : les hôtes le placent dans des listes de dépendances
  `useCallback`/`useEffect` (ancrage, clavier mobile, streaming). Une identité qui change à chaque
  bascule de suivi relançait ces effets et ré-ancrait le lecteur au bas — exactement le raccrochage
  que FN-398 supprime. `isFollowing` est donc exposé par un accesseur lisant le ref synchrone, tandis
  que l'état React interne ne sert qu'à déclencher le rendu.
  */
  void isFollowing;
  return useMemo(() => ({
    get isFollowing() { return isFollowingRef.current; },
    isFollowingRef,
    intentGenerationRef,
    followBottom,
    noteProgrammaticWrite,
    setFollowing,
    handleScroll,
  }), [followBottom, handleScroll, noteProgrammaticWrite, setFollowing]);
}

/** Réexport pratique pour les hôtes qui n'ont besoin que de la fenêtre de réengagement. */
export { isWithinBottomRearmWindow };
