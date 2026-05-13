import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TaskCard } from "../TaskCard";
import type { Task } from "@fusion/core";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("lucide-react", () => ({
  Link: () => null,
  GitBranch: () => null,
  Clock: () => null,
  Pencil: () => null,
  Layers: () => null,
  ChevronDown: () => null,
  Folder: () => null,
  GitPullRequest: () => null,
  CircleDot: () => null,
  Target: () => null,
  Bot: () => null,
  Trash2: () => null,
  RotateCw: () => null,
  Zap: () => null,
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: () => null,
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

const noop = () => {};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Badge height",
    column: "in-progress",
    status: "planning" as Task["status"],
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

function mountCss() {
  const style = document.createElement("style");
  style.textContent = loadAllAppCss();
  document.head.appendChild(style);
  return () => style.remove();
}

describe("TaskCard badge heights (FN-4369)", () => {
  it("keeps planning, merging, and priority pills at identical dimensions", () => {
    const cleanupCss = mountCss();

    const planning = render(
      <TaskCard task={makeTask({ id: "FN-100", column: "in-progress", status: "planning" as Task["status"] })} onOpenDetail={noop} addToast={noop} />,
    ).container.querySelector(".card-status-badge");

    const merging = render(
      <TaskCard task={makeTask({ id: "FN-101", column: "in-review", status: "merging" as Task["status"] })} onOpenDetail={noop} addToast={noop} />,
    ).container.querySelector(".card-status-badge");

    const urgent = render(
      <TaskCard task={makeTask({ id: "FN-102", priority: "urgent" as Task["priority"] })} onOpenDetail={noop} addToast={noop} />,
    ).container.querySelector(".card-priority-badge--urgent");

    const high = render(
      <TaskCard task={makeTask({ id: "FN-103", priority: "high" as Task["priority"] })} onOpenDetail={noop} addToast={noop} />,
    ).container.querySelector(".card-priority-badge--high");

    const low = render(
      <TaskCard task={makeTask({ id: "FN-104", priority: "low" as Task["priority"] })} onOpenDetail={noop} addToast={noop} />,
    ).container.querySelector(".card-priority-badge--low");

    expect(planning).toBeTruthy();
    expect(merging).toBeTruthy();
    expect(urgent).toBeTruthy();
    expect(high).toBeTruthy();
    expect(low).toBeTruthy();

    const baseline = getComputedStyle(planning!);

    for (const badge of [merging!, urgent!, high!, low!]) {
      const styles = getComputedStyle(badge);
      expect(styles.height).toBe(baseline.height);
      expect(styles.paddingTop).toBe(baseline.paddingTop);
      expect(styles.paddingBottom).toBe(baseline.paddingBottom);
      expect(styles.borderTopWidth).toBe(baseline.borderTopWidth);
      expect(styles.borderBottomWidth).toBe(baseline.borderBottomWidth);
      expect(styles.fontSize).toBe(baseline.fontSize);
      expect(styles.lineHeight).toBe(baseline.lineHeight);
    }

    cleanupCss();
  });
});
