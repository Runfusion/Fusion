export const EXPERIMENT_SESSION_STATUSES = ["active", "finalizing", "finalized", "archived"] as const;
export type ExperimentSessionStatus = typeof EXPERIMENT_SESSION_STATUSES[number];

export const EXPERIMENT_METRIC_DIRECTIONS = ["maximize", "minimize"] as const;
export type ExperimentMetricDirection = typeof EXPERIMENT_METRIC_DIRECTIONS[number];

export interface ExperimentMetricDefinition {
  name: string;
  unit?: string;
  direction: ExperimentMetricDirection;
  description?: string;
}

export const EXPERIMENT_RECORD_TYPES = ["config", "run", "hook", "finalize"] as const;
export type ExperimentRecordType = typeof EXPERIMENT_RECORD_TYPES[number];

export const EXPERIMENT_RUN_OUTCOMES = ["keep", "discard", "checks_failed", "errored", "pending"] as const;
export type ExperimentRunOutcome = typeof EXPERIMENT_RUN_OUTCOMES[number];

export interface ExperimentSecondaryMetric {
  name: string;
  value: number;
  unit?: string;
}

export interface ExperimentRunRecordPayload {
  commit?: string;
  primaryMetric: number;
  secondaryMetrics: ExperimentSecondaryMetric[];
  status: ExperimentRunOutcome;
  description?: string;
  confidence?: number;
  asi?: Record<string, unknown>;
  durationMs?: number;
}

export interface ExperimentConfigRecordPayload {
  metric: ExperimentMetricDefinition;
  maxIterations?: number;
  rules?: string;
  ideas?: string;
  workingDir?: string;
}

export interface ExperimentHookRecordPayload {
  hook: "before" | "after";
  exitCode: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  steerMessage?: string;
}

export interface ExperimentFinalizeRecordPayload {
  keptRunIds: string[];
  discardedRunIds: string[];
  branches?: Array<{ name: string; baseCommit?: string; tipCommit?: string }>;
  summary?: string;
}

export interface ExperimentSessionRecordBase {
  id: string;
  sessionId: string;
  segment: number;
  seq: number;
  createdAt: string;
}

export interface ExperimentConfigRecord extends ExperimentSessionRecordBase {
  type: "config";
  payload: ExperimentConfigRecordPayload;
}

export interface ExperimentRunRecord extends ExperimentSessionRecordBase {
  type: "run";
  payload: ExperimentRunRecordPayload;
}

export interface ExperimentHookRecord extends ExperimentSessionRecordBase {
  type: "hook";
  payload: ExperimentHookRecordPayload;
}

export interface ExperimentFinalizeRecord extends ExperimentSessionRecordBase {
  type: "finalize";
  payload: ExperimentFinalizeRecordPayload;
}

export type ExperimentSessionRecord =
  | ExperimentConfigRecord
  | ExperimentRunRecord
  | ExperimentHookRecord
  | ExperimentFinalizeRecord;

export function isRunRecord(record: ExperimentSessionRecord): record is ExperimentRunRecord {
  return record.type === "run";
}

export function isConfigRecord(record: ExperimentSessionRecord): record is ExperimentConfigRecord {
  return record.type === "config";
}

export function isHookRecord(record: ExperimentSessionRecord): record is ExperimentHookRecord {
  return record.type === "hook";
}

export function isFinalizeRecord(record: ExperimentSessionRecord): record is ExperimentFinalizeRecord {
  return record.type === "finalize";
}

export interface ExperimentSession {
  id: string;
  name: string;
  projectId?: string;
  status: ExperimentSessionStatus;
  metric: ExperimentMetricDefinition;
  currentSegment: number;
  maxIterations?: number;
  workingDir?: string;
  baselineRunId?: string;
  bestRunId?: string;
  keptRunIds: string[];
  tags: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
}

export interface ExperimentSessionCreateInput {
  name: string;
  projectId?: string;
  status?: ExperimentSessionStatus;
  metric: ExperimentMetricDefinition;
  currentSegment?: number;
  maxIterations?: number;
  workingDir?: string;
  baselineRunId?: string;
  bestRunId?: string;
  keptRunIds?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  finalizedAt?: string;
}

export interface ExperimentSessionUpdateInput {
  name?: string;
  projectId?: string;
  status?: ExperimentSessionStatus;
  metric?: ExperimentMetricDefinition;
  currentSegment?: number;
  maxIterations?: number;
  workingDir?: string;
  baselineRunId?: string;
  bestRunId?: string;
  keptRunIds?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  finalizedAt?: string;
}

export interface ExperimentSessionRecordAppendInput {
  segment?: number;
  type: ExperimentRecordType;
  payload:
    | ExperimentRunRecordPayload
    | ExperimentConfigRecordPayload
    | ExperimentHookRecordPayload
    | ExperimentFinalizeRecordPayload;
}

export interface ExperimentSessionListOptions {
  status?: ExperimentSessionStatus;
  projectId?: string;
  tag?: string;
  limit?: number;
  offset?: number;
  search?: string;
}

export interface ExperimentSessionStoreEvents {
  "session:created": [ExperimentSession];
  "session:updated": [ExperimentSession];
  "session:deleted": [string];
  "session:status_changed": [ExperimentSession];
  "session:finalized": [ExperimentSession];
  "record:appended": [ExperimentSessionRecord];
  "segment:reset": [{ sessionId: string; segment: number }];
}
