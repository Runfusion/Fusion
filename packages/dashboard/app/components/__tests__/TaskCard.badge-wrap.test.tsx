import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  CheckCircle2: () => null,
  XCircle: () => null,
  Target: () => null,
  Bot: () => null,
  Trash2: () => null,
  RotateCw: () => null,
  Zap: () => null,
  AlertTriangle: () => null,
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: () => null,
}));

vi.mock("../PluginSlot", () => ({
  PluginSlot: () => null,
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

const noop = () => {};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5162",
    title: "Wrap this very long task title without letting the badge row overflow the card boundary",
    column: "in-progress",
    status: "planning" as Task["status"],
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

describe("TaskCard badge wrapping (FN-5162)", () => {
  let cleanupCss: (() => void) | undefined;
  let container: HTMLElement;

  beforeEach(async () => {
    const style = document.createElement("style");
    style.textContent = await Promise.resolve(loadAllAppCss());
    document.head.appendChild(style);
    cleanupCss = () => style.remove();

    container = render(
      <TaskCard
        task={makeTask({
          priority: "urgent" as Task["priority"],
          executionMode: "fast",
          noCommitsExpected: true,
          sourceType: "agent_heartbeat",
          sourceAgentId: "agent-badge-wrap",
          issueInfo: {
            owner: "owner",
            repo: "repo",
            number: 42,
            state: "open",
            title: "Tracked issue with a long badge label",
            url: "https://github.com/owner/repo/issues/42",
          } as Task["issueInfo"],
        })}
        onOpenDetail={noop}
        addToast={noop}
        workflowBadge={{ workflowId: "wf-badge-wrap", workflowName: "Long workflow badge label" }}
      />,
    ).container;
  });

  afterEach(() => {
    cleanupCss?.();
    cleanupCss = undefined;
  });

  it("wraps the header row and keeps a non-zero row gap", () => {
    const header = container.querySelector(".card-header");
    expect(header).toBeTruthy();

    const styles = getComputedStyle(header!);
    expect(styles.flexWrap).toBe("wrap");
    expect(styles.rowGap).toMatch(/^(var\(--space-xs\)|(?!0px$)\d+(?:\.\d+)?px)$/);
  });

  it.each([
    ".card-status-badge",
    ".card-priority-badge",
    ".card-agent-created-badge",
    ".card-no-commits-expected-badge",
    ".card-github-badge",
    ".card-workflow-badge",
  ])("applies truncation constraints to %s when rendered", (selector) => {
    const badge = container.querySelector(selector);
    expect(badge, `${selector} should render for the fixture`).toBeTruthy();

    const styles = getComputedStyle(badge as Element);
    expect(styles.maxWidth).not.toBe("none");
    expect(styles.whiteSpace).toBe("nowrap");
  });

  it("places the workflow badge in a left-aligned bottom row outside the header badge cluster", () => {
    const workflowRow = container.querySelector(".card-workflow-badge-row") as HTMLElement;
    const workflowBadge = container.querySelector(".card-workflow-badge") as HTMLElement;
    const metaBadges = container.querySelector(".card-meta-badges") as HTMLElement;

    expect(workflowRow).toBeTruthy();
    expect(workflowBadge).toBeTruthy();
    expect(workflowRow.contains(workflowBadge)).toBe(true);
    expect(metaBadges.contains(workflowBadge)).toBe(false);

    const styles = getComputedStyle(workflowRow);
    expect(styles.display).toBe("flex");
    expect(styles.justifyContent).toBe("flex-start");
    expect(styles.minWidth).toBe("0px");
  });
});
