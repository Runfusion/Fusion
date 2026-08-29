import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  clampTaskListText as sourceBarrelClampTaskListText,
  MAX_TASK_LIST_TEXT_CHARS as SOURCE_BARREL_MAX_TASK_LIST_TEXT_CHARS,
  formatTaskListText as sourceBarrelFormatTaskListText,
} from "../index.js";
import { hasBuiltCoreDistBarrel } from "@fusion/test-utils";
import { clampTaskListText, formatTaskListText, MAX_TASK_LIST_TEXT_CHARS } from "../tasks/task-list-format.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type RuntimeCoreTaskListModule = {
  COLUMNS: readonly string[];
  COLUMN_LABELS: Record<string, string>;
  MAX_TASK_LIST_TEXT_CHARS: number;
  clampTaskListText: (lines: string[]) => string;
  formatTaskListText?: (lines: string[]) => string;
};

type RuntimeTask = {
  id: string;
  title?: string;
  description: string;
  column: string;
  dependencies?: string[];
};

function formatRuntimeTaskLine(task: RuntimeTask): string {
  const dependencySuffix = task.dependencies?.length ? ` [deps: ${task.dependencies.join(", ")}]` : "";
  return `${task.id}  ${task.title || task.description}${dependencySuffix}`;
}

function executeRuntimeTaskList(
  core: RuntimeCoreTaskListModule,
  tasks: RuntimeTask[],
  params: { column?: string; limit?: number } = {},
) {
  if (tasks.length === 0) {
    return {
      content: [{ type: "text", text: "No tasks yet." }],
      details: { count: 0 },
    };
  }

  const perColumn = params.limit ?? 10;
  const lines: string[] = [];
  for (const col of core.COLUMNS) {
    if (params.column && params.column !== col) continue;

    const colTasks = tasks.filter((task) => task.column === col);
    if (colTasks.length === 0) continue;

    lines.push(`${core.COLUMN_LABELS[col] ?? col} (${colTasks.length}):`);
    const shown = colTasks.slice(0, perColumn);
    for (const task of shown) {
      lines.push(`  ${formatRuntimeTaskLine(task)}`);
    }
    const hidden = colTasks.length - shown.length;
    if (hidden > 0) {
      lines.push(`  ... and ${hidden} more`);
    }
    lines.push("");
  }

  return {
    content: [{ type: "text", text: core.clampTaskListText(lines).trimEnd() }],
    details: { count: tasks.length },
  };
}

/**
 * FNXC:TaskListOutput 2026-06-16-23:20:
 * FN-6515 requires the @fusion/core dist barrel to export clampTaskListText and MAX_TASK_LIST_TEXT_CHARS because heartbeat fn_task_list and other runtime surfaces load the built dist, not src/index.ts. Source-aliased tests alone can pass while a stale or missing dist export still crashes ambient agents.
 *
 * FNXC:TaskListOutput 2026-06-17-02:30:
 * FN-6535 requires this guard to execute a fn_task_list-shaped runtime call through the built dist module, not just assert the barrel types. The recurring crash was a post-FN-6492 tool call resolving @fusion/core through exports.import to stale dist, so the regression must fail when that dist omits the helper.
 */
describe("@fusion/core dist barrel export wiring (FN-6515/FN-6535)", () => {
  const distDir = resolve(__dirname, "../../dist");
  const hasCompleteDistBarrel = hasBuiltCoreDistBarrel(distDir);
  const distIndex = resolve(distDir, "index.js");
  let builtDistCore: RuntimeCoreTaskListModule | undefined;

  /*
  FNXC:CoreTests 2026-06-17-13:40:
  FN-6591 requires the FN-6515/FN-6535 dist-barrel guard to settle under broad @fusion/core suite load without timeout, retry, or worker appeasement.
  Load the built dist barrel once for every dist assertion so heartbeat fn_task_list coverage still exercises the real runtime export path while avoiding duplicate dynamic-import pressure in the timed test bodies.

  FNXC:CoreTests 2026-06-18-01:35:
  FN-6627 requires this guard to skip when the built @fusion/core dist barrel is absent or partial, because the runtime import path depends on both index.js and task-list-format.js.
  */
  beforeAll(async () => {
    if (!hasCompleteDistBarrel) return;
    builtDistCore = await import(pathToFileURL(distIndex).href) as RuntimeCoreTaskListModule;
  });

  it("re-exports task-list formatting helpers from the source barrel", () => {
    expect(typeof sourceBarrelClampTaskListText).toBe("function");
    expect(typeof sourceBarrelFormatTaskListText).toBe("function");
    expect(typeof SOURCE_BARREL_MAX_TASK_LIST_TEXT_CHARS).toBe("number");
  });

  it.skipIf(!hasCompleteDistBarrel)("re-exports task-list formatting helpers from the built dist barrel", () => {
    const mod = builtDistCore;

    expect(mod).toBeDefined();
    expect(typeof mod?.clampTaskListText).toBe("function");
    expect(typeof mod?.formatTaskListText).toBe("function");
    expect(typeof mod?.MAX_TASK_LIST_TEXT_CHARS).toBe("number");
  });

  it.skipIf(!hasCompleteDistBarrel)("executes the fn_task_list surface through the built dist core module", () => {
    const mod = builtDistCore as RuntimeCoreTaskListModule;
    const todoAnchor: RuntimeTask = {
      id: "FN-001",
      title: `Runtime todo task 001 ${"x".repeat(260)}`,
      description: "Runtime todo task 001",
      column: "todo",
    };
    const tasks: RuntimeTask[] = [
      ...Array.from({ length: 35 }, (_, index) => ({
        id: `FN-${String(index + 101).padStart(3, "0")}`,
        title: `Runtime planning task ${String(index + 1).padStart(3, "0")} ${"x".repeat(380)}`,
        description: `Runtime planning task ${String(index + 1).padStart(3, "0")}`,
        column: "triage",
      })),
      todoAnchor,
      ...Array.from({ length: 59 }, (_, index) => ({
        id: `FN-${String(index + 2).padStart(3, "0")}`,
        title: `Runtime todo task ${String(index + 2).padStart(3, "0")} ${"x".repeat(260)}`,
        description: `Runtime todo task ${String(index + 2).padStart(3, "0")}`,
        column: "todo",
        dependencies: [todoAnchor.id],
      })),
    ];

    const broadResult = executeRuntimeTaskList(mod, tasks, { limit: 20 });
    const broadText = broadResult.content[0].text;
    expect(broadResult.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(broadText.length).toBeLessThanOrEqual(mod.MAX_TASK_LIST_TEXT_CHARS);
    expect(broadText).toContain("Planning (35):");
    expect(broadText).toContain("FN-101");
    expect(broadText).toContain("truncated to fit; narrow with column/limit");
    expect(broadResult.details.count).toBe(95);

    const todoResult = executeRuntimeTaskList(mod, tasks, { column: "todo", limit: 50 });
    const todoText = todoResult.content[0].text;
    expect(todoResult.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(todoText.length).toBeLessThanOrEqual(mod.MAX_TASK_LIST_TEXT_CHARS);
    expect(todoText).toContain("Todo (60):");
    expect(todoText).toContain("FN-001");
    expect(todoText).toContain("[deps: FN-001]");
    expect(todoText).toContain("truncated to fit; narrow with column/limit");
    expect(todoResult.details.count).toBe(95);
  });
});

describe("formatTaskListText", () => {
  it("returns an empty string for empty input", () => {
    expect(formatTaskListText([])).toBe("");
  });

  it("uses the canonical clamp path for small input without a marker", () => {
    const lines = ["Todo (2):", "  FN-001  First task", "  FN-002  Second task"];

    expect(formatTaskListText(lines)).toBe(lines.join("\n"));
    expect(formatTaskListText(lines)).not.toContain("truncated to fit");
  });

  it("uses the canonical clamp path for large input with the FN-6492 marker", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `FN-${String(index + 1).padStart(3, "0")}  ${"x".repeat(20)}`);

    const text = formatTaskListText(lines, { maxChars: 150 });

    expect(text.length).toBeLessThanOrEqual(150);
    expect(text).toContain("truncated to fit; narrow with column/limit");
  });

  it("falls back to bounded text when the clamp helper is missing", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `FN-${String(index + 1).padStart(3, "0")}  ${"x".repeat(80)}`);

    const text = formatTaskListText(lines, { clamp: undefined });

    expect(text).toBeTruthy();
    expect(text.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
  });

  it("falls back to bounded text when the clamp binding is not a function", () => {
    const lines = ["FN-001  " + "x".repeat(200)];
    const text = formatTaskListText(lines, {
      maxChars: 40,
      clamp: "not-a-function" as unknown as (lines: string[], opts?: { maxChars?: number }) => string,
    });

    expect(text).toBeTruthy();
    expect(text.length).toBeLessThanOrEqual(40);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("clampTaskListText", () => {
  it("documents the host-safe default budget", () => {
    expect(MAX_TASK_LIST_TEXT_CHARS).toBe(3_000);
  });

  it("returns an empty string for empty input", () => {
    expect(clampTaskListText([])).toBe("");
  });

  it("returns small input unchanged without a marker", () => {
    const lines = ["Todo (2):", "  FN-001  First task", "  FN-002  Second task"];

    expect(clampTaskListText(lines)).toBe(lines.join("\n"));
    expect(clampTaskListText(lines)).not.toContain("truncated to fit");
  });

  it("truncates large input to the budget with an accurate dropped-line marker", () => {
    const lines = [
      "Todo (5):",
      "  FN-001  Task one",
      "  FN-002  Task two",
      "  FN-003  Task three",
      "  FN-004  Task four",
      "  FN-005  Task five",
    ];

    const text = clampTaskListText(lines, { maxChars: 95 });

    expect(text.length).toBeLessThanOrEqual(95);
    expect(text).toContain("Todo (5):");
    expect(text).toContain("FN-001");
    expect(text).toContain("... and 4 more tasks (truncated to fit; narrow with column/limit)");
  });

  it("never splits retained lines mid-line", () => {
    const lines = [
      "Todo (4):",
      "  FN-001  Retain me whole",
      "  FN-002  Retain me whole too",
      "  FN-003  Drop me whole",
      "  FN-004  Drop me whole too",
    ];

    const text = clampTaskListText(lines, { maxChars: 105 });
    const outputLines = text.split("\n");

    expect(outputLines).toEqual([
      "Todo (4):",
      "  FN-001  Retain me whole",
      "... and 3 more tasks (truncated to fit; narrow with column/limit)",
    ]);
  });

  it("honors a custom maxChars budget", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `FN-${String(index + 1).padStart(3, "0")}  ${"x".repeat(20)}`);

    const text = clampTaskListText(lines, { maxChars: 150 });

    expect(text.length).toBeLessThanOrEqual(150);
    expect(text).toContain("truncated to fit");
  });

  it("keeps default output within the exported budget", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `FN-${String(index + 1).padStart(3, "0")}  ${"x".repeat(80)}`);

    expect(clampTaskListText(lines).length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
  });

  it("truncates realistic large listings under the host-safe budget", () => {
    const lines = [
      "Todo (60):",
      ...Array.from(
        { length: 50 },
        (_, index) =>
          `  FN-${String(index + 1).padStart(3, "0")}  Realistic todo task ${String(index + 1).padStart(3, "0")} keeps descriptive context for text agents without artificial padding`,
      ),
      "  ... and 10 more",
      "",
    ];

    const text = clampTaskListText(lines);

    expect(lines.join("\n").length).toBeGreaterThan(MAX_TASK_LIST_TEXT_CHARS);
    expect(text.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
    expect(text).toContain("Todo (60):");
    expect(text).toContain("FN-001");
    expect(text).toContain("truncated to fit; narrow with column/limit");
  });

  it("handles a single over-budget line by returning a bounded truncation marker", () => {
    const text = clampTaskListText(["FN-001  " + "x".repeat(200)], { maxChars: 40 });

    expect(text.length).toBeLessThanOrEqual(40);
    expect(text).toMatch(/^\.\.\. and 1 more tas/);
    expect(text.endsWith("…")).toBe(true);
  });
});
