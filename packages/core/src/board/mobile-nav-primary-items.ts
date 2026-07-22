import type { ProjectSettings } from "../types.js";

/** Destinations represented by the mobile navigation registry. */
export const MOBILE_NAV_SELECTABLE_ITEMS = [
  "command-center",
  "tasks",
  "agents",
  "missions",
  "chat",
  "mailbox",
  "planning",
  "activity",
  "git",
  "files",
  "workflows",
  "automation",
  "github-import",
  "usage",
  "projects",
  "documents",
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
  "todos",
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
  planning: "nav.planning",
  activity: "nav.activityLog",
  git: "nav.gitManager",
  files: "nav.files",
  workflows: "nav.workflows",
  automation: "nav.automation",
  "github-import": "nav.importFromGitHub",
  usage: "nav.usage",
  projects: "nav.projects",
  documents: "nav.documents",
  secrets: "nav.secrets",
  settings: "nav.settings",
  skills: "nav.skills",
  insights: "nav.insights",
  memory: "nav.memory",
  research: "nav.research",
  evals: "nav.evals",
  ideation: "nav.ideation",
  goals: "nav.goals",
  todos: "nav.todos",
  "dev-server": "nav.devServer",
};

/** Destinations that Settings may promote into the mobile footer. */
export const MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS = MOBILE_NAV_SELECTABLE_ITEMS.filter(
  (item): item is Exclude<MobileNavSelectableItem, "ideation"> => item !== "ideation",
);

export const DEFAULT_MOBILE_NAV_PRIMARY_ITEMS: MobileNavSelectableItem[] = [
  "command-center", "tasks", "agents", "missions", "chat", "mailbox",
];

export const MAX_MOBILE_NAV_PRIMARY_ITEMS = 6;

export interface ResolvedMobileNavPrimaryItems {
  primaryItems: MobileNavSelectableItem[];
  omittedItems: MobileNavSelectableItem[];
}

/*
FNXC:Navigation 2026-07-17-00:00:
Mobile footer customization includes every navigable sidebar and More-sheet destination, while Terminal,
scripts, shell controls, plugin views, separators, and `more` remain overflow-only. The resolver is gate-agnostic:
the render layer suppresses disabled experimental destinations, and More remains the separate trailing tab.
*/
export function resolveMobileNavPrimaryItems(settings?: Pick<ProjectSettings, "mobileNavPrimaryItems">): ResolvedMobileNavPrimaryItems {
  const selected = Array.isArray(settings?.mobileNavPrimaryItems) ? settings.mobileNavPrimaryItems : [];
  const valid = new Set<string>(MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS);
  const primaryItems = selected.reduce<MobileNavSelectableItem[]>((items, id) => {
    if (valid.has(id) && !items.includes(id as MobileNavSelectableItem) && items.length < MAX_MOBILE_NAV_PRIMARY_ITEMS) {
      items.push(id as MobileNavSelectableItem);
    }
    return items;
  }, []);
  const resolved = primaryItems.length > 0 ? primaryItems : [...DEFAULT_MOBILE_NAV_PRIMARY_ITEMS];
  return { primaryItems: resolved, omittedItems: MOBILE_NAV_SELECTABLE_ITEMS.filter((id) => !resolved.includes(id)) };
}
