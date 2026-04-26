import type { LogEntry } from "./log-ring-buffer.js";

// ── Public types shared across the whole dashboard-tui module ─────────────────

export type { LogEntry };

export type SectionId = "logs" | "system" | "utilities" | "stats" | "settings";

export type AppMode = "status" | "interactive";

export type InteractiveView = "board" | "agents" | "settings" | "git" | "files";

export interface SystemInfo {
  host: string;
  port: number;
  baseUrl: string;
  authEnabled: boolean;
  authToken?: string;
  tokenizedUrl?: string;
  engineMode: "dev" | "active" | "paused";
  fileWatcher: boolean;
  startTimeMs: number;
}

export interface TaskStats {
  total: number;
  byColumn: Record<string, number>;
  active: number;
  agents: {
    idle: number;
    active: number;
    running: number;
    error: number;
  };
}

export interface SystemStats {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  heapLimit: number;
  external: number;
  arrayBuffers: number;
  cpuPercent: number;
  loadAvg: [number, number, number];
  cpuCount: number;
  systemTotalMem: number;
  systemFreeMem: number;
  pid: number;
  nodeVersion: string;
  platform: string;
}

export type RemoteProvider = "tailscale" | "cloudflare";

export interface RemoteStatus {
  provider: RemoteProvider | null;
  state: "stopped" | "starting" | "running" | "error";
  url: string | null;
  lastError: string | null;
}

export interface RemoteTokenResult {
  token?: string;
  maskedToken?: string;
  tokenType: "persistent" | "short-lived";
  expiresAt: string | null;
}

export interface RemoteQrPayload {
  url: string;
  expiresAt: string | null;
  format: "text" | "image/svg";
  data?: string;
}

export interface RemoteSettingsSnapshot {
  remoteEnabled: boolean;
  activeProvider: RemoteProvider | null;
  tailscaleEnabled: boolean;
  cloudflareEnabled: boolean;
  shortLivedEnabled: boolean;
  shortLivedTtlMs: number;
}

export interface SettingsValues {
  maxConcurrent: number;
  maxWorktrees: number;
  autoMerge: boolean;
  mergeStrategy: string;
  pollIntervalMs: number;
  enginePaused: boolean;
  globalPause: boolean;
  remoteEnabled: boolean;
  remoteActiveProvider: RemoteProvider | null;
  remoteShortLivedEnabled: boolean;
  remoteShortLivedTtlMs: number;
  remoteSettingsSnapshot?: RemoteSettingsSnapshot;
  remoteStatus?: RemoteStatus;
}

export interface UtilityAction {
  id: string;
  label: string;
  key: string;
  description: string;
}

export interface TUICallbacks {
  onRefreshStats: () => Promise<void>;
  onClearLogs: () => void;
  onTogglePause: (paused: boolean) => Promise<SettingsValues>;
  /** Persist vitest memory-guard settings to global settings so they
   *  survive across dashboard restarts. Optional — when undefined, the
   *  controller treats them as session-local. */
  onPersistVitestKillSettings?: (
    partial: { enabled?: boolean; thresholdPct?: number },
  ) => Promise<void>;
}

// Slim project shape used by interactive mode
export interface ProjectItem {
  id: string;
  name: string;
  path: string;
}

// Slim task shape used by interactive mode
export interface TaskItem {
  id: string;
  title?: string;
  description: string;
  column: string;
  agentState?: string;
}

// Slim agent shape for Agents view list
export interface AgentItem {
  id: string;
  name: string;
  state: string;
  role: string;
  taskId?: string;
  lastHeartbeatAt?: string;
}

// Slim heartbeat run for agent detail
export interface AgentRunItem {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  triggerDetail?: string;
  invocationSource?: string;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  resultJson?: Record<string, unknown>;
  // Optional synthetic log lines for tests / alternate data providers.
  logs?: string[];
}

// Slim agent detail shape for Agents view detail panel
export interface AgentDetailItem extends AgentItem {
  title?: string;
  capabilities: string[];
  recentRuns: AgentRunItem[];
}

// Slim model shape for Settings view models subsection
export interface ModelItem {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
}

// ── File explorer types ───────────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  path: string; // relative to project root
  isDirectory: boolean;
  size: number; // bytes; 0 for dirs
  modifiedAt: string; // ISO
}

export interface FileReadResult {
  content: string | null; // null if binary or too-large
  isBinary: boolean;
  tooLarge: boolean;
  size: number;
  modifiedAt: string;
  lineCount: number;
}

// ── Task detail + streaming types ────────────────────────────────────────────

export interface TaskStep {
  index: number;
  name: string;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  startedAt?: string;
  endedAt?: string;
}

export interface TaskLogEntry {
  timestamp: string; // ISO-8601
  level: "info" | "warn" | "error" | "debug";
  text: string;
  source?: string; // e.g. "executor" / "agent" / step name
}

export interface TaskDetailData {
  id: string;
  title?: string;
  description: string;
  column: string;
  agentState?: string;
  branch?: string;
  worktree?: string;
  currentStepIndex?: number;
  steps: TaskStep[];
  recentLogs: TaskLogEntry[]; // last ~200 entries on initial load
}

export type TaskEvent =
  | { kind: "step:updated"; step: TaskStep }
  | { kind: "log:appended"; entry: TaskLogEntry }
  | { kind: "task:updated"; task: TaskDetailData };

// ── Git view types ────────────────────────────────────────────────────────────

export interface GitStatus {
  branch: string;
  detached: boolean;
  ahead: number;
  behind: number;
  staged: Array<{ status: string; path: string }>;
  unstaged: Array<{ status: string; path: string }>;
  untracked: Array<{ path: string }>;
  remoteUrl: string;
  lastFetchAt: number | null;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  relativeTime: string;
  isoTime: string;
}

export interface GitCommitDetail extends GitCommit {
  body: string;
  stat: string;
}

export interface GitBranch {
  name: string;
  shortSha: string;
  relativeTime: string;
  isCurrent: boolean;
  upstreamTrack: string;
}

export interface GitWorktree {
  path: string;
  branch: string;
  sha: string;
  isCurrent: boolean;
  isLocked: boolean;
}

export interface InteractiveData {
  listProjects: () => Promise<ProjectItem[]>;
  listTasks: (projectPath: string) => Promise<TaskItem[]>;
  createTask: (projectPath: string, input: { title: string; description?: string }) => Promise<TaskItem>;
  listAgents: () => Promise<AgentItem[]>;
  getAgentDetail: (id: string) => Promise<AgentDetailItem | null>;
  updateAgentState: (id: string, state: string) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  getSettings: () => Promise<SettingsValues>;
  updateSettings: (partial: Partial<SettingsValues>) => Promise<void>;
  listModels: () => ModelItem[];
  remote: {
    getSettings: () => Promise<RemoteSettingsSnapshot>;
    getStatus: () => Promise<RemoteStatus>;
    activateProvider: (provider: RemoteProvider) => Promise<void>;
    startTunnel: () => Promise<void>;
    stopTunnel: () => Promise<void>;
    regeneratePersistentToken: () => Promise<RemoteTokenResult>;
    generateShortLivedToken: (ttlMs: number) => Promise<RemoteTokenResult>;
    getRemoteUrl: (tokenType: "persistent" | "short-lived", ttlMs?: number) => Promise<{ url: string; tokenType: "persistent" | "short-lived"; expiresAt: string | null }>;
    getQrPayload: (tokenType: "persistent" | "short-lived", ttlMs?: number) => Promise<RemoteQrPayload>;
  };
  git: {
    getStatus: (projectPath: string) => Promise<GitStatus>;
    listCommits: (projectPath: string, limit?: number) => Promise<GitCommit[]>;
    showCommit: (projectPath: string, sha: string) => Promise<GitCommitDetail>;
    listBranches: (projectPath: string) => Promise<GitBranch[]>;
    listWorktrees: (projectPath: string) => Promise<GitWorktree[]>;
    push: (projectPath: string) => Promise<{ success: boolean; output: string }>;
    fetch: (projectPath: string) => Promise<{ success: boolean; output: string }>;
  };
  files: {
    listDirectory: (projectPath: string, relativePath: string) => Promise<FileEntry[]>;
    readFile: (projectPath: string, relativePath: string) => Promise<FileReadResult>;
  };
  tasks: {
    // Initial fetch when the detail screen mounts — includes steps + recent logs.
    getTaskDetail: (projectPath: string, taskId: string) => Promise<TaskDetailData | null>;
    // Subscribe to live step-change and log-append events for a single task.
    // Returns an unsubscribe function.
    subscribeTaskEvents: (
      projectPath: string,
      taskId: string,
      handler: (event: TaskEvent) => void,
    ) => () => void;
  };
}

// ── Dashboard state (mutable, shared between controller and App) ───────────────

export interface DashboardState {
  activeSection: SectionId;
  logEntries: LogEntry[];
  systemInfo: SystemInfo | null;
  taskStats: TaskStats | null;
  systemStats: SystemStats | null;
  settings: SettingsValues | null;
  callbacks: TUICallbacks | null;
  showHelp: boolean;
  logsSeverityFilter: "all" | LogEntry["level"];
  logsWrapEnabled: boolean;
  logsExpandedMode: boolean;
  selectedLogIndex: number;
  logsViewportStart: number;
  loadingStatus: string;
  mode: AppMode;
  interactiveData: InteractiveData | null;
  interactiveView: InteractiveView;
  interactiveInputLocked: boolean;
  autoKillVitestOnPressure: boolean;
  vitestKillThreshold: number;
}

export const SECTION_ORDER: SectionId[] = ["system", "logs", "utilities", "stats", "settings"];

export function createInitialState(): DashboardState {
  return {
    activeSection: "logs",
    logEntries: [],
    systemInfo: null,
    taskStats: null,
    systemStats: null,
    settings: null,
    callbacks: null,
    showHelp: false,
    logsSeverityFilter: "all",
    logsWrapEnabled: false,
    logsExpandedMode: false,
    selectedLogIndex: 0,
    logsViewportStart: 0,
    loadingStatus: "Starting…",
    mode: "status",
    interactiveData: null,
    interactiveView: "board",
    interactiveInputLocked: false,
    autoKillVitestOnPressure: true,
    vitestKillThreshold: 0.9,
  };
}
