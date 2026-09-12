import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp } from "lucide-react";
import type { DashboardNavigationEntry } from "./dashboardNavigationEntries";
import "./AlphaDesktopActionBar.css";

export interface AlphaDesktopActionBarProps {
  entries: readonly DashboardNavigationEntry[];
  activeId?: string | null;
}

export function AlphaDesktopActionBar({ entries, activeId }: AlphaDesktopActionBarProps) {
  /* FNXC:AlphaNavigation 2026-09-12-00:36: Alpha navigation labels, including its overflow trigger and landmark, must use the shared locale catalog rather than English-only literals. */
  const { t } = useTranslation("app");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const direct = entries.filter((entry) => entry.placement === "direct");
  const overflow = entries.filter((entry) => entry.placement === "overflow");
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
  return <nav className="alpha-desktop-action-bar" aria-label={t("nav.primaryNavAriaLabel", "Primary navigation")} data-testid="alpha-desktop-action-bar">
    <div className="alpha-desktop-action-bar__scroller">{direct.map((entry) => renderButton(entry))}</div>
    {overflow.length ? <div className="alpha-desktop-action-bar__more">
      <button type="button" className="alpha-desktop-action-bar__action" aria-label={t("header.moreViews", "More views")} aria-haspopup="menu" aria-expanded={overflowOpen} data-testid="alpha-desktop-nav-more" onClick={() => setOverflowOpen((value) => !value)}><ChevronUp aria-hidden="true" /><span>{t("nav.more", "More")}</span></button>
      {overflowOpen ? <div className="alpha-desktop-action-bar__menu" role="menu">{overflow.map((entry) => renderButton(entry, true))}</div> : null}
    </div> : null}
  </nav>;
}
