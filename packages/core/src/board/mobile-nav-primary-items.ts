import type { ProjectSettings } from "../types.js";

/** Destinations represented by the mobile navigation registry. */
export const MOBILE_NAV_SELECTABLE_ITEMS = [
  "command-center",
  "tasks",
  "agents",
  "missions",
  "chat",
  "mailbox",
  "patchnode",
  "planning",
  "activity",
  "git",
  "files",
  "workflows",
  "automation",
  "github-import",
  "usage",
  "projects",
  "notes",
  "whiteboard",
  "secrets",
  "settings",
  "skills",
  "insights",
  "memory",
  "research",
  "evals",
  /*
  FNXC:Navigation 2026-08-01-00:00:
  FN-8352 makes Ideation a top-level experimental destination, but it remains
  More-only on mobile. Keep it registered for labels and More rendering while
  excluding it from the footer-promotion registry below.
  */
  "ideation",
  "goals",
  "dev-server",
] as const;

export type MobileNavSelectableItem = (typeof MOBILE_NAV_SELECTABLE_ITEMS)[number];

/** Stable i18n keys for settings controls that list selectable destinations. */
export const MOBILE_NAV_SELECTABLE_ITEM_LABEL_KEYS: Record<MobileNavSelectableItem, string> = {
  "command-center": "nav.commandCenter",
  tasks: "nav.tasks",
  agents: "nav.agents",
  missions: "nav.missions",
  chat: "nav.chat",
  mailbox: "nav.mailbox",
  patchnode: "nav.patchnode",
  planning: "nav.planning",
  activity: "nav.activityLog",
  git: "nav.gitManager",
  files: "nav.files",
  workflows: "nav.workflows",
  automation: "nav.automation",
  "github-import": "nav.importFromGitHub",
  usage: "nav.usage",
  projects: "nav.projects",
  notes: "nav.notes",
  whiteboard: "nav.whiteboard",
  secrets: "nav.secrets",
  settings: "nav.settings",
  skills: "nav.skills",
  insights: "nav.insights",
  memory: "nav.memory",
  research: "nav.research",
  evals: "nav.evals",
  ideation: "nav.ideation",
  goals: "nav.goals",
  "dev-server": "nav.devServer",
};

/*
FNXC:Navigation 2026-09-16-04:15:
FN-446 réutilise la clé projet `mobileNavPrimaryItems` (aucune migration, aucune nouvelle clé) pour piloter la rangée
d'accès rapide de la barre de navigation partagée tablette/ordinateur, et plus seulement un libellé « mobile ».
Une destination n'est donc promouvable que si elle possède une entrée correspondante dans le registre de navigation
du pied de page : cette table est la source de vérité unique (identifiant persisté → identifiant d'entrée du registre),
et `MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS` en est dérivé. Les destinations sans entrée de pied de page (`notes`,
`secrets`, `settings`, `patchnode`, `activity`, `usage`, `projects`, `ideation`) deviennent non éligibles : elles
restent atteignables par leurs propriétaires existants (barre latérale, feuille « More » mobile, right dock, Réglages)
mais ne peuvent plus revendiquer un accès rapide qui n'existerait nulle part.
*/
export const MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS = {
  "command-center": "command-center",
  tasks: "board",
  chat: "chat",
  agents: "agents",
  missions: "missions",
  mailbox: "mailbox",
  planning: "planning",
  files: "files",
  git: "git-manager",
  workflows: "workflows",
  automation: "automations",
  "github-import": "import-tasks",
  skills: "skills",
  memory: "memory",
  whiteboard: "whiteboard",
  goals: "goals",
  insights: "insights",
  research: "research",
  evals: "evals",
  "dev-server": "dev-server",
} as const satisfies Partial<Record<MobileNavSelectableItem, string>>;

export type MobileNavPrimarySelectableItem = keyof typeof MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS;

/** Destinations that Settings may promote into the shared quick-access row. */
export const MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS = MOBILE_NAV_SELECTABLE_ITEMS.filter(
  (item): item is MobileNavPrimarySelectableItem => item in MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS,
);

/*
FNXC:Navigation 2026-09-17-16:53:
FN-511 renverse la décision de FN-495 : le cinquième créneau du pied de page est CONFIGURABLE et `chat` y est une
destination ordinaire. Trois invariants remplacent l'ancienne protection « chat non configurable » :
(1) `chat` est éligible comme n'importe quelle autre destination — il entre dans
    `MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS`, donc l'opérateur peut le placer n'importe où parmi les cinq
    créneaux, ou l'exclure complètement du pied de page ;
(2) le résolveur COMPLÈTE toute sélection valide jusqu'au plafond de cinq en puisant, dans l'ordre et sans doublon,
    dans `DEFAULT_MOBILE_NAV_PRIMARY_ITEMS` qui se termine par `chat`. Une valeur persistée de quatre destinations
    (l'état d'avant cette tâche) rend donc toujours le Chat en cinquième position : la mise à jour est transparente
    sans migration de données ni seconde clé de réglage, et le seul moyen d'exclure le Chat du pied de page est de
    définir cinq destinations explicites ;
(3) une destination résolue ne peut jamais figurer aussi dans `omittedItems` (celui-ci est strictement le complément
    de la rangée résolue), donc aucune destination n'est rendue deux fois sur un même hôte : rangée directe OU menu
    « Plus », jamais les deux.
`tasks` est l'identifiant persisté historique du Board.
*/
export const DEFAULT_MOBILE_NAV_PRIMARY_ITEMS: MobileNavSelectableItem[] = [
  "command-center", "tasks", "planning", "missions", "chat",
];

export const MAX_MOBILE_NAV_PRIMARY_ITEMS = 5;

export interface ResolvedMobileNavPrimaryItems {
  primaryItems: MobileNavSelectableItem[];
  omittedItems: MobileNavSelectableItem[];
}

/*
FNXC:Navigation 2026-07-17-00:00:
Mobile footer customization includes every navigable sidebar and More-sheet destination, while Terminal,
scripts, shell controls, plugin views, separators, and `more` remain overflow-only. The resolver is gate-agnostic:
the render layer suppresses disabled experimental destinations, and More remains the separate trailing tab.

FNXC:MailboxNavigation 2026-09-09-20:02:
Standalone Artifacts and Recommendations navigation is retired in favor of Mailbox categories. Normalize either legacy persisted mobile preference to Mailbox and deduplicate it so upgrades preserve a reachable footer choice.
*/
export function resolveMobileNavPrimaryItems(settings?: Pick<ProjectSettings, "mobileNavPrimaryItems">): ResolvedMobileNavPrimaryItems {
  const selected = Array.isArray(settings?.mobileNavPrimaryItems) ? settings.mobileNavPrimaryItems : [];
  const valid = new Set<string>(MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS);
  const primaryItems = selected.reduce<MobileNavSelectableItem[]>((items, persistedId) => {
    const id = persistedId === "documents" || persistedId === "recommendations" ? "mailbox" : persistedId;
    if (valid.has(id) && !items.includes(id as MobileNavSelectableItem) && items.length < MAX_MOBILE_NAV_PRIMARY_ITEMS) {
      items.push(id as MobileNavSelectableItem);
    }
    return items;
  }, []);
  /*
  FNXC:Navigation 2026-09-17-16:53:
  FN-511 : complément SYSTÉMATIQUE, et non plus repli réservé à la sélection vide. Toute sélection valide plus courte
  que le plafond est complétée par les destinations par défaut manquantes, sans doublon, jusqu'à exactement cinq.
  Le choix des destinations de complément privilégie la FIN de l'ordre par défaut, qui se termine par `chat`, parce que
  la raison d'être de ce complément est précisément de préserver le Chat tout à droite du pied de page pour les
  opérateurs ayant déjà personnalisé quatre raccourcis avant cette tâche (mise à jour transparente, sans migration ni
  seconde clé). Les destinations retenues sont ensuite ajoutées dans l'ordre par défaut, donc une sélection vide rend
  exactement `DEFAULT_MOBILE_NAV_PRIMARY_ITEMS`. Le complément est purement au rendu : la valeur persistée de
  l'opérateur n'est jamais réécrite, et le seul moyen d'exclure `chat` du pied de page est de définir cinq
  destinations explicites.
  */
  const missingDefaults = DEFAULT_MOBILE_NAV_PRIMARY_ITEMS.filter((item) => !primaryItems.includes(item));
  const completionCount = Math.max(0, MAX_MOBILE_NAV_PRIMARY_ITEMS - primaryItems.length);
  const resolved = [...primaryItems, ...missingDefaults.slice(Math.max(0, missingDefaults.length - completionCount))];
  return { primaryItems: resolved, omittedItems: MOBILE_NAV_SELECTABLE_ITEMS.filter((id) => !resolved.includes(id)) };
}

/*
FNXC:Navigation 2026-09-16-04:15:
FN-446 : identifiants d'entrées du registre de navigation à placer en accès direct, dans l'ordre persisté. Le résolveur
existant conserve toute la normalisation (valeurs héritées `documents`/`recommendations` → `mailbox`, déduplication,
plafond, repli sur le défaut) ; cette fonction ne fait que traduire le résultat vers les identifiants du registre.
*/
export function resolveNavigationQuickAccessEntryIds(settings?: Pick<ProjectSettings, "mobileNavPrimaryItems">): string[] {
  return resolveMobileNavPrimaryItems(settings).primaryItems.reduce<string[]>((entryIds, item) => {
    const entryId = (MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS as Partial<Record<MobileNavSelectableItem, string>>)[item];
    if (entryId && !entryIds.includes(entryId)) entryIds.push(entryId);
    return entryIds;
  }, []);
}
