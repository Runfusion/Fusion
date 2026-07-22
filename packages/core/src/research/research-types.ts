/**
 * Research Domain Types
 *
 * Contracts for Fusion-native research run persistence.
 */

export const RESEARCH_RUN_STATUSES = [
  "queued",
  "running",
  "cancelling",
  "retry_waiting",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "retry_exhausted",
] as const;

export type ResearchRunStatus = typeof RESEARCH_RUN_STATUSES[number];

export const RESEARCH_SOURCE_STATUSES = [
  "pending",
  "fetching",
  "completed",
  "failed",
] as const;

export type ResearchSourceStatus = typeof RESEARCH_SOURCE_STATUSES[number];

export const RESEARCH_EXPORT_FORMATS = ["json", "markdown", "pdf"] as const;

export type ResearchExportFormat = typeof RESEARCH_EXPORT_FORMATS[number];

export const RESEARCH_SOURCE_TYPES = ["web", "github", "local", "llm", "other"] as const;

export type ResearchSourceType = typeof RESEARCH_SOURCE_TYPES[number];

export const RESEARCH_EVENT_TYPES = [
  "info",
  "warning",
  "error",
  "source_added",
  "result_updated",
  "progress",
  "status_changed",
  "retry_scheduled",
  "cancel_requested",
  "timeout",
] as const;

export type ResearchEventType = typeof RESEARCH_EVENT_TYPES[number];

export const RESEARCH_RUN_FAILURE_CLASSES = [
  "cancelled",
  "timed_out",
  "retryable_transient",
  "non_retryable",
] as const;

export const RESEARCH_ERROR_CODES = [
  "FEATURE_DISABLED",
  "MISSING_CREDENTIALS",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "RUN_CANCELLED",
  "RETRY_EXHAUSTED",
  "INVALID_TRANSITION",
  "NON_RETRYABLE_PROVIDER_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ResearchErrorCode = typeof RESEARCH_ERROR_CODES[number];

export type ResearchRunFailureClass = typeof RESEARCH_RUN_FAILURE_CLASSES[number];

export interface ResearchRunLifecycle {
  terminalReason?: "completed" | "cancelled" | "failed" | "timed_out" | "retry_exhausted";
  terminalCause?: string;
  failureClass?: ResearchRunFailureClass;
  errorCode?: ResearchErrorCode;
  retryable?: boolean;
  retryAfterMs?: number;
  cancellationRequestedAt?: string;
  timeoutAt?: string;
  retryOfRunId?: string;
  rootRunId?: string;
  attempt?: number;
  maxAttempts?: number;
}

export interface ResearchRunEvent {
  id: string;
  runId: string;
  seq: number;
  type: ResearchEventType;
  message: string;
  status?: ResearchRunStatus;
  classification?: ResearchRunFailureClass;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ResearchSource {
  id: string;
  type: ResearchSourceType;
  reference: string;
  title?: string;
  content?: string;
  excerpt?: string;
  metadata?: Record<string, unknown>;
  status: ResearchSourceStatus;
  fetchedAt?: string;
  error?: string;
}

export interface ResearchEvent {
  id: string;
  timestamp: string;
  type: ResearchEventType;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * FNXC:ResearchMissionBridge 2026-07-18-12:00:
 * A finding identity must be stable when providers reorder synthesis output. It
 * is intentionally derived from finding-owned content and cited URLs, never an
 * array position, so every promotion surface can reuse the same roadmap work.
 */
export function resolveResearchFindingId(finding: Pick<ResearchFinding, "heading" | "content" | "sources"> & { id?: unknown }): string {
  const explicitId = typeof finding.id === "string" ? finding.id.trim() : "";
  if (explicitId) return explicitId;
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const canonical = [normalize(finding.heading ?? ""), normalize(finding.content ?? ""), ...[...(finding.sources ?? [])].map(normalize).filter(Boolean).sort()].join("\n");
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `finding-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface ResearchFinding {
  /** Optional provider-persisted identity; legacy findings use resolveResearchFindingId. */
  id?: string;
  heading: string;
  content: string;
  sources: string[];
  /**
   * Synthesis-emitted confidence in [0,1] from the LLM response.
   * NOT a statistical MAD confidence score.
   */
  confidence?: number;
}

export interface ResearchResult {
  summary?: string;
  findings: ResearchFinding[];
  citations?: string[];
  synthesizedOutput?: string;
}

export interface ResearchTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
}

/**
 * A cited-search/synthesis run persisted by Fusion Research.
 * Not an upstream pi-autoresearch experiment session.
 * See docs/research/naming-decision-2026-05.md.
 */
export interface ResearchRun {
  id: string;
  query: string;
  topic?: string;
  status: ResearchRunStatus;
  projectId?: string;
  trigger?: string;
  providerConfig?: Record<string, unknown>;
  sources: ResearchSource[];
  events: ResearchEvent[];
  results?: ResearchResult;
  error?: string;
  tokenUsage?: ResearchTokenUsage;
  tags: string[];
  metadata?: Record<string, unknown>;
  lifecycle?: ResearchRunLifecycle;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface ResearchExport {
  id: string;
  runId: string;
  format: ResearchExportFormat;
  content: string;
  filePath?: string;
  createdAt: string;
}

export interface ResearchRunCreateInput {
  query: string;
  topic?: string;
  projectId?: string;
  trigger?: string;
  providerConfig?: Record<string, unknown>;
  sources?: ResearchSource[];
  events?: ResearchEvent[];
  results?: ResearchResult;
  tags?: string[];
  metadata?: Record<string, unknown>;
  lifecycle?: ResearchRunLifecycle;
}

export interface ResearchRunUpdateInput {
  query?: string;
  topic?: string;
  status?: ResearchRunStatus;
  projectId?: string;
  trigger?: string;
  providerConfig?: Record<string, unknown>;
  sources?: ResearchSource[];
  events?: ResearchEvent[];
  results?: ResearchResult;
  error?: string | null;
  tokenUsage?: ResearchTokenUsage;
  tags?: string[];
  metadata?: Record<string, unknown>;
  lifecycle?: ResearchRunLifecycle;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
}

export interface ResearchRunListOptions {
  status?: ResearchRunStatus;
  fromDate?: string;
  toDate?: string;
  tag?: string;
  limit?: number;
  offset?: number;
  search?: string;
}

export interface ResearchStoreEvents {
  "run:created": [ResearchRun];
  "run:updated": [ResearchRun];
  "run:deleted": [string];
  "run:status_changed": [ResearchRun];
  "run:completed": [ResearchRun];
  "run:failed": [ResearchRun];
  "run:cancelled": [ResearchRun];
  "run:timed_out": [ResearchRun];
  "event:added": [{ runId: string; event: ResearchEvent }];
  "source:added": [{ runId: string; source: ResearchSource }];
}

export const RESEARCH_ORCHESTRATION_PHASES = [
  "planning",
  "searching",
  "fetching",
  "synthesizing",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ResearchOrchestrationPhase = typeof RESEARCH_ORCHESTRATION_PHASES[number];

export const RESEARCH_ORCHESTRATION_STEP_STATUSES = ["pending", "running", "completed", "failed", "skipped"] as const;

export type ResearchOrchestrationStepStatus = typeof RESEARCH_ORCHESTRATION_STEP_STATUSES[number];

export type ResearchOrchestrationStepType = "source-query" | "content-fetch" | "synthesis-pass";

export interface ResearchOrchestrationStep {
  id: string;
  type: ResearchOrchestrationStepType;
  phase: ResearchOrchestrationPhase;
  status: ResearchOrchestrationStepStatus;
  order: number;
  name: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export type ResearchOrchestrationEventType =
  | "phase-changed"
  | "step-started"
  | "step-completed"
  | "step-failed"
  | "source-found"
  | "synthesis-progress"
  | "run-cancelled";

export interface ResearchOrchestrationEvent {
  type: ResearchOrchestrationEventType;
  phase: ResearchOrchestrationPhase;
  message: string;
  stepId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ResearchProviderConfig {
  timeoutMs?: number;
  rateLimitPerMinute?: number;
  maxResults?: number;
  metadata?: Record<string, unknown>;
}

export interface ResearchOrchestrationProvider {
  type: string;
  config?: ResearchProviderConfig;
}

export interface ResearchModelSettings {
  provider?: string;
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ResearchOrchestrationConfig {
  providers: ResearchOrchestrationProvider[];
  /**
   * Bounds source fan-out within a single cited-research run.
   * NOT an experiment-iteration cap.
   */
  maxSources: number;
  /**
   * Bounds synthesis passes within a single cited-research run.
   * NOT an experiment-iteration cap.
   */
  maxSynthesisRounds: number;
  phaseTimeoutMs?: number;
  stepTimeoutMs?: number;
  rateLimitPerMinute?: number;
  synthesisModel?: ResearchModelSettings;
  metadata?: Record<string, unknown>;
}

export interface ResearchSynthesisRequest {
  query: string;
  sources: ResearchSource[];
  round: number;
  desiredFormat?: "markdown" | "json" | "bullets";
  instructions?: string;
}

export interface ResearchSynthesisResult {
  output: string;
  citations: string[];
  confidence?: number;
  usage?: ResearchTokenUsage;
  metadata?: Record<string, unknown>;
}

export interface ResearchCancellationState {
  runId: string;
  controller: AbortController;
  requestedAt: string;
  acknowledgedAt?: string;
  gracefulShutdown: boolean;
  reason?: string;
}
