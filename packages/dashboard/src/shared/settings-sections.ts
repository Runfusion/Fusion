/*
FNXC:UiMetadataApi 2026-07-14-00:00:
Settings section ids, labels, scopes, groups, and search terms have one source of truth consumed by both the Settings UI and GET /api/settings/sections. Edit this registry rather than either consumer so plugin discovery and rendered Settings navigation cannot drift.
*/

export type SettingsSectionScope = "global" | "project" | undefined;
export type SettingsSectionGroup = "Preferences" | "Project" | "AI & Models" | "Automation" | "Integrations" | "Infrastructure" | "Advanced";

interface SettingsSectionDefinition {
  id: string;
  label: string;
  labelKey: string;
  scope: SettingsSectionScope;
  isGroupHeader?: boolean;
  searchableText?: readonly string[];
  searchableKeys?: readonly string[];
}

export interface SettingsSectionMetadata extends SettingsSectionDefinition {
  group: SettingsSectionGroup;
  advanced: boolean;
}

/* FNXC:VoiceInput 2026-07-28-12:00: Voice Input is an opt-in end-user feature, so it stays visible in Basic Settings rather than joining this advanced-only set. */
const ADVANCED_SECTION_IDS = new Set([
  "node-sync",
  "global-mcp",
  "cli-agents",
  "research-global",
  "remote",
  "experimental",
  "hermes-runtime",
  "openclaw-runtime",
  "paperclip-runtime",
  "scheduled-evals",
  "node-routing",
  "agent-permissions",
  "memory",
  "backups",
  "research-project",
  "secrets",
  "mcp",
  "prompts",
  "plugins",
]);

const SETTINGS_SECTION_DEFINITIONS: readonly SettingsSectionDefinition[] = [
  { id: "__preferences_header", label: "Preferences", labelKey: "settings.nav.preferencesHeader", scope: undefined, isGroupHeader: true },
  { id: "appearance", label: "Appearance", labelKey: "settings.nav.appearance", scope: "global", searchableText: ["theme", "color", "sidebar", "dock", "task popup", "task popups", "board list popups", "popup view attachment", "open tasks as popups", "quick chat"] },
  { id: "keyboard-shortcuts", label: "Keyboard Shortcuts", labelKey: "settings.nav.keyboardShortcuts", scope: "global", searchableText: ["keyboard shortcuts", "hotkeys", "quick chat shortcut", "terminal shortcut", "open files", "open settings", "command center", "new task shortcut", "record shortcut"] },
  { id: "notifications", label: "Notifications", labelKey: "settings.nav.notifications", scope: "global", searchableText: ["ntfy", "webhook", "events", "failure notifications", "sticky", "toast"] },
  { id: "global-general", label: "General · Global", labelKey: "settings.nav.globalGeneral", scope: "global", searchableText: ["global defaults", "modal outside dismiss", "agent logs", "persist tool output", "thinking logs"] },
  /*
  FNXC:SettingsNavigation 2026-07-16-12:00:
  FN-8128 keeps the `fn` binary panel as a dedicated section rather than re-inlining machine plumbing at the top of General · Global, while restoring it to the default-visible Global group. Operators need installation, version, path, and diagnostic controls in Basic mode when setup or repair is needed.
  */
  { id: "cli-binary", label: "CLI Binary", labelKey: "settings.nav.cliBinary", scope: "global", searchableText: ["fn binary", "cli", "install", "version", "path", "upgrade", "homebrew", "binary check"] },

  { id: "__project_header", label: "Project", labelKey: "settings.nav.projectHeader", scope: undefined, isGroupHeader: true },
  /*
  FNXC:GitHubImportTranslate 2026-07-15-16:20:
  Import auto-translation lives in Project General beside the other import-scoped GitHub settings, but operators look for it by what it DOES ("translate", "language", "auto translate issues"), not by the section it happens to live in.
  FNXC:SettingsSearch 2026-07-15-19:10: the per-setting index now matches these controls on their own label and help text, so the terms that merely restate the copy are no longer load-bearing. The list is kept for the genuine vocabulary gaps — "localize", "localization", "foreign language issues" — which appear nowhere in the copy, and because unmigrated siblings in this section still rely on section-level keywords.
  */
  { id: "general", label: "General · Project", labelKey: "settings.nav.projectGeneral", scope: "project", searchableText: ["project general", "Completion Documentation Automation", "Quick Chat launcher", "ephemeral task-worker agents", "chat rooms", "auto-cleanup old chats", "translate", "translation", "auto translate", "auto-translate", "autotranslate", "auto translate issues", "translate issues", "translate imported issues", "githubImportAutoTranslate", "importTranslateTargetLocale", "target language", "translation target language", "translation language", "language", "foreign language issues", "import language", "localize", "localization", "report", "report bug", "send feedback", "share idea", "get help"], searchableKeys: ["settings.general.autoTranslateImportedIssues", "settings.general.autoTranslateImportedIssuesHelp", "settings.general.translationTargetLanguage", "settings.general.translationTargetLanguageHelp", "settings.general.followDashboardLanguage"] },
  { id: "commands", label: "Commands & Scripts", labelKey: "settings.nav.commands", scope: "project", searchableText: ["test command", "build command", "verification command", "workflow scripts", "commands"] },
  { id: "worktrees", label: "Worktrees", labelKey: "settings.nav.worktrees", scope: "project", searchableText: ["worktree directory", "copy files", "recycle worktrees", "branch naming", "sibling branch rename"] },
  { id: "merge", label: "Merge", labelKey: "settings.nav.merge", scope: "project", searchableText: ["auto merge", "AI merge", "merge strategy", "plan approval", "direct merge", "integration branch", "push after merge"] },
  /*
  FNXC:SettingsNavigation 2026-07-18-12:30:
  FN-8350 makes configuration history a project Settings destination instead of a
  Command Center card. Register it in the shared section registry so desktop
  navigation, the mobile picker, and Settings search expose one canonical view.
  */
  { id: "config-versions", label: "Configuration Versions", labelKey: "settings.nav.configVersions", scope: "project", searchableText: ["configuration versions", "revision history", "roll back settings", "restore configuration", "config rollback"] },

  { id: "__ai_header", label: "AI & Models", labelKey: "settings.nav.aiHeader", scope: undefined, isGroupHeader: true },
  /*
  FNXC:SettingsNavigation 2026-07-16-01:30:
  Authentication leads the AI & Models group. It is a provider-credentials screen, so it belongs with the model settings it gates rather than under Integrations (where it sat among MCP/Plugins/runtimes) or floating above the groups as a special case — connecting a provider and choosing its models are one task, done in that order.
  First within the group because nothing else in AI & Models can be configured until it is done: with no provider connected there are no models to pick.

  FNXC:SettingsNavigation 2026-07-16-13:40:
  FN-8130 changes the Settings landing surface from Authentication to Appearance. Authentication remains first within its own AI & Models group, but the always-visible global Preferences section is the default instead.
  */
  { id: "authentication", label: "Authentication", labelKey: "settings.nav.authentication", scope: undefined, searchableText: ["login", "OAuth", "API key", "custom providers", "Anthropic", "OpenAI", "provider credentials"] },
  { id: "global-models", label: "Models · Global", labelKey: "settings.nav.globalModels", scope: "global", searchableText: ["global models", "model presets", "favorite providers", "model pricing overrides", "LiteLLM pricing", "token pricing", "translate", "translation model", "import translation model", "import auto-translation model"] },
  /**
   * FNXC:SettingsNavigation 2026-07-13-00:00:
   * Project Models owns the FN-7907 Direct-chat default settings. Its shared Settings search index must advertise chat-default terms and i18n labels so desktop nav, the mobile section picker, and filtered search all surface this section when operators search for Chat defaults.

   * FNXC:SettingsNavigation 2026-07-14-20:15:
   * Title auto-summarization lives under Project Models but operators search for "summarize", "auto summarize", "title summarization", and related phrases that did not match the prior chat-only/summarization-model index. Advertise those terms and the control's i18n keys so Settings search finds this section.
   */
  {
    id: "project-models",
    label: "Models · Project",
    labelKey: "settings.nav.projectModels",
    scope: "project",
    searchableText: [
      "default provider",
      "default model",
      "workflow model lanes",
      "Plan/Triage",
      "Executor",
      "Reviewer",
      "summarization model",
      "summarize",
      "summarize titles",
      "auto summarize",
      "auto-summarize",
      "auto summarize titles",
      "auto-summarize titles",
      "autoSummarizeTitles",
      "task definition language",
      "task definitions input language",
      "taskDefinitionInInputLanguage",
      "localized task prose",
      "title summarization",
      "title summarizer",
      "AI title",
      "AI merge commit summaries",
      "merge commit summary",
      "chat",
      "new chat",
      "new chat behavior",
      "chat default",
      "chat default model",
      "chat default agent",
      "chat model",
      "chat agent",
      "prompt for model",
      "always use default",
      // FNXC:GitHubImportTranslate 2026-07-15-16:20: the import-translate lane is picked here.
      "translate",
      "translation",
      "translation model",
      "import translation model",
      "import auto-translation model",
      "auto-translate model",
    ],
    searchableKeys: [
      "settings.projectModels.chatHeading",
      "settings.projectModels.chatDescription",
      "settings.projectModels.chatNewSessionMode",
      "settings.projectModels.chatNewSessionModePrompt",
      "settings.projectModels.chatNewSessionModeAlwaysDefault",
      "settings.projectModels.chatDefaultKind",
      "settings.projectModels.chatDefaultModel",
      "settings.projectModels.chatDefaultAgent",
      "settings.projectModels.aITitleAndGitCommitMessageSummarization",
      "settings.projectModels.autoSummarizeLongDescriptionsAsTitles",
      "settings.projectModels.whenEnabledTasksCreatedWithoutATitleBut",
      "settings.projectModels.aIMergeCommitSummaries",
      "settings.projectModels.whenEnabledMergeCommitMessagesIncludeAnAI",
    ],
  },
  {
    id: "cli-agents",
    label: "CLI Agents",
    labelKey: "settings.nav.cliAgents",
    scope: "global",
    searchableText: [
      "Droid CLI",
      "Cursor CLI",
      "agent runtime",
      "command line agents",
      "Adapter",
      "Command override",
      "Path or name of the binary to launch",
      "Extra arguments",
      "Appended after the adapter's computed arguments",
      "Environment variable additions",
      "Comma-separated variable names forwarded",
      "Autonomy mode",
      "Elevated autonomy requires a per-project approval",
    ],
    searchableKeys: [
      "settings.cliAgents.adapterLabel",
      "settings.cliAgents.commandLabel",
      "settings.cliAgents.commandHelp",
      "settings.cliAgents.extraArgsLabel",
      "settings.cliAgents.extraArgsHelp",
      "settings.cliAgents.envLabel",
      "settings.cliAgents.envHelp",
      "settings.cliAgents.autonomyLabel",
      "settings.cliAgents.autonomyHelp",
      "settings.cliAgents.approvedNote",
    ],
  },
  { id: "agent-permissions", label: "Agents & Permissions", labelKey: "settings.nav.agentPermissions", scope: "project", searchableText: ["agent provisioning", "approval", "permissions", "policy", "agent creation"] },
  { id: "prompts", label: "Prompts", labelKey: "settings.nav.prompts", scope: "project", searchableText: ["prompt instructions", "PR title prompt", "PR description prompt", "custom prompts"] },
  { id: "memory", label: "Memory", labelKey: "settings.nav.memory", scope: "project", searchableText: ["memory backend", "Dreams", "long-term memory", "qmd", "memory file", "retrieval"] },
  { id: "research-global", label: "Research · Global", labelKey: "settings.nav.researchGlobal", scope: "global", searchableText: ["research providers", "external search providers", "fetch limits", "global research defaults", "citations"] },
  { id: "research-project", label: "Research · Project", labelKey: "settings.nav.researchProject", scope: "project", searchableText: ["project research", "research runs", "citations", "search limits", "fetch synthesis"] },
  { id: "voice-input", label: "Voice Input", labelKey: "settings.nav.voiceInput", scope: "project", searchableText: ["voice", "dictation", "microphone", "speech to text", "parakeet", "transcription"] },

  { id: "__automation_header", label: "Automation", labelKey: "settings.nav.automationHeader", scope: undefined, isGroupHeader: true },
  /*
  FNXC:SettingsNavigation 2026-07-15-18:52:
  FNXC:CapacityModel 2026-07-29-00:10 (drop the cross-project cap — settings half):
  The Global/Project scheduling PAIR is now a single "Scheduling" section. The
  global half existed to host exactly one control, the machine-wide concurrency
  cap, which is deleted — capacity is two numbers PER PROJECT. An empty section in
  the nav is a promise of settings that are not there.
  */
  { id: "scheduling", label: "Scheduling", labelKey: "settings.nav.scheduling", scope: "project", searchableText: ["max concurrent", "capacity", "stuck tasks", "poll interval", "parallel steps", "scheduler"] },
  { id: "scheduled-evals", label: "Scheduled Evals", labelKey: "settings.nav.scheduledEvals", scope: "project", searchableText: ["scheduled evals", "evaluation schedule", "eval runs", "quality jobs"] },

  { id: "__integrations_header", label: "Integrations", labelKey: "settings.nav.integrationsHeader", scope: undefined, isGroupHeader: true },
  /*
  FNXC:SourceControl 2026-07-15-20:30:
  The Global/Project source-control pair sits under Integrations, not Project: these settings configure how Fusion talks to GitHub/GitLab, which is the same kind of thing as the MCP and provider entries beside them.
  The two are adjacent and ordered global-then-project to match the inheritance they model — the global entry holds the fallbacks the project entry overrides — mirroring the MCP Servers pair directly below.
  The GitLab/GitHub keywords below were curated on the `general` and `merge` nav entries before their controls moved here; a keyword left behind would send an operator searching "gitlab token" to a section that no longer renders one. The translate keywords deliberately did NOT move: `githubImportAutoTranslate`/`importTranslateTargetLocale` are Import Tasks panel settings and stay in General.
  */
  { id: "source-control-global", label: "Source Control · Global", labelKey: "settings.nav.sourceControlGlobal", scope: "global", searchableText: ["GitLab instance URL", "global tracking repo", "GitLab", "GitHub", "global GitLab token", "GitLab fallback", "source control", "forge"] },
  { id: "source-control", label: "Source Control · Project", labelKey: "settings.nav.sourceControl", scope: "project", searchableText: ["GitHub tracking", "GitLab integration", "GitHub auth mode", "GitLab access token", "GitHub personal access token", "tracking repo", "source control", "forge", "gh cli", "issue tracking"] },
  { id: "global-mcp", label: "MCP Servers · Global", labelKey: "settings.nav.globalMcp", scope: "global", searchableText: ["global MCP servers", "shared MCP", "user MCP", "tool servers"] },
  { id: "mcp", label: "MCP Servers · Project", labelKey: "settings.nav.mcp", scope: "project", searchableText: ["project MCP servers", "workspace MCP", "project tool servers", "mcp config"] },
  { id: "plugins", label: "Plugins", labelKey: "settings.nav.plugins", scope: "project", searchableText: ["Fusion plugins", "Pi extensions", "plugin manager", "extension marketplace"] },
  { id: "hermes-runtime", label: "Hermes", labelKey: "settings.nav.hermesRuntime", scope: "global", searchableText: ["Hermes runtime", "plugin runtime", "printer runtime"] },
  { id: "openclaw-runtime", label: "OpenClaw", labelKey: "settings.nav.openclawRuntime", scope: "global", searchableText: ["OpenClaw runtime", "plugin runtime", "open claw"] },
  { id: "paperclip-runtime", label: "Paperclip", labelKey: "settings.nav.paperclipRuntime", scope: "global", searchableText: ["Paperclip runtime", "plugin runtime"] },
  { id: "secrets", label: "Secrets", labelKey: "settings.nav.secrets", scope: "project", searchableText: ["secrets", "secret storage", "environment", "credentials"] },

  { id: "__infrastructure_header", label: "Infrastructure", labelKey: "settings.nav.infrastructureHeader", scope: undefined, isGroupHeader: true },
  { id: "node-sync", label: "Node Sync", labelKey: "settings.nav.nodeSync", scope: "global", searchableText: ["sync", "node", "distributed", "heartbeat", "coordination"] },
  { id: "node-routing", label: "Node Routing", labelKey: "settings.nav.nodeRouting", scope: "project", searchableText: ["node routing", "routing rules", "node selection", "execution nodes"] },
  /*
  FNXC:SettingsNavigation 2026-06-26-09:20:
  FN-7062 requires the remote settings nav entry to read "Remote Access" only. The stale "& Node Sync" suffix belongs to the separate Node Sync settings section, while this section body already uses the Remote Access heading.
  */
  { id: "remote", label: "Remote Access", labelKey: "settings.nav.remote", scope: "global", searchableText: ["cloudflared", "tunnel", "QR", "persistent token", "remote URL"] },
  { id: "backups-global", label: "Database Backups", labelKey: "settings.backups.databaseBackups", scope: "global", searchableText: ["database backup", "restore", "shared cluster"] },
  { id: "backups", label: "Memory Backups", labelKey: "settings.backups.memoryBackups", scope: "project", searchableText: ["memory backup", "memory snapshot"] },

  { id: "__advanced_header", label: "Advanced", labelKey: "settings.nav.advancedHeader", scope: undefined, isGroupHeader: true },
  { id: "experimental", label: "Experimental Features", labelKey: "settings.nav.experimental", scope: "global", searchableText: ["feature flags", "experiments", "research view", "evals view", "sandbox", "subtask breakdown"] },
];

let currentGroup: SettingsSectionGroup | undefined;
export const SETTINGS_SECTION_METADATA: readonly SettingsSectionMetadata[] = SETTINGS_SECTION_DEFINITIONS.map((section) => {
  if (section.isGroupHeader) {
    currentGroup = section.label as SettingsSectionGroup;
  }
  if (!currentGroup) {
    throw new Error(`Settings section ${section.id} appears before its group header`);
  }
  return {
    ...section,
    group: currentGroup,
    advanced: ADVANCED_SECTION_IDS.has(section.id),
  };
});
