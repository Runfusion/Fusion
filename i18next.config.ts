import {
  defineConfig,
  recommendedAcceptedAttributes,
  recommendedAcceptedTags,
} from "i18next-cli";


const DEFERRED_I18N_LINT_FILES = [
  // FNXC:i18n-LintBaseline 2026-06-19-00:00:
  // These exact files still carry pre-existing user-facing copy debt after FN-6749 restored the guardrail scope and token suppression.
  // Deferral split: 23 settings section files -> FN-6771, 21 workflow/task/setup/PR files -> FN-6770, and 36 plugin/agent/mission/misc files -> FN-6769.
  // Keep the deferral file-scoped and remove entries as those follow-ups localize each cluster.
  "packages/dashboard/app/components/WorkflowSelector.tsx",
  "packages/dashboard/app/components/WorkflowResultsTab.tsx",
  "packages/dashboard/app/components/WorkflowNodeEditor.tsx",
  "packages/dashboard/app/components/TerminalModal.tsx",
  "packages/dashboard/app/components/TaskDetailModal.tsx",
  "packages/dashboard/app/components/TaskComments.tsx",
  "packages/dashboard/app/components/TaskChatTab.tsx",
  "packages/dashboard/app/components/StashConflictModal.tsx",
  "packages/dashboard/app/components/SetupWizardModal.tsx",
  "packages/dashboard/app/components/SettingsModal.tsx",
  "packages/dashboard/app/components/ScriptsModal.tsx",
  "packages/dashboard/app/components/ScheduleForm.tsx",
  "packages/dashboard/app/components/ScheduleCard.tsx",
  "packages/dashboard/app/components/RoutingTab.tsx",
  "packages/dashboard/app/components/RoutineEditor.tsx",
  "packages/dashboard/app/components/RoutineCard.tsx",
  "packages/dashboard/app/components/ResearchView.tsx",
  "packages/dashboard/app/components/QuickChatFAB.tsx",
  "packages/dashboard/app/components/PullRequestView.tsx",
  "packages/dashboard/app/components/ProjectSelector.tsx",
  "packages/dashboard/app/components/PrPanel.tsx",
  "packages/dashboard/app/components/PrCreateModal.tsx",
  "packages/dashboard/app/components/PiExtensionsManager.tsx",
  "packages/dashboard/app/components/NodeDetailModal.tsx",
  "packages/dashboard/app/components/ModelOnboardingModal.tsx",
  "packages/dashboard/app/components/MissionManager.tsx",
  "packages/dashboard/app/components/MissionInterviewModal.tsx",
  "packages/dashboard/app/components/MilestoneSliceInterviewModal.tsx",
  "packages/dashboard/app/components/MailboxView.tsx",
  "packages/dashboard/app/components/IssueMentionPopup.tsx",
  "packages/dashboard/app/components/InsightsView.tsx",
  "packages/dashboard/app/components/HermesRuntimeCard.tsx",
  "packages/dashboard/app/components/Header.tsx",
  "packages/dashboard/app/components/GroupTaskModal.tsx",
  "packages/dashboard/app/components/GitManagerModal.tsx",
  "packages/dashboard/app/components/GitHubStarPrompt.tsx",
  "packages/dashboard/app/components/ExecutorStatusBar.tsx",
  "packages/dashboard/app/components/ErrorBoundary.tsx",
  "packages/dashboard/app/components/DocumentsView.tsx",
  "packages/dashboard/app/components/DevServerView.tsx",
  "packages/dashboard/app/components/DashboardLoader.tsx",
  "packages/dashboard/app/components/CursorCliProviderCard.tsx",
  "packages/dashboard/app/components/CliBinaryPanel.tsx",
  "packages/dashboard/app/components/BranchGroupCard.tsx",
  "packages/dashboard/app/components/Board.tsx",
  "packages/dashboard/app/components/AgentsOverviewBar.tsx",
  "packages/dashboard/app/components/AgentRunHistory.tsx",
  "packages/dashboard/app/components/AgentPromptsManager.tsx",
  "packages/dashboard/app/components/AgentOnboardingModal.tsx",
  "packages/dashboard/app/components/AgentImportModal.tsx",
  "packages/dashboard/app/components/AgentGenerationModal.tsx",
  "packages/dashboard/app/components/AgentDetailView.tsx",
  "packages/dashboard/app/components/AddNodeModal.tsx",
  "packages/dashboard/app/components/ActivityLogModal.tsx",
  "packages/dashboard/app/components/ActivityFeed.tsx",
  "packages/dashboard/app/components/ActiveAgentsPanel.tsx",
  "packages/dashboard/app/components/nodes/WorkflowNodeTypes.tsx",
  "packages/dashboard/app/components/settings/sections/WorktreesSection.tsx",
  "packages/dashboard/app/components/settings/sections/SchedulingSection.tsx",
  "packages/dashboard/app/components/settings/sections/ScheduledEvalsSection.tsx",
  "packages/dashboard/app/components/settings/sections/RuntimesSections.tsx",
  "packages/dashboard/app/components/settings/sections/ResearchProjectSection.tsx",
  "packages/dashboard/app/components/settings/sections/ResearchGlobalSection.tsx",
  "packages/dashboard/app/components/settings/sections/RemoteSection.tsx",
  "packages/dashboard/app/components/settings/sections/ProjectModelsSection.tsx",
  "packages/dashboard/app/components/settings/sections/PluginsSection.tsx",
  "packages/dashboard/app/components/settings/sections/NotificationsSection.tsx",
  "packages/dashboard/app/components/settings/sections/NodeSyncSection.tsx",
  "packages/dashboard/app/components/settings/sections/NodeRoutingSection.tsx",
  "packages/dashboard/app/components/settings/sections/MergeSection.tsx",
  "packages/dashboard/app/components/settings/sections/MemorySection.tsx",
  "packages/dashboard/app/components/settings/sections/GlobalModelsSection.tsx",
  "packages/dashboard/app/components/settings/sections/GlobalGeneralSection.tsx",
  "packages/dashboard/app/components/settings/sections/GeneralSection.tsx",
  "packages/dashboard/app/components/settings/sections/ExperimentalSection.tsx",
  "packages/dashboard/app/components/settings/sections/CommandsSection.tsx",
  "packages/dashboard/app/components/settings/sections/BackupsSection.tsx",
  "packages/dashboard/app/components/settings/sections/AuthenticationSection.tsx",
  "packages/dashboard/app/components/settings/sections/AppearanceSection.tsx",
  "packages/dashboard/app/components/settings/sections/AgentPermissionsSection.tsx",
] as const;

/**
 * i18next-cli workflow config for the whole monorepo.
 *
 * - `extract` pulls t()/<Trans> keys from the dashboard and CLI source into the
 *   authored `en` catalogs under @fusion/i18n.
 * - `sync` propagates the `en` key structure to the four other locales.
 * - `types` regenerates key types from the `en` catalogs.
 * - `status` reports per-locale completion (CI gate).
 * - `lint` flags hardcoded user-facing strings (primary guardrail).
 *
 * Namespaces are routed by the `ns:` prefix in keys / `useTranslation(ns)` in
 * source, not by file path. `common` is the default namespace.
 */
export default defineConfig({
  locales: ["en", "zh-CN", "zh-TW", "fr", "es", "ko"],
  extract: {
    input: [
      "packages/dashboard/app/**/*.{ts,tsx}",
      "packages/cli/src/**/*.{ts,tsx}",
      "!**/__tests__/**",
      "!**/*.test.*",
    ],
    output: "packages/i18n/locales/{{language}}/{{namespace}}.json",
    primaryLanguage: "en",
    defaultNS: "common",
    keySeparator: ".",
    nsSeparator: ":",
    // Untranslated secondary-locale keys stay empty so `status` can measure
    // real completion; the active locale falls back to `en` at runtime.
    defaultValue: "",
  },
  types: {
    input: ["packages/i18n/locales/en/*.json"],
    output: "packages/i18n/src/i18next-resources.d.ts",
  },
  lint: {
    /*
     * FNXC:i18n-LintBaseline 2026-06-19-00:00:
     * i18n lint must scan the same shipping surfaces as extract so it remains a trusted user-facing-copy guardrail.
     * Tests and stories are excluded because they are non-shipping fixtures and extract already excludes test files.
     * Keyboard-key glyphs inside <kbd> are technical tokens, not translated prose.
     */
    ignore: ["**/__tests__/**", "**/*.test.*", "**/*.stories.*", ...DEFERRED_I18N_LINT_FILES],
    ignoredTags: ["kbd"],
    acceptedTags: recommendedAcceptedTags,
    acceptedAttributes: recommendedAcceptedAttributes,
  },
});
