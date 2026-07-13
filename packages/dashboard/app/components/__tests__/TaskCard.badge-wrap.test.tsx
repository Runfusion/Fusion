import React from "react";
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
  ArrowDown: ({ style }: { style?: React.CSSProperties }) => <svg className="lucide-arrow-down" style={style} />,
  Flag: ({ style }: { style?: React.CSSProperties }) => <svg className="lucide-flag" style={style} />,
  ArrowUp: ({ style }: { style?: React.CSSProperties }) => <svg className="lucide-arrow-up" style={style} />,
  TriangleAlert: ({ style }: { style?: React.CSSProperties }) => <svg className="lucide-triangle-alert" style={style} />,
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
const resolvedChipHeightPattern = /^(var\(--card-chip-height\)|22px)$/;
const centeredIdNudgePattern = /^translateY\(calc\(var\(--space-xs\) \/ 4\)\)$/;

function expectSharedHeaderBaseline(container: HTMLElement) {
  const header = container.querySelector(".card-header") as HTMLElement;
  const cardId = container.querySelector(".card-id") as HTMLElement;
  const actions = container.querySelector(".card-header-actions") as HTMLElement;

  expect(header).toBeTruthy();
  expect(cardId).toBeTruthy();
  expect(actions).toBeTruthy();

  const headerStyles = getComputedStyle(header);
  const idStyles = getComputedStyle(cardId);
  const actionsStyles = getComputedStyle(actions);

  expect(headerStyles.alignItems).toBe("flex-start");
  expect(headerStyles.flexWrap).toBe("nowrap");
  expect(idStyles.display).toBe("inline-flex");
  expect(idStyles.alignItems).toBe("center");
  expect(idStyles.lineHeight).toBe("1");
  expect(idStyles.minHeight).toMatch(resolvedChipHeightPattern);
  expect(idStyles.transform).toMatch(centeredIdNudgePattern);
  expect(actionsStyles.display).toBe("flex");
  expect(actionsStyles.alignItems).toBe("center");
  expect(actionsStyles.transform).toBe(idStyles.transform);
  expect(actionsStyles.minHeight).toMatch(resolvedChipHeightPattern);
  expect(actionsStyles.marginLeft).toBe("auto");
  expect(actionsStyles.flex).toBe("0 0 auto");
}

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
  let loadedCss = "";

  beforeEach(async () => {
    const style = document.createElement("style");
    loadedCss = await Promise.resolve(loadAllAppCss());
    style.textContent = loadedCss;
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
    expectSharedHeaderBaseline(sizedContainer);
  });

  it("aligns an in-progress card id with Send back and size actions while badges are present", () => {
    const { container: alignedContainer } = render(
      <TaskCard
        task={makeTask({
          id: "FN-7862",
          column: "in-progress",
          status: "planning" as Task["status"],
          size: "M",
          priority: "urgent" as Task["priority"],
          executionMode: "fast",
          plannerOverseerState: { state: "monitoring" },
        })}
        onOpenDetail={noop}
        addToast={noop}
        onMoveTask={async () => makeTask()}
      />,
    );

    const headerBadges = alignedContainer.querySelector(".card-header-badges") as HTMLElement;
    const actions = alignedContainer.querySelector(".card-header-actions") as HTMLElement;
    const sizeBadge = alignedContainer.querySelector(".card-size-badge") as HTMLElement;
    const sendBack = alignedContainer.querySelector(".card-send-back") as HTMLElement;

    expect(headerBadges).toBeTruthy();
    expect(getComputedStyle(headerBadges).alignItems).toBe("center");
    expect(getComputedStyle(headerBadges).minHeight).toMatch(resolvedChipHeightPattern);
    expect(sendBack).toBeTruthy();
    expect(actions.contains(sendBack)).toBe(true);
    expect(actions.contains(sizeBadge)).toBe(true);
    expect(sizeBadge.closest(".card-header-badges")).toBeNull();
    expectSharedHeaderBaseline(alignedContainer);
  });

  it("aligns a no-badges triage card id with edit/delete actions without shifting the id", () => {
    const { container: triageContainer } = render(
      <TaskCard
        task={makeTask({
          id: "FN-7862-NO-BADGES",
          column: "triage",
          status: undefined,
          size: "M",
          priority: "normal" as Task["priority"],
          executionMode: "standard",
          plannerOversightLevel: "off",
        })}
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={async () => makeTask()}
        onDeleteTask={async () => makeTask()}
      />,
    );

    const actions = triageContainer.querySelector(".card-header-actions") as HTMLElement;
    const sizeBadge = triageContainer.querySelector(".card-size-badge") as HTMLElement;

    expect(triageContainer.querySelector(".card-header-badges")).toBeNull();
    expect(actions.querySelector(".card-edit-btn")).toBeTruthy();
    expect(actions.querySelector(".card-delete-btn")).toBeTruthy();
    expect(actions.contains(sizeBadge)).toBe(true);
    expect(sizeBadge.closest(".card-header-badges")).toBeNull();
    expectSharedHeaderBaseline(triageContainer);
  });

  it("keeps the centered-id nudge and mobile header rhythm tokenized with the badge-wrap contract", () => {
    const cardIdRule = loadedCss.match(/\.card-id\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    const actionsRule = loadedCss.match(/\.card-header-actions\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    expect(cardIdRule).toContain("min-height: var(--card-chip-height);");
    expect(cardIdRule).toContain("line-height: 1;");
    expect(cardIdRule).toContain("transform: translateY(calc(var(--space-xs) / 4));");
    expect(cardIdRule).not.toMatch(/translateY\(\d/);
    expect(actionsRule).toContain("transform: translateY(calc(var(--space-xs) / 4));");
    expect(actionsRule).not.toMatch(/translateY\(\d/);
    expect(loadedCss).toContain(".card-id,\n  .card-header-badges,\n  .card-header-actions");
    expect(loadedCss).toContain("min-height: var(--card-chip-height-mobile);");
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
