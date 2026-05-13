import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers({ defaultCap: 3 });

const qualityAppTests = [
  // Top-level API-client, mobile layout, styling, auth, and shell regressions.
  "app/__tests__/*.test.{ts,tsx}",
  "app/api/**/*.test.ts",
  // Representative workflow/component coverage. Exhaustive modal/view suites
  // stay available in the full `dashboard-app` project.
  "app/components/__tests__/{ActiveAgentsPanel,AgentMentionPopup,AgentMetricsBar,AgentReflectionsTab,AgentTokenStatsPanel,App,AuthTokenRecoveryDialog,Board,board-mobile-view-switch,ChatView,Column,ConfirmDialog,ConversationHistory,DashboardLoader,DirectoryPicker,ErrorBoundary,ExecutorStatusBar,FileBrowser,FileEditor,InlineCreateCard,LoginInstructions,MemoryView,MessageComposer,MobileNavBar,NewTaskModal,NodeCard,NodeHealthDot,NodeStatusIndicator,ProjectCard,ProjectSelector,ProviderIcon,QuickChatFAB,ResearchView,StashRecoveryView,TaskCard,TaskCard.badge-height,TaskChangesTab,TaskComments,TaskDetailModal.github-tracking-header,TaskDocumentsTab,TaskForm,TaskIdIntegrityBanner,ThemeSelectorSwatchContract,WorkflowResultsTab}.test.tsx",
  // Hooks and utilities are fast, user-visible state/formatting behavior.
  "app/context/**/*.test.tsx",
  "app/hooks/__tests__/{useAgents,useAgentLogs,useAppSettings,useAuthOnboarding,useConfirm,useCurrentProject,useNodes,useNodeSettingsSync,useProjects,useQuickChat,useTasks,useTerminalSessions,useTheme,useToast,useUsageData,useViewState}.test.{ts,tsx}",
  "app/utils/**/*.test.{ts,tsx}",
];

const qualityApiTests = [
  // Critical HTTP/server behavior: auth, task/project/settings mutation,
  // git/GitHub, agents, nodes, chat/files, realtime, and isolation guards.
  "src/__tests__/{api-error,auth-middleware,auth-middleware-integration,chat-attachment-routes,chat-routes,file-service,github,github-webhooks,initialize,planning-flow-diagnostics-guardrail,project-routes,project-store-resolver,remote-access-routes,remote-auth,routes-agent-budget,routes-agent-keys,routes-agent-permissions,routes-agent-ratings,routes-agent-runs,routes-agent-soul-memory,routes-agents,routes-automation,routes-git,routes-github,routes-nodes,routes-settings,routes-task-commit-associations,routes-tasks,server,server-static-assets,server-webhook,server.events,setup-routes,sse,sse-buffer,test-isolation-guard,update-check-route,websocket}.test.ts",
  "src/routes/__tests__/{custom-provider-routes,custom-providers,register-docker-node-routes,stash-recovery-routes}.test.ts",
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
      "@fusion/engine": resolve(__dirname, "../engine/src/index.ts"),
      "@fusion/plugin-sdk": resolve(__dirname, "../plugin-sdk/src/index.ts"),
      "@fusion/test-utils": resolve(__dirname, "../core/src/__test-utils__/workspace.ts"),
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
