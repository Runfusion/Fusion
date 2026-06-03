import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers({ defaultCap: 3 });

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
  "app/hooks/__tests__/{useAgents,useAgentLogs,useAgentLogs.resume-instrumentation,useAppSettings,useAuthOnboarding,useConfirm,useCurrentProject,useNodes,useNodes.resume-instrumentation,useNodeSettingsSync,useProjects,useProjects.resume-instrumentation,useMeshState.resume-instrumentation,useManagedDockerNodes.resume-instrumentation,usePrChecksStream.resume-instrumentation,useDevServerLogs.resume-instrumentation,useResearch.resume-instrumentation,useBackgroundSessions.resume-instrumentation,useQuickChat,useTasks,useTasks.resume-instrumentation,useChatRooms.resume-instrumentation,useTerminalSessions,useTheme,useToast,useUsageData,useViewState,useMergeAdvanceNotice}.test.{ts,tsx}",
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
  "TestModeBanner",
  "TaskDetailModal.create-pr-integration",
  "TaskDetailModal.github-tracking-header",
  "TaskDetailModal.github-tracking-stale",
  "TaskDetailModal.rebind-banner",
  "TaskDocumentsTab",
  "TaskForm",
  "TaskIdIntegrityBanner",
  "TrackingRepoSelect",
  "WorkflowResultsTab",
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
  return testNames.length > 0
    ? [`app/components/__tests__/{${testNames.join(",")}}.test.tsx`]
    : [];
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


const qualityApiTests = [
  // Critical HTTP/server behavior: auth, task/project/settings mutation,
  // git/GitHub, agents, nodes, chat/files, realtime, and isolation guards.
  "src/__tests__/{api-error,auth-middleware,auth-middleware-integration,chat-attachment-routes,chat-routes,file-service,github,github-webhooks,initialize,planning-flow-diagnostics-guardrail,pr-routes-auto-merge,pr-routes.contract,project-routes,project-store-resolver,register-git-github.pr-options-preflight-metadata,remote-access-routes,remote-auth,routes-agent-budget,routes-agent-keys,routes-agent-permissions,routes-agent-ratings,routes-agent-runs,routes-agent-soul-memory,routes-agents,routes-automation,routes-branch-groups,routes-git,routes-github,routes-merge-advance-push-origin,routes-nodes,routes-nodes-sync-contract,routes-planning,routes-secrets-sync,routes-settings,routes-task-commit-associations,routes-tasks,routes-tasks-deterministic-dedup,routes-tasks-duplicate-check,routes-tasks-explicit-duplicate-marker,server,server-static-assets,server-webhook,server.events,setup-routes,sse,sse-buffer,test-isolation-guard,update-check-route,websocket,recover-branch-binding-route}.test.ts",
  "src/__tests__/dashboard-test-config-guard.test.ts",
  "src/routes/__tests__/{custom-provider-routes,custom-providers,register-docker-node-routes,register-diagnostics-routes,stash-recovery-routes}.test.ts",
  "scripts/__tests__/run-vitest-with-heap.test.ts",
];

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
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers } },
    fileParallelism: true,
    isolate: true,
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
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-foundation-api",
          environment: "jsdom",
          include: qualityAppFoundationApiShardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-foundation-ui",
          environment: "jsdom",
          include: qualityAppFoundationUiShardTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-foundation-hooks-utils",
          environment: "jsdom",
          include: qualityAppFoundationHooksAndUtilsTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-components-a",
          environment: "jsdom",
          include: qualityAppComponentBatchATests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-components-b",
          environment: "jsdom",
          include: qualityAppComponentBatchBTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-app",
          environment: "jsdom",
          include: qualityAppAppOnlyTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-chat",
          environment: "jsdom",
          include: qualityAppChatOnlyTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app-quality-settings",
          environment: "jsdom",
          include: qualityAppSettingsOnlyTests,
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-api-quality",
          environment: "node",
          include: qualityApiTests,
          css: { include: [] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-app",
          environment: "jsdom",
          include: ["app/**/*.test.{ts,tsx}"],
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
