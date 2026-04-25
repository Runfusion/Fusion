// Re-exports that preserve the public API surface of the old dashboard-tui.ts
// so that dashboard.ts (and any tests importing from dashboard-tui.js) need
// only update their import path.

export { DashboardTUI } from "./controller.js";
export { DashboardLogSink, formatConsoleArgs } from "./log-sink.js";
export { LogRingBuffer } from "./log-ring-buffer.js";
export { isTTYAvailable } from "./utils.js";
export type {
  LogEntry,
  SectionId,
  SystemInfo,
  TaskStats,
  SettingsValues,
  UtilityAction,
  TUICallbacks,
  InteractiveData,
  ProjectItem,
  TaskItem,
  GitStatus,
  GitCommit,
  GitCommitDetail,
  GitBranch,
  GitWorktree,
  FileEntry,
  FileReadResult,
  TaskStep,
  TaskLogEntry,
  TaskDetailData,
  TaskEvent,
} from "./state.js";
