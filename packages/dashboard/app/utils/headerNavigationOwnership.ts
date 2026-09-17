import type { ViewportMode } from "../hooks/useViewportMode";

/*
FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
FN-481 : « peu importe la taille de l'écran, si le bouton d'accès est présent dans le header à cette vue, il ne doit
pas être présent en plus dans le footer ni dans "more" ». La propriété est donc DÉRIVÉE des conditions de rendu
réelles du Header (mode + capacités effectivement passées), jamais d'une liste d'identifiants retirée globalement ni
d'une détection DOM. Ce module est la SEULE table de décision : `Header` l'utilise pour ne pas dupliquer son propre
accès, et `App` l'utilise pour dire à la navigation basse ce que son Header offre déjà. Un Header absent doit donner
une collection vide, sinon une pill isolée perdrait des destinations encore fonctionnelles.
*/
export type HeaderOwnedNavigationItem = "usage" | "projects" | "notes" | "activity";

export interface HeaderNavigationOwnershipInput {
  /** Mode de viewport mesuré ; `mobile` = téléphone, `tablet` et `desktop` partagent la disposition large. */
  mode: ViewportMode;
  /** Vrai quand la pill flottante possède la navigation primaire (shell mobile : téléphone ET tablette). */
  mobileNavEnabled?: boolean;
  /** `onOpenUsage` est réellement fourni au Header. */
  hasOpenUsage?: boolean;
  /** `onOpenNotesPanel` est réellement fourni au Header. */
  hasOpenNotesPanel?: boolean;
  /** `onOpenActivityPanel` est réellement fourni au Header. */
  hasOpenActivityPanel?: boolean;
  /** Nombre de projets proposés au Header. */
  projectCount?: number;
  /** `onSelectProject` est réellement fourni : il conditionne le montage du sélecteur compact téléphone. */
  hasSelectProject?: boolean;
  /** `onViewAllProjects` est réellement fourni : il conditionne l'action de gestion des projets. */
  hasViewAllProjects?: boolean;
}

/**
 * Destinations que le Header rend RÉELLEMENT dans les conditions décrites.
 *
 * FNXC:HeaderNavigationOwnership 2026-09-17-02:14:
 * FN-481 : critères exacts, alignés un pour un sur les branches de rendu de `Header.tsx`.
 * - `usage` : bouton direct hors téléphone (`header-usage-btn`) avec son callback, ou raccourci téléphone
 *   (`mobile-header-usage-btn`) quand la pill possède la navigation. Le Header historique sans pill n'offre Usage
 *   que dans son menu de débordement, donc il n'en est pas propriétaire.
 * - `notes` / `activity` : uniquement hors téléphone, avec leur callback de panneau (FN-437 a supprimé ces
 *   déclencheurs sur téléphone, où la navigation basse reste l'unique propriétaire).
 * - `projects` : au moins un projet proposé ET l'action de gestion atteignable. Sur téléphone le sélecteur compact
 *   exige en plus `onSelectProject` ; hors téléphone le sélecteur complet dépend de `onViewAllProjects`.
 *
 * Fonction PURE : aucun accès DOM, aucun état persistant, aucun effet de bord sur les réglages.
 */
export function resolveHeaderNavigationOwnership({
  mode,
  mobileNavEnabled = false,
  hasOpenUsage = false,
  hasOpenNotesPanel = false,
  hasOpenActivityPanel = false,
  projectCount = 0,
  hasSelectProject = false,
  hasViewAllProjects = false,
}: HeaderNavigationOwnershipInput): HeaderOwnedNavigationItem[] {
  const isPhone = mode === "mobile";
  const owned: HeaderOwnedNavigationItem[] = [];

  const ownsUsage = hasOpenUsage && (isPhone ? Boolean(mobileNavEnabled) : true);
  if (ownsUsage) owned.push("usage");

  const hasProjectOffer = (Number.isFinite(projectCount) ? projectCount : 0) >= 1;
  const ownsProjects = hasProjectOffer && hasViewAllProjects && (isPhone ? hasSelectProject : true);
  if (ownsProjects) owned.push("projects");

  if (!isPhone && hasOpenNotesPanel) owned.push("notes");
  if (!isPhone && hasOpenActivityPanel) owned.push("activity");

  return owned;
}
