import "./ListItemContextMenu.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { UiMenu, UiMenuItem } from "./ui";
import {
  LIST_ITEM_MENU_PORTAL_SURFACE,
  LIST_ITEM_MENU_VIEWPORT_MARGIN,
} from "../utils/listItemGesture";
import type { ListItemMenuAnchor } from "../hooks/useListItemContextMenu";

export type ListItemMenuActionTone = "default" | "danger";

export interface ListItemMenuAction {
  id: string;
  label: string;
  tone?: ListItemMenuActionTone;
  disabled?: boolean;
  testId?: string;
  onSelect?: () => void;
}

export interface ListItemContextMenuProps {
  anchor: ListItemMenuAnchor | null;
  /** Nom accessible du menu, construit par l'hôte à partir du titre de sa cible. */
  ariaLabel: string;
  actions: ListItemMenuAction[];
  onClose: () => void;
  className?: string;
  "data-testid"?: string;
}

/*
FNXC:ListItemContextMenu 2026-09-17-03:18:
FN-486 : rendu PARTAGÉ du menu de ligne, composé des primitives existantes `UiMenu`/`UiMenuItem` — donc le
contrat clavier (Arrow/Home/End, transfert et restitution du focus) et la sémantique `role="menu"` viennent
d'un seul endroit. Le menu est portalisé dans `document.body` et positionné en coordonnées viewport, parce
que ses hôtes (tiroir téléphone, fenêtre flottante, popover de dock, colonne défilante) rognent tous leur
contenu. Il se ferme sur Escape, sur un vrai appui extérieur, sur un défilement et lorsque son hôte retire
sa cible ; une liste d'actions vide ne rend RIEN, de sorte qu'aucune ligne sans action n'ouvre un menu vide.

FNXC:ContextMenuLayering 2026-09-18-01:13:
FN-521 : le menu ne réclame PLUS de calque au montage (`nextFloatingZ()`). Une réclamation est figée à la
valeur du compteur au moment du montage, donc tout hôte réhausé ensuite — ou déclaré au-dessus du plafond,
comme `.dashboard-tool-popover` à `calc(var(--fusion-max-z) + 3)` — peignait par-dessus le menu. Le calque
est désormais porté par le CSS, dérivé du plafond VIVANT (`+ 6`), donc il domine toujours l'hôte de sa cible.
*/
export function ListItemContextMenu({ anchor, ariaLabel, actions, onClose, className, "data-testid": testId }: ListItemContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const touchSelectedRef = useRef<{ id: string; at: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const hasActions = actions.length > 0;
  const anchorKey = anchor?.key ?? null;
  const anchorX = anchor?.x ?? 0;
  const anchorY = anchor?.y ?? 0;

  useEffect(() => {
    setPosition(anchorKey === null ? null : { x: anchorX, y: anchorY });
  }, [anchorKey, anchorX, anchorY]);

  /* Clamp après rendu avec la taille réellement mesurée, pour ne jamais déborder du viewport. */
  useLayoutEffect(() => {
    if (!position || !hasActions) return;
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const maxX = Math.max(LIST_ITEM_MENU_VIEWPORT_MARGIN, window.innerWidth - rect.width - LIST_ITEM_MENU_VIEWPORT_MARGIN);
    const maxY = Math.max(LIST_ITEM_MENU_VIEWPORT_MARGIN, window.innerHeight - rect.height - LIST_ITEM_MENU_VIEWPORT_MARGIN);
    const next = { x: Math.min(position.x, maxX), y: Math.min(position.y, maxY) };
    if (next.x !== position.x || next.y !== position.y) setPosition(next);
  }, [hasActions, position]);

  useEffect(() => {
    if (!anchorKey || !hasActions) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [anchorKey, hasActions, onClose]);

  const select = useCallback((action: ListItemMenuAction) => {
    if (action.disabled || !action.onSelect) return;
    onClose();
    action.onSelect();
  }, [onClose]);

  /* Activation tactile au relâchement, puis garde anti-double-appel sur le clic synthétisé qui suit. */
  const onActionPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>, action: ListItemMenuAction) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    touchSelectedRef.current = { id: action.id, at: Date.now() };
    select(action);
  }, [select]);

  const onActionClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>, action: ListItemMenuAction) => {
    const touched = touchSelectedRef.current;
    if (touched?.id === action.id && Date.now() - touched.at < 1000) {
      event.preventDefault();
      event.stopPropagation();
      touchSelectedRef.current = null;
      return;
    }
    touchSelectedRef.current = null;
    event.stopPropagation();
    select(action);
  }, [select]);

  if (!anchor || !hasActions || !position || typeof document === "undefined") return null;

  const menu = (
    <UiMenu
      ref={menuRef}
      aria-label={ariaLabel}
      preventScrollOnFocus
      data-portal-surface={LIST_ITEM_MENU_PORTAL_SURFACE}
      data-testid={testId ?? "list-item-context-menu"}
      className={["list-item-context-menu", className].filter(Boolean).join(" ")}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map((action) => (
        <UiMenuItem
          key={action.id}
          id={action.id}
          className={["list-item-context-menu__item", action.tone === "danger" ? "list-item-context-menu__item--danger" : ""].filter(Boolean).join(" ")}
          disabled={action.disabled}
          data-testid={action.testId}
          onPointerUp={(event) => onActionPointerUp(event, action)}
          onClick={(event) => onActionClick(event, action)}
        >
          {action.label}
        </UiMenuItem>
      ))}
    </UiMenu>
  );
  return createPortal(menu, document.body);
}
