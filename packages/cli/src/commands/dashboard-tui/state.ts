import type { LogEntry } from "./log-ring-buffer.js";

// ── Public types shared across the whole dashboard-tui module ─────────────────

export type { LogEntry };

export type SectionId = "logs" | "system" | "utilities" | "stats" | "settings";

export type AppMode = "status" | "interactive";

export type InteractiveView = "board" | "agents" | "settings";

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

export interface SettingsValues {
  maxConcurrent: number;
  maxWorktrees: number;
  autoMerge: boolean;
  mergeStrategy: string;
  pollIntervalMs: number;
  enginePaused: boolean;
  globalPause: boolean;
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

export interface InteractiveData {
  listProjects: () => Promise<ProjectItem[]>;
  listTasks: (projectPath: string) => Promise<TaskItem[]>;
  listAgents: () => Promise<AgentItem[]>;
  getAgentDetail: (id: string) => Promise<AgentDetailItem | null>;
  updateAgentState: (id: string, state: string) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  getSettings: () => Promise<SettingsValues>;
  updateSettings: (partial: Partial<SettingsValues>) => Promise<void>;
  listModels: () => ModelItem[];
}

// ── Dashboard state (mutable, shared between controller and App) ───────────────

export interface DashboardState {
  activeSection: SectionId;
  logEntries: LogEntry[];
  systemInfo: SystemInfo | null;
  taskStats: TaskStats | null;
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
}

export const SECTION_ORDER: SectionId[] = ["system", "logs", "utilities", "stats", "settings"];

export function createInitialState(): DashboardState {
  return {
    activeSection: "system",
    logEntries: [],
    systemInfo: null,
    taskStats: null,
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
  };
}
