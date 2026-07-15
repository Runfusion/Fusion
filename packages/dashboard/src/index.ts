export { createServer, loadTlsCredentialsFromEnv, type ServerOptions } from "./server.js";
export {
  refreshAllCustomProviderModels,
  refreshCustomProviderModels,
  type RefreshAllCustomProviderModelsResult,
  type RefreshCustomProviderModelsResult,
} from "./routes/register-custom-provider-routes.js";
export { stopAllDevServers, destroyAllDevServerManagers, getActiveProcessManagers } from "./dev-server-routes.js";
export {
  createRuntimeLogger,
  getRuntimeLogSink,
  resetRuntimeLogSink,
  setRuntimeLogSink,
  type RuntimeLogContext,
  type RuntimeLogger,
  type RuntimeLogLevel,
  type RuntimeLogSink,
} from "./runtime-logger.js";
export { createSkillsAdapter, getProjectSettingsPath, type SkillsAdapter, type DiscoveredSkill, type CatalogEntry, type CatalogFetchResult, type ToggleSkillResult, type UpstreamError, type UpstreamErrorCode, type SkillContent, type SkillFileEntry, type SkillFileContent } from "./skills-adapter.js";
export { GitHubClient, isPrMergeReady, closeGroupPullRequest, reconcileGroupPullRequest, type GitHubClientOptions, type PrMergeStatus, type PrCheckStatus, type ReviewDecision, type MergePrParams, type UpdatePrParams, type ClosePrParams, type FindPrParams, type CreateIssueParams, type CreatedIssue, type CreateGroupPrResult } from "./github.js";
export { generatePrMetadata, type GeneratedPrMetadata } from "./pr-metadata-generator.js";
export {
  resolvePrConflicts,
  type ResolvePrConflictsInput,
  type ResolvePrConflictsResult,
} from "./pr-conflict-resolver.js";
export { maybeCreateTrackingIssue, type MaybeCreateTrackingIssueDeps } from "./github-tracking.js";
export {
  buildIssueSearchQueries,
  DEDUP_MATCH_THRESHOLD,
  extractFileScopePaths,
  extractSymptomKeywords,
  scoreCandidateIssue,
} from "./github-tracking-dedup.js";
export { registerGithubTrackingHook } from "./github-tracking-hook.js";
export {
  GitLabClient,
  GitLabApiError,
  buildGitLabTaskDescription,
  buildGitLabTaskProvenance,
  isGitLabAlreadyImported,
  type GitLabIssue,
  type GitLabMergeRequest,
  type GitLabResourceType,
} from "./gitlab.js";
export {
  resolveGitlabAuth,
  type ResolvedGitlabAuth,
  type GitlabAuthResolution,
} from "./gitlab-auth.js";
export {
  resolveGithubTrackingAuth,
  type GithubTrackingAuth,
  type GithubTrackingAuthResolution,
  type ResolveGithubTrackingAuthDeps,
} from "./github-auth.js";
export { rateLimit, RATE_LIMITS, type RateLimitOptions } from "./rate-limit.js";
export { GitHubPollingService, type GitHubPollingServiceOptions, type TaskWatchInput, type WatchedBadgeType } from "./github-poll.js";
export { GitHubIssueCommentService, DEFAULT_COMMENT_TEMPLATE } from "./github-issue-comment.js";
export { GitHubSourceIssueCloseService } from "./github-source-issue-close.js";
export {
  upsertKnowledgePageAsync,
  queryKnowledgePagesAsync,
  countKnowledgePagesAsync,
  refreshKnowledgeForTask,
  renderTaskPage,
  buildSearchText,
  tokenizeQuery,
  KNOWLEDGE_QUERY_DEFAULT_LIMIT,
  KNOWLEDGE_QUERY_MAX_LIMIT,
  type KnowledgePage,
  type KnowledgePageInput,
  type KnowledgeSourceKind,
  type KnowledgeQueryOptions,
} from "./knowledge-index.js";
export { KnowledgeIndexRefreshService } from "./knowledge-index-refresh.js";
export {
  recordDeployment,
  ingestIncidentSignal,
  resolveIncident,
  getOpenIncidentByGroupingKey,
  getIncident,
  attachFixTask,
  decideStormGuard,
  countRecentAutoFixTasks,
  DEFAULT_STORM_GUARD,
  type Deployment,
  type DeploymentInput,
  type Incident,
  type IncidentSignalInput,
  type IncidentStatus,
  type StormGuardConfig,
  type StormGuardDecision,
} from "./monitor-store.js";
export {
  registerMonitorTrait,
  runMonitorOnRegression,
  isMonitorFixTask,
  MONITOR_TRAIT_ID,
  MONITOR_TRAIT_DEFINITION,
  MONITOR_FIX_ROUTE_COLUMN,
  type MonitorDeps,
  type MonitorRegressionOutcome,
} from "./monitor-trait.js";
export {
  registerMonitorRoutes,
  resolveMonitorIngestSecret,
  isAuthorizedMonitorIngest,
  MONITOR_INGEST_SECRET_ENV,
} from "./routes/monitor-routes.js";
export { GitHubTrackingCommentService, formatTrackingComment } from "./github-tracking-comments.js";
export { GitHubTrackingStateService, decideIssueAction } from "./github-tracking-state.js";
export { GitHubTrackingReconciler, RECONCILE_CONCURRENCY_LIMIT, RECONCILE_SCAN_LIMIT } from "./github-tracking-reconciler.js";
export { getCliPackageVersion, isUnresolvedCliPackageVersion, resolveCliPackageVersionInfo, type CliPackageVersionInfo } from "./cli-package-version.js";
export {
  ApiError,
  type ApiErrorResponse,
  type SendErrorOptions,
  sendErrorResponse,
  catchHandler,
  badRequest,
  unauthorized,
  notFound,
  conflict,
  rateLimited,
  internalError,
} from "./api-error.js";
export {
  type BadgePubSub,
  type BadgePubSubEvents,
  type BadgePubSubMessage,
  type BadgePubSubFactory,
  type BadgePubSubFactoryOptions,
  InMemoryBadgePubSub,
  RedisBadgePubSub,
  createBadgePubSub,
} from "./badge-pubsub.js";

export * from "./plugins/index.js";

// CLI-session terminal-output hardening — re-exported so the TUI passthrough
// (packages/cli, U14) applies the IDENTICAL neutralization set as the dashboard
// WS bridge (U10). The host TTY honors more escape sequences than xterm.js, so
// the TUI MUST reuse this single implementation rather than fork it.
export {
  neutralizeTerminalOutput,
  flushTerminalOutput,
  MAX_CARRY_LENGTH,
  type NeutralizeResult,
} from "./cli-session-output-filter.js";

// CLI Agent Executor transport dependencies — re-exported so the CLI boot
// (packages/cli dashboard command) can construct the per-session attach-ticket
// store, input-attribution log, and confirm-advance/relaunch registries that the
// cli-sessions transport routes require, then thread them into ServerOptions.
export {
  AttachTicketStore,
  CliInputAttributionLog,
  CliConfirmAdvanceRegistry,
  CliRelaunchRegistry,
  type CliSessionTransportDeps,
} from "./cli-session-transport.js";
