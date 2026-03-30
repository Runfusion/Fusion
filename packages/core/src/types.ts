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
  "berry",
  "monochrome",
  "high-contrast",
  "solarized",
] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number];

export type PrStatus = "open" | "closed" | "merged";

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

export interface Task {
  id: string;
  title?: string;
  description: string;
  column: Column;
  dependencies: string[];
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
  attachments?: TaskAttachment[];
  steeringComments?: SteeringComment[];
  /** PR information for tasks linked to GitHub pull requests */
  prInfo?: PrInfo;
  /** Issue information for tasks imported from GitHub issues */
  issueInfo?: IssueInfo;
  log: TaskLogEntry[];
  size?: "S" | "M" | "L";
  reviewLevel?: number;
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
  /** Number of merge retry attempts made for this task (auto-merge conflict recovery) */
  mergeRetries?: number;
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
}

export interface Settings {
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
  /** Whether GitHub token is configured for PR operations (read-only, set by server).
   *  When false, PR creation features are disabled in the UI. */
  githubTokenConfigured?: boolean;
  /** When true, merge commit messages include the task ID as the conventional
   *  commit scope (e.g. `feat(KB-001): ...`). When false, the scope is
   *  omitted (e.g. `feat: ...`). Default: true. */
  includeTaskIdInCommit?: boolean;
  /** Default AI model provider name (e.g. `"anthropic"`, `"openai"`).
   *  Must be set together with `defaultModelId`. When both are undefined,
   *  the engine uses pi's automatic model resolution. */
  defaultProvider?: string;
  /** Default AI model ID within the provider (e.g. `"claude-sonnet-4-5"`).
   *  Must be set together with `defaultProvider`. When both are undefined,
   *  the engine uses pi's automatic model resolution. */
  defaultModelId?: string;
  /** Default thinking effort level for AI agent sessions.
   *  Controls how much reasoning effort the model uses — higher levels
   *  produce better results but cost more. When undefined, the engine
   *  uses the model's default thinking level. */
  defaultThinkingLevel?: ThinkingLevel;
  /** When true, auto-merge will automatically resolve common conflict patterns
   *  (lock files, generated files, trivial conflicts) without requiring AI
   *  intervention. When AI resolution fails, the system will retry with escalating
   *  strategies. Default: true. */
  autoResolveConflicts?: boolean;
  /** Alias for autoResolveConflicts. When true, enables automatic resolution of
   *  lock files (ours), generated files (theirs), and trivial whitespace conflicts
   *  without spawning an AI agent. Default: true. */
  smartConflictResolution?: boolean;
  /** When enabled, AI-generated task specifications require manual approval
   *  before the task can move from triage to todo. Tasks with approved specs
   *  remain in triage with status "awaiting-approval" until a user approves
   *  or rejects the plan. Default: false. */
  requirePlanApproval?: boolean;
  /** ntfy.sh topic name for push notifications. When set along with ntfyEnabled,
   *  notifications are sent to https://ntfy.sh/{topic} when tasks complete or fail. */
  ntfyTopic?: string;
  /** When true, enables ntfy.sh push notifications for task completion and failures.
   *  Requires ntfyTopic to be set. Default: false. */
  ntfyEnabled?: boolean;
  /** Theme mode preference: dark, light, or system (follows OS). Default: "dark". */
  themeMode?: ThemeMode;
  /** Color theme preference for accent colors and styling. Default: "default". */
  colorTheme?: ColorTheme;
}

export const DEFAULT_SETTINGS: Settings = {
  globalPause: false,
  enginePaused: false,
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: false,
  autoMerge: true,
  worktreeInitCommand: undefined,
  recycleWorktrees: false,
  worktreeNaming: "random",
  taskPrefix: undefined,
  includeTaskIdInCommit: true,
  defaultProvider: undefined,
  defaultModelId: undefined,
  defaultThinkingLevel: undefined,
  autoResolveConflicts: true,
  smartConflictResolution: true,
  requirePlanApproval: false,
  ntfyEnabled: false,
  ntfyTopic: undefined,
  themeMode: "dark",
  colorTheme: "default",
};

export interface BoardConfig {
  nextId: number;
  settings?: Settings;
}

export interface MergeResult {
  task: Task;
  branch: string;
  merged: boolean;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  error?: string;
  /** Strategy that successfully resolved the merge, if any */
  resolutionStrategy?: "ai" | "auto-resolve" | "theirs";
  /** Alias for resolutionStrategy — how conflicts were resolved (for metrics/debugging) */
  resolutionMethod?: "ai" | "auto" | "mixed" | "theirs";
  /** Number of retry attempts made (1 = first attempt succeeded, 2-3 = retries needed) */
  attemptsMade?: 1 | 2 | 3;
  /** Number of files auto-resolved (for tracking mixed resolution scenarios) */
  autoResolvedCount?: number;
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
  "in-review": ["done", "in-progress"],
  done: ["archived"],
  archived: ["done"],
};
