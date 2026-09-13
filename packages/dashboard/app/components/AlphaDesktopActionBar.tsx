import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, Terminal } from "lucide-react";
import type { Task } from "@fusion/core";
import type { ExecutorColumnFlags } from "../hooks/useExecutorStats";
import { useExecutorStats } from "../hooks/useExecutorStats";
import { EngineControlMenu } from "./EngineControlMenu";
import type { DashboardNavigationEntry } from "./dashboardNavigationEntries";
import "./AlphaDesktopActionBar.css";

export interface AlphaDesktopActionBarProps {
  entries: readonly DashboardNavigationEntry[];
  activeId?: string | null;
  tasks: Task[];
  projectId?: string;
  columnFlagsByTaskId?: ReadonlyMap<string, ExecutorColumnFlags>;
  onToggleTerminal?: () => void;
}

const MORE_MENU_CLOSE_GRACE_MS = 150;

export function AlphaDesktopActionBar({ entries, activeId, tasks, projectId, columnFlagsByTaskId, onToggleTerminal }: AlphaDesktopActionBarProps) {
  /* FNXC:AlphaNavigation 2026-09-12-00:36: Alpha navigation labels, including its overflow trigger and landmark, must use the shared locale catalog rather than English-only literals. */
  const { t } = useTranslation("app");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { stats, loading, error } = useExecutorStats(tasks, projectId, columnFlagsByTaskId);
  /*
  FNXC:AlphaDesktopNavigation 2026-09-13-04:10:
  Le menu More du footer Alpha partagé par tablette et ordinateur forme un seul périmètre trigger + panneau. Une sortie du pointeur démarre une courte grâce annulable afin que les traversées lentes du corridor ne ferment pas le panneau; focus, Escape et sélection acceptée conservent leurs fermetures explicites.
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
    return <button key={entry.id} type="button" className={`alpha-desktop-action-bar__action${active ? " alpha-desktop-action-bar__action--active" : ""}`} aria-label={entry.label} aria-current={active && entry.kind === "main-page" ? "page" : undefined} data-testid={entry.testId} onClick={() => {
      const result = entry.onSelect?.();
      if (inOverflow) void Promise.resolve(result).then((accepted) => { if (accepted !== false) closeOverflow(); });
    }}>
      <span className="alpha-desktop-action-bar__icon"><Icon aria-hidden="true" />{entry.dot ? <span className={`status-dot status-dot--${entry.dot}`} /> : null}{entry.badge ? <span className="btn-badge">{entry.badge > 99 ? "99+" : entry.badge}</span> : null}</span>
      <span>{entry.label}</span>
    </button>;
  };
  /*
  FNXC:AlphaDesktopNavigation 2026-09-13-02:40:
  The wide Alpha footer shared by tablet and desktop keeps capacity at the far left, navigation in the middle, and its optional Terminal action immediately left of the single retained Settings action. Scripts remain on their existing owners, and omitting both right-side actions must leave no empty action-group shell.
  */
  return <nav className="alpha-desktop-action-bar" aria-label={t("nav.primaryNavAriaLabel", "Primary navigation")} data-testid="alpha-desktop-action-bar">
    <div className="alpha-desktop-action-bar__capacity"><EngineControlMenu projectId={projectId} triggerContent={<span data-testid="alpha-desktop-capacity-count">{capacityText}</span>} triggerLabel={capacityLabel} /></div>
    <div className="alpha-desktop-action-bar__center"><div className="alpha-desktop-action-bar__scroller">{direct.map((entry) => renderButton(entry))}</div>
    {overflow.length ? <div
      ref={overflowRef}
      className="alpha-desktop-action-bar__more"
      onPointerEnter={openOverflow}
      onPointerLeave={scheduleOverflowClose}
      onFocusCapture={openOverflow}
      onBlurCapture={closeAfterFocusLeaves}
      onKeyDown={handleOverflowKeyDown}
    >
      <button type="button" className="alpha-desktop-action-bar__action" aria-label={t("header.moreViews", "More views")} aria-haspopup="menu" aria-expanded={overflowOpen} data-testid="alpha-desktop-nav-more" onClick={openOverflow}><ChevronUp aria-hidden="true" /><span>{t("nav.more", "More")}</span></button>
      {overflowOpen ? <div className="alpha-desktop-action-bar__menu" role="menu">{overflow.map((entry) => renderButton(entry, true))}</div> : null}
    </div> : null}</div>
    {onToggleTerminal || settings ? <div className="alpha-desktop-action-bar__right">
      {onToggleTerminal ? <button type="button" className="alpha-desktop-action-bar__action" aria-label={t("nav.terminal", "Terminal")} data-testid="alpha-desktop-nav-terminal" onClick={onToggleTerminal}>
        <span className="alpha-desktop-action-bar__icon"><Terminal aria-hidden="true" /></span>
        <span>{t("nav.terminal", "Terminal")}</span>
      </button> : null}
      {settings ? renderButton(settings) : null}
    </div> : null}
  </nav>;
}
