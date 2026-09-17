import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  LIST_ITEM_LONG_PRESS_DELAY_MS,
  LIST_ITEM_LONG_PRESS_MOVE_THRESHOLD,
  LIST_ITEM_MENU_KEYBOARD_OFFSET,
  LIST_ITEM_MENU_VIEWPORT_MARGIN,
  cancelActiveDrawerGestures,
  isOwnRowGestureTarget,
  listRowGestureAttributes,
} from "../utils/listItemGesture";

export interface ListItemMenuAnchor {
  /** Identité COMPOSÉE de la cible : contexte projet, type d'objet et identifiant. Jamais un index ni un titre. */
  key: string;
  x: number;
  y: number;
}

export interface UseListItemContextMenuOptions {
  /** Faux lorsque l'hôte est masqué, fermé ou en lecture seule : aucun menu ne s'ouvre et un menu ouvert se ferme. */
  enabled?: boolean;
  /**
   * Identité du contexte (projet, collection, onglet). Tout changement ferme le menu, car sa cible
   * n'appartient plus au contexte affiché.
   */
  contextId?: string;
}

export interface ListItemRowGestureProps {
  [key: string]: unknown;
  "aria-haspopup": "menu";
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}

export interface ListItemContextMenuController {
  anchor: ListItemMenuAnchor | null;
  isOpen: (key: string) => boolean;
  close: () => void;
  /** Props à étaler sur la LIGNE (le contrôle de sélection lui-même, pas un bouton supplémentaire). */
  getRowProps: (key: string) => ListItemRowGestureProps;
  /*
  FNXC:ListItemContextMenu 2026-09-17-10:37:
  FN-506 : ouverture PROGRAMMATIQUE du même menu depuis un déclencheur qui n'est pas une ligne (l'en-tête
  contextuel d'une destination, quand l'objet ouvert occupe le panneau et que sa ligne n'est pas visible).
  Elle partage la clé composée, le bornage au viewport, la garde `enabled` et la fermeture sur changement de
  contexte : il n'existe donc toujours qu'un seul rendu de menu et un seul jeu de gestionnaires.
  */
  openAt: (key: string, x: number, y: number) => void;
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(max) || max <= LIST_ITEM_MENU_VIEWPORT_MARGIN * 2) return Math.max(LIST_ITEM_MENU_VIEWPORT_MARGIN, value);
  return Math.max(LIST_ITEM_MENU_VIEWPORT_MARGIN, Math.min(value, max - LIST_ITEM_MENU_VIEWPORT_MARGIN));
}

/*
FNXC:ListItemContextMenu 2026-09-17-03:18:
FN-486 : une ligne de liste n'expose plus de bouton secondaire ni de « … ». Ses actions s'ouvrent au clic
droit, à la touche Menu / Shift+F10 et à l'appui long tactile ou stylet. Trois règles sont structurantes :

1. Aucun `preventDefault` ni capture au démarrage du geste. Le défilement natif et la fermeture du tiroir
   restent donc possibles ; seule l'expiration du délai d'appui long ouvre un menu, et elle invalide alors le
   candidat de fermeture. Un mouvement au-delà du seuil annule l'appui long avant cette expiration.
2. Le menu est identifié par une CLÉ composée, résolue par l'hôte dans ses données courantes à chaque rendu.
   Aucune closure périmée, aucun index, aucun titre, et jamais la sélection courante comme cible.
3. Le clic synthétique qui suit une activation tactile est supprimé une seule fois, donc un appui long
   n'ouvre pas l'élément, tandis qu'un vrai clic suivant et la navigation clavier restent intacts.
*/
export function useListItemContextMenu({ enabled = true, contextId }: UseListItemContextMenuOptions = {}): ListItemContextMenuController {
  const [anchor, setAnchor] = useState<ListItemMenuAnchor | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ key: string; pointerId: number; x: number; y: number } | null>(null);
  /*
  Le clic synthétique d'une activation tactile est supprimé UNE seule fois et dans une fenêtre courte : un
  drapeau permanent avalerait un vrai clic ultérieur sur la même ligne si aucun clic ne suivait l'appui long.
  */
  const suppressClickAtRef = useRef(0);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  }, []);

  const close = useCallback(() => {
    clearLongPress();
    setAnchor(null);
  }, [clearLongPress]);

  const openAt = useCallback((key: string, x: number, y: number) => {
    if (!enabled) return;
    /* Un menu de ligne qui s'ouvre retire tout candidat de fermeture de tiroir encore en attente. */
    cancelActiveDrawerGestures();
    const width = typeof window === "undefined" ? 0 : window.innerWidth;
    const height = typeof window === "undefined" ? 0 : window.innerHeight;
    setAnchor({ key, x: clamp(x, width), y: clamp(y, height) });
  }, [enabled]);

  /* Hôte désactivé/masqué ou contexte changé : la cible n'est plus valide, le menu se ferme. */
  useEffect(() => {
    if (!enabled) close();
  }, [close, enabled]);
  useEffect(() => {
    setAnchor(null);
  }, [contextId]);

  useEffect(() => () => clearLongPress(), [clearLongPress]);

  /* Un défilement extérieur annule l'appui long en attente, comme sur les cartes du board. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const cancel = () => clearLongPress();
    window.addEventListener("scroll", cancel, true);
    return () => window.removeEventListener("scroll", cancel, true);
  }, [clearLongPress]);

  const getRowProps = useCallback((key: string): ListItemRowGestureProps => ({
    ...listRowGestureAttributes(),
    "aria-haspopup": "menu",
    onContextMenu: (event) => {
      if (!enabled || !isOwnRowGestureTarget(event.target, event.currentTarget)) return;
      /* Le clic droit ne produit pas de `click` primaire : rien à supprimer, sous peine d'avaler le suivant. */
      event.preventDefault();
      event.stopPropagation();
      clearLongPress();
      openAt(key, event.clientX, event.clientY);
    },
    onKeyDown: (event) => {
      if (!enabled) return;
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      if (!isOwnRowGestureTarget(event.target, event.currentTarget)) return;
      event.preventDefault();
      event.stopPropagation();
      /* La touche Menu n'a pas de coordonnées : le menu s'ancre sur la boîte de la ligne. */
      const rect = event.currentTarget.getBoundingClientRect();
      openAt(key, rect.left + LIST_ITEM_MENU_KEYBOARD_OFFSET, rect.top + LIST_ITEM_MENU_KEYBOARD_OFFSET);
    },
    onPointerDown: (event) => {
      if (!enabled || event.pointerType === "mouse") return;
      if (!event.isPrimary) { clearLongPress(); return; }
      if (!isOwnRowGestureTarget(event.target, event.currentTarget)) return;
      clearLongPress();
      const { clientX, clientY } = event;
      longPressStartRef.current = { key, pointerId: event.pointerId, x: clientX, y: clientY };
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        longPressStartRef.current = null;
        suppressClickAtRef.current = Date.now();
        openAt(key, clientX, clientY);
      }, LIST_ITEM_LONG_PRESS_DELAY_MS);
    },
    onPointerMove: (event) => {
      const start = longPressStartRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      if (Math.abs(event.clientX - start.x) > LIST_ITEM_LONG_PRESS_MOVE_THRESHOLD
        || Math.abs(event.clientY - start.y) > LIST_ITEM_LONG_PRESS_MOVE_THRESHOLD) clearLongPress();
    },
    onPointerUp: () => clearLongPress(),
    onPointerCancel: () => clearLongPress(),
    onClickCapture: (event) => {
      if (Date.now() - suppressClickAtRef.current > 1000) return;
      suppressClickAtRef.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
  }), [clearLongPress, enabled, openAt]);

  const isOpen = useCallback((key: string) => anchor?.key === key, [anchor]);

  return useMemo(() => ({ anchor, isOpen, close, getRowProps, openAt }), [anchor, close, getRowProps, isOpen, openAt]);
}
