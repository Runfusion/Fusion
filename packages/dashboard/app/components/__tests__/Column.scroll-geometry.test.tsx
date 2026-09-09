import React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Column as ColumnType, Task } from "@fusion/core";
import { loadComponentCss } from "../../test/cssFixture";
import { Column } from "../Column";

vi.mock("../TaskCard", () => ({ TaskCard: ({ task }: { task: Task }) => <article data-testid={`task-${task.id}`}>{task.id}</article> }));
vi.mock("../WorktreeGroup", () => ({ WorktreeGroup: () => null }));
vi.mock("../QuickEntryBox", () => ({ QuickEntryBox: () => null }));
vi.mock("../../hooks/usePluginUiSlots", () => ({ usePluginUiSlots: () => ({ slots: [], getSlotsForId: () => [], loading: false, error: null }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn() }) }));

function task(index: number): Task {
  return {
    id: `FN-${index}`,
    title: `Task ${index}`,
    description: "",
    column: "done" as ColumnType,
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

const props = {
  column: "done" as ColumnType,
  columnFlags: { complete: true },
  workflowMode: true,
  maxConcurrent: 1,
  maxWorktrees: 1,
  showWorktreeGrouping: false,
  onMoveTask: vi.fn().mockResolvedValue({} as Task),
  onOpenDetail: vi.fn(),
  addToast: vi.fn(),
};

afterEach(() => vi.unstubAllGlobals());

describe("Column scroll geometry", () => {
  it("keeps virtual spacers in normal flow and includes row spacing in measurements", () => {
    const css = loadComponentCss("Column.css");
    expect(css).toMatch(/\.column-body\s*\{[^}]*display:\s*block/s);
    expect(css).toMatch(/\.column-virtual-row\s*\{[^}]*padding-block-end:\s*var\(--space-xs\)/s);
    expect(css).toMatch(/\.column-virtual-spacer\s*\{[^}]*inline-size:\s*100%/s);
  });

  it.each([1_200, 768, 600])("reaches the final logical row with at most 40 mounted rows at %ipx", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    vi.stubGlobal("ResizeObserver", undefined);
    const tasks = Array.from({ length: 10_000 }, (_, index) => task(index));
    render(<Column {...props} tasks={tasks} />);
    const root = document.querySelector<HTMLElement>(".column-body")!;
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 640 },
      scrollHeight: { configurable: true, value: 3_200_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    root.scrollTop = root.scrollHeight - root.clientHeight;
    await act(async () => {
      fireEvent.scroll(root);
      await Promise.resolve();
    });

    expect(document.querySelectorAll("[data-virtual-task-row]").length).toBeLessThanOrEqual(40);
    expect(document.querySelector("[data-virtual-task-row='FN-9999']")).not.toBeNull();
    const spacerHeights = [...document.querySelectorAll<HTMLElement>(".column-virtual-spacer")].map((node) => Number.parseFloat(node.style.height));
    expect(spacerHeights.some((height) => height > 0)).toBe(true);
  });
});
