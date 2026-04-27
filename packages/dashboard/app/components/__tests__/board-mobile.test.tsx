import fs from "node:fs";
import { loadAllAppCss } from "../../test/cssFixture";
import path from "node:path";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Task, TaskDetail, Settings } from "@fusion/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTaskDetail } from "../../api";
import { InlineCreateCard } from "../InlineCreateCard";
import { TaskCard } from "../TaskCard";

vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 30_000,
    groupOverlappingFiles: true,
    autoMerge: true,
  } satisfies Partial<Settings>),
  updateGlobalSettings: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    isConnected: false,
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  }),
}));

vi.mock("../../hooks/useSessionFiles", () => ({
  useSessionFiles: () => ({ files: [], loading: false }),
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));


function getMainMobileSection(css: string): string {
  // Mobile rules now live across many co-located component CSS files (each
  // owns its own @media (max-width: 768px) block) instead of one monolith
  // section in styles.css. Concatenate every <=768px media block in the
  // bundle so these assertions remain location-agnostic.
  const re = /@media\s*\([^)]*max-width:\s*768px[^)]*\)\s*\{/g;
  const blocks: string[] = [];

  for (const match of css.matchAll(re)) {
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
  return blocks.join("\n");
}

function expectRuleToContain(section: string, selectorFragment: string, declaration: string): void {
  const pattern = /([^{}]+)\{([\s\S]*?)\}/g;
  let foundSelector = false;
  let foundDeclaration = false;

  for (const match of section.matchAll(pattern)) {
    const selector = match[1];
    const block = match[2];

    if (!selector.includes(selectorFragment)) {
      continue;
    }

    foundSelector = true;
    if (block.includes(declaration)) {
      foundDeclaration = true;
      break;
    }
  }

  expect(foundSelector).toBe(true);
  expect(foundDeclaration).toBe(true);
}

function createTask(overrides: Partial<Task> & { id?: string } = {}): Task {
  return {
    id: overrides.id ?? "FN-1139",
    title: overrides.title,
    description: overrides.description ?? "Mobile board test task",
    column: overrides.column ?? "todo",
    dependencies: overrides.dependencies ?? [],
    steps: overrides.steps ?? [],
    currentStep: overrides.currentStep ?? 0,
    log: overrides.log ?? [],
    createdAt: overrides.createdAt ?? "2026-04-08T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-08T00:00:00.000Z",
    ...overrides,
  } as Task;
}

beforeEach(() => {
  vi.clearAllMocks();
  if (typeof window !== "undefined") {
    window.localStorage.clear();
  }
});

describe("Board desktop column width CSS", () => {
  it("keeps desktop board columns equal width via 6x minmax(300px, 1fr) grid", () => {
    const css = loadAllAppCss();

    expectRuleToContain(css, ".board", "grid-template-columns: repeat(6, minmax(300px, 1fr));");
  });

  it("constrains header content so actions cannot stretch column width", () => {
    const css = loadAllAppCss();

    expectRuleToContain(css, ".column-header", "min-width: 0;");
    expectRuleToContain(css, ".column-header h2", "min-width: 0;");
    expectRuleToContain(css, ".column-header h2", "overflow: hidden;");
    expectRuleToContain(css, ".column-header h2", "text-overflow: ellipsis;");
    expectRuleToContain(css, ".column-header h2", "white-space: nowrap;");
  });
});

describe("Board and Column mobile CSS", () => {
  it("contains .board scroll-snap-type: x mandatory in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board", "scroll-snap-type: x mandatory;");
  });

  it("contains .board scroll-behavior: smooth in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board", "scroll-behavior: smooth;");
  });

  it("contains .board > .column width: 300px in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board > .column", "width: 300px;");
  });

  it("contains .board > .column min-width: 300px in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board > .column", "min-width: 300px;");
  });

  it("does not force .column-header min-height in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    // Column headers use natural height from padding/font — no forced min-height
    const pattern = /([^{}]+)\{([\s\S]*?)\}/g;
    for (const match of mobileSection.matchAll(pattern)) {
      const selector = match[1].trim();
      const block = match[2];
      // Match exactly ".column-header" (not ".column-header .btn-icon" etc.)
      if (selector !== ".column-header") continue;
      // No rule targeting .column-header should set min-height
      expect(block).not.toContain("min-height");
    }
  });

  it("hides board scrollbars in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board", "scrollbar-width: none;");
    expectRuleToContain(mobileSection, ".board::-webkit-scrollbar", "display: none;");
  });

  it("uses simple padding-bottom on .board (safe-area handled by parent)", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    // Board padding-bottom is just var(--space-md) to avoid double-counting safe-area-inset-bottom
    // which is already handled by .project-content--with-mobile-nav padding
    expectRuleToContain(mobileSection, ".board", "padding-bottom: var(--space-md);");
  });
});

describe("TaskCard mobile", () => {
  it("sets .card-archive-btn opacity: 1 in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".card-archive-btn", "opacity: 1;");
  });

  it("does not force .card-archive-btn min-height in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    // Archive buttons use natural height from padding — no forced min-height
    const pattern = /([^{}]+)\{([\s\S]*?)\}/g;
    for (const match of mobileSection.matchAll(pattern)) {
      const selector = match[1].trim();
      const block = match[2];
      if (!selector.includes(".card-archive-btn") && !selector.includes(".card-unarchive-btn")) continue;
      // Archive/unarchive buttons should not have min-height in mobile block
      expect(block).not.toContain("min-height");
    }
  });

  it("does not force .card-steps-toggle min-height in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    // Steps toggle uses natural height from content and padding
    const pattern = /([^{}]+)\{([\s\S]*?)\}/g;
    for (const match of mobileSection.matchAll(pattern)) {
      const selector = match[1].trim();
      const block = match[2];
      if (selector !== ".card-steps-toggle") continue;
      expect(block).not.toContain("min-height");
    }
  });

  it("does not force .card-session-files min-height in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    // Session files button uses natural height
    const pattern = /([^{}]+)\{([\s\S]*?)\}/g;
    for (const match of mobileSection.matchAll(pattern)) {
      const selector = match[1].trim();
      const block = match[2];
      if (selector !== ".card-session-files") continue;
      expect(block).not.toContain("min-height");
    }
  });

  it("keeps TaskCard footer row on one line", () => {
    const css = loadAllAppCss();
    expectRuleToContain(css, ".card-footer-row", "flex-wrap: nowrap;");
  });

  it("keeps TaskCard timer chip right-aligned with files metadata", () => {
    const css = loadAllAppCss();
    expectRuleToContain(css, ".card-time-indicator", "margin-left: auto;");
  });

  it("truncates TaskCard files-changed text instead of wrapping", () => {
    const css = loadAllAppCss();
    expectRuleToContain(css, ".card-session-files span", "text-overflow: ellipsis;");
    expectRuleToContain(css, ".card-session-files span", "white-space: nowrap;");
  });

  it("sets .card-edit-btn width and height to 32px in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".card-edit-btn", "width: 32px;");
    expectRuleToContain(mobileSection, ".card-edit-btn", "height: 32px;");
  });

  it("opens task detail on quick tap", async () => {
    const task = createTask({ id: "FN-200", column: "todo" });

    const onOpenDetail = vi.fn();
    const { container } = render(
      <TaskCard task={task} onOpenDetail={onOpenDetail} addToast={vi.fn()} />,
    );

    const card = container.querySelector(`[data-id="${task.id}"]`) as HTMLElement;
    expect(card).toBeTruthy();

    fireEvent.touchStart(card, {
      touches: [{ clientX: 100, clientY: 100 }],
    });
    fireEvent.touchEnd(card, {
      changedTouches: [{ clientX: 100, clientY: 100 }],
    });

    // TaskCard calls onOpenDetail directly with the task - no fetchTaskDetail needed for card taps
    expect(onOpenDetail).toHaveBeenCalledWith(task);
  });

  it("does not open task detail when touch gesture indicates scroll", async () => {
    const task = createTask({ id: "FN-201", column: "todo" });
    vi.mocked(fetchTaskDetail).mockResolvedValueOnce({
      ...task,
      prompt: "",
      attachments: [],
    } as TaskDetail);

    const { container } = render(
      <TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} />,
    );

    const card = container.querySelector(`[data-id="${task.id}"]`) as HTMLElement;
    expect(card).toBeTruthy();

    fireEvent.touchStart(card, {
      touches: [{ clientX: 100, clientY: 100 }],
    });
    fireEvent.touchMove(card, {
      touches: [{ clientX: 150, clientY: 100 }],
    });
    fireEvent.touchEnd(card, {
      changedTouches: [{ clientX: 150, clientY: 100 }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchTaskDetail).not.toHaveBeenCalled();
  });

  it("does not open task detail when tapping the edit button", async () => {
    const task = createTask({ id: "FN-204", column: "todo" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={vi.fn()}
        onUpdateTask={vi.fn().mockResolvedValue(task)}
      />,
    );

    const editButton = screen.getByRole("button", { name: "Edit task" });
    fireEvent.touchStart(editButton, {
      touches: [{ clientX: 100, clientY: 100 }],
    });
    fireEvent.touchEnd(editButton, {
      changedTouches: [{ clientX: 100, clientY: 100 }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchTaskDetail).not.toHaveBeenCalled();
  });

  it("does not open task detail when tapping the steps toggle", async () => {
    const task = createTask({
      id: "FN-205",
      column: "todo",
      status: "executing",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "in-progress" },
      ],
    });

    render(
      <TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} />,
    );

    const toggleButton = screen.getByRole("button", { name: "Show steps" });
    fireEvent.touchStart(toggleButton, {
      touches: [{ clientX: 100, clientY: 100 }],
    });
    fireEvent.touchEnd(toggleButton, {
      changedTouches: [{ clientX: 100, clientY: 100 }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchTaskDetail).not.toHaveBeenCalled();
  });

  it("does not open task detail when touch target is an SVG element inside a button", async () => {
    const task = createTask({
      id: "FN-206",
      column: "todo",
      status: "executing",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "in-progress" },
      ],
    });

    render(
      <TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} />,
    );

    const toggleButton = screen.getByRole("button", { name: "Show steps" });
    const svgTarget = toggleButton.querySelector("svg");
    expect(svgTarget).toBeTruthy();

    fireEvent.touchStart(svgTarget as SVGElement, {
      touches: [{ clientX: 100, clientY: 100 }],
    });
    fireEvent.touchEnd(svgTarget as SVGElement, {
      changedTouches: [{ clientX: 100, clientY: 100 }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchTaskDetail).not.toHaveBeenCalled();
  });

  it("renders edit button with aria-label in editable columns", () => {
    const task = createTask({ id: "FN-202", column: "todo" });

    render(
      <TaskCard
        task={task}
        onOpenDetail={vi.fn()}
        addToast={vi.fn()}
        onUpdateTask={vi.fn().mockResolvedValue(task)}
      />,
    );

    expect(screen.getByRole("button", { name: "Edit task" })).toBeTruthy();
  });

  it("hides the progress bar for todo cards that are not executing", () => {
    const task = createTask({
      id: "FN-203",
      column: "todo",
      status: "queued",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "in-progress" },
      ],
    });

    const { container } = render(
      <TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} />,
    );

    expect(container.querySelector(".card-progress-bar")).toBeNull();
  });

  it("renders the progress bar when a todo card is executing", () => {
    const task = createTask({
      id: "FN-207",
      column: "todo",
      status: "executing",
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "in-progress" },
      ],
    });

    const { container } = render(
      <TaskCard task={task} onOpenDetail={vi.fn()} addToast={vi.fn()} />,
    );

    expect(container.querySelector(".card-progress-bar")).toBeTruthy();
  });
});

describe("InlineCreateCard mobile", () => {
  it("contains .inline-create-input font-size: 16px in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".inline-create-input", "font-size: 16px;");
  });

  it("contains .inline-create-toggle min-height: 36px in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".inline-create-toggle", "min-height: 36px;");
  });

  it("contains .inline-create-controls .btn min-height: 36px in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".inline-create-controls .btn", "min-height: 36px;");
  });

  it("contains .inline-create-priority-select min-height: 36px in the mobile media block", () => {
    const css = loadAllAppCss();
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".inline-create-priority-select", "min-height: 36px;");
  });

  it("renders Plan and Subtask buttons when expanded", () => {
    render(
      <InlineCreateCard
        tasks={[]}
        onSubmit={vi.fn().mockResolvedValue(createTask({ id: "FN-300" }))}
        onCancel={vi.fn()}
        addToast={vi.fn()}
        availableModels={[]}
      />,
    );

    fireEvent.click(screen.getByTestId("inline-create-toggle"));

    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subtask" })).toBeTruthy();
  });

  it("renders dependency dropdown when Deps button is clicked", () => {
    render(
      <InlineCreateCard
        tasks={[createTask({ id: "FN-301", description: "Existing dependency task" })]}
        onSubmit={vi.fn().mockResolvedValue(createTask({ id: "FN-302" }))}
        onCancel={vi.fn()}
        addToast={vi.fn()}
        availableModels={[]}
      />,
    );

    fireEvent.click(screen.getByTestId("inline-create-toggle"));
    fireEvent.click(screen.getByRole("button", { name: /Deps/i }));

    expect(document.querySelector(".dep-dropdown")).toBeTruthy();
  });
});
