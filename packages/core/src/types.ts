/** Valid thinking effort levels for AI agent sessions, controlling the cost/quality tradeoff of reasoning. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const COLUMNS = ["triage", "todo", "in-progress", "in-review", "done", "archived"] as const;
export type Column = (typeof COLUMNS)[number];

/** Theme mode for light/dark/system preference */
export const THEME_MODES = ["dark", "light", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Color theme options for the dashboard */
export const COLOR_THEMES = [
  "default",
  "ocean",
  "forest",
  "sunset",
  "zen",
  "berry",
  "high-contrast",
  "industrial",
  "monochrome",
  "slate",
  "ash",
  "graphite",
  "silver",
  "solarized",
  "factory",
  "ayu",
  "one-dark",
  "nord",
  "dracula",
  "gruvbox",
  "tokyo-night",
  "catppuccin-mocha",
  "github-dark",
  "everforest",
  "rose-pine",
  "kanagawa",
  "night-owl",
  "palenight",
  "monokai-pro",
  "slime",
] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number];

export type PrStatus = "open" | "closed" | "merged";
export type MergeStrategy = "direct" | "pull-request";

export interface ModelPreset {
  id: string;
  name: string;
  executorProvider?: string;
  executorModelId?: string;
  validatorProvider?: string;
  validatorModelId?: string;
}

/** A reusable workflow step definition that can run after task implementation. */
/** Execution mode for a workflow step. */
export type WorkflowStepMode = "prompt" | "script";
export type WorkflowStepToolMode = "readonly" | "coding";

/** Lifecycle phase for workflow step execution. */
export type WorkflowStepPhase = "pre-merge" | "post-merge";

export interface WorkflowStep {
  /** Unique identifier (e.g., "WS-001") */
  id: string;
  /** Built-in template source ID when this step was materialized from a template. */
  templateId?: string;
  /** Display name (e.g., "Documentation Review") */
  name: string;
  /** Short description for UI display */
  description: string;
  /** Execution mode — "prompt" runs an AI agent, "script" runs a named project script */
  mode: WorkflowStepMode;
  /** Lifecycle phase — "pre-merge" runs before merge (default), "post-merge" runs after merge success */
  phase?: WorkflowStepPhase;
  /** Full agent prompt to execute when this step runs (used when mode is "prompt") */
  prompt: string;
  /** Tool set available to prompt-mode workflow agents. Defaults to readonly. */
  toolMode?: WorkflowStepToolMode;
  /** Name of a script from project settings `scripts` map to execute (required when mode is "script") */
  scriptName?: string;
  /** Whether this step is available for selection on new tasks */
  enabled: boolean;
  /** When true, this step is automatically pre-selected when creating new tasks.
   *  Users can still deselect it — this only controls the initial default state. */
  defaultOn?: boolean;
  /** AI model provider override for the workflow step agent (e.g., "anthropic").
   *  Must be set together with `modelId`. When both model fields are undefined,
   *  the executor uses global settings defaults. Only used when mode is "prompt". */
  modelProvider?: string;
  /** AI model ID override for the workflow step agent (e.g., "claude-sonnet-4-5").
   *  Must be set together with `modelProvider`. When both model fields are undefined,
   *  the executor uses global settings defaults. Only used when mode is "prompt". */
  modelId?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Input for creating a new workflow step. */
/** Event types that can trigger ntfy notifications */
export type NtfyNotificationEvent = "in-review" | "merged" | "failed";

export interface WorkflowStepInput {
  /** Built-in template source ID when creating a concrete step from a template. */
  templateId?: string;
  name: string;
  description: string;
  /** Execution mode — defaults to "prompt" if not specified */
  mode?: WorkflowStepMode;
  /** Lifecycle phase — defaults to "pre-merge" if not specified */
  phase?: WorkflowStepPhase;
  /** Agent prompt (used when mode is "prompt"). Optional — can be AI-generated later via refinement. */
  prompt?: string;
  /** Tool set available to prompt-mode workflow agents. Defaults to readonly. */
  toolMode?: WorkflowStepToolMode;
  /** Script name from project settings (required when mode is "script").
   *  Must reference a named script in `settings.scripts` — no raw commands. */
  scriptName?: string;
  /** Defaults to true if not specified */
  enabled?: boolean;
  /** When true, this step is automatically pre-selected when creating new tasks.
   *  Users can still deselect — this only controls the initial default state. */
  defaultOn?: boolean;
  /** AI model provider override. Must be set together with modelId. Only used when mode is "prompt". */
  modelProvider?: string;
  /** AI model ID override. Must be set together with modelProvider. Only used when mode is "prompt". */
  modelId?: string;
}

/** Result of a workflow step execution on a task. */
export interface WorkflowStepResult {
  /** ID of the workflow step that ran (e.g., "WS-001") */
  workflowStepId: string;
  /** Name of the workflow step at execution time */
  workflowStepName: string;
  /** Lifecycle phase at execution time */
  phase?: WorkflowStepPhase;
  /** Execution status */
  status: "passed" | "failed" | "skipped" | "pending";
  /** Output from the workflow step agent (findings, errors, etc.) */
  output?: string;
  /** ISO-8601 timestamp when the step started */
  startedAt?: string;
  /** ISO-8601 timestamp when the step completed */
  completedAt?: string;
}

/** A built-in workflow step template for one-click creation. */
export interface WorkflowStepTemplate {
  /** Unique template identifier (e.g., "documentation-review") */
  id: string;
  /** Display name (e.g., "Documentation Review") */
  name: string;
  /** Short description for UI */
  description: string;
  /** Full agent prompt template */
  prompt: string;
  /** Tool set available when the template runs as a prompt-mode step. */
  toolMode?: WorkflowStepToolMode;
  /** Grouping category (e.g., "Quality", "Security") */
  category: string;
  /** Optional icon identifier for UI (e.g., "file-text", "shield") */
  icon?: string;
}

/** Built-in workflow step templates available for one-click creation. */
export const WORKFLOW_STEP_TEMPLATES: WorkflowStepTemplate[] = [
  {
    id: "documentation-review",
    name: "Documentation Review",
    description: "Verify all public APIs, functions, and complex logic have appropriate documentation",
    category: "Quality",
    icon: "file-text",
    toolMode: "readonly",
    prompt: `You are a documentation reviewer. Review the completed task and verify documentation quality.

Review Criteria:
1. All new public functions, classes, and modules have JSDoc comments or equivalent documentation
2. Complex logic has inline comments explaining the "why" not just the "what"
3. README files are updated if the task changes user-facing behavior
4. CHANGELOG or release notes are considered for significant changes
5. Type definitions are documented for public APIs

Files to Review:
- Review all files modified in the task worktree
- Focus on public API surface area
- Check test files for test documentation

Output Requirements:
- If documentation is adequate: call task_done() with success status
- If documentation is missing: list specific files and functions that need documentation using task_log()
- Provide specific suggestions for what documentation should be added`,
  },
  {
    id: "qa-check",
    name: "QA Check",
    description: "Run tests and verify they pass, check for obvious bugs",
    category: "Quality",
    icon: "check-circle",
    toolMode: "coding",
    prompt: `You are a QA tester. Verify the task implementation by running tests and checking for bugs.

Test Execution:
1. Run the project's test suite (use pnpm test, npm test, or the configured test command)
2. Verify all tests pass
3. If tests fail, analyze whether failures are related to the task changes

Code Review:
1. Review the changes for obvious bugs or edge cases
2. Check error handling is appropriate
3. Verify input validation is present where needed
4. Look for common issues: null pointer risks, off-by-one errors, race conditions

Output Requirements:
- If all tests pass and no bugs found: call task_done() with success status
- If tests fail: provide detailed failure information via task_log()
- If bugs are found: describe the bug, affected files, and suggested fix via task_log()`,
  },
  {
    id: "security-audit",
    name: "Security Audit",
    description: "Check for common security vulnerabilities and anti-patterns",
    category: "Security",
    icon: "shield",
    toolMode: "readonly",
    prompt: `You are a security auditor. Review the task changes for common security vulnerabilities.

Security Checklist:
1. **Injection vulnerabilities** — Check for SQL injection, command injection, XSS via unsanitized user input
2. **Secrets and credentials** — Ensure no hardcoded passwords, API keys, tokens, or private keys
3. **Unsafe eval** — Check for eval(), new Function(), or similar dangerous patterns
4. **Path traversal** — Verify file path handling prevents directory traversal attacks
5. **Insecure deserialization** — Check for unsafe parsing of untrusted data
6. **Authentication/Authorization** — Verify access controls are properly implemented
7. **Dependency risks** — Note any new dependencies that might have known vulnerabilities

Files to Review:
- All modified files in the task
- Configuration files that might contain secrets
- Areas handling user input or external data

Output Requirements:
- If no security issues found: call task_done() with success status
- If issues found: describe each vulnerability with specific file paths, line numbers, and severity via task_log()
- Provide remediation suggestions for each issue`,
  },
  {
    id: "performance-review",
    name: "Performance Review",
    description: "Check for performance anti-patterns and optimization opportunities",
    category: "Quality",
    icon: "zap",
    toolMode: "readonly",
    prompt: `You are a performance reviewer. Analyze the task changes for performance implications.

Performance Checklist:
1. **Algorithmic complexity** — Check for O(n²) or worse patterns that could bottleneck
2. **N+1 queries** — Look for database queries in loops
3. **Memory leaks** — Check for unclosed resources, event listeners, or accumulating caches
4. **Unnecessary re-renders** — For UI code, check for inefficient React/Angular/Vue patterns
5. **Bundle size** — Note if large dependencies are added unnecessarily
6. **Async patterns** — Verify proper use of async/await, Promise.all for parallel work
7. **Caching opportunities** — Identify where caching could improve performance

Files to Review:
- All modified files, focusing on hot paths and frequently executed code
- Database query files
- API endpoints and route handlers

Output Requirements:
- If performance is acceptable: call task_done() with success status
- If issues found: describe each issue with specific file paths and suggested optimizations via task_log()`,
  },
  {
    id: "accessibility-check",
    name: "Accessibility Check",
    description: "Verify UI changes meet accessibility standards (WCAG 2.1)",
    category: "Quality",
    icon: "eye",
    toolMode: "readonly",
    prompt: `You are an accessibility reviewer. Check UI changes for WCAG 2.1 compliance.

Accessibility Checklist:
1. **Keyboard navigation** — Ensure all interactive elements are keyboard accessible
2. **ARIA labels** — Check that screen reader announcements are appropriate
3. **Color contrast** — Verify text meets minimum contrast ratios (4.5:1 for normal text)
4. **Focus indicators** — Ensure visible focus states for keyboard navigation
5. **Alt text** — Check that images have meaningful alternative text
6. **Form labels** — Verify all inputs have associated labels
7. **Semantic HTML** — Check that proper HTML elements are used (buttons not divs)

Files to Review:
- Modified UI components
- CSS/styling changes
- New HTML templates or JSX

Output Requirements:
- If accessibility requirements are met: call task_done() with success status
- If issues found: describe each issue with specific file paths, WCAG guideline references, and remediation steps via task_log()`,
  },
  {
    id: "browser-verification",
    name: "Browser Verification",
    description: "Verify web application functionality using browser automation",
    category: "Quality",
    icon: "globe",
    toolMode: "coding",
    prompt: `You are a browser verification specialist. Verify web application functionality after task implementation using the agent-browser CLI tool.

## Prerequisites
First, determine the URL to verify. Check the task PROMPT.md for any URLs mentioned, or look at the code changes to identify the local development server URL (typically http://localhost:3000, http://localhost:5173, http://localhost:8080, etc.).

## Verification Commands
Use these agent-browser commands for verification:
- \`agent-browser open <url>\` — Navigate to the page
- \`agent-browser snapshot -i\` — Get interactive elements with refs (@e1, @e2, etc.)
- \`agent-browser click @e1\` — Click an element
- \`agent-browser fill @e1 "text"\` — Fill an input field
- \`agent-browser get text @e1\` — Get element text content
- \`agent-browser screenshot\` — Capture screenshot to file
- \`agent-browser wait --load networkidle\` — Wait for page to fully load

## Verification Checklist
1. Page loads without JavaScript errors or blank screens
2. Navigation between pages/sections works
3. Forms accept input and submit correctly
4. Interactive elements (buttons, links) respond to clicks
5. Error states are handled gracefully
6. Screenshots capture expected content

## Output Requirements
- If verification succeeds: call task_done() with success status
- If verification fails: describe what failed and how it should behave via task_log()
- Include screenshots as evidence of verification results

Note: Refs (@e1, @e2) are invalidated after page navigation. Re-snapshot after clicking links or form submissions.`,
  },
];

export interface PrInfo {
  url: string;
  number: number;
  status: PrStatus;
  title: string;
  headBranch: string;
  baseBranch: string;
  commentCount: number;
  lastCommentAt?: string;
  lastCheckedAt?: string;
}

export type IssueState = "open" | "closed";

export interface IssueInfo {
  url: string;
  number: number;
  state: IssueState;
  title: string;
  stateReason?: "completed" | "not_planned" | "reopened";
  lastCheckedAt?: string;
}

export interface BatchStatusRequest {
  taskIds: string[];
}

export interface BatchStatusEntry {
  issueInfo?: IssueInfo;
  prInfo?: PrInfo;
  stale: boolean;
  error?: string;
}

export type BatchStatusResult = Record<string, BatchStatusEntry>;

export interface BatchStatusResponse {
  results: BatchStatusResult;
}

export type StepStatus = "pending" | "in-progress" | "done" | "skipped";

export interface TaskStep {
  name: string;
  status: StepStatus;
}

export interface TaskLogEntry {
  timestamp: string;
  action: string;
  outcome?: string;
}

export type ActivityEventType = "task:created" | "task:moved" | "task:updated" | "task:deleted" | "task:merged" | "task:failed" | "settings:updated";

export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  type: ActivityEventType;
  taskId?: string;
  taskTitle?: string;
  details: string;
  metadata?: Record<string, unknown>;
}

/** The set of agent roles that produce log entries. */
export type AgentRole = "triage" | "executor" | "reviewer" | "merger";

/** The discriminator for agent log entry types. */
export type AgentLogType = "text" | "tool" | "thinking" | "tool_result" | "tool_error";

/** A single chunk of agent output persisted to disk (JSONL in agent.log). */
export interface AgentLogEntry {
  /** ISO-8601 timestamp of when the entry was recorded. */
  timestamp: string;
  /** The task this log entry belongs to. */
  taskId: string;
  /** The text content (delta for "text"/"thinking", tool name for "tool"/"tool_result"/"tool_error"). */
  text: string;
  /** The kind of entry — text delta, tool invocation marker, thinking block, tool result, or tool error. */
  type: AgentLogType;
  /** For tool entries: human-readable summary of tool args (e.g. file path, command).
   *  For tool_result/tool_error: summary of the result or error message. */
  detail?: string;
  /** Which agent produced this entry. Absent in logs written before this field was added. */
  agent?: AgentRole;
}

export interface TaskAttachment {
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface SteeringComment {
  id: string;
  text: string;
  createdAt: string;
  author: "user" | "agent";
}

export interface TaskComment {
  id: string;
  text: string;
  author: string;
  createdAt: string;
  updatedAt?: string;
}

export interface TaskCommentInput {
  text: string;
  author: string;
}

export interface MergeDetails {
  commitSha?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  mergeCommitMessage?: string;
  mergedAt?: string;
  mergeConfirmed?: boolean;
  prNumber?: number;
  resolutionStrategy?: "ai" | "auto-resolve" | "theirs";
  resolutionMethod?: "ai" | "auto" | "mixed" | "theirs";
  attemptsMade?: 1 | 2 | 3;
  autoResolvedCount?: number;
}

export interface Task {
  id: string;
  title?: string;
  description: string;
  column: Column;
  dependencies: string[];
  /** User-requested hint for triage: prefer splitting into child tasks when appropriate. */
  breakIntoSubtasks?: boolean;
  worktree?: string;
  steps: TaskStep[];
  currentStep: number;
  status?: string;
  /** ID of the in-progress task whose file scope overlaps with this task,
   *  causing the scheduler to defer it. Set when the scheduler queues
   *  the task due to file-scope overlap; cleared (set to `undefined`)
   *  when the task is eventually started or moved to done. */
  blockedBy?: string;
  /** When true, all automated agent and scheduler interaction is suspended. */
  paused?: boolean;
  /** Git branch name (or task ID) to use as the starting point when
   *  creating this task's worktree. Set by the scheduler when a task's
   *  explicit dependency or `blockedBy` task is in-review with an
   *  unmerged branch. The executor reads this to branch from the
   *  dependency's branch instead of HEAD. Cleared after worktree creation. */
  baseBranch?: string;
  /** Actual git branch name used for this task's worktree. May differ from
   *  the conventional `kb/{task-id}` when conflict recovery generated a
   *  unique suffixed name (e.g., `kb/fn-042-2`). The merger and PR systems
   *  read this field instead of deriving the branch from the task ID. */
  branch?: string;
  /** Base commit SHA for creating this task's worktree. Used with baseBranch
   *  to establish the exact starting point for the worktree. */
  baseCommitSha?: string;
  /** List of files modified by this task (populated during execution) */
  modifiedFiles?: string[];
  /** Mission ID this task is linked to (for mission hierarchy) */
  missionId?: string;
  /** Slice ID this task is linked to (for mission hierarchy) */
  sliceId?: string;
  attachments?: TaskAttachment[];
  steeringComments?: SteeringComment[];
  comments?: TaskComment[];
  /** PR information for tasks linked to GitHub pull requests */
  prInfo?: PrInfo;
  mergeDetails?: MergeDetails;
  /** Issue information for tasks imported from GitHub issues */
  issueInfo?: IssueInfo;
  log: TaskLogEntry[];
  size?: "S" | "M" | "L";
  reviewLevel?: number;
  /** Model preset selected during task creation. Presets resolve to concrete model overrides at creation time. */
  modelPresetId?: string;
  /** AI model provider override for the executor agent (e.g., "anthropic").
   *  Must be set together with `modelId`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelProvider?: string;
  /** AI model ID override for the executor agent (e.g., "claude-sonnet-4-5").
   *  Must be set together with `modelProvider`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelId?: string;
  /** AI model provider override for the validator/reviewer agent.
   *  Must be set together with `validatorModelId`. When both validator model fields
   *  are undefined, the reviewer uses global settings defaults. */
  validatorModelProvider?: string;
  /** AI model ID override for the validator/reviewer agent.
   *  Must be set together with `validatorModelProvider`. When both validator model
   *  fields are undefined, the reviewer uses global settings defaults. */
  validatorModelId?: string;
  /** AI model provider override for the planning/triage agent.
   *  Must be set together with `planningModelId`. When both planning model fields
   *  are undefined, the triage agent uses global settings defaults. */
  planningModelProvider?: string;
  /** AI model ID override for the planning/triage agent.
   *  Must be set together with `planningModelProvider`. When both planning model
   *  fields are undefined, the triage agent uses global settings defaults. */
  planningModelId?: string;
  /** IDs of workflow steps enabled for this task, run after implementation completes */
  enabledWorkflowSteps?: string[];
  /** Results from workflow step executions (populated after task implementation) */
  workflowStepResults?: WorkflowStepResult[];
  /** Number of merge retry attempts made for this task (auto-merge conflict recovery) */
  mergeRetries?: number;
  /** Number of times the stuck-task detector has killed this task's agent session.
   *  Incremented by the self-healing manager on each stuck kill. When this reaches
   *  `maxStuckKills`, the task is marked as permanently failed instead of re-queued. */
  stuckKillCount?: number;
  /** Number of bounded recovery retry attempts for transient executor/triage failures.
   *  Distinct from `mergeRetries` (merge-conflict-specific). Incremented by the
   *  recovery-policy module on each recoverable failure; cleared when work restarts
   *  cleanly or reaches a terminal column (in-review, done, archived). */
  recoveryRetryCount?: number;
  /** ISO-8601 timestamp indicating when the task becomes eligible for the next
   *  recovery retry. Scheduler and triage processor skip tasks whose
   *  `nextRecoveryAt` is still in the future. Cleared alongside `recoveryRetryCount`. */
  nextRecoveryAt?: string;
  /** Thinking level for AI agent sessions — controls reasoning effort (off/minimal/low/medium/high) */
  thinkingLevel?: ThinkingLevel;
  /** Explicitly assigned agent ID for task-agent linking. Distinct from Agent.taskId active execution state. */
  assignedAgentId?: string;
  /** Path to the persisted agent session file, enabling pause/resume without
   *  losing conversation context. Set when execution starts; cleared on
   *  completion or terminal failure. */
  sessionFile?: string;
  /** Error message from the last failure, if the task failed during execution */
  error?: string;
  /** Optional summary of what was changed/fixed when task is completed */
  summary?: string;
  /** ISO-8601 timestamp of when the task last entered its current column.
   *  Used to sort cards within a column so that recently-moved cards appear at the top. */
  columnMovedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends Task {
  prompt: string;
}

export interface TaskCreateInput {
  title?: string;
  description: string;
  column?: Column;
  dependencies?: string[];
  breakIntoSubtasks?: boolean;
  /** IDs of workflow steps to enable for this task */
  enabledWorkflowSteps?: string[];
  /** Model preset selected during task creation. Presets resolve to concrete model overrides at creation time. */
  modelPresetId?: string;
  /** AI model provider override for the executor agent (e.g., "anthropic").
   *  Must be set together with `modelId`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelProvider?: string;
  /** AI model ID override for the executor agent (e.g., "claude-sonnet-4-5").
   *  Must be set together with `modelProvider`. When both model fields are undefined,
   *  the executor uses global settings defaults. */
  modelId?: string;
  /** AI model provider override for the validator/reviewer agent.
   *  Must be set together with `validatorModelId`. When both validator model fields
   *  are undefined, the reviewer uses global settings defaults. */
  validatorModelProvider?: string;
  /** AI model ID override for the validator/reviewer agent.
   *  Must be set together with `validatorModelProvider`. When both validator model
   *  fields are undefined, the reviewer uses global settings defaults. */
  validatorModelId?: string;
  /** AI model provider override for the planning/triage agent.
   *  Must be set together with `planningModelId`. When both planning model fields
   *  are undefined, the triage agent uses global settings defaults. */
  planningModelProvider?: string;
  /** AI model ID override for the planning/triage agent.
   *  Must be set together with `planningModelProvider`. When both planning model
   *  fields are undefined, the triage agent uses global settings defaults. */
  planningModelId?: string;
  /** Thinking level for AI agent sessions — controls reasoning effort (off/minimal/low/medium/high) */
  thinkingLevel?: ThinkingLevel;
  /** When true, trigger AI title summarization if description is long and no title provided */
  summarize?: boolean;
  /** Mission ID to link this task to (for mission hierarchy) */
  missionId?: string;
  /** Slice ID to link this task to (for mission hierarchy) */
  sliceId?: string;
  /** Optional explicit agent assignment for this task */
  assignedAgentId?: string;
}

// ── Settings Scope Types ────────────────────────────────────────────────
//
// Settings are split into two scopes:
//
// 1. **GlobalSettings** — User preferences stored in `~/.pi/fusion/settings.json`.
//    These persist across all kb projects for the current user (theme, default
//    AI models, notification preferences).
//
// 2. **ProjectSettings** — Project-specific workflow and resource settings stored
//    in `.fusion/config.json`. These control how the engine operates for this
//    particular project (concurrency, merge strategy, worktree management, etc.).
//
// The merged view (`Settings`) combines both scopes: project values override
// global values. This is the type returned by `TaskStore.getSettings()` and
// used by most consumers.
//
// Computed/server-only fields (like `githubTokenConfigured`) live only on
// `Settings` and are injected at read time by the API layer.

/** Settings scope discriminator for UI and validation. */
export type SettingsScope = "global" | "project";

/**
 * Global (user-level) settings stored in `~/.pi/fusion/settings.json`.
 *
 * These are user preferences that persist across all kb projects.
 * The dashboard UI shows these under a "Global" section.
 */
export interface GlobalSettings {
  /** Theme mode preference: dark, light, or system (follows OS). Default: "dark". */
  themeMode?: ThemeMode;
  /** Color theme preference for accent colors and styling. Default: "default". */
  colorTheme?: ColorTheme;
  /** Default AI model provider name (e.g. `"anthropic"`, `"openai"`).
   *  Must be set together with `defaultModelId`. When both are undefined,
   *  the engine uses pi's automatic model resolution. */
  defaultProvider?: string;
  /** Default AI model ID within the provider (e.g. `"claude-sonnet-4-5"`).
   *  Must be set together with `defaultProvider`. When both are undefined,
   *  the engine uses pi's automatic model resolution. */
  defaultModelId?: string;
  /** Fallback AI model provider used when the primary default model fails due to
   *  transient provider-side issues such as rate limits or overloaded capacity.
   *  Must be set together with `fallbackModelId`. */
  fallbackProvider?: string;
  /** Fallback AI model ID used with `fallbackProvider` when the primary default
   *  model fails due to transient provider-side issues such as rate limits or
   *  overloaded capacity. Must be set together with `fallbackProvider`. */
  fallbackModelId?: string;
  /** Default thinking effort level for AI agent sessions.
   *  Controls how much reasoning effort the model uses — higher levels
   *  produce better results but cost more. When undefined, the engine
   *  uses the model's default thinking level. */
  defaultThinkingLevel?: ThinkingLevel;
  /** When true, enables ntfy.sh push notifications for task completion and failures.
   *  Requires ntfyTopic to be set. Default: false. */
  ntfyEnabled?: boolean;
  /** ntfy.sh topic name for push notifications. When set along with ntfyEnabled,
   *  notifications are sent to https://ntfy.sh/{topic} when tasks complete or fail. */
  ntfyTopic?: string;
  /** List of notification events to send via ntfy.sh.
   *  When ntfyEnabled is true, only events in this list will trigger notifications.
   *  If undefined or empty when ntfyEnabled is true, all events are sent (backward compatible).
   *  Default: ["in-review", "merged", "failed"] */
  ntfyEvents?: NtfyNotificationEvent[];
  /** Dashboard hostname for ntfy.sh deep links. When set along with ntfyEnabled
   *  and ntfyTopic, notifications include a Click URL that opens the dashboard
   *  directly to the task. In multi-project setups the URL includes both
   *  ?project=<id>&task=<id> so the dashboard opens the correct project first.
   *  Example: "http://localhost:3000" or "https://fusion.example.com" */
  ntfyDashboardHost?: string;
  /** The default project ID for CLI operations when --project flag is not provided.
   *  Used to determine which project to operate on when not in a project directory.
   *  Set via `kb project set-default <name>`. */
  defaultProjectId?: string;
  /** Whether the first-run setup wizard has been completed.
   *  Set to true when the user completes the multi-project setup process.
   *  Default: false (undefined until setup is completed). */
  setupComplete?: boolean;
  /** List of favorite provider names. Favorite providers appear at the top of
   *  model selection dropdowns. Order is preserved - earlier entries appear higher. */
  favoriteProviders?: string[];
  /** List of favorite model identifiers. Each entry is formatted as `{provider}/{modelId}`
   *  (e.g., `"anthropic/claude-sonnet-4-5"`). Favorited models appear as pinned rows
   *  at the very top of model selection dropdowns, before provider groups. Order is
   *  preserved - earlier entries appear higher. */
  favoriteModels?: string[];
  /** When true, the dashboard eagerly fetches the latest model catalog from
   *  the OpenRouter API at startup so the model picker shows all available
   *  OpenRouter models (not just the static built-in list). Default: true. */
  openrouterModelSync?: boolean;
  /** When true, indicates the user has completed the AI model onboarding flow
   *  (connected at least one provider and selected a default model). When
   *  false/undefined, the dashboard will auto-open the onboarding modal.
   *  Also set to true when the user explicitly dismisses onboarding. */
  modelOnboardingComplete?: boolean;
}

/**
 * Project-level settings stored in `.fusion/config.json`.
 *
 * These control how the engine operates for this particular project:
 * concurrency, merge strategy, worktree management, build/test commands, etc.
 * Runtime state fields (globalPause, enginePaused) also live here because
 * different projects may need independent pause control.
 */
export interface ProjectSettings {
  /** Hard stop: when true, all automated agent activity is **immediately**
   *  terminated — active triage, execution, and merge agent sessions are
   *  killed, and the scheduler stops dispatching new work. Acts as a
   *  global emergency stop for the entire AI engine.
   *  Individual per-task pause flags are unaffected. */
  globalPause?: boolean;
  /** Engine pause (soft pause): when true, the scheduler and triage
   *  processor stop dispatching **new** work (scheduling, triage
   *  specification, and auto-merge), but currently running agent sessions
   *  are allowed to finish naturally — no sessions are terminated.
   *  This is the normal on/off toggle for the AI engine.
   *  Contrast with {@link globalPause}, which is a hard stop that
   *  immediately terminates all active agent sessions. Has no additional
   *  effect when {@link globalPause} is also true (hard stop already
   *  covers everything). */
  enginePaused?: boolean;
  /** Maximum number of concurrent AI agents across all activity types
   *  (triage specification, task execution, and merge operations). */
  maxConcurrent: number;
  maxWorktrees: number;
  pollIntervalMs: number;
  groupOverlappingFiles: boolean;
  autoMerge: boolean;
  /** How completed in-review tasks should be finalized when autoMerge is enabled.
   *  - "direct": preserve the existing local squash-merge flow into the current branch
   *  - "pull-request": create or reuse a GitHub PR and wait for GitHub-side checks/reviews
   *    before merging through GitHub
   *  Default: "direct" for backward compatibility. */
  mergeStrategy?: MergeStrategy;
  /** Shell command to run inside each new worktree immediately after creation.
   *  Useful for project-specific setup (e.g. `pnpm install`, `cp .env.local .env`). */
  worktreeInitCommand?: string;
  /** Custom test command for the project (e.g. "pnpm test") */
  testCommand?: string;
  /** Custom build command for the project (e.g. "pnpm build") */
  buildCommand?: string;
  /** When true, completed task worktrees are returned to an idle pool instead
   *  of being deleted. New tasks acquire a warm worktree from the pool,
   *  preserving build caches (node_modules, target/, dist/). Default: false. */
  recycleWorktrees?: boolean;
  /** Controls how worktree directory names are generated when creating fresh worktrees.
   *  Only applies when recycleWorktrees is NOT enabled (pooled worktrees retain their existing names).
   *  - "random": Human-friendly adjective-noun names (e.g., swift-falcon) — default
   *  - "task-id": Use the task ID (e.g., kb-042)
   *  - "task-title": Use a slugified version of the task title (e.g., fix-login-bug)
   *  Default: "random". */
  worktreeNaming?: "random" | "task-id" | "task-title";
  /** Prefix for generated task IDs (e.g. `"KB"` produces `KB-001`).
   *  Defaults to `"KB"`. Only affects new tasks — existing tasks retain
   *  their original IDs. */
  taskPrefix?: string;
  /** When true, merge commit messages include the task ID as the conventional
   *  commit scope (e.g. `feat(KB-001): ...`). When false, the scope is
   *  omitted (e.g. `feat: ...`). Default: true. */
  includeTaskIdInCommit?: boolean;
  /** AI model provider for planning/triage (specification) agent.
   *  Must be set together with `planningModelId`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  planningProvider?: string;
  /** AI model ID for planning/triage (specification) agent.
   *  Must be set together with `planningProvider`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  planningModelId?: string;
  /** Fallback model provider for planning/triage. When unset, falls back to the
   *  global fallback model. Must be set together with `planningFallbackModelId`. */
  planningFallbackProvider?: string;
  /** Fallback model ID for planning/triage. When unset, falls back to the
   *  global fallback model. Must be set together with `planningFallbackProvider`. */
  planningFallbackModelId?: string;
  /** AI model provider for validator/reviewer agent.
   *  Must be set together with `validatorModelId`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  validatorProvider?: string;
  /** AI model ID for validator/reviewer agent.
   *  Must be set together with `validatorProvider`. When both are undefined,
   *  falls back to `defaultProvider`/`defaultModelId`. */
  validatorModelId?: string;
  /** Fallback model provider for validator/reviewer. When unset, falls back to
   *  the global fallback model. Must be set together with
   *  `validatorFallbackModelId`. */
  validatorFallbackProvider?: string;
  /** Fallback model ID for validator/reviewer. When unset, falls back to the
   *  global fallback model. Must be set together with `validatorFallbackProvider`. */
  validatorFallbackModelId?: string;
  /** Reusable model configuration presets for task creation. */
  modelPresets?: ModelPreset[];
  /** When true, task creation UIs automatically recommend/apply a preset based on task size. */
  autoSelectModelPreset?: boolean;
  /** Mapping of task sizes to preset IDs used for auto-selection during task creation. */
  defaultPresetBySize?: { S?: string; M?: string; L?: string };
  /** When true, auto-merge will automatically resolve common conflict patterns
   *  (lock files, generated files, trivial conflicts) without requiring AI
   *  intervention. When AI resolution fails, the system will retry with escalating
   *  strategies. Default: true. */
  autoResolveConflicts?: boolean;
  /** Alias for autoResolveConflicts. When true, enables automatic resolution of
   *  lock files (ours), generated files (theirs), and trivial whitespace conflicts
   *  without spawning an AI agent. Default: true. */
  smartConflictResolution?: boolean;
  /** When true, out-of-scope file changes block merge instead of just logging warnings.
   *  Useful for teams that want strict enforcement of declared File Scope.
   *  Default: false (soft guardrail — warnings only). */
  strictScopeEnforcement?: boolean;
  /** Maximum number of build retry attempts during merge when a build fails with a
   *  transient error. Default: 0 (no retry). Set to 1 to allow one retry. */
  buildRetryCount?: number;
  /** Timeout in milliseconds for build commands during merge. Default: 300000 (5 min). */
  buildTimeoutMs?: number;
  /** When enabled, AI-generated task specifications require manual approval
   *  before the task can move from triage to todo. Tasks with approved specs
   *  remain in triage with status "awaiting-approval" until a user approves
   *  or rejects the plan. Default: false. */
  requirePlanApproval?: boolean;
  /** Timeout in milliseconds for detecting stuck tasks. When a task's agent session
   *  shows no activity (no text deltas, tool calls, or progress updates) for longer
   *  than this duration, the task is considered stuck and will be terminated and retried.
   *  Default: undefined (disabled). Suggested value: 600000 (10 minutes). */
  taskStuckTimeoutMs?: number;
  /** When true, automatically unpause after rate-limit-triggered globalPause using
   *  escalating backoff. Allows unattended recovery from transient API rate limits.
   *  Default: true. */
  autoUnpauseEnabled?: boolean;
  /** Base delay in milliseconds before first auto-unpause attempt after rate-limit pause.
   *  Subsequent attempts use exponential backoff (2x). Default: 300000 (5 min). */
  autoUnpauseBaseDelayMs?: number;
  /** Maximum delay cap in milliseconds for auto-unpause backoff. Default: 3600000 (60 min). */
  autoUnpauseMaxDelayMs?: number;
  /** Maximum number of times the stuck-task detector can kill and re-queue a task
   *  before it is marked as permanently failed. Default: 6. */
  maxStuckKills?: number;
  /** Maximum number of child agents a single parent agent can spawn.
   *  Limits the fan-out per executor task to prevent resource exhaustion.
   *  Default: 5. */
  maxSpawnedAgentsPerParent?: number;
  /** Maximum total spawned agents across all parent agents in a single executor instance.
   *  Provides a global safety cap regardless of how many parent agents are running.
   *  Default: 20. */
  maxSpawnedAgentsGlobal?: number;
  /** Interval in milliseconds for periodic maintenance (worktree pruning, WAL checkpoint,
   *  orphan cleanup). 0 disables. Default: 900000 (15 min). */
  maintenanceIntervalMs?: number;
  /** When true, automatically poll and update PR status badges for tasks linked to GitHub PRs.
   *  Default: false. */
  autoUpdatePrStatus?: boolean;
  /** When true, automatically create GitHub PRs for completed tasks.
   *  Default: false. */
  autoCreatePr?: boolean;
  /** When true, automatic database backups are enabled. Default: false. */
  autoBackupEnabled?: boolean;
  /** Cron expression for backup schedule. Default: "0 2 * * *" (daily at 2 AM). */
  autoBackupSchedule?: string;
  /** Number of backup files to retain (oldest deleted when exceeded). Default: 7. */
  autoBackupRetention?: number;
  /** Directory for backup files, relative to project root. Default: ".fusion/backups". */
  autoBackupDir?: string;
  /** When true, tasks created without titles but with descriptions longer than 200
   *  characters will automatically receive an AI-generated title (max 60 chars).
   *  Default: false. */
  autoSummarizeTitles?: boolean;
  /** AI model provider for title summarization (when autoSummarizeTitles is enabled).
   *  Must be set together with `titleSummarizerModelId`. Falls back to planningProvider,
   *  then defaultProvider if not specified. */
  titleSummarizerProvider?: string;
  /** AI model ID for title summarization (when autoSummarizeTitles is enabled).
   *  Must be set together with `titleSummarizerProvider`. Falls back to planningModelId,
   *  then defaultModelId if not specified. */
  titleSummarizerModelId?: string;
  /** Fallback model provider for title summarization. When unset, falls back to
   *  planning fallback, then global fallback. Must be set together with
   *  `titleSummarizerFallbackModelId`. */
  titleSummarizerFallbackProvider?: string;
  /** Fallback model ID for title summarization. When unset, falls back to
   *  planning fallback, then global fallback. Must be set together with
   *  `titleSummarizerFallbackProvider`. */
  titleSummarizerFallbackModelId?: string;
  /** Named scripts that can be referenced by setupScript or other automation.
   *  A map of script name to shell command. */
  scripts?: Record<string, string>;
  /** Reference to a named script in the scripts map that runs before task execution.
   *  Used for pre-task setup like environment preparation. */
  setupScript?: string;
  /** When true, enables periodic AI-powered extraction of insights from working memory
   *  into a distilled long-term memory file. Creates an automation schedule that reads
   *  `.fusion/memory.md`, identifies patterns/principles/pitfalls, and writes to
   *  `.fusion/memory-insights.md`. Default: false. */
  insightExtractionEnabled?: boolean;
  /** Cron expression for insight extraction schedule. Only used when
   *  insightExtractionEnabled is true. Default: "0 2 * * *" (daily at 2 AM). */
  insightExtractionSchedule?: string;
  /** Minimum interval between insight extractions in milliseconds. Prevents
   *  excessive AI calls when working memory hasn't changed significantly.
   *  Extraction only runs if BOTH this time has elapsed AND memory has grown
   *  by more than MIN_INSIGHT_GROWTH_CHARS characters. Default: 86400000 (24h). */
  insightExtractionMinIntervalMs?: number;
  /** When enabled, agents will consult and update .fusion/memory.md with durable
   *  project learnings. When disabled, agents will not include memory instructions
   *  in their prompts and will not read or write to .fusion/memory.md.
   *  Default: true (enabled for backward compatibility). */
  memoryEnabled?: boolean;
  /** Maximum token count before auto-compact triggers. When undefined, compact
   *  only on overflow errors. When set, the engine monitors token usage after
   *  each prompt and proactively compacts context when the token count reaches
   *  this threshold. */
  tokenCap?: number;
  /** When true, each task step runs in its own fresh agent session instead of a
   *  single session for the entire task. Enables per-step error recovery and
   *  optional parallel execution when steps have non-overlapping file scopes.
   *  Default: false. */
  runStepsInNewSessions?: boolean;
  /** Maximum number of steps to run in parallel when runStepsInNewSessions is
   *  enabled and steps have non-overlapping file scopes. Range: 1–4.
   *  Default: 2. */
  maxParallelSteps?: number;
  /** Configurable agent role prompt templates and assignments.
   *  When set, allows per-project customization of system prompts
   *  for different agent roles (executor, triage, reviewer, merger). */
  agentPrompts?: AgentPromptsConfig;
}

/**
 * Merged settings view combining global and project scopes.
 *
 * This is the primary type returned by `TaskStore.getSettings()` and used
 * by most consumers. Project settings override global settings.
 *
 * Also includes computed/server-only fields like `githubTokenConfigured`
 * that are injected at read time by the API layer.
 */
export interface Settings extends GlobalSettings, ProjectSettings {
  /** Whether GitHub token is configured for PR operations (read-only, set by server).
   *  When false, PR creation features are disabled in the UI. */
  githubTokenConfigured?: boolean;
}

/** Default values for global (user-level) settings. */
export const DEFAULT_GLOBAL_SETTINGS: Required<Pick<GlobalSettings, "themeMode" | "colorTheme">> & GlobalSettings = {
  themeMode: "dark",
  colorTheme: "default",
  defaultProvider: undefined,
  defaultModelId: undefined,
  fallbackProvider: undefined,
  fallbackModelId: undefined,
  defaultThinkingLevel: undefined,
  ntfyEnabled: false,
  ntfyTopic: undefined,
  ntfyEvents: ["in-review", "merged", "failed"],
  ntfyDashboardHost: undefined,
  openrouterModelSync: true,
  modelOnboardingComplete: undefined,
};

/** Default values for project-level settings. */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  globalPause: false,
  enginePaused: false,
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: true,
  autoMerge: true,
  mergeStrategy: "direct",
  worktreeInitCommand: undefined,
  recycleWorktrees: false,
  worktreeNaming: "random",
  taskPrefix: "FN",
  includeTaskIdInCommit: true,
  planningProvider: undefined,
  planningModelId: undefined,
  planningFallbackProvider: undefined,
  planningFallbackModelId: undefined,
  validatorProvider: undefined,
  validatorModelId: undefined,
  validatorFallbackProvider: undefined,
  validatorFallbackModelId: undefined,
  modelPresets: [],
  autoSelectModelPreset: false,
  defaultPresetBySize: {},
  autoResolveConflicts: true,
  smartConflictResolution: true,
  strictScopeEnforcement: false,
  buildRetryCount: 0,
  buildTimeoutMs: 300_000,
  requirePlanApproval: false,
  taskStuckTimeoutMs: undefined,
  autoUnpauseEnabled: true,
  autoUnpauseBaseDelayMs: 300_000,
  autoUnpauseMaxDelayMs: 3_600_000,
  maxStuckKills: 6,
  maxSpawnedAgentsPerParent: 5,
  maxSpawnedAgentsGlobal: 20,
  maintenanceIntervalMs: 900_000,
  autoUpdatePrStatus: false,
  autoCreatePr: false,
  autoBackupEnabled: false,
  autoBackupSchedule: "0 2 * * *",
  autoBackupRetention: 7,
  autoBackupDir: ".fusion/backups",
  autoSummarizeTitles: false,
  titleSummarizerProvider: undefined,
  titleSummarizerModelId: undefined,
  titleSummarizerFallbackProvider: undefined,
  titleSummarizerFallbackModelId: undefined,
  insightExtractionEnabled: false,
  insightExtractionSchedule: "0 2 * * *",
  insightExtractionMinIntervalMs: 86_400_000,
  memoryEnabled: true,
  tokenCap: undefined,
  runStepsInNewSessions: false,
  maxParallelSteps: 2,
  agentPrompts: undefined,
};

/**
 * Merged default settings (backward compatible).
 * This combines global and project defaults into a single object
 * that matches the legacy `DEFAULT_SETTINGS` shape.
 */
export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_GLOBAL_SETTINGS,
  ...DEFAULT_PROJECT_SETTINGS,
};

/** Keys that belong to the global settings scope. */
export const GLOBAL_SETTINGS_KEYS: ReadonlyArray<keyof GlobalSettings> = [
  "themeMode",
  "colorTheme",
  "defaultProvider",
  "defaultModelId",
  "fallbackProvider",
  "fallbackModelId",
  "defaultThinkingLevel",
  "ntfyEnabled",
  "ntfyTopic",
  "ntfyEvents",
  "ntfyDashboardHost",
  "defaultProjectId",
  "openrouterModelSync",
  "modelOnboardingComplete",
] as const;

/** Keys that belong to the project settings scope. */
export const PROJECT_SETTINGS_KEYS: ReadonlyArray<keyof ProjectSettings> = [
  "globalPause",
  "enginePaused",
  "maxConcurrent",
  "maxWorktrees",
  "pollIntervalMs",
  "groupOverlappingFiles",
  "autoMerge",
  "mergeStrategy",
  "worktreeInitCommand",
  "testCommand",
  "buildCommand",
  "recycleWorktrees",
  "worktreeNaming",
  "taskPrefix",
  "includeTaskIdInCommit",
  "planningProvider",
  "planningModelId",
  "planningFallbackProvider",
  "planningFallbackModelId",
  "validatorProvider",
  "validatorModelId",
  "validatorFallbackProvider",
  "validatorFallbackModelId",
  "modelPresets",
  "autoSelectModelPreset",
  "defaultPresetBySize",
  "autoResolveConflicts",
  "smartConflictResolution",
  "requirePlanApproval",
  "taskStuckTimeoutMs",
  "maxStuckKills",
  "autoUpdatePrStatus",
  "autoCreatePr",
  "autoBackupEnabled",
  "autoBackupSchedule",
  "autoBackupRetention",
  "autoBackupDir",
  "autoSummarizeTitles",
  "titleSummarizerProvider",
  "titleSummarizerModelId",
  "titleSummarizerFallbackProvider",
  "titleSummarizerFallbackModelId",
  "tokenCap",
  "insightExtractionEnabled",
  "insightExtractionSchedule",
  "insightExtractionMinIntervalMs",
  "memoryEnabled",
  "maxSpawnedAgentsPerParent",
  "maxSpawnedAgentsGlobal",
  "runStepsInNewSessions",
  "maxParallelSteps",
  "agentPrompts",
] as const;

export interface BoardConfig {
  nextId: number;
  settings?: Settings;
  /** Global workflow step definitions */
  workflowSteps?: WorkflowStep[];
  /** Auto-incrementing counter for workflow step IDs */
  nextWorkflowStepId?: number;
}

export interface MergeResult extends MergeDetails {
  task: Task;
  branch: string;
  merged: boolean;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  error?: string;
  /** Internal flag to track if a build retry has been attempted. Not persisted. */
  _buildRetried?: boolean;
}

export const COLUMN_LABELS: Record<Column, string> = {
  triage: "Triage",
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
  archived: "Archived",
};

export const COLUMN_DESCRIPTIONS: Record<Column, string> = {
  triage: "Raw ideas — AI will specify these",
  todo: "Specified and ready to start",
  "in-progress": "AI is working on this in a worktree",
  "in-review": "Complete — ready to merge",
  done: "Merged and closed",
  archived: "Completed and archived",
};

export const VALID_TRANSITIONS: Record<Column, Column[]> = {
  triage: ["todo"],
  todo: ["in-progress", "triage"],
  "in-progress": ["in-review", "todo", "triage"],
  "in-review": ["done", "in-progress", "todo"],
  done: ["todo", "triage", "archived"],
  archived: ["done"],
};

// ── Planning Mode Types ────────────────────────────────────────────────────

/** Entry in the archive log (archive.jsonl) representing a compact, 
 *  restorable snapshot of an archived task without agent log content.
 */
export interface ArchivedTaskEntry {
  id: string;
  title?: string;
  description: string;
  column: "archived"; // Always archived when in the log
  dependencies: string[];
  steps: TaskStep[];
  currentStep: number;
  size?: "S" | "M" | "L";
  reviewLevel?: number;
  prInfo?: PrInfo;
  issueInfo?: IssueInfo;
  /** Attachment metadata (filenames, mime types, etc.) without file content */
  attachments?: TaskAttachment[];
  log: TaskLogEntry[];
  createdAt: string;
  updatedAt: string;
  columnMovedAt?: string;
  /** Timestamp when the task was archived to the log */
  archivedAt: string;
  /** Optional: model preset and override fields for executor and validator */
  modelPresetId?: string;
  modelProvider?: string;
  modelId?: string;
  validatorModelProvider?: string;
  validatorModelId?: string;
  /** Optional: planning model override for triage agent */
  planningModelProvider?: string;
  planningModelId?: string;
  /** Optional: other metadata to preserve */
  breakIntoSubtasks?: boolean;
  paused?: boolean;
  baseBranch?: string;
  /** Actual git branch name used for this task's worktree */
  branch?: string;
  /** Base commit SHA for the task's worktree */
  baseCommitSha?: string;
  /** List of files modified by this task */
  modifiedFiles?: string[];
  /** Mission ID this task is linked to */
  missionId?: string;
  /** Slice ID this task is linked to */
  sliceId?: string;
  mergeRetries?: number;
  recoveryRetryCount?: number;
  nextRecoveryAt?: string;
  error?: string;
}

/** Type of planning question presented to the user */
export type PlanningQuestionType = "text" | "single_select" | "multi_select" | "confirm";

/** Isolation mode for project execution */
export type IsolationMode = "in-process" | "child-process";

/** Project status in the central registry */
export type ProjectStatus = "active" | "paused" | "errored" | "initializing";

/** Node connectivity/health status in the central registry */
export type NodeStatus = "online" | "offline" | "connecting" | "error";

/** A runtime node that can host project execution (local machine or remote host) */
export interface NodeConfig {
  /** Unique node ID (e.g., "node_abc123") */
  id: string;
  /** Display name (unique across all nodes) */
  name: string;
  /** Node type */
  type: "local" | "remote";
  /** Base URL for remote nodes. Undefined for local nodes. */
  url?: string;
  /** API key used for authenticating requests to remote nodes. */
  apiKey?: string;
  /** Current node status */
  status: NodeStatus;
  /** Optional capabilities available on this node */
  capabilities?: AgentCapability[];
  /** Maximum concurrent tasks/runtimes this node can host */
  maxConcurrent: number;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** A project registered in the central database */
export interface RegisteredProject {
  /** Unique project ID (e.g., "proj_abc123") */
  id: string;
  /** Display name */
  name: string;
  /** Absolute path to project directory */
  path: string;
  /** Current project status */
  status: ProjectStatus;
  /** Execution isolation mode */
  isolationMode: IsolationMode;
  /** Optional runtime node assignment */
  nodeId?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
  /** ISO-8601 timestamp of last activity */
  lastActivityAt?: string;
  /** Cached project settings snapshot */
  settings?: ProjectSettings;
}

/** @deprecated Use RegisteredProject instead */
export type ProjectInfo = RegisteredProject;

/** Health metrics for a registered project */
export interface ProjectHealth {
  /** Project ID reference */
  projectId: string;
  /** Current status */
  status: ProjectStatus;
  /** Number of tasks currently active */
  activeTaskCount: number;
  /** Number of agents currently running */
  inFlightAgentCount: number;
  /** ISO-8601 timestamp of last activity */
  lastActivityAt?: string;
  /** ISO-8601 timestamp of last error */
  lastErrorAt?: string;
  /** Last error message */
  lastErrorMessage?: string;
  /** Total completed tasks (cumulative) */
  totalTasksCompleted: number;
  /** Total failed tasks (cumulative) */
  totalTasksFailed: number;
  /** Rolling average task duration in milliseconds */
  averageTaskDurationMs?: number;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Activity log entry in the central unified feed */
export interface CentralActivityLogEntry {
  /** Unique entry ID */
  id: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Event type */
  type: ActivityEventType;
  /** Project ID this event belongs to */
  projectId: string;
  /** Project name (denormalized for display) */
  projectName: string;
  /** Task ID (optional) */
  taskId?: string;
  /** Task title (optional) */
  taskTitle?: string;
  /** Event details */
  details: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Global concurrency state across all projects */
export interface GlobalConcurrencyState {
  /** System-wide concurrent agent limit (default: 4) */
  globalMaxConcurrent: number;
  /** Active agents across all projects */
  currentlyActive: number;
  /** Tasks waiting for concurrency slots */
  queuedCount: number;
  /** Per-project active agent counts */
  projectsActive: Record<string, number>;
}

/** A single question in the planning conversation flow */
export interface PlanningQuestion {
  id: string;
  type: PlanningQuestionType;
  question: string;
  description?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

/** The final summary generated after planning conversation completes */
export interface PlanningSummary {
  title: string;
  description: string;
  suggestedSize: "S" | "M" | "L";
  suggestedDependencies: string[];
  keyDeliverables: string[];
}

/** Response from planning endpoints - either a question or the final summary */
export type PlanningResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: PlanningSummary };

/** Planning session state stored in memory */
export interface PlanningSession {
  id: string;
  ip: string;
  initialPlan: string;
  history: Array<{ question: PlanningQuestion; response: unknown }>;
  currentQuestion?: PlanningQuestion;
  summary?: PlanningSummary;
  createdAt: Date;
  updatedAt: Date;
}

// ── Agent Types ────────────────────────────────────────────────────────────

/** Agent lifecycle states */
export const AGENT_STATES = ["idle", "active", "running", "paused", "error", "terminated"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Valid state transitions for agents */
export const AGENT_VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["active"],
  active: ["running", "paused", "terminated"],
  running: ["active", "paused", "error", "terminated"],
  paused: ["active", "terminated"],
  error: ["active", "terminated"],
  terminated: ["idle", "active", "running"], // Can be restarted or reset
};

/** Single heartbeat event recorded for an agent */
export interface AgentHeartbeatEvent {
  /** ISO-8601 timestamp of when the heartbeat was recorded */
  timestamp: string;
  /** Status of the heartbeat */
  status: "ok" | "missed" | "recovered";
  /** ID of the heartbeat run this event belongs to */
  runId: string;
}

/** What triggered a heartbeat run */
export type HeartbeatInvocationSource = "on_demand" | "timer" | "assignment" | "automation";

/** A continuous heartbeat session/run for an agent */
export interface AgentHeartbeatRun {
  /** Unique identifier for this run */
  id: string;
  /** ID of the agent this run belongs to */
  agentId: string;
  /** ISO-8601 timestamp when the run started */
  startedAt: string;
  /** ISO-8601 timestamp when the run ended (null if active) */
  endedAt: string | null;
  /** Status of the run */
  status: "active" | "completed" | "terminated" | "failed";
  /** What triggered this run */
  invocationSource?: HeartbeatInvocationSource;
  /** Trigger detail (manual, ping, scheduler, system) */
  triggerDetail?: string;
  /** PID of the agent process */
  processPid?: number;
  /** Exit code of the agent process */
  exitCode?: number;
  /** Session ID before execution (for continuity tracking) */
  sessionIdBefore?: string;
  /** Session ID after execution */
  sessionIdAfter?: string;
  /** Token usage for this run */
  usageJson?: { inputTokens: number; outputTokens: number; cachedTokens: number };
  /** Structured result from the run */
  resultJson?: Record<string, unknown>;
  /** Snapshot of context at run start (taskId, projectId, etc.) */
  contextSnapshot?: Record<string, unknown>;
  /** Excerpt of stdout output */
  stdoutExcerpt?: string;
  /** Excerpt of stderr output */
  stderrExcerpt?: string;
}

/** Capabilities/roles an agent can have */
export type AgentCapability = "triage" | "executor" | "reviewer" | "merger" | "scheduler" | "engineer" | "custom";

/** A configurable agent role prompt template. */
export interface AgentPromptTemplate {
  /** Unique identifier (e.g., "default-executor", "senior-engineer") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of this template's behavioral style */
  description: string;
  /** The agent role this template applies to */
  role: AgentCapability;
  /** The system prompt content for this template */
  prompt: string;
  /** Whether this is a built-in template (true) or user-created (false) */
  builtIn?: boolean;
}

/** Configuration for per-agent prompts stored in project settings. */
export interface AgentPromptsConfig {
  /** Custom prompt templates. Built-in templates are always available. */
  templates?: AgentPromptTemplate[];
  /** Mapping from agent role to template ID.
   *  When set, overrides the default built-in prompt for that role.
   *  Key is the AgentCapability string, value is a template ID. */
  roleAssignments?: Partial<Record<AgentCapability, string>>;
}

/** Agent record stored in the system */
export interface Agent {
  /** Unique identifier (e.g., "agent-001") */
  id: string;
  /** Display name */
  name: string;
  /** Role/capability of the agent */
  role: AgentCapability;
  /** Current lifecycle state */
  state: AgentState;
  /** ID of the task this agent is currently working on (if any) */
  taskId?: string;
  /** ISO-8601 timestamp when the agent was created */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
  /** ISO-8601 timestamp of last successful heartbeat */
  lastHeartbeatAt?: string;
  /** Optional metadata */
  metadata: Record<string, unknown>;
  /** Job title / description for the agent */
  title?: string;
  /** Custom icon identifier */
  icon?: string;
  /** Agent ID this agent reports to (org hierarchy) */
  reportsTo?: string;
  /** Runtime configuration. Supports: AgentHeartbeatConfig keys (heartbeatIntervalMs, heartbeatTimeoutMs, maxConcurrentRuns) */
  runtimeConfig?: Record<string, unknown>;
  /** Why the agent was paused (error, manual, etc.) */
  pauseReason?: string;
  /** Capability permission flags */
  permissions?: Record<string, boolean>;
  /** Cumulative input tokens across all runs */
  totalInputTokens?: number;
  /** Cumulative output tokens across all runs */
  totalOutputTokens?: number;
  /** Last error message */
  lastError?: string;
  /** Path to a markdown file containing custom instructions (resolved relative to project root).
   *  Must end in `.md`, no `..` traversal. Max 500 chars. */
  instructionsPath?: string;
  /** Inline custom instructions appended to the agent's system prompt at execution time. Max 50,000 chars. */
  instructionsText?: string;
}

export type MessageResponseMode = "immediate" | "on-heartbeat";

/** Per-agent heartbeat configuration, stored in agent.runtimeConfig */
export interface AgentHeartbeatConfig {
  /** Whether heartbeat triggers are enabled for this agent (default: true) */
  enabled?: boolean;
  /** Polling interval in ms (default: 30000). Min: 1000 */
  heartbeatIntervalMs?: number;
  /** Heartbeat timeout in ms (default: 60000). Min: 5000 */
  heartbeatTimeoutMs?: number;
  /** Max concurrent heartbeat runs per agent (default: 1). Min: 1 */
  maxConcurrentRuns?: number;
  /**
   * How this agent responds to incoming messages.
   * "immediate" triggers a heartbeat run when a message arrives.
   * "on-heartbeat" defers message handling to the next scheduled heartbeat (default).
   */
  messageResponseMode?: MessageResponseMode;
}

/** Extended agent information including heartbeat history */
export interface AgentDetail extends Agent {
  /** Recent heartbeat events (last N events) */
  heartbeatHistory: AgentHeartbeatEvent[];
  /** Current active heartbeat run (if any) */
  activeRun?: AgentHeartbeatRun;
  /** All completed runs for this agent */
  completedRuns: AgentHeartbeatRun[];
}

/** Input for creating a new agent */
export interface AgentCreateInput {
  name: string;
  role: AgentCapability;
  metadata?: Record<string, unknown>;
  title?: string;
  icon?: string;
  reportsTo?: string;
  runtimeConfig?: Record<string, unknown>;
  permissions?: Record<string, boolean>;
  instructionsPath?: string;
  instructionsText?: string;
}

/** Input for updating an existing agent */
export interface AgentUpdateInput {
  name?: string;
  role?: AgentCapability;
  metadata?: Record<string, unknown>;
  title?: string;
  icon?: string;
  reportsTo?: string;
  runtimeConfig?: Record<string, unknown>;
  pauseReason?: string;
  permissions?: Record<string, boolean>;
  lastError?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  instructionsPath?: string;
  instructionsText?: string;
}

/** An API key associated with an agent for bearer token authentication. */
export interface AgentApiKey {
  /** Unique key identifier (e.g., "key-a1b2c3d4") */
  id: string;
  /** The agent this key belongs to */
  agentId: string;
  /** SHA-256 hash of the plaintext token (hex-encoded, 64 chars) */
  tokenHash: string;
  /** Optional human-readable label for the key */
  label?: string;
  /** ISO-8601 timestamp when the key was created */
  createdAt: string;
  /** ISO-8601 timestamp when the key was revoked, null if active */
  revokedAt?: string;
}

/** Result returned when creating a new API key — includes the plaintext token exactly once. */
export interface AgentApiKeyCreateResult {
  /** The persisted key metadata (不含 plaintext token) */
  key: AgentApiKey;
  /** The plaintext token — shown only at creation, never stored */
  token: string;
}

/** Per-task session persistence for an agent */
export interface AgentTaskSession {
  /** Agent ID */
  agentId: string;
  /** Task ID */
  taskId: string;
  /** Session state for resuming context across runs */
  sessionParams: Record<string, unknown>;
  /** Human-readable session identifier */
  sessionDisplayId?: string;
  /** ISO-8601 timestamp when session was created */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Aggregate statistics for agents */
export interface AgentStats {
  /** Number of agents in active/running state */
  activeCount: number;
  /** Number of tasks assigned to agents */
  assignedTaskCount: number;
  /** Total completed runs */
  completedRuns: number;
  /** Total failed runs */
  failedRuns: number;
  /** Success rate (0-1) */
  successRate: number;
}

// ── Multi-Project First-Run & Migration Types ───────────────────────────────

/** Detected project for migration consideration */
export interface DetectedProject {
  /** Absolute path to project directory */
  path: string;
  /** Auto-generated or derived project name */
  name: string;
  /** Whether the project has a valid fusion.db */
  hasDb: boolean;
}

/** Setup state for the first-run wizard UI */
export interface SetupState {
  /** Whether this is a first-run scenario (no projects registered) */
  isFirstRun: boolean;
  /** Whether any projects were detected on the filesystem */
  hasDetectedProjects: boolean;
  /** Projects detected on filesystem for potential registration */
  detectedProjects: DetectedProject[];
  /** Projects already registered in the central database */
  registeredProjects: RegisteredProject[];
  /** Recommended action based on current state */
  recommendedAction: "auto-detect" | "create-new" | "manual-setup";
}

/** Input for setting up a project via the wizard */
export interface ProjectSetupInput {
  /** Project path */
  path: string;
  /** Display name */
  name: string;
  /** Isolation mode preference */
  isolationMode?: "in-process" | "child-process";
}

/** Result of completing the first-run setup */
export interface SetupCompletionResult {
  /** Whether the setup completed successfully */
  success: boolean;
  /** Projects that were registered */
  projects: RegisteredProject[];
  /** Recommended next steps for the user */
  nextSteps: string[];
}

/** Options for running a migration */
export interface MigrationOptions {
  /** Path to start scanning for projects (default: process.cwd()) */
  startPath?: string;
  /** Maximum recursion depth for scanning (default: 5) */
  maxDepth?: number;
  /** Whether to simulate without making changes */
  dryRun?: boolean;
  /** Whether to auto-register detected projects */
  autoRegister?: boolean;
  /** Progress callback for long-running operations */
  onProgress?: (current: number, total: number, path: string) => void;
}

/** Result of a migration operation (from MigrationOrchestrator) */
export interface MigrationResult {
  /** Projects detected during scanning */
  projectsDetected: DetectedProject[];
  /** Projects that were registered */
  projectsRegistered: RegisteredProject[];
  /** Projects that were skipped with reasons */
  projectsSkipped: Array<{ path: string; reason: string }>;
  /** Errors encountered during migration */
  errors: Array<{ path: string; error: string }>;
}

// ── Messaging Types ──────────────────────────────────────────────────────────

/** Participant types for message routing */
export type ParticipantType = "agent" | "user" | "system";

/** Message types/categories */
export type MessageType = "agent-to-agent" | "agent-to-user" | "user-to-agent" | "system";

/** Message record stored in the system */
export interface Message {
  /** Unique identifier */
  id: string;
  /** Sender identifier */
  fromId: string;
  /** Sender type */
  fromType: ParticipantType;
  /** Recipient identifier */
  toId: string;
  /** Recipient type */
  toType: ParticipantType;
  /** Message body */
  content: string;
  /** Message category */
  type: MessageType;
  /** Whether the recipient has read this message */
  read: boolean;
  /** Optional extra data */
  metadata?: Record<string, unknown>;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Input for creating a new message */
export interface MessageCreateInput {
  /** Sender identifier (auto-filled by the transport layer if omitted) */
  fromId?: string;
  /** Sender type (auto-filled by the transport layer if omitted) */
  fromType?: ParticipantType;
  /** Recipient identifier */
  toId: string;
  /** Recipient type */
  toType: ParticipantType;
  /** Message body */
  content: string;
  /** Message category */
  type: MessageType;
  /** Optional extra data */
  metadata?: Record<string, unknown>;
}

/** Filter options for querying messages */
export interface MessageFilter {
  /** Filter by message type */
  type?: MessageType;
  /** Filter by read status */
  read?: boolean;
  /** Maximum number of messages to return */
  limit?: number;
  /** Number of messages to skip (for pagination) */
  offset?: number;
}

/** Mailbox summary for a participant */
export interface Mailbox {
  /** Owner identifier */
  ownerId: string;
  /** Owner type */
  ownerType: ParticipantType;
  /** Number of unread messages */
  unreadCount: number;
  /** Most recent message (if any) */
  lastMessage?: Message;
}
