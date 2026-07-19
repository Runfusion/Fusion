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
vi.mock("../../hooks/useAgentsMapCache", () => ({
  useAgentsMapCache: () => ({
    agentsMap: new Map([["agent-ci", { name: "CI Engineer with a very long display name" }]]),
    agents: [],
    loading: false,
    refresh: vi.fn(),
  }),
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
  expect(idStyles.height).toMatch(resolvedChipHeightPattern);
  expect(idStyles.maxHeight).toMatch(resolvedChipHeightPattern);
  expect(idStyles.transform).toMatch(centeredIdNudgePattern);
  expect(actionsStyles.display).toBe("flex");
  expect(actionsStyles.alignItems).toBe("center");
  expect(actionsStyles.transform).toBe(idStyles.transform);
  expect(actionsStyles.minHeight).toMatch(resolvedChipHeightPattern);
  // Locked chip-height row so a taller ⋯ touch target cannot sink the right cluster below the task id.
  expect(actionsStyles.height).toMatch(resolvedChipHeightPattern);
  expect(actionsStyles.maxHeight).toMatch(resolvedChipHeightPattern);
  expect(actionsStyles.overflow).toBe("visible");
  expect(actionsStyles.marginLeft).toBe("auto");
  expect(actionsStyles.flex).toBe("0 0 auto");
}

function getCssBlocks(css: string, atRuleFragment: string): string[] {
  const re = /@media[^{}]*\{/g;
  const blocks: string[] = [];

  for (const match of css.matchAll(re)) {
    if (!match[0].includes(atRuleFragment)) continue;
    const start = match.index! + match[0].length;
    let depth = 1;
    let i = start;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    blocks.push(css.slice(start, i - 1));
  }

  expect(blocks.length).toBeGreaterThan(0);
  return blocks;
}

function getCssRuleBodies(section: string, selectorFragment: string): string[] {
  const bodies: string[] = [];
  const pattern = /([^{}]+)\{([\s\S]*?)\}/g;

  for (const match of section.matchAll(pattern)) {
    if (match[1].includes(selectorFragment)) {
      bodies.push(match[2]);
    }
  }

  expect(bodies.length, `Expected CSS rule for ${selectorFragment}`).toBeGreaterThan(0);
  return bodies;
}

function expectCssRuleToContain(section: string, selectorFragment: string, declaration: string): void {
  const bodies = getCssRuleBodies(section, selectorFragment);
  expect(bodies.some((body) => body.includes(declaration)), `${selectorFragment} should include ${declaration}`).toBe(true);
}

function expectCssRuleNotToContain(section: string, selectorFragment: string, declaration: string): void {
  const bodies = getCssRuleBodies(section, selectorFragment);
  for (const body of bodies) {
    expect(body, `${selectorFragment} should not include ${declaration}`).not.toContain(declaration);
  }
}

function expectHeaderActionsControlCenterline(container: HTMLElement, expected: {
  menu?: boolean;
}) {
  const actions = container.querySelector(".card-header-actions") as HTMLElement;
  expect(actions).toBeTruthy();
  expect(getComputedStyle(actions).alignItems).toBe("center");

  const menu = actions.querySelector(".card-menu-btn") as HTMLElement | null;
  if (expected.menu) {
    expect(menu).toBeTruthy();
    const menuStyles = getComputedStyle(menu!);
    expect(menuStyles.display).toBe("flex");
    expect(menuStyles.alignItems).toBe("center");
    expect(menuStyles.justifyContent).toBe("center");
    expect(menuStyles.lineHeight).toBe("1");
    expect(menuStyles.minHeight).toBe("");
  } else {
    expect(menu).toBeNull();
  }
}

function expectSizeBadgeAfterTaskId(container: HTMLElement, expected: boolean) {
  const header = container.querySelector(".card-header") as HTMLElement;
  const cardId = container.querySelector(".card-id") as HTMLElement;
  const headerBadges = container.querySelector(".card-header-badges") as HTMLElement | null;
  const actions = container.querySelector(".card-header-actions") as HTMLElement | null;
  const sizeBadge = container.querySelector(".card-size-badge") as HTMLElement | null;

  expect(header).toBeTruthy();
  expect(cardId).toBeTruthy();
  if (!expected) {
    expect(sizeBadge).toBeNull();
    return;
  }
  expect(sizeBadge).toBeTruthy();

  const sizeStyles = getComputedStyle(sizeBadge!);
  expect(sizeStyles.display).toBe("inline-flex");
  expect(sizeStyles.alignItems).toBe("center");
  expect(sizeStyles.lineHeight).toBe("1");
  expect(sizeBadge!.parentElement).toBe(header);
  expect(cardId.nextElementSibling).toBe(sizeBadge);
  expect(actions?.contains(sizeBadge)).toBe(false);
  expect(sizeBadge!.closest(".card-header-badges")).toBeNull();
  expect(container.querySelectorAll(".card-size-badge")).toHaveLength(1);

  if (headerBadges) {
    expect(sizeBadge!.compareDocumentPosition(headerBadges) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  } else {
    expect(sizeBadge!.nextElementSibling).toBe(actions);
  }
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
          status: "executing" as Task["status"],
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

  it("places a fast-mode size badge after the task id before wrapping header badges", () => {
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
    expectSizeBadgeAfterTaskId(sizedContainer, true);
    expect(headerBadges.contains(fastBadge)).toBe(true);
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

  it("aligns an in-progress card id, adjacent size badge, and three-dot actions while badges are present", () => {
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

    expect(headerBadges).toBeTruthy();
    expect(getComputedStyle(headerBadges).alignItems).toBe("center");
    expect(getComputedStyle(headerBadges).minHeight).toMatch(resolvedChipHeightPattern);
    expect(alignedContainer.querySelector(".card-send-back")).toBeNull();
    expect(actions.querySelector(".card-menu-btn")).toBeTruthy();
    expectSizeBadgeAfterTaskId(alignedContainer, true);
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

    expect(triageContainer.querySelector(".card-header-badges")).toBeNull();
    expect(actions.querySelector(".card-edit-btn")).toBeTruthy();
    expect(actions.querySelector(".card-delete-btn")).toBeTruthy();
    expectSizeBadgeAfterTaskId(triageContainer, true);
    expectSharedHeaderBaseline(triageContainer);
  });

  it("keeps adjacent size badges and trailing three-dot controls aligned across card states", () => {
    const { container: inProgressContainer } = render(
      <TaskCard
        task={makeTask({
          id: "FN-7928-IN-PROGRESS",
          column: "in-progress",
          status: "running" as Task["status"],
          size: "M",
        })}
        onOpenDetail={noop}
        addToast={noop}
        onMoveTask={async () => makeTask()}
      />,
    );

    expectSharedHeaderBaseline(inProgressContainer);
    expectHeaderActionsControlCenterline(inProgressContainer, { menu: true });
    expectSizeBadgeAfterTaskId(inProgressContainer, true);

    /*
     * FNXC:BoardCardActions 2026-07-16-02:24:
     * FN-8080 preserves the FN-8035 done-card contract: Archive/Revert live in the three-dot
     * card-menu-btn TaskContextMenu, so the trailing header actions expose the menu only.
     */
    const { container: doneContainer } = render(
      <TaskCard
        task={makeTask({
          id: "FN-7928-DONE",
          column: "done",
          status: "done" as Task["status"],
          size: "S",
        })}
        onOpenDetail={noop}
        addToast={noop}
        onArchiveTask={async () => makeTask()}
      />,
    );

    expectSharedHeaderBaseline(doneContainer);
    expectHeaderActionsControlCenterline(doneContainer, { menu: true });
    expectSizeBadgeAfterTaskId(doneContainer, true);

    const { container: triageContainer } = render(
      <TaskCard
        task={makeTask({
          id: "FN-7928-TRIAGE",
          column: "triage",
          status: undefined,
          size: "L",
        })}
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={async () => makeTask()}
        onDeleteTask={async () => makeTask()}
      />,
    );

    expectSharedHeaderBaseline(triageContainer);
    expectHeaderActionsControlCenterline(triageContainer, { menu: true });
    expectSizeBadgeAfterTaskId(triageContainer, true);

    const { container: menuAbsentContainer } = render(
      <TaskCard
        task={makeTask({
          id: "FN-7928-NO-MENU",
          column: "todo",
          status: "pending" as Task["status"],
          size: "M",
        })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expectSharedHeaderBaseline(menuAbsentContainer);
    expectHeaderActionsControlCenterline(menuAbsentContainer, {});
    expectSizeBadgeAfterTaskId(menuAbsentContainer, true);

    const { container: sizeAbsentContainer } = render(
      <TaskCard
        task={makeTask({
          id: "FN-7928-NO-SIZE",
          column: "in-progress",
          status: "running" as Task["status"],
          size: undefined,
        })}
        onOpenDetail={noop}
        addToast={noop}
        onMoveTask={async () => makeTask()}
      />,
    );

    expectSharedHeaderBaseline(sizeAbsentContainer);
    expectHeaderActionsControlCenterline(sizeAbsentContainer, { menu: true });
    expectSizeBadgeAfterTaskId(sizeAbsentContainer, false);

    const { container: awaitingInputContainer } = render(
      <TaskCard
        task={makeTask({
          id: "FN-7933-AWAITING-INPUT",
          column: "in-progress",
          status: "awaiting-user-input" as Task["status"],
          size: "M",
        })}
        onOpenDetail={noop}
        onOpenDetailWithTab={noop}
        addToast={noop}
        onMoveTask={async () => makeTask()}
      />,
    );

    expect(awaitingInputContainer.querySelector(".card-answer-questions-btn")).toBeTruthy();
    expectSharedHeaderBaseline(awaitingInputContainer);
    expectHeaderActionsControlCenterline(awaitingInputContainer, { menu: true });
    expectSizeBadgeAfterTaskId(awaitingInputContainer, true);
  });

  it("keeps the centered-id nudge and mobile header rhythm tokenized with the badge-wrap contract", () => {
    const cardHeaderRule = loadedCss.match(/\.card-header\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    const cardIdRule = loadedCss.match(/\.card-id\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    const actionsRule = loadedCss.match(/\.card-header-actions\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    expect(cardHeaderRule).toContain("align-items: flex-start;");
    expect(cardIdRule).toContain("min-height: var(--card-chip-height);");
    expect(cardIdRule).toContain("height: var(--card-chip-height);");
    expect(cardIdRule).toContain("max-height: var(--card-chip-height);");
    expect(cardIdRule).toContain("line-height: 1;");
    expect(cardIdRule).toContain("transform: translateY(calc(var(--space-xs) / 4));");
    expect(cardIdRule).not.toMatch(/translateY\(\d/);
    expect(actionsRule).toContain("align-items: center;");
    expect(actionsRule).toContain("height: var(--card-chip-height);");
    expect(actionsRule).toContain("max-height: var(--card-chip-height);");
    expect(actionsRule).toContain("overflow: visible;");
    expect(actionsRule).toContain("transform: translateY(calc(var(--space-xs) / 4));");
    expect(actionsRule).not.toMatch(/translateY\(\d/);
    expect(loadedCss).toContain(".card-id,\n  .card-header-badges,\n  .card-header-actions");
    expect(loadedCss).toContain("min-height: var(--card-chip-height-mobile);");
  });

  it("derives the size badge height from shared header-badge geometry", () => {
    const sizeBadgeRule = loadedCss.match(/\.card-size-badge\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";

    expect(sizeBadgeRule).toContain("align-self: center;");
    expect(sizeBadgeRule).not.toContain("min-height:");
  });

  it("locks the mobile three-dot menu, size, and Promote controls to the card rhythm", () => {
    const mobileSection = getCssBlocks(loadedCss, "max-width: 768px").join("\n");
    const menuTouchSection = getCssBlocks(loadedCss, "max-height: 480px").join("\n");

    expectCssRuleToContain(mobileSection, ".card-header-actions", "min-height: var(--card-chip-height-mobile);");
    expectCssRuleToContain(mobileSection, ".card-header-actions", "height: var(--card-chip-height-mobile);");
    expectCssRuleToContain(mobileSection, ".card-header-actions", "max-height: var(--card-chip-height-mobile);");
    expectCssRuleToContain(mobileSection, ".card-header-actions", "overflow: visible;");
    expectCssRuleToContain(mobileSection, ".card-header-actions", "align-items: center;");
    expectCssRuleToContain(mobileSection, ".card-header-actions", "gap: calc(var(--space-xs) / 2);");
    // Task id and trailing actions share the locked mobile chip row; the size chip uses shared badge geometry.
    expectCssRuleToContain(mobileSection, ".card-id", "height: var(--card-chip-height-mobile);");
    expectCssRuleToContain(mobileSection, ".card-id", "max-height: var(--card-chip-height-mobile);");
    expect(mobileSection).not.toMatch(/\.card-send-back\s*\{/);
    expectCssRuleToContain(mobileSection, ".card-send-back-btn", "line-height: 1;");
    expectCssRuleToContain(mobileSection, ".card-send-back-btn", "transform: translateY(calc(var(--space-xs) / -4));");
    expectCssRuleToContain(mobileSection, ".card-menu-btn", "line-height: 1;");
    /*
     * FNXC:TaskCardLayout 2026-07-17-15:00 (FN-8254):
     * jsdom does not apply the mobile media query. Inspect its shared declaration directly so
     * text, icon-only, size, PR, mission, and oversight chips cannot regain divergent box geometry.
     */
    const mobileHeaderChipSelectors = [
      ".card-status-badge",
      ".card-priority-badge",
      ".card-size-badge",
      ".card-planner-overseer-state",
      ".card-execution-mode-badge",
      ".card-pr-node-badge",
      ".card-mission-badge",
      ".card-oversight-badge",
    ];
    for (const selector of mobileHeaderChipSelectors) {
      expectCssRuleToContain(mobileSection, selector, "font-size: 0.5625rem;");
      expectCssRuleToContain(mobileSection, selector, "line-height: 1;");
      expectCssRuleToContain(mobileSection, selector, "padding: calc(var(--space-xs) / 4) calc((var(--space-xs) * 3) / 2);");
      expectCssRuleToContain(mobileSection, selector, "border: var(--btn-border-width) solid transparent;");
      expectCssRuleNotToContain(mobileSection, selector, "padding-block:");
    }
    expectCssRuleNotToContain(mobileSection, ".card-send-back-btn", "min-height:");
    expectCssRuleNotToContain(mobileSection, ".card-menu-btn", "min-height:");
    expectCssRuleToContain(menuTouchSection, ".card-menu-btn", "width: 28px;");
    expectCssRuleToContain(menuTouchSection, ".card-menu-btn", "height: 28px;");
    expectCssRuleToContain(menuTouchSection, ".card-menu-btn", "line-height: 1;");
    // Negative vertical margin cancels residual 28px layout contribution (same pattern as .card-edit-btn/.card-delete-btn).
    expectCssRuleToContain(menuTouchSection, ".card-menu-btn", "margin: -6px 0;");
    expectCssRuleToContain(menuTouchSection, ".card-menu-btn svg", "width: 16px;");
    expectCssRuleToContain(menuTouchSection, ".card-menu-btn svg", "height: 16px;");
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

  it("keeps assigned-agent badge text visible and truncated in mobile and narrow-card CSS", () => {
    const { container: assignedAgentContainer } = render(
      <TaskCard
        task={makeTask({ assignedAgentId: "agent-ci" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const label = assignedAgentContainer.querySelector(".card-agent-badge-text") as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.textContent).toBe("CI Engineer ...");

    const labelStyles = getComputedStyle(label);
    expect(labelStyles.display).not.toBe("none");
    expect(labelStyles.overflow).toBe("hidden");
    expect(labelStyles.textOverflow).toBe("ellipsis");
    expect(labelStyles.whiteSpace).toBe("nowrap");

    // jsdom does not apply media or container queries, so lock the source declaration that would otherwise hide this visible label.
    const mobileSection = getCssBlocks(loadedCss, "max-width: 768px").join("\n");
    expect(mobileSection).not.toMatch(/\.card-agent-badge-text\s*\{[^}]*display\s*:\s*none/);
    expect(loadedCss).not.toMatch(/@container\s+task-card\s*\(max-width:\s*240px\)\s*\{\s*\.card-agent-badge-text\s*\{[^}]*display\s*:\s*none/);
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
