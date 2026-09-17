import {
  cloneElement,
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type InputHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { useDashboardWindowSurface, useDashboardWindowFocusRestoring } from "../../context/DashboardWindowManagerContext";
import { currentFloatingZ, nextFloatingZ } from "../floatingWindowStack";

type UiButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;
type UiInputProps = InputHTMLAttributes<HTMLInputElement>;
type UiTextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;
type UiSurfaceProps = HTMLAttributes<HTMLDivElement>;
type UiSelectProps = SelectHTMLAttributes<HTMLSelectElement> & { "data-testid"?: string };
/*
FNXC:NativeUiCollections 2026-09-17-03:18:
FN-486 : `preventScrollOnFocus` est une OPTION, défaut inchangé (`false`). Un menu portalisé ouvert depuis une
ligne de liste vit au-dessus d'un tiroir ou d'une colonne défilante qui se ferme au défilement : si l'entrée de
focus faisait défiler un ancêtre, le menu se refermerait aussitôt après s'être ouvert. Le contrat clavier reste
identique pour tous les autres appelants.
*/
type UiMenuProps = HTMLAttributes<HTMLDivElement> & { "aria-label": string; preventScrollOnFocus?: boolean };
type UiMenuSectionProps = HTMLAttributes<HTMLElement> & { "aria-label": string };
export type UiMenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & { id?: string };
type UiMenuRowProps = UiMenuItemProps & { collectionLabel: string; auxiliary?: ReactNode; rowClassName?: string };
type UiMenuSubmenuProps = { id: string; label: string; className?: string; menuClassName?: string; children: ReactNode };
type UiListBoxProps = HTMLAttributes<HTMLElement> & { "aria-label": string; legacyAs?: "div" | "ul" };
type UiListBoxRowProps = UiListBoxItemProps & { collectionLabel: string; auxiliary?: ReactNode; rowClassName?: string };
export type UiListBoxItemProps = HTMLAttributes<HTMLElement> & {
  id: string;
  textValue: string;
  isDisabled?: boolean;
  legacyAs?: "button" | "div" | "li";
};

/*
FNXC:NativeUiPrimitives 2026-09-15-00:20:
These were the `ui` primitives. Fusion's homemade presentation is NATIVE, so there is no
`AlphaProvider`, no `AlphaBoundary`, and no `useUiSurface()` branch any more. Every primitive
behaves unconditionally the way the in-boundary variant behaved: markers are always published, popovers
always portal, collections always carry the roving-focus contract, and menus always transfer and restore
focus. The native behaviour is deliberately the UNION of the two former variants, not the surviving
branch of a deleted `if` — a component that used to sit outside a boundary (a model dropdown inside a
form, a workflow switcher in the header, a task context menu in the list) keeps every capability it had
and gains the ones the boundary used to gate.

FNXC:NativeUiPrimitives 2026-09-15-00:20:
Controls use native HTML semantics and preserve the existing business callbacks, refs, controlled values,
disabled state, accessible names, and form behavior. `data-ui` / `data-ui-portal` are DESCRIPTIVE
presentation hooks consumed by native-ui.css; they are not a re-enable-able perimeter and nothing reads
them to decide behaviour.

FNXC:NativeUiCollections 2026-09-15-00:20:
Listboxes and menus use one roving-focus collection with ArrowUp, ArrowDown, Home, and End navigation.
Auxiliary actions remain siblings reachable by Tab, while submenus render beside their trigger so
interactive controls are never nested.
*/
function uiMarker(kind: string) {
  return { "data-ui": kind };
}

function focusCollectionItem(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const root = event.currentTarget;
  const items = Array.from(root.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"]), [role^="menuitem"]:not(:disabled):not([aria-disabled="true"])'));
  if (items.length === 0) return;
  event.preventDefault();
  const active = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowUp"
    ? (active <= 0 ? items.length - 1 : active - 1)
    : (active < 0 || active === items.length - 1 ? 0 : active + 1);
  items[next]?.focus();
}

function useEscape(onClose?: () => void, active = true) {
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!onClose) return;
    const close = (event: globalThis.KeyboardEvent) => { if (activeRef.current && event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
}

export const UiButton = forwardRef<HTMLButtonElement, UiButtonProps>(function UiButton(props, ref) {
  return <button ref={ref} {...uiMarker("button")} {...props} />;
});

export const UiInput = forwardRef<HTMLInputElement, UiInputProps>(function UiInput(props, ref) {
  return <input ref={ref} {...uiMarker("input")} {...props} />;
});

export const UiTextArea = forwardRef<HTMLTextAreaElement, UiTextAreaProps>(function UiTextArea(props, ref) {
  return <textarea ref={ref} {...uiMarker("textarea")} {...props} />;
});

export const UiPopoverSurface = forwardRef<HTMLDivElement, UiSurfaceProps & { triggerRef?: RefObject<Element | null>; onClose?: () => void }>(function UiPopoverSurface({ children, triggerRef: _triggerRef, onClose, onKeyDown, ...props }, ref) {
  /*
  FNXC:NativeUiKeyboard 2026-09-15-00:20:
  Escape is handled on the PANEL, not on the document. A document-level listener would collapse the nested
  Escape hierarchy (submenu first, then menu, then the composer's own field) because every open popover
  would dismiss on the same keystroke. The menu autofocuses its filter/first item on open, so the panel
  reliably owns the key while it is the innermost open surface.
  */
  const panel = <div ref={ref} role="dialog" data-ui="popover" data-ui-portal="true" onKeyDown={(event) => { onKeyDown?.(event); if (event.key === "Escape") onClose?.(); }} {...props}>{children}</div>;
  return typeof document !== "undefined" ? createPortal(panel, document.body) : panel;
});

export const UiPortalSurface = forwardRef<HTMLDivElement, UiSurfaceProps>(function UiPortalSurface(props, ref) {
  return <div ref={ref} data-ui="portal-surface" data-ui-portal="true" {...props} />;
});

export const UiListBox = forwardRef<HTMLDivElement, UiListBoxProps>(function UiListBox({ children, legacyAs = "div", onKeyDown, ...props }, ref) {
  const Element = legacyAs;
  return <Element ref={ref as never} role="listbox" tabIndex={0} {...uiMarker("listbox")} onKeyDown={(event) => { onKeyDown?.(event); if (!event.defaultPrevented) focusCollectionItem(event); }} {...props}>{children}</Element>;
});

export const UiListBoxItem = forwardRef<HTMLDivElement, UiListBoxItemProps>(function UiListBoxItem({ children, id, textValue: _textValue, isDisabled, legacyAs = "div", onClick, tabIndex: _tabIndex, ...props }, ref) {
  const Element = legacyAs;
  return <Element ref={ref as never} id={id} role="option" aria-disabled={isDisabled || undefined} tabIndex={-1} {...(legacyAs === "button" ? { type: "button", disabled: isDisabled } : {})} {...uiMarker("listbox-item")} onClick={isDisabled ? undefined : onClick as never} {...props}>{children}</Element>;
});

export const UiListBoxRow = forwardRef<HTMLDivElement, UiListBoxRowProps>(function UiListBoxRow({ collectionLabel: _collectionLabel, auxiliary, rowClassName, children, className, onClick, ...itemProps }, ref) {
  return <div ref={ref} className={rowClassName}><UiListBoxItem className={className} onClick={onClick} {...itemProps}>{children}</UiListBoxItem>{auxiliary}</div>;
});

export const UiDialogPanel = forwardRef<HTMLDivElement, UiSurfaceProps & { labelledBy?: string }>(function UiDialogPanel({ children, labelledBy, ...props }, ref) {
  return <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy} {...uiMarker("dialog")} {...props}>{children}</div>;
});

export const UiSurface = forwardRef<HTMLDivElement, UiSurfaceProps>(function UiSurface(props, ref) {
  return <div ref={ref} {...uiMarker("surface")} {...props} />;
});

export const UiSelect = forwardRef<HTMLSelectElement, UiSelectProps>(function UiSelect(props, ref) {
  return <select ref={ref} {...uiMarker("select")} {...props} />;
});

export function UiMenuSubmenu({ id, label, className, menuClassName, children }: UiMenuSubmenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);
  return <div className="ui-submenu-host">
    <button ref={triggerRef} id={`${id}-submenu`} type="button" role="menuitem" className={className} aria-haspopup="menu" aria-expanded={open} data-task-submenu-toggle={id} {...uiMarker("menu-item")} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (["ArrowRight", "Enter", " "].includes(event.key)) { event.preventDefault(); setOpen(true); } }} >{label}</button>
    {open ? <UiMenu ref={menuRef} className={menuClassName} data-task-submenu={id} aria-label={label} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "Escape") { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); } }}>{children}</UiMenu> : null}
  </div>;
}

export function UiMenuSection({ children, ...props }: UiMenuSectionProps) {
  return <section role="group" {...props}>{children}</section>;
}

export const UiMenu = forwardRef<HTMLDivElement, UiMenuProps>(function UiMenu({ children, onKeyDown, onFocus, preventScrollOnFocus = false, ...props }, ref) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  /*
  FNXC:NativeUiCollections 2026-09-15-00:20:
  Opening a menu transfers focus from its trigger to the first enabled item. One roving tab stop follows
  Arrow/Home/End navigation, and closing the menu restores the trigger when focus was still owned by the
  menu. This runs for every menu now that the presentation is native, so list, card, header and detail
  menus share one keyboard contract.
  */
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const active = document.activeElement;
    triggerRef.current = active instanceof HTMLElement && !menu.contains(active) ? active : null;
    const firstItem = menu.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])');
    if (firstItem) {
      menu.querySelectorAll<HTMLElement>('[role^="menuitem"]').forEach((item) => { item.tabIndex = item === firstItem ? 0 : -1; });
      firstItem.focus({ preventScroll: preventScrollOnFocus });
    }
    return () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && (menu.contains(focused) || focused === document.body) && triggerRef.current?.isConnected) {
        triggerRef.current.focus({ preventScroll: preventScrollOnFocus });
      }
    };
    /* Le mode de focus est volontairement figé à l'ouverture du menu : la liste de dépendances reste vide. */
  }, []);

  return <div ref={(node) => {
    menuRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }} role="menu" {...uiMarker("menu")} onFocus={(event) => {
    onFocus?.(event);
    if (!(event.target instanceof HTMLElement) || !event.target.matches('[role^="menuitem"]')) return;
    event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]').forEach((item) => { item.tabIndex = item === event.target ? 0 : -1; });
  }} onKeyDown={(event) => { onKeyDown?.(event); if (!event.defaultPrevented) focusCollectionItem(event); }} {...props}>{children}</div>;
});

export const UiMenuRow = forwardRef<HTMLDivElement, UiMenuRowProps>(function UiMenuRow({ collectionLabel: _collectionLabel, auxiliary, rowClassName, children, className, disabled, id, onClick, ...itemProps }, ref) {
  return <div ref={ref} className={rowClassName}><UiMenuItem className={className} disabled={disabled} id={id} onClick={onClick} {...itemProps}>{children}</UiMenuItem>{auxiliary}</div>;
});

export const UiMenuItem = forwardRef<HTMLButtonElement, UiMenuItemProps>(function UiMenuItem({ children, tabIndex: _tabIndex, ...props }, ref) {
  return <button ref={ref} type="button" role="menuitem" tabIndex={-1} {...uiMarker("menu-item")} {...props}>{children}</button>;
});


/*
FNXC:DashboardWindowVisibility 2026-09-14-10:52:
Dialog backdrops are first-class managed surfaces. Global hiding retains their trees but disables Escape
and backdrop dismissal; popovers and collection surfaces remain intentionally outside the snapshot registry.

FNXC:DialogStacking 2026-09-14-17:46:
FN-392: a child dialog (Refine, Reset, New Chat, duplicate warning) is body-portaled, so a static CSS z-index put it
UNDER the floating work window that opened it. Every shared dialog therefore claims the shared floating-utility layer
on open, publishes it as its `stackOrder`, and applies it inline so it always dominates the task/chat band. The parent
`FloatingWindow` raises itself from CAPTURE-phase pointer/focus handlers, which run before this bubble-phase handler in
the same React event, so re-claiming here is what keeps the dialog above its parent after a real interaction. A focus
claim is skipped while the window manager is restoring focus after a global hide, so hide/show never reorders anything.
*/
function useUiDialogLayer(logicalId: string) {
  const focusRestoring = useDashboardWindowFocusRestoring();
  const [layer, setLayer] = useState(() => nextFloatingZ());
  const windowSurface = useDashboardWindowSurface({ logicalId, group: "dialog", locallyVisible: true, stackOrder: layer });
  const raise = useCallback(() => {
    setLayer((current) => (current >= currentFloatingZ() ? current : nextFloatingZ()));
  }, []);
  const surfaceActive = windowSurface.surfaceActive;
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!surfaceActive || event.isDefaultPrevented()) return;
    raise();
  }, [raise, surfaceActive]);
  const onFocus = useCallback(() => {
    if (!surfaceActive || focusRestoring()) return;
    raise();
  }, [focusRestoring, raise, surfaceActive]);
  return { windowSurface, layer, onPointerDown, onFocus };
}

function portalDialog(dialog: ReactElement): ReactElement {
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body) as unknown as ReactElement;
}

export function UiDialogBackdrop({ children, overlayClassName, labelledBy, onClose, overlayProps }: { children: ReactElement<HTMLAttributes<HTMLElement>>; overlayClassName?: string; labelledBy?: string; onClose?: () => void; overlayProps?: HTMLAttributes<HTMLDivElement> }) {
  const { windowSurface, layer, onPointerDown, onFocus } = useUiDialogLayer(labelledBy ?? "ui-dialog");
  useEscape(onClose, windowSurface.surfaceActive);
  const dialog = (
    <div
      {...overlayProps}
      ref={windowSurface.rootRef}
      className={overlayClassName}
      role="presentation"
      style={{ ...(overlayProps?.style as CSSProperties | undefined), zIndex: layer }}
      aria-hidden={windowSurface.surfaceAttributes["aria-hidden"]}
      inert={windowSurface.surfaceAttributes.inert}
      data-dashboard-window-surface={windowSurface.surfaceAttributes["data-dashboard-window-surface"]}
      data-dashboard-window-globally-hidden={windowSurface.surfaceAttributes["data-dashboard-window-globally-hidden"]}
      data-ui-portal="true"
      data-ui="dialog-backdrop"
      onPointerDown={(event) => {
        overlayProps?.onPointerDown?.(event);
        onPointerDown(event);
      }}
      onFocus={(event) => {
        overlayProps?.onFocus?.(event);
        onFocus();
      }}
      onMouseDown={(event) => {
        if (!windowSurface.surfaceActive) return;
        overlayProps?.onMouseDown?.(event);
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      {cloneElement(children, { role: "dialog", "aria-modal": true, "aria-labelledby": labelledBy ?? children.props["aria-labelledby"], ...uiMarker("dialog") } as HTMLAttributes<HTMLElement>)}
    </div>
  );
  return portalDialog(dialog);
}

export function UiDialog({ children, className, overlayClassName, labelledBy, onClose }: { children: ReactNode; className?: string; overlayClassName?: string; labelledBy?: string; onClose?: () => void }) {
  const { windowSurface, layer, onPointerDown, onFocus } = useUiDialogLayer(labelledBy ?? "ui-dialog");
  useEscape(onClose, windowSurface.surfaceActive);
  const dialog = (
    <div
      ref={windowSurface.rootRef}
      className={overlayClassName}
      role="presentation"
      style={{ zIndex: layer }}
      aria-hidden={windowSurface.surfaceAttributes["aria-hidden"]}
      inert={windowSurface.surfaceAttributes.inert}
      data-dashboard-window-surface={windowSurface.surfaceAttributes["data-dashboard-window-surface"]}
      data-dashboard-window-globally-hidden={windowSurface.surfaceAttributes["data-dashboard-window-globally-hidden"]}
      data-ui-portal="true"
      data-ui="dialog-backdrop"
      onPointerDown={onPointerDown}
      onFocus={onFocus}
      onMouseDown={(event) => {
        if (windowSurface.surfaceActive && event.target === event.currentTarget) onClose?.();
      }}
    >
      <div className={className} role="dialog" aria-modal="true" aria-labelledby={labelledBy} {...uiMarker("dialog")}>{children}</div>
    </div>
  );
  return portalDialog(dialog);
}

export function UiSpinner({ className, label }: { className?: string; label: string }) {
  return <span className={className} role="status" aria-label={label} {...uiMarker("spinner")} />;
}
