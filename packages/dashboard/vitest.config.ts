import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers({ defaultCap: 3 });

// Curated-gate skip-list (plan U2 / R7). Files listed here run in NO project on
// purpose (pre-existing failures discovered when the curated-gate hole was
// closed). The skip-list is the single source of truth shared with
// scripts/check-test-inventory.mjs's --dashboard-curated guard. Express the
// dashboard-relative globs so the backfill projects can exclude them.
const curatedSkipList: { entries: { file: string; reason: string }[] } = JSON.parse(
  readFileSync(resolve(__dirname, "../../scripts/lib/dashboard-curated-skiplist.json"), "utf8"),
);
const skipListDashboardGlobs = curatedSkipList.entries
  .map((entry) => entry.file.replace(/^packages\/dashboard\//, ""))
  .filter((file) => file.length > 0);

const qualityAppFoundationApiTests = [
  // API-client regressions are numerous but lightweight; keep them in their
  // own shard so the jsdom heap can reset before broader UI/layout coverage.
  "app/__tests__/api-*.test.ts",
  "app/api/**/*.test.ts",
];

const qualityAppFoundationUiTests = [
  // Top-level UI, auth, shell, mobile layout, and styling regressions.
  // Keep these as explicit file paths: this shard completes reliably when the
  // worker starts from a concrete file list instead of the broad glob.
  "app/__tests__/AgentMentionPopup.css.test.ts",
  "app/__tests__/App.boot-gate.test.tsx",
  "app/__tests__/App.shell-onboarding.test.tsx",
  "app/__tests__/ShellContext.test.tsx",
  "app/__tests__/activity-feed-theme-styling.test.ts",
  "app/__tests__/activity-log-mobile-layout.test.ts",
  "app/__tests__/agent-css-classes.test.ts",
  "app/__tests__/agent-runs-ui.test.ts",
  "app/__tests__/animation-duration-tokens.css.test.ts",
  "app/__tests__/auth.test.ts",
  "app/__tests__/board-mobile-corner-rendering.test.ts",
  "app/__tests__/board-tablet-overflow.test.ts",
  "app/__tests__/browser-layout-smoke-fixture.test.ts",
  "app/__tests__/chat-tool-calls-mobile-layout.test.ts",
  "app/__tests__/column-fixed-width.test.ts",
  "app/__tests__/component-css-no-raw-rgba.test.ts",
  "app/__tests__/dashboard-component-color-tokenization.test.ts",
  "app/__tests__/dashboard-footer-mobile-layout.test.ts",
  "app/__tests__/detail-body-mobile-overflow.test.ts",
  "app/__tests__/dev-server-layout-css.test.ts",
  "app/__tests__/executor-status-bar-theme.test.ts",
  "app/__tests__/footer-safe-layout.test.ts",
  "app/__tests__/git-manager-theme-styling.test.ts",
  "app/__tests__/index-html-theme-link.test.ts",
  "app/__tests__/insight-model-selector.test.tsx",
  "app/__tests__/lazy-loaded-views-docs.test.ts",
  "app/__tests__/mission-planning-modals-mobile.test.ts",
  "app/__tests__/mobile-bottom-bars-keyboard-layout.test.ts",
  "app/__tests__/mobile-bottom-space-layout.test.ts",
  "app/__tests__/mobile-feature-access-regression.test.tsx",
  "app/__tests__/mobile-header-controls.test.ts",
  "app/__tests__/mobile-input-font-size.test.ts",
  "app/__tests__/mobile-nav-bar-css.test.ts",
  "app/__tests__/mobile-planning-input-font-size.test.ts",
  "app/__tests__/mobile-scripts.test.ts",
  "app/__tests__/mobile-scroll-snap.test.ts",
  "app/__tests__/no-legacy-public.test.ts",
  "app/__tests__/onboarding-overlay-layering.test.ts",
  "app/__tests__/pwa.test.ts",
  "app/__tests__/quick-chat-mobile-keyboard-layout.test.ts",
  "app/__tests__/quick-chat-session-dropdown.test.ts",
  "app/__tests__/quick-chat-tool-calls-mobile-layout.test.ts",
  "app/__tests__/quick-entry-expanded-height.test.tsx",
  "app/__tests__/settings-mobile-wrap.test.ts",
  "app/__tests__/setup-wizard-modal-layout.test.ts",
  "app/__tests__/shell-host.test.ts",
  "app/__tests__/shell-native.test.ts",
  "app/__tests__/spinner-animation.css.test.ts",
  "app/__tests__/sse-bus.test.ts",
  "app/__tests__/status-colors-theme.test.ts",
  "app/__tests__/swUpdate.test.ts",
  "app/__tests__/tablet-header-controls.test.tsx",
  "app/__tests__/task-detail-modal-tablet-width.test.ts",
  "app/__tests__/terminal-input.test.ts",
  "app/__tests__/terminal-mobile-header-row.test.ts",
  "app/__tests__/terminal-mobile-keyboard-layout.test.ts",
  "app/__tests__/text-token-canonicalization.test.ts",
  "app/__tests__/versionCheck.test.ts",
  "app/__tests__/viewport-compensation-keyboard.test.ts",
];

const qualityAppHooksAndUtilsTests = [
  // Hooks and utilities are fast, user-visible state/formatting behavior.
  "app/context/**/*.test.tsx",
  "app/hooks/__tests__/{useAgents,useAgentLogs,useAgentLogs.resume-instrumentation,useAppSettings,useAuthOnboarding,useConfirm,useCurrentProject,useNodes,useNodes.resume-instrumentation,useNodeSettingsSync,useProjects,useProjects.resume-instrumentation,useMeshState.resume-instrumentation,useManagedDockerNodes.resume-instrumentation,usePrChecksStream.resume-instrumentation,useDevServerLogs.resume-instrumentation,useResearch.resume-instrumentation,useBackgroundSessions.resume-instrumentation,useQuickChat,useTasks,useTasks.resume-instrumentation,useChatRooms,useTerminalSessions,useTheme,useToast,useUsageData,useViewportMode,useViewState,useMergeAdvanceNotice}.test.{ts,tsx}",
  "app/utils/**/*.test.{ts,tsx}",
];

const qualityAppComponentTests = [
  "ActiveAgentsPanel",
  "ActivityLogModal",
  "AgentMentionPopup",
  "AgentMetricsBar",
  "AgentOnboardingModal",
  "AgentReflectionsTab",
  "AgentTokenStatsPanel",
  "App",
  "AuthTokenRecoveryDialog",
  "Board",
  "Board.canDropTask",
  "auto-merge-toggle-blank.mobile",
  "auto-merge-toggle-blank.mobile-integration",
  "board-mobile",
  "board-mobile-view-switch",
  "BranchGroupCard",
  "ChatView",
  "ChatView.autosize",
  "ChatView.chat-input-autosize",
  "ChatView.default-model-icon",
  "ChatView.draft",
  "ChatView.hash-mention",
  "ChatView.rooms",
  "ChatView.scroll-to-top",
  "ChatView.swipe-back",
  "Column",
  "ConfirmDialog",
  "ConversationHistory",
  "DataBoundary",
  "DashboardLoader",
  "DevServerView.mobile",
  "DirectoryPicker",
  "DuplicateWarningModal",
  "ErrorBoundary",
  "ExecutorStatusBar",
  "FileBrowser",
  "FileEditor",
  "GitHubBadge",
  "GroupTaskModal",
  "InlineCreateCard",
  "Lane",
  "LoginInstructions",
  "MemoryView",
  "MergeAdvanceNotice",
  "MessageComposer",
  "MessageComposer.autosize",
  "MobileNavBar",
  "NewTaskModal",
  "NewTaskModal.shared-cache",
  "NodeCard",
  "NodeHealthDot",
  "NodeStatusIndicator",
  "PlanningModeModal.autosize",
  "PluginManager.registry",
  "PrChecksList",
  "PrCreateModal",
  "PrCreateModal.layout",
  "ProjectCard",
  "ProjectHealthBadge",
  "ProjectSelector",
  "ProviderIcon",
  "PrPanel",
  "PrPanel.merge",
  "PrPanel.reviews",
  "QuickChatFAB",
  "QuickChatFAB.shared-cache",
  "ReliabilityView",
  "ResearchView",
  "SecretsView",
  "SecretsView.mobile",
  "SettingsModal",
  "SettingsModal.testMode",
  "SettingsModal.worktrunk",
  "StashConflictModal",
  "StashRecoveryView",
  "TaskCard",
  "TaskCard.badge-height",
  "TaskCard.badge-wrap",
  "TaskCard.footer-wrap",
  "TaskChangesTab",
  "TaskComments",
  "TaskDetailModal",
  "TaskDetailModal.allow-resurrection",
  "TaskDetailModal.create-pr-e2e",
  "TaskDetailModal.custom-fields",
  "TaskDetailModal.inline-editing-and-integrations",
  "TestModeBanner",
  "TaskDetailModal.create-pr-integration",
  "TaskDetailModal.github-tracking-header",
  "TaskDetailModal.github-tracking-stale",
  "TaskDetailModal.rebind-banner",
  "TaskDocumentsTab",
  "TaskFieldsSection",
  "TaskForm",
  "TaskIdIntegrityBanner",
  "TrackingRepoSelect",
  "WorkflowFieldsPanel",
  "WorkflowSettingsPanel",
  "WorkflowNodeEditor",
  "WorkflowResultsTab",
  "WorkflowSelector",
  "workflow-flow-mapping",
  "WorktrunkInstallApprovalDetails",
] as const;

const isolatedQualityAppComponentTests = ["App", "ChatView", "SettingsModal"] as const;
const batchedQualityAppComponentTests = qualityAppComponentTests.filter(
  (testName) => !isolatedQualityAppComponentTests.includes(testName),
);
const batchedQualityAppSplitIndex = Math.ceil(batchedQualityAppComponentTests.length / 2);
const batchedQualityAppComponentTestsA = batchedQualityAppComponentTests.slice(0, batchedQualityAppSplitIndex);
const batchedQualityAppComponentTestsB = batchedQualityAppComponentTests.slice(batchedQualityAppSplitIndex);

function buildComponentQualityInclude(testNames: readonly string[]): string[] {
  return testNames.map((testName) => `app/components/__tests__/${testName}.test.{ts,tsx}`);
}

const qualityAppTests = [
  ...qualityAppFoundationApiTests,
  ...qualityAppFoundationUiTests,
  ...qualityAppHooksAndUtilsTests,
  ...buildComponentQualityInclude(qualityAppComponentTests),
];

const qualityAppFoundationApiShardTests = [...qualityAppFoundationApiTests];
const qualityAppFoundationUiShardTests = [...qualityAppFoundationUiTests];
const qualityAppFoundationHooksAndUtilsTests = [...qualityAppHooksAndUtilsTests];
const qualityAppComponentBatchATests = buildComponentQualityInclude(batchedQualityAppComponentTestsA);
const qualityAppComponentBatchBTests = buildComponentQualityInclude(batchedQualityAppComponentTestsB);

const qualityAppAppOnlyTests = ["app/components/__tests__/App.test.tsx"];
const qualityAppChatOnlyTests = ["app/components/__tests__/ChatView.test.tsx"];
const qualityAppSettingsOnlyTests = ["app/components/__tests__/SettingsModal.test.tsx"];
/*
FNXC:DashboardTestQuarantine 2026-06-14-17:01:
FN-6454 applied the quarantine deletion ratchet to every dashboard test quarantined on 2026-06-14.
Keep this list empty until a new flaky dashboard test is quarantined with a matching ledger entry.

FNXC:DashboardTestQuarantine 2026-06-16-21:31:
FN-6514 rescued QuickEntryBox before the 2026-06-30 deletion deadline by restoring its mutated jsdom viewport, visibility, and object-URL globals in file teardown.
Keep it out of this exclude list so the broad app backfill lane exercises its aria-expanded regression coverage without quarantine drift.

FNXC:DashboardTestQuarantine 2026-06-16-19:21:
FN-6496 merge verification observed github-tracking-hook fail during the changed-test backfill shard with temp-directory cleanup ENOTEMPTY, then pass on isolated rerun.
Quarantine the cleanup-flaky file under the deletion ratchet rather than changing production or test timing outside the chat-streaming scope.
*/
const quarantinedDashboardTests: string[] = [
  "src/__tests__/github-tracking-hook.test.ts",
];

const qualityApiTests = [
  // Critical HTTP/server behavior: auth, task/project/settings mutation,
  // git/GitHub, agents, nodes, chat/files, realtime, and isolation guards.
  "src/__tests__/{api-error,auth-middleware,auth-middleware-integration,chat-attachment-routes,chat-manager,chat-routes,file-service,github,github-webhooks,initialize,planning-flow-diagnostics-guardrail,pr-routes-auto-merge,pr-routes.contract,project-routes,project-store-resolver,register-git-github.pr-options-preflight-metadata,register-git-github.pr-resolve-conflicts,remote-access-routes,remote-auth,routes-agent-budget,routes-agent-keys,routes-agent-permissions,routes-agent-ratings,routes-agent-runs,routes-agent-soul-memory,routes-agents,routes-automation,routes-branch-groups,routes-git,routes-github,routes-merge-advance-push-origin,routes-nodes,routes-nodes-sync-contract,routes-planning,routes-plugin-registry,routes-secrets-sync,routes-settings,routes-task-commit-associations,routes-tasks,routes-tasks-deterministic-dedup,routes-tasks-duplicate-check,routes-tasks-explicit-duplicate-marker,server,server-static-assets,server-webhook,server.events,setup-routes,sse,sse-buffer,test-isolation-guard,update-check-route,websocket,recover-branch-binding-route}.test.ts",
  "src/__tests__/dashboard-test-config-guard.test.ts",
  "src/routes/__tests__/{custom-provider-routes,custom-providers,register-docker-node-routes,register-diagnostics-routes,stash-recovery-routes}.test.ts",
  "scripts/__tests__/{run-quality-tests,run-vitest-with-heap}.test.ts",
];

// Backfill projects (plan U2 / R7). Historically the curated quality lanes
// enumerated their files by hand, so any app/ or src/ test file that nobody
// added to a curated list ran in NO project — not locally, not in CI. The
// backfill projects close that hole structurally: they include the broad
// globs and EXCLUDE only (a) files already executed by a curated lane and
// (b) the explicit skip-list. A brand-new test file therefore lands in
// backfill automatically; it can never silently fall through again.
const backfillAppExclude = [
  ...qualityAppTests,
  ...skipListDashboardGlobs.filter((file) => file.startsWith("app/")),
  "app/__tests__/build-output.test.ts",
];
const qualityAppBackfillTests = ["app/**/*.test.{ts,tsx}"];

const backfillApiExclude = [
  ...qualityApiTests,
  ...skipListDashboardGlobs.filter((file) => file.startsWith("src/")),
];
const qualityApiBackfillTests = ["src/**/*.test.{ts,tsx}"];

export const dashboardQualityProjectGlobs = {
  "dashboard-app-quality-foundation-api": {
    include: qualityAppFoundationApiShardTests,
    exclude: quarantinedDashboardTests,
  },
  "dashboard-app-quality-foundation-ui": {
    include: qualityAppFoundationUiShardTests,
    exclude: quarantinedDashboardTests,
  },
  "dashboard-app-quality-foundation-hooks-utils": {
    include: qualityAppFoundationHooksAndUtilsTests,
    exclude: quarantinedDashboardTests,
  },
  "dashboard-app-quality-components-a": {
    include: qualityAppComponentBatchATests,
    exclude: quarantinedDashboardTests,
  },
  "dashboard-app-quality-components-b": {
    include: qualityAppComponentBatchBTests,
    exclude: quarantinedDashboardTests,
  },
  "dashboard-app-quality-app": {
    include: qualityAppAppOnlyTests,
    exclude: quarantinedDashboardTests,
  },
  "dashboard-app-quality-chat": {
    include: qualityAppChatOnlyTests,
    exclude: quarantinedDashboardTests,
  },
  "dashboard-app-quality-settings": {
    include: qualityAppSettingsOnlyTests,
    exclude: quarantinedDashboardTests,
  },
  "dashboard-api-quality": {
    include: qualityApiTests,
    exclude: quarantinedDashboardTests,
  },
  "dashboard-app-quality-backfill": {
    include: qualityAppBackfillTests,
    exclude: [...backfillAppExclude, ...quarantinedDashboardTests],
  },
  "dashboard-api-quality-backfill": {
    include: qualityApiBackfillTests,
    exclude: [...backfillApiExclude, ...quarantinedDashboardTests],
  },
} as const;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
      "@fusion/engine": resolve(__dirname, "../engine/src/index.ts"),
      "@fusion/plugin-sdk": resolve(__dirname, "../plugin-sdk/src/index.ts"),
      "@fusion/test-utils": resolve(__dirname, "../core/src/__test-utils__/workspace.ts"),
      "@fusion/dashboard/app/components/TaskCard": resolve(__dirname, "app/components/TaskCard.tsx"),
      "@fusion/dashboard/app/plugins/types": resolve(__dirname, "app/plugins/types.ts"),
      "@fusion/dashboard/app/utils/projectStorage": resolve(__dirname, "app/utils/projectStorage.ts"),
      "@fusion/dashboard/app/utils/taskStuck": resolve(__dirname, "app/utils/taskStuck.ts"),
      "@fusion-plugin-examples/droid-runtime/probe": resolve(
        __dirname,
        "../../plugins/fusion-plugin-droid-runtime/src/probe.ts",
      ),
      "@fusion-plugin-examples/droid-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-droid-runtime/src/index.ts",
      ),
      "@fusion-plugin-examples/hermes-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-hermes-runtime/src/index.ts",
      ),
      "@fusion-plugin-examples/openclaw-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-openclaw-runtime/src/index.ts",
      ),
      "@fusion-plugin-examples/paperclip-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-paperclip-runtime/src/index.ts",
      ),
      "@fusion-plugin-examples/dependency-graph/dashboard-view": resolve(
        __dirname,
        "../../plugins/fusion-plugin-dependency-graph/src/dashboard-view.tsx",
      ),
      "@fusion-plugin-examples/dependency-graph": resolve(
        __dirname,
        "../../plugins/fusion-plugin-dependency-graph/src/index.ts",
      ),
      "@fusion-plugin-examples/compound-engineering/dashboard-view": resolve(
        __dirname,
        "../../plugins/fusion-plugin-compound-engineering/src/dashboard-view.tsx",
      ),
      "@fusion-plugin-examples/compound-engineering": resolve(
        __dirname,
        "../../plugins/fusion-plugin-compound-engineering/src/index.ts",
      ),
    },
  },
  test: {
    globals: true,
    setupFiles: [
      resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts"),
      "./vitest.setup.ts",
    ],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    // Threads share a V8 heap so they're much lighter than forks for jsdom +
    // React suites; forks duplicated the entire renderer per worker (~500MB).
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
    fileParallelism: true,
    isolate: true,
    exclude: quarantinedDashboardTests,
    // Dashboard route and integration-heavy suites can exceed the Vitest
    // 5s default under workspace-concurrent runs.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "dashboard-app-quality",
          environment: "jsdom",
          include: qualityAppTests,
          exclude: quarantinedDashboardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-foundation-api",
          environment: "jsdom",
          include: qualityAppFoundationApiShardTests,
          exclude: quarantinedDashboardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-foundation-ui",
          environment: "jsdom",
          include: qualityAppFoundationUiShardTests,
          exclude: quarantinedDashboardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-foundation-hooks-utils",
          environment: "jsdom",
          include: qualityAppFoundationHooksAndUtilsTests,
          exclude: quarantinedDashboardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-components-a",
          environment: "jsdom",
          include: qualityAppComponentBatchATests,
          exclude: quarantinedDashboardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-components-b",
          environment: "jsdom",
          include: qualityAppComponentBatchBTests,
          exclude: quarantinedDashboardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-app",
          environment: "jsdom",
          include: qualityAppAppOnlyTests,
          exclude: quarantinedDashboardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-chat",
          environment: "jsdom",
          include: qualityAppChatOnlyTests,
          exclude: quarantinedDashboardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-settings",
          environment: "jsdom",
          include: qualityAppSettingsOnlyTests,
          exclude: quarantinedDashboardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-api-quality",
          environment: "node",
          include: qualityApiTests,
          exclude: quarantinedDashboardTests,
          css: { include: [] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-backfill",
          environment: "jsdom",
          include: qualityAppBackfillTests,
          exclude: [...backfillAppExclude, ...quarantinedDashboardTests],
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-api-quality-backfill",
          environment: "node",
          include: qualityApiBackfillTests,
          exclude: [...backfillApiExclude, ...quarantinedDashboardTests],
          css: { include: [] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app",
          environment: "jsdom",
          include: ["app/**/*.test.{ts,tsx}"],
          exclude: quarantinedDashboardTests,
          // Process CSS imports only for jsdom tests that assert on
          // getComputedStyle. Node API tests do not need CSS transforms.
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-api",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: quarantinedDashboardTests,
          css: { include: [] },
        },
      },
    ],
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "dist/**"],
    },
  },
});
