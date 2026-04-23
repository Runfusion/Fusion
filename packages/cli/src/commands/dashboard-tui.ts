/**
 * Dashboard TUI Renderer
 *
 * An interactive terminal user interface for `fn dashboard` with five sections:
 * - logs: real-time log entries with ring buffer
 * - system: host, port, URL, auth mode, token, engine mode
 * - utilities: action list with keybindings
 * - stats: task counts, active task count, agent state counts
 * - settings: real key/value settings from TaskStore
 *
 * Uses pure Node.js + ANSI escape sequences (no external TUI libraries).
 * Activates only in TTY mode; falls back to plain console in non-TTY.
 */

import * as readline from "node:readline";

// ── Types ────────────────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: Date;
  level: "info" | "warn" | "error";
  message: string;
  prefix?: string;
}

export type SectionId = "logs" | "system" | "utilities" | "stats" | "settings";

export interface SystemInfo {
  host: string;
  port: number;
  baseUrl: string;
  authEnabled: boolean;
  authToken?: string;
  tokenizedUrl?: string;
  engineMode: "dev" | "active" | "paused";
  fileWatcher: boolean;
  startTimeMs: number; // Used to compute live uptime at render time
}

export interface TaskStats {
  total: number;
  byColumn: Record<string, number>;
  active: number; // in-progress + in-review
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

// ── Ring Buffer ───────────────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 1000;

export class LogRingBuffer {
  private entries: LogEntry[] = [];
  private count = 0;

  push(entry: LogEntry): void {
    if (this.entries.length < MAX_LOG_ENTRIES) {
      this.entries.push(entry);
    } else {
      // Overwrite oldest entry in circular fashion
      this.entries[this.count % MAX_LOG_ENTRIES] = entry;
    }
    this.count++;
  }

  getAll(): LogEntry[] {
    if (this.count <= MAX_LOG_ENTRIES) {
      return this.entries.slice();
    }
    // Return entries in chronological order (oldest to newest)
    const start = this.count % MAX_LOG_ENTRIES;
    return [
      ...this.entries.slice(start),
      ...this.entries.slice(0, start),
    ];
  }

  clear(): void {
    this.entries = [];
    this.count = 0;
  }

  get total(): number {
    return this.count;
  }
}

// ── Escape Sequence Helpers ───────────────────────────────────────────────────

function moveCursorTo(x: number, y: number): void {
  process.stdout.write(`\x1b[${y};${x}H`);
}

function clearLine(): void {
  process.stdout.write("\x1b[2K");
}

function clearScreen(): void {
  process.stdout.write("\x1b[2J");
}

function hideCursor(): void {
  process.stdout.write("\x1b[?25l");
}

function showCursor(): void {
  process.stdout.write("\x1b[?25h");
}

function enableAlternateScreen(): void {
  process.stdout.write("\x1b[?47h");
}

function disableAlternateScreen(): void {
  process.stdout.write("\x1b[?47l");
}

// ── Color helpers ───────────────────────────────────────────────────────────────

function colorize(text: string, color: string): string {
  const colors: Record<string, string> = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    gray: "\x1b[90m",
    brightRed: "\x1b[91m",
    brightGreen: "\x1b[92m",
    brightYellow: "\x1b[93m",
    brightBlue: "\x1b[94m",
    brightMagenta: "\x1b[95m",
    brightCyan: "\x1b[96m",
  };
  return `${colors[color] || ""}${text}${colors.reset}`;
}

// ── Format helpers ─────────────────────────────────────────────────────────────

function formatTimestamp(date: Date): string {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  const s = date.getSeconds().toString().padStart(2, "0");
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Calculate visible width of a string by stripping ANSI escape sequences.
 */
function visibleLength(str: string): number {
  // Strip ANSI escape sequences (CSI sequences: ESC [ ... letter)
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").length;
}

/**
 * Truncate a string to a maximum visible width, accounting for ANSI escape sequences.
 * The returned string includes any ANSI sequences from the original.
 */
function visibleTruncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const currentLength = visibleLength(text);
  if (currentLength <= maxWidth) return text;

  // If the string is longer than maxWidth, we need to truncate the visible content
  // while preserving ANSI sequences. We do this by finding where to cut.
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[[0-9;]*[a-zA-Z]/g;
  let result = "";
  let visibleCount = 0;

  // Find all ANSI sequences and their positions
  let match;
  const ansiMatches: Array<{ start: number; end: number; seq: string }> = [];
  while ((match = ansiRegex.exec(text)) !== null) {
    ansiMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      seq: match[0],
    });
  }

  // Build result by iterating through text, counting visible chars, preserving ANSI
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Check if we're at an ANSI sequence
    const ansiMatch = ansiMatches.find((m) => m.start === i);
    if (ansiMatch) {
      result += ansiMatch.seq;
      // Don't count ANSI chars in visible width
      continue;
    }

    // Regular character - count it
    visibleCount++;
    result += char;

    // If we've reached the limit (minus space for ellipsis)
    if (visibleCount >= maxWidth - 3) {
      break;
    }
  }

  // Add ellipsis if we truncated
  if (visibleCount >= maxWidth - 3 && visibleCount < currentLength) {
    result += "...";
  }

  return result;
}

// ── Dashboard TUI Renderer ───────────────────────────────────────────────────

const SECTION_ORDER: SectionId[] = ["logs", "system", "utilities", "stats", "settings"];

export class DashboardTUI {
  private activeSection: SectionId = "logs";
  private logBuffer: LogRingBuffer;
  private systemInfo: SystemInfo | null = null;
  private taskStats: TaskStats | null = null;
  private settings: SettingsValues | null = null;
  private callbacks: TUICallbacks | null = null;
  private isRunning = false;
  private rl: readline.Interface | null = null;
  private originalHandlers: Map<NodeJS.Signals, NodeJS.SignalsListener> = new Map();
  private lastRenderHeight = 0;
  private showHelp = false;
  private uptimeTimer: ReturnType<typeof setInterval> | null = null;
  private resizeHandler: (() => void) | null = null;

  constructor() {
    this.logBuffer = new LogRingBuffer();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns whether the TUI is currently running */
  get running(): boolean {
    return this.isRunning;
  }

  setCallbacks(callbacks: TUICallbacks): void {
    this.callbacks = callbacks;
  }

  setSystemInfo(info: SystemInfo): void {
    this.systemInfo = info;
    this.render();
  }

  setTaskStats(stats: TaskStats): void {
    this.taskStats = stats;
    this.render();
  }

  setSettings(settings: SettingsValues): void {
    this.settings = settings;
    this.render();
  }

  addLog(entry: Omit<LogEntry, "timestamp">): void {
    this.logBuffer.push({
      ...entry,
      timestamp: new Date(),
    });
    this.render();
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

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Set up raw terminal mode
    enableAlternateScreen();
    hideCursor();

    // Save original signal handlers
    this.saveSignalHandlers();

    // Create readline interface for key input
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Enable raw mode for stdin
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    // Enable keypress events on stdin and handle raw input
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", (str, key) => {
      // Normalize input - use the string character if available, otherwise derive from key
      if (str) {
        this.handleKeypress(str);
      } else if (key.ctrl && key.name === "c") {
        this.handleKeypress("\x03"); // Ctrl+C
      } else if (key.name === "right") {
        this.handleKeypress("\x1b[C");
      } else if (key.name === "left") {
        this.handleKeypress("\x1b[D");
      } else if (key.name === "up") {
        this.handleKeypress("\x1b[A");
      } else if (key.name === "down") {
        this.handleKeypress("\x1b[B");
      } else if (key.name === "escape") {
        this.handleKeypress("\x1b");
      }
    });

    // Start uptime timer to keep footer live (every 5 seconds)
    this.uptimeTimer = setInterval(() => {
      if (this.isRunning) {
        this.renderFooter();
      }
    }, 5000);

    // Handle terminal resize - full re-render when size changes
    this.resizeHandler = () => {
      if (this.isRunning) {
        this.render();
      }
    };
    process.stdout.on("resize", this.resizeHandler);

    // Initial render
    this.render();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    // Stop uptime timer
    if (this.uptimeTimer) {
      clearInterval(this.uptimeTimer);
      this.uptimeTimer = null;
    }

    // Remove resize listener
    if (this.resizeHandler) {
      process.stdout.off("resize", this.resizeHandler);
      this.resizeHandler = null;
    }

    // Restore terminal state
    this.restoreTerminal();

    // Restore signal handlers
    this.restoreSignalHandlers();

    // Clean up readline
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  // ── Private: Signal Handling ───────────────────────────────────────────────

  private saveSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const sig of signals) {
      const listeners = process.listeners(sig);
      if (listeners.length > 0) {
        // Store only the last listener (our handler should be first)
        this.originalHandlers.set(sig, listeners[listeners.length - 1]);
      }
    }
  }

  private restoreSignalHandlers(): void {
    // Restore any signal handlers that were saved before raw mode
    for (const [sig, handler] of this.originalHandlers) {
      process.on(sig, handler);
    }
    this.originalHandlers.clear();
  }

  // ── Private: Terminal Restoration ────────────────────────────────────────

  private restoreTerminal(): void {
    showCursor();
    disableAlternateScreen();
    process.stdout.write("\n");
    process.stdin.pause?.();
    process.stdin.setRawMode?.(false);
  }

  // ── Private: Key Handling ────────────────────────────────────────────────

  private handleKeypress(key: string): void {
    // Handle Ctrl+C
    if (key === "\x03") {
      void this.stop();
      process.exit(0);
      return;
    }

    // Handle 'q' to quit
    if (key === "q" || key === "Q") {
      void this.stop();
      process.exit(0);
      return;
    }

    // Toggle help with '?' or 'h'
    if (key === "?" || key === "h" || key === "H") {
      this.showHelp = !this.showHelp;
      this.render();
      return;
    }

    // Number keys 1-5 to switch tabs
    if (key >= "1" && key <= "5") {
      const index = parseInt(key, 10) - 1;
      if (index >= 0 && index < SECTION_ORDER.length) {
        this.activeSection = SECTION_ORDER[index];
        this.showHelp = false;
        this.render();
      }
      return;
    }

    // Arrow right or 'n' for next tab
    if (key === "\x1b[C" || key === "n" || key === "N") {
      const currentIndex = SECTION_ORDER.indexOf(this.activeSection);
      this.activeSection = SECTION_ORDER[(currentIndex + 1) % SECTION_ORDER.length];
      this.showHelp = false;
      this.render();
      return;
    }

    // Arrow left or 'p' for previous tab
    if (key === "\x1b[D" || key === "p" || key === "P") {
      const currentIndex = SECTION_ORDER.indexOf(this.activeSection);
      this.activeSection = SECTION_ORDER[(currentIndex - 1 + SECTION_ORDER.length) % SECTION_ORDER.length];
      this.showHelp = false;
      this.render();
      return;
    }

    // Utility actions based on active section
    if (this.activeSection === "utilities") {
      this.handleUtilityKeypress(key);
    }
  }

  private async handleUtilityKeypress(key: string): Promise<void> {
    if (!this.callbacks) return;

    switch (key.toLowerCase()) {
      case "r": // Refresh stats
        await this.callbacks.onRefreshStats();
        break;
      case "c": // Clear logs
        this.callbacks.onClearLogs();
        this.logBuffer.clear();
        this.render();
        break;
      case "t": // Toggle pause
        if (this.systemInfo) {
          const newPaused = this.systemInfo.engineMode !== "paused";
          const newSettings = await this.callbacks.onTogglePause(newPaused);
          // Sync TUI state after pause toggle to keep all panels consistent
          const newEngineMode = newSettings.enginePaused ? "paused" : "active";
          this.setSystemInfo({ ...this.systemInfo, engineMode: newEngineMode });
          this.setSettings(newSettings);
        }
        break;
    }
  }

  // ── Private: Rendering ───────────────────────────────────────────────────

  private render(): void {
    if (!this.isRunning) return;

    clearScreen();
    moveCursorTo(1, 1);

    // Render header with tabs
    this.renderHeader();

    // Render active section content
    this.renderSection();

    // Render footer
    this.renderFooter();

    // Render help overlay if active
    if (this.showHelp) {
      this.renderHelpOverlay();
    }
  }

  private renderHeader(): void {
    const cols = process.stdout.columns || 80;
    const title = colorize("  fusion  ", "cyan");
    const titleLen = visibleLength(title);

    process.stdout.write(title);

    // Responsive header modes based on terminal width:
    // - Wide (>= 70 cols): Full labels "[1] Logs [2] System [3] Utilities [4] Stats [5] Settings"
    // - Medium (>= 40 cols): Short labels "[1] L [2] S [3] U [4] St [5] Se"
    // - Narrow (< 40 cols): Only active tab with navigation hint "[n/p] Previous/Next"

    if (cols >= 70) {
      // Full labels for wide terminals
      for (let i = 0; i < SECTION_ORDER.length; i++) {
        const section = SECTION_ORDER[i];
        const isActive = section === this.activeSection;
        const num = (i + 1).toString();
        const label = section.charAt(0).toUpperCase() + section.slice(1);
        const tabText = `[${num}] ${label}`;
        const style = isActive ? "brightBlue" : "dim";
        process.stdout.write(colorize(` ${tabText} `, style));
      }
    } else if (cols >= 40) {
      // Short labels for medium terminals
      const shortLabels: Record<SectionId, string> = {
        logs: "L",
        system: "S",
        utilities: "U",
        stats: "St",
        settings: "Se",
      };
      for (let i = 0; i < SECTION_ORDER.length; i++) {
        const section = SECTION_ORDER[i];
        const isActive = section === this.activeSection;
        const num = (i + 1).toString();
        const shortLabel = shortLabels[section];
        const tabText = `[${num}]${shortLabel}`;
        const style = isActive ? "brightBlue" : "dim";
        process.stdout.write(colorize(` ${tabText} `, style));
      }
    } else {
      // Very narrow: show active tab with navigation hint only
      const activeIndex = SECTION_ORDER.indexOf(this.activeSection);
      const activeLabel = this.activeSection.charAt(0).toUpperCase() + this.activeSection.slice(1);
      process.stdout.write(colorize(` [${activeIndex + 1}]${activeLabel} `, "brightBlue"));
      process.stdout.write(colorize(" [n/p]nav ", "dim"));
    }

    // Fill rest of line - use visibleLength to account for ANSI escape sequences
    const tabsLength = SECTION_ORDER.reduce((acc, s, i) => {
      let label: string;
      if (cols >= 70) {
        label = s.charAt(0).toUpperCase() + s.slice(1);
      } else if (cols >= 40) {
        const shortLabels: Record<SectionId, string> = {
          logs: "L",
          system: "S",
          utilities: "U",
          stats: "St",
          settings: "Se",
        };
        label = shortLabels[s];
      } else {
        label = s.charAt(0).toUpperCase() + s.slice(1);
      }
      const tabText = `[${i + 1}]${label} `;
      return acc + tabText.length;
    }, 0);
    const headerLen = titleLen + tabsLength;

    const remaining = cols - headerLen;
    if (remaining > 0) {
      process.stdout.write(" ".repeat(remaining));
    }

    process.stdout.write("\n");
    // Use full terminal width for the divider (with a safe minimum of 20)
    process.stdout.write(colorize("─".repeat(Math.max(20, cols)), "dim") + "\n");
  }

  private renderSection(): void {
    switch (this.activeSection) {
      case "logs":
        this.renderLogsSection();
        break;
      case "system":
        this.renderSystemSection();
        break;
      case "utilities":
        this.renderUtilitiesSection();
        break;
      case "stats":
        this.renderStatsSection();
        break;
      case "settings":
        this.renderSettingsSection();
        break;
    }
  }

  private renderLogsSection(): void {
    const cols = process.stdout.columns || 80;
    const entries = this.logBuffer.getAll();
    // Clamp to minimum 1 row to handle very small terminals.
    // Reserve 9 rows for fixed UI chrome (header, section labels/spacers, footer)
    // so content never overlaps the footer on short terminals.
    const maxRows = Math.max(1, (process.stdout.rows ?? 38) - 9);

    process.stdout.write(colorize("\n  LOGS\n", "bold"));
    process.stdout.write(colorize(`  Ring buffer: ${this.logBuffer.total}/${MAX_LOG_ENTRIES} entries\n\n`, "dim"));

    if (entries.length === 0) {
      process.stdout.write(colorize("  No log entries yet.\n", "dim"));
      return;
    }

    // Show most recent entries first (reverse chronological)
    const displayEntries = entries.slice(-maxRows).reverse();
    for (const entry of displayEntries) {
      const ts = colorize(formatTimestamp(entry.timestamp), "dim");
      const prefix = entry.prefix ? colorize(`[${entry.prefix}]`, "gray") : "";
      const levelChar = entry.level === "error" ? colorize("✗", "brightRed")
        : entry.level === "warn" ? colorize("⚠", "brightYellow")
        : colorize("✓", "brightGreen");

      // Clamp message width to prevent negative truncation on narrow terminals
      const messageWidth = Math.max(8, cols - 40);
      // Use visibleTruncate to handle ANSI sequences in log messages
      const message = visibleTruncate(entry.message, messageWidth);
      const line = `  ${ts} ${levelChar} ${prefix ? prefix + " " : ""}${message}`;

      process.stdout.write(visibleTruncate(line, cols - 1) + "\n");
    }
  }

  private renderSystemSection(): void {
    if (!this.systemInfo) {
      process.stdout.write(colorize("\n  System information not available.\n", "dim"));
      return;
    }

    const cols = process.stdout.columns || 80;
    const info = this.systemInfo;
    const rows: string[] = [];

    rows.push(colorize("\n  SYSTEM INFORMATION\n", "bold"));
    rows.push("");

    // Calculate available width for value fields (accounting for label + padding)
    const labelWidth = 12; // "  XXXX:" + space = 12 chars
    const availableValueWidth = Math.max(8, cols - labelWidth - 1);

    rows.push(`  ${colorize("Host:", "white")} ${info.host}`);
    rows.push(`  ${colorize("Port:", "white")} ${info.port}`);
    rows.push(`  ${colorize("URL:", "white")} ${colorize(visibleTruncate(info.baseUrl, availableValueWidth), "brightCyan")}`);
    rows.push("");

    if (info.authEnabled) {
      rows.push(`  ${colorize("Auth:", "white")} ${colorize("bearer token required", "yellow")}`);
      if (info.authToken) {
        rows.push(`  ${colorize("Token:", "white")} ${visibleTruncate(info.authToken, availableValueWidth)}`);
      }
      if (info.tokenizedUrl) {
        rows.push(`  ${colorize("Open:", "white")} ${visibleTruncate(info.tokenizedUrl, availableValueWidth)}`);
        rows.push(colorize("  (browser stores token, click once)", "dim"));
      }
    } else {
      rows.push(`  ${colorize("Auth:", "white")} ${colorize("disabled (--no-auth)", "dim")}`);
    }

    rows.push("");
    rows.push(`  ${colorize("AI Engine:", "white")} ${
      info.engineMode === "dev" ? colorize("✗ disabled (dev mode)", "yellow")
      : info.engineMode === "paused" ? colorize("⏸ paused", "brightYellow")
      : colorize("✓ active", "brightGreen")
    }`);
    rows.push(`  ${colorize("File Watcher:", "white")} ${
      info.fileWatcher
        ? colorize("✓ active", "brightGreen")
        : colorize("✗ inactive", "brightRed")
    }`);
    rows.push(`  ${colorize("Uptime:", "white")} ${formatUptime(Date.now() - info.startTimeMs)}`);

    // Print rows with width-aware truncation for each line
    for (const row of rows) {
      process.stdout.write(visibleTruncate(row, cols) + "\n");
    }
  }

  private renderUtilitiesSection(): void {
    const cols = process.stdout.columns || 80;
    const actions: UtilityAction[] = [
      { id: "refresh", label: "Refresh Stats", key: "r", description: "Re-fetch task and agent counts" },
      { id: "clear", label: "Clear Logs", key: "c", description: "Clear the log ring buffer" },
      { id: "pause", label: "Toggle Engine Pause", key: "t", description: "Pause/resume AI engine automation" },
      { id: "help", label: "Help", key: "?", description: "Show keyboard shortcuts" },
    ];

    process.stdout.write(colorize("\n  UTILITIES\n", "bold"));
    process.stdout.write(colorize("  Press key to execute action\n\n", "dim"));

    // Calculate available width for description: 2 (indent) + key display + space + label + " - "
    // key display is "[x]" = 3 chars, label is padded to 20 chars
    const prefixWidth = 2 + 3 + 1 + 20 + 3; // "  [x] " + label + " - "
    const descriptionWidth = Math.max(8, cols - prefixWidth - 1);

    for (const action of actions) {
      const keyDisplay = colorize(`[${action.key}]`, "brightYellow");
      const label = colorize(action.label.padEnd(20), "white");
      const description = visibleTruncate(action.description, descriptionWidth);
      const line = `  ${keyDisplay} ${label} - ${description}`;
      process.stdout.write(visibleTruncate(line, cols - 1) + "\n");
    }
  }

  private renderStatsSection(): void {
    const cols = process.stdout.columns || 80;

    if (!this.taskStats) {
      process.stdout.write(colorize("\n  Statistics not available.\n", "dim"));
      return;
    }

    const stats = this.taskStats;
    const rows: string[] = [];

    rows.push(colorize("\n  STATISTICS\n", "bold"));
    rows.push("");
    rows.push(`  ${colorize("Total Tasks:", "white")} ${stats.total}`);
    rows.push("");

    // Task counts by column
    rows.push(`  ${colorize("By Column:", "dim")}`);
    for (const [column, count] of Object.entries(stats.byColumn)) {
      const colName = column.replace("-", " ").replace(/\b\w/g, l => l.toUpperCase());
      const activeMark = (column === "in-progress" || column === "in-review") && count > 0
        ? colorize(" ●", "brightGreen")
        : "";
      rows.push(`    ${colName}: ${count}${activeMark}`);
    }

    rows.push("");
    rows.push(`  ${colorize("Active Tasks:", "white")} ${stats.active} (in-progress + in-review)`);
    rows.push("");

    // Agent counts
    rows.push(`  ${colorize("Agents:", "dim")}`);
    rows.push(`    Idle:    ${stats.agents.idle}`);
    rows.push(`    Active:  ${stats.agents.active}`);
    rows.push(`    Running: ${stats.agents.running}`);
    rows.push(`    Error:   ${stats.agents.error}`);

    for (const row of rows) {
      process.stdout.write(visibleTruncate(row, cols) + "\n");
    }
  }

  private renderSettingsSection(): void {
    const cols = process.stdout.columns || 80;

    if (!this.settings) {
      process.stdout.write(colorize("\n  Settings not available.\n", "dim"));
      return;
    }

    const s = this.settings;
    const rows: string[] = [];

    rows.push(colorize("\n  SETTINGS\n", "bold"));
    rows.push("");

    const settingsList: Array<[string, string]> = [
      ["maxConcurrent", s.maxConcurrent.toString()],
      ["maxWorktrees", s.maxWorktrees.toString()],
      ["autoMerge", s.autoMerge ? "enabled" : "disabled"],
      ["mergeStrategy", s.mergeStrategy],
      ["pollIntervalMs", `${s.pollIntervalMs}ms`],
      ["enginePaused", s.enginePaused ? "yes" : "no"],
      ["globalPause", s.globalPause ? "yes" : "no"],
    ];

    const keyWidth = Math.max(...settingsList.map(([k]) => k.length));

    for (const [key, value] of settingsList) {
      const keyPad = key.padEnd(keyWidth);
      const isEnabled = value === "enabled" || value === "yes";
      const isDisabled = value === "disabled" || value === "no";

      const valueColor = isEnabled ? "brightGreen"
        : isDisabled ? "brightYellow"
        : "white";

      rows.push(`  ${colorize(keyPad, "gray")}  ${colorize(value, valueColor)}`);
    }

    for (const row of rows) {
      process.stdout.write(visibleTruncate(row, cols) + "\n");
    }
  }

  private renderFooter(): void {
    const cols = process.stdout.columns || 80;
    // Clamp to minimum 1 to handle very small terminals
    const footerY = Math.max(1, (process.stdout.rows ?? 22) - 2);

    // Move to footer position
    moveCursorTo(1, footerY);
    clearLine();

    const status = this.systemInfo
      ? `${this.systemInfo.baseUrl} | ${formatUptime(Date.now() - this.systemInfo.startTimeMs)}`
      : "";

    const left = colorize("Press ? for help", "dim");
    const right = colorize(visibleTruncate(status, Math.max(20, cols - 20)), "dim");

    // Use visibleLength to account for ANSI escape sequences
    const leftLen = visibleLength(left);
    const rightLen = visibleLength(right);

    process.stdout.write(left);
    const padding = Math.max(1, cols - leftLen - rightLen - 2);
    process.stdout.write(" ".repeat(padding));
    process.stdout.write(right);

    // Clear rest of line
    process.stdout.write("\n");
  }

  /**
   * Build help overlay lines as an array of strings.
   * Uses dynamic visibleLength calculation to ensure consistent box width.
   * All box-drawing rows (including borders) have the same total visible width.
   *
   * @param boxWidth - The interior content width (excluding the two box characters)
   * @param useBoxDrawing - Whether to use box-drawing characters (true) or compact text (false)
   * @returns Array of help lines
   */
  private buildHelpLines(boxWidth: number, useBoxDrawing: boolean): string[] {
    if (useBoxDrawing) {
      // Helper to create a width-safe interior row with consistent total width
      // Formula: │ + content + padding + │ where padding = max(0, boxWidth - visibleLength(content))
      // This ensures total visible width = boxWidth + 2 for ALL rows
      const boxRow = (content: string): string => {
        const padding = Math.max(0, boxWidth - visibleLength(content));
        return "│" + content + " ".repeat(padding) + "│";
      };

      // Full box drawing style for terminals wide enough
      return [
        "┌" + "─".repeat(boxWidth) + "┐",
        boxRow(centerText("KEYBOARD SHORTCUTS", boxWidth, " ")),
        "├" + "─".repeat(boxWidth) + "┤",
        boxRow("  [1-5]       Switch to tab by number"),
        boxRow("  [n] / →     Next tab"),
        boxRow("  [p] / ←     Previous tab"),
        boxRow("  [r]         Refresh stats (Utilities)"),
        boxRow("  [c]         Clear logs (Utilities)"),
        boxRow("  [t]         Toggle engine pause (Utilities)"),
        boxRow("  [?] / [h]   Toggle help"),
        boxRow("  [q]         Quit"),
        boxRow("  [Ctrl+C]    Force quit"),
        "└" + "─".repeat(boxWidth) + "┘",
      ];
    } else {
      // Compact plain text for narrow terminals - use visibleTruncate to prevent overflow
      return [
        "KEYBOARD SHORTCUTS",
        "  [1-5] Switch tab | [n/p] Next/Prev | [q] Quit",
        "  [r] Refresh | [c] Clear logs | [t] Toggle engine",
        "  [?/h] Help | [Ctrl+C] Force quit",
      ];
    }
  }

  private renderHelpOverlay(): void {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    // Build help lines with dynamic width for narrow terminals
    const boxWidth = Math.min(62, Math.max(cols - 4, 20));
    const useBoxDrawing = cols >= boxWidth + 4;

    const rawHelpLines = this.buildHelpLines(boxWidth, useBoxDrawing);

    // Compute compact box width from actual line widths for proper centering
    const compactBoxWidth = useBoxDrawing ? boxWidth : Math.max(...rawHelpLines.map(visibleLength));
    const boxHeight = rawHelpLines.length;
    // Clamp origin to terminal-safe coordinates (minimum 1)
    const safeStartX = Math.max(1, Math.floor((cols - compactBoxWidth) / 2));
    const safeStartY = Math.max(1, Math.floor((rows - boxHeight) / 2));

    // Clamp clear-loop bounds to valid terminal coordinates
    const clearTop = Math.max(1, safeStartY - 1);
    const clearBottom = Math.min(rows, safeStartY + boxHeight);

    // Colorize lines and clear screen area for overlay
    for (let y = clearTop; y <= clearBottom; y++) {
      moveCursorTo(1, y);
      clearLine();
    }

    // Draw the help box
    for (let i = 0; i < rawHelpLines.length; i++) {
      const color = i === 0 || i === 2 || i === rawHelpLines.length - 1 ? "brightBlue" : "white";
      moveCursorTo(safeStartX, safeStartY + i);
      process.stdout.write(colorize(rawHelpLines[i], color));
    }
  }
}

// ── Non-TTY Fallback Sink ─────────────────────────────────────────────────────

/**
 * A log sink that routes messages to the TUI in TTY mode,
 * or to console in non-TTY mode.
 */
export class DashboardLogSink {
  private tui: DashboardTUI | null = null;
  private isTTY: boolean;

  constructor(tui?: DashboardTUI) {
    this.tui = tui ?? null;
    this.isTTY = tui?.running ?? false;
  }

  setTUI(tui: DashboardTUI): void {
    this.tui = tui;
    this.isTTY = true;
  }

  log(message: string, prefix?: string): void {
    if (this.tui && this.isTTY) {
      this.tui.log(message, prefix);
    } else {
      console.log(prefix ? `[${prefix}] ${message}` : message);
    }
  }

  warn(message: string, prefix?: string): void {
    if (this.tui && this.isTTY) {
      this.tui.warn(message, prefix);
    } else {
      console.warn(prefix ? `[${prefix}] ${message}` : message);
    }
  }

  error(message: string, prefix?: string): void {
    if (this.tui && this.isTTY) {
      this.tui.error(message, prefix);
    } else {
      console.error(prefix ? `[${prefix}] ${message}` : message);
    }
  }
}

// ── String Helpers ────────────────────────────────────────────────────────────

/** Center text within a field of given width */
function centerText(text: string, width: number, padChar: string = " "): string {
  const visibleLen = visibleLength(text);
  const padding = Math.max(0, width - visibleLen);
  const leftPad = Math.floor(padding / 2);
  const rightPad = padding - leftPad;
  return padChar.repeat(leftPad) + text + padChar.repeat(rightPad);
}

// ── Check if TTY is available ─────────────────────────────────────────────────

export function isTTYAvailable(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

// ── Header String Helper (for testing) ─────────────────────────────────────

/**
 * Render the header to a string using the given column width.
 * Used for testing without requiring TTY mode.
 */
export function renderHeaderToString(cols: number): string {
  const title = colorize("  fusion  ", "cyan");
  const titleLen = visibleLength(title);

  let output = title;

  // Build tabs based on column width (same logic as renderHeader)
  if (cols >= 70) {
    for (let i = 0; i < SECTION_ORDER.length; i++) {
      const section = SECTION_ORDER[i];
      const isActive = section === "logs"; // Default active section for test
      const num = (i + 1).toString();
      const label = section.charAt(0).toUpperCase() + section.slice(1);
      const tabText = `[${num}] ${label}`;
      const style = isActive ? "brightBlue" : "dim";
      output += colorize(` ${tabText} `, style);
    }
  } else if (cols >= 40) {
    const shortLabels: Record<SectionId, string> = {
      logs: "L",
      system: "S",
      utilities: "U",
      stats: "St",
      settings: "Se",
    };
    for (let i = 0; i < SECTION_ORDER.length; i++) {
      const section = SECTION_ORDER[i];
      const isActive = section === "logs";
      const num = (i + 1).toString();
      const shortLabel = shortLabels[section];
      const tabText = `[${num}]${shortLabel}`;
      const style = isActive ? "brightBlue" : "dim";
      output += colorize(` ${tabText} `, style);
    }
  } else {
    output += colorize(" [1]Logs ", "brightBlue");
    output += colorize(" [n/p]nav ", "dim");
  }

  // Calculate tabs length for padding
  const tabsLength = SECTION_ORDER.reduce((acc, s, i) => {
    let label: string;
    if (cols >= 70) {
      label = s.charAt(0).toUpperCase() + s.slice(1);
    } else if (cols >= 40) {
      const shortLabels: Record<SectionId, string> = {
        logs: "L",
        system: "S",
        utilities: "U",
        stats: "St",
        settings: "Se",
      };
      label = shortLabels[s];
    } else {
      label = s.charAt(0).toUpperCase() + s.slice(1);
    }
    const tabText = `[${i + 1}]${label} `;
    return acc + tabText.length;
  }, 0);
  const headerLen = titleLen + tabsLength;

  const remaining = cols - headerLen;
  if (remaining > 0) {
    output += " ".repeat(remaining);
  }

  output += "\n";
  output += colorize("─".repeat(Math.max(20, cols)), "dim") + "\n";

  return output;
}
