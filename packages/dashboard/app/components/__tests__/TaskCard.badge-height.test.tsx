import React from "react";
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
  GitPullRequest: () => <svg />,
  CircleDot: () => null,
  Target: () => <svg />,
  Bot: () => null,
  Trash2: () => null,
  RotateCw: () => null,
  Zap: () => <svg />,
  Eye: () => <svg />,
  AlertTriangle: () => null,
  ArrowDown: ({ style }: { style?: React.CSSProperties }) => <svg className="lucide-arrow-down" style={style} />,
  Flag: ({ style }: { style?: React.CSSProperties }) => <svg className="lucide-flag" style={style} />,
  ArrowUp: ({ style }: { style?: React.CSSProperties }) => <svg className="lucide-arrow-up" style={style} />,
  TriangleAlert: ({ style }: { style?: React.CSSProperties }) => <svg className="lucide-triangle-alert" style={style} />,
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: () => null,
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));
vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
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
  it("keeps triage planning, merging, and priority pills at identical dimensions", () => {
    const cleanupCss = mountCss();

    const planning = render(
      <TaskCard task={makeTask({ id: "FN-100", column: "triage", status: "planning" as Task["status"] })} onOpenDetail={noop} addToast={noop} />,
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

  it("keeps every populated header chip on the shared text-badge geometry", () => {
    const cleanupCss = mountCss();
    const { container } = render(
      <TaskCard
        task={makeTask({
          id: "FN-8254",
          status: "running" as Task["status"],
          size: "M",
          priority: "urgent" as Task["priority"],
          executionMode: "fast",
          missionId: "M-8254",
          plannerOversightLevel: "autonomous",
          plannerOverseerState: {
            state: "watching",
            oversightLevel: "autonomous",
            watchedStage: "executor",
            signal: "progressing",
            attemptCount: 0,
            attemptLimit: 3,
            pendingConfirmation: false,
            observedAt: 1700000000000,
          },
        })}
        onOpenDetail={noop}
        addToast={noop}
        onOpenPullRequest={noop}
        prNode={{ id: "pr-8254", state: "open", prNumber: 8254 }}
      />,
    );

    const baseline = container.querySelector(".card-status-badge");
    const chips = [
      ".card-planner-overseer-state",
      ".card-execution-mode-badge",
      ".card-pr-node-badge",
      ".card-mission-badge",
      ".card-size-badge",
      ".card-oversight-badge",
    ].map((selector) => container.querySelector(selector));

    expect(baseline).toBeTruthy();
    chips.forEach((chip) => expect(chip).toBeTruthy());

    const baselineStyles = getComputedStyle(baseline!);
    for (const chip of chips) {
      const styles = getComputedStyle(chip!);
      expect(styles.height).toBe(baselineStyles.height);
      expect(styles.paddingTop).toBe(baselineStyles.paddingTop);
      expect(styles.paddingBottom).toBe(baselineStyles.paddingBottom);
      expect(styles.borderTopWidth).toBe(baselineStyles.borderTopWidth);
      expect(styles.borderBottomWidth).toBe(baselineStyles.borderBottomWidth);
      expect(styles.lineHeight).toBe(baselineStyles.lineHeight);
      expect(styles.minHeight).toBe(baselineStyles.minHeight);
    }

    cleanupCss();
  });
});
