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
import { useAlphaSurface } from "../../context/AlphaContext";
import { useDashboardWindowSurface, useDashboardWindowFocusRestoring } from "../../context/DashboardWindowManagerContext";
import { currentFloatingZ, nextFloatingZ } from "../floatingWindowStack";

type AlphaButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;
type AlphaInputProps = InputHTMLAttributes<HTMLInputElement>;
type AlphaTextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;
type AlphaSurfaceProps = HTMLAttributes<HTMLDivElement>;
type AlphaSelectProps = SelectHTMLAttributes<HTMLSelectElement> & { "data-testid"?: string };
type AlphaMenuProps = HTMLAttributes<HTMLDivElement> & { "aria-label": string };
type AlphaMenuSectionProps = HTMLAttributes<HTMLElement> & { "aria-label": string };
export type AlphaMenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & { id?: string };
type AlphaMenuRowProps = AlphaMenuItemProps & { collectionLabel: string; auxiliary?: ReactNode; rowClassName?: string };
type AlphaMenuSubmenuProps = { id: string; label: string; className?: string; menuClassName?: string; children: ReactNode };
type AlphaListBoxProps = HTMLAttributes<HTMLElement> & { "aria-label": string; legacyAs?: "div" | "ul" };
type AlphaListBoxRowProps = AlphaListBoxItemProps & { collectionLabel: string; auxiliary?: ReactNode; rowClassName?: string };
export type AlphaListBoxItemProps = HTMLAttributes<HTMLElement> & {
  id: string;
  textValue: string;
  isDisabled?: boolean;
  legacyAs?: "button" | "div" | "li";
};

/*
FNXC:HomemadeAlphaPrimitives 2026-09-11-16:14:
Alpha controls use native HTML semantics and preserve the existing business callbacks, refs, controlled values, disabled state, accessible names, and form behavior. Alpha markers are presentation hooks only; they do not replace browser interaction contracts with synthetic event adapters.

FNXC:HomemadeAlphaCollections 2026-09-11-16:14:
Listboxes and menus use one roving-focus collection with ArrowUp, ArrowDown, Home, and End navigation. Auxiliary actions remain siblings reachable by Tab, while submenus render beside their trigger so interactive controls are never nested.
*/
function alphaMarker(alpha: boolean, kind: string) {
  return alpha ? { "data-alpha-ui": kind } : {};
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

export const AlphaButton = forwardRef<HTMLButtonElement, AlphaButtonProps>(function AlphaButton(props, ref) {
  const alpha = useAlphaSurface();
  return <button ref={ref} {...alphaMarker(alpha, "button")} {...props} />;
});

export const AlphaInput = forwardRef<HTMLInputElement, AlphaInputProps>(function AlphaInput(props, ref) {
  const alpha = useAlphaSurface();
  return <input ref={ref} {...alphaMarker(alpha, "input")} {...props} />;
});

export const AlphaTextArea = forwardRef<HTMLTextAreaElement, AlphaTextAreaProps>(function AlphaTextArea(props, ref) {
  const alpha = useAlphaSurface();
  return <textarea ref={ref} {...alphaMarker(alpha, "textarea")} {...props} />;
});

export const AlphaPopoverSurface = forwardRef<HTMLDivElement, AlphaSurfaceProps & { triggerRef?: RefObject<Element | null>; onClose?: () => void }>(function AlphaPopoverSurface({ children, triggerRef: _triggerRef, onClose, onKeyDown, ...props }, ref) {
  const alpha = useAlphaSurface();
  const panel = <div ref={ref} role="dialog" {...(alpha ? { "data-alpha-ui": "popover", "data-alpha-portal": "true" } : {})} onKeyDown={(event) => { onKeyDown?.(event); if (event.key === "Escape") onClose?.(); }} {...props}>{children}</div>;
  return alpha && typeof document !== "undefined" ? createPortal(panel, document.body) : panel;
});

export const AlphaPortalSurface = forwardRef<HTMLDivElement, AlphaSurfaceProps>(function AlphaPortalSurface(props, ref) {
  const alpha = useAlphaSurface();
  return <div ref={ref} {...(alpha ? { "data-alpha-ui": "portal-surface", "data-alpha-portal": "true" } : {})} {...props} />;
});

export const AlphaListBox = forwardRef<HTMLDivElement, AlphaListBoxProps>(function AlphaListBox({ children, legacyAs = "div", onKeyDown, ...props }, ref) {
  const alpha = useAlphaSurface();
  const Element = legacyAs;
  return <Element ref={ref as never} role="listbox" tabIndex={alpha ? 0 : props.tabIndex} {...alphaMarker(alpha, "listbox")} onKeyDown={(event) => { onKeyDown?.(event); if (!event.defaultPrevented) focusCollectionItem(event); }} {...props}>{children}</Element>;
});

export const AlphaListBoxItem = forwardRef<HTMLDivElement, AlphaListBoxItemProps>(function AlphaListBoxItem({ children, id, textValue: _textValue, isDisabled, legacyAs = "div", onClick, tabIndex, ...props }, ref) {
  const alpha = useAlphaSurface();
  const Element = legacyAs;
  return <Element ref={ref as never} id={id} role="option" aria-disabled={isDisabled || undefined} tabIndex={isDisabled || alpha ? -1 : (tabIndex ?? 0)} {...(legacyAs === "button" ? { type: "button", disabled: isDisabled } : {})} {...alphaMarker(alpha, "listbox-item")} onClick={isDisabled ? undefined : onClick as never} {...props}>{children}</Element>;
});

export const AlphaListBoxRow = forwardRef<HTMLDivElement, AlphaListBoxRowProps>(function AlphaListBoxRow({ collectionLabel: _collectionLabel, auxiliary, rowClassName, children, className, onClick, ...itemProps }, ref) {
  return <div ref={ref} className={rowClassName}><AlphaListBoxItem className={className} onClick={onClick} {...itemProps}>{children}</AlphaListBoxItem>{auxiliary}</div>;
});

export const AlphaDialogPanel = forwardRef<HTMLDivElement, AlphaSurfaceProps & { labelledBy?: string }>(function AlphaDialogPanel({ children, labelledBy, ...props }, ref) {
  const alpha = useAlphaSurface();
  return <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy} {...alphaMarker(alpha, "dialog")} {...props}>{children}</div>;
});

export const AlphaSurface = forwardRef<HTMLDivElement, AlphaSurfaceProps>(function AlphaSurface(props, ref) {
  const alpha = useAlphaSurface();
  return <div ref={ref} {...alphaMarker(alpha, "surface")} {...props} />;
});

export const AlphaSelect = forwardRef<HTMLSelectElement, AlphaSelectProps>(function AlphaSelect(props, ref) {
  const alpha = useAlphaSurface();
  return <select ref={ref} {...alphaMarker(alpha, "select")} {...props} />;
});

export function AlphaMenuSubmenu({ id, label, className, menuClassName, children }: AlphaMenuSubmenuProps) {
  const alpha = useAlphaSurface();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);
  return <div className="alpha-submenu-host">
    <button ref={triggerRef} id={`${id}-submenu`} type="button" role="menuitem" className={className} aria-haspopup="menu" aria-expanded={open} data-task-submenu-toggle={id} {...alphaMarker(alpha, "menu-item")} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (["ArrowRight", "Enter", " "].includes(event.key)) { event.preventDefault(); setOpen(true); } }} >{label}</button>
    {open ? <AlphaMenu ref={menuRef} className={menuClassName} data-task-submenu={id} aria-label={label} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "Escape") { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); } }}>{children}</AlphaMenu> : null}
  </div>;
}

export function AlphaMenuSection({ children, ...props }: AlphaMenuSectionProps) {
  return <section role="group" {...props}>{children}</section>;
}

export const AlphaMenu = forwardRef<HTMLDivElement, AlphaMenuProps>(function AlphaMenu({ children, onKeyDown, onFocus, ...props }, ref) {
  const alpha = useAlphaSurface();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  /*
  FNXC:HomemadeAlphaCollections 2026-09-11-16:53:
  Opening an Alpha menu transfers focus from its trigger to the first enabled item. One roving tab stop follows Arrow/Home/End navigation, and closing the menu restores the trigger when focus was still owned by the menu.
  */
  useEffect(() => {
    const menu = menuRef.current;
    if (!alpha || !menu) return;
    const active = document.activeElement;
    triggerRef.current = active instanceof HTMLElement && !menu.contains(active) ? active : null;
    const firstItem = menu.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])');
    if (firstItem) {
      menu.querySelectorAll<HTMLElement>('[role^="menuitem"]').forEach((item) => { item.tabIndex = item === firstItem ? 0 : -1; });
      firstItem.focus();
    }
    return () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && (menu.contains(focused) || focused === document.body) && triggerRef.current?.isConnected) {
        triggerRef.current.focus();
      }
    };
  }, [alpha]);

  return <div ref={(node) => {
    menuRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }} role="menu" {...alphaMarker(alpha, "menu")} onFocus={(event) => {
    onFocus?.(event);
    if (!alpha || !(event.target instanceof HTMLElement) || !event.target.matches('[role^="menuitem"]')) return;
    event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]').forEach((item) => { item.tabIndex = item === event.target ? 0 : -1; });
  }} onKeyDown={(event) => { onKeyDown?.(event); if (!event.defaultPrevented) focusCollectionItem(event); }} {...props}>{children}</div>;
});

export const AlphaMenuRow = forwardRef<HTMLDivElement, AlphaMenuRowProps>(function AlphaMenuRow({ collectionLabel: _collectionLabel, auxiliary, rowClassName, children, className, disabled, id, onClick, ...itemProps }, ref) {
  return <div ref={ref} className={rowClassName}><AlphaMenuItem className={className} disabled={disabled} id={id} onClick={onClick} {...itemProps}>{children}</AlphaMenuItem>{auxiliary}</div>;
});

export const AlphaMenuItem = forwardRef<HTMLButtonElement, AlphaMenuItemProps>(function AlphaMenuItem({ children, tabIndex, ...props }, ref) {
  const alpha = useAlphaSurface();
  return <button ref={ref} type="button" role="menuitem" tabIndex={alpha ? -1 : tabIndex} {...alphaMarker(alpha, "menu-item")} {...props}>{children}</button>;
});

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

/*
FNXC:DashboardWindowVisibility 2026-09-14-10:52:
Alpha dialog backdrops are first-class managed surfaces. Global hiding retains their trees but disables Escape and backdrop dismissal; popovers and collection surfaces remain intentionally outside the snapshot registry.

FNXC:DialogStacking 2026-09-14-17:46:
FN-392: a child dialog (Refine, Reset, New Chat, duplicate warning) is body-portaled, so a static CSS z-index put it
UNDER the floating work window that opened it. Every shared dialog therefore claims the shared floating-utility layer
on open, publishes it as its `stackOrder`, and applies it inline so it always dominates the task/chat band. The parent
`FloatingWindow` raises itself from CAPTURE-phase pointer/focus handlers, which run before this bubble-phase handler in
the same React event, so re-claiming here is what keeps the dialog above its parent after a real interaction. A focus
claim is skipped while the window manager is restoring focus after a global hide, so hide/show never reorders anything.
*/
function useAlphaDialogLayer(logicalId: string) {
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

export function AlphaDialogBackdrop({ children, overlayClassName, labelledBy, onClose, overlayProps }: { children: ReactElement<HTMLAttributes<HTMLElement>>; overlayClassName?: string; labelledBy?: string; onClose?: () => void; overlayProps?: HTMLAttributes<HTMLDivElement> }) {
  const alpha = useAlphaSurface();
  const { windowSurface, layer, onPointerDown, onFocus } = useAlphaDialogLayer(labelledBy ?? "alpha-dialog");
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
      data-alpha-portal="true"
      {...(alpha ? { "data-alpha-ui": "dialog-backdrop" } : {})}
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
      {cloneElement(children, { role: "dialog", "aria-modal": true, "aria-labelledby": labelledBy ?? children.props["aria-labelledby"], ...(alpha ? { "data-alpha-ui": "dialog" } : {}) })}
    </div>
  );
  return portalDialog(dialog);
}

export function AlphaDialog({ children, className, overlayClassName, labelledBy, onClose }: { children: ReactNode; className?: string; overlayClassName?: string; labelledBy?: string; onClose?: () => void }) {
  const alpha = useAlphaSurface();
  const { windowSurface, layer, onPointerDown, onFocus } = useAlphaDialogLayer(labelledBy ?? "alpha-dialog");
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
      data-alpha-portal="true"
      {...(alpha ? { "data-alpha-ui": "dialog-backdrop" } : {})}
      onPointerDown={onPointerDown}
      onFocus={onFocus}
      onMouseDown={(event) => {
        if (windowSurface.surfaceActive && event.target === event.currentTarget) onClose?.();
      }}
    >
      <div className={className} role="dialog" aria-modal="true" aria-labelledby={labelledBy} {...alphaMarker(alpha, "dialog")}>{children}</div>
    </div>
  );
  return portalDialog(dialog);
}

export function AlphaSpinner({ className, label }: { className?: string; label: string }) {
  const alpha = useAlphaSurface();
  return <span className={className} role="status" aria-label={label} {...alphaMarker(alpha, "spinner")} />;
}
