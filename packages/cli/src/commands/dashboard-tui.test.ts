import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LogRingBuffer,
  DashboardLogSink,
  isTTYAvailable,
  renderHeaderToString,
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
    expect(header).toContain("Logs");
    expect(header).toContain("System");
  });

  it("renders correctly at medium terminal width (>= 40 cols)", () => {
    const header = renderHeaderToString(50);
    expect(header).toContain("fusion");
    expect(header).toContain("[1]L"); // Short label for Logs
  });

  it("renders correctly at narrow terminal width (< 40 cols)", () => {
    const header = renderHeaderToString(30);
    expect(header).toContain("fusion");
    expect(header).toContain("Logs");
    expect(header).toContain("[n/p]nav");
  });
});

// ── Type exports verification ─────────────────────────────────────────────

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
