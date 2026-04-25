import os from "node:os";
import v8 from "node:v8";
import { LogRingBuffer } from "./log-ring-buffer.js";
import type { LogEntry } from "./log-ring-buffer.js";
import type {
  SystemInfo,
  SystemStats,
  TaskStats,
  SettingsValues,
  TUICallbacks,
  SectionId,
  DashboardState,
  InteractiveData,
  InteractiveView,
} from "./state.js";
import { SECTION_ORDER } from "./state.js";

// ── DashboardTUI ─────────────────────────────────────────────────────────────
//
// Public API is identical to the old imperative class so dashboard.ts requires
// no changes other than the import path. State fields are kept as direct class
// properties (matching the old names) so the test suite can reach them via
// `(tui as any).activeSection` etc. without modification.
//
// The Ink App component subscribes via `subscribe()` / `getSnapshot()` — the
// same pattern as `useSyncExternalStore`.

export class DashboardTUI {
  // State fields mirror the original private layout so tests can access them.
  activeSection: SectionId = "logs";
  // Named `logBuffer` to match what captureConsole tests access via
  // `(tui as unknown as { logBuffer: LogRingBuffer }).logBuffer`.
  logBuffer: LogRingBuffer;
  systemInfo: SystemInfo | null = null;
  taskStats: TaskStats | null = null;
  systemStats: SystemStats | null = null;
  // When set, dashboard.ts refreshes task stats from this project path
  // instead of the launch cwd. Mirrors BoardView's selected project.
  boardScopedProjectPath: string | null = null;
  private boardScopeListener: ((path: string | null) => void) | null = null;
  settings: SettingsValues | null = null;
  callbacks: TUICallbacks | null = null;
  isRunning = false;
  showHelp = false;
  logsSeverityFilter: "all" | LogEntry["level"] = "all";
  logsWrapEnabled = false;
  logsExpandedMode = false;
  selectedLogIndex = 0;
  logsViewportStart = 0;
  loadingStatus = "Starting…";
  mode: "status" | "interactive" = "status";
  interactiveData: InteractiveData | null = null;
  interactiveView: InteractiveView = "board";

  // Subscribers registered by the Ink App component.
  private subscribers: Set<() => void> = new Set();

  // Cached snapshot — useSyncExternalStore compares by Object.is, so we must
  // return the same reference between renders unless state actually changed.
  // notify() invalidates this; getSnapshot() rebuilds on demand.
  private cachedSnapshot: DashboardState | null = null;

  // Ink instance — set when start() is called.
  private inkInstance: { unmount: () => void; waitUntilExit: () => Promise<unknown> } | null = null;

  // Uptime ticker to keep footer time live.
  private uptimeTimer: ReturnType<typeof setInterval> | null = null;
  // System stats sampler — process memory + CPU%.
  private systemStatsTimer: ReturnType<typeof setInterval> | null = null;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuSampleAt = 0;

  constructor() {
    this.logBuffer = new LogRingBuffer();
  }

  // ── Subscription API (for Ink App) ────────────────────────────────────────

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getSnapshot(): DashboardState {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = {
      activeSection: this.activeSection,
      logEntries: this.logBuffer.getAll(),
      systemInfo: this.systemInfo,
      taskStats: this.taskStats,
      systemStats: this.systemStats,
      settings: this.settings,
      callbacks: this.callbacks,
      showHelp: this.showHelp,
      logsSeverityFilter: this.logsSeverityFilter,
      logsWrapEnabled: this.logsWrapEnabled,
      logsExpandedMode: this.logsExpandedMode,
      selectedLogIndex: this.selectedLogIndex,
      logsViewportStart: this.logsViewportStart,
      loadingStatus: this.loadingStatus,
      mode: this.mode,
      interactiveData: this.interactiveData,
      interactiveView: this.interactiveView,
    };
    return this.cachedSnapshot;
  }

  private notify(): void {
    this.cachedSnapshot = null;
    for (const cb of this.subscribers) cb();
  }

  // ── Public API (unchanged from original DashboardTUI) ─────────────────────

  get running(): boolean {
    return this.isRunning;
  }

  setCallbacks(callbacks: TUICallbacks): void {
    this.callbacks = callbacks;
    this.notify();
  }

  setSystemInfo(info: SystemInfo): void {
    this.systemInfo = info;
    this.notify();
  }

  setTaskStats(stats: TaskStats): void {
    this.taskStats = stats;
    this.notify();
  }

  setSystemStats(stats: SystemStats): void {
    this.systemStats = stats;
    this.notify();
  }

  setBoardScopedProjectPath(path: string | null): void {
    if (this.boardScopedProjectPath === path) return;
    this.boardScopedProjectPath = path;
    this.boardScopeListener?.(path);
    this.notify();
  }

  onBoardScopeChange(listener: (path: string | null) => void): () => void {
    this.boardScopeListener = listener;
    return () => {
      if (this.boardScopeListener === listener) this.boardScopeListener = null;
    };
  }

  /** Sample process memory + CPU% in-place. Called from the sampler timer. */
  sampleSystemStats(): void {
    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const now = Date.now();
    const cpu = process.cpuUsage();
    let cpuPercent = 0;
    if (this.lastCpuUsage && this.lastCpuSampleAt > 0) {
      const elapsedMicros = (now - this.lastCpuSampleAt) * 1000;
      if (elapsedMicros > 0) {
        const usedMicros =
          (cpu.user - this.lastCpuUsage.user) +
          (cpu.system - this.lastCpuUsage.system);
        cpuPercent = (usedMicros / elapsedMicros) * 100;
      }
    }
    this.lastCpuUsage = cpu;
    this.lastCpuSampleAt = now;

    const load = os.loadavg();
    this.setSystemStats({
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapLimit: heapStats.heap_size_limit,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      cpuPercent,
      loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      cpuCount: os.cpus().length,
      systemTotalMem: os.totalmem(),
      systemFreeMem: os.freemem(),
      pid: process.pid,
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
    });
  }

  setSettings(settings: SettingsValues): void {
    this.settings = settings;
    this.notify();
  }

  setLoadingStatus(text: string): void {
    this.loadingStatus = text;
    this.notify();
  }

  setInteractiveData(data: InteractiveData): void {
    this.interactiveData = data;
    this.notify();
  }

  setInteractiveView(view: InteractiveView): void {
    this.interactiveView = view;
    this.notify();
  }

  addLog(entry: Omit<LogEntry, "timestamp">): void {
    // If the cursor was sitting on the most recent entry (or there were no
    // entries yet), keep it pinned to the new tail so live logs follow the
    // latest event — same behavior as `tail -f` or k9s.
    const beforeCount = this.getFilteredLogEntries().length;
    const wasAtTail = beforeCount === 0 || this.selectedLogIndex === beforeCount - 1;
    this.logBuffer.push({ ...entry, timestamp: new Date() });
    const after = this.getFilteredLogEntries();
    if (wasAtTail) {
      this.selectedLogIndex = Math.max(0, after.length - 1);
    } else {
      this.clampSelectedLogIndex(after);
    }
    this.notify();
  }

  clearLogs(): void {
    this.logBuffer.clear();
    this.selectedLogIndex = 0;
    this.logsViewportStart = 0;
    this.logsExpandedMode = false;
    this.notify();
  }

  log(message: string, prefix?: string): void {
    this.addLog({ level: "info", message, prefix });
  }

  warn(message: string, prefix?: string): void {
    this.addLog({ level: "warn", message, prefix });
  }

  error(message: string, prefix?: string): void {
    this.addLog({ level: "error", message, prefix });
  }

  // ── State helpers called from Ink App ────────────────────────────────────

  setActiveSection(section: SectionId): void {
    this.activeSection = section;
    this.showHelp = false;
    this.notify();
  }

  setShowHelp(show: boolean): void {
    this.showHelp = show;
    this.notify();
  }

  setLogsWrapEnabled(enabled: boolean): void {
    this.logsWrapEnabled = enabled;
    this.notify();
  }

  setLogsExpandedMode(expanded: boolean): void {
    this.logsExpandedMode = expanded;
    this.notify();
  }

  setSelectedLogIndex(index: number): void {
    const entries = this.getFilteredLogEntries();
    this.selectedLogIndex = this.clampIndex(index, entries.length);
    this.notify();
  }

  setLogsViewportStart(start: number): void {
    this.logsViewportStart = start;
    this.notify();
  }

  setMode(mode: "status" | "interactive"): void {
    this.mode = mode;
    this.notify();
  }

  cycleSection(direction: 1 | -1): void {
    const idx = SECTION_ORDER.indexOf(this.activeSection);
    this.activeSection = SECTION_ORDER[(idx + direction + SECTION_ORDER.length) % SECTION_ORDER.length];
    this.showHelp = false;
    this.notify();
  }

  cycleSeverityFilter(): void {
    const order: Array<"all" | LogEntry["level"]> = ["all", "info", "warn", "error"];
    const idx = order.indexOf(this.logsSeverityFilter);
    this.logsSeverityFilter = order[(idx + 1) % order.length];
    this.clampSelectedLogIndex(this.getFilteredLogEntries());
    this.logsViewportStart = 0;
    this.notify();
  }

  getFilteredLogEntries(): LogEntry[] {
    const all = this.logBuffer.getAll();
    return this.logsSeverityFilter === "all"
      ? all
      : all.filter((e) => e.level === this.logsSeverityFilter);
  }

  async handleUtilityAction(key: string): Promise<void> {
    if (!this.callbacks) return;

    switch (key.toLowerCase()) {
      case "r":
        await this.callbacks.onRefreshStats();
        break;
      case "c":
        this.callbacks.onClearLogs();
        this.clearLogs();
        break;
      case "t":
        if (this.systemInfo) {
          const newPaused = this.systemInfo.engineMode !== "paused";
          const newSettings = await this.callbacks.onTogglePause(newPaused);
          const newEngineMode = newSettings.enginePaused ? "paused" : "active";
          this.setSystemInfo({ ...this.systemInfo, engineMode: newEngineMode });
          this.setSettings(newSettings);
        }
        break;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Dynamic import avoids pulling Ink into non-TTY paths (CI, tests
    // that only exercise pure logic).
    const { render } = await import("ink");
    const { createElement } = await import("react");
    const { DashboardApp } = await import("./app.js");

    this.inkInstance = render(
      createElement(DashboardApp, { controller: this }),
    );

    this.uptimeTimer = setInterval(() => {
      if (this.isRunning) this.notify();
    }, 5000);

    // Prime CPU baseline, then sample every 2s.
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleAt = Date.now();
    this.sampleSystemStats();
    this.systemStatsTimer = setInterval(() => {
      if (this.isRunning) this.sampleSystemStats();
    }, 2000);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.uptimeTimer) {
      clearInterval(this.uptimeTimer);
      this.uptimeTimer = null;
    }

    if (this.systemStatsTimer) {
      clearInterval(this.systemStatsTimer);
      this.systemStatsTimer = null;
    }

    if (this.inkInstance) {
      this.inkInstance.unmount();
      this.inkInstance = null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private clampSelectedLogIndex(entries: LogEntry[]): void {
    if (entries.length === 0) {
      this.selectedLogIndex = 0;
      this.logsExpandedMode = false;
      return;
    }
    if (this.selectedLogIndex >= entries.length) {
      this.selectedLogIndex = entries.length - 1;
    }
    if (this.selectedLogIndex < 0) {
      this.selectedLogIndex = 0;
    }
  }

  private clampIndex(index: number, length: number): number {
    if (length === 0) return 0;
    return Math.max(0, Math.min(index, length - 1));
  }
}
