/**
 * Shared agent tool factory functions.
 *
 * Extracted from TaskExecutor so they can be reused by other subsystems
 * (e.g., HeartbeatMonitor execution) without pulling in the full executor.
 *
 * The parameter schemas are canonical here — executor.ts imports and reuses them.
 */

import { appendFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as fusionCore from "@fusion/core";
import type { AgentState, AgentCapability, AgentUpdateInput, AgentLogEntry, Artifact, ArtifactCreateInput, ArtifactWithTask, Task, TaskDocument, TaskDocumentCreateInput, TaskStore, RunMutationContext, MessageStore, Message, SourceType, Settings, ResearchRun, ResearchRunStatus, TaskCreateInput, ReflectionStore, ApprovalRequestStore, ProjectSettings, ChatStore, WorkflowSettingDefinition, GoalStatus, WorkflowIrNode } from "@fusion/core";
import { listTraits, isBuiltinWorkflowId, AgentStore, validateColumnAgentBindings, ColumnAgentBindingError, stripApprovalBypassFlags, WorkflowSettingRejectionError, resolveEffectiveSettingsById, resolveWorkflowIrById, findOrphanedSettingValues, BUILTIN_WORKFLOW_SETTINGS, MAX_TASK_LIST_TEXT_CHARS, formatCurrentTaskLine, normalizeWorkflowIcon, parseWorkflowIr, WorkflowIrError, assertColumnTraitsValid, ColumnTraitValidationError } from "@fusion/core";
import { promoteHeldTask } from "./hold-release.js";
import { computeCrossParentDiagnosticClaim, computeCrossParentDiagnosticClaimId, computeParentIntentClaimId, DASHBOARD_USER_ID, dailyMemoryPath, ensureOpenClawMemoryFiles, evaluateImplementationTaskBind, extractAgentProvisioningRequest, findSameAgentDuplicates, getMemoryBackendCapabilities, getProjectMemory, isEphemeralAgent, memoryLongTermPath, normalizeMessageParticipant, reconcileDeterministicDuplicate, resolveAgentProvisioningPolicy, resolveMemoryBackend, resolveResearchSettings, resolveTaskGithubTracking, runDeterministicDuplicateGuard, scheduleQmdProjectMemoryRefresh, searchProjectMemory, shouldSkipBackgroundQmdRefresh } from "@fusion/core";
import { ResearchOrchestrator } from "./research-orchestrator.js";
import { ResearchProviderRegistry } from "./research/provider-registry.js";
import { ResearchStepRunner } from "./research-step-runner.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentReflectionService } from "./agent-reflection.js";
import { createLogger } from "./logger.js";
import { fetchWebContent, WebFetchError } from "./web-fetch.js";
import type { RunAuditor } from "./run-audit.js";
import { computeApprovalDedupeKey } from "./agent-action-gate.js";
import { MessageDeliveryAutoRecoveryHandler } from "./auto-recovery-handlers/message-delivery.js";
import { emitGoalRetrievalAudit } from "./goal-anchoring-audit.js";
import { recordRetry } from "./retry-burned-logger.js";
import { acquireWorkspaceRepoWorktree, WorkspaceRepoAcquireBusyError } from "./worktree-acquisition.js";
import { validateCodeNodeSources } from "./code-node-runner.js";

// ── Tool parameter schemas (canonical definitions) ────────────────────────

const TASK_CREATE_PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;

export const taskCreateParams = Type.Object({
  description: Type.String({ description: "What needs to be done" }),
  dependencies: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs this new task depends on (e.g. [\"KB-001\"])" }),
  ),
  priority: Type.Optional(
    Type.Union(TASK_CREATE_PRIORITY_VALUES.map((priority) => Type.Literal(priority)), {
      description: "Task priority (low, normal, high, urgent)",
    }),
  ),
  workflow_id: Type.Optional(
    Type.String({
      description:
        "Workflow ID to select for the new task (e.g. 'WF-003' or 'builtin:coding'). " +
        "Omit to inherit the project default workflow. Use fn_workflow_list to discover valid IDs.",
    }),
  ),
});

export const taskLogParams = Type.Object({
  message: Type.String({ description: "What happened" }),
  outcome: Type.Optional(Type.String({ description: "Result or consequence (optional)" })),
});

const agentLogTypeParams = Type.Union([
  Type.Literal("text"),
  Type.Literal("status"),
  Type.Literal("tool"),
  Type.Literal("thinking"),
  Type.Literal("tool_result"),
  Type.Literal("tool_error"),
], { description: "Only return entries of this agent-log type." });

export const taskLogsReadParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Maximum matching entries to return (default 100)." })),
  offset: Type.Optional(Type.Number({ description: "Number of matching entries to skip from the newest entry (default 0)." })),
  type: Type.Optional(agentLogTypeParams),
});

export const chatTaskLogsReadParams = Type.Object({
  task_id: Type.String({ description: "Task ID whose agent log to read (e.g. FN-001)." }),
  limit: Type.Optional(Type.Number({ description: "Maximum matching entries to return (default 100)." })),
  offset: Type.Optional(Type.Number({ description: "Number of matching entries to skip from the newest entry (default 0)." })),
  type: Type.Optional(agentLogTypeParams),
});

export const taskListParams = Type.Object({});

export const taskShowParams = Type.Object({
  id: Type.String({ description: "Task ID (e.g. FN-001)" }),
});

export const taskSearchParams = Type.Object({
  query: Type.String({ minLength: 1, description: "Search query" }),
  includeDone: Type.Optional(Type.Boolean({ description: "Include done tasks (default true)" })),
  includeArchived: Type.Optional(Type.Boolean({ description: "Include archived tasks (default true)" })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Max results (default 20, max 50)" })),
});

export const acquireRepoWorktreeParams = Type.Object({
  repo: Type.String({
    description:
      "Relative path of the sub-repo within the workspace to acquire a worktree in " +
      "(e.g. 'wolf-server'). Must be one of the repos listed in the workspace. " +
      "If already acquired, returns the existing worktree path immediately.",
  }),
});

export const taskDocumentWriteParams = Type.Object({
  key: Type.String({
    description: "Document key (e.g., 'plan', 'notes', 'research'). Alphanumeric, hyphens, underscores, 1-64 chars.",
  }),
  content: Type.String({ description: "Document content to store" }),
  author: Type.Optional(Type.String({ description: "Who is writing (default: 'agent')" })),
});

export const taskDocumentReadParams = Type.Object({
  key: Type.Optional(
    Type.String({ description: "Document key to read. Omit to list all documents for this task." }),
  ),
});

export const taskPromptWriteParams = Type.Object({
  content: Type.String({ description: "Complete replacement content for this task's PROMPT.md." }),
});

export const taskFileScopeAddParams = Type.Object({
  files: Type.Array(
    Type.String({
      description:
        "A repo-relative file path or glob to add to the task's File Scope, e.g. `packages/engine/src/foo.ts` or `packages/dashboard/app/**`. No leading slash, no `..`, no URLs or git refs.",
    }),
    { minItems: 1, description: "One or more files/globs to add to this task's ## File Scope." },
  ),
  reason: Type.Optional(
    Type.String({ description: "Short reason these files must be edited (recorded in the agent log)." }),
  ),
});

export const chatTaskDocumentWriteParams = Type.Object({
  task_id: Type.String({ description: "Task ID to write the document to (e.g. 'FN-001')." }),
  key: Type.String({
    description: "Document key (e.g., 'plan', 'notes', 'research'). Alphanumeric, hyphens, underscores, 1-64 chars.",
  }),
  content: Type.String({ description: "Document content to store" }),
  author: Type.Optional(Type.String({ description: "Who is writing (default: 'agent')" })),
});

export const chatTaskDocumentReadParams = Type.Object({
  task_id: Type.String({ description: "Task ID to read documents from (e.g. 'FN-001')." }),
  key: Type.Optional(
    Type.String({ description: "Document key to read. Omit to list all documents for this task." }),
  ),
});

const ARTIFACT_TYPE_VALUES = ["document", "image", "video", "audio", "other"] as const;
const artifactTypeSchema = Type.Union(ARTIFACT_TYPE_VALUES.map((type) => Type.Literal(type)), {
  description: "Artifact type: document, image, video, audio, or other.",
});

export const artifactRegisterParams = Type.Object({
  type: artifactTypeSchema,
  title: Type.String({ description: "Human-readable artifact title." }),
  description: Type.Optional(Type.String({ description: "Optional longer artifact description or caption." })),
  mimeType: Type.Optional(Type.String({ description: "Optional MIME type, e.g. text/markdown or image/png." })),
  uri: Type.Optional(Type.String({ description: "Optional URI/path reference when content is stored elsewhere." })),
  content: Type.Optional(Type.String({ description: "Optional inline text content for document/text artifacts." })),
  dataBase64: Type.Optional(Type.String({ description: "Optional base64-encoded binary payload for image artifacts, e.g. PNG bytes; omit content, uri, and path when provided." })),
  path: Type.Optional(Type.String({ description: "Optional local file path to a media file you already saved (screenshot, wireframe, mockup, recording). The file is copied into managed artifact storage. Preferred over dataBase64 for files on disk. Omit content, uri, and dataBase64 when provided." })),
  taskId: Type.Optional(Type.String({ description: "Optional associated task ID (e.g. 'FN-001')." })),
});

export const artifactListParams = Type.Object({
  type: Type.Optional(artifactTypeSchema),
  authorId: Type.Optional(Type.String({ description: "Filter by registering author/agent ID." })),
  taskId: Type.Optional(Type.String({ description: "Filter by associated task ID." })),
  search: Type.Optional(Type.String({ description: "Search artifact titles, descriptions, content, and task metadata." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of artifacts to return." })),
  offset: Type.Optional(Type.Number({ description: "Number of artifacts to skip." })),
});

export const artifactViewParams = Type.Object({
  id: Type.String({ description: "Artifact ID to view." }),
});

export const chatArtifactRegisterParams = Type.Object({
  type: artifactTypeSchema,
  title: Type.String({ description: "Human-readable artifact title." }),
  description: Type.Optional(Type.String({ description: "Optional longer artifact description or caption." })),
  mimeType: Type.Optional(Type.String({ description: "Optional MIME type, e.g. text/markdown or image/png." })),
  uri: Type.Optional(Type.String({ description: "Optional URI/path reference when content is stored elsewhere." })),
  content: Type.Optional(Type.String({ description: "Optional inline text content for document/text artifacts." })),
  dataBase64: Type.Optional(Type.String({ description: "Optional base64-encoded binary payload for image artifacts, e.g. PNG bytes; omit content, uri, and path when provided." })),
  path: Type.Optional(Type.String({ description: "Optional local file path to a media file you already saved (screenshot, wireframe, mockup, recording). The file is copied into managed artifact storage. Preferred over dataBase64 for files on disk. Omit content, uri, and dataBase64 when provided." })),
  task_id: Type.String({ description: "Associated task ID (e.g. 'FN-001')." }),
});

export const chatArtifactListParams = Type.Object({
  type: Type.Optional(artifactTypeSchema),
  authorId: Type.Optional(Type.String({ description: "Filter by registering author/agent ID." })),
  task_id: Type.String({ description: "Associated task ID to list artifacts for." }),
  search: Type.Optional(Type.String({ description: "Search artifact titles, descriptions, content, and task metadata." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of artifacts to return." })),
  offset: Type.Optional(Type.Number({ description: "Number of artifacts to skip." })),
});

export const workflowListParams = Type.Object({});

export const workflowGetParams = Type.Object({
  workflow_id: Type.String({
    description:
      "The workflow definition ID to fetch (e.g. 'WF-003', or a 'builtin:*' id). " +
      "Use fn_workflow_list to discover available IDs.",
  }),
});

export const workflowSelectParams = Type.Object({
  workflow_id: Type.String({
    description:
      "The workflow definition ID to select (e.g. 'WF-003', or a 'builtin:*' id). " +
      "Use fn_workflow_list to discover available IDs.",
  }),
  task_id: Type.Optional(
    Type.String({ description: "Task to assign the workflow to. Defaults to the current task." }),
  ),
});

export const taskPromoteParams = Type.Object({
  task_id: Type.Optional(
    Type.String({ description: "Held task to promote. Defaults to the current task." }),
  ),
});

export const workflowCreateParams = Type.Object({
  name: Type.String({ description: "Workflow name (required, non-empty)." }),
  description: Type.Optional(Type.String({ description: "Optional human-readable description." })),
  icon: Type.Optional(Type.String({ description: "Optional compact plain-text icon for this custom workflow." })),
  ir: Type.Unknown({
    description:
      "Workflow graph (intermediate representation). Validated server-side; a malformed graph is rejected.",
  }),
  layout: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Optional node layout map keyed by node id.",
    }),
  ),
  confirm_policy_escalation: Type.Optional(
    Type.Boolean({
      description:
        "Set true to confirm binding a column to an agent whose permission policy is broader " +
        "(more privileged) than the project default. Required when such a binding is present; " +
        "the create is otherwise rejected naming the offending column.",
    }),
  ),
});

export const workflowValidateParams = Type.Object({
  workflow_id: Type.Optional(
    Type.String({
      description:
        "Workflow definition ID to dry-run validate (e.g. 'WF-003', or a 'builtin:*' id). " +
        "Use either workflow_id or ir; validation performs no persistence.",
    }),
  ),
  ir: Type.Optional(
    Type.Unknown({
      description:
        "Inline workflow graph (intermediate representation) to dry-run validate. " +
        "Use either ir or workflow_id; validation performs no persistence.",
    }),
  ),
  confirm_policy_escalation: Type.Optional(
    Type.Boolean({
      description:
        "Set true to confirm that validating column-agent bindings may allow a broader agent policy. " +
        "This is checked exactly like create/update but never persists anything.",
    }),
  ),
});

export const workflowUpdateParams = Type.Object({
  workflow_id: Type.String({ description: "The workflow definition ID to update (built-ins cannot be edited)." }),
  name: Type.Optional(Type.String({ description: "New name." })),
  description: Type.Optional(Type.String({ description: "New description." })),
  icon: Type.Optional(Type.String({ description: "New compact plain-text icon; blank clears it." })),
  ir: Type.Optional(Type.Unknown({ description: "Replacement workflow graph (validated server-side)." })),
  layout: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Replacement node layout map." })),
  rehome_to: Type.Optional(
    Type.String({
      description:
        "When an IR update removes a column that still holds cards, supply the column id to re-home those occupants into. " +
        "Required to resolve an OccupiedColumns conflict; the target must exist in the new IR.",
    }),
  ),
  confirm_policy_escalation: Type.Optional(
    Type.Boolean({
      description:
        "Set true to confirm binding a column to an agent whose permission policy is broader " +
        "(more privileged) than the project default. Required when such a binding is present; " +
        "the update is otherwise rejected naming the offending column.",
    }),
  ),
});

export const workflowDeleteParams = Type.Object({
  workflow_id: Type.String({ description: "The workflow definition ID to delete (built-ins cannot be deleted)." }),
});

export const workflowSettingsParams = Type.Object({
  action: Type.Union([Type.Literal("get"), Type.Literal("set")], {
    description:
      "`get` reads the stored setting VALUES plus the engine-effective values for the workflow; " +
      "`set` writes values (requires `values`).",
  }),
  workflow_id: Type.String({
    description:
      "The workflow whose setting VALUES to read/write (e.g. 'WF-003', or a 'builtin:*' id). " +
      "Values are scoped per (workflow, project). Built-in workflow VALUES are writable even though " +
      "built-in DECLARATIONS are not (declarations are edited via the workflow IR's `settings`). " +
      "Values are validated against THIS workflow's declared settings (use fn_workflow_get to inspect them).",
  }),
  values: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "For action='set': a map of settingId → value to write. A `null` value DELETES the override " +
        "(null-as-delete). Each value is validated against the named workflow's declaration; on ANY " +
        "rejection (unknown-setting/type-mismatch/enum-violation/no-settings-defined) nothing is " +
        "persisted and the typed rejection list is returned.",
    }),
  ),
});

export const traitListParams = Type.Object({});

export const reflectOnPerformanceParams = Type.Object({
  focus_area: Type.Optional(
    Type.String({ description: "Optional focus area for reflection (e.g., 'code quality', 'speed', 'testing')" }),
  ),
});

export const readEvaluationsParams = Type.Object({});

export const updateIdentityParams = Type.Object({
  soul: Type.Optional(Type.String({ description: "Updated soul/personality text" })),
  instructionsText: Type.Optional(Type.String({ description: "Updated operating instructions" })),
  memory: Type.Optional(Type.String({ description: "Updated agent memory text" })),
});

export const goalListParams = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("active"),
      Type.Literal("archived"),
      Type.Literal("all"),
    ], { description: "Filter by goal status (default: active)" }),
  ),
});

export const goalShowParams = Type.Object({
  id: Type.String({ description: "Goal ID (G-…)" }),
});

export const listAgentsParams = Type.Object({
  role: Type.Optional(
    Type.String({ description: "Filter by agent role/capability (e.g., 'executor', 'reviewer', 'qa')" }),
  ),
  state: Type.Optional(
    Type.String({ description: "Filter by agent state (e.g., 'idle', 'active', 'running')" }),
  ),
  includeEphemeral: Type.Optional(
    Type.Boolean({ description: "Include ephemeral/runtime agents (default: false)" }),
  ),
});

export const delegateTaskParams = Type.Object({
  agent_id: Type.String({ description: "The agent ID to delegate work to" }),
  description: Type.String({ description: "What needs to be done" }),
  dependencies: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs this new task depends on (e.g. [\"KB-001\"])" }),
  ),
  workflow_id: Type.Optional(
    Type.String({
      description:
        "Workflow ID to select for the new task (e.g. 'WF-003' or 'builtin:coding'). " +
        "Omit to inherit the project default workflow. Use fn_workflow_list to discover valid IDs.",
    }),
  ),
  override: Type.Optional(Type.Boolean({ description: "Set true to bypass executor-role assignment policy" })),
});

export const taskAssignParams = Type.Object({
  task_id: Type.String({ description: "Task ID to assign (e.g. FN-001)" }),
  agent_id: Type.String({ description: "Durable agent ID to assign to the task" }),
  override: Type.Optional(Type.Boolean({ description: "Set true to bypass executor-role assignment policy" })),
});

export const getAgentConfigParams = Type.Object({
  agent_id: Type.String({ description: "The agent ID to read configuration for" }),
});

export const updateAgentConfigParams = Type.Object({
  agent_id: Type.String({ description: "The agent ID to update" }),
  soul: Type.Optional(Type.String({ description: "Agent personality/identity text", maxLength: 10000 })),
  instructions_text: Type.Optional(Type.String({ description: "Inline custom instructions", maxLength: 50000 })),
  instructions_path: Type.Optional(Type.String({ description: "Path to instructions markdown file", maxLength: 500 })),
  heartbeat_procedure_path: Type.Optional(Type.String({ description: "Path to heartbeat procedure markdown file", maxLength: 500 })),
  heartbeat_interval_ms: Type.Optional(Type.Number({ description: "Heartbeat polling interval in ms", minimum: 1000 })),
  heartbeat_timeout_ms: Type.Optional(Type.Number({ description: "Heartbeat timeout in ms", minimum: 5000 })),
  max_concurrent_runs: Type.Optional(Type.Number({ description: "Max concurrent heartbeat runs", minimum: 1 })),
  message_response_mode: Type.Optional(Type.Union([
    Type.Literal("immediate"),
    Type.Literal("on-heartbeat"),
  ], { description: "How agent responds to messages" })),
});

export const createAgentParams = Type.Object({
  name: Type.String({ description: "Name for the new agent" }),
  role: Type.Union([
    Type.Literal("triage"),
    Type.Literal("executor"),
    Type.Literal("reviewer"),
    Type.Literal("merger"),
    Type.Literal("engineer"),
    Type.Literal("custom"),
  ], { description: "Agent role/capability" }),
  soul: Type.Optional(Type.String({ description: "Agent personality/identity text", maxLength: 10000 })),
  instructions_text: Type.Optional(Type.String({ description: "Inline custom instructions", maxLength: 50000 })),
  instructions_path: Type.Optional(Type.String({ description: "Path to instructions markdown file", maxLength: 500 })),
  reportsTo: Type.Optional(Type.String({ description: "Manager agent ID. Defaults to the calling agent." })),
  heartbeat_interval_ms: Type.Optional(Type.Number({ description: "Heartbeat polling interval in ms", minimum: 1000 })),
  heartbeat_timeout_ms: Type.Optional(Type.Number({ description: "Heartbeat timeout in ms", minimum: 5000 })),
  max_concurrent_runs: Type.Optional(Type.Number({ description: "Max concurrent heartbeat runs", minimum: 1 })),
  message_response_mode: Type.Optional(Type.Union([
    Type.Literal("immediate"),
    Type.Literal("on-heartbeat"),
  ], { description: "How agent responds to messages" })),
});

export const deleteAgentParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID to delete" }),
  force: Type.Optional(Type.Boolean({ description: "Force delete even if the agent currently holds a checkout lease" })),
  reassign_to: Type.Optional(Type.String({ description: "Optional replacement agent ID for tasks currently assigned to the deleted agent" })),
});

export const sendMessageParams = Type.Object({
  to_id: Type.String({ description: "Recipient ID (agent ID or user ID, depending on message type)" }),
  content: Type.String({ description: "Message body (1-2000 characters)" }),
  type: Type.Optional(Type.Union([
    Type.Literal("agent-to-agent"),
    Type.Literal("agent-to-user"),
  ], { description: "Message type (defaults to 'agent-to-agent')" })),
  reply_to_message_id: Type.Optional(
    Type.String({ description: "Optional ID of the message you are replying to (use IDs from fn_read_messages output)" }),
  ),
});

export const readMessagesParams = Type.Object({
  unread_only: Type.Optional(Type.Boolean({ description: "Only return unread messages (default: true)" })),
  limit: Type.Optional(Type.Number({ description: "Max messages to return (default: 20)" })),
});

export const postRoomMessageParams = Type.Object({
  roomId: Type.String({ description: "Room ID to post into" }),
  content: Type.String({ description: "Room message body (1-2000 characters)" }),
  replyToMessageId: Type.Optional(Type.String({ description: "Optional ID of the room message you are replying to" })),
  mentions: Type.Optional(Type.Array(Type.String(), { description: "Optional agent IDs to mention in the room message" })),
});

export const askQuestionParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({
        description: "The question text shown to the user. Required and must be specific enough to answer.",
      }),
      header: Type.Optional(Type.String({
        description: "Optional short heading for the question card, such as 'Decision needed'.",
      })),
      description: Type.Optional(Type.String({
        description: "Optional helper text explaining why the answer is needed or how it will be used.",
      })),
      options: Type.Optional(Type.Array(Type.Object({
        label: Type.String({ description: "Visible option label the user can choose." }),
        description: Type.Optional(Type.String({ description: "Optional explanatory text for this option." })),
      }), {
        description: "Options for single_select, multi_select, or confirm questions. Select questions require at least one option.",
      })),
      multiSelect: Type.Optional(Type.Boolean({
        description: "Set true when the user may choose multiple options. Prefer type='multi_select' for clarity.",
      })),
      type: Type.Optional(Type.Union([
        Type.Literal("text"),
        Type.Literal("single_select"),
        Type.Literal("multi_select"),
        Type.Literal("confirm"),
      ], {
        description: "Question input type: free text, single option, multiple options, or yes/no confirmation.",
      })),
    }),
    { description: "One or more structured questions to present to the user." },
  ),
});

export const memorySearchParams = Type.Object({
  query: Type.String({ description: "Search terms for durable project memory. Use focused keywords, not a full prompt." }),
  limit: Type.Optional(Type.Number({ description: "Maximum snippets to return (default: 5, max: 20)" })),
});

export const memoryGetParams = Type.Object({
  path: Type.String({ description: "Memory path from fn_memory_search, e.g. .fusion/memory/MEMORY.md or .fusion/memory/YYYY-MM-DD.md" }),
  startLine: Type.Optional(Type.Number({ description: "1-based start line (default: 1)" })),
  lineCount: Type.Optional(Type.Number({ description: "Number of lines to read (default: 120, max: 400)" })),
});

export const webFetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch (http/https only)" }),
  prompt: Type.Optional(Type.String({ description: "Optional extraction hint for downstream summarization" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Request timeout in milliseconds" })),
  maxBytes: Type.Optional(Type.Number({ description: "Maximum content bytes to return" })),
});

export const researchRunParams = Type.Object({
  query: Type.String({ description: "Research question or topic to investigate" }),
  wait_for_completion: Type.Optional(Type.Boolean({ description: "Wait for completion in this call (default: false)" })),
  max_wait_ms: Type.Optional(Type.Number({ description: "Max wait time when wait_for_completion=true (default: 90000, capped by settings)" })),
});

export const researchListParams = Type.Object({
  status: Type.Optional(Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ], { description: "Optional status filter" })),
  limit: Type.Optional(Type.Number({ description: "Max runs to return (default: 10)" })),
});

export const researchGetParams = Type.Object({
  id: Type.String({ description: "Research run ID" }),
});

export const researchCancelParams = Type.Object({
  id: Type.String({ description: "Research run ID to cancel" }),
});

export const researchRetryParams = Type.Object({
  id: Type.String({ description: "Failed or cancelled research run ID to retry" }),
});

export const memoryAppendParams = Type.Object({
  scope: Type.Optional(Type.Union([
    Type.Literal("project"),
    Type.Literal("agent"),
  ], { description: "project for workspace memory, agent for this agent's private memory" })),
  layer: Type.Union([
    Type.Literal("long-term"),
    Type.Literal("daily"),
  ], { description: "long-term for durable conventions/decisions/pitfalls, daily for running notes/open loops" }),
  content: Type.String({ description: "Markdown content to append. Keep it concise and reusable." }),
});

type MemoryToolSettings = {
  memoryBackendType?: string;
  [key: string]: unknown;
};

type AgentMemoryContext = {
  agentId: string;
  agentName?: string;
  memory?: string | null;
};

type MemoryToolOptions = {
  agentMemory?: AgentMemoryContext;
};

type MemorySearchHit = {
  path: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  score: number;
  backend: string;
};

const log = createLogger("agent-tools");

const MAX_INSTRUCTIONS_TEXT_LENGTH = 50_000;
const MAX_MEMORY_LENGTH = 50_000;
const MAX_SOUL_LENGTH = 10_000;

const AGENT_MEMORY_ROOT = ".fusion/agent-memory";
const AGENT_MEMORY_FILENAME = "MEMORY.md";
const AGENT_DREAMS_FILENAME = "DREAMS.md";
const agentQmdRefreshState = new Map<string, { lastStartedAt: number; inFlight?: Promise<void> }>();
const AGENT_QMD_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DAILY_AGENT_MEMORY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

export function sanitizeAgentMemoryId(agentId: string): string {
  return agentId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function agentMemoryDisplayPath(agentId: string): string {
  return `${AGENT_MEMORY_ROOT}/${sanitizeAgentMemoryId(agentId)}/${AGENT_MEMORY_FILENAME}`;
}

function agentDreamsDisplayPath(agentId: string): string {
  return `${AGENT_MEMORY_ROOT}/${sanitizeAgentMemoryId(agentId)}/${AGENT_DREAMS_FILENAME}`;
}

function agentMemoryDirectory(rootDir: string, agentId: string): string {
  return join(rootDir, AGENT_MEMORY_ROOT, sanitizeAgentMemoryId(agentId));
}

export function agentMemoryFilePath(rootDir: string, agentId: string): string {
  return join(agentMemoryDirectory(rootDir, agentId), AGENT_MEMORY_FILENAME);
}

function agentDreamsFilePath(rootDir: string, agentId: string): string {
  return join(agentMemoryDirectory(rootDir, agentId), AGENT_DREAMS_FILENAME);
}

function agentDailyFilePath(rootDir: string, agentId: string, date = new Date()): string {
  return join(agentMemoryDirectory(rootDir, agentId), `${date.toISOString().slice(0, 10)}.md`);
}

export async function readAgentMemoryWorkspaceLongTerm(rootDir: string, agentId: string): Promise<string> {
  const safeRoot = typeof rootDir === "string" ? rootDir.trim() : "";
  const safeAgentId = typeof agentId === "string" ? agentId.trim() : "";
  if (!safeRoot || !safeAgentId) {
    return "";
  }

  const filePath = agentMemoryFilePath(safeRoot, safeAgentId);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return "";
    }
    const content = await readFile(filePath, "utf-8");
    return typeof content === "string" ? content.trim() : "";
  } catch {
    return "";
  }
}

export function qmdAgentMemoryCollectionName(rootDir: string, agentId: string): string {
  const hash = createHash("sha1").update(`${rootDir}:${agentId}`).digest("hex").slice(0, 12);
  return `fusion-agent-memory-${sanitizeAgentMemoryId(agentId).toLowerCase()}-${hash}`;
}

export function buildQmdAgentMemoryCollectionAddArgs(rootDir: string, agentId: string): string[] {
  return [
    "collection",
    "add",
    agentMemoryDirectory(rootDir, agentId),
    "--name",
    qmdAgentMemoryCollectionName(rootDir, agentId),
    "--mask",
    "**/*.md",
  ];
}

export function buildQmdAgentMemorySearchArgs(rootDir: string, agentId: string, query: string, limit = 5): string[] {
  return [
    "search",
    query,
    "--json",
    "--collection",
    qmdAgentMemoryCollectionName(rootDir, agentId),
    "-n",
    String(Math.max(1, Math.min(limit, 20))),
  ];
}

async function syncAgentMemoryFile(rootDir: string, agentMemory?: AgentMemoryContext): Promise<string | null> {
  const content = agentMemory?.memory?.trim();
  if (!agentMemory?.agentId) {
    return null;
  }

  const dir = agentMemoryDirectory(rootDir, agentMemory.agentId);
  await mkdir(dir, { recursive: true });
  const longTermPath = agentMemoryFilePath(rootDir, agentMemory.agentId);
  if (!existsSync(longTermPath)) {
    const title = agentMemory.agentName?.trim()
      ? `# Agent Memory: ${agentMemory.agentName.trim()}`
      : "# Agent Memory";
    const fileContent = `${title}\n\n<!-- Per-agent memory. Keep separate from workspace Project Memory. -->\n\n${content || ""}\n`;
    await writeFile(longTermPath, fileContent, "utf-8");
  }
  const dreamsPath = agentDreamsFilePath(rootDir, agentMemory.agentId);
  if (!existsSync(dreamsPath)) {
    await writeFile(dreamsPath, "# Agent Memory Dreams\n\n<!-- Synthesized patterns from this agent's daily notes. -->\n", "utf-8");
  }
  const dailyPath = agentDailyFilePath(rootDir, agentMemory.agentId);
  if (!existsSync(dailyPath)) {
    await writeFile(dailyPath, `# Agent Daily Memory ${new Date().toISOString().slice(0, 10)}\n\n<!-- Running observations for this agent. -->\n`, "utf-8");
  }
  return agentMemoryDisplayPath(agentMemory.agentId);
}

async function listAgentMemoryFiles(rootDir: string, agentMemory: AgentMemoryContext): Promise<Array<{ absPath: string; displayPath: string }>> {
  await syncAgentMemoryFile(rootDir, agentMemory);
  const dir = agentMemoryDirectory(rootDir, agentMemory.agentId);
  const files = [
    { absPath: agentMemoryFilePath(rootDir, agentMemory.agentId), displayPath: agentMemoryDisplayPath(agentMemory.agentId) },
    { absPath: agentDreamsFilePath(rootDir, agentMemory.agentId), displayPath: agentDreamsDisplayPath(agentMemory.agentId) },
  ];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    log.warn(`Failed to read agent memory directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    entries = [];
  }

  for (const entry of entries) {
    if (!DAILY_AGENT_MEMORY_RE.test(entry)) continue;
    const absPath = join(dir, entry);
    const fileStat = await stat(absPath);
    if (fileStat.isFile()) {
      files.push({
        absPath,
        displayPath: `${AGENT_MEMORY_ROOT}/${sanitizeAgentMemoryId(agentMemory.agentId)}/${entry}`,
      });
    }
  }
  return files;
}

function scoreAgentMemorySnippet(snippet: string, query: string): number {
  const terms = query.toLowerCase().split(/[^a-z0-9_-]+/i).filter((term) => term.length >= 2);
  const normalized = snippet.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

async function searchAgentMemoryFile(rootDir: string, agentMemory: AgentMemoryContext, query: string, limit: number): Promise<MemorySearchHit[]> {
  const displayPath = await syncAgentMemoryFile(rootDir, agentMemory);
  if (!displayPath) {
    return [];
  }

  const results: MemorySearchHit[] = [];
  for (const file of await listAgentMemoryFiles(rootDir, agentMemory)) {
    const content = await readFile(file.absPath, "utf-8");
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 8) {
      const chunk = lines.slice(index, index + 12).join("\n").trim();
      if (!chunk) continue;
      const score = scoreAgentMemorySnippet(chunk, query);
      if (score === 0) continue;
      results.push({
        path: file.displayPath,
        lineStart: index + 1,
        lineEnd: Math.min(index + 12, lines.length),
        snippet: chunk.slice(0, 1200),
        score: score + 1000,
        backend: "agent-memory",
      });
    }
  }
  return results.slice(0, limit);
}

async function refreshAgentMemoryQmdIndex(rootDir: string, agentMemory: AgentMemoryContext): Promise<void> {
  if (shouldSkipBackgroundQmdRefresh()) {
    return;
  }
  await syncAgentMemoryFile(rootDir, agentMemory);
  const key = `${rootDir}:${agentMemory.agentId}`;
  const now = Date.now();
  const current = agentQmdRefreshState.get(key);
  if (current?.inFlight) {
    return current.inFlight;
  }
  if (current && now - current.lastStartedAt < AGENT_QMD_REFRESH_INTERVAL_MS) {
    return;
  }

  const promise = (async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("qmd", buildQmdAgentMemoryCollectionAddArgs(rootDir, agentMemory.agentId), {
        cwd: rootDir,
        timeout: 4000,
        maxBuffer: 512 * 1024,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
      if (!/already exists|exists/i.test(`${message}\n${stderr}`)) {
        throw error;
      }
    }
    await execFileAsync("qmd", ["update"], { cwd: rootDir, timeout: 30_000, maxBuffer: 1024 * 1024 });
    await execFileAsync("qmd", ["embed"], { cwd: rootDir, timeout: 120_000, maxBuffer: 1024 * 1024 });
  })();

  agentQmdRefreshState.set(key, { lastStartedAt: now, inFlight: promise });
  try {
    await promise;
  } finally {
    const latest = agentQmdRefreshState.get(key);
    if (latest?.inFlight === promise) {
      agentQmdRefreshState.set(key, { lastStartedAt: latest.lastStartedAt });
    }
  }
}

function normalizeQmdAgentMemoryResultPath(rootDir: string, agentId: string, rawPath: unknown): string {
  const fallbackPath = agentMemoryDisplayPath(agentId);
  const original = String(rawPath ?? "").trim();
  if (!original) {
    return fallbackPath;
  }

  let candidate = original.replace(/\\/g, "/");
  const uriMatch = candidate.match(/^qmd:\/\/[^/]+\/(.+)$/i);
  if (uriMatch?.[1]) {
    candidate = uriMatch[1];
  }

  candidate = candidate.split("?")[0]?.split("#")[0] ?? "";
  candidate = candidate.replace(/^\.\/+/, "");

  const normalizedAgentId = sanitizeAgentMemoryId(agentId);
  const agentPrefix = `${AGENT_MEMORY_ROOT}/${normalizedAgentId}/`;
  if (candidate.startsWith(agentPrefix)) {
    return resolveAgentMemoryPath(rootDir, agentId, candidate)?.displayPath ?? fallbackPath;
  }

  const workspacePath = resolve(agentMemoryDirectory(rootDir, agentId)).replace(/\\/g, "/");
  const candidateAbs = resolve(rootDir, candidate).replace(/\\/g, "/");
  const relToWorkspace = relative(workspacePath, candidateAbs).replace(/\\/g, "/");
  if (relToWorkspace && !relToWorkspace.startsWith("..") && !relToWorkspace.includes("/../")) {
    const maybeDisplayPath = `${agentPrefix}${relToWorkspace}`;
    return resolveAgentMemoryPath(rootDir, agentId, maybeDisplayPath)?.displayPath ?? fallbackPath;
  }

  const filename = candidate.split("/").pop() ?? "";
  if (filename.toLowerCase() === AGENT_MEMORY_FILENAME.toLowerCase()) {
    return agentMemoryDisplayPath(agentId);
  }
  if (filename.toLowerCase() === AGENT_DREAMS_FILENAME.toLowerCase()) {
    return agentDreamsDisplayPath(agentId);
  }
  if (DAILY_AGENT_MEMORY_RE.test(filename)) {
    return `${agentPrefix}${filename}`;
  }

  return fallbackPath;
}

async function searchAgentMemoryWithQmd(rootDir: string, agentMemory: AgentMemoryContext, query: string, limit: number): Promise<MemorySearchHit[]> {
  if (shouldSkipBackgroundQmdRefresh()) {
    return searchAgentMemoryFile(rootDir, agentMemory, query, limit);
  }
  try {
    await refreshAgentMemoryQmdIndex(rootDir, agentMemory);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("qmd", buildQmdAgentMemorySearchArgs(rootDir, agentMemory.agentId, query, limit), {
      cwd: rootDir,
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    const rawResults = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
    return rawResults.slice(0, limit).map((result: Record<string, unknown>) => {
      const rawPath = result.path ?? result.file;
      return {
        path: normalizeQmdAgentMemoryResultPath(rootDir, agentMemory.agentId, rawPath),
        lineStart: Number(result.lineStart ?? result.startLine ?? 1),
        lineEnd: Number(result.lineEnd ?? result.endLine ?? result.startLine ?? 1),
        snippet: String(result.snippet ?? result.text ?? result.content ?? "").slice(0, 1200),
        score: Number(result.score ?? 1) + 1000,
        backend: "qmd-agent-memory",
      };
    }).filter((result: MemorySearchHit) => result.snippet.trim().length > 0);
  } catch (err) {
    log.warn(
      `QMD agent memory search failed for agent ${agentMemory.agentId}, falling back to file search: ${err instanceof Error ? err.message : String(err)}`,
    );
    return searchAgentMemoryFile(rootDir, agentMemory, query, limit);
  }
}

function resolveAgentMemoryPath(rootDir: string, agentId: string, path: string): { absPath: string; displayPath: string } | null {
  const safeAgentId = sanitizeAgentMemoryId(agentId);
  const prefix = `${AGENT_MEMORY_ROOT}/${safeAgentId}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  const filename = path.slice(prefix.length);
  if (filename !== AGENT_MEMORY_FILENAME && filename !== AGENT_DREAMS_FILENAME && !DAILY_AGENT_MEMORY_RE.test(filename)) {
    return null;
  }
  return {
    absPath: join(agentMemoryDirectory(rootDir, agentId), filename),
    displayPath: `${prefix}${filename}`,
  };
}

async function getAgentMemoryWindow(rootDir: string, agentMemory: AgentMemoryContext, path: string, startLine = 1, lineCount = 40) {
  const resolved = resolveAgentMemoryPath(rootDir, agentMemory.agentId, path);
  if (!resolved) {
    return null;
  }
  await syncAgentMemoryFile(rootDir, agentMemory);
  const content = await readFile(resolved.absPath, "utf-8");
  const lines = content.split("\n");
  const start = Math.max(1, Math.floor(startLine));
  const count = Math.max(1, Math.min(Math.floor(lineCount), 200));
  const startIndex = Math.min(start - 1, lines.length);
  const endIndex = Math.min(startIndex + count, lines.length);
  return {
    path: resolved.displayPath,
    content: lines.slice(startIndex, endIndex).join("\n"),
    startLine: start,
    endLine: endIndex,
    totalLines: lines.length,
    backend: "agent-memory",
  };
}

// ── Tool factory functions ────────────────────────────────────────────────

type AgentTaskCreationOptions = {
  rootDir?: string;
  bypassDuplicateCheck?: boolean;
  acknowledgedDuplicates?: string[];
  /*
  FNXC:EphemeralAgentTaskCreation 2026-07-01-00:00:
  Set true when fn_task_create is registered for an ephemeral/runtime task-worker session (executor-FN-XXXX). The tool then honors the project `ephemeralAgentsCanCreateTasks` toggle and rejects creation when it is disabled. Permanent-agent sessions leave this unset and are never gated.
  */
  callerIsEphemeral?: boolean;
  messageStore?: MessageStore;
  sourceAgentId?: string;
  sourceTaskId?: string;
};

/*
FNXC:AgentRouting 2026-07-29-00:00:
FN-8207 requires deterministic-duplicate canonical tasks to honor an explicit delegate's owner and todo-column request. Carry both mutations in the engine task-creation seam so every canonical return path is truthful without changing the shared core duplicate-guard API.
*/
async function carryCanonicalTaskRouting(
  store: TaskStore,
  canonical: Task,
  input: TaskCreateInput,
): Promise<Task> {
  // Task creation without an explicit assignee must not mutate an existing duplicate.
  if (input.assignedAgentId === undefined) return canonical;

  let task = canonical;
  if (input.assignedAgentId !== canonical.assignedAgentId) {
    task = await store.updateTask(canonical.id, { assignedAgentId: input.assignedAgentId });
  }
  if (input.column !== undefined && input.column !== task.column) {
    task = await store.moveTask(task.id, input.column);
  }
  return task;
}

export async function createAgentTask(
  store: TaskStore,
  input: TaskCreateInput,
  options?: AgentTaskCreationOptions,
): Promise<{ task: Awaited<ReturnType<TaskStore["createTask"]>>; wasDuplicate: boolean }> {
  const settings = typeof (store as { getSettings?: unknown }).getSettings === "function"
    ? await store.getSettings()
    : {} as Settings;
  const rootDir = options?.rootDir;
  const sourceParentTaskId = (input.source?.sourceParentTaskId ?? options?.sourceTaskId)?.trim().toUpperCase();
  const sourceAgentId = input.source?.sourceAgentId ?? options?.sourceAgentId;
  const crossParentDiagnosticClaim = options?.bypassDuplicateCheck === true
    ? null
    : computeCrossParentDiagnosticClaim({ title: input.title, description: input.description });
  const crossParentDiagnosticClaimId = crossParentDiagnosticClaim?.id ?? null;
  const duplicateLockScope = crossParentDiagnosticClaimId
    ? store.getRootDir?.() ?? rootDir ?? "agent-tools"
    : rootDir ?? store.getRootDir?.() ?? "agent-tools";
  const effectiveSource = input.source || sourceParentTaskId || sourceAgentId
    ? {
        sourceType: input.source?.sourceType ?? "api" as const,
        ...input.source,
        sourceAgentId,
        sourceParentTaskId,
      }
    : undefined;
  const guard = await runDeterministicDuplicateGuard(store, {
    title: input.title,
    description: input.description,
  }, {
    lockScope: duplicateLockScope,
    bypass: options?.bypassDuplicateCheck === true,
    acknowledgedDuplicates: options?.acknowledgedDuplicates,
    serializationKey: crossParentDiagnosticClaimId ?? (sourceParentTaskId ? `parent:${sourceParentTaskId}` : undefined),
    sourceParentTaskId: crossParentDiagnosticClaimId ? null : sourceParentTaskId,
    logger: log,
  });

  try {
    if (guard.action === "duplicate" && guard.existing) {
      return {
        task: await carryCanonicalTaskRouting(store, guard.existing, input),
        wasDuplicate: true,
      };
    }

    if (crossParentDiagnosticClaim) {
      try {
        const acknowledged = new Set(options?.acknowledgedDuplicates ?? []);
        const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
        const candidates = (await store.searchTasks(crossParentDiagnosticClaim.searchTerm, {
          slim: true,
          includeArchived: false,
        }))
          .filter((candidate) => candidate.column !== "done" && candidate.column !== "archived")
          .filter((candidate) => Date.parse(candidate.createdAt) >= cutoffMs)
          .filter((candidate) => !acknowledged.has(candidate.id))
          .filter((candidate) => computeCrossParentDiagnosticClaimId({
            title: candidate.title,
            description: candidate.description,
          }) === crossParentDiagnosticClaimId)
          .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
        const canonical = candidates[0];
        if (canonical) {
          return { task: await carryCanonicalTaskRouting(store, canonical, input), wasDuplicate: true };
        }
      } catch (error) {
        log.warn("Cross-parent diagnostic duplicate pre-check failed; aborting creation", {
          crossParentDiagnosticClaimId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error("Unable to verify cross-parent diagnostic task uniqueness", { cause: error });
      }
    }

    if (sourceParentTaskId && options?.bypassDuplicateCheck !== true) {
      try {
        const acknowledged = new Set(options?.acknowledgedDuplicates ?? []);
        const candidates = await store.findRecentTasksBySourceParentTaskId(sourceParentTaskId);
        const matches = findSameAgentDuplicates({
          title: input.title,
          description: input.description,
          sourceParentTaskId,
        }, candidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title ?? "",
          description: candidate.description,
          column: candidate.column,
          createdAt: Date.parse(candidate.createdAt),
          sourceAgentId: candidate.sourceAgentId ?? null,
          sourceParentTaskId: candidate.sourceParentTaskId ?? null,
        })), { sourceAgentId: sourceAgentId ?? null });
        const match = matches.find((candidate) => !acknowledged.has(candidate.id));
        const canonical = match ? candidates.find((candidate) => candidate.id === match.id) : undefined;
        if (canonical) {
          return { task: await carryCanonicalTaskRouting(store, canonical, input), wasDuplicate: true };
        }
      } catch (error) {
        log.warn("Parent-scoped task duplicate pre-check failed; aborting creation", {
          sourceParentTaskId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(`Unable to verify parent-scoped task uniqueness for ${sourceParentTaskId}`, { cause: error });
      }
    }

    const sourceMetadata = {
      ...(effectiveSource?.sourceMetadata ?? {}),
      ...(guard.fingerprint ? { contentFingerprint: guard.fingerprint } : {}),
      ...(crossParentDiagnosticClaimId ? { crossParentDiagnosticClaimId } : {}),
    };
    const nextSource = effectiveSource
      ? {
          ...effectiveSource,
          sourceMetadata: Object.keys(sourceMetadata).length > 0 ? sourceMetadata : undefined,
        }
      : undefined;

    const globalSettings =
      (await store.getGlobalSettingsStore?.()?.getSettings?.()) ?? {};
    const resolvedTracking = resolveTaskGithubTracking(
      { githubTracking: input.githubTracking },
      settings,
      globalSettings,
    );

    const shouldPrefillGithubTrackingEnabled =
      input.githubTracking?.enabled !== false && resolvedTracking.enabled;
    const createInput: TaskCreateInput = {
      ...input,
      proposalClaimId: input.proposalClaimId ?? (
        options?.bypassDuplicateCheck === true
          ? undefined
          : computeParentIntentClaimId({ title: input.title, description: input.description, sourceParentTaskId }) ?? undefined
      ),
      summarize: !input.title?.trim() ? true : undefined,
      source: nextSource,
      githubTracking: shouldPrefillGithubTrackingEnabled
        ? {
            ...(input.githubTracking ?? {}),
            enabled: true,
            ...(input.githubTracking?.repoOverride || !resolvedTracking.repo
              ? {}
              : { repoOverride: `${resolvedTracking.repo.owner}/${resolvedTracking.repo.repo}` }),
          }
        : input.githubTracking,
    };

    let proposalClaimConflict = false;
    const createdTask = await store.createTask(createInput, {
      settings,
      onProposalClaimConflict: () => { proposalClaimConflict = true; },
    });

    const reconcile = await reconcileDeterministicDuplicate(store, {
      createdTask,
      fingerprint: guard.fingerprint,
      sourceParentTaskId,
      logger: log,
    });

    return {
      task: proposalClaimConflict
        ? await carryCanonicalTaskRouting(store, createdTask, input)
        : reconcile.outcome === "archived"
        ? await carryCanonicalTaskRouting(store, reconcile.canonical, input)
        : reconcile.canonical,
      wasDuplicate: proposalClaimConflict || reconcile.outcome === "archived",
    };
  } finally {
    guard.releaseLock();
  }
}

/**
 * Create a `fn_task_create` tool that creates a new task in the selected-or-default
 * workflow's resolved intake column.
 *
 * @param store - TaskStore for task persistence
 * @returns ToolDefinition for the `fn_task_create` tool
 */
export function createTaskCreateTool(
  store: TaskStore,
  provenance?: { sourceType: SourceType; sourceAgentId?: string; sourceRunId?: string; sourceParentTaskId?: string },
  options?: AgentTaskCreationOptions,
): ToolDefinition {
  return {
    name: "fn_task_create",
    label: "Create Task",
    description:
      "Create a new task for out-of-scope work discovered during execution. " +
      "The task enters the selected-or-default workflow's intake/planning column " +
      "where it will be specified by the AI (a custom workflow with a non-triage " +
      "intake column, e.g. Inbox, lands the card there instead and it stays inert " +
      "until released). " +
      "Before creating, scan existing open tasks for similar work — if an open task " +
      "already covers this, do not create a duplicate. " +
      "Optionally set dependencies (e.g., the new task depends on the current one, " +
      "or the current task should wait for the new one). " +
      "Optionally pass workflow_id to select a workflow at creation time; use " +
      "fn_workflow_list to discover valid IDs.",
    parameters: taskCreateParams,
    execute: async (_id: string, params: Static<typeof taskCreateParams>) => {
      try {
        /*
        FNXC:EphemeralAgentTaskCreation 2026-07-01-00:00:
        Ephemeral task-worker sessions may only create tasks when the project `ephemeralAgentsCanCreateTasks` toggle is on (default true). Fail-open on a settings read error so a store hiccup never blocks creation.
        */
        if (options?.callerIsEphemeral) {
          const settings = typeof (store as { getSettings?: unknown }).getSettings === "function"
            ? await store.getSettings().catch(() => ({} as Settings))
            : ({} as Settings);
          const policy = fusionCore.resolveEphemeralTaskCreationPolicy(settings as Settings);
          if (policy === "deny") {
            const message = "Ephemeral task-worker agents are not allowed to create tasks (ephemeral agent task creation is denied for this project).";
            return { content: [{ type: "text" as const, text: `ERROR: ${message}` }], details: { error: message, rule: "ephemeral-agents-cannot-create-tasks" }, isError: true };
          }
          if (policy === "upon_validation") {
            if (!options.messageStore) {
              const message = "Task proposal validation is configured but the mailbox is unavailable; no task was created.";
              return { content: [{ type: "text" as const, text: `ERROR: ${message}` }], details: { error: message, rule: "ephemeral-agents-cannot-create-tasks" }, isError: true };
            }
            const title = params.description.split(/\r?\n/, 1)[0]?.trim().slice(0, 80) || "Follow-up task";
            await options.messageStore.sendMessage({
              fromId: options.sourceAgentId ?? provenance?.sourceAgentId ?? "ephemeral-worker", fromType: "agent", toId: DASHBOARD_USER_ID, toType: "user", type: "agent-to-user",
              content: `Task proposal awaiting validation: ${title}`,
              metadata: { kind: "task-proposal", proposalStatus: "pending", proposalIdempotencyKey: randomUUID(), taskId: options.sourceTaskId, proposedTask: { title, description: params.description, priority: params.priority, workflowId: params.workflow_id, dependencies: params.dependencies } },
            });
            return { content: [{ type: "text" as const, text: "Task proposal submitted to the operator for validation; no task was created." }], details: { proposed: true } };
          }
        }
        const workflowId = params.workflow_id?.trim() || undefined;
        /*
        FNXC:Workflows 2026-07-05-00:00:
        fn_task_create must NOT hardcode column:"triage" here. TaskStore.createTask already
        resolves the landing column from the selected-or-default workflow's intake-trait
        column (input.column || resolvedEntryColumn || "triage" in _createTaskInternal); a
        hardcoded override here defeated that resolution and made a non-triage intake column
        (e.g. a custom workflow's "Inbox" hold column) dead configuration, since the card
        always jumped straight into triage and started the Planner seam immediately.
        Omitting `column` lets a custom workflow's Inbox-style intake column capture new
        cards inert (no bootstrap spec generation) while the default builtin:coding workflow
        still resolves to "triage" (byte-identical prior behavior).
        */
        const { task, wasDuplicate } = await createAgentTask(store, {
          description: params.description,
          dependencies: params.dependencies,
          priority: params.priority,
          ...(workflowId ? { workflowId } : {}),
          source: provenance ? {
            sourceType: provenance.sourceType,
            sourceAgentId: provenance.sourceAgentId,
            sourceRunId: provenance.sourceRunId,
            sourceParentTaskId: provenance.sourceParentTaskId,
          } : undefined,
        }, options);
        const deps = task.dependencies.length ? ` (depends on: ${task.dependencies.join(", ")})` : "";
        const workflow = workflowId ? ` (workflow: ${workflowId})` : "";
        return {
          content: [{
            type: "text" as const,
            text: `${wasDuplicate ? "Linked existing" : "Created"} ${task.id}: ${params.description}${deps}${workflow}`,
          }],
          details: { taskId: task.id, wasDuplicate },
        };
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Task ID already exists:")) {
          return {
            content: [{ type: "text" as const, text: `ERROR: ${err.message}` }],
            details: {},
            isError: true,
          };
        }
        if (err instanceof Error && (err as { code?: string }).code === "SELF_DEFEATING_DEPENDENCY") {
          return {
            content: [{ type: "text" as const, text: `ERROR: ${err.message}` }],
            details: {},
            isError: true,
          };
        }
        throw err;
      }
    },
  };
}

type TaskListClamp = (lines: string[], opts?: { maxChars?: number }) => string;
type TaskListFormatter = (
  lines: string[],
  opts?: { maxChars?: number; clamp?: TaskListClamp },
) => string;

function inlineTaskReadListFallback(
  lines: string[],
  opts: { maxChars?: number } = {},
): string {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? MAX_TASK_LIST_TEXT_CHARS));
  try {
    const text = lines.join("\n");
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, Math.max(0, maxChars - 1)) + "…";
  } catch {
    return "";
  }
}

function resolveTaskReadListFormatter(core: { formatTaskListText?: unknown }): TaskListFormatter {
  return typeof core.formatTaskListText === "function"
    ? (core.formatTaskListText as TaskListFormatter)
    : inlineTaskReadListFallback;
}

function formatTaskReadLines(lines: string[], emptyStateText: string): string {
  if (lines.length === 0) {
    return emptyStateText;
  }
  const formatter = resolveTaskReadListFormatter(fusionCore);
  const text = formatter(lines, { clamp: fusionCore.clampTaskListText });
  return text.trim().length > 0 ? text : emptyStateText;
}

function formatTaskSummaryLine(task: { id: string; column: string; title?: string | null; description: string; dependencies: string[] }): string {
  const desc = task.title || task.description.slice(0, 80) || "(no description)";
  const deps = task.dependencies.length ? ` [deps: ${task.dependencies.join(", ")}]` : "";
  return `${task.id} (${task.column}): ${desc}${deps}`;
}

/**
 * FNXC:AgentTooling 2026-06-27-14:05:
 * Shared read-only task discovery factories must return host-safe text and be reusable by triage, chat/planning, and heartbeat surfaces. Heartbeat agents now receive task read tools through this single store-backed implementation instead of bespoke copies.
 *
 * FNXC:AgentTooling 2026-06-27-00:00:
 * Triage and planning-board surfaces now use canonical `fn_task_show`; deprecated `fn_task_get` survives only as a recognition alias in action-gate and analytics compatibility paths, not as a model-visible registered tool.
 */
export function createTaskListTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_task_list",
    label: "List Tasks",
    description:
      "List active tasks that aren't done or archived. Returns ID, description, column, " +
      "and dependencies for each. Use to discover work and check for duplicates.",
    parameters: taskListParams,
    execute: async () => {
      const tasks = await store.listTasks({ slim: true, includeArchived: false });
      const active = tasks.filter((task) => task.column !== "done");
      const lines = active.map(formatTaskSummaryLine);
      return {
        content: [{ type: "text" as const, text: formatTaskReadLines(lines, "No active tasks.") }],
        details: { count: active.length },
      };
    },
  };
}

export function createTaskSearchTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_task_search",
    label: "Search Tasks",
    description:
      "Keyword search across tasks, including done and archived tasks by default. " +
      "Use for duplicate detection and work discovery before filing new tasks.",
    parameters: taskSearchParams,
    execute: async (_id: string, params: Static<typeof taskSearchParams>) => {
      const query = params.query.trim();
      if (query.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No tasks matched." }],
          details: { count: 0 },
        };
      }
      const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 20)));
      const results = await store.searchTasks(query, {
        slim: true,
        includeArchived: params.includeArchived ?? true,
        limit,
      });
      const includeDone = params.includeDone ?? true;
      const filtered = includeDone ? results : results.filter((task) => task.column !== "done");
      const lines = filtered.map(formatTaskSummaryLine);
      const text = formatTaskReadLines(
        lines.length > 0 ? [`Search results for "${query}" (${filtered.length}):`, ...lines] : [],
        "No tasks matched.",
      );
      return {
        content: [{ type: "text" as const, text }],
        details: { count: filtered.length },
      };
    },
  };
}

export function createTaskShowTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_task_show",
    label: "Show Task",
    description: "Show full details for a task including its PROMPT.md content.",
    parameters: taskShowParams,
    execute: async (_id: string, params: Static<typeof taskShowParams>) => {
      try {
        const task = await store.getTask(params.id);
        const parts = [
          `ID: ${task.id}`,
          task.title ? `Title: ${task.title}` : null,
          `Column: ${task.column}`,
          `Status: ${task.status ?? task.column}`,
          `Description: ${task.description || "(no description)"}`,
          task.dependencies.length ? `Dependencies: ${task.dependencies.join(", ")}` : null,
          Array.isArray(task.steps) && task.steps.length
            ? `Steps:\n${task.steps.map((step, index) => `  ${index}. ${step.name} — ${step.status}`).join("\n")}`
            : null,
          "",
          "PROMPT.md:",
          task.prompt || "(not yet specified)",
        ].filter((part): part is string => typeof part === "string");
        return {
          content: [{ type: "text" as const, text: parts.join("\n") || `Task ${params.id} has no details.` }],
          details: { taskId: task.id },
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: `Task ${params.id} not found.` }],
          details: {},
        };
      }
    },
  };
}

export function createTaskReadTools(store: TaskStore): ToolDefinition[] {
  return [createTaskListTool(store), createTaskShowTool(store), createTaskSearchTool(store)];
}

/**
 * Create a `fn_task_log` tool that logs an entry for a specific task.
 *
 * @param store - TaskStore for task persistence
 * @param taskId - The task ID to log entries against
 * @returns ToolDefinition for the `fn_task_log` tool
 */
export function createTaskLogTool(store: TaskStore, taskId: string): ToolDefinition {
  return {
    name: "fn_task_log",
    label: "Log Entry",
    description:
      "Log an important action, decision, or issue for this task. " +
      "Use for significant events — not every small step.",
    parameters: taskLogParams,
    execute: async (_id: string, params: Static<typeof taskLogParams>) => {
      try {
        await store.logEntry(taskId, params.message, params.outcome);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        if (typeof err?.message === "string" && err.message.toLowerCase().includes("archived")) {
          return {
            content: [{ type: "text" as const, text: "ERROR: Cannot log to archived task — this task is read-only" }],
            details: {},
          };
        }
        throw err;
      }

      return {
        content: [{ type: "text" as const, text: `Logged: ${params.message}` }],
        details: {},
      };
    },
  };
}

/**
 * Create a `fn_task_log` tool with run context for mutation correlation.
 *
 * @param store - TaskStore for task persistence
 * @param taskId - The task ID to log entries against
 * @param runContext - Optional run context for mutation correlation
 * @returns ToolDefinition for the `fn_task_log` tool
 */
export function createTaskLogToolWithContext(store: TaskStore, taskId: string, runContext?: RunMutationContext): ToolDefinition {
  return {
    name: "fn_task_log",
    label: "Log Entry",
    description:
      "Log an important action, decision, or issue for this task. " +
      "Use for significant events — not every small step.",
    parameters: taskLogParams,
    execute: async (_id: string, params: Static<typeof taskLogParams>) => {
      try {
        await store.logEntry(taskId, params.message, params.outcome, runContext);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        if (typeof err?.message === "string" && err.message.toLowerCase().includes("archived")) {
          return {
            content: [{ type: "text" as const, text: "ERROR: Cannot log to archived task — this task is read-only" }],
            details: {},
          };
        }
        throw err;
      }

      return {
        content: [{ type: "text" as const, text: `Logged: ${params.message}` }],
        details: {},
      };
    },
  };
}

/*
FNXC:TaskLogsRead 2026-07-16-00:00:
TypeBox defaults are schema metadata, not runtime values. Issue #2149 needs omitted or invalid paging normalized here because an undefined limit reaches TaskStore as an unbounded read.
*/
export function normalizeAgentLogPaging(rawLimit?: unknown, rawOffset?: unknown, defaultLimit = 100): { limit: number; offset: number } {
  const normalizedLimit = rawLimit == null ? defaultLimit : Math.floor(Number(rawLimit));
  const normalizedOffset = rawOffset == null ? 0 : Math.floor(Number(rawOffset));
  return {
    limit: Number.isFinite(normalizedLimit) && normalizedLimit > 0 ? normalizedLimit : defaultLimit,
    offset: Number.isFinite(normalizedOffset) && normalizedOffset >= 0 ? normalizedOffset : 0,
  };
}

/*
FNXC:TaskLogsRead 2026-07-16-00:00:
Issue #2149 requires failure analysis to preserve each persisted log row's chronology. AgentLogEntry has no persisted stream/run boundary, so adjacent text or thinking rows cannot safely be re-glued here: they may be distinct responses from the same agent. The dashboard can group its live render entries using its hidden tool-boundary metadata; this store-only reader must render every persisted row separately.
*/
export function renderAgentLogEntries(entries: AgentLogEntry[]): string {
  return entries.map((entry) => formatAgentLogBlock(entry, entry.text)).join("\n\n");
}

function formatAgentLogBlock(entry: AgentLogEntry, text: string): string {
  const agent = entry.agent ? ` (${entry.agent})` : "";
  const detail = entry.detail !== undefined ? `\nDetail:\n${entry.detail}` : "";
  return `[${entry.timestamp}] ${entry.type}${agent}\n${text}${detail}`;
}

async function readTaskAgentLogs(
  store: TaskStore,
  taskId: string,
  params: { limit?: unknown; offset?: unknown; type?: AgentLogEntry["type"] },
) {
  const { limit, offset } = normalizeAgentLogPaging(params.limit, params.offset);
  try {
    const [entries, total] = await Promise.all([
      store.getAgentLogs(taskId, { limit, offset, type: params.type }),
      store.getAgentLogCount(taskId, { type: params.type }),
    ]);
    const filter = params.type ? `, type=${params.type}` : "";
    const header = `Agent log: ${entries.length}/${total} entries (limit=${limit}, offset=${offset}${filter})`;
    return { content: [{ type: "text" as const, text: entries.length > 0 ? `${header}\n\n${renderAgentLogEntries(entries)}` : `${header}\n\n(no matching log entries)` }], details: { taskId, total, limit, offset, type: params.type } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `ERROR: Failed to read agent log for task ${taskId}: ${err.message}` }], details: {} };
  }
}

/**
 * FNXC:TaskLogsRead 2026-07-16-00:00:
 * Issue #2149 requires task-bound agents to read the full persisted agent log to diagnose failures. Runtime paging normalization prevents accidental unbounded reads.
 */
export function createTaskLogsReadTool(store: TaskStore, taskId: string): ToolDefinition {
  return {
    name: "fn_task_logs_read",
    label: "Read Agent Logs",
    description: "Read this task's persisted agent log with pagination and optional type filtering. Default page size is 100.",
    parameters: taskLogsReadParams,
    execute: async (_id: string, params: Static<typeof taskLogsReadParams>) => readTaskAgentLogs(store, taskId, params),
  };
}

/**
 * FNXC:TaskLogsRead 2026-07-16-00:00:
 * Dashboard chat has no ambient task, so Issue #2149 log reads require task_id just like chat task-document tools.
 */
export function createChatTaskLogsReadTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_task_logs_read",
    label: "Read Agent Logs",
    description: "Read a task's persisted agent log with pagination and optional type filtering. Requires task_id; default page size is 100.",
    parameters: chatTaskLogsReadParams,
    execute: async (_id: string, params: Static<typeof chatTaskLogsReadParams>) => readTaskAgentLogs(store, params.task_id, params),
  };
}

/**
 * Create a `fn_task_document_write` tool that stores a named task document.
 *
 * @param store - TaskStore for task document persistence
 * @param taskId - The task ID to write documents against
 * @returns ToolDefinition for the `fn_task_document_write` tool
 */
export function createTaskDocumentWriteTool(store: TaskStore, taskId: string): ToolDefinition {
  return {
    name: "fn_task_document_write",
    label: "Write Document",
    description:
      "Save a named document for this task (for example plan, notes, or research). " +
      "Each write creates a new revision so you can update documents over time.",
    parameters: taskDocumentWriteParams,
    execute: async (_id: string, params: Static<typeof taskDocumentWriteParams>) => {
      const input: TaskDocumentCreateInput = {
        key: params.key,
        content: params.content,
        author: params.author || "agent",
      };

      try {
        const document: TaskDocument = await store.upsertTaskDocument(taskId, input);
        return {
          content: [{
            type: "text" as const,
            text: `Saved document "${document.key}" (revision ${document.revision}).`,
          }],
          details: {},
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `ERROR: Failed to save document "${params.key}": ${err.message}`,
          }],
          details: {},
        };
      }
    },
  };
}

/**
 * Create a `fn_task_document_read` tool that reads task-scoped documents.
 *
 * @param store - TaskStore for task document reads
 * @param taskId - The task ID to read documents from
 * @returns ToolDefinition for the `fn_task_document_read` tool
 */
export function createTaskDocumentReadTool(store: TaskStore, taskId: string): ToolDefinition {
  return {
    name: "fn_task_document_read",
    label: "Read Document",
    description:
      "Read a named document for this task, or list all documents when no key is provided.",
    parameters: taskDocumentReadParams,
    execute: async (_id: string, params: Static<typeof taskDocumentReadParams>) => readTaskDocuments(store, taskId, params.key),
  };
}

/**
 * FNXC:WorkflowReviewers 2026-07-01-13:22:
 * Plan Review inline fixes must be able to rewrite the task's authoritative PROMPT.md, but that pre-execution reviewer should not need general source-file write tools. Route the write through TaskStore so existing PROMPT.md validation, task directory placement, and task.json sync remain the single persistence path.
 */
export function createTaskPromptWriteTool(store: TaskStore, taskId: string, runContext?: RunMutationContext): ToolDefinition {
  return {
    name: "fn_task_prompt_write",
    label: "Write PROMPT.md",
    description:
      "Replace this task's PROMPT.md with revised plan/spec content. " +
      "Use only during Plan Review/spec repair; provide the complete final PROMPT.md content.",
    parameters: taskPromptWriteParams,
    execute: async (_id: string, params: Static<typeof taskPromptWriteParams>) => {
      try {
        await store.updateTask(taskId, { prompt: params.content }, runContext);
        return {
          content: [{ type: "text" as const, text: `Updated PROMPT.md for ${taskId}.` }],
          details: {},
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `ERROR: Failed to update PROMPT.md for ${taskId}: ${err.message}`,
          }],
          details: {},
        };
      }
    },
  };
}

/*
FNXC:FileScope 2026-07-08-22:40:
Requirement: when an executing agent must edit files beyond the task's declared `## File Scope`, it should extend the declared scope itself rather than silently editing out-of-scope (which strands those edits — the merger's squash is scoped to `## File Scope`, and cross-task overlap blocking + the merge file-scope invariant both read it). This tool appends validated entries to the `## File Scope` section of PROMPT.md and persists via `store.updateTask({ prompt })`, so the same validation (`validateFileScopeInPromptContent`) and task.json/PROMPT.md sync path as `fn_task_prompt_write` applies, and `parseFileScopeFromPrompt` picks the additions up immediately.
Entries are validated with `isValidFileScopeEntry` and de-duplicated against existing scope. Marker-free plain `- \`path\`` lines are used (not the merger's `scopeAutoWiden` HTML-comment marker) so these read as first-class declared scope. Caveat: unlike the merge-time auto-widen, this does NOT re-run the peer-claim refusal (files owned by another active task's scope) — the merge-time invariant remains the backstop for genuine cross-task conflicts.
*/
export function createTaskFileScopeAddTool(store: TaskStore, taskId: string, runContext?: RunMutationContext): ToolDefinition {
  return {
    name: "fn_task_file_scope_add",
    label: "Add to File Scope",
    description:
      "Add one or more files/globs to this task's declared ## File Scope when you need to edit beyond the initial scope. " +
      "Use this instead of silently editing out-of-scope files so your changes are not stranded at merge. " +
      "Paths are repo-relative (no leading slash, no `..`).",
    parameters: taskFileScopeAddParams,
    execute: async (_id: string, params: Static<typeof taskFileScopeAddParams>) => {
      const errorContent = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
      try {
        const requested = params.files.map((f) => f.trim()).filter((f) => f.length > 0);
        const rejected = requested.filter((f) => !fusionCore.isValidFileScopeEntry(f));
        const valid = requested.filter((f) => fusionCore.isValidFileScopeEntry(f));

        const task = await store.getTask(taskId);
        const prompt = task.prompt ?? "";
        const headingMatch = prompt.match(/^##\s+File Scope\s*$/m);
        if (!headingMatch) {
          return errorContent(
            `ERROR: ${taskId}'s PROMPT.md has no "## File Scope" section to extend. Use fn_task_prompt_write if the spec needs a scope section.`,
          );
        }

        const sectionStart = headingMatch.index! + headingMatch[0].length;
        const rest = prompt.slice(sectionStart);
        const nextHeadingIdx = rest.search(/^##\s/m);
        const sectionEnd = nextHeadingIdx === -1 ? prompt.length : sectionStart + nextHeadingIdx;
        const section = prompt.slice(sectionStart, sectionEnd);

        const existing = new Set((section.match(/`([^`]+)`/g) ?? []).map((t) => t.slice(1, -1)));
        const alreadyPresent = valid.filter((f) => existing.has(f));
        const toAdd = valid.filter((f) => !existing.has(f));

        if (toAdd.length === 0) {
          const parts = ["No files added to File Scope."];
          if (alreadyPresent.length > 0) parts.push(`Already present: ${alreadyPresent.join(", ")}.`);
          if (rejected.length > 0) parts.push(`Rejected (invalid path/glob): ${rejected.join(", ")}.`);
          return errorContent(parts.join(" "));
        }

        const insertion = toAdd.map((f) => `- \`${f}\``).join("\n");
        const sectionTrimmed = section.replace(/\s+$/, "");
        const newSection = sectionTrimmed.length === 0 ? `\n\n${insertion}\n` : `${sectionTrimmed}\n${insertion}\n`;
        const newPrompt = prompt.slice(0, sectionStart) + newSection + prompt.slice(sectionEnd);

        await store.updateTask(taskId, { prompt: newPrompt }, runContext);
        await store
          .appendAgentLog(
            taskId,
            `Added to File Scope: ${toAdd.join(", ")}${params.reason ? ` — ${params.reason}` : ""}`,
            "status",
          )
          .catch(() => {});

        const parts = [`Added to File Scope: ${toAdd.join(", ")}.`];
        if (alreadyPresent.length > 0) parts.push(`Already present: ${alreadyPresent.join(", ")}.`);
        if (rejected.length > 0) parts.push(`Rejected (invalid path/glob): ${rejected.join(", ")}.`);
        return { content: [{ type: "text" as const, text: parts.join(" ") }], details: { added: toAdd } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return errorContent(`ERROR: Failed to update File Scope for ${taskId}: ${err.message}`);
      }
    },
  };
}

/**
 * FNXC:ChatAgentTools 2026-06-18-06:51:
 * Chat sessions do not have an ambient task, but users expect the same `fn_task_document_write` and `fn_task_document_read` names that task-bound lanes expose.
 * Require an explicit `task_id` here, mirroring no-ambient workflow authoring tools, so FN-6635 chat agents can persist task documents without guessing a target task.
 */
export function createChatTaskDocumentTools(store: TaskStore): ToolDefinition[] {
  return [
    {
      name: "fn_task_document_write",
      label: "Write Document",
      description:
        "Save a named document for a task (for example plan, notes, or research). " +
        "Each write creates a new revision so you can update documents over time. Requires task_id.",
      parameters: chatTaskDocumentWriteParams,
      execute: async (_id: string, params: Static<typeof chatTaskDocumentWriteParams>) => {
        const input: TaskDocumentCreateInput = {
          key: params.key,
          content: params.content,
          author: params.author || "agent",
        };

        try {
          const document: TaskDocument = await store.upsertTaskDocument(params.task_id, input);
          return {
            content: [{
              type: "text" as const,
              text: `Saved document "${document.key}" (revision ${document.revision}).`,
            }],
            details: {},
          };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          return {
            content: [{
              type: "text" as const,
              text: `ERROR: Failed to save document "${params.key}" for task ${params.task_id}: ${err.message}`,
            }],
            details: {},
          };
        }
      },
    },
    {
      name: "fn_task_document_read",
      label: "Read Document",
      description:
        "Read a named document for a task, or list all documents when no key is provided. Requires task_id.",
      parameters: chatTaskDocumentReadParams,
      execute: async (_id: string, params: Static<typeof chatTaskDocumentReadParams>) => (
        readTaskDocuments(store, params.task_id, params.key)
      ),
    },
  ];
}

/**
 * FNXC:ArtifactRegistry 2026-06-21-06:50:
 * Agents need to register multi-type artifacts across agents and tasks while using the existing task store registry. A new artifact registration must also announce itself to the dashboard user's inbox, but that notification is best-effort and must never fail the artifact write.
 */
export function createArtifactRegisterTool(
  store: TaskStore,
  authorId: string,
  messageStore?: MessageStore,
  options?: ArtifactRegisterToolOptions,
): ToolDefinition {
  return {
    name: "fn_artifact_register",
    label: "Register Artifact",
    description:
      "Register an artifact (document, image, video, audio, or other) so it appears in the dashboard Artifacts gallery and other agents and tasks can discover it. " +
      "For media you saved to disk (screenshots, wireframes, mockups, screen recordings, PDFs), pass `path` — the file is copied into managed artifact storage. " +
      "HTML mockups (type=document, mimeType=text/html, content or path) render as live sandboxed previews; PDFs (mimeType=application/pdf, path) open in an embedded viewer; videos play with seeking. " +
      "Alternatively provide inline `content` for text/markdown/HTML documents or `dataBase64` image bytes; optionally associate the artifact with a taskId.",
    parameters: artifactRegisterParams,
    execute: async (_id: string, params: Static<typeof artifactRegisterParams>) => registerArtifactForAgent(store, authorId, params, messageStore, options),
  };
}

/**
 * FNXC:ArtifactRegistry 2026-06-21-06:50:
 * Agents need a read-only cross-agent discovery surface for registered multi-type artifacts. Keep list rendering concise so agents can scan ids, media classes, authors, and task context before calling `fn_artifact_view`.
 */
export function createArtifactListTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_artifact_list",
    label: "List Artifacts",
    description:
      "List registered artifacts across agents and tasks. Supports filters for type, authorId, taskId, search, limit, and offset.",
    parameters: artifactListParams,
    execute: async (_id: string, params: Static<typeof artifactListParams>) => listArtifactsForAgent(store, params),
  };
}

/**
 * FNXC:ArtifactRegistry 2026-06-21-06:50:
 * Agents need to inspect artifact metadata plus inline content or URI references without relying on dashboard UI. Render binary media as references so tool output remains lightweight and safe for agent contexts.
 */
export function createArtifactViewTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_artifact_view",
    label: "View Artifact",
    description:
      "View a registered artifact by id, including metadata and inline content when present or the uri/path reference for media artifacts.",
    parameters: artifactViewParams,
    execute: async (_id: string, params: Static<typeof artifactViewParams>) => viewArtifactForAgent(store, params.id),
  };
}

/**
 * FNXC:ArtifactRegistry 2026-06-21-06:50:
 * Dashboard chat and planning lanes have no ambient task, so artifact tools require an explicit task target for register/list parity while keeping the canonical `fn_artifact_*` tool names available to agents.
 */
export function createChatArtifactTools(store: TaskStore, messageStore?: MessageStore): ToolDefinition[] {
  const chatAuthorId = "dashboard-chat";
  return [
    {
      name: "fn_artifact_register",
      label: "Register Artifact",
      description:
        "Register an artifact for a specific task so it appears in the dashboard Artifacts gallery and other agents can discover it. Requires task_id; accepts a local file `path` (screenshots, wireframes, mockups, recordings, PDFs), inline `content` (text/markdown/HTML — HTML renders as a live preview), or dataBase64 image bytes, and notifies the dashboard inbox best-effort.",
      parameters: chatArtifactRegisterParams,
      execute: async (_id: string, params: Static<typeof chatArtifactRegisterParams>) => registerArtifactForAgent(
        store,
        chatAuthorId,
        {
          type: params.type,
          title: params.title,
          description: params.description,
          mimeType: params.mimeType,
          uri: params.uri,
          content: params.content,
          dataBase64: params.dataBase64,
          path: params.path,
          taskId: params.task_id,
        },
        messageStore,
      ),
    },
    {
      name: "fn_artifact_list",
      label: "List Artifacts",
      description:
        "List registered artifacts for a specific task. Supports filters for type, authorId, search, limit, and offset. Requires task_id.",
      parameters: chatArtifactListParams,
      execute: async (_id: string, params: Static<typeof chatArtifactListParams>) => listArtifactsForAgent(store, {
        type: params.type,
        authorId: params.authorId,
        taskId: params.task_id,
        search: params.search,
        limit: params.limit,
        offset: params.offset,
      }),
    },
    createArtifactViewTool(store),
  ];
}

/**
 * FNXC:ArtifactRegistry 2026-07-10-14:30:
 * Executor-lane artifact registration must default to the executing task so agent-produced media
 * lands in the per-task Artifacts tab (and gallery task context) even when the agent omits taskId.
 * `baseDir` anchors relative `path` payloads at the agent's worktree so "screenshots/after.png"
 * resolves where the agent actually saved it.
 */
export interface ArtifactRegisterToolOptions {
  baseDir?: string;
  defaultTaskId?: string;
}

async function registerArtifactForAgent(
  store: TaskStore,
  authorId: string,
  params: Static<typeof artifactRegisterParams>,
  messageStore?: MessageStore,
  options?: ArtifactRegisterToolOptions,
) {
  try {
    /*
    FNXC:ArtifactRegistry 2026-07-11-09:40:
    docs/agents.md promises "exactly one payload source" for fn_artifact_register. The path and
    dataBase64 readers already reject their own mixed combos with specific messages; this guard
    closes the remaining content+uri gap so both fields are never persisted on one artifact row.
    Zero payload sources stays allowed (metadata-only registrations are unchanged).
    */
    if (params.content !== undefined && params.uri !== undefined) {
      throw new Error("content cannot be combined with uri; provide exactly one artifact payload source: content, uri, dataBase64, or path.");
    }
    const filePayload = await readArtifactFileFromPath(params, options?.baseDir);
    const data = filePayload ? filePayload.data : decodeArtifactDataBase64(params);
    await assertReviewArtifactGenerationEligible(store, {
      type: params.type,
      mimeType: filePayload?.mimeType ?? params.mimeType,
      taskId: params.taskId ?? options?.defaultTaskId,
    });
    const input: ArtifactCreateInput = {
      type: params.type,
      title: params.title,
      description: params.description,
      mimeType: filePayload?.mimeType ?? params.mimeType,
      uri: params.uri,
      content: params.content,
      data,
      authorId,
      authorType: "agent",
      taskId: params.taskId ?? options?.defaultTaskId,
    };

    const artifact: Artifact = await store.registerArtifact(input);
    void notifyArtifactRegistered(messageStore, artifact, authorId);
    return {
      content: [{
        type: "text" as const,
        text: `Registered artifact "${artifact.title}" (${artifact.type}) with id ${artifact.id}.`,
      }],
      details: { artifactId: artifact.id },
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    return {
      content: [{
        type: "text" as const,
        text: `ERROR: Failed to register artifact "${params.title}": ${err.message}`,
      }],
      details: {},
    };
  }
}

/**
 * FNXC:ReviewArtifacts 2026-07-17-13:00:
 * Automatic artifact producers share the core eligibility resolver at the
 * registration seam so `user-facing` excludes backend/trivial tasks instead of
 * relying on each future video/live-demo producer to recreate policy. Untargeted
 * artifacts remain registry-wide and are not a task review deliverable.
 */
async function assertReviewArtifactGenerationEligible(
  store: TaskStore,
  artifact: Pick<ArtifactCreateInput, "type" | "mimeType" | "taskId">,
): Promise<void> {
  if (!artifact.taskId || !fusionCore.isReviewArtifact(artifact)) return;
  if (typeof store.getTask !== "function" || typeof store.getSettings !== "function") return;

  const [task, settings] = await Promise.all([store.getTask(artifact.taskId), store.getSettings()]);
  if (!fusionCore.isReviewArtifactGenerationEligible(settings, task.prompt)) {
    throw new Error(`Review artifact generation is disabled for task ${artifact.taskId} by its reviewArtifacts policy.`);
  }
}

/**
 * FNXC:ArtifactRegistry 2026-06-29-00:00:
 * Agents need a portable way to create task-scoped image artifacts without reading arbitrary local files. `dataBase64` decodes inside the tool and then uses TaskStore's existing binary persistence path so registry rows continue to store only managed artifact URIs.
 *
 * FNXC:ArtifactRegistry 2026-06-29-17:05:
 * `dataBase64` is an image-only payload source. Reject empty, non-image, and signature-mismatched bytes early so agents get actionable tool errors instead of persisting artifacts the dashboard cannot preview.
 */
/*
FNXC:ArtifactRegistry 2026-07-10-14:30:
Agents produce screenshots/wireframes/mockups as files on disk (browser tools, design tooling, ffmpeg), and inlining megabytes of base64 into a tool call is impractical — which is why image artifacts were effectively never created. `path` lets the agent register the file it already saved; the bytes are read here and persisted through TaskStore's managed artifact storage so the registry row keeps a servable managed URI even after the worktree is cleaned up.
Image payloads are signature-validated (PNG/JPEG/GIF/WebP binary magic, SVG text sniff) so the dashboard gallery never receives an unpreviewable "image". Non-image media (video/audio/other/document files) only require a resolvable MIME type, inferred from the file extension when omitted.
*/
const ARTIFACT_FILE_MAX_BYTES = 50 * 1024 * 1024;

const ARTIFACT_EXTENSION_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
};

async function readArtifactFileFromPath(
  params: Static<typeof artifactRegisterParams>,
  baseDir?: string,
): Promise<{ data: Buffer; mimeType: string } | undefined> {
  if (params.path === undefined) {
    return undefined;
  }

  const rawPath = params.path.trim();
  if (rawPath.length === 0) {
    throw new Error("path must reference a file on disk.");
  }

  if (params.uri || params.content || params.dataBase64) {
    throw new Error("path cannot be combined with uri, content, or dataBase64; provide exactly one artifact payload source.");
  }

  /*
  FNXC:ArtifactRegistry 2026-07-11-09:45:
  `path` reads server-side files, so it must be contained: an injected tool call must not be able to
  copy arbitrary readable server files (e.g. secrets, /etc files) into managed artifact storage.
  Containment rule (checked BEFORE stat/readFile, on realpath-canonicalized paths so symlinks and
  `../` segments cannot escape; macOS tmpdir /var/folders/... canonicalizes to /private/var/...):
  - Relative paths REQUIRE a configured session `baseDir` (executor/heartbeat worktree) and must
    canonicalize to inside it; without a baseDir they are rejected instead of silently resolving
    against process.cwd() (the server process directory).
  - Absolute paths are allowed only inside the canonical `baseDir` or the canonical OS temp
    directory. The tmpdir allowance is deliberate: browser/screenshot/recording tooling writes
    captures under os.tmpdir(), and agents must be able to register those from every lane.
  - Lanes without a baseDir (dashboard chat, no-baseDir heartbeats) are therefore bounded to
    tmpdir-only absolute paths.
  */
  const isRelative = !isAbsolute(rawPath);
  if (isRelative && !baseDir) {
    throw new Error("relative path requires a workspace directory for this session; pass an absolute path under the OS temp directory instead.");
  }
  const resolvedPath = isRelative ? resolve(baseDir!, rawPath) : rawPath;

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolvedPath);
  } catch {
    throw new Error(`path ${resolvedPath} does not exist or is not readable.`);
  }

  let canonicalBaseDir: string | undefined;
  if (baseDir) {
    try {
      canonicalBaseDir = await realpath(baseDir);
    } catch {
      canonicalBaseDir = undefined;
    }
  }
  const canonicalTmpDir = await realpath(tmpdir());
  const isInside = (child: string, root: string): boolean => child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

  if (isRelative) {
    if (!canonicalBaseDir || !isInside(canonicalPath, canonicalBaseDir)) {
      throw new Error(`path ${rawPath} escapes the session workspace directory ${baseDir}; relative artifact paths must stay inside it.`);
    }
  } else if (!(canonicalBaseDir && isInside(canonicalPath, canonicalBaseDir)) && !isInside(canonicalPath, canonicalTmpDir)) {
    const allowedRoots = [canonicalBaseDir, canonicalTmpDir].filter(Boolean).join(", ");
    throw new Error(`path ${resolvedPath} is outside the allowed roots (${allowedRoots}); artifact files must live under the session workspace directory or the OS temp directory.`);
  }

  let fileStat;
  try {
    fileStat = await stat(canonicalPath);
  } catch {
    throw new Error(`path ${resolvedPath} does not exist or is not readable.`);
  }

  if (!fileStat.isFile()) {
    throw new Error(`path ${resolvedPath} is not a regular file.`);
  }

  if (fileStat.size === 0) {
    throw new Error(`path ${resolvedPath} is empty.`);
  }

  if (fileStat.size > ARTIFACT_FILE_MAX_BYTES) {
    throw new Error(`path ${resolvedPath} is ${fileStat.size} bytes, above the ${ARTIFACT_FILE_MAX_BYTES}-byte artifact limit.`);
  }

  const inferredMime = ARTIFACT_EXTENSION_MIME_TYPES[extname(resolvedPath).toLowerCase()];
  const mimeType = params.mimeType?.toLowerCase().split(";", 1)[0] ?? inferredMime;
  if (!mimeType) {
    throw new Error(`Could not infer a MIME type from ${resolvedPath}; pass mimeType explicitly.`);
  }

  const data = await readFile(canonicalPath);

  if (params.type === "image") {
    if (!mimeType.startsWith("image/")) {
      throw new Error(`image artifacts require an image/* mimeType, got ${mimeType}.`);
    }
    if (!isValidImagePayload(data, mimeType)) {
      throw new Error(`path ${resolvedPath} does not contain valid image bytes matching mimeType ${mimeType}.`);
    }
  }

  /*
  FNXC:ArtifactRegistry 2026-07-11-10:20:
  Video and PDF payloads get the same keep-the-gallery-playable treatment as images: a light
  container-signature check (mp4/mov ftyp box, WebM EBML header, %PDF- prefix) rejects renamed
  junk before it reaches the registry, where the dashboard viewer could not play or render it.
  */
  if (params.type === "video") {
    if (!mimeType.startsWith("video/")) {
      throw new Error(`video artifacts require a video/* mimeType, got ${mimeType}.`);
    }
    if (!hasVideoSignature(data, mimeType)) {
      throw new Error(`path ${resolvedPath} does not contain valid video bytes matching mimeType ${mimeType}.`);
    }
  }

  if (mimeType === "application/pdf" && !data.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error(`path ${resolvedPath} does not contain valid PDF bytes (missing %PDF- header).`);
  }

  return { data, mimeType };
}

function hasVideoSignature(data: Buffer, mimeType: string): boolean {
  if (mimeType === "video/webm") {
    // EBML header shared by WebM/Matroska containers.
    return data.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"));
  }
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") {
    // ISO BMFF: box size (4 bytes) then "ftyp".
    return data.length >= 8 && data.subarray(4, 8).toString("ascii") === "ftyp";
  }
  // Unknown video containers pass; the mimeType prefix check already ran.
  return true;
}

function isValidImagePayload(data: Buffer, mimeType: string): boolean {
  if (mimeType === "image/svg+xml") {
    const head = data.subarray(0, 4096).toString("utf8").trimStart();
    return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
  }
  return hasImageSignature(data, mimeType);
}

function decodeArtifactDataBase64(params: Static<typeof artifactRegisterParams>): Buffer | undefined {
  if (params.dataBase64 === undefined) {
    return undefined;
  }

  const encoded = params.dataBase64.trim();
  if (encoded.length === 0) {
    throw new Error("dataBase64 must decode to non-empty artifact bytes.");
  }

  if (params.uri || params.content) {
    throw new Error("dataBase64 cannot be combined with uri or content; provide exactly one artifact payload source.");
  }

  if (params.type !== "image") {
    throw new Error("dataBase64 is only supported for image artifacts; use uri or content for other types.");
  }

  const mimeType = params.mimeType?.toLowerCase().split(";", 1)[0];
  if (!mimeType || !mimeType.startsWith("image/")) {
    throw new Error("image artifacts registered with dataBase64 require an image/* mimeType such as image/png.");
  }

  const normalized = encoded.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("dataBase64 must be valid base64-encoded artifact bytes.");
  }

  const data = Buffer.from(normalized, "base64");

  if (!hasImageSignature(data, mimeType)) {
    throw new Error(`dataBase64 must decode to valid image bytes matching mimeType ${mimeType}.`);
  }

  return data;
}

function hasImageSignature(data: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }

  if (mimeType === "image/jpeg") {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }

  if (mimeType === "image/gif") {
    const header = data.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }

  if (mimeType === "image/webp") {
    return data.length >= 12
      && data.subarray(0, 4).toString("ascii") === "RIFF"
      && data.subarray(8, 12).toString("ascii") === "WEBP";
  }

  return false;
}

async function notifyArtifactRegistered(messageStore: MessageStore | undefined, artifact: Artifact, authorId: string): Promise<void> {
  if (!messageStore) return;

  /*
  FNXC:ArtifactRegistry 2026-07-12-00:00:
  Artifact-registration mailbox notifications remain best-effort and keep their stable content string, but metadata now carries mimeType so dashboard mailbox surfaces can render document/other artifact affordances from metadata without an extra artifact fetch.
  */
  try {
    await messageStore.sendMessage({
      fromType: "system",
      toType: "user",
      toId: DASHBOARD_USER_ID,
      type: "system",
      content: `New ${artifact.type} artifact registered: ${artifact.title}`,
      metadata: {
        artifactId: artifact.id,
        artifactType: artifact.type,
        title: artifact.title,
        mimeType: artifact.mimeType,
        authorId,
        taskId: artifact.taskId,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    log.warn(`Failed to send best-effort artifact registration notification for ${artifact.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function listArtifactsForAgent(store: TaskStore, params: Static<typeof artifactListParams>) {
  try {
    const artifacts: ArtifactWithTask[] = await store.listArtifacts({
      type: params.type,
      authorId: params.authorId,
      taskId: params.taskId,
      search: params.search,
      limit: params.limit,
      offset: params.offset,
    });

    if (artifacts.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No artifacts found." }],
        details: {},
      };
    }

    const lines = artifacts.map((artifact) => {
      const task = artifact.taskId ? `${artifact.taskId}${artifact.taskTitle ? ` (${artifact.taskTitle})` : ""}` : "no task";
      return `- ${artifact.id} [${artifact.type}] ${artifact.title} — author: ${artifact.authorId}; task: ${task}`;
    });
    return {
      content: [{
        type: "text" as const,
        text: `Artifacts:\n${lines.join("\n")}`,
      }],
      details: { artifactIds: artifacts.map((artifact) => artifact.id) },
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    return {
      content: [{
        type: "text" as const,
        text: `ERROR: Failed to list artifacts: ${err.message}`,
      }],
      details: {},
    };
  }
}

async function viewArtifactForAgent(store: TaskStore, id: string) {
  try {
    const artifact: Artifact | null = await store.getArtifact(id);
    if (!artifact) {
      return {
        content: [{ type: "text" as const, text: `Artifact "${id}" not found.` }],
        details: {},
      };
    }

    const lines = [
      `Artifact: ${artifact.title}`,
      `ID: ${artifact.id}`,
      `Type: ${artifact.type}`,
      `Author: ${artifact.authorId} (${artifact.authorType})`,
      `Created: ${artifact.createdAt}`,
      `Updated: ${artifact.updatedAt}`,
    ];
    if (artifact.taskId) lines.push(`Task: ${artifact.taskId}`);
    if (artifact.description) lines.push(`Description: ${artifact.description}`);
    if (artifact.mimeType) lines.push(`MIME type: ${artifact.mimeType}`);
    if (typeof artifact.sizeBytes === "number") lines.push(`Size: ${artifact.sizeBytes} bytes`);
    if (artifact.uri) lines.push(`URI: ${artifact.uri}`);
    if (artifact.content) lines.push("", artifact.content);

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: { artifactId: artifact.id },
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    return {
      content: [{
        type: "text" as const,
        text: `ERROR: Failed to view artifact "${id}": ${err.message}`,
      }],
      details: {},
    };
  }
}

async function readTaskDocuments(store: TaskStore, taskId: string, key?: string) {
  try {
    if (key) {
      const document: TaskDocument | null = await store.getTaskDocument(taskId, key);
      if (!document) {
        return {
          content: [{ type: "text" as const, text: `Document "${key}" not found.` }],
          details: {},
        };
      }

      return {
        content: [{
          type: "text" as const,
          text:
            `Document: ${document.key}\n` +
            `Revision: ${document.revision}\n` +
            `Updated: ${document.updatedAt}\n\n` +
            document.content,
        }],
        details: {},
      };
    }

    const documents: TaskDocument[] = await store.getTaskDocuments(taskId);
    if (documents.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No documents found for this task." }],
        details: {},
      };
    }

    const lines = documents.map((doc) => `- ${doc.key} (revision ${doc.revision}, updated ${doc.updatedAt})`);
    return {
      content: [{
        type: "text" as const,
        text: `Task documents:\n${lines.join("\n")}`,
      }],
      details: {},
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    return {
      content: [{
        type: "text" as const,
        text: `ERROR: Failed to read task documents for task ${taskId}: ${err.message}`,
      }],
      details: {},
    };
  }
}

/**
 * Create a `fn_workflow_list` tool that lists the workflows available for a
 * project (read-only built-ins plus user-authored definitions). Agent-native
 * parity with the dashboard's workflow picker.
 */
export function createWorkflowListTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_workflow_list",
    label: "List Workflows",
    description:
      "List the custom workflows available for this project — read-only built-ins " +
      "(ids starting with 'builtin:') and user-authored definitions. Use before " +
      "fn_workflow_select to discover valid workflow IDs.",
    parameters: workflowListParams,
    execute: async () => {
      try {
        const workflows = await store.listWorkflowDefinitions();
        if (workflows.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No workflows are defined for this project." }],
            details: {},
          };
        }
        const lines = workflows.map(
          (w) => `- ${w.id}: ${w.name}${w.description ? ` — ${w.description}` : ""}`,
        );
        return {
          content: [{ type: "text" as const, text: `Available workflows:\n${lines.join("\n")}` }],
          details: { workflowIds: workflows.map((w) => w.id) },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to list workflows: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

/**
 * Create a `fn_workflow_get` tool that returns a single workflow definition by
 * id — id/name/description, whether it is a read-only built-in, and the full
 * resolved IR (nodes/edges/columns/artifacts/fields) as JSON. Agent-native
 * read parity with the dashboard's workflow inspector; the companion read tool
 * to fn_workflow_list. Read-only; an unknown id is reported as a tool error.
 */
export function createWorkflowGetTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_workflow_get",
    label: "Get Workflow",
    description:
      "Fetch a single workflow definition by its ID — its name, description, whether it is a " +
      "read-only built-in, and its full IR (nodes, edges, columns, artifacts, and custom fields) " +
      "as JSON. Use fn_workflow_list to discover IDs first.",
    parameters: workflowGetParams,
    execute: async (_id: string, params: Static<typeof workflowGetParams>) => {
      const workflowId = params.workflow_id?.trim();
      if (!workflowId) {
        return {
          content: [{ type: "text" as const, text: "ERROR: workflow_id is required." }],
          details: {},
          isError: true,
        };
      }
      try {
        const def = await store.getWorkflowDefinition(workflowId);
        if (!def) {
          return {
            content: [{ type: "text" as const, text: `ERROR: Unknown workflow id '${workflowId}'. Use fn_workflow_list to discover valid IDs.` }],
            details: {},
            isError: true,
          };
        }
        const builtin = isBuiltinWorkflowId(def.id);
        const payload = {
          id: def.id,
          name: def.name,
          description: def.description,
          builtin,
          ir: def.ir,
          // Preserve editor node positions so a read→modify→write cycle does not
          // strip the layout. May be absent for older/built-in defs; only include
          // when present to keep the payload tidy.
          ...(def.layout ? { layout: def.layout } : {}),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: { workflowId: def.id, builtin, ...(def.layout ? { layout: def.layout } : {}) },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to get workflow: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

/**
 * Create a `fn_workflow_select` tool that assigns a workflow definition to a
 * task (defaulting to the current task). Mirrors the dashboard's per-task
 * workflow selection so an agent can set up a task the same way a user can.
 */
export function createWorkflowSelectTool(store: TaskStore, currentTaskId: string): ToolDefinition {
  return {
    name: "fn_workflow_select",
    label: "Select Workflow",
    description:
      "Assign a custom workflow to a task by its workflow ID. Defaults to the " +
      "current task when task_id is omitted. Note: selecting a workflow does not " +
      "retroactively change a pipeline already running — it applies when the task " +
      "next executes its steps. Use fn_workflow_list to find valid IDs.",
    parameters: workflowSelectParams,
    execute: async (_id: string, params: Static<typeof workflowSelectParams>) => {
      const taskId = params.task_id?.trim() || currentTaskId;
      try {
        const { enabledWorkflowSteps: enabled, reconciliation } =
          await store.selectTaskWorkflowAndReconcile(taskId, params.workflow_id);
        const stepSummary = `${enabled.length} step${enabled.length === 1 ? "" : "s"} enabled`;
        // Surface the reconciliation outcome so the agent observes any re-home:
        // a preserved card stays put; an unpreserved card moves fromColumn→toColumn.
        const rehomeNote =
          reconciliation && !reconciliation.preserved && reconciliation.fromColumn !== reconciliation.toColumn
            ? ` Re-homed from '${reconciliation.fromColumn}' to '${reconciliation.toColumn}'.`
            : reconciliation
              ? ` Card preserved in '${reconciliation.toColumn}'.`
              : "";
        return {
          content: [{
            type: "text" as const,
            text: `Selected workflow ${params.workflow_id} for ${taskId} (${stepSummary}).${rehomeNote}`,
          }],
          details: { taskId, workflowId: params.workflow_id, enabledWorkflowSteps: enabled, reconciliation },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to select workflow: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

/**
 * Create a `fn_task_promote` tool that manually releases a held task out of its
 * hold column — the agent-native equivalent of the dashboard's "promote" action.
 * Defaults to the current task. Wraps {@link promoteHeldTask}.
 */
export function createTaskPromoteTool(store: TaskStore, currentTaskId: string): ToolDefinition {
  return {
    name: "fn_task_promote",
    label: "Promote Held Task",
    description:
      "Manually promote a held task out of its hold column, releasing it regardless of the " +
      "hold's release kind (the explicit operator action a 'manual' hold waits for). Defaults " +
      "to the current task. Returns the destination column, or a rejection reason when the task " +
      "is not held or the destination is full.",
    parameters: taskPromoteParams,
    execute: async (_id: string, params: Static<typeof taskPromoteParams>) => {
      const taskId = params.task_id?.trim() || currentTaskId;
      try {
        const outcome = await promoteHeldTask(store, taskId);
        if (outcome.released) {
          return {
            content: [{
              type: "text" as const,
              text: `Promoted ${taskId} to column '${outcome.toColumn}'.`,
            }],
            details: { taskId, released: true, toColumn: outcome.toColumn },
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: `ERROR: Could not promote ${taskId}: ${outcome.rejection ?? "unknown"}.`,
          }],
          details: { taskId, released: false, rejection: outcome.rejection },
          isError: true,
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to promote task: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

/**
 * Shared write-time column-agent gate for the `fn_workflow_*` tools (R11/R13).
 * Runs the SAME `validateColumnAgentBindings` check the dashboard route runs, so
 * an agent cannot persist a binding the UI would reject (existence +
 * policy-escalation). Constructs a per-call AgentStore from the store's fusion
 * dir (the connection is process-cached) and feeds it the project settings.
 *
 * A {@link ColumnAgentBindingError} propagates unchanged; each tool's catch
 * surfaces its message (which names the column and, for an escalation, instructs
 * passing `confirm_policy_escalation: true`).
 */
async function assertWorkflowColumnAgentBindings(
  store: TaskStore,
  ir: unknown,
  confirmPolicyEscalation: boolean,
): Promise<void> {
  const columns = (ir as { columns?: unknown })?.columns;
  if (!Array.isArray(columns) || !columns.some((c) => c?.agent?.agentId)) return;
  // FNXC:SqliteFinalRemoval 2026-06-26-11:05:
  // In backend mode, pass the AsyncDataLayer so AgentStore delegates to async helpers.
  const agentLayer = store.getAsyncLayer();
  const agentStore = new AgentStore({
    rootDir: store.getFusionDir(),
    ...(agentLayer ? { asyncLayer: agentLayer } : {}),
  });
  await agentStore.init();
  const settings = await store.getSettings();
  await validateColumnAgentBindings({ ir, agentStore, settings, confirmPolicyEscalation });
}

/**
 * Render a {@link ColumnAgentBindingError} as a structured tool error result.
 * Re-phrases the escalation guidance with the tool's snake_case flag name
 * (`confirm_policy_escalation`) rather than the route's camelCase variant.
 */
function columnAgentBindingErrorResult(err: ColumnAgentBindingError) {
  const text =
    err.reason === "policy-escalation"
      ? `Column '${err.columnId}' binds agent '${err.agentId}' whose permission policy is broader than ` +
        `the project default; pass confirm_policy_escalation: true to confirm.`
      : err.message;
  return {
    content: [{ type: "text" as const, text: `ERROR: ${text}` }],
    details: { columnId: err.columnId, agentId: err.agentId, reason: err.reason },
    isError: true as const,
  };
}

export type WorkflowValidateDryRunError =
  | { type: "workflow-ir"; message: string }
  | { type: "column-traits"; message: string; violations: unknown[] }
  | { type: "code-node"; message: string; codeNodeErrors: unknown[] }
  | { type: "column-agent"; message: string; columnId: string; agentId?: string; reason?: string; policyEscalation?: boolean };

function workflowValidationErrorFromUnknown(err: unknown): WorkflowValidateDryRunError | undefined {
  if (err instanceof WorkflowIrError) return { type: "workflow-ir", message: err.message };
  if (err instanceof ColumnTraitValidationError) {
    return { type: "column-traits", message: err.message, violations: err.violations };
  }
  if (err instanceof ColumnAgentBindingError) {
    return {
      type: "column-agent",
      message: err.message,
      columnId: err.columnId,
      agentId: err.agentId,
      reason: err.reason,
      ...(err.reason === "policy-escalation" ? { policyEscalation: true } : {}),
    };
  }
  return undefined;
}

/**
 * FNXC:WorkflowAuthoringTools 2026-07-12-00:00:
 * Workflow authors need a no-persistence dry run that executes the same IR, trait, code-node, and column-agent checks used before create/update persistence.
 * Keep validation failures as successful dry-run results so agents can iterate on malformed graphs without mutating workflow rows.
 */
export async function validateWorkflowIrDryRun(
  store: TaskStore,
  ir: unknown,
  confirmPolicyEscalation = false,
): Promise<{ valid: true } | { valid: false; errors: WorkflowValidateDryRunError[] }> {
  try {
    const parsed = parseWorkflowIr(ir as Parameters<typeof parseWorkflowIr>[0]);
    if (parsed.version === "v2") assertColumnTraitsValid(parsed.columns);
    const codeNodeFailures = await validateCodeNodeSources({ nodes: parsed.nodes as WorkflowIrNode[] });
    if (codeNodeFailures.length > 0) {
      return {
        valid: false,
        errors: [{
          type: "code-node",
          message: `Workflow has ${codeNodeFailures.length} code node(s) that failed to compile`,
          codeNodeErrors: codeNodeFailures,
        }],
      };
    }
    await assertWorkflowColumnAgentBindings(store, parsed, confirmPolicyEscalation);
    return { valid: true };
  } catch (err: unknown) {
    const validationError = workflowValidationErrorFromUnknown(err);
    if (validationError) return { valid: false, errors: [validationError] };
    throw err;
  }
}

export function createWorkflowValidateTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_workflow_validate",
    label: "Validate Workflow",
    description:
      "Dry-run validate a workflow IR by workflow_id or inline ir without creating or mutating any workflow. " +
      "Runs the same server-side IR, trait, code-node, and column-agent validation as create/update and returns typed errors.",
    parameters: workflowValidateParams,
    execute: async (_id: string, params: Static<typeof workflowValidateParams>) => {
      try {
        const workflowId = params.workflow_id?.trim();
        if (!workflowId && params.ir === undefined) {
          return {
            content: [{ type: "text" as const, text: "ERROR: workflow_id or ir is required." }],
            details: { error: "missing-input" },
            isError: true,
          };
        }
        let ir = params.ir;
        if (workflowId) {
          const def = await store.getWorkflowDefinition(workflowId);
          if (!def) {
            return {
              content: [{ type: "text" as const, text: `ERROR: Workflow '${workflowId}' not found.` }],
              details: { workflowId },
              isError: true,
            };
          }
          ir = def.ir;
        }
        const result = await validateWorkflowIrDryRun(store, ir, params.confirm_policy_escalation === true);
        if (result.valid) {
          return {
            content: [{ type: "text" as const, text: "IR is valid. No workflow was created or mutated." }],
            details: { valid: true, ...(workflowId ? { workflowId } : {}) },
          };
        }
        return {
          content: [{ type: "text" as const, text: `IR is invalid: ${result.errors.map((e) => e.message).join("; ")}` }],
          details: { valid: false, errors: result.errors, ...(workflowId ? { workflowId } : {}) },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to validate workflow: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

/**
 * Create a `fn_workflow_create` tool — a thin wrapper over the store's workflow
 * definition create. The IR is validated server-side; a malformed graph rejects.
 */
export function createWorkflowCreateTool(
  store: TaskStore,
  opts?: WorkflowAuthoringToolOptions,
): ToolDefinition {
  return {
    name: "fn_workflow_create",
    label: "Create Workflow",
    description:
      "Create a new custom workflow definition from a name and a workflow graph (IR). " +
      "The IR is validated server-side; a malformed graph rejects. Returns the new workflow ID.\n" +
      "v2 IR supports step-inversion constructs (all additive, opt-in): " +
      "`parse-steps` node {artifact, parser} writes the task step list from a declared artifact " +
      "(built-in parsers: `step-headings`, `json-steps`; routable `no-steps`/`parse-error` outcomes) — " +
      "it must precede any `foreach`; " +
      "`foreach` node {source:'task-steps', template:{nodes,edges}, mode:'sequential'|'parallel', " +
      "isolation:'shared'|'worktree', concurrency (parallel only, 1-8), maxReworkCycles (1-10)} " +
      "instantiates its single-entry/exit template subgraph once per planned step " +
      "(parallel+shared is rejected); a `step-execute` node is legal only inside a foreach template; " +
      "`step-review` node {type:'plan'|'code', model?} surfaces verdicts as outcome edges " +
      "(`outcome:approve|revise|rethink|unavailable`); edges may set `kind:'rework'` (the only legal cycles, " +
      "back to step-execute within an instance; rethink edges trigger a reset-to-baseline); " +
      "`code` node {source, timeoutMs?} runs sandboxed TypeScript returning {outcome?, contextPatch?, customFields?}. " +
      "Declare task documents via `artifacts: [{key, title?, producedBy?, role?}]` and custom task fields via " +
      "`fields: [{id, name, type, required?, default?, options?, render?}]` (types: string/text/number/boolean/" +
      "enum/multi-enum/date/url; render.placement card|detail|detail-section, render.badge for card chips).\n" +
      "Declare typed workflow SETTINGS via `settings: [{id, name, type, default?, options?, description?, render?}]` " +
      "(types: string/text/number/boolean/enum/multi-enum; settings have no card/detail placement — widget only). " +
      "Settings carry workflow-scoped policy (step timeouts, review gates, model lanes); their per-project VALUES are " +
      "read/written via fn_workflow_settings, not here.\n" +
      "Bind a column to a permanent agent via `columns[].agent: { agentId, mode }`: `mode:'defer'` applies the " +
      "column agent only when the work carries no own agent/model settings, while `mode:'override'` supersedes " +
      "node/task settings wholesale. The bound agent must exist; if its permission policy is broader than the " +
      "project default, pass `confirm_policy_escalation: true` to confirm (the create is otherwise rejected).",
    parameters: workflowCreateParams,
    execute: async (_id: string, params: Static<typeof workflowCreateParams>) => {
      try {
        let approvalNote = "";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let ir = params.ir as any;
        if (opts?.stripApprovalFlags) {
          const result = stripApprovalBypassFlags(ir);
          ir = result.ir;
          if (result.stripped) approvalNote = " (approval-bypass flags removed)";
        }
        await assertWorkflowColumnAgentBindings(store, ir, params.confirm_policy_escalation === true);
        const created = await store.createWorkflowDefinition({
          name: params.name,
          description: params.description,
          icon: normalizeWorkflowIcon(params.icon),
          ir,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          layout: params.layout as any,
        });
        return {
          content: [{ type: "text" as const, text: `Created workflow ${created.id} (${created.name}).${approvalNote}` }],
          details: { workflowId: created.id, name: created.name },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        if (err instanceof ColumnAgentBindingError) {
          return columnAgentBindingErrorResult(err);
        }
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to create workflow: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

/**
 * Create a `fn_workflow_update` tool — a thin wrapper over the store's workflow
 * definition update. When an IR change removes a still-occupied column, the store
 * throws an OccupiedColumnsError; we surface it as a structured response carrying
 * the per-column occupant counts so the agent can retry with `rehome_to`.
 */
export function createWorkflowUpdateTool(
  store: TaskStore,
  opts?: WorkflowAuthoringToolOptions,
): ToolDefinition {
  return {
    name: "fn_workflow_update",
    label: "Update Workflow",
    description:
      "Update a custom workflow definition (name/description/ir/layout). Built-ins cannot be edited. " +
      "If an IR change removes a column that still holds cards, the update is blocked and returns the " +
      "occupied columns — retry with rehome_to set to a column id that survives in the new IR. " +
      "The IR accepts the same step-inversion constructs as fn_workflow_create (foreach with mode/isolation/" +
      "concurrency, step-execute, step-review, parse-steps, code nodes, rework edges, artifacts, fields, settings). " +
      "Editing `fields` orphans (never destroys) existing task values for removed/incompatible fields. " +
      "Editing `settings` declarations changes the schema; orphaned setting VALUES are dropped on resolution " +
      "(the engine never sees a value that no longer validates). Built-in workflow declarations cannot be edited; " +
      "their per-project VALUES are written via fn_workflow_settings.\n" +
      "Bind a column to a permanent agent via `columns[].agent: { agentId, mode }`: `mode:'defer'` applies the " +
      "column agent only when the work carries no own agent/model settings, while `mode:'override'` supersedes " +
      "node/task settings wholesale. The bound agent must exist; if its permission policy is broader than the " +
      "project default, pass `confirm_policy_escalation: true` to confirm (the update is otherwise rejected).",
    parameters: workflowUpdateParams,
    execute: async (_id: string, params: Static<typeof workflowUpdateParams>) => {
      try {
        let approvalNote = "";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let ir = params.ir as any;
        if (ir !== undefined && ir !== null) {
          if (opts?.stripApprovalFlags) {
            const result = stripApprovalBypassFlags(ir);
            ir = result.ir;
            if (result.stripped) approvalNote = " (approval-bypass flags removed)";
          }
          await assertWorkflowColumnAgentBindings(store, ir, params.confirm_policy_escalation === true);
        }
        const updated = await store.updateWorkflowDefinition(params.workflow_id, {
          name: params.name,
          description: params.description,
          ...(params.icon !== undefined ? { icon: normalizeWorkflowIcon(params.icon) ?? null } : {}),
          ir,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          layout: params.layout as any,
          rehomeTo: params.rehome_to,
        });
        return {
          content: [{ type: "text" as const, text: `Updated workflow ${updated.id} (${updated.name}).${approvalNote}` }],
          details: { workflowId: updated.id, name: updated.name },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        if (err instanceof ColumnAgentBindingError) {
          return columnAgentBindingErrorResult(err);
        }
        // Surface the typed OccupiedColumnsError as a structured, retryable result.
        if (err?.name === "OccupiedColumnsError") {
          const occupancies = err.occupancies ?? [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const summary = occupancies.map((o: any) => `${o.columnId} (${o.count})`).join(", ");
          return {
            content: [{
              type: "text" as const,
              text:
                `ERROR: Update removes occupied column(s): ${summary}. ` +
                `Retry with rehome_to set to a surviving column id.`,
            }],
            details: { occupiedColumns: occupancies, workflowId: err.workflowId, retryWith: "rehome_to" },
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to update workflow: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

/**
 * Create a `fn_workflow_delete` tool — a thin wrapper over the store's workflow
 * definition delete. Surfaces built-in protection and not-found errors as
 * structured responses. (The store auto-re-homes occupants to the default
 * workflow on delete, so no rehome target is required here.)
 */
export function createWorkflowDeleteTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_workflow_delete",
    label: "Delete Workflow",
    description:
      "Delete a custom workflow definition. Built-ins cannot be deleted. Any tasks using it have " +
      "their selection cleared and are re-homed to the default workflow's entry column.",
    parameters: workflowDeleteParams,
    execute: async (_id: string, params: Static<typeof workflowDeleteParams>) => {
      try {
        await store.deleteWorkflowDefinition(params.workflow_id);
        return {
          content: [{ type: "text" as const, text: `Deleted workflow ${params.workflow_id}.` }],
          details: { workflowId: params.workflow_id },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        if (err?.name === "OccupiedColumnsError") {
          const occupancies = err.occupancies ?? [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const summary = occupancies.map((o: any) => `${o.columnId} (${o.count})`).join(", ");
          return {
            content: [{
              type: "text" as const,
              text: `ERROR: Delete blocked by occupied column(s): ${summary}.`,
            }],
            details: { occupiedColumns: occupancies, workflowId: err.workflowId },
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to delete workflow: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

/**
 * Create a `fn_workflow_settings` tool — read/write the per-`(workflow, project)`
 * setting VALUES that tune a workflow's policy (step timeouts, review gates, model
 * lanes). This is the agent-native parity with the editor's workflow settings
 * panel and mirrors the two-path contract from U2:
 *
 *  - DECLARATIONS (the typed schema) live in the workflow IR's `settings` array and
 *    are authored via fn_workflow_create/update; built-in declarations are not
 *    editable (the store's built-in guard rejects an IR edit).
 *  - VALUES are written here against the NAMED workflow's declarations via
 *    {@link store.updateWorkflowSettingValues}. Built-in workflow VALUES are
 *    writable (per-project tuning of `builtin:coding`). An invalid value surfaces
 *    the typed rejection list ({@link WorkflowSettingRejectionError}) and persists
 *    nothing — the same contract HTTP/dashboard writers see.
 *
 * `action: "get"` returns both the raw `stored` values and the engine `effective`
 * values (post drop-on-orphan), so an agent sees what it wrote and what the engine
 * will actually consume.
 */
/**
 * Resolve the setting DECLARATIONS for a workflow. Mirrors the store's private
 * `resolveWorkflowSettingDeclarations` (and the dashboard route helper of the
 * same shape): the resolved IR's `settings` when present, else the built-in
 * catalog for built-in ids. Used to compute the `orphaned` value entries.
 */
async function resolveWorkflowSettingDeclarationsForTool(
  store: TaskStore,
  workflowId: string,
): Promise<WorkflowSettingDefinition[] | undefined> {
  const ir = await resolveWorkflowIrById(store, workflowId);
  const declared = ir.version === "v2" ? ir.settings : undefined;
  if (declared && declared.length > 0) return declared;
  if (isBuiltinWorkflowId(workflowId)) return BUILTIN_WORKFLOW_SETTINGS;
  return declared;
}

export function createWorkflowSettingsTool(store: TaskStore): ToolDefinition {
  return {
    name: "fn_workflow_settings",
    label: "Workflow Settings",
    description:
      "Read or write a workflow's setting VALUES (the per-(workflow, project) policy knobs: step " +
      "timeouts, review/approval gates, per-phase model lanes). action='get' returns both the raw " +
      "`stored` values and the engine `effective` values (declaration defaults filled in, orphaned " +
      "values dropped). action='set' writes `values` against the NAMED workflow's declared settings; " +
      "a `null` value clears an override. Built-in workflow VALUES are writable, but built-in " +
      "DECLARATIONS are not — declarations are authored in the workflow IR's `settings` array via " +
      "fn_workflow_create/update. An invalid value returns the typed rejection list and persists nothing.",
    parameters: workflowSettingsParams,
    execute: async (_id: string, params: Static<typeof workflowSettingsParams>, _signal, _onUpdate, context) => {
      const workflowId = params.workflow_id?.trim();
      if (!workflowId) {
        return {
          content: [{ type: "text" as const, text: "ERROR: workflow_id is required." }],
          details: {},
          isError: true,
        };
      }
      let projectId: string;
      try {
        // Resolve the project key the same way the engine resolver does, so agent
        // reads/writes share the store's single project scope.
        projectId = store.getWorkflowSettingsProjectId();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to resolve project: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }

      if (params.action === "get") {
        try {
          const stored = await store.getWorkflowSettingValuesAsync(workflowId, projectId);
          const effective = await resolveEffectiveSettingsById(store, workflowId, projectId);
          const declarations = await resolveWorkflowSettingDeclarationsForTool(store, workflowId);
          const orphaned = findOrphanedSettingValues(declarations, stored);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ workflowId, stored, effective, orphaned }, null, 2),
            }],
            details: { workflowId, stored, effective, orphaned },
          };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `ERROR: Failed to read workflow settings: ${err?.message ?? err}` }],
            details: {},
            isError: true,
          };
        }
      }

      // action === "set"
      const values = params.values;
      if (!values || Object.keys(values).length === 0) {
        return {
          content: [{ type: "text" as const, text: "ERROR: action='set' requires a non-empty `values` map." }],
          details: { error: "No values provided" },
          isError: true,
        };
      }
      try {
        /* FNXC:ConfigVersioning 2026-07-18-00:00: preserve the acting agent identity in workflow-value history. */
        const agentContext = context as unknown as { agentId?: unknown } | undefined;
        const agentId = typeof agentContext?.agentId === "string" ? agentContext.agentId : undefined;
        const next = await store.updateWorkflowSettingValues(workflowId, projectId, values, agentId ? { kind: "agent", id: agentId } : { kind: "system", id: "system" });
        const effective = await resolveEffectiveSettingsById(store, workflowId, projectId);
        const declarations = await resolveWorkflowSettingDeclarationsForTool(store, workflowId);
        const orphaned = findOrphanedSettingValues(declarations, next);
        return {
          content: [{
            type: "text" as const,
            text: `Updated workflow settings for ${workflowId}: ${JSON.stringify(next)}`,
          }],
          details: { workflowId, stored: next, effective, orphaned },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        // Surface the typed rejection list the same way other value writers do
        // (mirrors the custom-field rejection contract) — flat, JSON-safe, with
        // machine-stable codes the agent can branch on and retry.
        if (err instanceof WorkflowSettingRejectionError || err?.name === "WorkflowSettingRejectionError") {
          const rejections = err.rejections ?? [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const summary = rejections.map((r: any) => `${r.settingId} (${r.code})`).join(", ");
          return {
            content: [{
              type: "text" as const,
              text: `ERROR: Rejected workflow setting value(s): ${summary}. Nothing was persisted.`,
            }],
            details: { workflowId, rejections },
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to write workflow settings: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

/**
 * Create a `fn_trait_list` tool that returns the trait catalog from
 * {@link listTraits} — the column-behavior building blocks (id, name, flags)
 * used when authoring workflow columns.
 */
export function createTraitListTool(): ToolDefinition {
  return {
    name: "fn_trait_list",
    label: "List Traits",
    description:
      "List the available column traits (the behavior building blocks for workflow columns): " +
      "id, name, description, and behavior flags. Use when authoring or updating a workflow IR.",
    parameters: traitListParams,
    execute: async () => {
      try {
        const traits = listTraits();
        if (traits.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No traits are registered." }],
            details: { traits: [] },
          };
        }
        const lines = traits.map(
          (t) => `- ${t.id}: ${t.name}${t.description ? ` — ${t.description}` : ""}`,
        );
        return {
          content: [{ type: "text" as const, text: `Available traits:\n${lines.join("\n")}` }],
          details: {
            traits: traits.map((t) => ({ id: t.id, name: t.name, description: t.description, flags: t.flags })),
          },
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to list traits: ${err?.message ?? err}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

/**
 * Assemble the full workflow-authoring tool surface for a single store-scoped
 * lane (chat / planning / executor): workflow discovery, selection, mutation,
 * settings, and `fn_trait_list` (trait vocabulary needed to author/update
 * workflow IR).
 *
 * FNXC:WorkflowAuthoringTools 2026-06-29-23:38:
 * Prompt-injectable chat/planning lanes need settings and trait discovery next to create/update/delete so agents can author policy-aware workflows without falling back to unpublished surfaces.
 * Centralizing the list keeps those lanes from drifting away as new workflow authoring tools are added. `currentTaskId` is the default task for `fn_workflow_select`; lanes with no ambient task pass a placeholder (an agent can still target any task via the `task_id` param).
 */
/**
 * Options for the workflow authoring tool set.
 *
 * `stripApprovalFlags` removes the `cliSkipApproval`/`autoApprove` approval-
 * bypass flags from every node config (incl. nested foreach templates) before
 * the create/update tools persist the IR. Chat and planning lanes are prompt-
 * injectable, so they pass `true`; the executor lane (project-owner escape
 * hatch) omits it so the dashboard editor can deliberately set those flags.
 */
export interface WorkflowAuthoringToolOptions {
  stripApprovalFlags?: boolean;
}

export function createWorkflowAuthoringTools(
  store: TaskStore,
  currentTaskId: string,
  opts?: WorkflowAuthoringToolOptions,
): ToolDefinition[] {
  return [
    createWorkflowListTool(store),
    createWorkflowGetTool(store),
    createWorkflowValidateTool(store),
    createWorkflowSelectTool(store, currentTaskId),
    createWorkflowCreateTool(store, opts),
    createWorkflowUpdateTool(store, opts),
    createWorkflowDeleteTool(store),
    createWorkflowSettingsTool(store),
    createTraitListTool(),
  ];
}

export function createMemorySearchTool(rootDir: string, settings?: MemoryToolSettings, options?: MemoryToolOptions): ToolDefinition {
  return {
    name: "fn_memory_search",
    label: "Search Memory",
    description:
      "Search durable project memory and this agent's own memory, returning small snippets with file paths and line ranges. " +
      "Use this before fn_memory_get; do not read all memory by default.",
    parameters: memorySearchParams,
    execute: async (_id: string, params: Static<typeof memorySearchParams>) => {
      const limit = params.limit ?? 5;
      const agentResults = options?.agentMemory
        ? resolveMemoryBackend(settings).type === "qmd"
          ? await searchAgentMemoryWithQmd(rootDir, options.agentMemory, params.query, limit)
          : await searchAgentMemoryFile(rootDir, options.agentMemory, params.query, limit)
        : [];
      const projectResults = await searchProjectMemory(rootDir, {
        query: params.query,
        limit,
      }, settings);
      const results = [...agentResults, ...projectResults]
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "NONE" }],
          details: { results: [] },
        };
      }

      const text = results.map((result, index) => [
        `${index + 1}. ${result.path}:${result.lineStart}-${result.lineEnd} (score ${result.score}, ${result.backend})`,
        result.snippet,
      ].join("\n")).join("\n\n");
      return { content: [{ type: "text" as const, text }], details: { results } };
    },
  };
}

export function createMemoryGetTool(rootDir: string, settings?: MemoryToolSettings, options?: MemoryToolOptions): ToolDefinition {
  return {
    name: "fn_memory_get",
    label: "Get Memory",
    description:
      "Read a bounded line window from a memory file returned by fn_memory_search. " +
      "Allowed files include project memory under .fusion/memory/ and this agent's own .fusion/agent-memory/{agentId}/MEMORY.md file.",
    parameters: memoryGetParams,
    execute: async (_id: string, params: Static<typeof memoryGetParams>) => {
      const agentResult = options?.agentMemory
        ? await getAgentMemoryWindow(rootDir, options.agentMemory, params.path, params.startLine, params.lineCount)
        : null;
      if (agentResult) {
        return {
          content: [{
            type: "text" as const,
            text: `${agentResult.path}:${agentResult.startLine}-${agentResult.endLine} (${agentResult.totalLines} total lines, ${agentResult.backend})\n\n${agentResult.content}`,
          }],
          details: agentResult,
        };
      }
      const result = await getProjectMemory(rootDir, {
        path: params.path,
        startLine: params.startLine,
        lineCount: params.lineCount,
      }, settings);
      return {
        content: [{
          type: "text" as const,
          text: `${result.path}:${result.startLine}-${result.endLine} (${result.totalLines} total lines, ${result.backend})\n\n${result.content}`,
        }],
        details: result,
      };
    },
  };
}

export function createMemoryAppendTool(rootDir: string, settings?: MemoryToolSettings, options?: MemoryToolOptions): ToolDefinition {
  return {
    name: "fn_memory_append",
    label: "Append Memory",
    description:
      "Append concise Markdown to memory. Use scope=\"agent\" for private operating context and scope=\"project\" for workspace-wide durable knowledge. " +
      "Use layer=\"long-term\" for durable conventions/decisions/pitfalls and layer=\"daily\" for running observations/open loops.",
    parameters: memoryAppendParams,
    execute: async (_id: string, params: Static<typeof memoryAppendParams>) => {
      const content = params.content.trim();
      if (!content) {
        return { content: [{ type: "text" as const, text: "ERROR: memory content cannot be empty" }], details: {} };
      }
      const scope = params.scope ?? "project";

      if (scope === "agent") {
        if (!options?.agentMemory) {
          return { content: [{ type: "text" as const, text: "ERROR: agent memory is not available in this session" }], details: {} };
        }
        const agentMemory = options.agentMemory;
        await syncAgentMemoryFile(rootDir, agentMemory);
        const targetPath = params.layer === "long-term"
          ? agentMemoryFilePath(rootDir, agentMemory.agentId)
          : agentDailyFilePath(rootDir, agentMemory.agentId);
        await appendFile(targetPath, `\n${content}\n`, "utf-8");
        if (resolveMemoryBackend(settings).type === "qmd") {
          void refreshAgentMemoryQmdIndex(rootDir, agentMemory).catch((err) => {
            log.warn(
              `Agent memory QMD index refresh failed for ${agentMemory.agentId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
        return {
          content: [{ type: "text" as const, text: `Appended to agent ${params.layer} memory.` }],
          details: { scope, layer: params.layer },
        };
      }

      await ensureOpenClawMemoryFiles(rootDir);
      const targetPath = params.layer === "long-term" ? memoryLongTermPath(rootDir) : dailyMemoryPath(rootDir);
      await appendFile(targetPath, `\n${content}\n`, "utf-8");
      if (resolveMemoryBackend(settings).type === "qmd") {
        scheduleQmdProjectMemoryRefresh(rootDir);
      }
      return {
        content: [{ type: "text" as const, text: `Appended to ${params.layer} memory.` }],
        details: { scope, layer: params.layer },
      };
    },
  };
}

export function createWebFetchTool(options?: { allowPrivateHosts?: boolean }): ToolDefinition {
  return {
    name: "fn_web_fetch",
    label: "WebFetch",
    description: "Fetch and extract readable text from a URL (lightweight HTTP fetch, no JS rendering).",
    parameters: webFetchParams,
    execute: async (_id: string, params: Static<typeof webFetchParams>) => {
      try {
        const result = await fetchWebContent(params.url, {
          timeoutMs: params.timeoutMs,
          maxBytes: params.maxBytes,
          allowPrivateHosts: options?.allowPrivateHosts ?? false,
        });
        const sections = [
          `URL: ${result.finalUrl}`,
          `Status: ${result.status}`,
          `Content-Type: ${result.contentType}`,
          params.prompt ? `Prompt: ${params.prompt}` : undefined,
          result.title ? `Title: ${result.title}` : undefined,
          "",
          result.content,
          result.truncated ? "\n[truncated to maxBytes]" : "",
        ].filter(Boolean);
        return {
          content: [{ type: "text" as const, text: sections.join("\n") }],
          details: {
            finalUrl: result.finalUrl,
            status: result.status,
            contentType: result.contentType,
            title: result.title,
            truncated: result.truncated,
            bytesRead: result.bytesRead,
            prompt: params.prompt,
          },
        };
      } catch (error) {
        if (error instanceof WebFetchError) {
          return {
            content: [{ type: "text" as const, text: `ERROR [${error.code}]: ${error.message}` }],
            details: { code: error.code, message: error.message },
            isError: true,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `ERROR [network-error]: ${message}` }],
          details: { code: "network-error", message },
          isError: true,
        };
      }
    },
  };
}

export function createMemoryTools(rootDir: string, settings?: MemoryToolSettings, options?: MemoryToolOptions): ToolDefinition[] {
  if (settings?.memoryEnabled === false) {
    return [];
  }
  const tools = [
    createMemorySearchTool(rootDir, settings, options),
    createMemoryGetTool(rootDir, settings, options),
  ];
  if (getMemoryBackendCapabilities(settings).writable) {
    tools.push(createMemoryAppendTool(rootDir, settings, options));
  }
  return tools;
}

const GOAL_LIST_HARD_LIMIT = 5;
const GOAL_LIST_SOFT_WARNING_THRESHOLD = 3;
const GOAL_SNIPPET_MAX_CHARS = 80;

type GoalAuditContext = {
  runId?: string;
  agentId?: string;
  taskId?: string;
};

type GoalListDetailsEntry = {
  id: string;
  title: string;
  status: GoalStatus;
  snippet?: string;
};

function buildGoalSnippet(description?: string): string | undefined {
  const firstLine = description?.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim();
  if (!firstLine) return undefined;
  if (firstLine.length <= GOAL_SNIPPET_MAX_CHARS) return firstLine;
  return `${firstLine.slice(0, GOAL_SNIPPET_MAX_CHARS - 1).trimEnd()}…`;
}

function buildGoalListDetailsEntry(goal: { id: string; title: string; status: GoalStatus; description?: string }): GoalListDetailsEntry {
  const snippet = buildGoalSnippet(goal.description);
  return snippet
    ? { id: goal.id, title: goal.title, status: goal.status, snippet }
    : { id: goal.id, title: goal.title, status: goal.status };
}

function formatGoalListLine(goal: GoalListDetailsEntry): string {
  return `- ${goal.id} [${goal.status}] ${goal.title}${goal.snippet ? ` — ${goal.snippet}` : ""}`;
}

function resolveGoalAuditContext(
  ctx: unknown,
  runContext?: RunMutationContext,
  taskId?: string,
): GoalAuditContext {
  const candidate = typeof ctx === "object" && ctx !== null ? ctx as Record<string, unknown> : {};
  const runId = typeof candidate.runId === "string" ? candidate.runId : runContext?.runId;
  const agentId = typeof candidate.agentId === "string" ? candidate.agentId : runContext?.agentId;
  const resolvedTaskId = typeof candidate.taskId === "string" ? candidate.taskId : taskId;
  return { runId, agentId, taskId: resolvedTaskId };
}

export function createGoalListTool(
  store: TaskStore,
  options?: { runContext?: RunMutationContext; taskId?: string },
): ToolDefinition {
  return {
    name: "fn_goal_list",
    label: "List Goals",
    description: "List goals by status with active-goal warning details.",
    parameters: goalListParams,
    execute: async (_id: string, params: Static<typeof goalListParams>, _signal, _onUpdate, ctx) => {
      const goalStore = store.getGoalStore();
      const status = params.status ?? "active";
      const goals = status === "all" ? await goalStore.listGoals() : await goalStore.listGoals({ status });
      const activeCount = (await goalStore.listGoals({ status: "active" })).length;
      const softWarning = activeCount >= GOAL_LIST_SOFT_WARNING_THRESHOLD;
      const goalEntries = goals.map(buildGoalListDetailsEntry);

      emitGoalRetrievalAudit(
        store,
        resolveGoalAuditContext(ctx, options?.runContext, options?.taskId),
        {
          toolName: "fn_goal_list",
          resultCount: goals.length,
          goalIds: goals.map((goal) => goal.id),
        },
      );

      const lines: string[] = [
        `Goals (${goals.length}) [filter: ${status}]`,
        `Active: ${activeCount}/${GOAL_LIST_HARD_LIMIT}`,
      ];
      if (softWarning) {
        lines.push(`⚠  ${GOAL_LIST_SOFT_WARNING_THRESHOLD}/${GOAL_LIST_HARD_LIMIT} active goals — soft warning at ${GOAL_LIST_SOFT_WARNING_THRESHOLD}, hard cap at ${GOAL_LIST_HARD_LIMIT}`);
      }
      lines.push("");
      if (goalEntries.length === 0) {
        lines.push("No goals found.");
      } else {
        lines.push(...goalEntries.map(formatGoalListLine));
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          goals: goalEntries,
          activeCount,
          softWarning,
          hardLimit: GOAL_LIST_HARD_LIMIT,
        },
      };
    },
  };
}

export function createGoalShowTool(
  store: TaskStore,
  options?: { runContext?: RunMutationContext; taskId?: string },
): ToolDefinition {
  return {
    name: "fn_goal_show",
    label: "Show Goal",
    description: "Show full details for a single goal by ID.",
    parameters: goalShowParams,
    execute: async (_id: string, params: Static<typeof goalShowParams>, _signal, _onUpdate, ctx) => {
      const goalStore = store.getGoalStore();
      const goal = await goalStore.getGoal(params.id);
      const auditContext = resolveGoalAuditContext(ctx, options?.runContext, options?.taskId);

      if (!goal) {
        emitGoalRetrievalAudit(store, auditContext, {
          toolName: "fn_goal_show",
          resultCount: 0,
          goalId: params.id,
          goalIds: [],
          notFound: true,
        });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Goal ${params.id} not found` }],
          details: { code: "GOAL_NOT_FOUND", goalId: params.id },
        };
      }

      const lines = [
        `${goal.id}: ${goal.title}`,
        `Status: ${goal.status}`,
        `Created: ${goal.createdAt}`,
        `Updated: ${goal.updatedAt}`,
        ...(goal.description ? [`Description: ${goal.description}`] : []),
      ];

      emitGoalRetrievalAudit(store, auditContext, {
        toolName: "fn_goal_show",
        resultCount: 1,
        goalId: params.id,
        goalIds: [params.id],
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { goal },
      };
    },
  };
}

export function createGoalRetrievalTools(
  store: TaskStore,
  options?: { runContext?: RunMutationContext; taskId?: string },
): ToolDefinition[] {
  return [
    createGoalListTool(store, options),
    createGoalShowTool(store, options),
  ];
}


/*
FNXC:MissionToolParity 2026-07-29-12:00:
FN-8294 requires every engine-managed lane to use TaskStore's project-scoped MissionStore
instead of reproducing route or pi-extension persistence. Mutations deliberately remain plain
ToolDefinitions: session action/permanent-agent gates classify their names at the boundary.
*/
export const missionListParams = Type.Object({});
export const missionShowParams = Type.Object({ id: Type.String({ description: "Mission ID (e.g., M-001)" }) });
export const missionCreateParams = Type.Object({
  title: Type.String({ description: "Mission title — brief but descriptive" }),
  description: Type.Optional(Type.String({ description: "Detailed mission objectives and context" })),
  autoAdvance: Type.Optional(Type.Boolean({ description: "Automatically activate the next pending slice" })),
  baseBranch: Type.Optional(Type.String({ description: "Optional integration base branch" })),
});
export const missionUpdateParams = Type.Object({ id: Type.String(), title: Type.Optional(Type.String()), description: Type.Optional(Type.String()) });
export const missionDeleteParams = Type.Object({ id: Type.String() });
export const milestoneAddParams = Type.Object({ missionId: Type.String(), title: Type.String(), description: Type.Optional(Type.String()) });
export const milestoneUpdateParams = Type.Object({ id: Type.String(), title: Type.Optional(Type.String()), description: Type.Optional(Type.String()), acceptanceCriteria: Type.Optional(Type.String()) });
export const milestoneDeleteParams = Type.Object({ milestoneId: Type.String(), force: Type.Optional(Type.Boolean()) });
export const sliceAddParams = Type.Object({ milestoneId: Type.String(), title: Type.String(), description: Type.Optional(Type.String()) });
export const sliceActivateParams = Type.Object({ id: Type.String() });
export const sliceDeleteParams = Type.Object({ sliceId: Type.String(), force: Type.Optional(Type.Boolean()) });
export const featureAddParams = Type.Object({ sliceId: Type.String(), title: Type.String(), description: Type.Optional(Type.String()), acceptanceCriteria: Type.Optional(Type.String()) });
export const featureUpdateParams = Type.Object({ id: Type.String(), title: Type.Optional(Type.String()), description: Type.Optional(Type.String()), acceptanceCriteria: Type.Optional(Type.String()) });
export const featureDeleteParams = Type.Object({ featureId: Type.String(), force: Type.Optional(Type.Boolean()) });
export const featureLinkTaskParams = Type.Object({ featureId: Type.String(), taskId: Type.String() });
export const researchFindingPromoteParams = Type.Object({
  runId: Type.String(),
  findingId: Type.String(),
  sliceId: Type.String(),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  acceptanceCriteria: Type.Optional(Type.String()),
  triage: Type.Optional(Type.Boolean()),
  taskId: Type.Optional(Type.String()),
});

const missionToolResult = (text: string, details: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}),
});
const optionalText = (value: string | undefined) => value?.trim() || undefined;
/* FNXC:MissionToolParity 2026-07-30-09:56: A supplied empty update value must remain an empty string so MissionStore can clear it, matching the pi-extension contract; only omitted values leave a field unchanged. */
const updateFields = (params: Record<string, unknown>, fields: string[]) => Object.fromEntries(
  fields.filter((field) => params[field] !== undefined).map((field) => [field, (params[field] as string).trim()]),
);

/** Create the project-scoped Mission hierarchy surface shared by engine lanes and dashboard chat. */
export function createMissionTools(store: TaskStore): ToolDefinition[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const tool = (name: string, label: string, description: string, parameters: any, execute: (params: any) => Promise<ReturnType<typeof missionToolResult>>): ToolDefinition => ({
    name, label, description, parameters,
    execute: async (_id, params: any) => { try { return await execute(params); } catch (error) { const message = error instanceof Error ? error.message : String(error); return missionToolResult(`ERROR: ${message}`, { error: message }, true); } },
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return [
    tool("fn_mission_list", "List Missions", "List all missions with their current status.", missionListParams, async () => { const missions = await store.getMissionStore().listMissions(); return missionToolResult(missions.length ? `Missions (${missions.length})\n${missions.map((m) => `- ${m.id}: ${m.title} (${m.status})`).join("\n")}` : "No missions yet.", { missions, count: missions.length }); }),
    tool("fn_mission_show", "Show Mission", "Show a mission with its full milestone, slice, and feature hierarchy.", missionShowParams, async ({ id }) => { const mission = await store.getMissionStore().getMissionWithHierarchy(id); return mission ? missionToolResult(`${mission.id}: ${mission.title}`, { mission }) : missionToolResult(`Mission ${id} not found`, { code: "MISSION_NOT_FOUND", missionId: id }, true); }),
    tool("fn_mission_create", "Create Mission", "Create a high-level mission.", missionCreateParams, async (p) => { const ms = store.getMissionStore(); const mission = await ms.createMission({ title: p.title.trim(), description: optionalText(p.description), baseBranch: optionalText(p.baseBranch) }); const updated = p.autoAdvance === undefined ? mission : await ms.updateMission(mission.id, { autoAdvance: p.autoAdvance }); return missionToolResult(`Created ${updated.id}: ${updated.title}`, { mission: updated }); }),
    tool("fn_mission_update", "Update Mission", "Partially update a mission.", missionUpdateParams, async (p) => { const updates = updateFields(p, ["title", "description"]); if (!Object.keys(updates).length) return missionToolResult("No fields to update", {}, true); const mission = await store.getMissionStore().updateMission(p.id, updates); return missionToolResult(`Updated ${mission.id}: ${mission.title}`, { mission }); }),
    tool("fn_mission_delete", "Delete Mission", "Delete a mission and its hierarchy.", missionDeleteParams, async ({ id }) => { await store.getMissionStore().deleteMission(id); return missionToolResult(`Deleted ${id}`, { missionId: id }); }),
    tool("fn_milestone_add", "Add Milestone", "Add a milestone to a mission.", milestoneAddParams, async (p) => { const milestone = await store.getMissionStore().addMilestone(p.missionId, { title: p.title.trim(), description: optionalText(p.description) }); return missionToolResult(`Added ${milestone.id}`, { milestone }); }),
    tool("fn_milestone_update", "Update Milestone", "Partially update a milestone.", milestoneUpdateParams, async (p) => { const updates = updateFields(p, ["title", "description", "acceptanceCriteria"]); if (!Object.keys(updates).length) return missionToolResult("No fields to update", {}, true); const milestone = await store.getMissionStore().updateMilestone(p.id, updates); return missionToolResult(`Updated ${milestone.id}`, { milestone }); }),
    tool("fn_milestone_delete", "Delete Milestone", "Delete a milestone and descendants.", milestoneDeleteParams, async (p) => { await store.getMissionStore().deleteMilestone(p.milestoneId, p.force === true); return missionToolResult(`Deleted ${p.milestoneId}`, { milestoneId: p.milestoneId }); }),
    tool("fn_slice_add", "Add Slice", "Add a slice to a milestone.", sliceAddParams, async (p) => { const slice = await store.getMissionStore().addSlice(p.milestoneId, { title: p.title.trim(), description: optionalText(p.description) }); return missionToolResult(`Added ${slice.id}`, { slice }); }),
    tool("fn_slice_activate", "Activate Slice", "Activate a pending slice.", sliceActivateParams, async ({ id }) => { const slice = await store.getMissionStore().activateSlice(id); return missionToolResult(`Activated ${slice.id}`, { slice }); }),
    tool("fn_slice_delete", "Delete Slice", "Delete a slice and descendants.", sliceDeleteParams, async (p) => { await store.getMissionStore().deleteSlice(p.sliceId, p.force === true); return missionToolResult(`Deleted ${p.sliceId}`, { sliceId: p.sliceId }); }),
    tool("fn_feature_add", "Add Feature", "Add a feature to a slice.", featureAddParams, async (p) => { const feature = await store.getMissionStore().addFeature(p.sliceId, { title: p.title.trim(), description: optionalText(p.description), acceptanceCriteria: optionalText(p.acceptanceCriteria) }); return missionToolResult(`Added ${feature.id}`, { feature }); }),
    tool("fn_feature_update", "Update Feature", "Partially update a feature.", featureUpdateParams, async (p) => { const updates = updateFields(p, ["title", "description", "acceptanceCriteria"]); if (!Object.keys(updates).length) return missionToolResult("No fields to update", {}, true); const feature = await store.getMissionStore().updateFeature(p.id, updates); return missionToolResult(`Updated ${feature.id}`, { feature }); }),
    tool("fn_feature_delete", "Delete Feature", "Delete a feature, respecting linked-task guards.", featureDeleteParams, async (p) => { await store.getMissionStore().deleteFeature(p.featureId, p.force ===true); return missionToolResult(`Deleted ${p.featureId}`, { featureId: p.featureId }); }),
    tool("fn_feature_link_task", "Link Feature to Task", "Link a feature to a live project-scoped task.", featureLinkTaskParams, async (p) => { const feature = await store.getMissionStore().linkFeatureToTask(p.featureId, p.taskId); return missionToolResult(`Linked ${feature.id} to ${p.taskId}`, { feature }); }),
    tool("fn_research_promote_finding", "Promote Research Finding", "Promote a completed research finding into a canonical mission feature.", researchFindingPromoteParams, async (p) => {
      const missionStore = store.getMissionStore();
      if (!("addResearchFeature" in missionStore)) return missionToolResult("Research promotion requires the PostgreSQL mission store", { code: "POSTGRES_REQUIRED" }, true);
      let promoted: Awaited<ReturnType<typeof fusionCore.promoteResearchFinding>>;
      try {
        promoted = await fusionCore.promoteResearchFinding(store.getResearchStore() as never, missionStore, p);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return missionToolResult(message, { code: message.includes("not completed") ? "RUN_NOT_COMPLETED" : message.includes("not found") ? "FINDING_OR_RUN_NOT_FOUND" : "PROMOTION_FAILED", runId: p.runId, findingId: p.findingId }, true);
      }
      /* FNXC:ResearchMissionBridge 2026-07-18-12:00: All agent promotion flows use the shared completed-run gate and AsyncMissionStore facade; never create a substitute task. */
      let feature = promoted.feature;
      if (p.taskId) feature = await store.getMissionStore().linkFeatureToTask(feature.id, p.taskId);
      if (p.triage) feature = await store.getMissionStore().triageFeature(feature.id);
      return missionToolResult(`${promoted.reused ? "Reused" : "Promoted"} ${promoted.findingId} as ${feature.id}`, { runId: promoted.runId, findingId: promoted.findingId, feature, sliceId: p.sliceId, citations: promoted.citations, reused: promoted.reused, taskId: feature.taskId ?? null, status: feature.status });
    }),
  ];
}

/*
FNXC:Ideation 2026-07-30-15:30:
These tools are the single agent-facing contract for bounded divergence and
atomic convergence. The store owns the shared transaction with MissionStore;
tools never recreate a Mission or persist a parallel prose handoff themselves.
*/
export const ideationStartParams = Type.Object({
  title: Type.String({ minLength: 1, description: "Short title for this bounded ideation session" }),
  prompt: Type.Optional(Type.String({ description: "Optional problem statement or framing prompt" })),
});
export const ideationDivergeParams = Type.Object({
  sessionId: Type.String({ description: "Ideation session ID" }),
  candidates: Type.Array(Type.Object({
    content: Type.String({ minLength: 1, description: "Candidate idea content" }),
    origin: Type.Union([Type.Literal("agent"), Type.Literal("human"), Type.Literal("research")]),
    sourceRef: Type.Optional(Type.String({ description: "Optional provenance reference" })),
  }), { minItems: 1, description: "One or more divergent candidates" }),
});
export const ideationShowParams = Type.Object({ id: Type.String({ description: "Ideation session ID" }) });
export const ideationConvergeParams = Type.Object({
  sessionId: Type.String({ description: "Open ideation session ID" }),
  candidateId: Type.String({ description: "Explicitly selected candidate ID" }),
  targetMissionId: Type.Optional(Type.String({ description: "Existing Mission to attach to; omit to create one" })),
  targetFeatureId: Type.Optional(Type.String({ description: "Optional Feature in the target Mission" })),
});

const ideationToolResult = (text: string, details: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}),
});

/** Create the persisted ideation surface shared by executor, triage, heartbeat, and chat. */
export function createIdeationTools(store: TaskStore): ToolDefinition[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const tool = (name: string, label: string, description: string, parameters: any, execute: (params: any) => Promise<ReturnType<typeof ideationToolResult>>): ToolDefinition => ({
    name, label, description, parameters,
    execute: async (_id, params: any) => {
      try { return await execute(params); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); return ideationToolResult(`ERROR: ${message}`, { error: message }, true); }
    },
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return [
    tool("fn_ideation_list", "List Ideation Sessions", "List persisted ideation sessions.", Type.Object({}), async () => {
      const sessions = await store.getIdeationStore().listSessions();
      return ideationToolResult(sessions.length ? `Ideation sessions (${sessions.length})\n${sessions.map((session) => `- ${session.id}: ${session.title} (${session.status})`).join("\n")}` : "No ideation sessions yet.", { sessions, count: sessions.length });
    }),
    tool("fn_ideation_show", "Show Ideation Session", "Show one ideation session and its divergent candidates.", ideationShowParams, async ({ id }) => {
      const session = await store.getIdeationStore().getSessionWithCandidates(id);
      return session ? ideationToolResult(`${session.id}: ${session.title}`, { session }) : ideationToolResult(`Ideation session ${id} not found`, { code: "IDEATION_SESSION_NOT_FOUND", sessionId: id }, true);
    }),
    tool("fn_ideation_start", "Start Ideation", "Create a bounded persisted ideation session.", ideationStartParams, async ({ title, prompt }) => {
      const session = await store.getIdeationStore().createSession({ title, prompt });
      return ideationToolResult(`Started ${session.id}: ${session.title}`, { session });
    }),
    tool("fn_ideation_diverge", "Record Divergent Candidates", "Record one or more divergent candidates with provenance.", ideationDivergeParams, async ({ sessionId, candidates }) => {
      const ideation = store.getIdeationStore();
      const created = [];
      for (const candidate of candidates) created.push(await ideation.addCandidate(sessionId, candidate));
      return ideationToolResult(`Recorded ${created.length} candidate${created.length === 1 ? "" : "s"}`, { candidates: created });
    }),
    tool("fn_ideation_converge", "Converge Ideation", "Select a candidate and atomically create or attach its canonical Mission handoff.", ideationConvergeParams, async ({ sessionId, candidateId, targetMissionId, targetFeatureId }) => {
      const session = await store.getIdeationStore().convergeSession(sessionId, candidateId, { targetMissionId, targetFeatureId });
      return ideationToolResult(`Converged ${session.id} into Mission ${session.targetMissionId}`, { session, targetMissionId: session.targetMissionId, targetFeatureId: session.targetFeatureId });
    }),
  ];
}

/**
 * Create a `fn_reflect_on_performance` tool that asks the reflection service to
 * analyze recent agent performance and return actionable insights.
 */
export function createReflectOnPerformanceTool(
  reflectionService: AgentReflectionService,
  agentId: string,
): ToolDefinition {
  return {
    name: "fn_reflect_on_performance",
    label: "Reflect on Performance",
    description:
      'Review your past task performance and generate insights for improvement. Optionally focus on a specific area like "code quality", "speed", or "testing".',
    parameters: reflectOnPerformanceParams,
    execute: async (_id: string, params: Static<typeof reflectOnPerformanceParams>) => {
      const triggerDetail = params.focus_area
        ? `Agent-initiated reflection focused on: ${params.focus_area}`
        : "Agent-initiated reflection";

      const reflection = await reflectionService.generateReflection(agentId, "manual", {
        triggerDetail,
      });

      if (!reflection) {
        return {
          content: [{ type: "text" as const, text: "No reflection data available — not enough history yet." }],
          details: {},
        };
      }

      const formattedText = [
        `Summary: ${reflection.summary}`,
        "",
        "Insights:",
        ...reflection.insights.map((insight, index) => `${index + 1}. ${insight}`),
        "",
        "Suggested Improvements:",
        ...reflection.suggestedImprovements.map((improvement, index) => `${index + 1}. ${improvement}`),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: formattedText }],
        details: {},
      };
    },
  };
}

/**
 * Create a `fn_list_agents` tool that lists all available agents.
 *
 * @param agentStore - AgentStore for agent discovery
 * @returns ToolDefinition for the `fn_list_agents` tool
 */
function formatScore(score: number | null | undefined): string {
  if (typeof score !== "number" || !Number.isFinite(score)) return "n/a";
  return score.toFixed(2);
}

function buildPreview(value: string, limit = 100): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

export function createReadEvaluationsTool(
  agentStore: AgentStore,
  reflectionStore: ReflectionStore | undefined,
  agentId: string,
): ToolDefinition {
  return {
    name: "fn_read_evaluations",
    label: "Read Evaluations",
    description: "Read your ratings, recent feedback, and reflection history to support self-improvement.",
    parameters: readEvaluationsParams,
    execute: async (_id: string, _params: Static<typeof readEvaluationsParams>) => {
      const [summary, ratings] = await Promise.all([
        agentStore.getRatingSummary(agentId),
        agentStore.getRatings(agentId, { limit: 10 }),
      ]);

      const latestReflection = reflectionStore
        ? await reflectionStore.getLatestReflection(agentId)
        : null;
      const reflections = reflectionStore
        ? await reflectionStore.getReflections(agentId, 5)
        : [];

      const hasRatings = ratings.length > 0 || summary.totalRatings > 0;
      const hasReflections = Boolean(latestReflection) || reflections.length > 0;

      if (!hasRatings && !hasReflections) {
        return {
          content: [{ type: "text" as const, text: "No evaluation data available yet." }],
          details: {},
        };
      }

      const lines: string[] = [
        "Evaluation Summary",
        `- Average score: ${formatScore(summary.averageScore)}`,
        `- Trend: ${summary.trend}`,
        `- Total ratings: ${summary.totalRatings}`,
      ];

      const categoryEntries = Object.entries(summary.categoryAverages ?? {});
      if (categoryEntries.length > 0) {
        lines.push("", "Category averages:");
        for (const [category, score] of categoryEntries) {
          lines.push(`- ${category}: ${formatScore(score)}`);
        }
      }

      const commentedRatings = ratings.filter((rating) => rating.comment?.trim());
      if (commentedRatings.length > 0) {
        lines.push("", "Recent rating comments:");
        for (const rating of commentedRatings.slice(0, 5)) {
          lines.push(`- [${rating.score}/5] ${rating.comment!.trim()}`);
        }
      }

      if (latestReflection) {
        lines.push("", "Latest reflection:", `- Summary: ${latestReflection.summary}`);
        if (latestReflection.insights.length > 0) {
          lines.push("- Insights:");
          latestReflection.insights.forEach((insight) => lines.push(`  - ${insight}`));
        }
        if (latestReflection.suggestedImprovements.length > 0) {
          lines.push("- Suggested improvements:");
          latestReflection.suggestedImprovements.forEach((item) => lines.push(`  - ${item}`));
        }
      }

      if (reflections.length > 0) {
        lines.push("", "Recent reflection history:");
        for (const reflection of reflections.slice(0, 5)) {
          lines.push(`- ${reflection.timestamp}: ${reflection.summary}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {},
      };
    },
  };
}

export function createUpdateIdentityTool(agentStore: AgentStore, agentId: string): ToolDefinition {
  return {
    name: "fn_update_identity",
    label: "Update Identity",
    description: "Update your own soul, instructionsText, or memory fields based on evaluation feedback.",
    parameters: updateIdentityParams,
    execute: async (_id: string, params: Static<typeof updateIdentityParams>) => {
      const updates: AgentUpdateInput = {};

      if (params.soul !== undefined) {
        const soul = params.soul.trim();
        if (soul.length > MAX_SOUL_LENGTH) {
          return {
            content: [{ type: "text" as const, text: `ERROR: soul exceeds ${MAX_SOUL_LENGTH} character limit` }],
            details: {},
          };
        }
        updates.soul = soul;
      }

      if (params.instructionsText !== undefined) {
        const instructionsText = params.instructionsText.trim();
        if (instructionsText.length > MAX_INSTRUCTIONS_TEXT_LENGTH) {
          return {
            content: [{ type: "text" as const, text: `ERROR: instructionsText exceeds ${MAX_INSTRUCTIONS_TEXT_LENGTH} character limit` }],
            details: {},
          };
        }
        updates.instructionsText = instructionsText;
      }

      if (params.memory !== undefined) {
        const memory = params.memory.trim();
        if (memory.length > MAX_MEMORY_LENGTH) {
          return {
            content: [{ type: "text" as const, text: `ERROR: memory exceeds ${MAX_MEMORY_LENGTH} character limit` }],
            details: {},
          };
        }
        updates.memory = memory;
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Provide at least one field to update" }],
          details: {},
        };
      }

      await agentStore.updateAgent(agentId, updates);

      const confirmations = Object.entries(updates).map(([key, value]) => `- ${key}: ${buildPreview(String(value))}`);
      return {
        content: [{
          type: "text" as const,
          text: `Updated identity fields:\n${confirmations.join("\n")}`,
        }],
        details: { updatedFields: Object.keys(updates) },
      };
    },
  };
}

export function createListAgentsTool(agentStore: AgentStore): ToolDefinition {
  return {
    name: "fn_list_agents",
    label: "List Agents",
    description:
      "List all available agents in the system. Shows each agent's name, role, state, " +
      "personality (soul), and current assignment. Use this to discover which agents exist " +
      "and what they specialize in before delegating work.",
    parameters: listAgentsParams,
    execute: async (_id: string, params: Static<typeof listAgentsParams>) => {
      const filter: { role?: AgentCapability; state?: AgentState; includeEphemeral?: boolean } = {};
      if (params.role) filter.role = params.role as AgentCapability;
      if (params.state) filter.state = params.state as AgentState;
      if (params.includeEphemeral !== undefined) filter.includeEphemeral = params.includeEphemeral;

      const agents = await agentStore.listAgents(filter);

      if (agents.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No agents found matching the specified filters." }],
          details: {},
        };
      }

      const lines = await Promise.all(agents.map(async (agent) => {
        const parts: string[] = [
          `ID: ${agent.id}`,
          `Name: ${agent.name}`,
          `Role: ${agent.role}`,
          `State: ${agent.state}`,
        ];

        if (agent.title) parts.push(`Title: ${agent.title}`);
        if (agent.soul) parts.push(`Soul: ${agent.soul.slice(0, 200)}`);
        if (agent.instructionsText) {
          const snippet = agent.instructionsText.slice(0, 100);
          parts.push(`Custom Instructions: ${snippet}${agent.instructionsText.length > 100 ? "…" : ""}`);
        }
        if (agent.taskId) {
          /*
          FNXC:AgentTaskStateDrift 2026-06-27-16:05:
          Show the linked task column in fn_list_agents so parked triage/todo ownership is not mistaken for an in-progress execution mismatch.
          */
          const linkedTask = await agentStore.resolveCurrentTaskLink(agent.taskId);
          parts.push(formatCurrentTaskLine(agent.taskId, linkedTask));
        }

        return parts.join("\n");
      }));

      return {
        content: [{ type: "text" as const, text: `Available agents:\n\n${lines.join("\n\n")}` }],
        details: { agents },
      };
    },
  };
}

/**
 * Create a `fn_delegate_task` tool that creates and assigns a task to a specific agent.
 *
 * @param agentStore - AgentStore for agent lookup
 * @param taskStore - TaskStore for task creation
 * @returns ToolDefinition for the `fn_delegate_task` tool
 */
export function createGetAgentConfigTool(agentStore: AgentStore, callingAgentId: string): ToolDefinition {
  return {
    name: "fn_get_agent_config",
    label: "Get Agent Config",
    description: "Read full configuration for one of your direct-report agents.",
    parameters: getAgentConfigParams,
    execute: async (_id: string, params: Static<typeof getAgentConfigParams>) => {
      const target = await agentStore.getAgent(params.agent_id);
      if (!target) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Agent ${params.agent_id} not found` }],
          details: {},
        };
      }

      if (target.reportsTo !== callingAgentId) {
        return {
          content: [{ type: "text" as const, text: "ERROR: You can only read configuration of agents that report to you" }],
          details: {},
        };
      }

      const runtimeConfig = (target.runtimeConfig ?? {}) as Record<string, unknown>;
      const lines: string[] = [
        `Agent Config: ${target.name} (${target.id})`,
        `Role: ${target.role}`,
        `State: ${target.state}`,
        `Title: ${target.title ?? "(none)"}`,
        `Icon: ${target.icon ?? "(none)"}`,
        "",
        "Soul:",
        target.soul ?? "(none)",
        "",
        "Instructions Text:",
        target.instructionsText ?? "(none)",
        `Instructions Path: ${target.instructionsPath ?? "(none)"}`,
        `Heartbeat Procedure Path: ${target.heartbeatProcedurePath ?? "(none)"}`,
        "",
        "Runtime Config:",
        `heartbeatIntervalMs: ${String(runtimeConfig.heartbeatIntervalMs ?? "(default)")}`,
        `heartbeatTimeoutMs: ${String(runtimeConfig.heartbeatTimeoutMs ?? "(default)")}`,
        `maxConcurrentRuns: ${String(runtimeConfig.maxConcurrentRuns ?? "(default)")}`,
        `messageResponseMode: ${String(runtimeConfig.messageResponseMode ?? "(default)")}`,
        `budget: ${JSON.stringify(runtimeConfig.budget ?? null)}`,
        "",
        "Memory:",
        target.memory ?? "(none)",
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { agent: target },
      };
    },
  };
}

function isCallerPrivileged(caller: { id: string; role: string; reportsTo?: string | null } | null): boolean {
  if (!caller) return false;
  return caller.role === "ceo" || caller.reportsTo == null;
}

export function createUpdateAgentConfigTool(agentStore: AgentStore, callingAgentId: string): ToolDefinition {
  return {
    name: "fn_update_agent_config",
    label: "Update Agent Config",
    description: "Update configuration for one of your direct-report agents.",
    parameters: updateAgentConfigParams,
    execute: async (_id: string, params: Static<typeof updateAgentConfigParams>) => {
      const target = await agentStore.getAgent(params.agent_id);
      if (!target) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Agent ${params.agent_id} not found` }],
          details: {},
        };
      }

      if (target.reportsTo !== callingAgentId) {
        return {
          content: [{ type: "text" as const, text: "ERROR: You can only update configuration of agents that report to you" }],
          details: {},
        };
      }

      if (isEphemeralAgent(target)) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Cannot update ephemeral/runtime agent ${params.agent_id}` }],
          details: {},
        };
      }

      if (params.soul && params.soul.length > 10000) {
        return {
          content: [{ type: "text" as const, text: "ERROR: soul exceeds 10000 character limit" }],
          details: {},
        };
      }
      if (params.instructions_text && params.instructions_text.length > 50000) {
        return {
          content: [{ type: "text" as const, text: "ERROR: instructions_text exceeds 50000 character limit" }],
          details: {},
        };
      }
      if (params.instructions_path && params.instructions_path.length > 500) {
        return {
          content: [{ type: "text" as const, text: "ERROR: instructions_path exceeds 500 character limit" }],
          details: {},
        };
      }
      if (params.heartbeat_procedure_path && params.heartbeat_procedure_path.length > 500) {
        return {
          content: [{ type: "text" as const, text: "ERROR: heartbeat_procedure_path exceeds 500 character limit" }],
          details: {},
        };
      }

      const hasRuntimeConfigUpdates = [
        params.heartbeat_interval_ms,
        params.heartbeat_timeout_ms,
        params.max_concurrent_runs,
        params.message_response_mode,
      ].some((value) => value !== undefined);

      const updateInput: AgentUpdateInput = {};
      if (params.soul !== undefined) updateInput.soul = params.soul;
      if (params.instructions_text !== undefined) updateInput.instructionsText = params.instructions_text;
      if (params.instructions_path !== undefined) updateInput.instructionsPath = params.instructions_path;
      if (params.heartbeat_procedure_path !== undefined) updateInput.heartbeatProcedurePath = params.heartbeat_procedure_path;
      if (hasRuntimeConfigUpdates) {
        updateInput.runtimeConfig = {
          ...((target.runtimeConfig ?? {}) as Record<string, unknown>),
          ...(params.heartbeat_interval_ms !== undefined ? { heartbeatIntervalMs: params.heartbeat_interval_ms } : {}),
          ...(params.heartbeat_timeout_ms !== undefined ? { heartbeatTimeoutMs: params.heartbeat_timeout_ms } : {}),
          ...(params.max_concurrent_runs !== undefined ? { maxConcurrentRuns: params.max_concurrent_runs } : {}),
          ...(params.message_response_mode !== undefined ? { messageResponseMode: params.message_response_mode } : {}),
        };
      }

      if (Object.keys(updateInput).length === 0) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Provide at least one field to update" }],
          details: {},
        };
      }

      const updated = await agentStore.updateAgent(params.agent_id, updateInput);
      const updatedRuntimeConfig = (updated.runtimeConfig ?? {}) as Record<string, unknown>;
      return {
        content: [{
          type: "text" as const,
          text: `Updated ${updated.name} (${updated.id})\n` +
            `heartbeatIntervalMs: ${String(updatedRuntimeConfig.heartbeatIntervalMs ?? "(default)")}\n` +
            `heartbeatTimeoutMs: ${String(updatedRuntimeConfig.heartbeatTimeoutMs ?? "(default)")}\n` +
            `maxConcurrentRuns: ${String(updatedRuntimeConfig.maxConcurrentRuns ?? "(default)")}\n` +
            `messageResponseMode: ${String(updatedRuntimeConfig.messageResponseMode ?? "(default)")}`,
        }],
        details: { agent: updated },
      };
    },
  };
}

/**
 * Create a `fn_delegate_task` tool that creates and assigns a task to a specific agent.
 *
 * @param agentStore - AgentStore for agent lookup
 * @param taskStore - TaskStore for task creation
 * @returns ToolDefinition for the `fn_delegate_task` tool
 */
type AgentProvisioningToolOptions = {
  hireApprovalEnabled?: boolean;
  approvalRequestStore?: ApprovalRequestStore;
  settingsProvider?: () => Promise<ProjectSettings | undefined>;
  runAuditor?: RunAuditor;
};

export function createAgentCreateTool(
  agentStore: AgentStore,
  callingAgentId: string,
  options?: AgentProvisioningToolOptions,
): ToolDefinition {
  return {
    name: "fn_agent_create",
    label: "Create Agent",
    description: "Create a new non-ephemeral direct-report agent.",
    parameters: createAgentParams,
    execute: async (_id: string, params: Static<typeof createAgentParams>) => {
      const caller = await agentStore.getAgent(callingAgentId);
      const privileged = isCallerPrivileged(caller);
      const reportsTo = params.reportsTo ?? callingAgentId;

      if (!privileged && reportsTo !== callingAgentId) {
        return {
          content: [{ type: "text" as const, text: "ERROR: You can only create agents that report to you" }],
          details: {},
        };
      }

      const settings = await options?.settingsProvider?.();
      const fallbackSettings = !options?.settingsProvider && !options?.approvalRequestStore
        ? { agentProvisioning: { approvalMode: "never" as const } }
        : settings;
      const policy = resolveAgentProvisioningPolicy({
        tool: "fn_agent_create",
        caller: caller ? { id: caller.id, role: caller.role, isPrivileged: privileged } : undefined,
        settings: fallbackSettings,
      });
      await options?.runAuditor?.database({ type: "agent:create:requested", target: callingAgentId, metadata: { policy } });

      if (policy.decision === "require-approval") {
        if (!options?.approvalRequestStore) {
          await options?.runAuditor?.database({ type: "agent:create:denied", target: callingAgentId, metadata: { policy, reason: "approval-store-missing" } });
          return {
            content: [{ type: "text" as const, text: `DENIED: agent provisioning requires approval but approval storage is unavailable (${policy.matchedRule})` }],
            details: { outcome: "denied", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode },
          };
        }

        const approvalDedupeKey = computeApprovalDedupeKey({
          agentId: callingAgentId,
          toolName: "fn_agent_create",
          category: "agent_provisioning",
          resourceType: "agent",
          resourceId: reportsTo,
          operation: `create:${params.name}:${params.role}:${reportsTo}`,
        });

        const request = await options.approvalRequestStore.create({
          requester: { actorId: callingAgentId, actorType: "agent", actorName: caller?.name ?? callingAgentId },
          targetAction: {
            category: "agent_provisioning",
            action: "create",
            summary: `Create agent ${params.name} (${params.role})`,
            resourceType: "agent",
            resourceId: "",
            context: { tool: "fn_agent_create", params, approvalDedupeKey },
          },
        });

        return {
          content: [{ type: "text" as const, text: `Approval required to create agent ${params.name}. Request ${request.id} created.` }],
          details: { outcome: "pending_approval", approvalRequestId: request.id, matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode },
        };
      }

      if (policy.decision === "deny") {
        await options?.runAuditor?.database({ type: "agent:create:denied", target: callingAgentId, metadata: { policy } });
        return {
          content: [{ type: "text" as const, text: `DENIED: agent provisioning blocked by policy (${policy.matchedRule})` }],
          details: { outcome: "denied", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode },
        };
      }

      const runtimeConfig: Record<string, unknown> = {
        ...(params.heartbeat_interval_ms !== undefined ? { heartbeatIntervalMs: params.heartbeat_interval_ms } : {}),
        ...(params.heartbeat_timeout_ms !== undefined ? { heartbeatTimeoutMs: params.heartbeat_timeout_ms } : {}),
        ...(params.max_concurrent_runs !== undefined ? { maxConcurrentRuns: params.max_concurrent_runs } : {}),
        ...(params.message_response_mode !== undefined ? { messageResponseMode: params.message_response_mode } : {}),
      };

      const created = await agentStore.createAgent({
        name: params.name,
        role: params.role,
        ...(params.soul !== undefined ? { soul: params.soul } : {}),
        ...(params.instructions_text !== undefined ? { instructionsText: params.instructions_text } : {}),
        ...(params.instructions_path !== undefined ? { instructionsPath: params.instructions_path } : {}),
        reportsTo,
        ...(Object.keys(runtimeConfig).length > 0 ? { runtimeConfig } : {}),
      });

      if (options?.hireApprovalEnabled) {
        await agentStore.updateAgentState(created.id, "paused");
        await agentStore.updateAgent(created.id, {
          metadata: { ...(created.metadata ?? {}), pendingApproval: true },
        });
      }

      await options?.runAuditor?.database({ type: "agent:create:approved", target: created.id, metadata: { policy, autoApproved: true } });
      return {
        content: [{ type: "text" as const, text: `Created agent ${created.name} (${created.id})${options?.hireApprovalEnabled ? " in pending_approval" : ""}` }],
        details: { outcome: "created", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agent: created, agentId: created.id, pendingApproval: options?.hireApprovalEnabled === true },
      };
    },
  };
}

export function createAgentDeleteTool(
  agentStore: AgentStore,
  callingAgentId: string,
  options?: AgentProvisioningToolOptions,
): ToolDefinition {
  return {
    name: "fn_agent_delete",
    label: "Delete Agent",
    description: "Delete one of your direct-report non-ephemeral agents.",
    parameters: deleteAgentParams,
    execute: async (_id: string, params: Static<typeof deleteAgentParams>) => {
      const caller = await agentStore.getAgent(callingAgentId);
      const target = await agentStore.getAgent(params.agent_id);
      if (!target) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Agent ${params.agent_id} not found` }],
          details: { outcome: "denied", matchedRule: "missing-target", effectiveMode: "trusted-only", agentId: params.agent_id },
        };
      }

      const privileged = isCallerPrivileged(caller);
      if (!privileged && target.reportsTo !== callingAgentId) {
        return {
          content: [{ type: "text" as const, text: "ERROR: You can only delete agents that report to you" }],
          details: {},
        };
      }

      if (isEphemeralAgent(target)) {
        return { content: [{ type: "text" as const, text: `ERROR: Cannot delete ephemeral/runtime agent ${params.agent_id}` }], details: {} };
      }

      const settings = await options?.settingsProvider?.();
      const fallbackSettings = !options?.settingsProvider && !options?.approvalRequestStore
        ? { agentProvisioning: { approvalMode: "never" as const } }
        : settings;
      const policy = resolveAgentProvisioningPolicy({
        tool: "fn_agent_delete",
        caller: caller ? { id: caller.id, role: caller.role, isPrivileged: privileged } : undefined,
        settings: fallbackSettings,
      });
      await options?.runAuditor?.database({ type: "agent:delete:requested", target: target.id, metadata: { policy } });

      if (policy.decision === "require-approval") {
        if (!options?.approvalRequestStore) {
          await options?.runAuditor?.database({ type: "agent:delete:denied", target: target.id, metadata: { policy, reason: "approval-store-missing" } });
          return {
            content: [{ type: "text" as const, text: `DENIED: agent delete requires approval but approval storage is unavailable (${policy.matchedRule})` }],
            details: { outcome: "denied", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId: target.id },
          };
        }

        const approvalDedupeKey = computeApprovalDedupeKey({
          agentId: callingAgentId,
          toolName: "fn_agent_delete",
          category: "agent_provisioning",
          resourceType: "agent",
          resourceId: target.id,
          operation: `delete:${target.id}:${params.force === true ? "force" : "normal"}:${params.reassign_to ?? ""}`,
        });

        const request = await options.approvalRequestStore.create({
          requester: { actorId: callingAgentId, actorType: "agent", actorName: caller?.name ?? callingAgentId },
          targetAction: {
            category: "agent_provisioning",
            action: "delete",
            summary: `Delete agent ${target.name} (${target.id})`,
            resourceType: "agent",
            resourceId: target.id,
            context: { tool: "fn_agent_delete", params, approvalDedupeKey },
          },
        });

        return {
          content: [{ type: "text" as const, text: `Approval required to delete agent ${target.name}. Request ${request.id} created.` }],
          details: { outcome: "pending_approval", approvalRequestId: request.id, matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId: target.id },
        };
      }

      if (policy.decision === "deny") {
        await options?.runAuditor?.database({ type: "agent:delete:denied", target: target.id, metadata: { policy } });
        return {
          content: [{ type: "text" as const, text: `DENIED: agent delete blocked by policy (${policy.matchedRule})` }],
          details: { outcome: "denied", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId: target.id },
        };
      }

      try {
        await agentStore.deleteAgent(params.agent_id, { force: params.force === true, reassignTo: params.reassign_to });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `ERROR: ${message}` }], details: {} };
      }

      await options?.runAuditor?.database({ type: "agent:delete:approved", target: target.id, metadata: { policy, autoApproved: true } });
      return {
        content: [{ type: "text" as const, text: `Deleted agent ${target.name} (${target.id})` }],
        details: { outcome: "deleted", matchedRule: policy.matchedRule, effectiveMode: policy.effectiveMode, agentId: target.id },
      };
    },
  };
}

export async function executeApprovedAgentProvisioning(
  approvalRequest: { id: string; status: string; targetAction: { resourceId: string } } & Parameters<typeof extractAgentProvisioningRequest>[0],
  deps: { agentStore: AgentStore },
): Promise<{ deletedId: string } | Awaited<ReturnType<AgentStore["createAgent"]>>> {
  if (approvalRequest.status !== "approved") {
    throw new Error(`Approval request ${approvalRequest.id} must be approved before provisioning execution`);
  }

  const { tool, params } = extractAgentProvisioningRequest(approvalRequest);
  if (tool === "fn_agent_create") {
    const runtimeConfig: Record<string, unknown> = {
      ...(typeof params.heartbeat_interval_ms === "number" ? { heartbeatIntervalMs: params.heartbeat_interval_ms } : {}),
      ...(typeof params.heartbeat_timeout_ms === "number" ? { heartbeatTimeoutMs: params.heartbeat_timeout_ms } : {}),
      ...(typeof params.max_concurrent_runs === "number" ? { maxConcurrentRuns: params.max_concurrent_runs } : {}),
      ...(typeof params.message_response_mode === "string" ? { messageResponseMode: params.message_response_mode } : {}),
    };

    return deps.agentStore.createAgent({
      name: String(params.name),
      role: String(params.role) as never,
      ...(typeof params.soul === "string" ? { soul: params.soul } : {}),
      ...(typeof params.instructions_text === "string" ? { instructionsText: params.instructions_text } : {}),
      ...(typeof params.instructions_path === "string" ? { instructionsPath: params.instructions_path } : {}),
      reportsTo: typeof params.reportsTo === "string" ? params.reportsTo : undefined,
      ...(Object.keys(runtimeConfig).length > 0 ? { runtimeConfig } : {}),
    });
  }

  await deps.agentStore.deleteAgent(approvalRequest.targetAction.resourceId, {
    force: params.force === true,
    reassignTo: typeof params.reassign_to === "string" ? params.reassign_to : undefined,
  });
  return { deletedId: approvalRequest.targetAction.resourceId };
}

export function createDelegateTaskTool(
  agentStore: AgentStore,
  taskStore: TaskStore,
  options?: AgentTaskCreationOptions,
): ToolDefinition {
  return {
    name: "fn_delegate_task",
    label: "Delegate Task",
    description:
      "Create a new task and assign it to a specific agent for execution. The task goes to " +
      "'todo' and will be picked up by the target agent on their next heartbeat cycle. " +
      "Use fn_list_agents first to find available agents and their capabilities. " +
      "Optionally pass workflow_id to select a workflow at creation time; use " +
      "fn_workflow_list to discover valid IDs.",
    parameters: delegateTaskParams,
    execute: async (_id: string, params: Static<typeof delegateTaskParams>) => {
      // Validate target agent exists
      const agent = await agentStore.getAgent(params.agent_id);
      if (!agent) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Agent ${params.agent_id} not found` }],
          details: {},
        };
      }

      // Validate target agent is not ephemeral
      if (isEphemeralAgent(agent)) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Cannot delegate to ephemeral/runtime agent ${params.agent_id}` }],
          details: {},
        };
      }

      /*
      FNXC:AgentRouting 2026-07-12-12:20:
      Issue #2015: delegation must honor per-agent assignmentPolicy. override=true still bypasses the ROLE
      check, but an agent with assignmentPolicy "none" (liaison guarantee) can never be delegated an
      implementation task — no override exists for that.
      */
      const override = params.override === true;
      const newTaskRef = { id: "<new>", column: "todo" } as const;
      const bindVerdict = evaluateImplementationTaskBind(agent, newTaskRef, {
        explicitRouting: true,
        executorRoleOverride: override,
      });
      if (!bindVerdict.allowed) {
        return {
          content: [{ type: "text" as const, text: `ERROR: ${bindVerdict.reason}` }],
          details: {},
        };
      }

      try {
        const workflowId = params.workflow_id?.trim() || undefined;
        // Create task assigned to the target agent
        const { task, wasDuplicate } = await createAgentTask(taskStore, {
          description: params.description,
          dependencies: params.dependencies,
          column: "todo",
          assignedAgentId: params.agent_id,
          ...(workflowId ? { workflowId } : {}),
          source: {
            sourceType: "api",
            ...(override ? { sourceMetadata: { executorRoleOverride: true } } : {}),
          },
        }, options);

        const deps = task.dependencies.length ? ` (depends on: ${task.dependencies.join(", ")})` : "";
        const workflow = workflowId ? ` (workflow: ${workflowId})` : "";
        /*
        FNXC:AgentRouting 2026-07-29-00:00:
        FN-8207 requires delegation confirmation to reflect the canonical task's actual owner. Never promise a heartbeat pickup by the requested agent when a duplicate canonical task remains owned by someone else.
        */
        const assignedToRequestedAgent = !wasDuplicate || task.assignedAgentId === agent.id;
        const actualOwner = task.assignedAgentId ? `agent ${task.assignedAgentId}` : "no agent";
        const action = wasDuplicate
          ? assignedToRequestedAgent
            ? `Linked existing ${task.id} and assigned it to ${agent.name}`
            : `Linked existing ${task.id}; it remains assigned to ${actualOwner}`
          : `Created ${task.id}`;
        const pickup = assignedToRequestedAgent
          ? ` The task will be picked up by ${agent.name} on their next heartbeat cycle.`
          : "";
        return {
          content: [{
            type: "text" as const,
            text: `${assignedToRequestedAgent ? `Delegated to ${agent.name} (${agent.id})` : "Delegation linked"}: ${action}${deps}${workflow}.${pickup}`,
          }],
          details: { taskId: task.id, agentId: agent.id, agentName: agent.name },
        };
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Task ID already exists:")) {
          return {
            content: [{ type: "text" as const, text: `ERROR: ${err.message}` }],
            details: {},
            isError: true,
          };
        }
        throw err;
      }
    },
  };
}

/*
FNXC:AgentRouting 2026-07-29-00:00:
FN-8207 adds an engine-session reassignment tool because executor fn_task_update is lifecycle-only. Bind checks match delegation: ephemeral agents and assignmentPolicy "none" are never assignable, while override bypasses only role eligibility.
*/
export function createTaskAssignTool(
  agentStore: AgentStore,
  taskStore: TaskStore,
): ToolDefinition {
  return {
    name: "fn_task_assign",
    label: "Assign Task",
    description: "Assign an existing task to a durable agent by task ID. Use this to correct or change task ownership.",
    parameters: taskAssignParams,
    execute: async (_id: string, params: Static<typeof taskAssignParams>) => {
      const agent = await agentStore.getAgent(params.agent_id);
      if (!agent) {
        return { content: [{ type: "text" as const, text: `ERROR: Agent ${params.agent_id} not found` }], details: {} };
      }
      if (isEphemeralAgent(agent)) {
        return { content: [{ type: "text" as const, text: `ERROR: Cannot assign to ephemeral/runtime agent ${params.agent_id}` }], details: {} };
      }

      let task: Task;
      try {
        task = await taskStore.getTask(params.task_id);
      } catch {
        return { content: [{ type: "text" as const, text: `ERROR: Task ${params.task_id} not found` }], details: {} };
      }

      const verdict = evaluateImplementationTaskBind(agent, task, {
        explicitRouting: true,
        executorRoleOverride: params.override === true,
      });
      if (!verdict.allowed) {
        return { content: [{ type: "text" as const, text: `ERROR: ${verdict.reason}` }], details: {} };
      }

      const assigned = await taskStore.updateTask(task.id, { assignedAgentId: agent.id });
      return {
        content: [{ type: "text" as const, text: `Assigned ${assigned.id} to ${agent.name} (${agent.id}).` }],
        details: { taskId: assigned.id, agentId: agent.id, agentName: agent.name },
      };
    },
  };
}

type AskQuestionInput = Static<typeof askQuestionParams>;

function askQuestionError(message: string) {
  return {
    content: [{ type: "text" as const, text: `ERROR: ${message}` }],
    details: {},
    isError: true,
  };
}

/**
 * FNXC:ChatAskQuestion 2026-06-17-13:08:
 * Dashboard chat agents need a provider-agnostic `fn_ask_question` tool that emits the FN-6501 structured question payload, renders through the existing chat question UI, and receives the answer through the normal next user message instead of a blocking tool response.
 *
 * Create a `fn_ask_question` tool that asks the dashboard user structured questions.
 *
 * @returns ToolDefinition for the `fn_ask_question` tool
 */
export function createAskQuestionTool(): ToolDefinition {
  return {
    name: "fn_ask_question",
    label: "Ask User Question",
    description:
      "Ask the user a structured question (single-select, multi-select, free-text, or yes/no confirm). " +
      "The question renders as an interactive card in chat. After calling this tool, end the turn and wait; " +
      "the user's answer arrives as the next message.",
    parameters: askQuestionParams,
    execute: async (_id: string, params: AskQuestionInput) => {
      if (!Array.isArray(params.questions) || params.questions.length === 0) {
        return askQuestionError("questions must contain at least one question");
      }

      for (const [index, question] of params.questions.entries()) {
        const questionText = typeof question.question === "string" ? question.question.trim() : "";
        if (!questionText) {
          return askQuestionError(`questions[${index}].question must be a non-empty string`);
        }

        const optionCount = Array.isArray(question.options)
          ? question.options.filter((option) => typeof option.label === "string" && option.label.trim().length > 0).length
          : 0;
        const requiresOptions = question.type === "single_select"
          || question.type === "multi_select"
          || question.multiSelect === true;
        if (requiresOptions && optionCount === 0) {
          return askQuestionError(`questions[${index}] select questions must include at least one option`);
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: "Question presented to the user. Stop and wait for their reply on the next turn.",
        }],
        details: { questionCount: params.questions.length },
      };
    },
  };
}

/**
 * Create a `fn_send_message` tool that sends a message to another agent or user.
 *
 * @param messageStore - MessageStore for message persistence
 * @param fromAgentId - The agent ID sending the message
 * @returns ToolDefinition for the `fn_send_message` tool
 */
export function createSendMessageTool(
  messageStore: MessageStore,
  fromAgentId: string,
  options?: { autoRecovery?: ProjectSettings["autoRecovery"]; runAudit?: RunAuditor; taskStore?: TaskStore; settings?: Settings; agentStore?: AgentStore },
): ToolDefinition {
  const deliveryHandler = new MessageDeliveryAutoRecoveryHandler({
    runAudit: options?.runAudit ?? { database: async () => {}, git: async () => {}, filesystem: async () => {}, sandbox: async () => {} },
  });

  return {
    name: "fn_send_message",
    label: "Send Message",
    description:
      "Send a message to another agent or user. The recipient will be woken if they have " +
      "`messageResponseMode: 'immediate'` configured. When replying to an existing message, " +
      "include `reply_to_message_id` to preserve threading.",
    parameters: sendMessageParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_id: string, params: Static<typeof sendMessageParams>, _signal?: any, _onUpdate?: any, _ctx?: any) => {
      const content = params.content.trim();
      if (content.length === 0) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Message content cannot be empty" }],
          details: {},
        };
      }
      if (content.length > 2000) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Message content exceeds 2000 character limit" }],
          details: {},
        };
      }

      try {
        const inferredDashboardRecipient = normalizeMessageParticipant(params.to_id, "user");
        const messageType = params.type
          ?? (inferredDashboardRecipient.id === DASHBOARD_USER_ID ? "agent-to-user" : "agent-to-agent");
        const recipientType: "user" | "agent" = messageType === "agent-to-user" ? "user" : "agent";
        const recipient = recipientType === "user"
          ? normalizeMessageParticipant(params.to_id, recipientType)
          : { id: params.to_id, type: recipientType };
        const replyToMessageId = params.reply_to_message_id?.trim();

        if (params.reply_to_message_id !== undefined && !replyToMessageId) {
          return {
            content: [{ type: "text" as const, text: "ERROR: reply_to_message_id must be a non-empty string" }],
            details: {},
          };
        }

        /*
        FNXC:AgentMessaging 2026-07-28-12:10:
        Agent-to-agent sends must reject missing recipients rather than store an unread, undeliverable message and report false delivery success. Use async getAgent instead of getCachedAgent because the synchronous cache always returns null in PostgreSQL mode. A lookup failure is validation-unavailable and must block the send; only a successful lookup may establish delivery confidence.
        */
        if (recipient.type === "agent" && options?.agentStore) {
          let resolvedRecipient: Awaited<ReturnType<AgentStore["getAgent"]>> | undefined;
          try {
            resolvedRecipient = await options.agentStore.getAgent(recipient.id);
          } catch {
            return {
              content: [{ type: "text" as const, text: `ERROR: Recipient agent '${params.to_id}' could not be validated — message not sent` }],
              details: {},
            };
          }
          if (resolvedRecipient == null) {
            return {
              content: [{ type: "text" as const, text: `ERROR: Recipient agent '${params.to_id}' does not exist — message not sent` }],
              details: {},
            };
          }
        }

        const result = await deliveryHandler.runWithBoundedRetry({
          run: async () => messageStore.sendMessage({
            fromId: fromAgentId,
            fromType: "agent",
            toId: recipient.id,
            toType: recipient.type,
            content,
            type: messageType,
            ...(replyToMessageId ? { metadata: { replyTo: { messageId: replyToMessageId } } } : {}),
          }),
          correlation: { kind: "direct", fromAgentId, toId: recipient.id },
        }, options?.autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 }, async () => {
          const taskId = _ctx?.taskId as string | undefined;
          if (!taskId || !options?.taskStore || !options.settings) {
            return;
          }
          const task = await options.taskStore.getTask(taskId);
          if (!task) {
            return;
          }
          await recordRetry({ store: options.taskStore, settings: options.settings, task, category: "messageDelivery", role: "executor", agentId: fromAgentId });
        });

        if (result.outcome === "parked") {
          return {
            content: [{ type: "text" as const, text: `ERROR: Failed to send message: ${result.error.message}` }],
            details: {},
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `Message sent to ${recipient.id === DASHBOARD_USER_ID ? DASHBOARD_USER_ID : params.to_id} (ID: ${result.value.id})`,
          }],
          details: { messageId: result.value.id },
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to send message: ${errorMessage}` }],
          details: {},
        };
      }
    },
  };
}

/**
 * Create a `fn_read_messages` tool that reads inbox messages for an agent.
 *
 * @param messageStore - MessageStore for message retrieval
 * @param agentId - The agent ID whose inbox to read
 * @returns ToolDefinition for the `fn_read_messages` tool
 */
type ResearchToolsOptions = {
  store: TaskStore;
  rootDir: string;
  getSettings: () => Promise<Settings>;
};

function formatResearchRunDetails(run: ResearchRun) {
  const findings = run.results?.findings ?? [];
  const citations = run.results?.citations ?? [];
  return {
    runId: run.id,
    status: run.status,
    query: run.query,
    summary: run.results?.summary ?? null,
    findings,
    citations,
    sourceCount: run.sources.length,
    error: run.error ?? null,
    setup: null as null | { code: string; message: string },
  };
}

function researchUnavailable(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      runId: null,
      status: "unavailable",
      summary: null,
      findings: [],
      citations: [],
      error: message,
      setup: { code, message },
    },
  };
}

export function createResearchTools(options: ResearchToolsOptions): ToolDefinition[] {
  const orchestratorState: {
    orchestrator: ResearchOrchestrator | null;
    providerRegistry: ResearchProviderRegistry | null;
    inFlight: Map<string, Promise<void>>;
  } = {
    orchestrator: null,
    providerRegistry: null,
    inFlight: new Map(),
  };

  /*
  FNXC:ResearchAgentTools 2026-07-13-23:45:
  Agent research tools must use the TaskStore-selected research backend. Await the shared sync/async API so PostgreSQL supports execution, reads, cancellation, and retry instead of silently degrading to an unavailable tool surface.
  */
  const resolveResearchStore = () => options.store.getResearchStore();

  const ensureOrchestrator = async (): Promise<ResearchOrchestrator | null> => {
    const settings = await options.getSettings();
    const resolved = resolveResearchSettings(settings);
    if (!resolved.enabled) {
      return null;
    }

    if (!orchestratorState.providerRegistry) {
      orchestratorState.providerRegistry = new ResearchProviderRegistry(settings, options.rootDir);
    } else {
      orchestratorState.providerRegistry.refreshSettings(settings);
    }

    const registry = orchestratorState.providerRegistry;
    const availableProviders = registry.getAvailableProviders();
    if (availableProviders.length === 0) {
      return null;
    }

    if (!orchestratorState.orchestrator) {
      const stepRunner = new ResearchStepRunner({
        providers: availableProviders
          .map((type) => registry.getProvider(type))
          .filter((provider): provider is NonNullable<typeof provider> => Boolean(provider)),
      });
      orchestratorState.orchestrator = new ResearchOrchestrator({
        store: resolveResearchStore(),
        stepRunner,
        maxConcurrentRuns: resolved.limits.maxConcurrentRuns,
      });
    }

    return orchestratorState.orchestrator;
  };

  const runTool: ToolDefinition = {
    name: "fn_research_run",
    label: "Run Research",
    description: "Start a bounded research run and optionally wait for completion to get findings.",
    parameters: researchRunParams,
    execute: async (_id: string, params: Static<typeof researchRunParams>) => {
      const settings = await options.getSettings();
      const resolved = resolveResearchSettings(settings);
      if (!resolved.enabled) {
        return researchUnavailable("feature-disabled", "Research is disabled in settings. Enable researchSettings.enabled or global research defaults first.");
      }
      const orchestrator = await ensureOrchestrator();
      if (!orchestrator) {
        return researchUnavailable("provider-unavailable", "Research providers are not configured. Add provider credentials in Settings → Authentication and select a research provider.");
      }

      const registry = orchestratorState.providerRegistry;
      const availableProviderTypes = registry?.getAvailableProviders() ?? [];
      const runId = await orchestrator.createRun({
        providers: availableProviderTypes
          .filter((type) => type !== "llm-synthesis")
          .map((type) => ({ type, config: { maxResults: resolved.limits.maxSourcesPerRun, timeoutMs: resolved.limits.requestTimeoutMs } })),
        maxSources: resolved.limits.maxSourcesPerRun,
        maxSynthesisRounds: Math.max(1, settings.researchMaxSynthesisRounds ?? settings.researchGlobalMaxSynthesisRounds ?? 2),
        phaseTimeoutMs: resolved.limits.maxDurationMs,
        stepTimeoutMs: resolved.limits.requestTimeoutMs,
      });

      const runPromise = orchestrator.startRun(runId, params.query);
      const trackedRun = runPromise
        .then(() => undefined, () => undefined)
        .finally(() => orchestratorState.inFlight.delete(runId));
      orchestratorState.inFlight.set(runId, trackedRun);

      if (!params.wait_for_completion) {
        const started = await resolveResearchStore().getRun(runId);
        if (!started) {
          return {
            content: [{ type: "text" as const, text: `Started research run ${runId} for: ${params.query}` }],
            details: { runId, status: "pending", summary: null, findings: [], citations: [], sourceCount: 0, error: null, setup: null },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Started research run ${runId} for: ${params.query}` }],
          details: formatResearchRunDetails(started),
        };
      }

      const maxWaitMs = Math.max(1_000, Math.min(params.max_wait_ms ?? 90_000, resolved.limits.maxDurationMs));
      const completed = await Promise.race([
        runPromise,
        new Promise<ResearchRun>((resolve) => setTimeout(() => {
          void Promise.resolve(resolveResearchStore().getRun(runId)).then((latest) => resolve(latest ?? ({
            id: runId,
            query: params.query,
            status: "running",
            sources: [],
            events: [],
            tags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as ResearchRun))).catch(() => resolve({
            id: runId,
            query: params.query,
            status: "running",
            sources: [],
            events: [],
            tags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as ResearchRun));
        }, maxWaitMs)),
      ]);
      const details = formatResearchRunDetails(completed);
      const text = details.status === "completed"
        ? `Research run ${runId} completed. ${details.summary ?? "No summary generated."}`
        : `Research run ${runId} is ${details.status}. Use fn_research_get for updates.`;
      return { content: [{ type: "text" as const, text }], details };
    },
  };

  const listTool: ToolDefinition = {
    name: "fn_research_list",
    label: "List Research Runs",
    description: "List recent research runs with status and summary snippets.",
    parameters: researchListParams,
    execute: async (_id: string, params: Static<typeof researchListParams>) => {
      const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
      const runs = await resolveResearchStore().listRuns({
        status: params.status as ResearchRunStatus | undefined,
        limit,
      });
      const text = runs.length
        ? runs.map((run) => `- ${run.id} [${run.status}] ${run.query}`).join("\n")
        : "No research runs found.";
      return {
        content: [{ type: "text" as const, text }],
        details: { runs: runs.map((run) => formatResearchRunDetails(run)) },
      };
    },
  };

  const getTool: ToolDefinition = {
    name: "fn_research_get",
    label: "Get Research Run",
    description: "Get one research run with structured findings and citations.",
    parameters: researchGetParams,
    execute: async (_id: string, params: Static<typeof researchGetParams>) => {
      const run = await resolveResearchStore().getRun(params.id);
      if (!run) {
        return {
          content: [{ type: "text" as const, text: `Research run ${params.id} not found.` }],
          details: { runId: params.id, status: "missing", summary: null, findings: [], citations: [], error: "not found", setup: null },
        };
      }
      const details = formatResearchRunDetails(run);
      return {
        content: [{ type: "text" as const, text: `Research run ${run.id} is ${run.status}.` }],
        details,
      };
    },
  };

  const cancelTool: ToolDefinition = {
    name: "fn_research_cancel",
    label: "Cancel Research Run",
    description: "Cancel an active research run.",
    parameters: researchCancelParams,
    execute: async (_id: string, params: Static<typeof researchCancelParams>) => {
      const orchestrator = await ensureOrchestrator();
      if (!orchestrator) {
        return researchUnavailable("provider-unavailable", "Research orchestrator is unavailable because research providers are not configured.");
      }
      const cancelled = await orchestrator.cancelRun(params.id);
      const run = await resolveResearchStore().getRun(params.id);
      if (!run) {
        return {
          content: [{ type: "text" as const, text: `Research run ${params.id} not found.` }],
          details: { runId: params.id, status: "missing", summary: null, findings: [], citations: [], error: "not found", setup: null },
        };
      }
      return {
        content: [{ type: "text" as const, text: cancelled ? `Cancellation requested for ${params.id}.` : `Run ${params.id} is not active.` }],
        details: formatResearchRunDetails(run),
      };
    },
  };

  const retryTool: ToolDefinition = {
    name: "fn_research_retry",
    label: "Retry Research Run",
    description: "Create a retry from a failed or cancelled research run.",
    parameters: researchRetryParams,
    execute: async (_id: string, params: Static<typeof researchRetryParams>) => {
      const orchestrator = await ensureOrchestrator();
      if (!orchestrator) {
        return researchUnavailable("provider-unavailable", "Research orchestrator is unavailable because research providers are not configured.");
      }
      const newRunId = await orchestrator.retryRun(params.id);
      const run = await resolveResearchStore().getRun(newRunId);
      return {
        content: [{ type: "text" as const, text: `Created retry run ${newRunId} from ${params.id}.` }],
        details: run ? formatResearchRunDetails(run) : { runId: newRunId, status: "retry_waiting", summary: null, findings: [], citations: [], error: null, setup: null },
      };
    },
  };

  return [runTool, listTool, getTool, cancelTool, retryTool];
}

export function createPostRoomMessageTool(
  chatStore: ChatStore,
  fromAgentId: string,
  options?: { autoRecovery?: ProjectSettings["autoRecovery"]; runAudit?: RunAuditor; taskStore?: TaskStore; settings?: Settings },
): ToolDefinition {
  const deliveryHandler = new MessageDeliveryAutoRecoveryHandler({
    runAudit: options?.runAudit ?? { database: async () => {}, git: async () => {}, filesystem: async () => {}, sandbox: async () => {} },
  });

  return {
    name: "fn_post_room_message",
    label: "Post Room Message",
    description:
      "Post a message to a room you are a member of. Room membership is enforced before posting, " +
      "so only reply when the room content is relevant to your role or identity.",
    parameters: postRoomMessageParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_id: string, params: Static<typeof postRoomMessageParams>, _signal?: any, _onUpdate?: any, _ctx?: any) => {
      const content = params.content.trim();
      if (content.length === 0) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Message content cannot be empty" }],
          details: {},
        };
      }
      if (content.length > 2000) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Message content exceeds 2000 character limit" }],
          details: {},
        };
      }

      const replyToMessageId = params.replyToMessageId?.trim();
      if (params.replyToMessageId !== undefined && !replyToMessageId) {
        return {
          content: [{ type: "text" as const, text: "ERROR: replyToMessageId must be a non-empty string" }],
          details: {},
        };
      }

      try {
        const isMember = (await chatStore.listRoomMembers(params.roomId)).some((member) => member.agentId === fromAgentId);
        if (!isMember) {
          return {
            content: [{ type: "text" as const, text: `ERROR: Agent ${fromAgentId} is not a member of room ${params.roomId}` }],
            details: {},
            isError: true,
          };
        }

        const result = await deliveryHandler.runWithBoundedRetry({
          run: async () => Promise.resolve(chatStore.addRoomMessage(params.roomId, {
            role: "assistant",
            senderAgentId: fromAgentId,
            content,
            mentions: params.mentions ?? [],
            ...(replyToMessageId ? { metadata: { replyToMessageId } } : {}),
          })),
          correlation: { kind: "room", fromAgentId, roomId: params.roomId },
        }, options?.autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 }, async () => {
          const taskId = _ctx?.taskId as string | undefined;
          if (!taskId || !options?.taskStore || !options.settings) {
            return;
          }
          const task = await options.taskStore.getTask(taskId);
          if (!task) {
            return;
          }
          await recordRetry({ store: options.taskStore, settings: options.settings, task, category: "messageDelivery", role: "executor", agentId: fromAgentId });
        });

        if (result.outcome === "parked") {
          return {
            content: [{ type: "text" as const, text: `ERROR: Failed to post room message: ${result.error.message}` }],
            details: {},
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Room message posted to ${params.roomId} (ID: ${result.value.id})` }],
          details: { messageId: result.value.id },
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to post room message: ${errorMessage}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

export function createReadMessagesTool(messageStore: MessageStore, agentId: string): ToolDefinition {
  const REPLY_CONTEXT_CONTENT_MAX_CHARS = 400;

  const trimReplyContent = (value: string): string => {
    if (value.length <= REPLY_CONTEXT_CONTENT_MAX_CHARS) {
      return value;
    }
    return `${value.slice(0, REPLY_CONTEXT_CONTENT_MAX_CHARS - 1)}…`;
  };

  const resolveReplyContext = async (msg: Message): Promise<{
    parentMessageId: string;
    parentMessage: Message | null;
    missingParent: boolean;
  } | null> => {
    const metadata = msg.metadata;
    const parentMessageId = typeof metadata === "object"
      && metadata !== null
      && "replyTo" in metadata
      && typeof metadata.replyTo === "object"
      && metadata.replyTo !== null
      && "messageId" in metadata.replyTo
      && typeof metadata.replyTo.messageId === "string"
      ? metadata.replyTo.messageId
      : null;

    if (!parentMessageId) {
      return null;
    }

    const parentMessage = await messageStore.getMessage(parentMessageId);
    return {
      parentMessageId,
      parentMessage,
      missingParent: !parentMessage,
    };
  };

  return {
    name: "fn_read_messages",
    label: "Read Messages",
    description: "Read your inbox messages. Returns unread messages by default.",
    parameters: readMessagesParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_id: string, params: Static<typeof readMessagesParams>, _signal?: any, _onUpdate?: any, _ctx?: any) => {
      const unreadOnly = params.unread_only ?? true;
      const limit = params.limit ?? 20;

      try {
        const filter = {
          ...(unreadOnly ? { read: false as const } : {}),
          limit,
        };

        const messages = await messageStore.getInbox(agentId, "agent", filter);

        if (messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No messages" }],
            details: {},
          };
        }

        const messageEntries = await Promise.all(messages.map(async (msg: Message) => {
          const replyContext = await resolveReplyContext(msg);
          return {
            message: msg,
            replyContext,
          };
        }));

        const lines = messageEntries.map(({ message, replyContext }) => {
          const timestamp = new Date(message.createdAt).toLocaleString();
          const readStatus = message.read ? "[read] " : "[unread] ";
          const baseLine = `${readStatus}[id: ${message.id}] [from: ${message.fromType}:${message.fromId}] ${message.content} (${timestamp})`;
          if (!replyContext) {
            return baseLine;
          }

          if (replyContext.parentMessage) {
            const parent = replyContext.parentMessage;
            return `${baseLine}\n  ↳ reply-to [id: ${parent.id}] [from: ${parent.fromType}:${parent.fromId}] ${trimReplyContent(parent.content)}`;
          }

          return `${baseLine}\n  ↳ reply-to [id: ${replyContext.parentMessageId}] (missing parent message)`;
        });

        return {
          content: [{
            type: "text" as const,
            text: `Messages (${messages.length}):\n${lines.join("\n")}`,
          }],
          details: {
            messages,
            threadContext: messageEntries
              .filter((entry) => entry.replyContext)
              .map((entry) => ({
                messageId: entry.message.id,
                replyTo: entry.replyContext,
              })),
          },
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to read messages: ${errorMessage}` }],
          details: {},
        };
      }
    },
  };
}

export function createAcquireRepoWorktreeTool(opts: {
  workspaceRootDir: string;
  workspaceRepos: string[];
  task: import("@fusion/core").Task;
  store: TaskStore;
  settings: Partial<Settings>;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  secretsStore?: Pick<import("@fusion/core").SecretsStore, "listEnvExportable">;
  runContext?: RunMutationContext;
  audit?: Pick<RunAuditor, "git" | "filesystem">;
  /*
  FNXC:Workspace 2026-06-21-22:30:
  F2 — executor-supplied callback invoked after a SUCCESSFUL fresh acquire so the
  acquired sub-repo worktree path is registered in the executor's per-task
  activeWorktrees Set (KTD2). Without this the Set only ever held the browse-only
  root and the "task holds N sub-repo paths" invariant was hollow — owner/liveness
  checks never saw live sub-repo worktrees. Not called on the already-acquired
  short-circuit (the path was registered on the original fresh acquire).
  */
  onAcquired?: (worktreePath: string) => void;
  // FNXC:Workspace 2026-06-22 — thread the configured worktree-init runner so sub-repo worktrees run configured setup.
  runConfiguredCommand?: import("./worktree-acquisition.js").AcquireWorkspaceRepoWorktreeOptions["runConfiguredCommand"];
  taskEnv?: NodeJS.ProcessEnv;
}): ToolDefinition {
  const { workspaceRootDir, workspaceRepos, task, store, settings, logger, secretsStore, runContext, audit, onAcquired, runConfiguredCommand, taskEnv } = opts;
  return {
    name: "fn_acquire_repo_worktree",
    label: "Acquire Repo Worktree",
    description:
      "Acquire an isolated git worktree for a sub-repo in this workspace. " +
      "Call this before editing files in a sub-repo; work in the returned path. " +
      `Available repos: ${workspaceRepos.join(", ")}.`,
    parameters: acquireRepoWorktreeParams,
    execute: async (_id: string, params: Static<typeof acquireRepoWorktreeParams>) => {
      const { repo } = params;
      if (!workspaceRepos.includes(repo)) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Unknown repo: "${repo}". Available: ${workspaceRepos.join(", ")}` }],
          details: {},
          isError: true,
        };
      }
      const freshTask = await store.getTask(task.id);
      /*
      FNXC:Workspace 2026-06-21-22:30:
      F1 — acquireWorkspaceRepoWorktree can throw WorkspaceRepoAcquireBusyError on
      same-sub-repo contention (KTD4) or a generic failure. Both must surface as a
      structured isError tool result, never an uncaught throw that crashes the agent
      loop. The busy message is sanitized — it does NOT leak the holder task id into
      agent-facing text (only into details). runContext is forwarded so the helper's
      audit/log entries keep run attribution.
      */
      let result: Awaited<ReturnType<typeof acquireWorkspaceRepoWorktree>>;
      try {
        result = await acquireWorkspaceRepoWorktree({
          repoRelPath: repo,
          workspaceRootDir,
          task: freshTask,
          store,
          settings,
          logger,
          secretsStore,
          audit,
          runContext,
          runConfiguredCommand,
          taskEnv,
        });
      } catch (err) {
        if (err instanceof WorkspaceRepoAcquireBusyError) {
          return {
            content: [{ type: "text" as const, text: `Sub-repo ${repo} is temporarily locked by another task's acquisition; retry fn_acquire_repo_worktree shortly.` }],
            details: { holderTaskId: err.holderTaskId },
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to acquire worktree for ${repo}: ${message}` }],
          details: {},
          isError: true,
        };
      }
      // FNXC:Workspace 2026-06-21-22:30: F2 — register a freshly-acquired sub-repo worktree in the executor's activeWorktrees Set (KTD2) so owner/liveness checks see live per-repo worktrees, not just the browse-only root.
      // FNXC:Workspace 2026-06-22-09:00: register UNCONDITIONALLY, including the
      // already-acquired short-circuit. After an executor restart activeWorktrees is an
      // empty Map; a resumed workspace task with pre-existing task.workspaceWorktrees hits
      // the alreadyAcquired path, so skipping onAcquired left the sub-repo path unregistered
      // in-memory and conflict/liveness checks missed it. Set.add is idempotent, so re-firing
      // on a fresh acquire is a harmless no-op.
      onAcquired?.(result.worktreePath);
      await store.logEntry(
        task.id,
        result.alreadyAcquired
          ? `fn_acquire_repo_worktree: reusing existing worktree for ${repo} at ${result.worktreePath}`
          : `fn_acquire_repo_worktree: created worktree for ${repo} at ${result.worktreePath} (branch: ${result.branch})`,
        undefined,
        runContext,
      );
      return {
        content: [{ type: "text" as const, text: `Worktree ready at: ${result.worktreePath} (branch: ${result.branch}, alreadyAcquired: ${result.alreadyAcquired})` }],
        details: result,
      };
    },
  };
}
