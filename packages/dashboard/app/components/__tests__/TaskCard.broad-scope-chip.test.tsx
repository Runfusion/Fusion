import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("lucide-react", () => ({
  Link: () => <svg />,
  GitBranch: () => <svg />,
  Clock: () => <svg />,
  Pencil: () => <svg />,
  Layers: () => <svg />,
  ChevronDown: () => <svg />,
  Folder: () => <svg />,
  GitPullRequest: () => <svg />,
  CircleDot: () => <svg />,
  Target: () => <svg />,
  Bot: () => <svg />,
  Trash2: () => <svg />,
  RotateCw: () => <svg />,
  Zap: () => <svg />,
  AlertTriangle: () => <svg />,
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    isConnected: true,
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  }),
}));

vi.mock("../../hooks/useBatchBadgeFetch", () => ({
  getFreshBatchData: vi.fn(() => null),
}));

vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => true) }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5314",
    title: "Broad scope test",
    description: "",
    column: "todo",
    status: undefined,
    steps: [],
    dependencies: [],
    ...overrides,
  } as Task;
}

const noop = () => {};

function mountCss(): () => void {
  const style = document.createElement("style");
  style.textContent = loadAllAppCss();
  document.head.appendChild(style);
  return () => style.remove();
}

describe("TaskCard broad-scope advisory chip", () => {
  it("renders chip for well-formed broadScopeFlag", () => {
    render(
      <TaskCard
        task={makeTask({
          sourceMetadata: {
            broadScopeFlag: {
              score: 5,
              reasons: ["size-l", "steps-high"],
              signals: { size: "L", stepCount: 13, fileScopeCount: 22, failingFileMentions: 0 },
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const label = "Broad-scope advisory (score 5): Size L, many steps";
    const chip = screen.getByLabelText(label);
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute("title", label);
    expect(chip.tagName).toBe("SPAN");
  });

  it("uses warning color + pill radius tokenized styles", () => {
    const unmountCss = mountCss();
    document.documentElement.style.setProperty("--color-warning", "rgb(210, 120, 0)");
    document.documentElement.style.setProperty("--radius-pill", "9999px");

    render(
      <TaskCard
        task={makeTask({
          sourceMetadata: {
            broadScopeFlag: {
              score: 5,
              reasons: ["size-l"],
            },
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const chip = screen.getByLabelText("Broad-scope advisory (score 5): Size L");
    const styles = window.getComputedStyle(chip);
    expect(styles.borderRadius).toBe("var(--radius-pill)");
    expect(styles.color).toBe("var(--color-warning)");

    unmountCss();
    document.documentElement.style.removeProperty("--color-warning");
    document.documentElement.style.removeProperty("--radius-pill");
  });

  it.each([
    ["missing sourceMetadata", undefined],
    ["missing broadScopeFlag", {}],
    ["non-numeric score", { broadScopeFlag: { score: "5", reasons: ["size-l"] } }],
    ["non-array reasons", { broadScopeFlag: { score: 5, reasons: "size-l" } }],
  ])("does not render chip when %s", (_label, sourceMetadata) => {
    render(
      <TaskCard
        task={makeTask({ sourceMetadata: sourceMetadata as Task["sourceMetadata"] })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Broad scope")).not.toBeInTheDocument();
  });
});
