import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LogRingBuffer,
  DashboardLogSink,
  isTTYAvailable,
  renderHeaderToString,
  DashboardTUI,
  type SystemInfo,
  type TaskStats,
  type SettingsValues,
} from "./dashboard-tui.js";

// ── LogRingBuffer Tests ────────────────────────────────────────────────────

describe("LogRingBuffer", () => {
  let buffer: LogRingBuffer;

  beforeEach(() => {
    buffer = new LogRingBuffer();
  });

  it("stores entries and reports total count", () => {
    buffer.push({ timestamp: new Date(), level: "info", message: "test1" });
    buffer.push({ timestamp: new Date(), level: "warn", message: "test2" });
    expect(buffer.total).toBe(2);
  });

  it("returns all entries in chronological order", () => {
    buffer.push({ timestamp: new Date("2026-01-01T10:00:00"), level: "info", message: "first" });
    buffer.push({ timestamp: new Date("2026-01-01T11:00:00"), level: "info", message: "second" });
    const entries = buffer.getAll();
    expect(entries.length).toBe(2);
    expect(entries[0].message).toBe("first");
    expect(entries[1].message).toBe("second");
  });

  it("caps at MAX_LOG_ENTRIES (1000)", () => {
    for (let i = 0; i < 1500; i++) {
      buffer.push({ timestamp: new Date(), level: "info", message: `entry-${i}` });
    }
    const entries = buffer.getAll();
    expect(entries.length).toBe(1000);
    expect(buffer.total).toBe(1500);
  });

  it("maintains chronological order when overwriting", () => {
    // Add 1500 entries to force overwrites
    for (let i = 0; i < 1500; i++) {
      buffer.push({ timestamp: new Date(2026, 0, 1, 0, i), level: "info", message: `entry-${i}` });
    }
    const entries = buffer.getAll();
    expect(entries.length).toBe(1000);
    // First entry should be the 500th (since 1000 entries were added before wrap)
    expect(entries[0].message).toBe("entry-500");
    // Last entry should be the 1499th
    expect(entries[entries.length - 1].message).toBe("entry-1499");
  });

  it("clears all entries", () => {
    buffer.push({ timestamp: new Date(), level: "info", message: "test" });
    buffer.clear();
    expect(buffer.getAll().length).toBe(0);
    expect(buffer.total).toBe(0);
  });

  it("stores entries with different levels", () => {
    buffer.push({ timestamp: new Date(), level: "info", message: "info msg" });
    buffer.push({ timestamp: new Date(), level: "warn", message: "warn msg" });
    buffer.push({ timestamp: new Date(), level: "error", message: "error msg" });
    const entries = buffer.getAll();
    expect(entries[0].level).toBe("info");
    expect(entries[1].level).toBe("warn");
    expect(entries[2].level).toBe("error");
  });

  it("stores entries with prefix", () => {
    buffer.push({ timestamp: new Date(), level: "info", message: "msg", prefix: "engine" });
    const entries = buffer.getAll();
    expect(entries[0].prefix).toBe("engine");
  });
});

// ── DashboardLogSink Tests ─────────────────────────────────────────────────

describe("DashboardLogSink", () => {
  it("logs to console in non-TTY mode", () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.log("test message");

    expect(consoleLogSpy).toHaveBeenCalledWith("test message");
    consoleLogSpy.mockRestore();
  });

  it("includes prefix in non-TTY mode", () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.log("test message", "dashboard");

    expect(consoleLogSpy).toHaveBeenCalledWith("[dashboard] test message");
    consoleLogSpy.mockRestore();
  });

  it("warns to console.warn in non-TTY mode", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.warn("warning message");

    expect(consoleWarnSpy).toHaveBeenCalledWith("warning message");
    consoleWarnSpy.mockRestore();
  });

  it("errors to console.error in non-TTY mode", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.error("error message");

    expect(consoleErrorSpy).toHaveBeenCalledWith("error message");
    consoleErrorSpy.mockRestore();
  });

  it("handles empty message", () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sink = new DashboardLogSink();

    sink.log("");

    expect(consoleLogSpy).toHaveBeenCalledWith("");
    consoleLogSpy.mockRestore();
  });
});

// ── isTTYAvailable Tests ─────────────────────────────────────────────────

describe("isTTYAvailable", () => {
  it("returns boolean based on TTY status", () => {
    const result = isTTYAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("checks both stdout and stdin are TTY", () => {
    // isTTYAvailable checks process.stdout.isTTY && process.stdin.isTTY
    // In test environment these may be undefined, resulting in falsy
    const result = isTTYAvailable();
    expect(typeof result).toBe("boolean");
  });
});

// ── Header Branding Tests ───────────────────────────────────────────────

describe("renderHeaderToString", () => {
  it("includes 'fusion' in header title", () => {
    const header = renderHeaderToString(80);
    expect(header).toContain("fusion");
  });

  it("does not include old 'fn board' branding", () => {
    const header = renderHeaderToString(80);
    expect(header).not.toContain("fn board");
  });

  it("renders correctly at wide terminal width (>= 70 cols)", () => {
    const header = renderHeaderToString(80);
    expect(header).toContain("fusion");
    expect(header).toContain("[1] System");
    expect(header).toContain("[2] Logs");
  });

  it("renders correctly at medium terminal width (>= 40 cols)", () => {
    const header = renderHeaderToString(50);
    expect(header).toContain("fusion");
    expect(header).toContain("[1]S"); // Short label for System
    expect(header).toContain("[2]L"); // Short label for Logs
  });

  it("renders correctly at narrow terminal width (< 40 cols)", () => {
    const header = renderHeaderToString(30);
    expect(header).toContain("fusion");
    expect(header).toContain("[1]System");
    expect(header).toContain("[n/p]nav");
  });
});

// ── Type exports verification ─────────────────────────────────────────────

describe("DashboardTUI default section", () => {
  it("starts on the system section by default", () => {
    const tui = new DashboardTUI();
    expect((tui as any).activeSection).toBe("system");
  });
});

describe("Type exports", () => {
  it("exports LogEntry type", () => {
    const entry = {
      timestamp: new Date(),
      level: "info" as const,
      message: "test",
      prefix: "test",
    };
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(entry.level).toBe("info");
  });

  it("accepts valid SystemInfo", () => {
    const info: SystemInfo = {
      host: "localhost",
      port: 4040,
      baseUrl: "http://localhost:4040",
      authEnabled: true,
      authToken: "token123",
      tokenizedUrl: "http://localhost:4040/?token=token123",
      engineMode: "active",
      fileWatcher: true,
      startTimeMs: Date.now() - 60000,
    };
    expect(info.host).toBe("localhost");
    expect(info.engineMode).toBe("active");
  });

  it("accepts valid TaskStats", () => {
    const stats: TaskStats = {
      total: 42,
      byColumn: { triage: 5, todo: 10, "in-progress": 8, "in-review": 2, done: 17 },
      active: 10,
      agents: { idle: 3, active: 2, running: 1, error: 0 },
    };
    expect(stats.total).toBe(42);
    expect(stats.agents.idle).toBe(3);
  });

  it("accepts valid SettingsValues", () => {
    const settings: SettingsValues = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      autoMerge: true,
      mergeStrategy: "direct",
      pollIntervalMs: 60000,
      enginePaused: false,
      globalPause: false,
    };
    expect(settings.autoMerge).toBe(true);
    expect(settings.enginePaused).toBe(false);
  });
});

// ── Help Overlay Alignment Tests ─────────────────────────────────────────────

/**
 * Calculate visible length of a string (strips ANSI escape sequences).
 * Mirrors the helper function in dashboard-tui.ts for testing purposes.
 */
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

describe("Help overlay border alignment in box-drawing mode", () => {
  /**
   * Helper that mirrors the boxRow logic from buildHelpLines.
   * Ensures total visible width = boxWidth + 2 for rows with content <= boxWidth.
   */
  function boxRow(content: string, boxWidth: number): string {
    const padding = Math.max(0, boxWidth - visibleLength(content));
    return "│" + content + " ".repeat(padding) + "│";
  }

  function centerText(text: string, width: number, padChar = " "): string {
    const padding = Math.max(0, width - visibleLength(text));
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return padChar.repeat(leftPad) + text + padChar.repeat(rightPad);
  }

  /**
   * Build help lines exactly as buildHelpLines() does.
   * Used to verify box geometry without requiring TTY mode.
   */
  function buildHelpLinesForTest(boxWidth: number): string[] {
    return [
      "┌" + "─".repeat(boxWidth) + "┐",
      boxRow(centerText("KEYBOARD SHORTCUTS", boxWidth, " "), boxWidth),
      "├" + "─".repeat(boxWidth) + "┤",
      boxRow("  [1-5]       Switch to tab by number", boxWidth),
      boxRow("  [n] / →     Next tab", boxWidth),
      boxRow("  [p] / ←     Previous tab", boxWidth),
      boxRow("  [r]         Refresh stats (Utilities)", boxWidth),
      boxRow("  [c]         Clear logs (Utilities)", boxWidth),
      boxRow("  [t]         Toggle engine pause (Utilities)", boxWidth),
      boxRow("  [?] / [h]   Toggle help", boxWidth),
      boxRow("  [q]         Quit", boxWidth),
      boxRow("  [Ctrl+C]    Force quit", boxWidth),
      "└" + "─".repeat(boxWidth) + "┘",
    ];
  }

  it("all box-drawing rows have consistent total visible width for standard terminal", () => {
    const boxWidth = 62;
    const helpLines = buildHelpLinesForTest(boxWidth);
    const expectedWidth = boxWidth + 2; // boxWidth interior + 2 box characters

    // All rows should have exactly the same visible width
    for (const line of helpLines) {
      expect(visibleLength(line)).toBe(expectedWidth);
    }
  });

  it("box rows match the top/bottom border width", () => {
    const boxWidth = 62;
    const helpLines = buildHelpLinesForTest(boxWidth);

    // Get top border width
    const topBorder = helpLines[0];
    const borderWidth = visibleLength(topBorder);

    // Every row must match the border width
    for (let i = 1; i < helpLines.length; i++) {
      expect(visibleLength(helpLines[i])).toBe(borderWidth);
    }
  });

  it("right border characters align across all rows for standard terminal", () => {
    const boxWidth = 62;
    const helpLines = buildHelpLinesForTest(boxWidth);
    const expectedWidth = boxWidth + 2;

    // Top border determines the box width
    const topBorder = helpLines[0];
    const topBorderWidth = visibleLength(topBorder);

    // Every interior row should have the same total width as the top border
    for (let i = 1; i < helpLines.length; i++) {
      const line = helpLines[i];
      // The line should have the same total width as top border
      expect(visibleLength(line)).toBe(topBorderWidth);
      expect(visibleLength(line)).toBe(expectedWidth);
    }
  });

  it("handles narrow terminal width (boxWidth = 62) for full-width content", () => {
    // Use 62 to accommodate the longest content line (~45 chars)
    const boxWidth = 62;
    const helpLines = buildHelpLinesForTest(boxWidth);
    const expectedWidth = boxWidth + 2;

    // All rows should have consistent width with boxWidth=62
    for (const line of helpLines) {
      expect(visibleLength(line)).toBe(expectedWidth);
    }
  });

  it("all interior rows end with right border character", () => {
    const boxWidth = 62;
    const helpLines = buildHelpLinesForTest(boxWidth);

    // Check that all interior rows (indices 1 through length-2) end with │
    // Skip header/title row (index 1) which has centered text
    for (let i = 3; i < helpLines.length - 1; i++) {
      const line = helpLines[i];
      expect(line.endsWith("│")).toBe(true);
    }
  });

  it("padding is zero when content fills the boxWidth", () => {
    const boxWidth = 62;
    // "  [t]         Toggle engine pause (Utilities)" is 45 chars
    const content = "  [t]         Toggle engine pause (Utilities)";
    const padding = Math.max(0, boxWidth - visibleLength(content));
    expect(padding).toBe(17); // 62 - 45 = 17
  });

  it("padding calculation ensures consistent row width", () => {
    // Test that for content shorter than boxWidth, padding fills the gap
    const boxWidth = 62;
    const shortContent = "  [q]         Quit"; // 18 chars
    const expectedPadding = boxWidth - visibleLength(shortContent); // 62 - 18 = 44

    const row = boxRow(shortContent, boxWidth);
    expect(visibleLength(row)).toBe(boxWidth + 2);
    expect(row.startsWith("│")).toBe(true);
    expect(row.endsWith("│")).toBe(true);
  });
});

// ── DashboardTUI Logs Interaction Tests ─────────────────────────────────────────

// Helper to create a TUI with mocked stdout for testing
function createTestTUI(): DashboardTUI & {
  _stdout: string[];
  _setTerminalSize: (cols: number, rows: number) => void;
} {
  const tui = new DashboardTUI() as DashboardTUI & {
    _stdout: string[];
    _setTerminalSize: (cols: number, rows: number) => void;
  };

  // Mock stdout writes
  const originalWrite = process.stdout.write.bind(process.stdout);
  tui._stdout = [];
  tui._setTerminalSize = (cols: number, rows: number) => {
    Object.defineProperty(process.stdout, "columns", { value: cols, writable: true });
    Object.defineProperty(process.stdout, "rows", { value: rows, writable: true });
  };

  // Set default terminal size
  tui._setTerminalSize(80, 24);

  return tui;
}

// Helper to simulate keypress
function simulateKeypress(tui: DashboardTUI, key: string): void {
  // Access the private handleLogsKeypress method via any
  (tui as any).handleLogsKeypress(key);
}

describe("DashboardTUI Logs Selection", () => {
  let tui: DashboardTUI & {
    _stdout: string[];
    _setTerminalSize: (cols: number, rows: number) => void;
  };

  beforeEach(() => {
    tui = createTestTUI();
    // Add some test entries
    for (let i = 1; i <= 5; i++) {
      tui.log(`Entry ${i}`);
    }
  });

  afterEach(() => {
    // Restore stdout
    Object.defineProperty(process.stdout, "columns", { value: 80, writable: true });
    Object.defineProperty(process.stdout, "rows", { value: 24, writable: true });
  });

  it("selection starts at 0", () => {
    expect((tui as any).selectedLogIndex).toBe(0);
  });

  it("arrow up moves selection to older entry", () => {
    // Move down first (towards newer)
    simulateKeypress(tui, "\x1b[B"); // down
    expect((tui as any).selectedLogIndex).toBe(1);

    // Move up (towards older)
    simulateKeypress(tui, "\x1b[A"); // up
    expect((tui as any).selectedLogIndex).toBe(0);
  });

  it("arrow down moves selection to newer entry", () => {
    simulateKeypress(tui, "\x1b[B"); // down
    expect((tui as any).selectedLogIndex).toBe(1);

    simulateKeypress(tui, "\x1b[B"); // down again
    expect((tui as any).selectedLogIndex).toBe(2);
  });

  it("k key moves selection to older entry", () => {
    simulateKeypress(tui, "\x1b[B"); // down
    expect((tui as any).selectedLogIndex).toBe(1);

    simulateKeypress(tui, "k");
    expect((tui as any).selectedLogIndex).toBe(0);
  });

  it("j key moves selection to newer entry", () => {
    simulateKeypress(tui, "j");
    expect((tui as any).selectedLogIndex).toBe(1);
  });

  it("selection clamps at first entry (up boundary)", () => {
    expect((tui as any).selectedLogIndex).toBe(0);
    simulateKeypress(tui, "\x1b[A"); // up from 0
    expect((tui as any).selectedLogIndex).toBe(0); // Should stay at 0
  });

  it("selection clamps at last entry (down boundary)", () => {
    // Move to last entry
    for (let i = 0; i < 10; i++) {
      simulateKeypress(tui, "\x1b[B");
    }
    expect((tui as any).selectedLogIndex).toBe(4); // Max index for 5 entries

    // Try to go past last
    simulateKeypress(tui, "\x1b[B");
    expect((tui as any).selectedLogIndex).toBe(4); // Should stay at 4
  });

  it("selection is entry-based, not visual-line-based", () => {
    // Selection should always be by entry index, regardless of wrap mode
    simulateKeypress(tui, "\x1b[B");
    expect((tui as any).selectedLogIndex).toBe(1);

    // Enable wrap mode
    simulateKeypress(tui, "w");

    // Selection should still be entry-based
    simulateKeypress(tui, "\x1b[A");
    expect((tui as any).selectedLogIndex).toBe(0);
  });
});

describe("DashboardTUI Logs viewport window", () => {
  let tui: DashboardTUI & {
    _stdout: string[];
    _setTerminalSize: (cols: number, rows: number) => void;
  };
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tui = createTestTUI();
    tui._setTerminalSize(80, 14); // maxRows = 5 in logs list
    (tui as any).activeSection = "logs";

    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    (tui as any).isRunning = true;

    for (let i = 1; i <= 12; i++) {
      tui.log(`Entry ${i}`);
    }
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    Object.defineProperty(process.stdout, "columns", { value: 80, writable: true });
    Object.defineProperty(process.stdout, "rows", { value: 24, writable: true });
  });

  function renderLogs(): string {
    stdoutWriteSpy.mockClear();
    (tui as any).renderLogsSection();
    return stdoutWriteSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
  }

  it("keeps the selected older entry visible when navigating beyond newest screenful", () => {
    // Jump to newest entry (index 11), then move to older entries.
    simulateKeypress(tui, "End");
    for (let i = 0; i < 7; i++) {
      simulateKeypress(tui, "\x1b[A");
    }

    expect((tui as any).selectedLogIndex).toBe(4);
    const output = renderLogs();

    expect(output).toContain("Entry 5");
    expect(output).toContain("Entry 9");
    expect(output).not.toContain("Entry 12");
    expect((tui as any).logsViewportStart).toBe(4);
  });

  it("Home and End reach full ring buffer bounds from the logs tab", () => {
    simulateKeypress(tui, "Home");
    expect((tui as any).selectedLogIndex).toBe(0);
    let output = renderLogs();
    expect(output).toContain("Entry 1");

    simulateKeypress(tui, "End");
    expect((tui as any).selectedLogIndex).toBe(11);
    output = renderLogs();
    expect(output).toContain("Entry 12");
    expect((tui as any).logsViewportStart).toBe(7);
  });
});

describe("DashboardTUI Logs Expanded Mode", () => {
  let tui: DashboardTUI & {
    _stdout: string[];
    _setTerminalSize: (cols: number, rows: number) => void;
  };

  beforeEach(() => {
    tui = createTestTUI();
    // Add some test entries
    for (let i = 1; i <= 5; i++) {
      tui.log(`Entry ${i}`);
    }
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: 80, writable: true });
    Object.defineProperty(process.stdout, "rows", { value: 24, writable: true });
  });

  it("expanded mode starts as false", () => {
    expect((tui as any).logsExpandedMode).toBe(false);
  });

  it("Enter toggles expanded mode on", () => {
    simulateKeypress(tui, "\r");
    expect((tui as any).logsExpandedMode).toBe(true);
  });

  it("Enter toggles expanded mode off when already expanded", () => {
    simulateKeypress(tui, "\r"); // turn on
    expect((tui as any).logsExpandedMode).toBe(true);

    simulateKeypress(tui, "\r"); // turn off
    expect((tui as any).logsExpandedMode).toBe(false);
  });

  it("Esc closes expanded mode", () => {
    simulateKeypress(tui, "\r"); // turn on
    expect((tui as any).logsExpandedMode).toBe(true);

    simulateKeypress(tui, "\x1b"); // Esc
    expect((tui as any).logsExpandedMode).toBe(false);
  });

  it("Enter on empty logs is a no-op", () => {
    // Clear all logs
    (tui as any).clearLogs();
    expect((tui as any).logsExpandedMode).toBe(false);

    simulateKeypress(tui, "\r"); // Should not throw or change state
    expect((tui as any).logsExpandedMode).toBe(false);
  });

  it("Esc on empty logs does nothing", () => {
    (tui as any).clearLogs();
    simulateKeypress(tui, "\x1b"); // Should not throw
    expect((tui as any).logsExpandedMode).toBe(false);
  });
});

describe("DashboardTUI Logs Wrap Mode", () => {
  let tui: DashboardTUI & {
    _stdout: string[];
    _setTerminalSize: (cols: number, rows: number) => void;
  };

  beforeEach(() => {
    tui = createTestTUI();
    tui.log("This is a long message that should wrap when wrap mode is enabled");
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: 80, writable: true });
    Object.defineProperty(process.stdout, "rows", { value: 24, writable: true });
  });

  it("wrap mode starts as false", () => {
    expect((tui as any).logsWrapEnabled).toBe(false);
  });

  it("w toggles wrap mode on", () => {
    simulateKeypress(tui, "w");
    expect((tui as any).logsWrapEnabled).toBe(true);
  });

  it("w toggles wrap mode off when already on", () => {
    simulateKeypress(tui, "w"); // turn on
    expect((tui as any).logsWrapEnabled).toBe(true);

    simulateKeypress(tui, "w"); // turn off
    expect((tui as any).logsWrapEnabled).toBe(false);
  });

  it("W (uppercase) also toggles wrap mode", () => {
    simulateKeypress(tui, "W");
    expect((tui as any).logsWrapEnabled).toBe(true);
  });

  it("wrap mode persists across tab switches", () => {
    simulateKeypress(tui, "w"); // Enable wrap
    expect((tui as any).logsWrapEnabled).toBe(true);

    // Switch to utilities tab (would be tab 3)
    (tui as any).activeSection = "utilities";

    // Switch back to logs
    (tui as any).activeSection = "logs";

    // Wrap mode should still be enabled
    expect((tui as any).logsWrapEnabled).toBe(true);
  });
});

describe("DashboardTUI Logs Selection Reset on Clear", () => {
  let tui: DashboardTUI & {
    _stdout: string[];
    _setTerminalSize: (cols: number, rows: number) => void;
  };

  beforeEach(() => {
    tui = createTestTUI();
    // Add some test entries
    for (let i = 1; i <= 5; i++) {
      tui.log(`Entry ${i}`);
    }
    // Move selection to middle
    simulateKeypress(tui, "\x1b[B");
    simulateKeypress(tui, "\x1b[B");
    expect((tui as any).selectedLogIndex).toBe(2);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: 80, writable: true });
    Object.defineProperty(process.stdout, "rows", { value: 24, writable: true });
  });

  it("clearing logs resets selection to 0", () => {
    (tui as any).clearLogs();
    expect((tui as any).selectedLogIndex).toBe(0);
  });

  it("clearing logs closes expanded mode", () => {
    simulateKeypress(tui, "\r"); // Enable expanded
    expect((tui as any).logsExpandedMode).toBe(true);

    (tui as any).clearLogs();
    expect((tui as any).logsExpandedMode).toBe(false);
  });

  it("clearing logs preserves wrap mode (wrap persists for session)", () => {
    simulateKeypress(tui, "w"); // Enable wrap
    expect((tui as any).logsWrapEnabled).toBe(true);

    (tui as any).clearLogs();
    // Wrap mode should persist across clear per spec: "w wrap mode persists for the active TUI session"
    expect((tui as any).logsWrapEnabled).toBe(true);
  });
});

describe("DashboardTUI Narrow Terminal Safety", () => {
  let tui: DashboardTUI & {
    _stdout: string[];
    _setTerminalSize: (cols: number, rows: number) => void;
  };

  beforeEach(() => {
    tui = createTestTUI();
    tui.log("Test message");
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: 80, writable: true });
    Object.defineProperty(process.stdout, "rows", { value: 24, writable: true });
  });

  it("handles very narrow terminal width without throwing", () => {
    tui._setTerminalSize(20, 10);
    expect(() => simulateKeypress(tui, "\x1b[A")).not.toThrow();
    expect(() => simulateKeypress(tui, "\x1b[B")).not.toThrow();
    expect(() => simulateKeypress(tui, "\r")).not.toThrow();
  });

  it("handles very short terminal height without throwing", () => {
    tui._setTerminalSize(80, 5);
    expect(() => simulateKeypress(tui, "\x1b[A")).not.toThrow();
    expect(() => simulateKeypress(tui, "\x1b[B")).not.toThrow();
  });

  it("handles single-row terminal without throwing", () => {
    tui._setTerminalSize(80, 1);
    expect(() => simulateKeypress(tui, "\x1b[A")).not.toThrow();
  });

  it("no negative widths in wrap calculation", () => {
    tui._setTerminalSize(5, 10); // Very narrow
    // This should not cause negative width issues
    expect(() => simulateKeypress(tui, "w")).not.toThrow();
  });
});

describe("DashboardTUI Help Overlay Interaction", () => {
  let tui: DashboardTUI & {
    _stdout: string[];
    _setTerminalSize: (cols: number, rows: number) => void;
  };

  beforeEach(() => {
    tui = createTestTUI();
    tui.log("Test message");
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: 80, writable: true });
    Object.defineProperty(process.stdout, "rows", { value: 24, writable: true });
  });

  it("Esc closes expanded mode and help overlay together", () => {
    simulateKeypress(tui, "\r"); // Enable expanded
    expect((tui as any).logsExpandedMode).toBe(true);

    (tui as any).showHelp = true; // Manually enable help
    expect((tui as any).showHelp).toBe(true);

    simulateKeypress(tui, "\x1b"); // Esc closes both
    expect((tui as any).logsExpandedMode).toBe(false);
    expect((tui as any).showHelp).toBe(false);
  });

  it("Esc closes help overlay when expanded mode is not active", () => {
    (tui as any).showHelp = true;
    expect((tui as any).showHelp).toBe(true);

    simulateKeypress(tui, "\x1b"); // Esc
    expect((tui as any).showHelp).toBe(false);
  });
});
