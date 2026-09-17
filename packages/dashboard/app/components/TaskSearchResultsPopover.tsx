/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 header search results panel.
 *
 * It renders the CANONICAL `TaskCard` in its read-only search-result mode, at the board column's
 * width, inside a single vertical scroll area. It deliberately does NOT reuse `DashboardToolPopover`:
 * that surface autofocuses itself and lays a backdrop over the page, which would steal the caret from
 * the search field and make the field unclickable — the field must stay typeable the whole time.
 *
 * The panel is therefore non-modal, anchored to the field, backdrop-free, and rendered in a body
 * portal so no header stacking context can clip it. Its size follows the live measurements of the
 * field and of the rendered cards, and it re-measures on visual-viewport changes (mobile keyboard),
 * on field resize, and on card resize.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Task } from "@fusion/core";
import { TaskCard } from "./TaskCard";
import { useAutoPaginationSentinel } from "../hooks/useAutoPaginationSentinel";
import {
  TASK_SEARCH_FALLBACK_CARD_WIDTH,
  computeTaskSearchAnchor,
  computeTaskSearchPanelGeometry,
  type TaskSearchAnchorGeometry,
  type TaskSearchPanelGeometry,
} from "../utils/taskSearchGeometry";
import type { TaskSearchError, TaskSearchLane } from "../hooks/useTaskSearch";
import "./TaskSearchResultsPopover.css";

/** Distance between the field and the panel, matching `--space-xs`. */
const FIELD_OFFSET = 4;

export interface TaskSearchResultsPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  tasks: readonly Task[];
  lane: TaskSearchLane;
  loading: boolean;
  aiLoading: boolean;
  hasMore: boolean;
  error: TaskSearchError | null;
  projectId?: string;
  panelId: string;
  onSelectTask: (task: Task) => void;
  onLoadMore: () => Promise<void> | void;
  addToast: (message: string, type?: "success" | "error" | "info" | "warning") => void;
  progressKey?: string;
  collectionKey?: string;
}

/**
 * Map a stable server code to recovery copy. Provider prose never reaches this function, so an
 * operator sees an actionable state rather than an upstream diagnostic.
 */
function errorMessage(error: TaskSearchError, t: (key: string, fallback: string) => string): string {
  switch (error.code) {
    case "AI_TASK_SEARCH_RATE_LIMIT":
      return t("header.taskSearchErrorQuota", "Trop de recherches intelligentes pour l'instant. Réessayez dans un moment.");
    case "AI_TASK_SEARCH_TIMEOUT":
      return t("header.taskSearchErrorTimeout", "La recherche intelligente a dépassé le délai. Appuyez sur Entrée pour réessayer.");
    case "AI_TASK_SEARCH_SERVICE_UNAVAILABLE":
      return t("header.taskSearchErrorUnavailable", "La recherche intelligente est indisponible. Vérifiez le modèle Fast & Cheap.");
    case "AI_TASK_SEARCH_INVALID_MODEL_RESPONSE":
      return t("header.taskSearchErrorModel", "Réponse inexploitable du modèle. Appuyez sur Entrée pour réessayer.");
    default:
      return error.kind === "ai"
        ? t("header.taskSearchErrorAi", "La recherche intelligente a échoué. Appuyez sur Entrée pour réessayer.")
        : t("header.taskSearchErrorText", "La recherche a échoué. Modifiez votre saisie pour réessayer.");
  }
}

function readGap(element: HTMLElement | null): number {
  if (!element) return 0;
  const parsed = Number.parseFloat(getComputedStyle(element).rowGap);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Total horizontal padding + border of the panel, which sits OUTSIDE its declared content width. */
function readInlineChrome(element: HTMLElement | null): number {
  if (!element) return 0;
  const style = getComputedStyle(element);
  const sum = [
    style.paddingLeft,
    style.paddingRight,
    style.borderLeftWidth,
    style.borderRightWidth,
  ].reduce((total, value) => total + (Number.parseFloat(value) || 0), 0);
  return Number.isFinite(sum) ? sum : 0;
}

/**
 * Measure a board card if one is currently mounted. In List view — or before the board has painted —
 * there is no card to measure, so the shared column token is used. The FIELD's width is deliberately
 * never used: it is far narrower than a card and would squash every result.
 */
const REFERENCE_CARD_SELECTOR = ".column-body .card, .board .card";

function findReferenceCard(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const candidate = document.querySelector(REFERENCE_CARD_SELECTOR);
  return candidate instanceof HTMLElement ? candidate : null;
}

function measureReferenceCardWidth(): number {
  if (typeof document === "undefined") return TASK_SEARCH_FALLBACK_CARD_WIDTH;
  const width = findReferenceCard()?.getBoundingClientRect().width ?? 0;
  if (width > 0) return width;
  const token = getComputedStyle(document.documentElement).getPropertyValue("--task-search-card-min-width");
  const parsed = Number.parseFloat(token);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : TASK_SEARCH_FALLBACK_CARD_WIDTH;
}

export function TaskSearchResultsPopover({
  anchorRef,
  tasks,
  lane,
  loading,
  aiLoading,
  hasMore,
  error,
  projectId,
  panelId,
  onSelectTask,
  onLoadMore,
  addToast,
  progressKey,
  collectionKey,
}: TaskSearchResultsPopoverProps) {
  const { t } = useTranslation("app");
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<TaskSearchAnchorGeometry | null>(null);
  const [geometry, setGeometry] = useState<TaskSearchPanelGeometry | null>(null);

  const measure = useCallback(() => {
    const field = anchorRef.current;
    if (!field || typeof window === "undefined") return;
    const fieldRect = field.getBoundingClientRect();
    const visual = window.visualViewport;
    const viewport = {
      width: visual?.width ?? window.innerWidth,
      height: visual?.height ?? window.innerHeight,
    };

    const referenceCardWidth = measureReferenceCardWidth();
    /*
    The panel is `content-box`, so its declared width is the CARD width and its own padding/border sit
    outside it. Viewport containment must therefore be computed against the OUTER box, otherwise the
    panel can hang past the screen edge by exactly its chrome.
    */
    const chrome = readInlineChrome(panelRef.current);
    const scrollbarWidth = scrollRef.current
      ? Math.max(0, scrollRef.current.offsetWidth - scrollRef.current.clientWidth)
      : 0;
    const nextAnchor = computeTaskSearchAnchor({
      fieldRect: { top: fieldRect.top, bottom: fieldRect.bottom, left: fieldRect.left, width: fieldRect.width },
      viewport,
      panelWidth: referenceCardWidth + scrollbarWidth + chrome,
      offset: FIELD_OFFSET,
    });

    const cards = listRef.current
      ? [...listRef.current.querySelectorAll<HTMLElement>(":scope > .task-search-result")]
      : [];
    const nextGeometry = computeTaskSearchPanelGeometry({
      cardHeights: cards.map((card) => card.getBoundingClientRect().height),
      gap: readGap(listRef.current),
      availableHeight: nextAnchor.availableHeight,
      referenceCardWidth,
      scrollbarWidth,
    });

    setAnchor((previous) => previous
      && previous.top === nextAnchor.top
      && previous.left === nextAnchor.left
      && previous.placement === nextAnchor.placement
      && previous.availableHeight === nextAnchor.availableHeight
      ? previous
      : nextAnchor);
    setGeometry((previous) => previous
      && previous.scrollHeight === nextGeometry.scrollHeight
      && previous.width === nextGeometry.width
      && previous.constrainedByViewport === nextGeometry.constrainedByViewport
      ? previous
      : nextGeometry);
  }, [anchorRef]);

  // Measure before paint so the panel never appears at a wrong size for one frame.
  useLayoutEffect(() => { measure(); }, [measure, tasks, lane, loading, aiLoading, error]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = () => measure();
    /*
    FNXC:TaskSearch 2026-09-17-07:43:
    FN-494 — le `scroll` en capture sur `window` existe pour re-ancrer le panneau quand la PAGE (ou
    une colonne du tableau) défile sous lui. Un défilement À L'INTÉRIEUR du panneau n'a aucun effet sur
    son ancrage : le laisser passer relançait une passe de mesure complète — donc un rendu de toutes
    les `TaskCard` — à chaque événement de défilement, ce que l'opérateur perçoit comme une liste qui
    ne défile pas. Les événements issus du panneau sont donc ignorés ici, et seulement ceux-là.
    */
    const handleScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      measure();
    };
    window.addEventListener("resize", handle);
    window.addEventListener("scroll", handleScroll, true);
    window.visualViewport?.addEventListener("resize", handle);
    window.visualViewport?.addEventListener("scroll", handle);

    /*
    Card heights change after their own content settles (steps expanding, badges resolving), and the
    field itself resizes between breakpoints. Observing both keeps the 1.5-card reserve true instead
    of frozen at the first paint.
    */
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(handle) : null;
    if (observer) {
      if (listRef.current) observer.observe(listRef.current);
      if (anchorRef.current) observer.observe(anchorRef.current);
      /*
      FNXC:TaskSearch 2026-09-17-09:41:
      The REFERENCE board card is observed too. Without it the panel kept whatever width it measured
      on its first pass: when the panel opened before the board had painted, that was the fallback
      token, and every result card stayed 2px off its board card for the rest of the session
      (measured in Chromium: board 298, panel 300).
      */
      const referenceCard = findReferenceCard();
      if (referenceCard) observer.observe(referenceCard);
      for (const card of listRef.current?.querySelectorAll<HTMLElement>(":scope > .task-search-result") ?? []) {
        observer.observe(card);
      }
    }

    // One post-paint pass, so a board that lays out after the panel opens is still measured.
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(handle) : undefined;

    return () => {
      window.removeEventListener("resize", handle);
      window.removeEventListener("scroll", handleScroll, true);
      window.visualViewport?.removeEventListener("resize", handle);
      window.visualViewport?.removeEventListener("scroll", handle);
      if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [anchorRef, measure, tasks.length]);

  /*
  Only the TEXT lane paginates. The AI lane returns a bounded selection, so an intersecting sentinel
  there would request pages that do not exist.
  */
  const { sentinelRef } = useAutoPaginationSentinel({
    rootRef: scrollRef,
    hasMore: hasMore && lane === "text",
    loading,
    onLoadMore,
    ...(progressKey !== undefined ? { progressKey } : {}),
    ...(collectionKey !== undefined ? { collectionKey } : {}),
  });

  const style = useMemo<CSSProperties>(() => ({
    top: anchor?.top ?? 0,
    left: anchor?.left ?? 0,
    width: geometry?.width ?? TASK_SEARCH_FALLBACK_CARD_WIDTH,
    ...(anchor?.placement === "above" ? { transform: "translateY(-100%)" } : {}),
  }), [anchor, geometry]);

  /*
  `blockSize`, not `maxBlockSize`: the reserve must hold whether the list is longer than it (then the
  area scrolls) or shorter (then the space is genuinely reserved, which is what "see one and a half
  cards before scrolling" means for a short list).
  */
  const scrollStyle = useMemo<CSSProperties>(
    () => ({ blockSize: geometry?.scrollHeight ?? undefined }),
    [geometry],
  );

  const statusMessage = aiLoading
    ? t("header.taskSearchAiLoading", "Recherche intelligente en cours…")
    : error
      ? errorMessage(error, t)
      : loading && tasks.length === 0
        ? t("header.taskSearchLoading", "Recherche…")
        : tasks.length === 0
          ? t("header.taskSearchEmpty", "Aucune tâche ne correspond.")
          : null;

  const laneLabel = lane === "ai"
    ? t("header.taskSearchLaneAi", "Résultats de la recherche intelligente")
    : t("header.taskSearchLaneText", "Résultats de la recherche");

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      id={panelId}
      className={`task-search-results${anchor?.placement === "above" ? " task-search-results--above" : ""}`}
      style={style}
      role="dialog"
      aria-label={laneLabel}
      data-lane={lane}
      data-testid="task-search-results"
      /*
      FNXC:TaskSearch 2026-09-17-07:43:
      Le panneau est non modal : une pression sur son CHROME (en-tête, statut) ne doit jamais faire
      perdre le curseur au champ encore actif, d'où l'annulation.

      FN-494 restreint cette annulation à ce chrome. Appliquée à tout le panneau, elle annulait aussi
      le `mousedown` qui démarre le glissement de la barre de défilement native — la barre était
      visible mais inutilisable, ce que l'opérateur a signalé comme « je ne peux pas scroller ». Un
      `mousedown` sur la barre de défilement cible le conteneur défilant lui-même, donc toute cible
      située dans `.task-search-results-scroll` est laissée au navigateur.
      */
      onMouseDown={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(".task-search-results-scroll")) return;
        event.preventDefault();
      }}
      /*
      FNXC:TaskSearch 2026-09-17-07:43:
      FN-494 — navigation clavier verticale entre cartes de résultat. Le gestionnaire vit sur le
      panneau, jamais sur `TaskCard` : le mode `search-result` de la carte ne doit pas gagner de
      nouveaux gestes. Les cibles interactives internes gardent leur propre comportement de flèches.
      */
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const inner = target.closest("input, textarea, select, [contenteditable='true']");
        if (inner) return;
        const cards = [...(panelRef.current?.querySelectorAll<HTMLElement>(".task-search-result .card") ?? [])];
        const current = target.closest<HTMLElement>(".task-search-result .card");
        const index = current ? cards.indexOf(current) : -1;
        if (index < 0) return;
        const next = event.key === "ArrowDown"
          ? cards[index + 1]
          : cards[index - 1];
        event.preventDefault();
        // Depuis la première carte, ArrowUp ne quitte pas le panneau vers un élément arbitraire.
        if (!next) return;
        next.focus();
        next.scrollIntoView?.({ block: "nearest" });
      }}
    >
      <div className="task-search-results-header">
        <span className="task-search-results-lane" data-testid="task-search-lane-label">{laneLabel}</span>
      </div>
      <div ref={scrollRef} className="task-search-results-scroll" style={scrollStyle} data-testid="task-search-results-scroll">
        <div ref={listRef} className="task-search-results-list">
          {tasks.map((task) => (
            <div key={task.id} className="task-search-result" data-testid="task-search-result">
              <TaskCard
                task={task}
                projectId={projectId}
                interactionMode="search-result"
                onOpenDetail={(selected) => onSelectTask(selected as Task)}
                addToast={addToast}
              />
            </div>
          ))}
          {hasMore && lane === "text" && (
            <div ref={sentinelRef} className="task-search-results-sentinel" data-testid="task-search-results-sentinel" />
          )}
        </div>
        {statusMessage && (
          <p className="task-search-results-status" role="status" data-testid="task-search-results-status">
            {statusMessage}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
