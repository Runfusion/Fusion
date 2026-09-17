import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, Terminal } from "lucide-react";
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
}

const MORE_MENU_CLOSE_GRACE_MS = 150;

export function DesktopActionBar({ entries, activeId, tasks, projectId, columnFlagsByTaskId, onToggleTerminal }: DesktopActionBarProps) {
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
  /*
  FNXC:DesktopNavigation 2026-09-17-16:53:
  FN-511 : les cinq créneaux d'accès rapide sont configurables et partagés à l'identique avec la pill mobile. Cette
  barre rend les QUATRE premiers au centre (scroller + déclencheur More) et le CINQUIÈME, quel qu'il soit, dans la
  piste de droite — l'emplacement qu'occupait le bouton Chat codé en dur, désormais supprimé. Le plafond vaut 5 parce
  que c'est le nombre d'emplacements que la barre peut rendre : quatre au centre plus celui de droite. Quand la
  sélection résolue produit moins de cinq entrées rendables (gates), la piste de droite se limite au Terminal ; sans
  l'un ni l'autre elle n'est pas rendue du tout, donc aucune coquille vide ne subsiste.
  */
  const CENTER_DIRECT_SLOTS = 4;
  const centerDirect = direct.slice(0, CENTER_DIRECT_SLOTS);
  const trailingDirect = direct.length > CENTER_DIRECT_SLOTS ? direct[CENTER_DIRECT_SLOTS] : undefined;
  /*
  FNXC:DesktopNavigation 2026-09-16-18:31:
  FN-469: the operator asked to remove Settings from the bottom-right corner, put it in the More list, and add an
  icon-only Settings action next to the concurrency counter. Settings keeps `placement: "external"` in the shared
  registry ("the host decides"), so the left sidebar and the mobile bar are untouched; only THIS bar's composition
  changes. `find` also makes a duplicated `settings` entry render exactly one icon button and one More row.
  */
  const overflow = entries.filter((entry) => entry.placement === "overflow");
  const settings = entries.find((entry) => entry.id === "settings");
  const overflowEntries = settings ? [...overflow, settings] : overflow;
  const capacityText = loading ? t("commandCenter.controls.status.loading", "Loading…") : error ? t("commandCenter.controls.concurrency.error", "Unable to load concurrency settings") : `${stats.runningTaskCount} / ${stats.maxConcurrent}`;
  const capacityLabel = `${t("executor.engineControls", "Engine controls")}: ${capacityText}`;
  /*
  FNXC:DesktopNavigation 2026-09-17-16:53:
  FN-511 : le rendu honore les champs d'accessibilité GÉNÉRIQUES du registre (`active`, `ariaHasPopup`, `ariaExpanded`,
  `ariaControls`). C'est ce qui permet à une entrée qui ouvre une surface plutôt qu'une page — le Chat aujourd'hui — de
  conserver exactement son contrat d'accessibilité où que l'hôte la rende : rangée centrale, piste de droite ou menu.
  */
  const renderButton = (entry: DashboardNavigationEntry, inOverflow = false) => {
    const Icon = entry.icon;
    const active = entry.id === activeId || Boolean(entry.active);
    return <button key={entry.id} type="button" className={`desktop-action-bar__action${active ? " desktop-action-bar__action--active" : ""}`} aria-label={entry.label} aria-current={active && entry.kind === "main-page" ? "page" : undefined} aria-haspopup={entry.ariaHasPopup} aria-expanded={entry.ariaExpanded} aria-controls={entry.ariaControls} data-testid={entry.testId} onClick={() => {
      const result = entry.onSelect?.();
      if (inOverflow) void Promise.resolve(result).then((accepted) => { if (accepted !== false) closeOverflow(); });
    }}>
      <span className="desktop-action-bar__icon"><Icon aria-hidden="true" />{entry.dot ? <span className={`status-dot status-dot--${entry.dot}`} /> : null}{entry.badge ? <span className="btn-badge">{entry.badge > 99 ? "99+" : entry.badge}</span> : null}</span>
      <span>{entry.label}</span>
    </button>;
  };
  /*
  FNXC:DesktopNavigation 2026-09-16-23:05:
  FN-489 inverse l'ordre posé par FN-469 dans la piste de début du footer partagé tablette/ordinateur : l'opérateur veut
  le bouton réglages en icône seule « tout à gauche dans le coin », donc il est rendu EN PREMIER et le compteur de
  concurrence le suit. Le coin est obtenu par l'ORDRE seul — `.desktop-action-bar__leading` conserve `grid-column: 1`
  et `justify-self: start`, et le `padding-inline` symétrique de la barre (FN-467, territoire de FN-484 à droite) n'est
  pas touché. Navigation au centre, groupe de droite limité aux actions optionnelles Chat et Terminal. Settings reste
  atteignable par l'icône de la piste de début et comme DERNIÈRE entrée du menu More ; les deux rendus de la piste
  restent conditionnels, donc aucun des deux ne laisse de coquille vide quand son propriétaire est absent.
  */
  /*
  FNXC:PopoverLayering 2026-09-15-09:31:
  FN-413: while the More menu is OPEN the footer must outrank every dashboard-managed window, so the bar carries an
  open modifier. The elevation belongs to the BAR, not the menu: `.desktop-action-bar` declares `z-index: var(--z-sticky)`
  and therefore owns a stacking context its absolutely positioned child can never escape. At rest the bar stays on the
  sticky token so a closed footer never dominates windows. Driven strictly by `overflowOpen`; no other behavior changes.
  */
  return <nav ref={dashboardWindowFooterRef} className={`desktop-action-bar${overflowOpen ? " desktop-action-bar--menu-open" : ""}`} aria-label={t("nav.primaryNavAriaLabel", "Primary navigation")} data-testid="desktop-action-bar">
    <div className="desktop-action-bar__leading">
      {/*
      FNXC:DesktopNavigation 2026-09-16-23:05:
      FN-489: l'action Settings en icône seule est le PREMIER enfant de la piste de début, donc collée au bord
      inline-start de la barre ; le compteur de concurrence la suit immédiatement. Elle réutilise
      `.desktop-action-bar__action` et `.desktop-action-bar__icon` plutôt que de forker une variante de bouton, porte le
      libellé de l'entrée comme nom accessible (aucune nouvelle clé i18n) et n'est rendue QUE si l'entrée existe, donc
      aucune coquille vide n'est laissée derrière.
      */}
      {settings ? <button
        type="button"
        className="desktop-action-bar__action desktop-action-bar__action--icon-only"
        aria-label={settings.label}
        data-testid="desktop-nav-settings-icon"
        onClick={() => { void settings.onSelect?.(); }}
      >
        <span className="desktop-action-bar__icon"><settings.icon aria-hidden="true" /></span>
      </button> : null}
      {/*
      FNXC:DesktopCapacity 2026-09-16-23:05:
      FN-489: le compteur ne doit plus se peindre comme une dalle `.btn` qui se remplit au survol, mais comme les autres
      boutons et le déclencheur More de cette barre. On RÉUTILISE donc `.desktop-action-bar__action` via
      `triggerClassName` au lieu de recopier ses déclarations dans une règle locale : toute évolution future de la
      peinture de la barre suit mécaniquement. Le comportement (popover, ancrage viewport-safe, libellés) est inchangé.
      */}
      <div className="desktop-action-bar__capacity"><EngineControlMenu projectId={projectId} triggerClassName="desktop-action-bar__action" triggerContent={<span data-testid="desktop-capacity-count">{capacityText}</span>} triggerLabel={capacityLabel} /></div>
    </div>
    {/*
    FNXC:DesktopNavigation 2026-09-16-04:15:
    FN-446: the direct row is the operator-configured quick-access selection, so it can legitimately resolve to nothing
    (every chosen destination gated off). Guard the scroller like the More perimeter already guards itself, so removing
    destinations never leaves an empty row shell behind.
    */}
    <div className="desktop-action-bar__center">{centerDirect.length ? <div className="desktop-action-bar__scroller">{centerDirect.map((entry) => renderButton(entry))}</div> : null}
    {overflowEntries.length ? <div
      ref={overflowRef}
      className={`desktop-action-bar__more${overflowOpen ? " desktop-action-bar__more--open" : ""}`}
      onPointerEnter={cancelScheduledClose}
      onPointerLeave={scheduleOverflowClose}
      onFocusCapture={openOverflow}
      onBlurCapture={closeAfterFocusLeaves}
      onKeyDown={handleOverflowKeyDown}
    >
      <button type="button" className="desktop-action-bar__action" aria-label={t("header.moreViews", "More views")} aria-haspopup="menu" aria-expanded={overflowOpen} data-testid="desktop-nav-more" onPointerEnter={openOverflow} onClick={openOverflow}><ChevronUp aria-hidden="true" /><span>{t("nav.more", "More")}</span></button>
      {overflowOpen ? <div className="desktop-action-bar__menu" role="menu">{overflowEntries.map((entry) => renderButton(entry, true))}</div> : null}
    </div> : null}</div>
    {/*
    FNXC:DesktopNavigation 2026-09-17-16:53:
    FN-511 : la piste de droite rend le DERNIER raccourci résolu, quel qu'il soit — le Chat par défaut, Planning si
    l'opérateur le place en cinquième position — puis le Terminal. Le Chat n'a plus de producteur codé en dur ici : il
    arrive par `entries`, donc il est rendu exactement une fois sur cet hôte. Cette barre n'adopte pas le geste tactile
    du shell mobile : le pied de page large n'est pas glissable.
    */}
    {trailingDirect || onToggleTerminal ? <div className="desktop-action-bar__right">
      {trailingDirect ? renderButton(trailingDirect) : null}
      {onToggleTerminal ? <button type="button" className="desktop-action-bar__action" aria-label={t("nav.terminal", "Terminal")} data-testid="desktop-nav-terminal" onClick={onToggleTerminal}>
        <span className="desktop-action-bar__icon"><Terminal aria-hidden="true" /></span>
        <span>{t("nav.terminal", "Terminal")}</span>
      </button> : null}
    </div> : null}
    <DashboardWindowVisibilityToggle />
  </nav>;
}
