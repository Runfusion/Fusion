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
et `MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS` en est dérivé. Les destinations sans entrée de pied de page (`chat`, `notes`,
`secrets`, `settings`, `patchnode`, `activity`, `usage`, `projects`, `ideation`) deviennent non éligibles : elles
restent atteignables par leurs propriétaires existants (barre latérale, feuille « More » mobile, right dock, Réglages)
mais ne peuvent plus revendiquer un accès rapide qui n'existerait nulle part.
*/
export const MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS = {
  "command-center": "command-center",
  tasks: "board",
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
FNXC:Navigation 2026-09-17-08:05:
FN-495 : le défaut est Dashboard, Board, Planning, Missions et le plafond est 4, pas 5. La rangée du pied de page
compte toujours un bouton « More » final, mais le cinquième créneau appartient désormais au **Chat**, qui reste
volontairement NON configurable : sur le footer partagé tablette/ordinateur c'est le bouton `desktop-nav-chat-panel`
du groupe de droite, et sur le shell mobile c'est la ligne « Chat » du menu « Plus » plus le geste de glissement du
pied de page vers le haut. `chat` reste donc délibérément hors de `MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS` et
de `MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS` : aucune nouvelle éligibilité, aucune clé de réglage, aucune migration.
Une sélection persistée de cinq identifiants est simplement tronquée par le résolveur ci-dessous ; la cinquième
destination bascule dans `omittedItems`, donc elle reste atteignable depuis « Plus ».
`tasks` est l'identifiant persisté historique du Board.
*/
export const DEFAULT_MOBILE_NAV_PRIMARY_ITEMS: MobileNavSelectableItem[] = [
  "command-center", "tasks", "planning", "missions",
];

export const MAX_MOBILE_NAV_PRIMARY_ITEMS = 4;

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
  const resolved = primaryItems.length > 0 ? primaryItems : [...DEFAULT_MOBILE_NAV_PRIMARY_ITEMS];
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
