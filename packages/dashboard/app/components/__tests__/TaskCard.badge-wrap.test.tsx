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
  Eye: () => null,
  MoreHorizontal: () => null,
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
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
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

  it("keeps the outer header row non-wrapping while badges wrap inside their own group", () => {
    const header = container.querySelector(".card-header");
    const headerBadges = container.querySelector(".card-header-badges");
    expect(header).toBeTruthy();
    expect(headerBadges).toBeTruthy();

    const headerStyles = getComputedStyle(header!);
    expect(headerStyles.flexWrap).toBe("nowrap");
    expect(headerStyles.rowGap).toMatch(/^(var\(--space-xs\)|(?!0px$)\d+(?:\.\d+)?px)$/);

    const badgeStyles = getComputedStyle(headerBadges!);
    expect(badgeStyles.display).toBe("flex");
    expect(badgeStyles.flexWrap).toBe("wrap");
    expect(badgeStyles.minWidth).toBe("0px");
    expect(header?.contains(headerBadges)).toBe(true);
    expect(container.querySelector(".card-header-actions")).toBeNull();
  });

  it("keeps a fast-mode size badge in the right-aligned header actions instead of an orphaned wrapped row", () => {
    const { container: sizedContainer } = render(
      <TaskCard
        task={makeTask({
          id: "FN-7832",
          column: "done",
          status: "done" as Task["status"],
          size: "S",
          priority: "urgent" as Task["priority"],
          executionMode: "fast",
          noCommitsExpected: true,
          issueInfo: {
            owner: "owner",
            repo: "repo",
            number: 7832,
            state: "open",
            title: "Fast-mode done card with extra header badges",
            url: "https://github.com/owner/repo/issues/7832",
          } as Task["issueInfo"],
        })}
        onOpenDetail={noop}
        addToast={noop}
        onArchiveTask={async () => makeTask()}
        workflowBadge={{ workflowId: "wf-fast-size", workflowName: "Fast size workflow" }}
      />,
    );

    const header = sizedContainer.querySelector(".card-header") as HTMLElement;
    const headerBadges = sizedContainer.querySelector(".card-header-badges") as HTMLElement;
    const actions = sizedContainer.querySelector(".card-header-actions") as HTMLElement;
    const sizeBadge = sizedContainer.querySelector(".card-size-badge") as HTMLElement;
    const fastBadge = sizedContainer.querySelector(".card-execution-mode-badge") as HTMLElement;

    expect(header).toBeTruthy();
    expect(headerBadges).toBeTruthy();
    expect(actions).toBeTruthy();
    expect(sizeBadge).toBeTruthy();
    expect(fastBadge).toBeTruthy();
    expect(actions.contains(sizeBadge)).toBe(true);
    expect(headerBadges.contains(fastBadge)).toBe(true);
    expect(sizeBadge.closest(".card-header-badges")).toBeNull();
    expect(actions.parentElement).toBe(header);
    expect(headerBadges.parentElement).toBe(header);

    const headerStyles = getComputedStyle(header);
    const actionsStyles = getComputedStyle(actions);
    expect(headerStyles.flexWrap).toBe("nowrap");
    expect(actionsStyles.marginLeft).toBe("auto");
    expect(actionsStyles.flexShrink).toBe("0");
    expect(actionsStyles.alignSelf).toBe("flex-start");
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

  it("places the agent badge in a left-aligned bottom row outside the header badge cluster", () => {
    const agentRow = container.querySelector(".card-agent-badge-row") as HTMLElement;
    const agentBadge = container.querySelector(".card-agent-created-badge") as HTMLElement;
    const header = container.querySelector(".card-header") as HTMLElement;
    const metaBadges = container.querySelector(".card-meta-badges") as HTMLElement;

    expect(agentRow).toBeTruthy();
    expect(agentBadge).toBeTruthy();
    expect(agentRow.contains(agentBadge)).toBe(true);
    expect(header.contains(agentBadge)).toBe(false);
    expect(metaBadges.contains(agentBadge)).toBe(false);
    expect(agentBadge.getAttribute("title")).toBe("Created by agent: agent-badge-wrap");
    expect(agentBadge.getAttribute("aria-label")).toBe("Created by agent: agent-badge-wrap");
    expect(agentBadge.querySelector(".visually-hidden")?.textContent).toBe("Created by agent: agent-badge-wrap");
    expect(agentBadge.querySelector("span[aria-hidden='true']")?.textContent).toBe("agent-badge-...");

    const styles = getComputedStyle(agentRow);
    expect(styles.display).toBe("flex");
    expect(styles.justifyContent).toBe("flex-start");
    expect(styles.minWidth).toBe("0px");
  });

  it("does not render an empty header badge shell when the agent badge is the only grouped affordance", () => {
    const { container: agentOnlyContainer } = render(
      <TaskCard
        task={makeTask({
          priority: "normal" as Task["priority"],
          executionMode: "standard",
          sourceType: "agent_heartbeat",
          sourceAgentId: "agent-only",
          plannerOversightLevel: "off",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const agentBadge = agentOnlyContainer.querySelector(".card-agent-created-badge");
    expect(agentBadge).not.toBeNull();
    expect(agentBadge?.closest(".card-agent-badge-row")).not.toBeNull();
    expect(agentBadge?.closest(".card-header")).toBeNull();
    expect(agentOnlyContainer.querySelector(".card-meta-badges")).toBeNull();
  });

  it("omits the agent bottom row for non-agent-created tasks", () => {
    const { container: nonAgentContainer } = render(
      <TaskCard
        task={makeTask({
          priority: "normal" as Task["priority"],
          executionMode: "standard",
          sourceType: "dashboard_ui",
          sourceAgentId: undefined,
          plannerOversightLevel: "off",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(nonAgentContainer.querySelector(".card-agent-created-badge")).toBeNull();
    expect(nonAgentContainer.querySelector(".card-agent-badge-row")).toBeNull();
    expect(nonAgentContainer.querySelector(".card-meta-badges")).toBeNull();
  });

  it("places the workflow badge in a left-aligned bottom row outside the header badge cluster", () => {
    const workflowRow = container.querySelector(".card-workflow-badge-row") as HTMLElement;
    const workflowBadge = container.querySelector(".card-workflow-badge") as HTMLElement;
    const metaBadges = container.querySelector(".card-meta-badges") as HTMLElement;
    const agentRow = container.querySelector(".card-agent-badge-row") as HTMLElement;

    expect(workflowRow).toBeTruthy();
    expect(workflowBadge).toBeTruthy();
    expect(workflowRow.contains(workflowBadge)).toBe(true);
    expect(metaBadges.contains(workflowBadge)).toBe(false);
    expect(agentRow.compareDocumentPosition(workflowRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const styles = getComputedStyle(workflowRow);
    expect(styles.display).toBe("flex");
    expect(styles.justifyContent).toBe("flex-start");
    expect(styles.minWidth).toBe("0px");
  });
});
