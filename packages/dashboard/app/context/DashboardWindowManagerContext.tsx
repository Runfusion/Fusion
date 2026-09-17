import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefCallback,
} from "react";

/*
FNXC:DashboardWindowManager 2026-09-14-10:48:
Dashboard windows share one declarative owner for shell geometry and temporary desktop visibility. Landmarks register through explicit refs and surfaces through opaque mount tokens; runtime class scans would miss portaled/plugin surfaces and would collapse duplicate logical ids.

The global hide action is presentation-only. It snapshots mounted, locally visible tokens and makes those roots inert without invoking close callbacks, changing geometry, claiming a new stack layer, or unmounting children. A second action restores only captured tokens that still exist; a newly opened surface consumes the old snapshot first so it can never debut invisibly.
*/

export interface DashboardWindowBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/*
FNXC:DashboardWindowBounds 2026-09-14-21:10:
FN-394 adds the left navigation as a measured landmark. A window's work area is the rectangle between
the header and the active footer, minus every side panel that actually occupies width. A collapsed,
unmounted, or zero-width panel reserves nothing, so closing a sidebar immediately widens snapped
windows and reopening it re-splits them symmetrically. The shell itself is never auto-closed.
*/
export type DashboardWindowLandmark = "header" | "footer" | "right-dock" | "left-nav";
export type DashboardWindowSurfaceGroup = "window" | "dialog" | "drawer" | "plugin" | "chat";
export type DashboardWindowSurfaceToken = symbol;

interface DashboardWindowSurfaceRecord {
  token: DashboardWindowSurfaceToken;
  logicalId: string;
  group: DashboardWindowSurfaceGroup;
  root: HTMLElement | null;
  locallyVisible: boolean;
  stackOrder: number;
}

export interface DashboardWindowSurfaceOptions {
  logicalId: string;
  group?: DashboardWindowSurfaceGroup;
  locallyVisible?: boolean;
  stackOrder?: number;
}

export interface DashboardWindowSurfaceBinding {
  /** Opaque per-instance identity. Shared window state (cascade cohort, visibility snapshot) is keyed by it. */
  token: DashboardWindowSurfaceToken;
  rootRef: RefCallback<HTMLElement>;
  globallyHidden: boolean;
  surfaceActive: boolean;
  surfaceAttributes: {
    "aria-hidden"?: boolean;
    "data-dashboard-window-surface": string;
    "data-dashboard-window-globally-hidden"?: "true";
    inert?: boolean;
  };
}

interface DashboardWindowManagerValue {
  availableBounds: DashboardWindowBounds;
  headerRef: RefCallback<HTMLElement>;
  footerRef: RefCallback<HTMLElement>;
  rightDockRef: RefCallback<HTMLElement>;
  leftNavRef: RefCallback<HTMLElement>;
  reserveCascadeSlot: (token: DashboardWindowSurfaceToken) => number;
  releaseCascadeSlot: (token: DashboardWindowSurfaceToken) => void;
  upsertSurface: (surface: DashboardWindowSurfaceRecord) => void;
  removeSurface: (token: DashboardWindowSurfaceToken) => void;
  isSurfaceHidden: (token: DashboardWindowSurfaceToken) => boolean;
  isGroupVisible: (group: DashboardWindowSurfaceGroup) => boolean;
  toggleVisibility: () => void;
  hiddenSnapshotActive: boolean;
  visibleSurfaceCount: number;
  toggleControlRef: RefCallback<HTMLButtonElement>;
  resetScope: (scopeKey: string | null | undefined) => void;
  bottomDockReservation: number;
  setBottomDockReservation: (token: DashboardWindowSurfaceToken, px: number | null) => void;
  /*
  FNXC:DashboardWindowVisibility 2026-09-14-17:46:
  FN-392: restoring a global hide re-runs each surface's own focus effects. Window and dialog surfaces consult this
  closure so a restoration focus never claims a new stack layer; a later real pointer or focus interaction still does.
  */
  isFocusRestoring: () => boolean;
}

const DashboardWindowManagerContext = createContext<DashboardWindowManagerValue | null>(null);
const DashboardWindowSurfaceActivityContext = createContext(true);
const EMPTY_HIDDEN_TOKENS: ReadonlySet<DashboardWindowSurfaceToken> = new Set();
const NOOP_ELEMENT_REF: RefCallback<HTMLElement> = () => {};
let cachedViewportBounds: DashboardWindowBounds | undefined;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function viewportBounds(): DashboardWindowBounds {
  const right = typeof window === "undefined" || !finite(window.innerWidth) ? 0 : Math.max(0, window.innerWidth);
  const bottom = typeof window === "undefined" || !finite(window.innerHeight) ? 0 : Math.max(0, window.innerHeight);
  if (cachedViewportBounds?.right === right && cachedViewportBounds.bottom === bottom) return cachedViewportBounds;
  cachedViewportBounds = { left: 0, top: 0, right, bottom, width: right, height: bottom };
  return cachedViewportBounds;
}

function validRect(node: HTMLElement | null): DOMRect | null {
  if (!node || !node.isConnected) return null;
  const rect = node.getBoundingClientRect();
  if (![rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(finite)) return null;
  if (rect.right < rect.left || rect.bottom < rect.top || rect.width < 0 || rect.height < 0) return null;
  return rect;
}

export function resolveDashboardWindowBounds(input: {
  viewportWidth: number;
  viewportHeight: number;
  headerRect?: Pick<DOMRect, "bottom"> | null;
  footerRect?: Pick<DOMRect, "top"> | null;
  rightDockRect?: Pick<DOMRect, "left"> | null;
  leftNavRect?: Pick<DOMRect, "right" | "width"> | null;
}): DashboardWindowBounds {
  const rightEdge = finite(input.viewportWidth) ? Math.max(0, input.viewportWidth) : 0;
  const bottomEdge = finite(input.viewportHeight) ? Math.max(0, input.viewportHeight) : 0;
  const top = input.headerRect && finite(input.headerRect.bottom)
    ? Math.min(bottomEdge, Math.max(0, input.headerRect.bottom))
    : 0;
  const bottom = input.footerRect && finite(input.footerRect.top)
    ? Math.min(bottomEdge, Math.max(top, input.footerRect.top))
    : bottomEdge;
  const right = input.rightDockRect && finite(input.rightDockRect.left)
    ? Math.min(rightEdge, Math.max(0, input.rightDockRect.left))
    : rightEdge;
  // A left panel only reserves width when it actually occupies some; a zero-width or invalid rect is ignored.
  const left = input.leftNavRect
    && finite(input.leftNavRect.right)
    && finite(input.leftNavRect.width)
    && input.leftNavRect.width > 0
    ? Math.min(right, Math.max(0, input.leftNavRect.right))
    : 0;
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function isFocusable(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  if (element.matches(":disabled, [inert], [inert] *")) return false;
  const tabIndex = element.getAttribute("tabindex");
  return tabIndex !== "-1";
}

function focusFirstAvailable(root: HTMLElement): boolean {
  const candidate = root.querySelector<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  );
  if (candidate && isFocusable(candidate)) {
    candidate.focus();
    return true;
  }
  if (isFocusable(root)) {
    root.focus();
    return true;
  }
  return false;
}

/*
FNXC:FloatingWindowSnap 2026-09-17-04:51:
FN-487 : l'opérateur exige qu'une fenêtre ancrée en bas se comporte comme le terminal épinglé, c'est-à-dire qu'elle
REORGANISE l'application au lieu de la recouvrir. Les fenêtres ancrées publient donc ici la hauteur de leur bande et
le shell la réserve. L'agrégation est un MAXIMUM, jamais une somme : deux fenêtres ancrées occupent la MÊME bande
pleine largeur, donc additionner réserverait le double de l'espace réellement pris.

Cette réservation est DÉLIBÉRÉMENT exclue de `resolveDashboardWindowBounds` / `measure()`. L'inclure créerait une
boucle de rétroaction : la bande réduirait la zone de travail, la zone de travail réduite remonterait le bord haut de
la bande, qui republierait une réservation plus grande, et ainsi de suite.
*/
export function resolveBottomDockReservation(values: Iterable<number>): number {
  let max = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value > max) max = value;
  }
  return max;
}

function scheduleAfterPaint(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const frame = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(frame);
  }
  const timer = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(timer);
}

export interface DashboardWindowManagerProviderProps {
  children: ReactNode;
}

export function DashboardWindowManagerProvider({ children }: DashboardWindowManagerProviderProps) {
  const landmarksRef = useRef<Record<DashboardWindowLandmark, HTMLElement | null>>({
    header: null,
    footer: null,
    "right-dock": null,
    "left-nav": null,
  });
  /*
  FNXC:FloatingWindowCascade 2026-09-14-21:10:
  FN-394 replaces the chat-only cascade with ONE cohort shared by every window type. Membership is keyed
  by the opaque per-instance surface token — never by logical id or storage key — so two windows with the
  same logical id, or a StrictMode remount, each resolve their own slot without leaking a phantom
  reservation. A window leaves the cohort as soon as the operator really moves, resizes, or snaps it.
  */
  const cascadeSlotsRef = useRef(new Map<DashboardWindowSurfaceToken, number>());
  const surfacesRef = useRef(new Map<DashboardWindowSurfaceToken, DashboardWindowSurfaceRecord>());
  const hiddenSnapshotRef = useRef<Set<DashboardWindowSurfaceToken> | null>(null);
  const focusedBeforeHideRef = useRef<HTMLElement | null>(null);
  const toggleControlElementRef = useRef<HTMLButtonElement | null>(null);
  const scopeKeyRef = useRef<string | null | undefined>(undefined);
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const measurePendingRef = useRef(false);
  const focusCleanupRef = useRef<(() => void) | null>(null);
  const focusRestoringRef = useRef(false);
  const [availableBounds, setAvailableBounds] = useState<DashboardWindowBounds>(viewportBounds);
  const [surfaceRevision, setSurfaceRevision] = useState(0);
  const [hiddenTokens, setHiddenTokens] = useState<ReadonlySet<DashboardWindowSurfaceToken>>(EMPTY_HIDDEN_TOKENS);
  const bottomDockReservationsRef = useRef(new Map<DashboardWindowSurfaceToken, number>());
  const [bottomDockReservation, setBottomDockReservationState] = useState(0);

  /** `null` releases the token's band. The aggregate is republished only when its value really changes. */
  const setBottomDockReservation = useCallback((token: DashboardWindowSurfaceToken, px: number | null) => {
    const registry = bottomDockReservationsRef.current;
    if (px === null || !Number.isFinite(px) || px <= 0) {
      if (!registry.delete(token)) return;
    } else {
      if (registry.get(token) === px) return;
      registry.set(token, px);
    }
    const next = resolveBottomDockReservation(registry.values());
    setBottomDockReservationState((current) => (current === next ? current : next));
  }, []);

  const measure = useCallback(() => {
    measureFrameRef.current = null;
    measurePendingRef.current = false;
    const viewport = viewportBounds();
    const headerRect = validRect(landmarksRef.current.header);
    const footerRect = validRect(landmarksRef.current.footer);
    const rightDockRect = validRect(landmarksRef.current["right-dock"]);
    const leftNavRect = validRect(landmarksRef.current["left-nav"]);
    const next = resolveDashboardWindowBounds({
      viewportWidth: viewport.right,
      viewportHeight: viewport.bottom,
      headerRect,
      footerRect,
      rightDockRect,
      leftNavRect,
    });
    setAvailableBounds((current) => (
      current.left === next.left
      && current.top === next.top
      && current.right === next.right
      && current.bottom === next.bottom
      && current.width === next.width
      && current.height === next.height
        ? current
        : next
    ));
  }, []);

  /*
  FNXC:DashboardWindowBounds 2026-09-14-21:10:
  Coalescing tracks a PENDING flag rather than the frame handle alone: an environment whose
  `requestAnimationFrame` runs its callback synchronously would otherwise store a handle for a frame that
  already ran, leaving the coalescer permanently "busy" and freezing every later landmark measurement.
  */
  const scheduleMeasure = useCallback(() => {
    if (measurePendingRef.current) return;
    if (typeof requestAnimationFrame !== "function") {
      measure();
      return;
    }
    measurePendingRef.current = true;
    const frame = requestAnimationFrame(() => {
      measurePendingRef.current = false;
      measureFrameRef.current = null;
      measure();
    });
    if (measurePendingRef.current) measureFrameRef.current = frame;
  }, [measure]);

  useLayoutEffect(() => {
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleMeasure) : null;
    observerRef.current = observer;
    for (const node of Object.values(landmarksRef.current)) {
      if (node) observer?.observe(node);
    }
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      observer?.disconnect();
      observerRef.current = null;
      if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
      measureFrameRef.current = null;
      measurePendingRef.current = false;
    };
  }, [measure, scheduleMeasure]);

  useEffect(() => () => {
    focusCleanupRef.current?.();
    focusRestoringRef.current = false;
  }, []);

  const isFocusRestoring = useCallback(() => focusRestoringRef.current, []);

  useEffect(() => {
    if (hiddenTokens.size === 0) return;
    const containHiddenSurfaceEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("keydown", containHiddenSurfaceEscape, true);
    return () => document.removeEventListener("keydown", containHiddenSurfaceEscape, true);
  }, [hiddenTokens]);

  const setLandmark = useCallback((kind: DashboardWindowLandmark, node: HTMLElement | null) => {
    const previous = landmarksRef.current[kind];
    if (previous === node) return;
    if (previous) observerRef.current?.unobserve(previous);
    landmarksRef.current[kind] = node;
    if (node) observerRef.current?.observe(node);
    scheduleMeasure();
  }, [scheduleMeasure]);

  const headerRef = useCallback<RefCallback<HTMLElement>>((node) => setLandmark("header", node), [setLandmark]);
  const footerRef = useCallback<RefCallback<HTMLElement>>((node) => setLandmark("footer", node), [setLandmark]);
  const rightDockRef = useCallback<RefCallback<HTMLElement>>((node) => setLandmark("right-dock", node), [setLandmark]);
  const leftNavRef = useCallback<RefCallback<HTMLElement>>((node) => setLandmark("left-nav", node), [setLandmark]);

  /** Idempotent per token: the first free slot is reserved once and returned unchanged on every later call. */
  const reserveCascadeSlot = useCallback((token: DashboardWindowSurfaceToken) => {
    const existing = cascadeSlotsRef.current.get(token);
    if (existing !== undefined) return existing;
    const taken = new Set(cascadeSlotsRef.current.values());
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    cascadeSlotsRef.current.set(token, slot);
    return slot;
  }, []);

  const releaseCascadeSlot = useCallback((token: DashboardWindowSurfaceToken) => {
    cascadeSlotsRef.current.delete(token);
  }, []);
  const toggleControlRef = useCallback<RefCallback<HTMLButtonElement>>((node) => {
    toggleControlElementRef.current = node;
  }, []);

  const restoreFocus = useCallback((capturedTokens: ReadonlySet<DashboardWindowSurfaceToken>) => {
    focusCleanupRef.current?.();
    /*
    FNXC:DashboardWindowVisibility 2026-09-14-17:46:
    FN-392: the restoration fence opens synchronously, before the revealing render commits, and closes only after the
    focus attempt settles — success or failure. Every focus handler that would otherwise claim a stack layer runs
    inside this window, so restore is purely presentational and preserves the exact pre-hide order.
    */
    focusRestoringRef.current = true;
    focusCleanupRef.current = scheduleAfterPaint(() => {
      focusCleanupRef.current = null;
      try {
        const prior = focusedBeforeHideRef.current;
        focusedBeforeHideRef.current = null;
        if (prior && isFocusable(prior)) {
          const belongsToRestoredSurface = [...capturedTokens].some((token) => {
            const surface = surfacesRef.current.get(token);
            return Boolean(surface?.root?.contains(prior) && surface.locallyVisible);
          });
          if (belongsToRestoredSurface) {
            prior.focus();
            return;
          }
        }
        const topmost = [...capturedTokens]
          .map((token) => surfacesRef.current.get(token))
          .filter((surface): surface is DashboardWindowSurfaceRecord => Boolean(surface?.root && surface.locallyVisible))
          .sort((a, b) => b.stackOrder - a.stackOrder)[0];
        if (topmost?.root && focusFirstAvailable(topmost.root)) return;
        toggleControlElementRef.current?.focus();
      } finally {
        focusRestoringRef.current = false;
      }
    });
  }, []);

  const consumeSnapshot = useCallback(() => {
    const snapshot = hiddenSnapshotRef.current;
    if (!snapshot) return;
    hiddenSnapshotRef.current = null;
    setHiddenTokens(EMPTY_HIDDEN_TOKENS);
    restoreFocus(snapshot);
  }, [restoreFocus]);

  const upsertSurface = useCallback((surface: DashboardWindowSurfaceRecord) => {
    const previous = surfacesRef.current.get(surface.token);
    const changed = !previous
      || previous.logicalId !== surface.logicalId
      || previous.group !== surface.group
      || previous.root !== surface.root
      || previous.locallyVisible !== surface.locallyVisible
      || previous.stackOrder !== surface.stackOrder;
    if (!changed) return;
    surfacesRef.current.set(surface.token, surface);
    setSurfaceRevision((revision) => revision + 1);

    const snapshot = hiddenSnapshotRef.current;
    if (snapshot && surface.root && surface.locallyVisible && !snapshot.has(surface.token)) {
      consumeSnapshot();
    }
  }, [consumeSnapshot]);

  const removeSurface = useCallback((token: DashboardWindowSurfaceToken) => {
    cascadeSlotsRef.current.delete(token);
    // An unmounted window must never leave a phantom band reserved in the shell.
    setBottomDockReservation(token, null);
    if (!surfacesRef.current.delete(token)) return;
    const snapshot = hiddenSnapshotRef.current;
    if (snapshot?.delete(token)) {
      if (snapshot.size === 0) {
        hiddenSnapshotRef.current = null;
        setHiddenTokens(EMPTY_HIDDEN_TOKENS);
        focusedBeforeHideRef.current = null;
      } else {
        setHiddenTokens(new Set(snapshot));
      }
    }
    setSurfaceRevision((revision) => revision + 1);
  }, [setBottomDockReservation]);

  const toggleVisibility = useCallback(() => {
    if (hiddenSnapshotRef.current) {
      consumeSnapshot();
      return;
    }
    const visibleTokens = [...surfacesRef.current.values()]
      .filter((surface) => surface.root && surface.locallyVisible)
      .map((surface) => surface.token);
    if (visibleTokens.length === 0) return;
    focusedBeforeHideRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const snapshot = new Set(visibleTokens);
    hiddenSnapshotRef.current = snapshot;
    setHiddenTokens(snapshot);
    focusCleanupRef.current?.();
    focusCleanupRef.current = scheduleAfterPaint(() => {
      focusCleanupRef.current = null;
      toggleControlElementRef.current?.focus();
    });
  }, [consumeSnapshot]);

  const resetScope = useCallback((scopeKey: string | null | undefined) => {
    if (scopeKeyRef.current === scopeKey) return;
    scopeKeyRef.current = scopeKey;
    cascadeSlotsRef.current.clear();
    // A project change closes the previous scope's windows: their band must not survive the switch.
    bottomDockReservationsRef.current.clear();
    setBottomDockReservationState(0);
    hiddenSnapshotRef.current = null;
    focusedBeforeHideRef.current = null;
    focusCleanupRef.current?.();
    focusCleanupRef.current = null;
    focusRestoringRef.current = false;
    setHiddenTokens(EMPTY_HIDDEN_TOKENS);
  }, []);

  const isSurfaceHidden = useCallback((token: DashboardWindowSurfaceToken) => hiddenTokens.has(token), [hiddenTokens]);
  const isGroupVisible = useCallback((group: DashboardWindowSurfaceGroup) => {
    void surfaceRevision;
    return [...surfacesRef.current.values()].some((surface) => (
      surface.group === group
      && Boolean(surface.root)
      && surface.locallyVisible
      && !hiddenTokens.has(surface.token)
    ));
  }, [hiddenTokens, surfaceRevision]);
  const hiddenSnapshotActive = hiddenTokens.size > 0;
  const visibleSurfaceCount = useMemo(() => {
    void surfaceRevision;
    let count = 0;
    for (const surface of surfacesRef.current.values()) {
      if (surface.root && surface.locallyVisible && !hiddenTokens.has(surface.token)) count += 1;
    }
    return count;
  }, [hiddenTokens, surfaceRevision]);

  const value = useMemo<DashboardWindowManagerValue>(() => ({
    availableBounds,
    headerRef,
    footerRef,
    rightDockRef,
    leftNavRef,
    reserveCascadeSlot,
    releaseCascadeSlot,
    upsertSurface,
    removeSurface,
    isSurfaceHidden,
    isGroupVisible,
    toggleVisibility,
    hiddenSnapshotActive,
    visibleSurfaceCount,
    toggleControlRef,
    resetScope,
    isFocusRestoring,
    bottomDockReservation,
    setBottomDockReservation,
  }), [
    availableBounds,
    bottomDockReservation,
    setBottomDockReservation,
    footerRef,
    headerRef,
    hiddenSnapshotActive,
    isFocusRestoring,
    isGroupVisible,
    isSurfaceHidden,
    leftNavRef,
    reserveCascadeSlot,
    releaseCascadeSlot,
    removeSurface,
    resetScope,
    rightDockRef,
    toggleControlRef,
    toggleVisibility,
    upsertSurface,
    visibleSurfaceCount,
  ]);

  return <DashboardWindowManagerContext.Provider value={value}>{children}</DashboardWindowManagerContext.Provider>;
}

export function useDashboardWindowManager(): DashboardWindowManagerValue | null {
  return useContext(DashboardWindowManagerContext);
}

/*
FNXC:FloatingWindowSnap 2026-09-17-04:51:
FN-487 : côté shell, la hauteur agrégée à réserver sous le contenu applicatif. Hors provider (tests, hôtes
autonomes) aucune fenêtre ne peut réserver quoi que ce soit, donc la valeur est `0`.
*/
export function useDashboardWindowBottomDockReservation(): number {
  return useContext(DashboardWindowManagerContext)?.bottomDockReservation ?? 0;
}

const NOOP_BOTTOM_DOCK_RESERVATION = () => {};

/** Producer side: a docked window publishes its band height, or `null` to release it. */
export function useDashboardWindowBottomDockReservationControl(): (token: DashboardWindowSurfaceToken, px: number | null) => void {
  return useContext(DashboardWindowManagerContext)?.setBottomDockReservation ?? NOOP_BOTTOM_DOCK_RESERVATION;
}

export function useDashboardWindowBounds(): DashboardWindowBounds {
  return useContext(DashboardWindowManagerContext)?.availableBounds ?? viewportBounds();
}

/*
FNXC:DashboardWindowVisibility 2026-09-14-11:35:
Managed descendants receive presentation activity through React context, not DOM discovery. Expensive readers, focus ownership, and unread acknowledgements can therefore stop while their retained window or drawer is globally hidden.
*/
export function DashboardWindowSurfaceActivityProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const parentActive = useContext(DashboardWindowSurfaceActivityContext);
  return <DashboardWindowSurfaceActivityContext.Provider value={parentActive && active}>{children}</DashboardWindowSurfaceActivityContext.Provider>;
}

export function useDashboardWindowSurfaceActivity(): boolean {
  return useContext(DashboardWindowSurfaceActivityContext);
}

export function useDashboardWindowGroupVisible(group: DashboardWindowSurfaceGroup): boolean {
  return useContext(DashboardWindowManagerContext)?.isGroupVisible(group) ?? false;
}

export interface DashboardWindowVisibilityController {
  hiddenSnapshotActive: boolean;
  visibleSurfaceCount: number;
  toggleVisibility: () => void;
  toggleControlRef: RefCallback<HTMLButtonElement>;
}

export function useDashboardWindowVisibility(): DashboardWindowVisibilityController | null {
  const manager = useContext(DashboardWindowManagerContext);
  if (!manager) return null;
  return {
    hiddenSnapshotActive: manager.hiddenSnapshotActive,
    visibleSurfaceCount: manager.visibleSurfaceCount,
    toggleVisibility: manager.toggleVisibility,
    toggleControlRef: manager.toggleControlRef,
  };
}

export function DashboardWindowManagerScope({ scopeKey }: { scopeKey: string | null | undefined }) {
  const resetScope = useContext(DashboardWindowManagerContext)?.resetScope;
  useLayoutEffect(() => resetScope?.(scopeKey), [resetScope, scopeKey]);
  return null;
}

export function useDashboardWindowLandmark(kind: DashboardWindowLandmark): RefCallback<HTMLElement> {
  const manager = useContext(DashboardWindowManagerContext);
  if (!manager) return NOOP_ELEMENT_REF;
  if (kind === "header") return manager.headerRef;
  if (kind === "footer") return manager.footerRef;
  if (kind === "left-nav") return manager.leftNavRef;
  return manager.rightDockRef;
}

export interface DashboardWindowCascadeController {
  /** Reserve (idempotently) this instance's slot in the pristine-window cohort. */
  reserve: (token: DashboardWindowSurfaceToken) => number;
  /** Leave the cohort — called once the operator really moves, resizes, or snaps the window. */
  release: (token: DashboardWindowSurfaceToken) => void;
}

const STANDALONE_CASCADE: DashboardWindowCascadeController = { reserve: () => 0, release: () => {} };

/*
FNXC:FloatingWindowCascade 2026-09-14-21:10:
Outside a provider there is no cohort, so a standalone window (tests, embedded hosts) always opens
exactly centered rather than inheriting a foreign offset.
*/
export function useDashboardWindowCascade(): DashboardWindowCascadeController {
  const manager = useContext(DashboardWindowManagerContext);
  const reserve = manager?.reserveCascadeSlot;
  const release = manager?.releaseCascadeSlot;
  /*
  The controller identity must depend ONLY on the two stable callbacks, never on the manager value
  object: that object is rebuilt whenever bounds or the surface revision change, and a new identity here
  would re-run every window's mount effect, re-reserving slots and resetting geometry mid-session.
  */
  return useMemo(
    () => (reserve && release ? { reserve, release } : STANDALONE_CASCADE),
    [release, reserve],
  );
}

const NEVER_RESTORING = () => false;

/*
FNXC:DashboardWindowVisibility 2026-09-14-17:46:
FN-392: shared read access to the restoration fence. Outside a provider nothing is ever restoring, so standalone hosts
and tests keep their ordinary focus-to-front behavior.
*/
export function useDashboardWindowFocusRestoring(): () => boolean {
  return useContext(DashboardWindowManagerContext)?.isFocusRestoring ?? NEVER_RESTORING;
}

export function useDashboardWindowManagerScope(scopeKey: string | null | undefined): void {
  const resetScope = useContext(DashboardWindowManagerContext)?.resetScope;
  useLayoutEffect(() => {
    resetScope?.(scopeKey);
  }, [resetScope, scopeKey]);
}

export type DashboardWindowSurfaceRootProps = HTMLAttributes<HTMLDivElement> & DashboardWindowSurfaceOptions;

/*
FNXC:DashboardWindowVisibility 2026-09-14-10:52:
Direct modal roots use the same declarative token contract as shared window primitives without adding a layout wrapper. Local aria/inert state is composed with, never overwritten by, the temporary global snapshot.
*/
export const DashboardWindowSurfaceRoot = forwardRef<HTMLDivElement, DashboardWindowSurfaceRootProps>(function DashboardWindowSurfaceRoot({
  logicalId,
  group,
  locallyVisible,
  stackOrder,
  children,
  ...props
}, forwardedRef) {
  const surface = useDashboardWindowSurface({ logicalId, group, locallyVisible, stackOrder });
  const setRoot = useCallback((node: HTMLDivElement | null) => {
    surface.rootRef(node);
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef, surface.rootRef]);
  const locallyHidden = props["aria-hidden"] === true || props.inert === true;
  return (
    <div
      {...props}
      ref={setRoot}
      aria-hidden={locallyHidden || surface.globallyHidden || undefined}
      inert={locallyHidden || surface.globallyHidden || undefined}
      data-dashboard-window-surface={surface.surfaceAttributes["data-dashboard-window-surface"]}
      data-dashboard-window-globally-hidden={surface.surfaceAttributes["data-dashboard-window-globally-hidden"]}
    >
      <DashboardWindowSurfaceActivityProvider active={surface.surfaceActive}>
        {children}
      </DashboardWindowSurfaceActivityProvider>
    </div>
  );
});

export function useDashboardWindowSurface(options: DashboardWindowSurfaceOptions): DashboardWindowSurfaceBinding {
  const manager = useContext(DashboardWindowManagerContext);
  const upsertSurface = manager?.upsertSurface;
  const removeSurface = manager?.removeSurface;
  const tokenRef = useRef<DashboardWindowSurfaceToken>(Symbol(options.logicalId));
  const rootRefValue = useRef<HTMLElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const publish = useCallback((root = rootRefValue.current) => {
    if (!upsertSurface) return;
    const current = optionsRef.current;
    upsertSurface({
      token: tokenRef.current,
      logicalId: current.logicalId,
      group: current.group ?? "dialog",
      root,
      locallyVisible: current.locallyVisible ?? true,
      stackOrder: Number.isFinite(current.stackOrder) ? current.stackOrder ?? 0 : 0,
    });
  }, [upsertSurface]);

  const rootRef = useCallback<RefCallback<HTMLElement>>((node) => {
    rootRefValue.current = node;
    publish(node);
  }, [publish]);

  useLayoutEffect(() => {
    publish();
  });
  useLayoutEffect(() => () => removeSurface?.(tokenRef.current), [removeSurface]);

  const globallyHidden = manager?.isSurfaceHidden(tokenRef.current) ?? false;
  const locallyVisible = options.locallyVisible ?? true;
  return {
    token: tokenRef.current,
    rootRef,
    globallyHidden,
    surfaceActive: locallyVisible && !globallyHidden,
    surfaceAttributes: {
      "data-dashboard-window-surface": options.logicalId,
      "data-dashboard-window-globally-hidden": globallyHidden ? "true" : undefined,
      "aria-hidden": globallyHidden || undefined,
      inert: globallyHidden || undefined,
    },
  };
}
