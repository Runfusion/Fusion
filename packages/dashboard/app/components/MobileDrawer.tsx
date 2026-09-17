import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDrawerDismissGesture } from "../hooks/useDrawerDismissGesture";
import {
  KeyboardViewportOwnerProvider,
  useKeyboardViewportSurface,
} from "../hooks/useKeyboardViewportSurface";
import { DrawerPresentationProvider, ViewDrawerHandle } from "./ViewDrawer";
import { ViewLayoutContent, ViewLayoutHeader } from "./ViewLayout";
import "./MobileDrawer.css";
import {
  DashboardWindowSurfaceActivityProvider,
  useDashboardWindowSurface,
  type DashboardWindowSurfaceGroup,
} from "../context/DashboardWindowManagerContext";

export interface MobileDrawerProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
  testId?: string;
  /** Semantic group used by shared visibility/read-state consumers. */
  surfaceGroup?: DashboardWindowSurfaceGroup;
  /**
   * When true, the hosted view owns the visible heading row and the drawer only
   * contributes an accessible dialog name plus its close control.
   */
  contentOwnsHeader?: boolean;
  /**
   * When true, the hosted view provides its own bounded central scroller. Keep
   * false for ordinary or headerless content so the drawer body remains scrollable.
   */
  contentOwnsScroll?: boolean;
}

interface AppDrawerBridgeProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/*
FNXC:MobileDrawer 2026-09-10-23:59:
Projects and Planning expose their production drawer bridges so browser geometry checks execute the exact ownership flags and mount policy used by App. Keep these bridges as the sole definitions of App-owned drawer chrome; fixture-only shell copies can drift while remaining green.
*/
export function ProjectsDrawer({ open, title, onClose, children }: AppDrawerBridgeProps) {
  return (
    <MobileDrawer open={open} title={title} onClose={onClose} testId="mobile-drawer-projects" contentOwnsHeader contentOwnsScroll>
      {children}
    </MobileDrawer>
  );
}

export function PlanningDrawer({ open, title, onClose, children }: AppDrawerBridgeProps) {
  return (
    <MobileDrawer open={open} title={title} onClose={onClose} keepMounted testId="mobile-drawer-planning" contentOwnsHeader contentOwnsScroll>
      {children}
    </MobileDrawer>
  );
}

/*
FNXC:ToolSurfaces 2026-09-16-23:06:
FN-435 avait introduit ici un pont `NotesDrawer` (`mobile-drawer-notes`) pour héberger Notes sur téléphone. FN-437 le
supprime : le Header n'expose plus de déclencheur Notes sur téléphone, donc ce pont n'avait plus aucune entrée. Le
propriétaire mobile de Notes est l'entrée `mobile-more-item-notes` du menu du pied de page, qui route vers la vue Notes
plein écran hébergée par `MainContentDrawer` (`mobile-drawer-main-content`) avec la même navigation interne liste ↔
éditeur. Ne pas réintroduire un second hôte Notes mobile ici : la mutuelle exclusion des propriétaires est ce qui
empêche deux contrôleurs d'édition concurrents.
*/

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/*
FNXC:MobileDrawer 2026-09-10-16:56:
The mobile shell keeps Board as the permanent project surface and presents every other destination in one bounded modal drawer. The shared shell owns the visible Board reveal, bottom-edge overlay above the trigger pill, internal system-safe clearance, independent scrolling, Escape/backdrop close, focus containment, and trigger-focus restoration so individual destinations do not invent competing mobile sheets.

FNXC:MobileDrawer 2026-09-11-01:40:
A hosted view with its own header remains the sole visible title/action row. The shell retains a screen-reader dialog name while its real top handle exclusively owns drag-to-dismiss; headerless plugin or fallback content still receives the visible shell title without a close-button reserve.

FNXC:MobileDrawer 2026-09-10-22:45:
Visible-header ownership and overflow ownership are independent contracts. Only views with a bounded internal flex scroller may suppress body scrolling; ordinary views such as Ideation keep the drawer body as their reachable vertical scroller even when they render their own heading.
*/
export function MobileDrawer({
  open,
  title,
  onClose,
  children,
  className,
  keepMounted = false,
  testId = "mobile-drawer",
  surfaceGroup,
  contentOwnsHeader = false,
  contentOwnsScroll = false,
}: MobileDrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  FN-512: the drawer panel is sized from `--mobile-drawer-block-size`, which is derived from
  `100dvh`. On WebKit `100dvh` does NOT shrink when the soft keyboard opens, so the panel kept
  reaching below the visible bottom edge and the composer it hosts ended up UNDER the keyboard — the
  first symptom reported. The panel now measures its own rectangle against the visible bound and
  publishes a usable block size.

  It also becomes the declared OWNER for its subtree: hosted content (Chat, forms, terminals) sees
  `ownedByAncestor` and must not clamp, translate, or reserve a second keyboard band. That is what
  removes the competing adjustments that made the outcome depend on event order.

  The provider is published only while the drawer is actually visible and active, so a retained but
  globally hidden drawer never claims ownership of a subtree the user is not looking at.
  */
  const windowSurface = useDashboardWindowSurface({
    logicalId: testId,
    group: surfaceGroup ?? "drawer",
    locallyVisible: open,
  });
  const surfaceActiveRef = useRef(windowSurface.surfaceActive);
  surfaceActiveRef.current = windowSurface.surfaceActive;
  /*
  FNXC:DashboardWindowSurfaceRefIdentity 2026-09-17-19:34:
  FN-515: this composed root ref MUST keep a stable identity across renders. `windowSurface.rootRef`
  publishes into the window manager, and the manager treats a `root` change as a real change, so an
  inline callback made React detach (publish null) then re-attach (publish the node) on every render.
  Each pair bumped `surfaceRevision` twice, the provider re-rendered this consumer, and the next
  render produced yet another callback — the runaway loop that surfaced as React #185 on modal open.

  Depend ONLY on `windowSurface.rootRef` (already stable), never on the whole `windowSurface` binding,
  which is a fresh object each render. `null` is still forwarded on a genuine detach so the registry
  can release the surface.
  */
  const setOverlayRef = useCallback((node: HTMLDivElement | null) => {
    overlayRef.current = node;
    windowSurface.rootRef(node);
  }, [windowSurface.rootRef]);
  const keyboardSurface = useKeyboardViewportSurface(overlayRef, {
    enabled: open && windowSurface.surfaceActive && !windowSurface.globallyHidden,
    // A drawer is portalled to document.body and is its own containing block.
    standalone: true,
    /*
    FNXC:MobileKeyboardViewport 2026-09-17-14:23:
    The overlay is `position: fixed; inset: 0` and its panel is bottom-aligned inside it, so this is a
    LAYOUT-BOTTOM surface: shortening it moves its own top edge and any height derived from that top
    feeds back into itself. Adapt the overlay's bottom inset from the frame instead — no measurement,
    no feedback — and let the panel fill the reduced overlay through ordinary percentage sizing.
    */
    anchor: "layout-bottom",
    bottomInsetProperty: "--mobile-drawer-keyboard-inset",
  });
  const keyboardOwned = keyboardSurface.bottomInset > 0;
  const keyboardOwnership = useMemo(() => ({ owned: keyboardOwned }), [keyboardOwned]);
  const dismissHandleProps = useDrawerDismissGesture({
    enabled: open && windowSurface.surfaceActive,
    open,
    panelRef,
    onDismiss: onClose,
  });

  /*
  FNXC:DashboardWindowVisibility 2026-09-14-10:52:
  Opening a drawer still claims initial focus, but a manager hide/restore cycle must not replay autofocus over the manager's captured target. Interaction listeners are independently removed while the retained drawer is globally hidden.
  */
  useEffect(() => {
    if (!open || !surfaceActiveRef.current) return;
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (priorFocus?.isConnected) priorFocus.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !windowSurface.surfaceActive) return;
    const panel = panelRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && currentIndex <= 0) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, windowSurface.surfaceActive]);

  if (!open && !keepMounted) return null;

  return createPortal(
    <div
      ref={setOverlayRef}
      className={`mobile-drawer${open ? " mobile-drawer--open" : " mobile-drawer--hidden"}${keyboardOwned ? " mobile-drawer--keyboard-bounded" : ""}${className ? ` ${className}` : ""}`}
      style={keyboardSurface.style}
      data-keyboard-bounded={keyboardOwned || undefined}
      data-testid={testId}
      aria-hidden={!open || windowSurface.globallyHidden || undefined}
      inert={!open || windowSurface.globallyHidden || undefined}
      data-dashboard-window-surface={windowSurface.surfaceAttributes["data-dashboard-window-surface"]}
      data-dashboard-window-globally-hidden={windowSurface.surfaceAttributes["data-dashboard-window-globally-hidden"]}
      onMouseDown={(event) => {
        if (windowSurface.surfaceActive && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className={`mobile-drawer__panel${contentOwnsHeader ? " mobile-drawer__panel--content-header" : ""}${contentOwnsScroll ? " mobile-drawer__panel--content-scroll" : ""}${keyboardOwned ? " mobile-drawer__panel--keyboard-bounded" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        tabIndex={-1}
        {...dismissHandleProps}
      >
        <ViewDrawerHandle className="mobile-drawer__handle-target" barClassName="mobile-drawer__handle" />
        {contentOwnsHeader ? (
          <h2 id={`${testId}-title`} className="mobile-drawer__accessible-title visually-hidden">{title}</h2>
        ) : (
          <ViewLayoutHeader as="header" className="mobile-drawer__header">
            <h2 id={`${testId}-title`} className="mobile-drawer__title">{title}</h2>
          </ViewLayoutHeader>
        )}
        {/*
        FNXC:StandardizedDrawers 2026-09-15-04:56:
        FN-406: MobileDrawer is a drawer BY CONSTRUCTION, so it publishes the presentation unconditionally rather than
        re-deriving the viewport predicate. Hosted content therefore suppresses its own canonical close here too.
        */}
        <ViewLayoutContent className="mobile-drawer__body">
          <DashboardWindowSurfaceActivityProvider active={windowSurface.surfaceActive}>
            <KeyboardViewportOwnerProvider value={keyboardOwnership}>
              <DrawerPresentationProvider value>{children}</DrawerPresentationProvider>
            </KeyboardViewportOwnerProvider>
          </DashboardWindowSurfaceActivityProvider>
        </ViewLayoutContent>
      </section>
    </div>,
    document.body,
  );
}
