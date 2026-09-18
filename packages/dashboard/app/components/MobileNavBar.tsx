import "./MobileNavBar.css";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity,
  Bot,
  Brain,
  ChevronRight,
  Clock,
  FileCode,
  Folder,
  Gauge,
  GitBranch,
  Grid3X3,
  History,
  List,
  Lightbulb,
  Loader2,
  Lock,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Menu,
  PanelsTopLeft,
  Play,
  Settings,
  Monitor,
  Search,
  Sparkles,
  StickyNote,
  Target,
  Terminal,
  Workflow,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchScripts } from "../api";
import { normalizeScriptCatalog } from "../api/system/workflows";
import type { PluginDashboardViewEntry, ScriptEntry } from "../api";
import { useViewportMode } from "./Header";
import { isMobileShellMode } from "../hooks/useViewportMode";
import { NavigationHistoryContext } from "../hooks/useNavigationHistory";
import type { TaskView } from "../hooks/useViewState";
import { buildPluginTaskViewId, isPluginViewId } from "../plugins/pluginViewRegistry";
import { getPluginDashboardViewNavIcon } from "./pluginNavIcon";
import { ViewDrawerHandle } from "./ViewDrawer";
import { useFooterSwipeUpGesture } from "../hooks/useFooterSwipeUpGesture";
import { useDrawerDismissGesture } from "../hooks/useDrawerDismissGesture";
import { listRowGestureAttributes } from "../utils/listItemGesture";
import { MOBILE_NAV_SELECTABLE_ITEMS, resolveMobileNavPrimaryItems, type MobileNavSelectableItem } from "../../../core/src/board/mobile-nav-primary-items";

export interface PublishedMobileNavHeightInput {
  navOffsetHeight: number;
  paddingBottom: number;
  tabHeights: number[];
  floatingGap?: number;
}

/**
 * FNXC:NativeShell 2026-09-10-03:16:
 * Publish the rendered navigation pill border box plus its floating gap exactly once. The shared project scroller consumes this measurement with the separate system offset so final controls remain scrollable above the visual overlay without duplicating safe-area terms.
 */
export function computePublishedMobileNavHeight({
  navOffsetHeight,
  paddingBottom,
  tabHeights,
  floatingGap = 0,
}: PublishedMobileNavHeightInput): number {
  const measuredTabHeight = Math.max(0, ...tabHeights.filter((height) => Number.isFinite(height)));
  const resolvedNavOffsetHeight = Number.isFinite(navOffsetHeight) ? Math.max(0, navOffsetHeight) : 0;
  const resolvedFloatingGap = Number.isFinite(floatingGap) ? Math.max(0, floatingGap) : 0;
  if (resolvedFloatingGap > 0) {
    const floatingSurfaceHeight = resolvedNavOffsetHeight > 0 ? resolvedNavOffsetHeight : measuredTabHeight;
    return Math.max(44, Math.ceil(floatingSurfaceHeight + resolvedFloatingGap));
  }

  if (measuredTabHeight > 0) {
    return Math.max(44, Math.ceil(measuredTabHeight));
  }

  const resolvedPaddingBottom = Number.isFinite(paddingBottom) ? paddingBottom : 0;
  const contentHeight = resolvedNavOffsetHeight - resolvedPaddingBottom;
  return Math.max(44, Math.ceil(contentHeight));
}

/*
FNXC:Navigation 2026-09-17-16:53:
FN-511 retire la promotion dynamique de destinations non configurées (`MOBILE_NAV_DYNAMIC_PROMOTION_ORDER`,
`MAX_MOBILE_NAV_DIRECT_DESTINATIONS`, `computeMobileNavDirectDestinationCount`, la largeur de créneau mesurée). Elle
était exactement ce qui empêchait « le paramétrage entre PC et mobile de rester strictement le même » : pour une
même valeur de `mobileNavPrimaryItems`, une largeur différente rendait une rangée différente. La rangée de la pill
est désormais STRICTEMENT la sélection résolue (cinq créneaux, `chat` compris comme destination ordinaire) filtrée
par l'éligibilité, suivie du déclencheur de menu. Seule la mesure de HAUTEUR de la pill subsiste dans l'effet de
mesure ci-dessous.
*/

export interface MobileNavKeyboardMetrics {
  keyboardOverlap: number;
  viewportHeight: number | null;
  viewportOffsetTop: number;
}

/*
FNXC:MobilePillPopover 2026-09-13-10:03:
The official pill and popover are sibling fixed surfaces, so both receive the complete geometry declaration directly. A root-computed custom-property chain cannot consume a value overridden only on one sibling; publishing the same local chain keeps their shared edge consistent.

FNXC:MobilePillPopover 2026-09-13-10:32:
A shifted iOS visual viewport moves its visible top. Publish that live top offset on both fixed siblings so the popover's CSS height cap cannot place its first controls above the visible viewport.

FNXC:MobilePillKeyboard 2026-09-16-16:27:
FN-463: the official pill stays anchored to the bottom of the screen INDEPENDENTLY of the software keyboard. It no longer lifts above the keyboard, so `--mobile-nav-pill-bottom` (and the popover bottom derived from it) contains no term derived from the visual viewport: opening, moving, and closing the keyboard leave the resolved bottom position numerically unchanged. `--mobile-nav-viewport-offset-top` survives for the popover height cap ONLY; it never participates in the bottom anchor.
*/
export interface MobileNavGeometryStyle extends CSSProperties {
  "--mobile-nav-floating-gap": string;
  "--mobile-nav-viewport-offset-top": string;
  "--mobile-nav-pill-bottom": string;
  "--mobile-nav-popover-bottom": string;
}

export function createMobileNavGeometryStyle(viewportOffsetTop = 0): MobileNavGeometryStyle {
  const visibleViewportTop = Number.isFinite(viewportOffsetTop) ? Math.max(0, viewportOffsetTop) : 0;
  return {
    "--mobile-nav-floating-gap": "var(--space-sm)",
    "--mobile-nav-viewport-offset-top": `${visibleViewportTop}px`,
    "--mobile-nav-pill-bottom": "calc(var(--mobile-nav-system-offset) + var(--mobile-nav-floating-gap))",
    "--mobile-nav-popover-bottom": "calc(var(--mobile-nav-pill-bottom) + var(--mobile-nav-pill-height) + var(--space-xs))",
  };
}

export interface MobileNavBarProps {
  /** Current task view mode */
  view: TaskView;
  /** Change task view handler */
  onChangeView: (view: TaskView) => void;
  /** Whether the ExecutorStatusBar footer is visible */
  footerVisible: boolean;
  /** Whether any full-screen modal is currently open (hides the tab bar) */
  modalOpen?: boolean;
  /*
  FNXC:Navigation 2026-07-25-22:57:
  The project overview has no task tabs to drive, so callers hide the mobile bar rather than rendering a non-functional navigation shell.
  */
  hidden?: boolean;
  /** Whether the on-screen mobile keyboard is open */
  keyboardOpen?: boolean;
  /** Existing visual-viewport metrics used to lift the official pill without a second observer. */
  keyboardMetrics?: MobileNavKeyboardMetrics;
  // Navigation handlers
  onOpenSettings?: () => void;
  onOpenActivityLog?: () => void;
  onOpenMailbox?: () => void;
  mailboxUnreadCount?: number;
  mailboxPendingApprovalCount?: number;
  chatHasUnreadResponse?: boolean;
  stashOrphanCount?: number;
  onOpenGitManager?: () => void;
  onOpenWorkflowEditor?: () => void;
  onOpenSchedules?: () => void;
  onOpenScripts?: () => void;
  onToggleTerminal?: () => void;
  onOpenFiles?: () => void;
  onOpenGitHubImport?: () => void;
  onOpenPlanning?: () => void;
  onResumePlanning?: () => void;
  activePlanningSessionCount?: number;
  /*
  FNXC:Navigation 2026-07-05-00:00:
  Planning Mode "awaiting input" no longer shows a top-of-board banner (its Resume button did not reliably
  redirect). Instead this flag drives a yellow `status-dot--pending` dot on the Planning More-sheet item and the
  More tab icon, mirroring `chatHasUnreadResponse`'s `mobile-nav-chat-unread-dot`, so the click target is always
  the working Planning navigation.
  */
  planningNeedsInput?: boolean;
  onOpenUsage?: () => void;
  onRunScript?: (name: string, command: string) => void;
  projectId?: string;
  onViewAllProjects?: () => void;
  /** Whether to show the skills tab */
  showSkillsTab?: boolean;
  /** Experimental feature flags controlling visibility of nav items. */
  experimentalFeatures?: {
    insights?: boolean;
    memoryView?: boolean;
    devServer?: boolean;
    devServerView?: boolean;
    researchView?: boolean;
    evalsView?: boolean;
    ideationView?: boolean;
    whiteboardView?: boolean;
    goalsView?: boolean;
  };
  pluginDashboardViews?: PluginDashboardViewEntry[];
  shellConnectionControl?: ReactNode;
  /*
  FNXC:Navigation 2026-09-16-17:41:
  FN-467: the pill's direct destinations are the project's persisted **Navigation quick access** selection
  (`mobileNavPrimaryItems`), exactly like the shared tablet/desktop footer row — one setting, both hosts, same order.
  The value is passed raw: `resolveMobileNavPrimaryItems` owns legacy normalization, deduplication, the cap of 5, and
  the fallback to the default selection, so no dashboard-side copy of that logic may exist. Omitting the prop keeps the
  default (Dashboard, Board, Planning, Missions, Mailbox).
  */
  quickAccessItems?: readonly string[];
  /*
  FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
  FN-481 : destinations que le Header de CET hôte rend déjà (résolues par `resolveHeaderNavigationOwnership`). Elles
  sont retirées AVANT la répartition — rangée directe, promotion dynamique et menu — donc un accès disponible en haut
  n'apparaît jamais une seconde fois en bas. L'omission de la prop vaut collection vide : une pill montée sans Header
  n'a pas le droit de supposer qu'un accès existe ailleurs et conserve toutes ses destinations.
  */
  headerOwnedItems?: readonly string[];
  /*
  FNXC:MobileNavGesture 2026-09-17-16:53:
  FN-511 : option projet `mobileNavMenuSwipeGesture`. Quand elle est vraie, le bouton hamburger n'est PAS rendu (aucune
  coquille, aucun `aria-controls`/`aria-expanded` résiduel) et le menu s'ouvre par un glissement vers le haut du pied de
  page, présenté comme un tiroir de la largeur de la barre. Quand elle est fausse, le hamburger est rendu et le geste
  est désarmé : il n'y a jamais deux affordances d'ouverture simultanées, et le geste n'ouvre plus jamais le Chat.
  */
  menuGestureEnabled?: boolean;
  /** App-owned open state for the mobile navigation popover. */
  navigationMenuOpen?: boolean;
  /** Updates the App-owned mobile popover state. */
  onUiMenuOpenChange?: (open: boolean) => void;
}

function GitHubLogo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function formatCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function MobileNavBar({
  view,
  onChangeView,
  footerVisible,
  modalOpen = false,
  hidden = false,
  keyboardOpen = false,
  keyboardMetrics,
  onOpenSettings,
  onOpenActivityLog,
  mailboxUnreadCount = 0,
  mailboxPendingApprovalCount = 0,
  chatHasUnreadResponse = false,
  stashOrphanCount = 0,
  onOpenGitManager,
  onOpenWorkflowEditor,
  onOpenSchedules,
  onOpenScripts,
  onToggleTerminal,
  onOpenFiles,
  onOpenGitHubImport,
  onOpenPlanning,
  onResumePlanning,
  activePlanningSessionCount = 0,
  planningNeedsInput = false,
  onOpenUsage,
  onRunScript,
  projectId,
  onViewAllProjects,
  showSkillsTab,
  experimentalFeatures,
  pluginDashboardViews = [],
  shellConnectionControl,
  quickAccessItems,
  headerOwnedItems,
  menuGestureEnabled = false,
  navigationMenuOpen = false,
  onUiMenuOpenChange,
}: MobileNavBarProps) {
  const { t } = useTranslation("app");
  const mode = useViewportMode();
  const navigationHistory = useContext(NavigationHistoryContext);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isScriptsSubmenuOpen, setIsScriptsSubmenuOpen] = useState(false);
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [isSheetDragging, setIsSheetDragging] = useState(false);
  const [hasSheetDragged, setHasSheetDragged] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetDragRef = useRef<{
    startY: number;
    startedAt: number;
    eligible: boolean;
    startedOnHandle: boolean;
  } | null>(null);
  const dragOffsetRef = useRef(0);
  const menuSurfaceRef = useRef<HTMLDivElement | null>(null);
  /* FN-382/MobileNav: holds the geometry in place for the whole open-menu gesture (see the freeze note below). */
  const frozenGeometryRef = useRef<MobileNavGeometryStyle | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const officialDesignEnabled = true;
  const isMenuOpen = navigationMenuOpen;

  /*
  FNXC:NativeShell 2026-09-11-15:01:
  The navigation pill keeps its popover state controlled by App while the sole trigger is the trailing sibling of the pill's destination tablist (FN-467: up to five destinations resolved from the project quick-access setting, never a fixed four). Standard mobile keeps its local More drawer; shell identity changes close either transient surface without creating another state owner.
  */
  useEffect(() => {
    setIsMoreOpen(false);
    setIsScriptsSubmenuOpen(false);
    onUiMenuOpenChange?.(false);
  }, [mode, onUiMenuOpenChange, projectId]);

  /*
  FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
  FN-481 : quand la propriété du Header change alors que le menu est ouvert (rotation téléphone ↔ tablette, projets
  chargés tardivement), les entrées concernées sont retirées immédiatement du DOM. Si c'est précisément le contrôle
  focalisé qui disparaît, le focus retombe sur `document.body` et le clavier perd le menu : on le replace alors sur la
  surface encore ouverte, sinon sur son déclencheur. Cet effet ne s'exécute QUE sur un changement de propriétaire et
  seulement si le focus a été réellement perdu, donc un simple rafraîchissement ne vole jamais le focus.
  */
  const headerOwnedSignature = [...(headerOwnedItems ?? [])].sort().join(",");
  const previousHeaderOwnedSignatureRef = useRef(headerOwnedSignature);
  useEffect(() => {
    const previous = previousHeaderOwnedSignatureRef.current;
    previousHeaderOwnedSignatureRef.current = headerOwnedSignature;
    if (previous === headerOwnedSignature) return;
    if (!navigationMenuOpen) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const surface = menuSurfaceRef.current;
    if (surface) {
      const firstControl = surface.querySelector<HTMLElement>("button");
      (firstControl ?? surface).focus?.();
      return;
    }
    menuTriggerRef.current?.focus?.();
  }, [headerOwnedSignature, navigationMenuOpen]);

  const scriptEntries = useMemo(
    () => [...scripts].sort((a, b) => a.name.localeCompare(b.name)),
    [scripts],
  );

  // Fetch scripts when the submenu opens
  useEffect(() => {
    if (!isScriptsSubmenuOpen) return;

    let cancelled = false;
    setScriptsLoading(true);

    fetchScripts(projectId)
      .then((data) => {
        if (!cancelled) setScripts(normalizeScriptCatalog(data));
      })
      .catch(() => {
        if (!cancelled) setScripts([]);
      })
      .finally(() => {
        if (!cancelled) setScriptsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isScriptsSubmenuOpen, projectId]);

  const resetSheetDrag = useCallback(() => {
    sheetDragRef.current = null;
    dragOffsetRef.current = 0;
    setDragOffset(0);
    setIsSheetDragging(false);
  }, []);

  const closeMore = useCallback(() => {
    resetSheetDrag();
    setHasSheetDragged(false);
    onUiMenuOpenChange?.(false);
    menuTriggerRef.current?.focus();
  }, [onUiMenuOpenChange, resetSheetDrag]);

  /*
  FNXC:MobileNav 2026-07-16-14:30:
  The More sheet must dismiss before navigation on iOS swipe-back, Android native Back, and browser Back.
  Register its stable, idempotent closer as a modal entry, while reading nullable context so provider-less
  component renders retain their existing behavior.
  */
  useEffect(() => {
    if (!isMenuOpen || !navigationHistory) return;
    navigationHistory.pushNav({ type: "modal", close: closeMore });
  }, [closeMore, isMenuOpen, navigationHistory]);

  const dismissMore = useCallback((forNavigation?: boolean) => {
    navigationHistory?.removeNav(
      closeMore,
      forNavigation === true ? { preserveHistoryPosition: true } : undefined,
    );
    closeMore();
  }, [closeMore, navigationHistory]);

  /*
  FNXC:MobileNav 2026-07-16-12:00:
  The mobile More drawer must dismiss when a user drags down from its top or grab handle.
  Keep scrollTop===0 as the body-drag guard so a scrolled sheet retains normal interior
  scrolling; the non-passive native listener can cancel iOS Safari and Android Chrome
  overscroll only for that eligible downward dismissal gesture.
  */
  useEffect(() => {
    const sheet = sheetRef.current;
    if (officialDesignEnabled || !isMoreOpen || !sheet) return;

    const onTouchMove = (event: TouchEvent) => {
      const drag = sheetDragRef.current;
      const touch = event.touches[0];
      if (!drag || !touch) return;

      const offset = Math.max(0, touch.clientY - drag.startY);
      const canDismiss = drag.eligible && (drag.startedOnHandle || sheet.scrollTop <= 0);
      if (offset === 0 || !canDismiss) return;

      event.preventDefault();
      dragOffsetRef.current = offset;
      setHasSheetDragged(true);
      setIsSheetDragging(true);
      setDragOffset(offset);
    };

    sheet.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => sheet.removeEventListener("touchmove", onTouchMove);
  }, [isMoreOpen, officialDesignEnabled]);

  const handleSheetTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    const touch = event.touches[0];
    if (!sheet || !touch) return;

    const target = event.target instanceof Element ? event.target : null;
    const startedOnHandle = Boolean(target?.closest(".mobile-more-sheet-handle"));
    sheetDragRef.current = {
      startY: touch.clientY,
      startedAt: Date.now(),
      eligible: startedOnHandle || sheet.scrollTop <= 0,
      startedOnHandle,
    };
    dragOffsetRef.current = 0;
    setDragOffset(0);
    setIsSheetDragging(false);
  }, []);

  const finishSheetDrag = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    const drag = sheetDragRef.current;
    const touch = event.changedTouches[0];
    const offset = dragOffsetRef.current;
    const elapsed = drag ? Math.max(1, Date.now() - drag.startedAt) : 1;
    const sheetHeight = sheet?.getBoundingClientRect().height ?? 0;
    const dismissDistance = Math.max(100, sheetHeight / 4);
    const shouldDismiss = Boolean(drag?.eligible && offset > 0 && (offset >= dismissDistance || offset / elapsed >= 0.6));

    resetSheetDrag();
    if (shouldDismiss && touch) {
      dismissMore();
    }
  }, [dismissMore, resetSheetDrag]);

  /*
  FNXC:GitHubImportSwipeBack 2026-07-20-23:12:
  More actions transition directly into their destination. Preserve the
  current history position while removing More so its asynchronous back
  consumption cannot dismiss Import or its nested candidate detail afterward.
  */
  const handleMoreAction = useCallback(
    (callback?: () => void) => {
      dismissMore(true);
      callback?.();
    },
    [dismissMore],
  );

  /*
  FNXC:MobileNav 2026-09-14-19:51:
  The opening focus is an accessibility affordance emitted EXACTLY ONCE PER OPEN, and never scrolls.
  It used to live in the dismissal effect, whose deps change identity on any parent re-render (`dismissMore`
  follows the NavigationHistoryContext value). Replaying `focus()` on a `overflow-y: auto` popover returns it to
  scrollTop 0, so the list moved under the finger between touchstart and click and an entry reached after scrolling
  never opened. The open-transition ref re-arms on close, and `preventScroll` keeps the surface still.
  */
  const openFocusArmedRef = useRef(false);
  useEffect(() => {
    if (!isMenuOpen) {
      openFocusArmedRef.current = false;
      return;
    }
    if (openFocusArmedRef.current) return;
    openFocusArmedRef.current = true;
    menuSurfaceRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [isMenuOpen]);

  useEffect(() => {
    if (!isMenuOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissMore();
    };
    /*
    FNXC:NativeShell 2026-09-11-15:01:
    The trailing pill hamburger owns its toggle click and remains inside the popover boundary. Escape, Back, and outside dismissal keep the canonical menu lifecycle while non-navigation closes restore focus to this sole trigger.
    */
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        !officialDesignEnabled
        || menuSurfaceRef.current?.contains(event.target as Node)
        || target?.closest(".mobile-menu-trigger")
      ) return;
      /*
      FNXC:MobileNav 2026-09-14-08:05:
      Geometric fallback for the dismissal guard. On a phone the popover can re-anchor between touchstart and click
      (URL-bar collapse moves the visual viewport), and DOM containment then reports a press on a menu entry as
      "outside" — closing the menu with nothing behind it. A press whose coordinates fall inside the popover is a
      press ON the menu whatever the DOM says, so it never dismisses.
      */
      const surface = menuSurfaceRef.current;
      if (surface) {
        const rect = surface.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (inside) return;
      }
      dismissMore();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [dismissMore, isMenuOpen, officialDesignEnabled]);

  useLayoutEffect(() => {
    /*
    FNXC:Navigation 2026-07-25-22:57:
    A hidden overview bar must remove its published height as well as its DOM shell; otherwise project content retains dead bottom space.

    FNXC:NativeShell 2026-09-10-03:51:
    Measurement follows every condition that mounts the mobile nav. A desktop/tablet-to-mobile transition or modal close must publish the newly rendered pill height instead of leaving the root fallback active.
    */
    if (hidden) {
      document.documentElement.style.removeProperty("--mobile-nav-height");
      document.documentElement.style.removeProperty("--mobile-nav-pill-height");
      document.documentElement.style.removeProperty("--mobile-nav-pill-left");
      document.documentElement.style.removeProperty("--mobile-nav-pill-width");
      return;
    }

    const navEl = navRef.current;
    if (!navEl || typeof document === "undefined") {
      return;
    }

    const publishMeasuredHeight = () => {
      const computed = window.getComputedStyle(navEl);
      const paddingBottom = Number.parseFloat(computed.paddingBottom);
      const floatingGap = Number.parseFloat(computed.getPropertyValue("--mobile-nav-floating-gap"));
      const tabHeights = Array.from(navEl.querySelectorAll<HTMLElement>(".mobile-nav-tab"), (tab) => tab.getBoundingClientRect().height);
      const publishedHeight = computePublishedMobileNavHeight({
        navOffsetHeight: navEl.offsetHeight,
        paddingBottom,
        tabHeights,
        floatingGap,
      });
      const pillHeight = Math.max(44, navEl.offsetHeight, ...tabHeights.filter((height) => Number.isFinite(height)));
      document.documentElement.style.setProperty("--mobile-nav-height", `${publishedHeight}px`);
      document.documentElement.style.setProperty("--mobile-nav-pill-height", `${Math.ceil(pillHeight)}px`);
      /*
      FNXC:MobileNavGesture 2026-09-17-16:53:
      FN-511 : le tiroir gestuel doit occuper EXACTEMENT la largeur du pied de page et démarrer à son bord. On publie donc
      la géométrie horizontale mesurée de la pill depuis ce même effet (aucun second observateur) ; les autres modes de
      popover ne la consomment pas.
      */
      const pillRect = navEl.getBoundingClientRect();
      if (Number.isFinite(pillRect.width) && pillRect.width > 0) {
        document.documentElement.style.setProperty("--mobile-nav-pill-left", `${Math.round(pillRect.left)}px`);
        document.documentElement.style.setProperty("--mobile-nav-pill-width", `${Math.round(pillRect.width)}px`);
      }
    };

    publishMeasuredHeight();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        publishMeasuredHeight();
      });
      observer.observe(navEl);
    }

    return () => {
      observer?.disconnect();
      document.documentElement.style.removeProperty("--mobile-nav-height");
      document.documentElement.style.removeProperty("--mobile-nav-pill-height");
      document.documentElement.style.removeProperty("--mobile-nav-pill-left");
      document.documentElement.style.removeProperty("--mobile-nav-pill-width");
    };
  }, [hidden, modalOpen, mode]);

  /*
  FNXC:NativeShell 2026-09-16-19:44:
  FN-468 : le montage de la pill est désormais décidé par le prédicat de shell partagé `isMobileShellMode`, donc
  la pill se monte en `mobile` ET en `tablet` (0–1023.98 px). C'est le SECOND des deux verrous qui l'excluaient de
  la tablette : le CSS la masquait, mais ce prédicat l'empêchéait déjà de se monter du tout. Retirer la colonne de
  gauche, le pied de page large et le dock droit de la bande tablette sans lever CE verrou laisserait la tablette
  sans aucune navigation primaire. Seule l'appartenance au MODE est élargie : `modalOpen` et `hidden` conservent
  leur sémantique exacte et continuent à démonter la pill.
  */
  /*
  FNXC:MobileNavGesture 2026-09-17-16:53:
  FN-511 : le geste de glissement vers le haut du pied de page ouvre le MENU de navigation, plus le Chat. Il est armé
  UNIQUEMENT quand l'option projet est active (le hamburger est alors masqué, donc le geste est la seule affordance),
  quand la pill est réellement montée (`pillMounted` reproduit exactement la condition de démontage ci-dessous, ce qui
  garantit que l'effet du hook se réexécute au moment où `navRef` porte enfin la `<nav>`) et quand le menu est fermé.
  Le déclenchement passe par `onUiMenuOpenChange(true)`, c'est-à-dire le MÊME propriétaire d'état que le hamburger.
  Le hook doit être appelé AVANT le retour anticipé ci-dessous pour que le nombre de hooks reste stable entre rendus.
  */
  const pillMounted = isMobileShellMode(mode) && !modalOpen && !hidden;
  const openMenuFromFooterGesture = useCallback(() => onUiMenuOpenChange?.(true), [onUiMenuOpenChange]);
  useFooterSwipeUpGesture({
    enabled: pillMounted && menuGestureEnabled && !isMenuOpen,
    surfaceRef: navRef,
    onTrigger: openMenuFromFooterGesture,
  });

  /*
  FNXC:MobileNavGesture 2026-09-18-00:54:
  FN-520 : la liste de navigation adopte le MÊME contrat de fermeture que les tiroirs du shell. Un glissement
  descendant n'est réclamé que si TOUS les conteneurs défilants entre la cible et la surface — surface comprise —
  étaient au bord haut au moment du contact ; une liste déjà défilée conserve donc intégralement son défilement
  natif, et aucun `preventDefault` n'est émis avant réclamation. Seul l'« overscroll dans le vide » signalé par
  l'opérateur devient une fermeture. `onDismiss` passe par le propriétaire d'état EXISTANT (`dismissMore`), donc
  aucun second propriétaire n'est créé et `navigationHistory` n'est pas dupliqué. Le geste d'OUVERTURE ci-dessus
  est armé uniquement `!isMenuOpen` et celui-ci uniquement `open: isMenuOpen` : les deux ne coexistent jamais sur
  le même contact. Comme `useFooterSwipeUpGesture`, l'appel précède le retour anticipé `pillMounted` pour que le
  nombre de hooks reste stable entre rendus.
  */
  const dismissMenuFromDrawerGesture = useCallback(() => { dismissMore(); }, [dismissMore]);
  const menuDismissGestureProps = useDrawerDismissGesture({
    enabled: officialDesignEnabled,
    open: isMenuOpen,
    panelRef: menuSurfaceRef,
    onDismiss: dismissMenuFromDrawerGesture,
  });

  if (!pillMounted) {
    return null;
  }

  const planningHandler = activePlanningSessionCount > 0 && onResumePlanning ? onResumePlanning : onOpenPlanning;

  const skillsEnabled = Boolean(showSkillsTab);

  const sortedPrimaryPluginViews = pluginDashboardViews
    .filter((entry) => entry.view.placement === "primary")
    .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER));
  /*
  FNXC:Navigation 2026-06-19-12:05:
  Mobile navigation adds Command Center as a fixed top-level tab immediately after Mailbox.
  Primary plugin tabs, including Compound Engineering, are demoted to the More sheet so touch targets stay wide and Command Center is not duplicated.

  FNXC:Navigation 2026-06-19-08:24:
  FN-6725 re-verified the suspected-revert surface: Command Center remains adjacent to Mailbox even when mailbox badges render, primary plugin tabs remain More-sheet-only, and no Command Center More-sheet duplicate is allowed.
  */
  const MAX_PRIMARY_PLUGIN_TOP_LEVEL_TABS = 0;
  const topLevelPrimaryPluginViews = sortedPrimaryPluginViews.slice(0, MAX_PRIMARY_PLUGIN_TOP_LEVEL_TABS);
  const topLevelPluginViewKeys = new Set(
    topLevelPrimaryPluginViews.map((entry) => `${entry.pluginId}:${entry.view.viewId}`),
  );
  const overflowPluginViews = pluginDashboardViews
    .filter((entry) => !topLevelPluginViewKeys.has(`${entry.pluginId}:${entry.view.viewId}`))
    .sort((a, b) => (a.view.order ?? Number.MAX_SAFE_INTEGER) - (b.view.order ?? Number.MAX_SAFE_INTEGER));

  /*
  FNXC:Navigation 2026-07-17-00:00:
  Selectable mobile destinations use one registry so an available destination is rendered exactly once:
  configured items are tabs and omitted items are More entries. Feature gates are enforced here rather
  than by the core resolver, keeping persisted choices valid if an operator later enables a feature.
  */
  /*
  FNXC:NativeShell 2026-09-09-22:40:
  Every destination reached from an overflow surface closes that surface through handleMoreAction before navigation. This includes Agents and Missions, which are always overflow entries on the mobile pill but can remain primary tabs in standard mobile mode.
  */
  const destinationRegistry: Record<MobileNavSelectableItem, {
    icon: ReactNode;
    labelKey: string;
    fallback: string;
    moreTestId: string;
    isActive: boolean;
    isAvailable: boolean;
    navigate: (surface: "primary" | "more") => void;
    indicator?: boolean;
    indicatorLabel?: string;
    badge?: number;
    badgeLabel?: string;
    alpha?: boolean;
  }> = {
    "command-center": { icon: <Gauge />, labelKey: "nav.commandCenter", fallback: "Dashboard", moreTestId: "mobile-more-item-command-center", isActive: view === "command-center", isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("command-center") : handleMoreAction(() => onChangeView("command-center")) },
    /*
    FNXC:MobileTaskNavigation 2026-09-17-01:43:
    FN-480 : sur le shell mobile, le Board est la surface projet permanente sous les drawers, donc un raccourci
    « Board » n'y produit aucun changement perceptible. Le slot persisté `tasks` rend et route donc **List** sur cet
    hôte : icône List, libellé `nav.list`, actif sur `view === "list"`, navigation `onChangeView("list")` pour les
    deux surfaces (onglet direct et entrée du menu). C'est une décision de rendu de l'hôte mobile, pas une migration :
    l'identifiant persisté `tasks`, le résolveur de `@fusion/core`, les libellés des Réglages et les hôtes
    tablette/ordinateur restent inchangés. Cette entrée est désormais l'unique producteur de List sur téléphone.
    */
    tasks: { icon: <List />, labelKey: "nav.list", fallback: "List", moreTestId: "mobile-more-item-tasks", isActive: view === "list", isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("list") : handleMoreAction(() => onChangeView("list")) },
    agents: { icon: <Bot />, labelKey: "nav.agents", fallback: "Agents", moreTestId: "mobile-more-item-agents", isActive: view === "agents", isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("agents") : handleMoreAction(() => onChangeView("agents")) },
    missions: { icon: <Target />, labelKey: "nav.missions", fallback: "Missions", moreTestId: "mobile-more-item-missions", isActive: view === "missions", isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("missions") : handleMoreAction(() => onChangeView("missions")) },
    chat: { icon: <MessageSquare />, labelKey: "nav.chat", fallback: "Chat", moreTestId: "mobile-more-item-chat", isActive: view === "chat", isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("chat") : handleMoreAction(() => onChangeView("chat")), indicator: chatHasUnreadResponse && view !== "chat", indicatorLabel: t("nav.chatUnreadAriaLabel", "Unread chat response") },
    mailbox: { icon: <Mail />, labelKey: "nav.mailbox", fallback: "Mailbox", moreTestId: "mobile-more-item-mailbox", isActive: view === "mailbox", isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("mailbox") : handleMoreAction(() => onChangeView("mailbox")), indicator: mailboxPendingApprovalCount > 0 && view !== "mailbox", indicatorLabel: t("nav.mailboxPendingAriaLabel", "Pending approvals"), badge: mailboxUnreadCount },
    /* FNXC:HistoryModalSurface 2026-09-15-04:29: FN-403: History is a modal surface, so it is never the active destination; invoking this entry opens the History modal over the current view. */
    patchnode: { icon: <History />, labelKey: "nav.patchnode", fallback: "History", moreTestId: "mobile-more-item-patchnode", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("patchnode") : handleMoreAction(() => onChangeView("patchnode")) },
    planning: { icon: <Lightbulb />, labelKey: "nav.planning", fallback: "Planning", moreTestId: "mobile-more-item-planning", isActive: view === "planning", isAvailable: true, navigate: (surface) => surface === "primary" ? planningHandler?.() : handleMoreAction(planningHandler), indicator: planningNeedsInput && view !== "planning", indicatorLabel: t("nav.planningNeedsInputAriaLabel", "Planning needs your input"), badge: activePlanningSessionCount },
    activity: { icon: <Activity />, labelKey: "nav.activityLog", fallback: "Activity Log", moreTestId: "mobile-more-item-activity", isActive: false, isAvailable: Boolean(onOpenActivityLog), navigate: (surface) => surface === "primary" ? onOpenActivityLog?.() : handleMoreAction(onOpenActivityLog) },
    git: { icon: <GitBranch />, labelKey: "nav.gitManager", fallback: "Git Manager", moreTestId: "mobile-more-item-git", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenGitManager?.() : handleMoreAction(onOpenGitManager), badge: stashOrphanCount },
    files: { icon: <Folder />, labelKey: "nav.files", fallback: "Files", moreTestId: "mobile-more-item-files", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenFiles?.() : handleMoreAction(onOpenFiles) },
    workflows: { icon: <Workflow />, labelKey: "nav.workflows", fallback: "Workflows", moreTestId: "mobile-more-item-workflow", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenWorkflowEditor?.() : handleMoreAction(onOpenWorkflowEditor) },
    automation: { icon: <Clock />, labelKey: "nav.automation", fallback: "Automation", moreTestId: "mobile-more-item-schedules", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenSchedules?.() : handleMoreAction(onOpenSchedules) },
    "github-import": { icon: <GitHubLogo />, labelKey: "nav.importFromGitHub", fallback: "Import from GitHub", moreTestId: "mobile-more-item-github", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenGitHubImport?.() : handleMoreAction(onOpenGitHubImport) },
    usage: { icon: <Activity />, labelKey: "nav.usage", fallback: "Usage", moreTestId: "mobile-more-item-usage", isActive: false, isAvailable: Boolean(onOpenUsage), navigate: (surface) => surface === "primary" ? onOpenUsage?.() : handleMoreAction(onOpenUsage) },
    projects: { icon: <Grid3X3 />, labelKey: "nav.projects", fallback: "Projects", moreTestId: "mobile-more-item-projects", isActive: false, isAvailable: Boolean(onViewAllProjects), navigate: (surface) => surface === "primary" ? onViewAllProjects?.() : handleMoreAction(onViewAllProjects) },
    notes: { icon: <StickyNote />, labelKey: "nav.notes", fallback: "Notes", moreTestId: "mobile-more-item-notes", isActive: view === "notes", isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("notes") : handleMoreAction(() => onChangeView("notes")) },
    whiteboard: { icon: <PanelsTopLeft />, labelKey: "nav.whiteboard", fallback: "Whiteboard", moreTestId: "mobile-more-item-whiteboard", isActive: view === "whiteboard", isAvailable: Boolean(experimentalFeatures?.whiteboardView), alpha: true, navigate: (surface) => surface === "primary" ? onChangeView("whiteboard") : handleMoreAction(() => onChangeView("whiteboard")) },
    secrets: { icon: <Lock />, labelKey: "nav.secrets", fallback: "Secrets", moreTestId: "mobile-more-item-secrets", isActive: view === "secrets", isAvailable: true, navigate: (surface) => surface === "primary" ? onChangeView("secrets") : handleMoreAction(() => onChangeView("secrets")) },
    settings: { icon: <Settings />, labelKey: "nav.settings", fallback: "Settings", moreTestId: "mobile-more-item-settings", isActive: false, isAvailable: true, navigate: (surface) => surface === "primary" ? onOpenSettings?.() : handleMoreAction(onOpenSettings) },
    skills: { icon: <Zap />, labelKey: "nav.skills", fallback: "Skills & Snippets", moreTestId: "mobile-more-item-skills", isActive: view === "skills", isAvailable: skillsEnabled, navigate: (surface) => surface === "primary" ? onChangeView("skills") : handleMoreAction(() => onChangeView("skills")) },
    insights: { icon: <Sparkles />, labelKey: "nav.insights", fallback: "Insights", moreTestId: "mobile-more-item-insights", isActive: view === "insights", isAvailable: Boolean(experimentalFeatures?.insights), navigate: (surface) => surface === "primary" ? onChangeView("insights") : handleMoreAction(() => onChangeView("insights")) },
    memory: { icon: <Brain />, labelKey: "nav.memory", fallback: "Memory", moreTestId: "mobile-more-item-memory", isActive: view === "memory", isAvailable: Boolean(experimentalFeatures?.memoryView), navigate: (surface) => surface === "primary" ? onChangeView("memory") : handleMoreAction(() => onChangeView("memory")) },
    research: { icon: <Search />, labelKey: "nav.research", fallback: "Research", moreTestId: "mobile-more-item-research", isActive: view === "research", isAvailable: Boolean(experimentalFeatures?.researchView), navigate: (surface) => surface === "primary" ? onChangeView("research") : handleMoreAction(() => onChangeView("research")) },
    evals: { icon: <Target />, labelKey: "nav.evals", fallback: "Evals", moreTestId: "mobile-more-item-evals", isActive: view === "evals", isAvailable: Boolean(experimentalFeatures?.evalsView), navigate: (surface) => surface === "primary" ? onChangeView("evals") : handleMoreAction(() => onChangeView("evals")) },
    ideation: { icon: <Lightbulb />, labelKey: "nav.ideation", fallback: "Ideation", moreTestId: "mobile-more-item-ideation", isActive: view === "ideation", isAvailable: Boolean(experimentalFeatures?.ideationView), navigate: (surface) => surface === "primary" ? onChangeView("ideation") : handleMoreAction(() => onChangeView("ideation")) },
    goals: { icon: <Target />, labelKey: "nav.goals", fallback: "Goals", moreTestId: "mobile-more-item-goals", isActive: view === "goalsView", isAvailable: Boolean(experimentalFeatures?.goalsView), navigate: (surface) => surface === "primary" ? onChangeView("goalsView") : handleMoreAction(() => onChangeView("goalsView")) },
    "dev-server": { icon: <Monitor />, labelKey: "nav.devServer", fallback: "Dev Server", moreTestId: "mobile-more-item-dev-server", isActive: view === "dev-server" || view === "devserver", isAvailable: Boolean(experimentalFeatures?.devServerView), navigate: (surface) => surface === "primary" ? onChangeView("dev-server") : handleMoreAction(() => onChangeView("dev-server")) },
  };
  /*
  FNXC:MobileDrawer 2026-09-16-17:41:
  FN-467 replaces the former fixed four-destination pill (and its hard-coded exclusion of Board) with the project's
  persisted **Navigation quick access** selection: up to five resolved destinations in the operator's order, the
  hamburger always last. Board (`tasks`) is now an ordinary destination — a direct tab when selected, a menu entry
  otherwise — because the drawer-returns-to-Kanban argument never justified making it unreachable from the menu too.
  `patchnode` stays excluded: History is a modal surface, not a navigation destination.

  FNXC:Navigation 2026-09-17-16:53:
  FN-511 : la rangée de la pill est STRICTEMENT la sélection d'accès rapide résolue — cinq créneaux, même clé, même
  ordre que le pied de page large — suivie du déclencheur de menu. C'est l'exigence de parité PC/mobile : pour une même
  valeur de réglage, les deux hôtes rendent la même liste. `chat` y est une destination ORDINAIRE : onglet direct quand
  il est résolu, ligne du menu « Plus » sinon, jamais les deux. Aucune promotion dynamique liée à la largeur mesurée ne
  subsiste, et le geste de glissement du pied de page n'ouvre plus le Chat mais le menu de navigation (étape 5).
  `patchnode` reste exclu : History est une surface modale, pas une destination.
  */
  /* Computed inline rather than memoized: this statement sits AFTER the component's early returns, so a hook here would
  change the hook count between renders. The resolver is a pure array reduce over at most a handful of ids. */
  const primaryDestinationItems: MobileNavSelectableItem[] = resolveMobileNavPrimaryItems({
    mobileNavPrimaryItems: quickAccessItems ? [...quickAccessItems] : undefined,
  }).primaryItems;
  /*
  FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
  FN-481 : prédicat d'éligibilité UNIQUE. Une destination n'est offerte par la pill que si elle est disponible ET si
  le Header de cet hôte ne la propose pas déjà. Il s'applique AVANT le comptage et la troncature, donc un accès
  possédé par le Header ne consomme jamais un créneau ni ne réapparaît dans le menu ; il DISPARAÎT du DOM au lieu
  d'être masqué. Le filtre est générique : il vaut pour n'importe quel identifiant du registre, pas seulement pour les
  quatre lignes actuellement rendues en double. Il ne touche ni la normalisation core, ni l'ordre persisté, ni le
  plafond, et n'écrit jamais le réglage d'accès rapide.
  */
  const headerOwnedItemSet = new Set(headerOwnedItems ?? []);
  const isEligibleDestination = (item: MobileNavSelectableItem): boolean =>
    destinationRegistry[item].isAvailable && !headerOwnedItemSet.has(item);
  const effectivePrimaryItems = primaryDestinationItems.filter(isEligibleDestination);
  const effectiveOmittedItems = MOBILE_NAV_SELECTABLE_ITEMS
    .filter((item) => !effectivePrimaryItems.includes(item) && item !== "patchnode")
    .filter(isEligibleDestination);
  const isMoreActive = effectiveOmittedItems.some((item) => destinationRegistry[item].isActive)
    || view === "graph"
    || (isPluginViewId(view) && !topLevelPrimaryPluginViews.some((entry) => buildPluginTaskViewId(entry.pluginId, entry.view.viewId) === view));

  /*
  FNXC:MobileNavGesture 2026-09-18-00:54:
  FN-520 : les lignes du menu de navigation sont de VRAIS `button` accessibles, et `isEligibleStart` du geste de
  fermeture refuse tout contrôle interactif qui n'est pas une ligne qualifiée. Sans `listRowGestureAttributes()`
  posé EXPLICITEMENT sur chaque ligne, le geste ne démarrerait que sur les rares zones non interactives de la
  surface (titre, séparateur) — donc nulle part où l'opérateur pose réellement le doigt. La qualification reste
  locale et minimale : le chevron `.mobile-more-split-toggle` (qui déplie les scripts, une action distincte de la
  ligne) et le contenu injecté de `shellConnectionControl` (propriété d'un autre composant) NE sont pas qualifiés,
  donc le geste n'y démarre pas et aucune sémantique accessible n'est retirée. Les onglets `.mobile-nav-tab` de la
  barre elle-même ne sont pas dans la surface de menu et restent également natifs.
  */
  const renderSelectableItem = (item: MobileNavSelectableItem, surface: "primary" | "more") => {
    const destination = destinationRegistry[item];
    const isPrimary = surface === "primary";
    const label = t(destination.labelKey, destination.fallback);
    if (isPrimary) return <button key={item} type="button" className={`mobile-nav-tab${destination.isActive ? " mobile-nav-tab--active" : ""}`} data-testid={`mobile-nav-tab-${item}`} role={undefined} aria-label={label} aria-current={destination.isActive ? "page" : undefined} aria-selected={undefined} onClick={() => destination.navigate("primary")}><span className="mobile-nav-tab-icon-wrapper">{destination.icon}{destination.indicator && <span className="status-dot status-dot--pending mobile-nav-chat-unread-dot" aria-label={destination.indicatorLabel} />}</span>{destination.badge && destination.badge > 0 ? <span className="mobile-nav-tab-badge" aria-label={destination.badgeLabel}>{formatCount(destination.badge)}</span> : null}{destination.alpha ? <span className="mobile-nav-tab-badge">{t("common.alpha", "Alpha")}</span> : null}</button>;
    return <button key={item} type="button" className="mobile-more-item" {...listRowGestureAttributes()} data-testid={destination.moreTestId} onClick={() => destination.navigate("more")}><span className="mobile-more-item-icon-wrapper">{destination.icon}{destination.indicator && <span className="status-dot status-dot--pending mobile-more-item-icon-dot" aria-label={destination.indicatorLabel} />}</span><span>{label}</span>{destination.badge && destination.badge > 0 ? <span className="mobile-more-item-badge" aria-label={destination.badgeLabel}>{formatCount(destination.badge)}</span> : null}{destination.alpha ? <span className="mobile-more-item-badge">{t("common.alpha", "Alpha")}</span> : null}</button>;
  };

  /*
  FNXC:MobileNav 2026-09-14-07:48:
  Freeze the navigation geometry while the popover is open. Its max-height is anchored to
  --mobile-nav-viewport-offset-top and 100dvh, both of which MOVE on a phone as soon as the user scrolls: the browser
  collapses its URL bar, visualViewport reports a new offset, and the popover re-anchors between touchstart and click.
  The tap then lands outside the moved surface, the outside-pointerdown guard dismisses the menu, and the destination
  never opens — which is why only entries reached AFTER scrolling were affected. Holding the last geometry while the
  menu is open keeps the surface still for the whole gesture; it is released on close, so safe-area tracking resumes
  untouched everywhere else.
  */
  const liveGeometryStyle = createMobileNavGeometryStyle(keyboardMetrics?.viewportOffsetTop ?? 0);
  if (!isMenuOpen) frozenGeometryRef.current = null;
  else if (!frozenGeometryRef.current) frozenGeometryRef.current = liveGeometryStyle;
  const mobileNavGeometryStyle = frozenGeometryRef.current ?? liveGeometryStyle;

  return (
    <>
      <nav
        ref={navRef}
        className={`mobile-nav-bar mobile-nav-bar--native${footerVisible ? " mobile-nav-bar--with-footer" : ""}${keyboardOpen ? " mobile-nav-bar--keyboard-open" : ""}`}
        style={mobileNavGeometryStyle}
        role="navigation"
        aria-label={t("nav.primaryNavAriaLabel", "Primary navigation")}
      >
        {effectivePrimaryItems.map((item) => renderSelectableItem(item, "primary"))}
        {/*
        FNXC:ToolSurfaces 2026-09-15-16:04:
        FN-426 removes this legacy-layout List tab. The header Board/List toggle now exists on every breakpoint,
        including phones, so keeping a second bottom-bar producer would give one destination two primary owners.

        FNXC:ToolSurfaces 2026-09-17-01:43:
        FN-480 makes the customizable `tasks` item itself the phone's single List producer (Board is the permanent
        background surface), so this legacy tab must stay deleted: restoring it would recreate the duplicate owner.
        */}

        {!officialDesignEnabled && topLevelPrimaryPluginViews.map((entry) => {
          const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
          const PluginIcon = getPluginDashboardViewNavIcon(entry);
          return (
            <button
              key={`${entry.pluginId}:${entry.view.viewId}`}
              type="button"
              className={`mobile-nav-tab${view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph") ? " mobile-nav-tab--active" : ""}`}
              data-testid={`mobile-nav-tab-plugin-${entry.pluginId}-${entry.view.viewId}`}
              role="tab"
              aria-selected={view === pluginTaskView || (view === "graph" && entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph")}
              onClick={() => onChangeView(entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : pluginTaskView)}
            >
              <span className="mobile-nav-tab-icon-wrapper">
                <PluginIcon />
              </span>
              <span className="mobile-nav-tab-label">{entry.view.label}</span>
            </button>
          );
        })}

        {/*
        FNXC:MobileNavGesture 2026-09-17-16:53:
        FN-511 : sous l'option de geste, le hamburger n'est PAS rendu du tout — pas une coquille masquée. Aucun
        `aria-label`, `aria-haspopup`, `aria-expanded` ni `aria-controls="mobile-navigation-popover"` ne subsiste alors
        sur un élément de la barre, et le geste devient l'unique affordance d'ouverture du menu.
        */}
        {officialDesignEnabled && !menuGestureEnabled && (
          <button
            ref={menuTriggerRef}
            className="mobile-menu-trigger"
            type="button"
            onClick={() => {
              if (navigationMenuOpen) dismissMore();
              else onUiMenuOpenChange?.(true);
            }}
            title={t("nav.openMenu", "Open navigation menu")}
            aria-label={t("nav.openMenu", "Open navigation menu")}
            aria-haspopup="menu"
            aria-expanded={navigationMenuOpen}
            aria-controls="mobile-navigation-popover"
            data-testid="mobile-menu-trigger"
          >
            <Menu />
          </button>
        )}

        {!officialDesignEnabled && <button
          type="button"
          className={`mobile-nav-tab${isMoreActive ? " mobile-nav-tab--active" : ""}`}
          data-testid="mobile-nav-tab-more"
          role="tab"
          aria-selected={false}
          onClick={() => {
            if (isMoreOpen) {
              dismissMore();
            } else {
              setIsMoreOpen(true);
            }
          }}
        >
          <span className="mobile-nav-tab-icon-wrapper">
            <MoreHorizontal />
            {planningNeedsInput && view !== "planning" && !isMoreOpen && (
              <span className="status-dot status-dot--pending mobile-nav-chat-unread-dot" aria-label={t("nav.planningNeedsInputAriaLabel", "Planning needs your input")} />
            )}
          </span>
          <span className="mobile-nav-tab-label">{t("nav.more", "More")}</span>
        </button>}
      </nav>

      {isMenuOpen && (
        <>
          {!officialDesignEnabled && <div
            className="mobile-more-sheet-backdrop"
            onClick={() => dismissMore()}
          />}
          <div
            ref={(element) => {
              menuSurfaceRef.current = element;
              sheetRef.current = officialDesignEnabled ? null : element;
            }}
            id={officialDesignEnabled ? "mobile-navigation-popover" : undefined}
            /*
            FNXC:MobileNavGesture 2026-09-17-16:53:
            FN-511 : en mode geste, le menu se présente comme un TIROIR qui part du bord supérieur du pied de page et
            occupe sa largeur. C'est un MODIFICATEUR de la surface existante, pas une seconde surface : toutes les règles
            de `.mobile-navigation-popover` (couches, hauteur maximale, défilement, peinture) restent en vigueur.
            */
            className={officialDesignEnabled ? `mobile-navigation-popover${menuGestureEnabled ? " mobile-navigation-popover--footer-drawer" : ""}` : `mobile-more-sheet${isSheetDragging ? " mobile-more-sheet--dragging" : ""}${hasSheetDragged ? " mobile-more-sheet--gesture-ready" : ""}`}
            role="menu"
            aria-label={t("nav.moreSheetTitle", "Navigate")}
            style={officialDesignEnabled ? mobileNavGeometryStyle : { transform: `translateY(${dragOffset}px)` }}
            onTouchStart={officialDesignEnabled ? undefined : handleSheetTouchStart}
            onTouchEnd={officialDesignEnabled ? undefined : finishSheetDrag}
            onTouchCancel={officialDesignEnabled ? undefined : resetSheetDrag}
            /*
            FNXC:MobileNavGesture 2026-09-18-00:54:
            FN-520 : les props pointeur du geste de fermeture ne sont étalées que sur la surface officielle. La
            branche héritée `.mobile-more-sheet` garde ses propres gestionnaires tactiles : deux gestes sur la même
            surface se disputeraient le même contact.
            */
            {...(officialDesignEnabled ? menuDismissGestureProps : {})}
            /*
            FNXC:MobileNav 2026-09-14-07:02:
            Selecting an entry that only becomes reachable AFTER scrolling did nothing. The sheet carries a transform
            open animation, and any state change while it is scrolled can restart that animation: the surface shifts
            under the finger between touchstart and click, so the tap lands on nothing. `--gesture-ready` already
            neutralises the animation, but it was armed only by a DRAG, which a plain scroll never performs. Arming it
            on first scroll settles the surface for every entry below the fold; the flag is idempotent so scrolling
            does not re-render per event.
            */
            onScroll={officialDesignEnabled ? undefined : () => { if (!hasSheetDragged) setHasSheetDragged(true); }}
          >
            {/*
            FNXC:StandardizedDrawers 2026-09-15-04:56:
            FN-406: the More sheet drew its own grab bar, which is exactly the drift that gave the file browser two
            handles. It now uses the shared ViewDrawerHandle primitive; `mobile-more-sheet-handle` stays on the TARGET
            because `handleSheetTouchStart` resolves drag eligibility via `closest(".mobile-more-sheet-handle")`.
            */}
            {!officialDesignEnabled && <ViewDrawerHandle className="mobile-more-sheet-handle" barClassName="mobile-more-sheet-handle__bar" />}
            <div className="mobile-more-sheet-title">{t("nav.moreSheetTitle", "Navigate")}</div>

            {shellConnectionControl ? (
              <div className="mobile-more-shell-connection" data-testid="mobile-more-shell-connection">
                {shellConnectionControl}
              </div>
            ) : null}

            <div className="mobile-more-split-row">
              <button
                type="button"
                className="mobile-more-item mobile-more-split-primary"
                {...listRowGestureAttributes()}
                data-testid="mobile-more-item-terminal"
                onClick={() => handleMoreAction(onToggleTerminal)}
              >
                <Terminal />
                <span>{t("nav.terminal", "Terminal")}</span>
              </button>
              <button
                type="button"
                className="mobile-more-split-toggle"
                data-testid="mobile-more-terminal-split-toggle"
                onClick={() => setIsScriptsSubmenuOpen((prev) => !prev)}
                aria-expanded={isScriptsSubmenuOpen}
                aria-haspopup="menu"
                aria-label={t("nav.showScriptsAriaLabel", "Show scripts")}
              >
                <ChevronRight
                  size={14}
                  className={`mobile-more-chevron${isScriptsSubmenuOpen ? " mobile-more-chevron--open" : ""}`}
                />
              </button>
            </div>
            {isScriptsSubmenuOpen && (
              <div className="mobile-more-submenu" role="menu" aria-label={t("nav.scriptsSubmenuAriaLabel", "Scripts submenu")}>
                {scriptsLoading ? (
                  <div className="mobile-more-submenu-loading" data-testid="mobile-more-scripts-loading">
                    <Loader2 className="animate-spin" />
                    <span>{t("nav.loadingScripts", "Loading scripts…")}</span>
                  </div>
                ) : scriptEntries.length > 0 ? (
                  <>
                    {scriptEntries.map((script) => (
                      <button
                        key={script.name}
                        type="button"
                        className="mobile-more-item mobile-more-subitem"
                        {...listRowGestureAttributes()}
                        data-testid={`mobile-more-script-item-${script.name}`}
                        onClick={() => {
                          if (onRunScript) onRunScript(script.name, script.command);
                          dismissMore();
                          setIsScriptsSubmenuOpen(false);
                        }}
                      >
                        <Play />
                        <span className="mobile-more-script-info">
                          <span className="mobile-more-script-name">{script.name}</span>
                          <span className="mobile-more-script-description" title={script.description ?? script.command}>
                            {script.description ?? script.command}
                          </span>
                        </span>
                      </button>
                    ))}
                    {onOpenScripts && (
                      <button
                        type="button"
                        className="mobile-more-item mobile-more-subitem mobile-more-subitem--manage"
                        {...listRowGestureAttributes()}
                        data-testid="mobile-more-scripts-manage"
                        onClick={() => {
                          dismissMore();
                          setIsScriptsSubmenuOpen(false);
                          onOpenScripts();
                        }}
                      >
                        <FileCode />
                        <span>{t("nav.manageScripts", "Manage Scripts…")}</span>
                      </button>
                    )}
                  </>
                ) : (
                  onOpenScripts && (
                    <button
                      type="button"
                      className="mobile-more-item mobile-more-subitem"
                      {...listRowGestureAttributes()}
                      data-testid="mobile-more-scripts-manage"
                      onClick={() => {
                        dismissMore();
                        setIsScriptsSubmenuOpen(false);
                        onOpenScripts();
                      }}
                    >
                      <FileCode />
                      <span>{t("nav.noScriptsAddOne", "No scripts — add one…")}</span>
                    </button>
                  )
                )}
              </div>
            )}


            {effectiveOmittedItems
              .filter((item) => item !== "settings")
              .map((item) => renderSelectableItem(item, "more"))}

            {overflowPluginViews.map((entry) => {
                const pluginTaskView = buildPluginTaskViewId(entry.pluginId, entry.view.viewId);
                const PluginIcon = getPluginDashboardViewNavIcon(entry);
                return (
                  <button
                    key={`${entry.pluginId}:${entry.view.viewId}`}
                    type="button"
                    className="mobile-more-item"
                    {...listRowGestureAttributes()}
                    data-testid={`mobile-more-item-plugin-${entry.pluginId}-${entry.view.viewId}`}
                    onClick={() => handleMoreAction(() => onChangeView(entry.pluginId === "fusion-plugin-dependency-graph" && entry.view.viewId === "graph" ? "graph" : pluginTaskView))}
                  >
                    <PluginIcon />
                    <span>{entry.view.label}</span>
                  </button>
                );
              })}

            {/*
            FNXC:Navigation 2026-07-17-15:43:
            Mobile More-sheet pins Settings below the `mobile-more-separator` divider so it stays at the bottom of
            the list (FN-8250), not inline in the middle. The omitted-items guard prevents a duplicate when Settings
            is promoted to a primary footer tab.

            FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
            FN-481 : le séparateur ne dépend plus du hasard — il n'est rendu QUE si son groupe existe. Sans cette
            garde, promouvoir Settings dans la rangée ou l'attribuer au Header laissait un trait final isolé,
            exactement la coquille résiduelle que le retrait d'un accès doit éviter.
            */}
            {effectiveOmittedItems.includes("settings") && (
              <>
                <div className="mobile-more-separator" />
                {renderSelectableItem("settings", "more")}
              </>
            )}

          </div>
        </>
      )}
    </>
  );
}
