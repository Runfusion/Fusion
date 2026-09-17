/*
FNXC:ModelDropdown 2026-09-06-21:10:
Body-portaled menus and the chat Brain panel are logical children of their launching controls. Dismissal hosts must share this contract instead of copying class selectors, so a menu re-anchor during mobile keyboard use cannot turn an inside gesture into an outside dismissal.
*/
export const PORTAL_SAFE_SURFACE_SELECTOR = [
  ".floating-window",
  ".modal-overlay",
  "[role=\"dialog\"]",
  "[data-portal-surface=\"chat-thinking\"]",
  ".model-combobox-dropdown--portal",
  ".model-nested-menu--portal",
  ".dep-dropdown--portal",
  ".node-picker-dropdown--portal",
  ".agent-picker-dropdown--portal",
  ".priority-picker-dropdown--portal",
  ".activity-view-menu",
  /*
  FNXC:ListItemContextMenu 2026-09-17-03:18:
  FN-486 : le menu contextuel d'une ligne de liste est un enfant LOGIQUE de la ligne qui l'a ouvert. Sans ce
  marqueur, l'utiliser depuis une fenêtre flottante ou un popover de dock refermerait son hôte, alors que le
  vrai appui extérieur doit continuer de fermer normalement.
  */
  "[data-portal-surface=\"list-item-menu\"]",
].join(", ");

export const PORTALED_MODEL_MENU_SELECTOR = ".model-combobox-dropdown--portal, .model-nested-menu--portal, [data-portal-surface=\"model-menu\"]";

function targetElement(target: unknown): Element | null {
  if (typeof Node === "undefined" || !(target instanceof Node)) return null;
  return target.nodeType === Node.ELEMENT_NODE ? target as Element : target.parentElement;
}

export function isInsidePortalSafeSurface(target: unknown, selector = PORTAL_SAFE_SURFACE_SELECTOR): boolean {
  return targetElement(target)?.closest(selector) != null;
}

export function isInsidePortaledModelMenu(target: unknown): boolean {
  return isInsidePortalSafeSurface(target, PORTALED_MODEL_MENU_SELECTOR);
}
