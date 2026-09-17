/*
FNXC:ListItemGesture 2026-09-17-03:18:
FN-486 : contrat PARTAGÉ et purement transitoire entre une ligne de liste et le geste de fermeture du tiroir.
Une ligne de SÉLECTION peut rester un vrai `button` accessible ; elle se déclare simplement comme cible de
ligne (`data-drawer-dismiss-row`). `useDrawerDismissGesture` n'exclut donc plus tous les contrôles interactifs
en bloc : il n'exclut que ceux qui ne sont PAS cette cible qualifiée. Un champ de renommage, un lien, un
bouton imbriqué, un slider ou une surface xterm placés SOUS une ligne qualifiée restent exclus, parce que le
contrôle interactif le plus proche de la cible n'est alors plus la ligne elle-même.

FNXC:ListItemGesture 2026-09-17-03:18:
Le signal d'ouverture de menu est un registre LOCAL et transitoire, jamais un bus persistant : quand une ligne
ouvre son menu contextuel, tout candidat de fermeture de tiroir encore en attente est invalidé immédiatement,
de sorte que « appui long puis menu » et « glissement puis fermeture » restent deux ordonnancements exclusifs.
*/

/** Attribut porté par une ligne de liste éligible au geste de fermeture du tiroir. */
export const LIST_ITEM_ROW_ATTRIBUTE = "data-drawer-dismiss-row";

export const LIST_ITEM_ROW_SELECTOR = `[${LIST_ITEM_ROW_ATTRIBUTE}]`;

/** Marqueur de surface portalisée du menu de ligne, partagé avec `portalSurfaces`. */
export const LIST_ITEM_MENU_PORTAL_SURFACE = "list-item-menu";

export const LIST_ITEM_MENU_PORTAL_SELECTOR = `[data-portal-surface="${LIST_ITEM_MENU_PORTAL_SURFACE}"]`;

/**
 * Délai d'appui long, aligné sur celui des menus tactiles de `TaskCard` afin que l'opérateur n'ait pas deux
 * temporisations différentes selon la liste qu'il touche.
 */
export const LIST_ITEM_LONG_PRESS_DELAY_MS = 500;

/**
 * Seuil de mouvement annulant l'appui long. Il vaut exactement le seuil d'intention du geste de tiroir
 * (`INTENT_THRESHOLD`), donc l'appui long est annulé AU PLUS TARD au moment où le tiroir peut prendre le geste.
 */
export const LIST_ITEM_LONG_PRESS_MOVE_THRESHOLD = 6;

/** Marge de sécurité du menu par rapport aux bords du viewport. */
export const LIST_ITEM_MENU_VIEWPORT_MARGIN = 8;

/** Décalage du menu ouvert au clavier, mesuré depuis le coin haut-gauche de la ligne. */
export const LIST_ITEM_MENU_KEYBOARD_OFFSET = 16;

export const INTERACTIVE_GESTURE_SELECTOR = "button, input, select, textarea, a[href], [contenteditable='true'], [role='button'], [role='slider'], [role='textbox']";

export const EXCLUDED_GESTURE_SELECTOR = ".xterm, .xterm-screen, .xterm-viewport";

/** Attributs à étaler sur une ligne de liste pour la qualifier comme cible de sélection. */
export function listRowGestureAttributes(): Record<string, string> {
  return { [LIST_ITEM_ROW_ATTRIBUTE]: "true" };
}

/**
 * Vrai lorsque le contrôle interactif le plus proche de `target` est une ligne de liste qualifiée — ou
 * qu'il n'y a aucun contrôle interactif du tout (ligne en `div`, texte libre, avatar…).
 */
export function isQualifiedRowGestureTarget(target: Element): boolean {
  const interactive = target.closest(INTERACTIVE_GESTURE_SELECTOR);
  return interactive === null || interactive.matches(LIST_ITEM_ROW_SELECTOR);
}

/**
 * Variante utilisée PAR la ligne elle-même : le geste n'appartient à la ligne que si aucun contrôle
 * interactif imbriqué (champ de renommage, bouton de confirmation, lien) ne se trouve entre la cible et elle.
 */
export function isOwnRowGestureTarget(target: unknown, row: Element): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (!row.contains(target)) return false;
  if (target.closest(EXCLUDED_GESTURE_SELECTOR)) return false;
  const interactive = target.closest(INTERACTIVE_GESTURE_SELECTOR);
  return interactive === null || interactive === row || !row.contains(interactive);
}

type DrawerGestureCanceller = () => void;

const drawerGestureCancellers = new Set<DrawerGestureCanceller>();

/** Enregistre l'invalidation d'un candidat de fermeture. Le retour désabonne. */
export function registerDrawerGestureCanceller(cancel: DrawerGestureCanceller): () => void {
  drawerGestureCancellers.add(cancel);
  return () => { drawerGestureCancellers.delete(cancel); };
}

/** Invalide immédiatement tout candidat de fermeture en attente (appelé à l'ouverture d'un menu de ligne). */
export function cancelActiveDrawerGestures(): void {
  for (const cancel of Array.from(drawerGestureCancellers)) cancel();
}
