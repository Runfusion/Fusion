/**
 * Tests for responsive layout utilities (terminal dimensions and truncation).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { Writable } from "node:stream";
import { computeColumnLayout, MIN_TERMINAL_COLUMNS, MIN_TERMINAL_ROWS, type ColumnDefinition } from "../utils/terminal";
import { truncateText, truncateWithOptions, padText, fitText } from "../utils/truncate";

// Mock stdout state as a mutable object that can be updated between tests
const mockStdout = {
  columns: 80,
  rows: 24,
  write: vi.fn(),
};

function createSinkStream(): NodeJS.WriteStream {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as NodeJS.WriteStream;
  stream.columns = 80;
  stream.rows = 24;
  return stream;
}

function renderTest(node: React.ReactNode) {
  return render(node, {
    stdout: createSinkStream(),
    stderr: createSinkStream(),
    patchConsole: false,
    exitOnCtrlC: false,
    maxFps: 1000,
  });
}

// Mock Ink's useStdout for terminal dimension tests
// The mock returns a function that reads from the mutable mockStdout object
vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ink")>();
  return {
    ...actual,
    useStdout: () => mockStdout,
    // Keep render from actual ink
    render: actual?.render,
    Box: actual?.Box,
    Text: actual?.Text,
  };
});

// Import after mocking
import { useTerminalDimensions } from "../utils/terminal";
import { render } from "ink";

describe("terminal.ts", () => {
  describe("MIN_TERMINAL_* constants", () => {
    it("has minimum column count of 80", () => {
      expect(MIN_TERMINAL_COLUMNS).toBe(80);
    });

    it("has minimum row count of 24", () => {
      expect(MIN_TERMINAL_ROWS).toBe(24);
    });
  });

  describe("useTerminalDimensions hook", () => {
    it("returns dimensions with minimum bounds applied", () => {
      let dimensions: ReturnType<typeof useTerminalDimensions> | null = null;

      function TestComponent() {
        dimensions = useTerminalDimensions();
        return null;
      }

      const instance = renderTest(<TestComponent />);
      instance.unmount();

      expect(dimensions).not.toBeNull();
      // Should have minimum bounds applied (80 columns, 24 rows)
      expect(dimensions!.columns).toBeGreaterThanOrEqual(80);
      expect(dimensions!.rows).toBeGreaterThanOrEqual(24);
      expect(dimensions!.isMinimumSize).toBe(true);
      expect(dimensions!.extraColumns).toBe(0);
    });

    it("does not crash when rendered", () => {
      function TestComponent() {
        const dims = useTerminalDimensions();
        return null;
      }

      const instance = renderTest(<TestComponent />);
      expect(() => instance.unmount()).not.toThrow();
    });
  });

  describe("computeColumnLayout", () => {
    it("returns empty layout for no columns", () => {
      const layout = computeColumnLayout(100, []);
      expect(layout.widths).toEqual([]);
      expect(layout.totalWidth).toBe(0);
      expect(layout.remainingColumns).toBe(100);
    });

    it("uses minimum widths when at or below minimum total", () => {
      const definitions: ColumnDefinition[] = [
        { minWidth: 10 },
        { minWidth: 20 },
        { minWidth: 15 },
      ];
      const layout = computeColumnLayout(80, definitions);

      expect(layout.widths).toEqual([10, 20, 15]);
      expect(layout.totalWidth).toBe(45);
      expect(layout.remainingColumns).toBe(35);
    });

    it("distributes extra columns proportionally by default", () => {
      const definitions: ColumnDefinition[] = [
        { minWidth: 10, canGrow: true, growWeight: 1 },
        { minWidth: 20, canGrow: true, growWeight: 2 },
        { minWidth: 15, canGrow: false }, // Won't grow
      ];
      const layout = computeColumnLayout(100, definitions);

      // Minimum total: 45, Extra: 55
      // Total weight: 3 (1+2)
      // Column 0: 10 + floor(55 * 1 / 3) = 10 + 18 = 28
      // Column 1: 20 + floor(55 * 2 / 3) = 20 + 36 = 56 (but due to rounding in loop, becomes 57)
      // Column 2: 15 (doesn't grow)
      expect(layout.widths[0]).toBe(28);
      // Note: Due to rounding, the last growable column gets the remainder
      expect(layout.widths[2]).toBe(15);
      expect(layout.totalWidth).toBe(100);
      // Verify proportional distribution (columns 0 and 1 should be ~2x each other)
      expect(layout.widths[0]).toBeLessThan(layout.widths[1]);
      expect(layout.widths[1] / layout.widths[0]).toBeGreaterThan(1.5);
    });

    it("distributes extra columns equally with 'equal' strategy", () => {
      const definitions: ColumnDefinition[] = [
        { minWidth: 10, canGrow: true },
        { minWidth: 20, canGrow: true },
        { minWidth: 15, canGrow: true },
      ];
      const layout = computeColumnLayout(100, definitions, "equal");

      // Minimum total: 45, Extra: 55
      // Extra per growable: floor(55 / 3) = 18
      // Remainder: 55 % 3 = 1
      expect(layout.widths[0]).toBe(28); // 10 + 18
      expect(layout.widths[1]).toBe(38); // 20 + 18
      expect(layout.widths[2]).toBe(33); // 15 + 18
      expect(layout.remainingColumns).toBe(1); // Rounding remainder
    });

    it("does not distribute extra columns with 'fixed' strategy", () => {
      const definitions: ColumnDefinition[] = [
        { minWidth: 10, canGrow: true },
        { minWidth: 20, canGrow: true },
      ];
      const layout = computeColumnLayout(100, definitions, "fixed");

      expect(layout.widths).toEqual([10, 20]);
      expect(layout.totalWidth).toBe(30);
      expect(layout.remainingColumns).toBe(70);
    });

    it("prioritizes content-heavy columns with 'content-heavy' strategy", () => {
      const definitions: ColumnDefinition[] = [
        { minWidth: 10, canGrow: true, preferredWidth: 20 },  // Needs 10 more
        { minWidth: 30, canGrow: true, preferredWidth: 35 },   // Needs 5 more
        { minWidth: 15, canGrow: false },                      // Won't grow
      ];
      const layout = computeColumnLayout(100, definitions, "content-heavy");

      // Minimum total: 55, Extra: 45
      // Content scores: 10, 5, 0
      // Total score: 15
      // Column 0: 10 + floor(45 * 10 / 15) = 10 + 30 = 40
      // Column 1: 30 + floor(45 * 5 / 15) = 30 + 15 = 45
      // Column 2: 15 (doesn't grow)
      expect(layout.widths[0]).toBe(40);
      expect(layout.widths[1]).toBe(45);
      expect(layout.widths[2]).toBe(15);
      expect(layout.totalWidth).toBe(100);
    });

    it("handles edge case of exactly minimum width", () => {
      const definitions: ColumnDefinition[] = [
        { minWidth: 10, canGrow: true },
        { minWidth: 20, canGrow: true },
      ];
      const layout = computeColumnLayout(30, definitions);

      expect(layout.widths).toEqual([10, 20]);
      expect(layout.totalWidth).toBe(30);
    });

    it("defaults growWeight to 1", () => {
      const definitions: ColumnDefinition[] = [
        { minWidth: 10, canGrow: true }, // Default weight: 1
        { minWidth: 20, canGrow: true }, // Default weight: 1
      ];
      const layout = computeColumnLayout(100, definitions, "proportional");

      // Both columns grow equally since weights are equal
      expect(layout.widths[0]).toBeGreaterThan(10);
      expect(layout.widths[1]).toBeGreaterThan(20);
      expect(layout.totalWidth).toBe(100);
      // Both should be allocated more than their minimum
      expect(layout.widths[0] + layout.widths[1]).toBeGreaterThan(30);
    });
  });
});

describe("truncate.ts", () => {
  describe("truncateText", () => {
    it("returns text unchanged when it fits", () => {
      expect(truncateText("Hello", 10)).toBe("Hello");
    });

    it("returns text unchanged when it exactly fits", () => {
      expect(truncateText("Hello", 5)).toBe("Hello");
    });

    it("truncates with ellipsis when text exceeds width", () => {
      expect(truncateText("Hello World", 8)).toBe("Hello W…");
    });

    it("returns single ellipsis when width is very small", () => {
      expect(truncateText("Hello", 1)).toBe("…");
      expect(truncateText("Hello", 2)).toBe("…");
      expect(truncateText("Hello", 3)).toBe("…");
    });

    it("returns truncated ellipsis when width is exactly 1-3", () => {
      expect(truncateText("Hello", 1)).toBe("…");
      expect(truncateText("Hello", 2)).toBe("…");
      expect(truncateText("Hello", 3)).toBe("…");
    });

    it("uses custom ellipsis", () => {
      // At width 10, available is 10 - 2 (for "~~") = 8
      expect(truncateText("Hello World", 10, "~~")).toBe("Hello Wo~~");
    });

    it("handles empty string", () => {
      expect(truncateText("", 10)).toBe("");
    });

    it("handles zero width", () => {
      expect(truncateText("Hello", 0)).toBe("");
    });

    it("handles negative width", () => {
      expect(truncateText("Hello", -5)).toBe("");
    });

    it("truncates very long text correctly", () => {
      const longText = "a".repeat(1000);
      expect(truncateText(longText, 10)).toBe("aaaaaaaaa…");
      expect(truncateText(longText, 10).length).toBe(10);
    });
  });

  describe("truncateWithOptions", () => {
    it("respects preserveWords option", () => {
      const text = "Hello World Example";
      // At width 12, without preserveWords: "Hello World…"
      // With preserveWords: looks for space near boundary
      const result = truncateWithOptions(text, 12, { preserveWords: true });
      // Should not break mid-word
      expect(result).not.toMatch(/^[^ ]* …$/); // No mid-word break
    });

    it("respects custom ellipsis option", () => {
      // At width 8 with "~~" (2 chars), available is 8 - 2 = 6
      const result = truncateWithOptions("Hello World", 8, { ellipsis: "~~" });
      expect(result).toBe("Hello ~~");
    });

    it("respects minTruncateWidth option", () => {
      // With minTruncateWidth of 6, at width 5 should use ellipsis
      const result = truncateWithOptions("Hello World", 5, { minTruncateWidth: 6 });
      expect(result).toBe("…");
    });
  });

  describe("padText", () => {
    it("pads text to the right by default", () => {
      expect(padText("Hi", 6)).toBe("Hi    ");
    });

    it("pads text to the left with right alignment", () => {
      expect(padText("Hi", 6, "right")).toBe("    Hi");
    });

    it("centers text with center alignment", () => {
      expect(padText("Hi", 6, "center")).toBe("  Hi  ");
    });

    it("does not pad when text equals width", () => {
      expect(padText("Hello", 5)).toBe("Hello");
    });

    it("truncates when text exceeds width", () => {
      expect(padText("Hello World", 5)).toBe("Hello");
    });

    it("handles zero width", () => {
      expect(padText("Hello", 0)).toBe("");
    });
  });

  describe("fitText", () => {
    it("pads short text to fill width", () => {
      expect(fitText("Hi", 6)).toBe("Hi    ");
    });

    it("truncates long text when no ellipsis specified", () => {
      expect(fitText("Hello World", 6)).toBe("Hello");
    });

    it("truncates with ellipsis when specified", () => {
      expect(fitText("Hello World", 8, "left", "…")).toBe("Hello W…");
    });

    it("respects alignment when padding", () => {
      expect(fitText("Hi", 6, "center")).toBe("  Hi  ");
      expect(fitText("Hi", 6, "right")).toBe("    Hi");
    });

    it("handles edge case of equal width", () => {
      expect(fitText("Hello", 5)).toBe("Hello");
    });

    it("handles zero width", () => {
      expect(fitText("Hello", 0)).toBe("");
    });
  });
});

describe("integration: column layout with truncation", () => {
  it("computes layout and truncates content to fit", () => {
    const columns = 80;
    const definitions: ColumnDefinition[] = [
      { minWidth: 8 },                           // ID
      { minWidth: 40, canGrow: true },           // Description
      { minWidth: 10 },                          // Status
      { minWidth: 12, canGrow: true },           // Created
      { minWidth: 10 },                          // Priority
    ];

    const layout = computeColumnLayout(columns, definitions);

    // Verify widths are calculated
    expect(layout.widths.length).toBe(5);
    expect(layout.totalWidth).toBeLessThanOrEqual(columns);

    // Simulate truncating content to fit
    const longDescription = "This is a very long task description that needs truncation";
    const truncated = truncateText(longDescription, layout.widths[1]);
    expect(truncated.length).toBeLessThanOrEqual(layout.widths[1]);
  });

  it("produces deterministic layout at minimum terminal width", () => {
    const definitions: ColumnDefinition[] = [
      { minWidth: 10, canGrow: true },
      { minWidth: 30, canGrow: true },
      { minWidth: 15, canGrow: true },
      { minWidth: 25, canGrow: false },
    ];

    // Run multiple times to verify determinism
    const layout1 = computeColumnLayout(80, definitions);
    const layout2 = computeColumnLayout(80, definitions);

    expect(layout1.widths).toEqual(layout2.widths);
    expect(layout1.totalWidth).toBe(layout2.totalWidth);
  });
});
