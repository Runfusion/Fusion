export const COLUMNS = ["triage", "todo", "in-progress", "in-review", "done"] as const;
export type Column = (typeof COLUMNS)[number];

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

/** A single chunk of agent output (text delta or tool invocation) persisted to disk. */
export interface AgentLogEntry {
  /** ISO-8601 timestamp of when the entry was recorded */
  timestamp: string;
  /** The task this log entry belongs to */
  taskId: string;
  /** The text content (delta for "text", tool name for "tool") */
  text: string;
  /** Whether this is a text delta or a tool invocation marker */
  type: "text" | "tool";
  /** For tool entries: human-readable summary of tool args (e.g. file path, command) */
  detail?: string;
}

export interface TaskAttachment {
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
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
  attachments?: TaskAttachment[];
  log: TaskLogEntry[];
  size?: "S" | "M" | "L";
  reviewLevel?: number;
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
  /** Prefix for generated task IDs (e.g. `"HAI"` produces `HAI-001`).
   *  Defaults to `"HAI"`. Only affects new tasks — existing tasks retain
   *  their original IDs. */
  taskPrefix?: string;
  /** When true, merge commit messages include the task ID as the conventional
   *  commit scope (e.g. `feat(HAI-001): ...`). When false, the scope is
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
}

export const DEFAULT_SETTINGS: Settings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: false,
  autoMerge: false,
  worktreeInitCommand: undefined,
  recycleWorktrees: false,
  taskPrefix: undefined,
  includeTaskIdInCommit: true,
  defaultProvider: undefined,
  defaultModelId: undefined,
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
}

export const COLUMN_LABELS: Record<Column, string> = {
  triage: "Triage",
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
};

export const COLUMN_DESCRIPTIONS: Record<Column, string> = {
  triage: "Raw ideas — AI will specify these",
  todo: "Specified and ready to start",
  "in-progress": "AI is working on this in a worktree",
  "in-review": "Complete — ready to merge",
  done: "Merged and closed",
};

export const VALID_TRANSITIONS: Record<Column, Column[]> = {
  triage: ["todo"],
  todo: ["in-progress", "triage"],
  "in-progress": ["in-review", "todo"],
  "in-review": ["done", "in-progress"],
  done: [],
};
