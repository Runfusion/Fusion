/**
 * Execution modes, planner oversight, theme, and locale domain types.
 *
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Extracted from types.ts; re-exported from the browser-safe types barrel.
 */

/**
 * Dashboard high-fan-out blocker threshold. A blocker is considered high impact
 * when at least this many active todo tasks are waiting on it.
 */
export const HIGH_FANOUT_BLOCKER_TODO_THRESHOLD = 5;

/**
 * Default age gate (ms) before a high fan-out blocker is escalated in dashboards.
 */
export const STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/**
 * Execution mode for task implementation.
 * Controls how the executor agent approaches the task:
 * - "standard": Full execution with complete review workflow (default)
 * - "fast": Expedited execution with minimal overhead for simple tasks
 */
export const EXECUTION_MODES = ["standard", "fast"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Default execution mode for new tasks */
export const DEFAULT_EXECUTION_MODE: ExecutionMode = "standard";

/*
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * Per-task override of the workflow-native `plannerOversightLevel` setting
 * (declared in `BUILTIN_OVERSIGHT_SETTINGS`, packages/core/src/builtin-workflow-settings.ts).
 * When a task sets this field, it wins over the workflow's effective oversight
 * value; unset (NULL in storage) means "inherit the workflow default". Values,
 * order, and default here must stay in sync with `BUILTIN_OVERSIGHT_SETTINGS`.
 */
export const PLANNER_OVERSIGHT_LEVELS = ["off", "observe", "steer", "autonomous"] as const;
export type PlannerOversightLevel = (typeof PLANNER_OVERSIGHT_LEVELS)[number];
export const DEFAULT_PLANNER_OVERSIGHT_LEVEL: PlannerOversightLevel = "autonomous";

/** Controls whether triage should require completion documentation artifacts in task specs. */
export const COMPLETION_DOCUMENTATION_MODES = ["off", "changeset", "changelog"] as const;
export type CompletionDocumentationMode = (typeof COMPLETION_DOCUMENTATION_MODES)[number];

/*
FNXC:ReviewArtifacts 2026-07-17-12:00:
Review-artifact production is opt-in by default: backend and trivial work stay off,
while user-facing tasks can opt in without making every task generate media.
*/
export const REVIEW_ARTIFACTS_MODES = ["off", "user-facing", "on"] as const;
export type ReviewArtifactsMode = (typeof REVIEW_ARTIFACTS_MODES)[number];

/** Theme mode for light/dark/system preference */
export const THEME_MODES = ["dark", "light", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Color theme options for the dashboard */
export const COLOR_THEMES = [
  "default",
  "ocean",
  "forest",
  "sunset",
  "zen",
  "berry",
  "high-contrast",
  "industrial",
  "monochrome",
  "slate",
  "ash",
  // FNXC:DashboardTheming 2026-06-19-15:36: "air" is the source-of-truth id for the minimal, borderless, paper-like dashboard theme; keep bootstrap validators and theme options in sync with this union.
  "air",
  "graphite",
  "silver",
  "solarized",
  "factory",
  "factory-mono",
  "ayu",
  "one-dark",
  "nord",
  "dracula",
  "gruvbox",
  "tokyo-night",
  "catppuccin-mocha",
  "github-dark",
  "everforest",
  "rose-pine",
  "kanagawa",
  "night-owl",
  "palenight",
  "monokai-pro",
  "slime",
  "brutalist",
  "neon-city",
  "parchment",
  "terminal",
  "glass",
  // FNXC:DashboardTheming 2026-07-01-00:00: Glass Silver is the silver/gray frosted sibling of Glass; keep this id in lockstep with dashboard/desktop validators and selector metadata so persisted explicit choices survive startup.
  "glass-silver",
  "horizon",
  "vitesse",
  "outrun",
  "snazzy",
  "porple",
  "espresso",
  "mars",
  "poimandres",
  "ember",
  "rust",
  "copper",
  "foundry",
  "carbon",
  "sandstone",
  "lagoon",
  "frost",
  "lavender",
  "neon-bloom",
  "sepia",
  // FNXC:DashboardTheming 2026-07-16-00:00: FN-8151 adds Cobalt, Clay, and Moss; keep the core union, selector metadata, both bootstrap validators, token blocks, and swatch classes in this exact order.
  "cobalt",
  "clay",
  "moss",
  // FNXC:DashboardTheming 2026-07-20-00:00: Aurora is a persisted dashboard theme; keep this ID and order synchronized with selector metadata and web/desktop first-paint validators so saved selections survive validation before React hydrates.
  "aurora",
  // FNXC:DashboardTheming 2026-07-20-00:00: Calm is persisted; keep its ID and order synchronized across core, selectors, and both pre-hydration validators so saved selections survive validation before React hydrates.
  "calm",
  "shadcn",
  // FNXC:DashboardTheming 2026-06-30-00:00: Shadcn Ember is the default for unset installs; keep it adjacent to the shadcn base so dashboard options and bootstrap validators preserve published theme order while explicit legacy ids remain valid.
  "shadcn-ember",
  // FNXC:DashboardTheming 2026-06-20-18:20: FN-6816 adds the user-customizable shadcn variant; keep this union in lockstep with dashboard theme options, swatches, theme-data base blocks, and the shadcn custom color token list.
  "shadcn-custom",
  // FNXC:DashboardTheming 2026-06-19-16:07: FN-6756 extends the published color-theme union with shadcn-family accent variants; keep dashboard theme options, bootstrap validation, swatches, and theme-data token blocks in lockstep with this ordered list.
  // FNXC:DashboardTheming 2026-06-20-00:00: FN-6813 renames the grayscale-base mono theme to shadcn-mono-red and adds the remaining mono accent variants; keep Shadcn Gray adjacent to Shadcn Black so the color-family order stays stable with FN-6814.
  // FNXC:DashboardTheming 2026-06-21-00:00: FN-6815 adds shadcn-gray-blue as the slate-neutral blue-gray sibling; keep it adjacent to Shadcn Gray so the published union mirrors dashboard option order.
  "shadcn-blue",
  "shadcn-green",
  "shadcn-red",
  "shadcn-purple",
  "shadcn-pink",
  "shadcn-orange",
  "shadcn-yellow",
  "shadcn-mono",
  "shadcn-mono-red",
  "shadcn-mono-blue",
  "shadcn-mono-green",
  "shadcn-mono-purple",
  "shadcn-mono-pink",
  "shadcn-mono-orange",
  "shadcn-mono-yellow",
  "shadcn-black",
  "shadcn-gray",
  "shadcn-gray-blue",
] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number];

/** UI locales supported across the dashboard and terminal UI. `en` is the
 *  source-of-truth language and the fallback for all others. Adding a locale
 *  here (plus translated catalogs) is the only code change a new language
 *  needs — see `@fusion/i18n`. zh-CN and zh-TW are independent catalogs and
 *  are never auto-converted between scripts. */
export const SUPPORTED_LOCALES = ["en", "zh-CN", "zh-TW", "fr", "es", "ko"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
/** Source-of-truth language and the fallback for all locales. */
export const DEFAULT_LOCALE: Locale = "en";

/** Narrow an arbitrary value to a supported `Locale`. */
export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}
