/**
 * Research Domain Types
 *
 * Contracts for Fusion-native research run persistence.
 */

export const RESEARCH_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
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
] as const;

export type ResearchEventType = typeof RESEARCH_EVENT_TYPES[number];

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

export interface ResearchFinding {
  heading: string;
  content: string;
  sources: string[];
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

export interface ResearchRun {
  id: string;
  query: string;
  topic?: string;
  status: ResearchRunStatus;
  providerConfig?: Record<string, unknown>;
  sources: ResearchSource[];
  events: ResearchEvent[];
  results?: ResearchResult;
  error?: string;
  tokenUsage?: ResearchTokenUsage;
  tags: string[];
  metadata?: Record<string, unknown>;
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
  providerConfig?: Record<string, unknown>;
  sources?: ResearchSource[];
  events?: ResearchEvent[];
  results?: ResearchResult;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ResearchRunUpdateInput {
  query?: string;
  topic?: string;
  status?: ResearchRunStatus;
  providerConfig?: Record<string, unknown>;
  sources?: ResearchSource[];
  events?: ResearchEvent[];
  results?: ResearchResult;
  error?: string | null;
  tokenUsage?: ResearchTokenUsage;
  tags?: string[];
  metadata?: Record<string, unknown>;
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
  maxSources: number;
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
