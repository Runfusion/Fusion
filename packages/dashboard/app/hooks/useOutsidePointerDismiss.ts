import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { isInsidePortaledModelMenu } from "../utils/portalSurfaces";

export interface UseOutsidePointerDismissInput {
  /** The listener exists only while this is true; a closed surface observes nothing. */
  open: boolean;
  onDismiss: () => void;
  /** Roots that count as "inside". A null `.current` is simply skipped, so an unmounted surface still dismisses. */
  surfaceRefs: Array<RefObject<HTMLElement | null>>;
  /**
   * Optional selector for the surface's own trigger. Without it a pointerdown on a TOGGLING trigger dismisses here and
   * the trigger's later `click` re-opens, so the panel would appear never to close.
   */
  triggerSelector?: string;
}

export interface UseOutsidePointerDismissResult {
  /** Spread on the surface's root element; it marks React-tree-inside events, portalled descendants included. */
  onPointerDownCapture: (event: ReactPointerEvent) => void;
}

function toElement(target: unknown): Element | null {
  if (typeof Node === "undefined" || !(target instanceof Node)) return null;
  return target.nodeType === Node.ELEMENT_NODE ? (target as Element) : target.parentElement;
}

/*
FNXC:ToolSurfaces 2026-09-17-05:48:
FN-491 : un panneau NON modal (`aria-modal="false"`) ne doit jamais geler le tableau. Les panneaux outils
(Conversations, Activité, Notes) et la popover Usage montaient chacun leur propre vitre plein écran
(`position: fixed; inset: 0; background: transparent`) uniquement pour capter le clic extérieur. Cette vitre
interceptait AUSSI la molette, le défilement tactile et tous les clics : le board restait visible mais inerte, et un
clic « en dehors » ne faisait que refermer le panneau sans jamais atteindre sa cible — d'où le double clic obligatoire
signalé par l'opérateur. Ce hook est désormais le SEUL propriétaire de la règle « clic extérieur ferme » pour ces
surfaces, ce qui satisfait l'exigence explicite « réglé DRY » : aucun élément DOM n'est monté, donc rien ne peut être
intercepté.

Deux décisions portent la correction :
- L'écouteur `pointerdown` est posé sur `document` en phase BUBBLE, jamais en capture. React 17+ attache ses écouteurs
  au conteneur racine ET aux conteneurs de portail (`document.body`), qui sont tous deux atteints avant `document`
  pendant la remontée : les gestionnaires React d'un enfant portalisé ont donc déjà tourné. En phase capture, un menu
  portalisé refermerait son hôte avant même de traiter son propre clic.
- L'appartenance « intérieur » est marquée par IDENTITÉ D'ÉVÉNEMENT (`insideEventRef.current = event.nativeEvent`,
  comparée par `===` puis remise à `null`), jamais par un booléen. Un descendant qui appelle `stopPropagation()` sur son
  `pointerdown` empêche l'écouteur `document` de tourner ; un booléen resterait alors armé et avalerait silencieusement
  la fermeture suivante, tandis qu'une identité périmée ne peut jamais correspondre à l'événement suivant.

Le hook ne ferme JAMAIS sur `scroll`, `wheel`, `touchmove` ni `resize` : ce serait réintroduire le symptôme sous une
autre forme. La fermeture par Échap et par le bouton de fermeture du panneau reste possédée par chaque hôte.
*/
export function useOutsidePointerDismiss({ open, onDismiss, surfaceRefs, triggerSelector }: UseOutsidePointerDismissInput): UseOutsidePointerDismissResult {
  const insideEventRef = useRef<Event | null>(null);
  const onDismissRef = useRef(onDismiss);
  const surfaceRefsRef = useRef(surfaceRefs);
  const triggerSelectorRef = useRef(triggerSelector);

  // Latest-value refs: the document listener is attached once per open cycle and must never hold a stale callback,
  // while callers legitimately pass a fresh `surfaceRefs` array literal on every render.
  onDismissRef.current = onDismiss;
  surfaceRefsRef.current = surfaceRefs;
  triggerSelectorRef.current = triggerSelector;

  const onPointerDownCapture = useCallback((event: ReactPointerEvent) => {
    insideEventRef.current = event.nativeEvent;
  }, []);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    const handlePointerDown = (event: PointerEvent) => {
      const marked = insideEventRef.current;
      insideEventRef.current = null;
      if (marked === event) return;

      const target = event.target;
      if (target instanceof Node && surfaceRefsRef.current.some((ref) => ref.current?.contains(target))) return;
      // A model menu re-anchored into a body portal is a logical child of the control that opened it.
      if (isInsidePortaledModelMenu(target)) return;

      const selector = triggerSelectorRef.current;
      if (selector && toElement(target)?.closest(selector)) return;

      onDismissRef.current();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      insideEventRef.current = null;
    };
  }, [open]);

  return { onPointerDownCapture };
}

export default useOutsidePointerDismiss;
