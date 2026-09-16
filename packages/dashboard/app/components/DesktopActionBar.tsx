import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, MessageSquare, Terminal } from "lucide-react";
import type { Task } from "@fusion/core";
import type { ExecutorColumnFlags } from "../hooks/useExecutorStats";
import { useExecutorStats } from "../hooks/useExecutorStats";
import { EngineControlMenu } from "./EngineControlMenu";
import type { DashboardNavigationEntry } from "./dashboardNavigationEntries";
import "./DesktopActionBar.css";
import { useDashboardWindowLandmark } from "../context/DashboardWindowManagerContext";
import { DashboardWindowVisibilityToggle } from "./DashboardWindowVisibilityToggle";

export interface DesktopActionBarProps {
  entries: readonly DashboardNavigationEntry[];
  activeId?: string | null;
  tasks: Task[];
  projectId?: string;
  columnFlagsByTaskId?: ReadonlyMap<string, ExecutorColumnFlags>;
  onToggleTerminal?: () => void;
  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  FN-426: the bottom bar owns the Chat entry point. It opens the conversation LIST as an anchored panel; picking or
  creating a conversation hands off to the existing project-scoped window owner, so the footer never becomes a second
  transcript host. The bar supplies only the trigger and its anchor rect.
  */
  onOpenChatPanel?: (anchorRect: DOMRect | null) => void;
  chatPanelOpen?: boolean;
  chatPanelId?: string;
  chatHasUnreadResponse?: boolean;
}

const MORE_MENU_CLOSE_GRACE_MS = 150;

export function DesktopActionBar({ entries, activeId, tasks, projectId, columnFlagsByTaskId, onToggleTerminal, onOpenChatPanel, chatPanelOpen = false, chatPanelId, chatHasUnreadResponse = false }: DesktopActionBarProps) {
  /* FNXC:NativeNavigation 2026-09-12-00:36: Navigation labels, including its overflow trigger and landmark, must use the shared locale catalog rather than English-only literals. */
  const { t } = useTranslation("app");
  const dashboardWindowFooterRef = useDashboardWindowLandmark("footer");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { stats, loading, error } = useExecutorStats(tasks, projectId, columnFlagsByTaskId);
  /*
  FNXC:DesktopNavigation 2026-09-13-04:10:
  Le menu More du footer partagé par tablette et ordinateur forme un seul périmètre trigger + panneau. Une sortie du pointeur démarre une courte grâce annulable afin que les traversées lentes du corridor ne ferment pas le panneau; focus, Escape et sélection acceptée conservent leurs fermetures explicites.

  FNXC:DesktopNavigation 2026-09-15-19:42:
  FN-432: l'OUVERTURE au pointeur appartient exclusivement au bouton More. Le périmètre (trigger + corridor + panneau) ne
  porte plus que l'ANNULATION de la fermeture différée, sinon survoler le corridor invisible situé au-dessus du bouton
  ouvrait le menu sans jamais survoler More. Le corridor reste indispensable à la traversée bouton → liste, mais il est
  inerte (`pointer-events: none`) tant que le menu est fermé; il n'est réactivé que sous `desktop-action-bar__more--open`.
  */
  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const closeOverflow = useCallback(() => {
    cancelScheduledClose();
    setOverflowOpen(false);
  }, [cancelScheduledClose]);
  const openOverflow = useCallback(() => {
    cancelScheduledClose();
    setOverflowOpen(true);
  }, [cancelScheduledClose]);
  const scheduleOverflowClose = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOverflowOpen(false);
    }, MORE_MENU_CLOSE_GRACE_MS);
  }, [cancelScheduledClose]);
  useEffect(() => cancelScheduledClose, [cancelScheduledClose]);
  const closeAfterFocusLeaves = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) closeOverflow();
  };
  const handleOverflowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeOverflow();
  };
  const direct = entries.filter((entry) => entry.placement === "direct");
  const overflow = entries.filter((entry) => entry.placement === "overflow");
  const settings = entries.find((entry) => entry.id === "settings");
  const capacityText = loading ? t("commandCenter.controls.status.loading", "Loading…") : error ? t("commandCenter.controls.concurrency.error", "Unable to load concurrency settings") : `${stats.runningTaskCount} / ${stats.maxConcurrent}`;
  const capacityLabel = `${t("executor.engineControls", "Engine controls")}: ${capacityText}`;
  const renderButton = (entry: DashboardNavigationEntry, inOverflow = false) => {
    const Icon = entry.icon;
    const active = entry.id === activeId;
    return <button key={entry.id} type="button" className={`desktop-action-bar__action${active ? " desktop-action-bar__action--active" : ""}`} aria-label={entry.label} aria-current={active && entry.kind === "main-page" ? "page" : undefined} data-testid={entry.testId} onClick={() => {
      const result = entry.onSelect?.();
      if (inOverflow) void Promise.resolve(result).then((accepted) => { if (accepted !== false) closeOverflow(); });
    }}>
      <span className="desktop-action-bar__icon"><Icon aria-hidden="true" />{entry.dot ? <span className={`status-dot status-dot--${entry.dot}`} /> : null}{entry.badge ? <span className="btn-badge">{entry.badge > 99 ? "99+" : entry.badge}</span> : null}</span>
      <span>{entry.label}</span>
    </button>;
  };
  /*
  FNXC:DesktopNavigation 2026-09-13-02:40:
  The wide footer shared by tablet and desktop keeps capacity at the far left, navigation in the middle, and its optional Terminal action immediately left of the single retained Settings action. Scripts remain on their existing owners, and omitting both right-side actions must leave no empty action-group shell.
  */
  /*
  FNXC:PopoverLayering 2026-09-15-09:31:
  FN-413: while the More menu is OPEN the footer must outrank every dashboard-managed window, so the bar carries an
  open modifier. The elevation belongs to the BAR, not the menu: `.desktop-action-bar` declares `z-index: var(--z-sticky)`
  and therefore owns a stacking context its absolutely positioned child can never escape. At rest the bar stays on the
  sticky token so a closed footer never dominates windows. Driven strictly by `overflowOpen`; no other behavior changes.
  */
  return <nav ref={dashboardWindowFooterRef} className={`desktop-action-bar${overflowOpen ? " desktop-action-bar--menu-open" : ""}`} aria-label={t("nav.primaryNavAriaLabel", "Primary navigation")} data-testid="desktop-action-bar">
    <div className="desktop-action-bar__capacity"><EngineControlMenu projectId={projectId} triggerContent={<span data-testid="desktop-capacity-count">{capacityText}</span>} triggerLabel={capacityLabel} /></div>
    {/*
    FNXC:DesktopNavigation 2026-09-16-04:15:
    FN-446: the direct row is the operator-configured quick-access selection, so it can legitimately resolve to nothing
    (every chosen destination gated off). Guard the scroller like the More perimeter already guards itself, so removing
    destinations never leaves an empty row shell behind.
    */}
    <div className="desktop-action-bar__center">{direct.length ? <div className="desktop-action-bar__scroller">{direct.map((entry) => renderButton(entry))}</div> : null}
    {overflow.length ? <div
      ref={overflowRef}
      className={`desktop-action-bar__more${overflowOpen ? " desktop-action-bar__more--open" : ""}`}
      onPointerEnter={cancelScheduledClose}
      onPointerLeave={scheduleOverflowClose}
      onFocusCapture={openOverflow}
      onBlurCapture={closeAfterFocusLeaves}
      onKeyDown={handleOverflowKeyDown}
    >
      <button type="button" className="desktop-action-bar__action" aria-label={t("header.moreViews", "More views")} aria-haspopup="menu" aria-expanded={overflowOpen} data-testid="desktop-nav-more" onPointerEnter={openOverflow} onClick={openOverflow}><ChevronUp aria-hidden="true" /><span>{t("nav.more", "More")}</span></button>
      {overflowOpen ? <div className="desktop-action-bar__menu" role="menu">{overflow.map((entry) => renderButton(entry, true))}</div> : null}
    </div> : null}</div>
    {onOpenChatPanel || onToggleTerminal || settings ? <div className="desktop-action-bar__right">
      {onOpenChatPanel ? <button
        type="button"
        className={`desktop-action-bar__action${chatPanelOpen ? " desktop-action-bar__action--active" : ""}`}
        aria-label={t("nav.chat", "Chat")}
        aria-haspopup="dialog"
        aria-expanded={chatPanelOpen}
        aria-controls={chatPanelOpen ? chatPanelId : undefined}
        data-testid="desktop-nav-chat-panel"
        onClick={(event) => onOpenChatPanel(event.currentTarget.getBoundingClientRect())}
      >
        <span className="desktop-action-bar__icon"><MessageSquare aria-hidden="true" />{chatHasUnreadResponse && !chatPanelOpen ? <span className="status-dot status-dot--pending" /> : null}</span>
        <span>{t("nav.chat", "Chat")}</span>
      </button> : null}
      {onToggleTerminal ? <button type="button" className="desktop-action-bar__action" aria-label={t("nav.terminal", "Terminal")} data-testid="desktop-nav-terminal" onClick={onToggleTerminal}>
        <span className="desktop-action-bar__icon"><Terminal aria-hidden="true" /></span>
        <span>{t("nav.terminal", "Terminal")}</span>
      </button> : null}
      {settings ? renderButton(settings) : null}
    </div> : null}
    <DashboardWindowVisibilityToggle />
  </nav>;
}
