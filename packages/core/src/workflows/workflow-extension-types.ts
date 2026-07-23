import type { Task, TaskDetail } from "../types.js";
import type { WorkflowIr, WorkflowIrNode } from "./workflow-ir-types.js";

export const WORKFLOW_EXTENSION_SCHEMA_VERSION = 1 as const;

export type WorkflowExtensionFallback = "degradeToDefault" | "parkNeedsAttention" | "failClosed";

export type WorkflowExtensionKind =
  | "column-metadata"
  | "move-policy"
  | "work-engine"
  | "node-handler"
  | "verdict-provider"
  | "merge-fact-provider";

export interface WorkflowExtensionBaseContribution {
  extensionId: string;
  name: string;
  description?: string;
  schemaVersion: typeof WORKFLOW_EXTENSION_SCHEMA_VERSION;
  fallback: WorkflowExtensionFallback;
}

export interface WorkflowExtensionConfigField {
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "object" | "array";
  required?: boolean;
  enumValues?: readonly string[];
  description?: string;
}

export interface WorkflowExtensionConfigSchema {
  fields: WorkflowExtensionConfigField[];
}

export interface WorkflowColumnMetadataExtensionContribution extends WorkflowExtensionBaseContribution {
  kind: "column-metadata";
  configSchema?: WorkflowExtensionConfigSchema;
}

export type WorkflowMovePolicyDecision =
  | { allowed: true; reason?: string }
  | { allowed: false; reason: string; message: string };

export interface WorkflowMovePolicyInput {
  task: Task;
  workflow: WorkflowIr;
  fromColumn: string;
  toColumn: string;
  actor?: {
    kind: "human" | "agent" | "engine" | "system";
    id?: string;
  };
  source?: string;
  metadata?: Record<string, unknown>;
}

export type WorkflowMovePolicyHandler =
  (input: WorkflowMovePolicyInput) => Promise<WorkflowMovePolicyDecision> | WorkflowMovePolicyDecision;

export interface WorkflowMovePolicyExtensionContribution extends WorkflowExtensionBaseContribution {
  kind: "move-policy";
  evaluate?: WorkflowMovePolicyHandler;
  configSchema?: WorkflowExtensionConfigSchema;
}

export type WorkflowWorkEngineDispatchResult =
  | { kind: "not-claimed" }
  | { kind: "claimed"; runId?: string; message?: string }
  | { kind: "degraded-to-default"; reason: string }
  | { kind: "parked"; reason: string; message: string };

export interface WorkflowWorkEngineInput {
  task: TaskDetail;
  workflow: WorkflowIr;
  columnId: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type WorkflowWorkEngineHandler =
  (input: WorkflowWorkEngineInput) => Promise<WorkflowWorkEngineDispatchResult>;

export interface WorkflowWorkEngineExtensionContribution extends WorkflowExtensionBaseContribution {
  kind: "work-engine";
  dispatch?: WorkflowWorkEngineHandler;
  configSchema?: WorkflowExtensionConfigSchema;
}

export type WorkflowNodeExtensionResult =
  | { outcome: "success" | "failure"; value?: string; contextPatch?: Record<string, unknown> }
  | { outcome: `outcome:${string}`; value?: string; contextPatch?: Record<string, unknown> };

export interface WorkflowNodeHandlerInput {
  task: TaskDetail;
  workflow: WorkflowIr;
  node: WorkflowIrNode;
  context: Record<string, unknown>;
  signal?: AbortSignal;
}

export type WorkflowNodeExtensionHandler =
  (input: WorkflowNodeHandlerInput) => Promise<WorkflowNodeExtensionResult>;

export interface WorkflowNodeHandlerExtensionContribution extends WorkflowExtensionBaseContribution {
  kind: "node-handler";
  nodeKind?: string;
  handle?: WorkflowNodeExtensionHandler;
  configSchema?: WorkflowExtensionConfigSchema;
}

export type TaskVerdictStatus = "pass" | "fail" | "blocked" | "error" | "pending";

export interface TaskVerdictProviderInput {
  task: TaskDetail;
  workflow: WorkflowIr;
  reworkRound: number;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface TaskVerdictProviderResult {
  status: Exclude<TaskVerdictStatus, "pending">;
  summary: string;
  failureReasons?: Array<{ code: string; message: string }>;
  writerId?: string;
}

export type TaskVerdictProviderHandler =
  (input: TaskVerdictProviderInput) => Promise<TaskVerdictProviderResult>;

export interface TaskVerdictProviderExtensionContribution extends WorkflowExtensionBaseContribution {
  kind: "verdict-provider";
  evaluate?: TaskVerdictProviderHandler;
  configSchema?: WorkflowExtensionConfigSchema;
}

export type AutoMergeRoute = "auto-enqueue" | "workflow-subgraph" | "manual-required" | "blocked";

export interface AutoMergeFactProviderInput {
  task: TaskDetail;
  workflow: WorkflowIr;
  metadata?: Record<string, unknown>;
}

export interface AutoMergeFactProviderResult {
  route?: AutoMergeRoute;
  facts?: Record<string, unknown>;
  reason?: string;
}

export type AutoMergeFactProviderHandler =
  (input: AutoMergeFactProviderInput) => Promise<AutoMergeFactProviderResult> | AutoMergeFactProviderResult;

export interface AutoMergeFactProviderExtensionContribution extends WorkflowExtensionBaseContribution {
  kind: "merge-fact-provider";
  collect?: AutoMergeFactProviderHandler;
  configSchema?: WorkflowExtensionConfigSchema;
}

export type WorkflowExtensionContribution =
  | WorkflowColumnMetadataExtensionContribution
  | WorkflowMovePolicyExtensionContribution
  | WorkflowWorkEngineExtensionContribution
  | WorkflowNodeHandlerExtensionContribution
  | TaskVerdictProviderExtensionContribution
  | AutoMergeFactProviderExtensionContribution;

export interface WorkflowExtensionMetadata {
  extensionId: string;
  name: string;
  kind: WorkflowExtensionKind;
  description?: string;
}

export function workflowExtensionRegistryId(pluginId: string, extensionId: string): string {
  return `plugin:${pluginId}:${extensionId}`;
}
