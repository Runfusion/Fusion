import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers({ defaultCap: 3 });

/*
FNXC:DashboardTests 2026-06-17-17:02:
Dashboard tests must be insulated from release-oriented shells that export NODE_ENV=production. Force test mode before Vitest resolves React and Testing Library so jsdom projects keep React.act and do not fail after slow browser-environment startup.
*/
process.env.NODE_ENV = "test";

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
  "app/__tests__/column-fixed-width.test.ts",
  "app/__tests__/dashboard-component-color-tokenization.test.ts",
  "app/__tests__/dashboard-footer-mobile-layout.test.ts",
  "app/__tests__/detail-body-mobile-overflow.test.ts",
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
  "app/__tests__/sse-bus.test.ts",
  "app/__tests__/swUpdate.test.ts",
  "app/__tests__/tablet-header-controls.test.tsx",
  "app/__tests__/task-detail-modal-tablet-width.test.ts",
  "app/__tests__/terminal-input.test.ts",
  "app/__tests__/terminal-mobile-header-row.test.ts",
  "app/__tests__/terminal-mobile-keyboard-layout.test.ts",
  "app/__tests__/versionCheck.test.ts",
  "app/__tests__/viewport-compensation-keyboard.test.ts",
];

const qualityAppHooksAndUtilsTests = [
  // Hooks and utilities are fast, user-visible state/formatting behavior.
  "app/context/**/*.test.tsx",
  "app/hooks/__tests__/{useAgents,useAgentLogs,useAgentLogs.resume-instrumentation,useAppSettings,useAuthOnboarding,useConfirm,useCurrentProject,useNavigationHistory,useNodes,useNodes.resume-instrumentation,useNodeSettingsSync,useProjects,useProjects.resume-instrumentation,useMeshState.resume-instrumentation,useManagedDockerNodes.resume-instrumentation,usePrChecksStream.resume-instrumentation,useDevServerLogs.resume-instrumentation,useResearch.resume-instrumentation,useBackgroundSessions.resume-instrumentation,useQuickChat,useTasks,useTasks.resume-instrumentation,useChatRooms,useTerminalSessions,useTheme,useToast,useUsageData,useViewportMode,useViewState,useMergeAdvanceNotice}.test.{ts,tsx}",
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
  "navigation-history",
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
  "RightDock",
  "SecretsView",
  "SecretsView.mobile",
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
  "TaskDetail.swipe-back",
  "TaskDetailModal",
  "TaskDetailModal.allow-resurrection",
  "TaskDetailModal.create-pr-e2e",
  "TaskDetailModal.custom-fields",
  "TaskDetailModal.inline-editing-and-integrations",
  "TestModeBanner",
  "TaskDetailModal.create-pr-integration",
  "TaskDetailModal.github-tracking-header",
  "TaskDetailModal.github-tracking-stale",
  "TaskDocumentsTab",
  "TaskFieldsSection",
  "TaskReviewTab",
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

// FNXC:DashboardTests 2026-06-25-10:10: SettingsModal stays isolated in its own
// project, but the 231-test suite is now 4 sibling files sharing
// SettingsModal.test-harness so the settings project parallelizes them across
// workers instead of one ~61s sequential file (FN-5048 feedback-loop velocity).
const isolatedQualityAppComponentTests = ["App"] as const;
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
/*
FNXC:DashboardTests 2026-06-25-16:30:
ChatView keeps its own isolated `dashboard-app-quality-chat` project, but the 231-test
ChatView.test.tsx is now 3 sibling files sharing ChatView.test-harness so the chat project
parallelizes them across workers instead of one ~24s sequential file (FN-5048 feedback-loop
velocity). Mirror the SettingsModal split: these 3 files live ONLY here (not in
qualityAppComponentTests), so they must be spread into backfillAppExclude too — otherwise
the broad `app/**` backfill glob re-collects them and they run in BOTH projects.
*/
const qualityAppChatOnlyTests = [
  "app/components/__tests__/ChatView.core.test.tsx",
  "app/components/__tests__/ChatView.sessions-rooms.test.tsx",
  "app/components/__tests__/ChatView.mobile.test.tsx",
  // FNXC:DashboardTests 2026-06-29-14:14: Task-detail chat typography regressions must run in the same chat quality lane as the required FN-7240 targeted command, so CSS-content assertions cannot fall through to broad backfill only.
  "app/components/__tests__/TaskChatTab.test.tsx",
];
const qualityAppSettingsOnlyTests = [
  "app/components/__tests__/SettingsModal.general.test.tsx",
  "app/components/__tests__/SettingsModal.models-auth.test.tsx",
  "app/components/__tests__/SettingsModal.scheduling-merge.test.tsx",
  "app/components/__tests__/SettingsModal.remote-notifications.test.tsx",
];
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

FNXC:DashboardTestQuarantine 2026-06-17-16:12:
FN-6593 deletes github-tracking-hook under the ratchet because the temp-cleanup ENOTEMPTY flake did not have a non-appeasement root-cause fix in this follow-up.
Keep the ledger entry and exclude removed together; git history remains the archive for this dropped GitHub tracking hook coverage.

FNXC:DashboardTestQuarantine 2026-06-18-06:12:
FN-6633 workspace verification observed unrelated QuickEntryBox focus and chat-routes SSE lifecycle flakes after the targeted chat prompt regression suite passed.
Quarantine the files under the deletion ratchet so this prompt-only chat guidance change does not appease flaky timing/focus behavior.

FNXC:DashboardTestQuarantine 2026-06-18-09:02:
FN-6642 rescued QuickEntryBox after the single-file and full app-backfill lanes passed with the exclude removed.
Keep QuickEntryBox out of this list so focus-restoration coverage remains active instead of deleting useful user-facing behavior coverage.

FNXC:DashboardTestQuarantine 2026-06-18-09:07:
FN-6642 rescued chat-routes by fixing the shared engine mock to return an iterable chat-task-document tool list during broad API lanes.
Keep chat-routes out of this list so SSE lifecycle coverage remains active and the ledger/config stay in lockstep.

FNXC:DashboardTestQuarantine 2026-06-19-03:22:
FN-6690 workspace verification observed session-cross-tab fail only during the broad dashboard API backfill shard with temp-directory cleanup ENOTEMPTY, then pass on isolated rerun.
Quarantine the cleanup-flaky file under the deletion ratchet rather than changing timing or session-locking behavior outside the lazy-view CSS chunk scope.

FNXC:DashboardTestQuarantine 2026-06-19-05:20:
FN-6697 workspace verification observed the QuickEntryBox post-submit focus restoration test fail only in the broad dashboard app backfill shard, then pass on targeted rerun.
Quarantine the focus-timing flake under the deletion ratchet instead of changing unrelated terminal shortcut behavior or appeasing the test.

FNXC:DashboardTestQuarantine 2026-06-19-08:17:
FN-6726 workspace verification observed the WorkflowNodeEditor duplicate-merge-seam template conflict test fail only in the broad components-b shard, then pass on targeted rerun.
Quarantine the concurrency-sensitive workflow editor file under the deletion ratchet instead of changing unrelated template insertion behavior or appeasing the test.

FNXC:DashboardTestQuarantine 2026-06-19-18:12:
FN-6744 rescued WorkflowNodeEditor before the 2026-07-03 deletion deadline by deriving duplicate-fragment seam conflicts from the active workflow IR plus React Flow nodes.
Keep it out of this exclude list so desktop and mobile template guards continue proving duplicate merge seams surface an inline alert with no insertion under components-b shard load.

FNXC:DashboardTestQuarantine 2026-06-19-15:40:
FN-6742 rescued session-cross-tab before the 2026-07-03 deletion ratchet by reproducing ENOTEMPTY in dashboard-api-quality-backfill and fixing the test-owned route/close-callback teardown seam.
Keep it out of this exclude list so loaded API shards keep exercising cross-tab locking, beacon release, stale-lock expiry, SSE summaries, and stale-session cleanup.

FNXC:DashboardTestQuarantine 2026-06-19-16:50:
FN-6743 rescued QuickEntryBox's third quarantine cycle by replacing the ref-gated post-submit focus effect with a resolved-submit focus trigger and broadening desktop/mobile submit coverage.
Keep QuickEntryBox out of this list so the dashboard app lanes exercise Enter, Save, duplicate-confirmed creation, mobile non-focus, and failure-preserves-draft focus invariants.

FNXC:DashboardTestQuarantine 2026-06-21-06:50:
FN-6722 workspace verification observed dev-server-process time out only in the broad dashboard API backfill shard while the isolated file passed immediately. Quarantine the process/timer race under the deletion ratchet instead of widening waits or changing unrelated Command Center behavior.

FNXC:DashboardTestQuarantine 2026-06-21-12:42:
FN-6860 rescued dev-server-process by settling stdout detection and fallback-probe lifecycle work before stop/close/failure teardown, then removed its ledger/config quarantine entry. The same loaded API shard also confirmed FN-6742's session-cross-tab rescue still holds, so its stale ledger-only entry was removed to restore lockstep.

FNXC:DashboardTestQuarantine 2026-06-22-18:05:
FN-6937 verified that FN-6860's claimed session-cross-tab ledger removal had not landed: the file was active because this exclude list was empty, but `test-quarantine.json` still carried the stale 2026-06-19 row. The repeated loaded `dashboard-api-quality-backfill` runs and lock-holder mutation proof confirmed FN-6742's rescue still holds, so remove the orphaned ledger row and keep this list empty to restore ledger↔config lockstep.

FNXC:DashboardTestQuarantine 2026-06-25-11:15:
The SQLite-to-PostgreSQL cutover (feature quarantine-sqlite-internals-tests) quarantines dashboard test files that exercise SQLite-only behavior. knowledge-index.test.ts asserts the knowledge_pages schema via PRAGMA table_info and sqlite_master on the SQLite store, with no PostgreSQL equivalent at this layer. Mirrored in scripts/lib/test-quarantine.json; will be DELETED when the SQLite code is removed.
*/
/*
FNXC:DashboardTestQuarantine 2026-07-14-07:15:
The 16 dashboard test files quarantined on 2026-06-25 (cutover batch) were
deleted per the AGENTS.md deletion ratchet (14 days expired, not rescued).
Ledger entries removed from scripts/lib/test-quarantine.json in the same commit.
The array stays empty; add new entries here only with a matching ledger row.

FNXC:DashboardTestQuarantine 2026-07-16-09:00:
FN-8077 removed routes-system.test.ts from this list and the ledger in lockstep. Its test now explicitly advances a fake Date-only clock between CPU samples, so unrelated route clock reads cannot stretch elapsed time under the loaded API lane; assertions and timeout policy are unchanged.
*/
const quarantinedDashboardTests: string[] = [
  /*
  FNXC:DashboardTestQuarantine 2026-07-17-16:50:
  FN-8245 re-admits all three UI files with their ledger rows removed in lockstep.
  QuickEntryBox restores focus from its resolved submit path while isolated jsdom
  globals prevent cross-file focus leakage; PlanningModeModal stream doubles use
  deterministic microtasks instead of wall-clock timers; and the oversight menu
  focuses its first button after the opening frame, never the native select.
  */
  /*
  FNXC:DashboardTests 2026-07-17-22:10:
  FN-8240 verified the 18 VAL-REMOVAL-005 dashboard API tests on their PG-backed
  async-store or applicable mock/non-store contracts. Remove their ledger/exclude
  pairs so dashboard-api-quality-backfill collects the restored coverage.
  */
  /*
  FNXC:DashboardTestQuarantine 2026-07-18-14:05:
  Full-suite shard 2 (run 29660321240): Terminal-guard tab settle race under
  dashboard-app-quality-backfill load; passes focused thrice with no product bug.
  Quarantine on sight — mirrored in scripts/lib/test-quarantine.json.
  */
  "app/components/__tests__/TaskDetailModal.tab-persistence.test.tsx",
];

const qualityApiTests = [
  // Critical HTTP/server behavior: auth, task/project/settings mutation,
  // git/GitHub, agents, nodes, chat/files, realtime, and isolation guards.
  /*
  FNXC:DashboardTests 2026-06-19-22:14:
  FN-6753 observed routes-auth timing out only under the broad API backfill shard, while five loaded local shard runs did not expose a concrete probe-spy or teardown root cause.
  Keep this auth-critical suite in the curated API shard so its assertions remain active without running inside the contended broad backfill glob.
  */
  "src/__tests__/{api-error,auth-middleware,auth-middleware-integration,chat-attachment-routes,chat-manager,chat-routes,file-service,github,github-webhooks,initialize,planning-flow-diagnostics-guardrail,pr-routes-auto-merge,pr-routes.contract,project-routes,project-store-resolver,register-git-github.pr-options-preflight-metadata,register-git-github.pr-resolve-conflicts,remote-access-routes,remote-auth,routes-agent-budget,routes-agent-keys,routes-agent-permissions,routes-agent-ratings,routes-agent-runs,routes-agent-soul-memory,routes-agents,routes-auth,routes-automation,routes-branch-groups,routes-git,routes-github,routes-merge-advance-push-origin,routes-nodes,routes-nodes-sync-contract,routes-planning,routes-plugin-registry,routes-secrets-sync,routes-settings,routes-task-commit-associations,routes-tasks,routes-tasks-deterministic-dedup,routes-tasks-duplicate-check,routes-tasks-explicit-duplicate-marker,server,server-static-assets,server-webhook,server.events,setup-routes,sse,sse-buffer,test-isolation-guard,update-check-route,websocket,recover-branch-binding-route}.test.ts",
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
  /*
  FNXC:DashboardTests 2026-06-25-10:40:
  The SettingsModal split removed the bare "SettingsModal" entry from
  qualityAppComponentTests, which is what previously excluded the curated
  settings file from the broad app backfill (via qualityAppTests). The 4 split
  files live only in qualityAppSettingsOnlyTests, so spread them here too —
  otherwise the backfill `app/**` glob re-collects them and they run in BOTH the
  settings project and backfill, doubling their wall-time instead of halving it.
  */
  ...qualityAppSettingsOnlyTests,
  // FNXC:DashboardTests 2026-06-25-16:30: same rationale as the settings split above —
  // the 3 ChatView split files live only in qualityAppChatOnlyTests, so exclude them from
  // the broad app backfill to avoid double-collection.
  ...qualityAppChatOnlyTests,
  ...skipListDashboardGlobs.filter((file) => file.startsWith("app/")),
  "app/__tests__/build-output.test.ts",
];
const qualityAppBackfillTests = ["app/**/*.test.{ts,tsx}"];

const backfillApiExclude = [
  ...qualityApiTests,
  /*
  FNXC:DashboardDistArtifacts 2026-07-17-15:10:
  FN-8245 reclassified plugin-registry-dist as a curated skip-list build-only
  assertion, not a flake. Keep this lane exclusion: test:build supplies its
  required emitted dist artifact without making every API backfill shard build.
  */
  "src/__tests__/plugin-registry-dist.test.ts",
  ...skipListDashboardGlobs.filter((file) => file.startsWith("src/")),
];
const qualityApiBackfillTests = ["src/**/*.test.{ts,tsx}"];

// The broad `dashboard-app` / `dashboard-api` lanes fully duplicate the curated
// shards + backfill projects, which already partition app/ and src/ exactly
// once. They exist ONLY as the explicit deep escape hatches
// (`test:deep`/`test:app`/`test:api`/`test:build`). In the DEFAULT no-`--project`
// run — e.g. `vitest run --changed` from `pnpm test` — letting their globs match
// re-executes every test a second time (and, with the now-removed umbrella, a
// third). Gate their includes on FUSION_DASHBOARD_DEEP so the default run uses
// the curated partition once; the deep scripts set the flag to opt back in.
const deepLaneEnabled = process.env.FUSION_DASHBOARD_DEEP === "1";
const deepAppInclude = deepLaneEnabled ? ["app/**/*.test.{ts,tsx}"] : [];
const deepApiInclude = deepLaneEnabled ? ["src/**/*.test.{ts,tsx}"] : [];

// Footgun guard: with the deep lanes gated off, selecting one explicitly
// (`vitest run --project dashboard-app`) matches zero files and exits green in
// milliseconds — a silent no-op that reads as a passing run. Warn loudly so a
// manual invocation isn't mistaken for coverage. Exact token match avoids firing
// on the curated `dashboard-app-*` shard projects. The deep scripts set
// FUSION_DASHBOARD_DEEP=1, so this never fires through the intended entry points.
if (!deepLaneEnabled) {
  const selectedProjects = process.argv.flatMap((arg, index) =>
    arg === "--project"
      ? [process.argv[index + 1]]
      : arg.startsWith("--project=")
        ? [arg.slice("--project=".length)]
        : [],
  );
  if (selectedProjects.some((name) => name === "dashboard-app" || name === "dashboard-api")) {
    console.warn(
      "[dashboard/vitest] --project dashboard-app/dashboard-api selected without FUSION_DASHBOARD_DEEP=1: " +
        "these deep lanes are empty by default and will match zero test files. " +
        "Use the test:app / test:api / test:deep / test:build scripts, which set the flag.",
    );
  }
}

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
      /*
      FNXC:GitHubImportTranslate 2026-07-15-09:30:
      Must precede the `@fusion/core` alias: Vite string aliases match by PREFIX, so the broader key would rewrite this subpath to `index.ts/detect-content-language` and fail to resolve.
      */
      "@fusion/core/detect-content-language": resolve(__dirname, "../core/src/detect-content-language.ts"),
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
      "@fusion/engine": resolve(__dirname, "../engine/src/index.ts"),
      "@fusion/plugin-sdk": resolve(__dirname, "../plugin-sdk/src/index.ts"),
      "@fusion/test-utils": resolve(__dirname, "../core/src/__test-utils__/workspace.ts"),
      "@fusion/dashboard/app/components/TaskCard": resolve(__dirname, "app/components/TaskCard.tsx"),
      "@fusion/dashboard/app/components/ViewHeader": resolve(__dirname, "app/components/ViewHeader.tsx"),
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
      "@fusion-plugin-examples/quality/dashboard-view": resolve(
        __dirname,
        "../../plugins/fusion-plugin-quality/src/dashboard-view.tsx",
      ),
      "@fusion-plugin-examples/quality/qa-tab": resolve(
        __dirname,
        "../../plugins/fusion-plugin-quality/src/qa-tab.tsx",
      ),
      "@fusion-plugin-examples/quality": resolve(
        __dirname,
        "../../plugins/fusion-plugin-quality/src/index.ts",
      ),
      "@fusion-plugin-examples/linear-import/dashboard-view": resolve(
        __dirname,
        "../../plugins/fusion-plugin-linear-import/src/dashboard-view.tsx",
      ),
      "@fusion-plugin-examples/linear-import": resolve(
        __dirname,
        "../../plugins/fusion-plugin-linear-import/src/index.ts",
      ),
      /*
      FNXC:PluginTests 2026-07-03-12:30:
      runtime-provider-probes.ts imports probeCursorBinary from @fusion-plugin-examples/cursor-runtime. Without these source aliases, Vite tries to resolve the package's dist/ exports which don't exist in a source checkout, causing every dashboard test that transitively imports the runtime provider to fail with "Failed to resolve entry for package".
      */
      "@fusion-plugin-examples/cursor-runtime/probe": resolve(
        __dirname,
        "../../plugins/fusion-plugin-cursor-runtime/src/probe.ts",
      ),
      "@fusion-plugin-examples/cursor-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-cursor-runtime/src/index.ts",
      ),
      /*
      FNXC:GrokCli 2026-07-08-00:00:
      runtime-provider-probes.ts imports probeGrokBinary from @fusion-plugin-examples/grok-runtime (FN-7705, mirroring the Cursor alias above). Without these source aliases, Vite tries to resolve the package's dist/ exports which don't exist in a source checkout.
      */
      "@fusion-plugin-examples/grok-runtime/probe": resolve(
        __dirname,
        "../../plugins/fusion-plugin-grok-runtime/src/probe.ts",
      ),
      "@fusion-plugin-examples/grok-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-grok-runtime/src/index.ts",
      ),
      /*
      FNXC:DashboardTests 2026-07-18-09:45:
      Alias Claude runtime to probes-entry (probe + model discovery only), not the full
      ACP index — same class as CLI #2292. Importing index pulls @agentclientprotocol/sdk
      and breaks dashboard-api-quality under source-checkout full-suite resolution.
      */
      "@fusion-plugin-examples/claude-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-claude-runtime/src/probes-entry.ts",
      ),
      "@fusion-plugin-examples/claude-runtime/probe": resolve(
        __dirname,
        "../../plugins/fusion-plugin-claude-runtime/src/probe.ts",
      ),
      /*
      FNXC:OmpAcp 2026-07-11-23:35:
      runtime-provider-probes.ts imports probeOmpBinary from @fusion-plugin-examples/omp-runtime.
      Source aliases avoid missing dist/ on a source checkout.
      */
      "@fusion-plugin-examples/omp-runtime/probe": resolve(
        __dirname,
        "../../plugins/fusion-plugin-omp-runtime/src/probe.ts",
      ),
      "@fusion-plugin-examples/omp-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-omp-runtime/src/index.ts",
      ),
      "@fusion-plugin-examples/roadmap/roadmap-suggestions": resolve(
        __dirname,
        "../../plugins/fusion-plugin-roadmap/src/roadmap-suggestions.ts",
      ),
      "@fusion-plugin-examples/roadmap": resolve(
        __dirname,
        "../../plugins/fusion-plugin-roadmap/src/index.ts",
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
      // NOTE: the former `dashboard-app-quality` umbrella project was removed —
      // it re-ran the exact union of the eight curated shards below (a 3rd copy
      // of every curated app test in the default no-`--project` run). The shards
      // partition `qualityAppTests` exactly; `dashboardQualityProjectGlobs` and
      // scripts/lib/test-inventory-spec.json never referenced the umbrella.
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
          // Empty unless FUSION_DASHBOARD_DEEP=1 (deep escape hatch). Keeps this
          // broad lane out of the default run so it doesn't duplicate the
          // curated shards + backfill, while remaining selectable via --project.
          include: deepAppInclude,
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
          // Empty unless FUSION_DASHBOARD_DEEP=1 (deep escape hatch); see the
          // dashboard-app note above.
          include: deepApiInclude,
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
