import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp } from "lucide-react";
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
}

export function AlphaDesktopActionBar({ entries, activeId, tasks, projectId, columnFlagsByTaskId }: AlphaDesktopActionBarProps) {
  /* FNXC:AlphaNavigation 2026-09-12-00:36: Alpha navigation labels, including its overflow trigger and landmark, must use the shared locale catalog rather than English-only literals. */
  const { t } = useTranslation("app");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const { stats, loading, error } = useExecutorStats(tasks, projectId, columnFlagsByTaskId);
  /*
  FNXC:AlphaDesktopNavigation 2026-09-12-04:06:
  Le menu Plus du footer Alpha desktop est un seul périmètre trigger + menu : le survol ou le focus l’ouvre, une sortie complète du pointeur ou du focus le ferme, et Escape conserve une fermeture clavier explicite. Un clic sur le trigger ouvre sans toggler afin qu’une activation ne referme jamais un menu déjà ouvert au hover.
  */
  const closeAfterFocusLeaves = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) setOverflowOpen(false);
  };
  const handleOverflowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setOverflowOpen(false);
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
      if (inOverflow) void Promise.resolve(result).then((accepted) => { if (accepted !== false) setOverflowOpen(false); });
    }}>
      <span className="alpha-desktop-action-bar__icon"><Icon aria-hidden="true" />{entry.dot ? <span className={`status-dot status-dot--${entry.dot}`} /> : null}{entry.badge ? <span className="btn-badge">{entry.badge > 99 ? "99+" : entry.badge}</span> : null}</span>
      <span>{entry.label}</span>
    </button>;
  };
  /*
  FNXC:AlphaDesktopNavigation 2026-09-12-01:35:
  Alpha desktop keeps capacity at the far left as a truthful running/max label, direct destinations in the middle, More immediately after them, and Settings isolated at the far right. New Task remains owned by the Header and other standard surfaces.
  */
  return <nav className="alpha-desktop-action-bar" aria-label={t("nav.primaryNavAriaLabel", "Primary navigation")} data-testid="alpha-desktop-action-bar">
    <div className="alpha-desktop-action-bar__capacity"><EngineControlMenu projectId={projectId} triggerContent={<span data-testid="alpha-desktop-capacity-count">{capacityText}</span>} triggerLabel={capacityLabel} /></div>
    <div className="alpha-desktop-action-bar__center"><div className="alpha-desktop-action-bar__scroller">{direct.map((entry) => renderButton(entry))}</div>
    {overflow.length ? <div
      ref={overflowRef}
      className="alpha-desktop-action-bar__more"
      onPointerEnter={() => setOverflowOpen(true)}
      onPointerLeave={() => setOverflowOpen(false)}
      onFocusCapture={() => setOverflowOpen(true)}
      onBlurCapture={closeAfterFocusLeaves}
      onKeyDown={handleOverflowKeyDown}
    >
      <button type="button" className="alpha-desktop-action-bar__action" aria-label={t("header.moreViews", "More views")} aria-haspopup="menu" aria-expanded={overflowOpen} data-testid="alpha-desktop-nav-more" onClick={() => setOverflowOpen(true)}><ChevronUp aria-hidden="true" /><span>{t("nav.more", "More")}</span></button>
      {overflowOpen ? <div className="alpha-desktop-action-bar__menu" role="menu">{overflow.map((entry) => renderButton(entry, true))}</div> : null}
    </div> : null}</div>
    <div className="alpha-desktop-action-bar__settings">{settings ? renderButton(settings) : null}</div>
  </nav>;
}
