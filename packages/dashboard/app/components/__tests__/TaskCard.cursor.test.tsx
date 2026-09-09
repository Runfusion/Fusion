import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { loadAllAppCss, loadComponentCss, readAppFile } from "../../test/cssFixture";
import { TaskCard } from "../TaskCard";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return new Proxy({}, {
    get: (_target, prop) => prop === "then" ? undefined : Stub,
    has: (_target, prop) => typeof prop === "string" && prop !== "then",
    getOwnPropertyDescriptor: (_target, prop) =>
      typeof prop === "string" && prop !== "then"
        ? { configurable: true, enumerable: true, value: Stub, writable: true }
        : undefined,
  });
});

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-provider={provider} />,
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
  addressPrFeedback: vi.fn(),
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(async () => ({ id: "M-001", title: "Cursor mission" })),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(async () => []),
  rebuildTaskSpec: vi.fn(),
  refreshPrStatus: vi.fn(),
  fetchBoardWorkflows: vi.fn(async () => ({ flagEnabled: true, defaultWorkflowId: "builtin:coding", workflows: [], taskWorkflowIds: {} })),
  fetchWorkflowSettingValues: vi.fn(async () => ({ stored: {}, effective: {}, orphaned: [] })),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn(), confirmWithSelect: vi.fn() }),
}));

type Specificity = readonly [number, number, number];

type CursorRule = {
  selector: string;
  value: string;
  specificity: Specificity;
  order: number;
};

function splitSelectorList(value: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") parenthesisDepth += 1;
    else if (char === ")") parenthesisDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "," && parenthesisDepth === 0 && bracketDepth === 0) {
      selectors.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  selectors.push(value.slice(start).trim());
  return selectors.filter(Boolean);
}

function findBalancedEnd(value: string, start: number, open: string, close: string): number {
  let depth = 1;
  let quote: string | null = null;
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index;
  }
  throw new Error(`Unbalanced ${open}${close} in CSS selector`);
}

function addSpecificity(left: Specificity, right: Specificity): Specificity {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function compareSpecificity(left: Specificity, right: Specificity): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function maxSpecificity(selectors: string[]): Specificity {
  return selectors.map(selectorSpecificity).reduce<Specificity>(
    (maximum, candidate) => compareSpecificity(candidate, maximum) > 0 ? candidate : maximum,
    [0, 0, 0],
  );
}

function selectorSpecificity(selector: string): Specificity {
  let result: Specificity = [0, 0, 0];
  let index = 0;

  while (index < selector.length) {
    const char = selector[index];
    if (char === "#") {
      result = addSpecificity(result, [1, 0, 0]);
      index += 1;
      while (/[\w-]/.test(selector[index] ?? "")) index += 1;
      continue;
    }
    if (char === ".") {
      result = addSpecificity(result, [0, 1, 0]);
      index += 1;
      while (/[\w-]/.test(selector[index] ?? "")) index += 1;
      continue;
    }
    if (char === "[") {
      result = addSpecificity(result, [0, 1, 0]);
      index = findBalancedEnd(selector, index, "[", "]") + 1;
      continue;
    }
    if (char === ":") {
      const pseudoElement = selector[index + 1] === ":";
      index += pseudoElement ? 2 : 1;
      const nameStart = index;
      while (/[\w-]/.test(selector[index] ?? "")) index += 1;
      const name = selector.slice(nameStart, index).toLowerCase();
      if (pseudoElement) result = addSpecificity(result, [0, 0, 1]);
      else if (selector[index] === "(" && ["is", "not", "has", "where"].includes(name)) {
        const end = findBalancedEnd(selector, index, "(", ")");
        if (name !== "where") {
          result = addSpecificity(result, maxSpecificity(splitSelectorList(selector.slice(index + 1, end))));
        }
        index = end + 1;
        continue;
      } else if (!pseudoElement) {
        result = addSpecificity(result, [0, 1, 0]);
      }
      if (selector[index] === "(") index = findBalancedEnd(selector, index, "(", ")") + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      result = addSpecificity(result, [0, 0, 1]);
      index += 1;
      while (/[\w-]/.test(selector[index] ?? "")) index += 1;
      continue;
    }
    if (char === "\\") index += 2;
    else index += 1;
  }

  return result;
}

function parseCursorRules(css: string): CursorRule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CursorRule[] = [];
  let order = 0;

  function walk(block: string): void {
    let position = 0;
    while (position < block.length) {
      const open = block.indexOf("{", position);
      if (open === -1) return;
      const close = findBalancedEnd(block, open, "{", "}");
      const rawHeader = block.slice(position, open);
      const header = rawHeader.slice(rawHeader.lastIndexOf(";") + 1).trim();
      const body = block.slice(open + 1, close);

      if (header.startsWith("@")) {
        walk(body);
      } else if (header) {
        const cursorDeclarations = [...body.matchAll(/(?:^|;)\s*cursor\s*:\s*([^;}]+)/g)];
        const declaration = cursorDeclarations.at(-1)?.[1].trim();
        if (declaration) {
          expect(declaration, `${header} must not use !important to win the cursor cascade`).not.toContain("!important");
          for (const selector of splitSelectorList(header)) {
            rules.push({ selector, value: declaration, specificity: selectorSpecificity(selector), order });
          }
          order += 1;
        }
      }
      position = close + 1;
    }
  }

  walk(source);
  return rules;
}

const cursorRules = parseCursorRules(loadAllAppCss());
const tileRootSelector = ".card[data-id]:not(.card-editing)";
const tileDescendantSelector = ".card[data-id] *:not(:disabled, :disabled *, .card-editing *)";
const tileTextEntrySelector = ".card[data-id] :is(input, textarea, select):not(:disabled)";
const activePanSelector = ".board.board-workflow-columns.is-mouse-panning :is(*, .card)";

function resolveOwnCursor(element: Element): string | undefined {
  let winner: CursorRule | undefined;
  for (const rule of cursorRules) {
    // FNXC:DashboardTests 2026-08-28-09:42: Pseudo-elements are painted fragments, never DOM Elements. jsdom rejects vendor pseudo-elements instead of returning false, so exclude them before evaluating the remaining shipped selectors.
    if (/::[\w-]+/.test(rule.selector)) continue;
    let matches = false;
    try {
      matches = element.matches(rule.selector);
    } catch (error) {
      throw new Error(`jsdom could not evaluate shipped cursor selector ${rule.selector}`, { cause: error });
    }
    if (!matches) continue;
    if (!winner || compareSpecificity(rule.specificity, winner.specificity) > 0
      || (compareSpecificity(rule.specificity, winner.specificity) === 0 && rule.order >= winner.order)) {
      winner = rule;
    }
  }
  return winner?.value;
}

function resolveCursor(element: Element): string {
  return resolveOwnCursor(element) ?? (element.parentElement ? resolveCursor(element.parentElement) : "auto");
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Cursor fixture ${id}`,
    description: "A real TaskCard cursor fixture",
    column: "todo",
    status: undefined as never,
    steps: [],
    currentStep: 0,
    dependencies: [],
    log: [],
    createdAt: "2026-08-28T09:42:00.000Z",
    updatedAt: "2026-08-28T09:42:00.000Z",
    ...overrides,
  } as Task;
}

const noop = () => {};
const updateTask = async (id: string) => makeTask(id);

type CursorFixtures = {
  board: HTMLElement;
  cards: HTMLElement[];
  minimalCard: HTMLElement;
  populatedCard: HTMLElement;
  pausedCard: HTMLElement;
  editingCard: HTMLElement;
};

function renderCursorFixtures(): CursorFixtures {
  const board = document.createElement("main");
  board.className = "board board-workflow-columns";
  document.body.append(board);

  const minimal = makeTask("FN-229-MIN");
  const populated = makeTask("FN-229-POP", {
    column: "in-progress",
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Cursor contract", status: "pending" },
    ],
    currentStep: 1,
    dependencies: ["FN-100"],
    missionId: "M-001",
    modifiedFiles: ["packages/dashboard/app/components/TaskCard.css"],
    retrySummary: {
      stuckKill: 0,
      recovery: 1,
      taskDone: 0,
      worktreeSession: 0,
      workflowStep: 0,
      verification: 0,
      postReviewFix: 0,
      mergeConflict: 0,
      branchConflict: 0,
      reviewerContext: 0,
      reviewerFallback: 0,
      total: 1,
    },
    prInfo: { number: 229, url: "https://github.com/runfusion/fusion/pull/229", status: "open", title: "Cursor contract" } as Task["prInfo"],
    githubTracking: {
      enabled: true,
      issue: { number: 229, url: "https://github.com/runfusion/fusion/issues/229", state: "open", title: "Cursor contract" },
    } as Task["githubTracking"],
    sourceMetadata: { nearDuplicateOf: "FN-100" },
  });
  const paused = makeTask("FN-229-PAUSED", { paused: true });
  const editing = makeTask("FN-229-EDIT");

  render(
    <>
      {[minimal, populated, paused, editing].map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          projectId="project-fn-229"
          onOpenDetail={noop}
          onOpenDetailWithTab={noop}
          onOpenMission={noop}
          onOpenPullRequest={noop}
          onUpdateTask={updateTask}
          onDeleteTask={updateTask}
          onRetryTask={updateTask}
          onResetTask={updateTask}
          onDuplicateTask={updateTask}
          addToast={noop}
          prNode={task.id === populated.id ? { id: "PR-229", state: "open", prNumber: 229 } : undefined}
        />
      ))}
    </>,
    { container: board },
  );

  const cards = [minimal.id, populated.id, paused.id, editing.id].map((id) => board.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!);
  expect(cards.every(Boolean)).toBe(true);
  const [minimalCard, populatedCard, pausedCard, editingCard] = cards;
  expect(pausedCard.classList.contains("paused")).toBe(true);
  expect(editingCard.classList.contains("card-editing")).toBe(false);
  fireEvent.click(editingCard.querySelector(".card-edit-btn")!);
  expect(editingCard.classList.contains("card-editing")).toBe(true);

  const nonClickableDependencyBadge = document.createElement("span");
  nonClickableDependencyBadge.className = "card-dep-badge";
  nonClickableDependencyBadge.textContent = "FN-101";
  const fanoutBadge = document.createElement("span");
  fanoutBadge.className = "card-fanout-badge";
  fanoutBadge.textContent = "Blocks 1";
  populatedCard.append(nonClickableDependencyBadge, fanoutBadge);

  return { board, cards, minimalCard, populatedCard, pausedCard, editingCard };
}

function cardSurfaces(card: HTMLElement): Element[] {
  return [card, ...card.querySelectorAll("*")];
}

function expectCursorAcrossCard(card: HTMLElement, expected: string, includeDisabled = false): void {
  for (const element of cardSurfaces(card)) {
    if (!includeDisabled && element.matches(":disabled, :disabled *")) continue;
    expect(resolveCursor(element), element.outerHTML).toBe(expected);
  }
}

function mediaBlocks(css: string): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));
  const blocks: string[] = [];
  const pattern = /@media\b[^{}]*\{/g;
  for (const match of source.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = findBalancedEnd(source, open, "{", "}");
    blocks.push(source.slice(open + 1, close));
  }
  return blocks;
}

const taskControlClasses = [
  "card-retry-badge",
  "card-pr-node-badge",
  "card-dep-badge clickable",
  "card-mission-badge",
  "card-session-files",
  "card-duplicate-dismiss",
  "card-create-pr-action",
  "card-steps-toggle",
  "card-edit-btn",
  "card-answer-questions-btn",
  "card-menu-btn",
  "card-delete-btn",
  "card-send-back-btn",
] as const;

function appendDisabledControls(card: HTMLElement): {
  waitElements: Element[];
  unavailableElements: Element[];
} {
  const waitButton = document.createElement("button");
  waitButton.className = "card-create-pr-action";
  waitButton.disabled = true;
  const waitIcon = document.createElement("svg");
  const waitIconPath = document.createElement("path");
  waitIcon.append(waitIconPath);
  waitButton.append(waitIcon);

  const unavailableButton = document.createElement("button");
  unavailableButton.className = "card-promote-action card-send-back-btn";
  unavailableButton.disabled = true;
  const unavailableIcon = document.createElement("svg");
  const unavailableIconPath = document.createElement("path");
  unavailableIcon.append(unavailableIconPath);
  unavailableButton.append(unavailableIcon);
  card.append(waitButton, unavailableButton);

  return {
    waitElements: [waitButton, waitIcon, waitIconPath],
    unavailableElements: [unavailableButton, unavailableIcon, unavailableIconPath],
  };
}

/*
FNXC:TaskCardCursorTest 2026-08-28-13:19 (FN-229):
Board task tiles are clickable surfaces, so desktop and tablet acceptance requires a uniform pointing hand at rest and a closed grabbing hand throughout active pan. Disabled controls and inline editing retain native state/form cursors until the pan override applies.

Touch mobile has no hover cursor and disables the Board mouse-pan hook; no cursor declaration may introduce a breakpoint-specific branch. ListView cards, the portaled context menu, the unbound skeleton, and shared non-task cards stay outside this selector. The `.card.queued` variant remains unreachable because no production TaskCard host passes `queued`.
*/
describe("TaskCard shipped cursor cascade (FN-229)", () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it("resolves every minimal, populated, and paused tile surface to pointer at rest", () => {
    const { minimalCard, populatedCard, pausedCard } = renderCursorFixtures();

    for (const card of [minimalCard, populatedCard, pausedCard]) {
      expectCursorAcrossCard(card, "pointer");
      for (const element of cardSurfaces(card)) {
        if (element.matches(":disabled, :disabled *")) continue;
        expect(resolveCursor(element), element.outerHTML).not.toBe("default");
      }
    }

    expect(populatedCard.querySelectorAll("button, [role=button], a").length).toBeGreaterThan(5);
    expect(populatedCard.querySelector(".card-session-files")).not.toBeNull();
    expect(populatedCard.querySelector(".card-dep-badge.clickable")).not.toBeNull();
    expect(populatedCard.querySelector(".card-dep-badge:not(.clickable)")).not.toBeNull();
    expect(populatedCard.querySelector(".card-fanout-badge")).not.toBeNull();
    expect(populatedCard.querySelector(".card-mission-badge")).not.toBeNull();
    expect(populatedCard.querySelector(".card-retry-badge")).not.toBeNull();
    expect(populatedCard.querySelector(".card-github-badge")).not.toBeNull();
  });

  it("keeps a paused tile root and its children on the pointing hand", () => {
    const { pausedCard } = renderCursorFixtures();
    const taskCardCss = loadComponentCss("TaskCard.css");
    const pausedRule = taskCardCss.match(/\.card\.paused\s*\{([^}]*)\}/)?.[1];

    expect(pausedCard.classList.contains("card")).toBe(true);
    expect(pausedCard.classList.contains("paused")).toBe(true);
    expectCursorAcrossCard(pausedCard, "pointer");
    expect(pausedRule).toContain("opacity: 0.55");
    expect(pausedRule).toContain("border-left: 3px solid var(--text-muted)");
    expect(pausedRule).not.toMatch(/\bcursor\s*:/);
  });

  it("resolves every tile surface to grabbing for the full active pan", () => {
    const { board, cards, minimalCard } = renderCursorFixtures();
    appendDisabledControls(minimalCard);
    board.classList.add("is-mouse-panning");

    for (const card of cards) expectCursorAcrossCard(card, "grabbing", true);
  });

  it("keeps editing on form cursors until an active pan begins", () => {
    const { board, editingCard } = renderCursorFixtures();
    const textarea = editingCard.querySelector<HTMLTextAreaElement>(".card-edit-desc-textarea")!;
    const content = editingCard.querySelector<HTMLElement>(".card-editing-content")!;

    expect(resolveCursor(editingCard)).toBe("default");
    expect(resolveCursor(content)).toBe("default");
    expect(resolveCursor(textarea)).toBe("auto");

    textarea.disabled = true;
    expect(resolveCursor(textarea)).toBe("not-allowed");

    board.classList.add("is-mouse-panning");
    for (const element of cardSurfaces(editingCard)) expect(resolveCursor(element)).toBe("grabbing");
  });

  it("does not change shared cards, the skeleton, ListView, or portaled menus", () => {
    const sharedCard = document.createElement("div");
    sharedCard.className = "card cc-stat-card";
    const sharedButton = document.createElement("button");
    sharedButton.className = "btn";
    sharedCard.append(sharedButton);

    const skeleton = document.createElement("section");
    skeleton.className = "board-workflows-skeleton__column card";
    const skeletonButton = document.createElement("button");
    skeletonButton.className = "btn";
    skeleton.append(skeletonButton);

    const listCard = document.createElement("article");
    listCard.className = "list-card";

    const portaledMenu = document.createElement("div");
    portaledMenu.className = "task-context-menu";
    const menuItem = document.createElement("button");
    menuItem.className = "task-context-menu__item";
    portaledMenu.append(menuItem);
    document.body.append(sharedCard, skeleton, listCard, portaledMenu);

    for (const element of [sharedCard, sharedButton, skeleton, skeletonButton, listCard, portaledMenu, menuItem]) {
      expect(element.matches(tileRootSelector), element.outerHTML).toBe(false);
      expect(element.matches(tileDescendantSelector), element.outerHTML).toBe(false);
    }
    expect(resolveCursor(sharedCard)).not.toBe("pointer");
    expect(resolveCursor(sharedButton)).toBe("pointer");
    expect(resolveCursor(skeletonButton)).toBe("pointer");
    expect(resolveCursor(listCard)).toBe("pointer");
    expect(resolveCursor(menuItem)).toBe("pointer");
  });

  it("preserves disabled state cursors at rest and overrides nested icons while panning", () => {
    const { board, minimalCard } = renderCursorFixtures();
    const { waitElements, unavailableElements } = appendDisabledControls(minimalCard);

    for (const element of waitElements) expect(resolveCursor(element)).toBe("wait");
    for (const element of unavailableElements) expect(resolveCursor(element)).toBe("not-allowed");

    board.classList.add("is-mouse-panning");
    for (const element of [...waitElements, ...unavailableElements]) {
      expect(resolveCursor(element)).toBe("grabbing");
    }
  });

  it("covers every TaskCard-only control class at rest and while panning", () => {
    const { board, minimalCard } = renderCursorFixtures();
    const source = readAppFile("components/TaskCard.tsx");
    const controls = taskControlClasses.map((classNames) => {
      for (const className of classNames.split(" ")) expect(source).toContain(className);
      const control = document.createElement("button");
      control.className = classNames;
      minimalCard.append(control);
      expect(resolveCursor(control), classNames).toBe("pointer");
      return control;
    });

    board.classList.add("is-mouse-panning");
    for (const control of controls) expect(resolveCursor(control), control.className).toBe("grabbing");
  });

  it("ratchets tile specificity, pan dominance, responsive scope, and TaskCard markup", () => {
    const taskCardCss = loadComponentCss("TaskCard.css");
    const boardCss = loadComponentCss("Board.css");
    const stylesCss = readAppFile("styles.css");
    const taskCardSource = readAppFile("components/TaskCard.tsx");
    const tileSpecificities = [
      selectorSpecificity(tileRootSelector),
      selectorSpecificity(tileDescendantSelector),
      selectorSpecificity(tileTextEntrySelector),
    ];
    const panSpecificity = selectorSpecificity(activePanSelector);

    expect(tileSpecificities).toEqual([[0, 3, 0], [0, 3, 0], [0, 3, 1]]);
    expect(panSpecificity).toEqual([0, 4, 0]);
    for (const specificity of tileSpecificities) expect(compareSpecificity(panSpecificity, specificity)).toBeGreaterThan(0);

    expect(taskCardCss.match(/cursor\s*:\s*pointer\s*;/g)).toHaveLength(1);
    expect(taskCardCss).toMatch(/\.card\[data-id\]:not\(\.card-editing\),\s*\.card\[data-id\]\s+\*:not\(:disabled,\s*:disabled\s+\*,\s*\.card-editing\s+\*\)\s*\{[^}]*cursor:\s*pointer;/);
    expect(taskCardCss).toMatch(/\.card\[data-id\]\s+:is\(input,\s*textarea,\s*select\):not\(:disabled\)\s*\{[^}]*cursor:\s*auto;/);
    expect(taskCardCss.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/[^{}]+\{\s*\}/);
    expect(taskCardCss).not.toMatch(/cursor\s*:[^;}]*!important/);
    for (const css of [taskCardCss, boardCss, stylesCss]) {
      for (const body of mediaBlocks(css)) expect(body).not.toMatch(/\bcursor\s*:/);
    }

    expect(boardCss).toMatch(/\.board\.board-workflow-columns\.is-mouse-panning\s*\{\s*cursor:\s*grabbing;\s*user-select:\s*none;\s*\}/);
    expect(boardCss).toMatch(/\.board\.board-workflow-columns\.is-mouse-panning\s+:is\(\*,\s*\.card\)\s*\{\s*cursor:\s*grabbing;\s*\}/);
    expect(taskCardSource.match(/data-id=\{task\.id\}/g)).toHaveLength(2);
  });
});
