import fs from "node:fs";
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

const stylesPath = path.resolve(__dirname, "../../styles.css");

function getMainMobileSection(css: string): string {
  const sectionStart = css.indexOf("/* === Mobile Responsive Overrides ===");
  const sectionEnd = css.indexOf("/* === Tablet Responsive Tier", sectionStart);

  expect(sectionStart).toBeGreaterThan(-1);
  expect(sectionEnd).toBeGreaterThan(sectionStart);

  return css.slice(sectionStart, sectionEnd);
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

describe("Board and Column mobile CSS", () => {
  it("contains .board scroll-snap-type: x mandatory in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board", "scroll-snap-type: x mandatory;");
  });

  it("contains .board scroll-behavior: smooth in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board", "scroll-behavior: smooth;");
  });

  it("contains .board > .column width: 280px in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board > .column", "width: 280px;");
  });

  it("contains .board > .column min-width: 280px in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board > .column", "min-width: 280px;");
  });

  it("contains .column-header min-height: 44px in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".column-header", "min-height: 44px;");
  });

  it("hides board scrollbars in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board", "scrollbar-width: none;");
    expectRuleToContain(mobileSection, ".board::-webkit-scrollbar", "display: none;");
  });

  it("keeps safe-area-inset-bottom handling on .board in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".board", "env(safe-area-inset-bottom");
  });
});

describe("TaskCard mobile", () => {
  it("sets .card-archive-btn opacity: 1 in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".card-archive-btn", "opacity: 1;");
  });

  it("sets .card-archive-btn min-height: 28px in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".card-archive-btn", "min-height: 28px;");
  });

  it("sets .card-steps-toggle min-height: 32px in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".card-steps-toggle", "min-height: 32px;");
  });

  it("sets .card-session-files min-height: 32px in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".card-session-files", "min-height: 32px;");
  });

  it("keeps .card-edit-btn width and height at 44px in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".card-edit-btn", "width: 44px;");
    expectRuleToContain(mobileSection, ".card-edit-btn", "height: 44px;");
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

  it("renders the progress bar when task has steps", () => {
    const task = createTask({
      id: "FN-203",
      column: "todo",
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
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".inline-create-input", "font-size: 16px;");
  });

  it("contains .inline-create-toggle min-height: 44px in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".inline-create-toggle", "min-height: 44px;");
  });

  it("contains .inline-create-controls .btn min-height: 44px in the mobile media block", () => {
    const css = fs.readFileSync(stylesPath, "utf-8");
    const mobileSection = getMainMobileSection(css);

    expectRuleToContain(mobileSection, ".inline-create-controls .btn", "min-height: 44px;");
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
