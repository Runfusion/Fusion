export const COLUMNS = ["triage", "todo", "in-progress", "in-review", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export interface Task {
  id: string;
  title?: string;
  description: string;
  column: Column;
  dependencies: string[];
  worktree?: string;
  status?: string;
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
  maxConcurrent: number;
  pollIntervalMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  maxConcurrent: 2,
  pollIntervalMs: 15000,
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
  "in-progress": ["in-review"],
  "in-review": ["done", "in-progress"],
  done: [],
};
