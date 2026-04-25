import { LogRingBuffer } from "./log-ring-buffer.js";
import type { LogEntry } from "./log-ring-buffer.js";
import type {
  SystemInfo,
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
  activeSection: SectionId = "system";
  // Named `logBuffer` to match what captureConsole tests access via
  // `(tui as unknown as { logBuffer: LogRingBuffer }).logBuffer`.
  logBuffer: LogRingBuffer;
  systemInfo: SystemInfo | null = null;
  taskStats: TaskStats | null = null;
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
    this.logBuffer.push({ ...entry, timestamp: new Date() });
    this.clampSelectedLogIndex(this.getFilteredLogEntries());
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
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.uptimeTimer) {
      clearInterval(this.uptimeTimer);
      this.uptimeTimer = null;
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
