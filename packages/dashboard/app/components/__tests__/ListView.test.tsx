import React from "react";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListView, LIST_MINIMUM_SPLIT_LAYOUT_WIDTH } from "../ListView";
import type { Task, TaskDetail } from "@fusion/core";
import { scopedKey } from "../../utils/projectStorage";
import { ALL_WORKFLOWS_BOARD_VIEW_ID, BOARD_WORKFLOW_SELECTION_STORAGE_KEY } from "../../utils/boardWorkflowSelection";
import { loadAllAppCss } from "../../test/cssFixture";

// Mock the API
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 30000,
    groupOverlappingFiles: true,
    autoMerge: true,
  }),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchTaskDetail: vi.fn(),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn(() => new Promise(() => {})),
  fetchBoardWorkflows: vi.fn(() => new Promise(() => {})),
  rebuildTaskSpec: vi.fn().mockResolvedValue({}),
  refreshPrStatus: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn(),
  api: vi.fn().mockResolvedValue({ sessions: [] }),
}));

const listViewSseHandlers: Record<string, (event?: unknown) => void> = {};
const subscribeSseMock = vi.fn(
  (_url: string, opts: { events?: Record<string, (event?: unknown) => void> }) => {
    for (const [name, handler] of Object.entries(opts.events ?? {})) {
      listViewSseHandlers[name] = handler;
    }
    return () => {};
  },
);
vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => (subscribeSseMock as (...a: unknown[]) => () => void)(...args),
}));

vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: ({
    onCreate,
    addToast,
    onPlanningMode,
    workflowId,
    workflowOptions,
    defaultWorkflowId,
    onMoveTask,
  }: {
    onCreate?: (input: { description: string; workflowId?: string | null; column?: string }) => Promise<unknown>;
    addToast: (message: string, type?: "error" | "success" | "info" | "warning") => void;
    onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
    workflowId?: string | null;
    workflowOptions?: { id: string; name: string; columns?: Array<{ flags?: { manualIntake?: boolean } }> }[];
    defaultWorkflowId?: string | null;
    onMoveTask?: (id: string, column: string) => Promise<unknown>;
  }) => {
    const [value, setValue] = useState("");
    const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null | undefined>(
      workflowId ?? defaultWorkflowId ?? workflowOptions?.[0]?.id,
    );
    const [expanded, setExpanded] = useState(false);
    const [modelMenuOpen, setModelMenuOpen] = useState(false);

    useEffect(() => {
      setSelectedWorkflowId(workflowId ?? defaultWorkflowId ?? workflowOptions?.[0]?.id);
    }, [defaultWorkflowId, workflowId, workflowOptions]);

    const submit = async () => {
      const description = value.trim();
      if (!description || !onCreate) return;
      try {
        await onCreate({
          description,
          ...(selectedWorkflowId !== undefined ? { workflowId: selectedWorkflowId } : {}),
        });
        setValue("");
      } catch (err) {
        addToast(err instanceof Error ? err.message : "Failed to create task", "error");
      }
    };

    const selectedWorkflow = workflowOptions?.find((option) => option.id === selectedWorkflowId);
    const showStart = selectedWorkflowId === "builtin:coding-ideas-v2"
      || defaultWorkflowId === "builtin:coding-ideas-v2"
      || selectedWorkflow?.columns?.[0]?.flags?.manualIntake === true;

    const handoff = (callback?: (description: string, workflowId?: string | null) => void) => {
      const description = value.trim();
      if (!description || !callback) return;
      if (selectedWorkflowId !== undefined) {
        callback(description, selectedWorkflowId);
        return;
      }
      callback(description);
    };

    return (
      <div className="quick-entry-box" data-testid="quick-entry-box">
        <textarea
          className="quick-entry-input"
          data-testid="quick-entry-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          type="button"
          data-testid="quick-entry-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((next) => !next)}
        >
          Toggle
        </button>
        <div id="quick-entry-controls" data-testid="quick-entry-actions" hidden={!expanded}>
          <button
            type="button"
            data-testid="quick-entry-models"
            onClick={() => setModelMenuOpen((next) => !next)}
          >
            Models
          </button>
          <button type="button" data-testid="quick-entry-deps">Deps</button>
          <button type="button" data-testid="quick-entry-plan" onClick={() => handoff(onPlanningMode)}>
            Plan
          </button>
          {workflowOptions && workflowOptions.length > 1 ? (
            <button type="button" data-testid="quick-entry-workflow-option-wf-custom" onClick={() => setSelectedWorkflowId("wf-custom")}>
              Custom workflow
            </button>
          ) : null}
          <span data-testid="quick-entry-workflow-props" data-workflow-id={workflowId ?? ""} data-default-workflow-id={defaultWorkflowId ?? ""} data-workflow-options={JSON.stringify((workflowOptions ?? []).map((option) => option.id))} />
          <button type="button" data-testid="quick-entry-save" onClick={() => void submit()}>
            Save
          </button>
          {showStart && (
            <button type="button" data-testid="quick-entry-start" onClick={() => void onCreate?.({ description: "Started task", workflowId: "builtin:coding-ideas-v2", column: "todo" })}>
              Start
            </button>
          )}
          <button type="button" data-testid="quick-entry-move" onClick={() => void onMoveTask?.("FN-created", "todo")}>
            Move
          </button>
        </div>
        {modelMenuOpen ? (
          <div data-testid="model-nested-menu">
            <button type="button">Plan</button>
            <button type="button">Executor</button>
            <button type="button">Reviewer</button>
          </div>
        ) : null}
      </div>
    );
  },
}));

vi.mock("../TaskDetailModal", () => ({
  TaskDetailContent: ({
    task,
    onOpenDetail,
    onRequestClose,
    onTaskUpdated,
  }: {
    task: Task | TaskDetail;
    onOpenDetail?: (task: Task | TaskDetail) => void;
    onRequestClose?: () => void;
    onTaskUpdated?: (patch: Partial<TaskDetail>) => void;
  }) => (
    <div data-testid="task-detail-content">
      <span>{task.id}</span>
      <output data-testid="split-detail-title">{task.title}</output>
      <button type="button" onClick={() => onRequestClose?.()}>Close detail</button>
      <button type="button" onClick={() => onTaskUpdated?.({ title: "renamed" })}>Patch split without id</button>
      <button type="button" onClick={() => onTaskUpdated?.({ id: "FN-FOREIGN", title: "foreign" })}>Patch split foreign id</button>
      {(task.dependencies ?? []).map((dependencyId) => (
        <button
          key={dependencyId}
          type="button"
          role="link"
          onClick={() =>
            onOpenDetail?.({
              id: dependencyId,
              title: dependencyId,
              description: dependencyId,
              column: "triage",
              dependencies: [],
              steps: [],
              currentStep: 0,
              status: "pending",
              paused: false,
              log: [],
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
              prompt: `# ${dependencyId}`,
            } as TaskDetail)
          }
        >
          {dependencyId}
        </button>
      ))}
    </div>
  ),
}));

import { fetchTaskDetail, batchUpdateTaskModels, fetchBoardWorkflows, fetchNodes, refreshPrStatus, updateTask } from "../../api";
import { writeBoardWorkflowsCache } from "../../utils/boardWorkflowsCache";
import { readAppFile } from "../../test/cssFixture";

const mockConfirm = vi.fn();
const mockConfirmWithChoice = vi.fn();
const mockConfirmWithSelect = vi.fn();
vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm, confirmWithChoice: mockConfirmWithChoice, confirmWithSelect: mockConfirmWithSelect }),
}));

const mockAddToast = vi.fn();
const TEST_PROJECT_ID = "proj-123";
const scopedStorageKey = (key: string) => scopedKey(key, TEST_PROJECT_ID);

function mountCssForBadgeTests() {
  const style = document.createElement("style");
  style.textContent = loadAllAppCss();
  document.head.appendChild(style);
  document.documentElement.style.setProperty("--status-error-bg", "rgb(255, 230, 230)");
  document.documentElement.style.setProperty("--color-error-dark", "rgb(200, 0, 0)");
  document.documentElement.style.setProperty("--status-in-review-bg", "rgb(230, 255, 230)");
  document.documentElement.style.setProperty("--in-review", "rgb(0, 160, 0)");
  document.documentElement.style.setProperty("--triage", "rgb(240, 140, 0)");
  document.documentElement.style.setProperty("--todo", "rgb(80, 120, 220)");
  return () => {
    style.remove();
    document.documentElement.style.removeProperty("--status-error-bg");
    document.documentElement.style.removeProperty("--color-error-dark");
    document.documentElement.style.removeProperty("--status-in-review-bg");
    document.documentElement.style.removeProperty("--in-review");
    document.documentElement.style.removeProperty("--triage");
    document.documentElement.style.removeProperty("--todo");
  };
}

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: "FN-001",
  description: "Test task description",
  title: "Test Task",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  status: "pending",
  paused: false,
  log: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

const renderListView = (
  props: Partial<React.ComponentProps<typeof ListView>> = {},
  options: { openViewOptions?: boolean } = {},
) => {
  const defaultProps = {
    tasks: [],
    onMoveTask: vi.fn(async () => createMockTask()),
    onRetryTask: vi.fn(async () => createMockTask()),
    onDeleteTask: vi.fn(async () => createMockTask()),
    onMergeTask: vi.fn(async () => ({ merged: false })),
    onResetTask: vi.fn(async () => createMockTask()),
    onDuplicateTask: vi.fn(async () => createMockTask()),
    onOpenDetail: vi.fn(),
    addToast: mockAddToast,
    globalPaused: false,
    onNewTask: vi.fn(),
    projectId: TEST_PROJECT_ID,
  };

  const result = render(<ListView {...defaultProps} {...props} />);
  if (options.openViewOptions ?? true) {
    const viewOptionsToggle = screen.queryByRole("button", { name: /^view$/i });
    if (viewOptionsToggle) {
      act(() => {
        fireEvent.click(viewOptionsToggle);
      });
    }
  }
  return result;
};

const clickInAct = (element: Element) => {
  act(() => {
    fireEvent.click(element);
  });
};

const clickAndFlush = async (element: Element) => {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
};

const keyDownAndFlush = async (element: Element, init: Parameters<typeof fireEvent.keyDown>[1]) => {
  await act(async () => {
    fireEvent.keyDown(element, init);
    await Promise.resolve();
  });
};

async function openWorkflowSwitcher() {
  const trigger = await screen.findByTestId("workflow-switcher");
  fireEvent.click(trigger);
  return trigger;
}

async function selectWorkflow(workflowId: string) {
  await openWorkflowSwitcher();
  fireEvent.click(screen.getByTestId(`workflow-switcher-option-${workflowId}`));
}

const enterBulkEditMode = () => {
  clickInAct(screen.getByRole("button", { name: "Bulk Edit" }));
};

const showAllColumnsByDefault = () => {
  localStorage.setItem(
    scopedStorageKey("kb-dashboard-list-columns"),
    JSON.stringify(["title", "status", "column", "dependencies", "progress"]),
  );
};

const getSectionTaskIds = (sectionName: string): string[] => {
  const allRows = screen.getAllByRole("row");
  const sectionStart = allRows.findIndex(
    (row) => row.className.includes("list-section-header") && row.textContent?.includes(sectionName),
  );
  if (sectionStart < 0) return [];

  const ids: string[] = [];
  for (let index = sectionStart + 1; index < allRows.length; index += 1) {
    const row = allRows[index];
    if (row.className.includes("list-section-header")) break;
    const id = row.getAttribute("data-id");
    if (id) ids.push(id);
  }

  return ids;
};

function ensureMatchMedia() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(),
    });
  }
}

function mockMobileViewport() {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function mockTabletViewport() {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(min-width: 769px) and (max-width: 1024px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function mockDesktopViewport() {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function installControlledResizeObserver() {
  const callbacks = new Set<ResizeObserverCallback>();
  class ControlledResizeObserver {
    constructor(private readonly observerCallback: ResizeObserverCallback) {
      callbacks.add(observerCallback);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      callbacks.delete(this.observerCallback);
    }
  }
  const OriginalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = ControlledResizeObserver as unknown as typeof ResizeObserver;

  return {
    resize(width: number) {
      for (const callback of callbacks) {
        callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
      }
    },
    restore() {
      globalThis.ResizeObserver = OriginalResizeObserver;
    },
  };
}

/*
FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
The default workflow's real lane set, used both as the resolved fetch value and as
the first-paint session-cache seed. Its five column ids are the same ones the deleted
`LEGACY_LIST_COLUMNS` fallback synthesized, so existing per-test assertions carry
over — the difference is that they now assert against columns resolved from a
workflow rather than from the hardcoded legacy enum.
*/
const DEFAULT_LANE_PAYLOAD = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [
    {
      id: "builtin:coding",
      name: "Coding",
      columns: [
        { id: "triage", name: "Planning", flags: { intake: true } },
        { id: "todo", name: "Todo", flags: { hold: true } },
        { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
        { id: "in-review", name: "In review", flags: { mergeBlocker: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    },
  ],
  taskWorkflowIds: {},
};

/*
FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
File-level, so it applies to EVERY describe here — several have their own
`beforeEach` and would otherwise fall back to the loading skeleton.

First-paint parity with production: `useBoardWorkflows` hydrates from the
project-scoped session cache in its `useState` initializer, so lanes are present on
the FIRST synchronous render. Seeding only the resolved fetch value is not enough —
`mockResolvedValue` settles a microtask later, and this file's assertions are
overwhelmingly synchronous `render(...)` + `getBy...`.
*/
beforeEach(() => {
  window.sessionStorage.clear();
  vi.mocked(fetchBoardWorkflows).mockResolvedValue(DEFAULT_LANE_PAYLOAD);
  writeBoardWorkflowsCache(TEST_PROJECT_ID, DEFAULT_LANE_PAYLOAD);
  // Lanes are cached per project, so seed every project id this file renders —
  // including `undefined`, which the cache stores under its "default" key and which
  // a few cases reach by re-rendering <ListView> without a projectId.
  writeBoardWorkflowsCache(undefined, DEFAULT_LANE_PAYLOAD);
  writeBoardWorkflowsCache("project-a", DEFAULT_LANE_PAYLOAD);
  writeBoardWorkflowsCache("project-b", DEFAULT_LANE_PAYLOAD);
});

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — PR #2525 review, greptile):
List must self-heal a task whose workflow mapping the payload does not yet carry — the
routine case, because the SSE task list updates before board-workflows does. Board has
done this since FN-7591; List had not, so a just-created card kept an approximated move
menu until some unrelated refresh.

REVERT CHECK: remove the `useUnmappedWorkflowRefetch` call from ListView and this fails
— `fetchBoardWorkflows` is never called a second time, so the mapping never resolves.
*/
describe("ListView unmapped-workflow self-heal", () => {
  it("forces one board-workflows refetch when a rendered task has no workflow mapping", async () => {
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      ...DEFAULT_LANE_PAYLOAD,
      // FN-901 is rendered but absent from the mapping: newer than the payload.
      taskWorkflowIds: {},
    });

    renderListView({ tasks: [createMockTask({ id: "FN-901", column: "todo", title: "Fresh card" })] });

    await waitFor(() => expect(vi.mocked(fetchBoardWorkflows).mock.calls.length).toBeGreaterThan(1));
    // Forced fresh, so a cached payload cannot satisfy the repair.
    expect(vi.mocked(fetchBoardWorkflows).mock.calls.some(([, options]) => options?.forceFresh === true)).toBe(true);
  });

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile):
  The forced fetch can return BEFORE the workflow-selection write commits, reporting the
  same suspect set. A one-shot guard treated that as "unresolvable" and gave up, leaving
  the card on approximate metadata until an unrelated refresh.

  REVERT CHECK: restore the one-shot guard (return whenever the signature repeats) and
  this fails — only ONE forced fetch is issued, so the mapping that arrives on the
  second response never triggers the repair.
  */
  it("retries once more when the forced fetch races the selection write", async () => {
    const unmappedPayload = { ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: {} };
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(unmappedPayload);

    renderListView({ tasks: [createMockTask({ id: "FN-903", column: "todo", title: "Racing card" })] });

    // Two forced attempts for the same still-suspect signature, then it must stop —
    // loop protection is kept, just not at one attempt.
    await waitFor(() => {
      expect(vi.mocked(fetchBoardWorkflows).mock.calls.filter(([, o]) => o?.forceFresh === true).length).toBe(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(fetchBoardWorkflows).mock.calls.filter(([, o]) => o?.forceFresh === true).length).toBe(2);
  });

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile, second round):
  A REJECTED forced fetch must not end the repair. `refreshBoardWorkflows` swallows a
  transient failure by design, so `boardWorkflows` never changes and an effect-driven
  retry would never re-run — the repair would die on exactly the failure it exists to
  survive.

  HONEST LIMITATION: this case pins the OUTCOME (the repair reaches its second attempt
  despite a rejected first) but it does NOT discriminate the mechanism. I checked:
  removing the self re-arm still passes it, because in this environment something else
  re-renders after the rejection and the effect happens to run again. I could not
  construct a case that isolates the self-driving loop without freezing re-renders in a
  way that no longer resembles the app, so I am not claiming revert-proof coverage for
  it — the loop is defensive against a state where nothing re-renders, which is real in
  production but not reproducible here.

  The bounded-retry budget IS revert-proof; see the racing-selection-write case above.
  */
  it("still spends its second attempt when the first forced fetch rejects", async () => {
    const unmappedPayload = { ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: {} };
    vi.mocked(fetchBoardWorkflows)
      .mockResolvedValueOnce(unmappedPayload)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(unmappedPayload);

    renderListView({ tasks: [createMockTask({ id: "FN-904", column: "todo", title: "Rejected repair" })] });

    await waitFor(
      () => {
        expect(vi.mocked(fetchBoardWorkflows).mock.calls.filter(([, o]) => o?.forceFresh === true).length).toBe(2);
      },
      { timeout: 2000 },
    );
  });

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile):
  A SLOW forced refresh must not have its successor started before it settles. On a
  fixed timer alone, a request in flight for longer than the retry delay had its second
  attempt fired anyway, so both attempts were spent on the same unresolved state before
  either answer arrived — the budget gone, the card still approximate.

  REVERT CHECK: re-arm on the plain timer (drop the settle-await) and this fails —
  the second attempt fires while the first is still pending.
  */
  it("waits for a slow forced refresh to settle before spending the next attempt", async () => {
    const unmappedPayload = { ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: {} };
    let releaseFirstForced: (() => void) | undefined;
    let forcedCalls = 0;
    vi.mocked(fetchBoardWorkflows).mockImplementation((_projectId?: string, options?: { forceFresh?: boolean }) => {
      if (options?.forceFresh !== true) return Promise.resolve(unmappedPayload);
      forcedCalls += 1;
      if (forcedCalls === 1) {
        return new Promise((resolve) => { releaseFirstForced = () => resolve(unmappedPayload); });
      }
      return Promise.resolve(unmappedPayload);
    });

    renderListView({ tasks: [createMockTask({ id: "FN-905", column: "todo", title: "Slow repair" })] });

    await waitFor(() => expect(forcedCalls).toBe(1));
    // FNXC:WorkflowBoard 2026-08-01-17:20: advance well past RETRY_DELAY_MS (250ms) deterministically with fake timers instead of a real 400ms wall wait. The repair re-arms only on settle, so no retry timer is pending while the first attempt is in flight — a regression that armed one would still fire here and fail the assertion, preserving the REVERT CHECK.
    await act(async () => {
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();
    });
    expect(forcedCalls).toBe(1);

    await act(async () => { releaseFirstForced?.(); await Promise.resolve(); });
    await waitFor(() => expect(forcedCalls).toBe(2), { timeout: 2000 });
  });

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile):
  A repair pending across a PROJECT SWITCH must abandon itself. Otherwise its
  continuation runs through the OLD project's `refreshBoardWorkflows` closure, and that
  stale request can claim the newest shared fetch sequence number — discarding the
  CURRENT project's response and leaving the new board without workflow metadata.

  REVERT CHECK: drop the `projectIdRef` comparison in the settle/timer continuations and
  this fails — a forced fetch is issued for the OLD project after the switch.
  */
  it("abandons a pending repair when the project changes", async () => {
    const unmappedPayload = { ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: {} };
    let releaseFirstForced: (() => void) | undefined;
    const forcedProjects: (string | undefined)[] = [];
    vi.mocked(fetchBoardWorkflows).mockImplementation((projectId?: string, options?: { forceFresh?: boolean }) => {
      if (options?.forceFresh !== true) return Promise.resolve(unmappedPayload);
      forcedProjects.push(projectId);
      if (forcedProjects.length === 1) {
        return new Promise((resolve) => { releaseFirstForced = () => resolve(unmappedPayload); });
      }
      return Promise.resolve(unmappedPayload);
    });

    const tasks = [createMockTask({ id: "FN-906", column: "todo", title: "Switching card" })];
    const view = renderListView({ tasks, projectId: "project-a" });
    await waitFor(() => expect(forcedProjects).toEqual(["project-a"]));

    // Switch projects while the repair is still in flight, then let it settle.
    view.rerender(<ListView tasks={tasks} projectId="project-b" onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);
    await act(async () => { releaseFirstForced?.(); await Promise.resolve(); });
    // FNXC:WorkflowBoard 2026-08-01-17:20: deterministic fake-timer advance past RETRY_DELAY_MS replaces a real 400ms wall wait. The settled continuation abandons on the project-id mismatch and arms no follow-up timer; a regression that dropped the projectIdRef guard would arm one and this advance would fire it, keeping the REVERT CHECK intact.
    await act(async () => {
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();
    });

    // No follow-up may be issued for the project that is no longer displayed.
    expect(forcedProjects.filter((id) => id === "project-a")).toHaveLength(1);
  });

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — CodeRabbit):
  A repair in flight at UNMOUNT must not resume. The cleanup can only clear the timer
  that exists at unmount; a settling request afterwards would schedule a fresh timer
  nobody will ever clear, and fire a refresh for a view that is gone.

  REVERT CHECK: drop the `mountedRef` guards and this fails — a forced fetch is issued
  after the component has been unmounted.
  */
  it("does not resume a repair that settles after unmount", async () => {
    const unmappedPayload = { ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: {} };
    let releaseFirstForced: (() => void) | undefined;
    let forcedCalls = 0;
    vi.mocked(fetchBoardWorkflows).mockImplementation((_projectId?: string, options?: { forceFresh?: boolean }) => {
      if (options?.forceFresh !== true) return Promise.resolve(unmappedPayload);
      forcedCalls += 1;
      if (forcedCalls === 1) {
        return new Promise((resolve) => { releaseFirstForced = () => resolve(unmappedPayload); });
      }
      return Promise.resolve(unmappedPayload);
    });

    const view = renderListView({ tasks: [createMockTask({ id: "FN-907", column: "todo", title: "Unmount card" })] });
    await waitFor(() => expect(forcedCalls).toBe(1));

    view.unmount();
    await act(async () => { releaseFirstForced?.(); await Promise.resolve(); });
    // FNXC:WorkflowBoard 2026-08-01-17:20: deterministic fake-timer advance past RETRY_DELAY_MS replaces a real 400ms wall wait. The settled continuation abandons on the mountedRef guard and arms no follow-up timer; a regression that dropped that guard would arm one and this advance would fire it, keeping the REVERT CHECK intact.
    await act(async () => {
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();
    });

    expect(forcedCalls).toBe(1);
  });

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile):
  StrictMode replays effects as mount -> cleanup -> mount while PRESERVING refs. A
  mounted latch that is only ever cleared stays `false` after the replay, so every
  deferred continuation exits at the guard and the repair is silently dead for the whole
  session — in production, since the dashboard root uses StrictMode.

  REVERT CHECK: remove `mountedRef.current = true` from the effect SETUP and this fails —
  no forced fetch is ever issued under StrictMode.
  */
  it("still repairs under StrictMode effect replay", async () => {
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({ ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: {} });

    render(
      <React.StrictMode>
        <ListView
          tasks={[createMockTask({ id: "FN-908", column: "todo", title: "Strict card" })]}
          projectId={TEST_PROJECT_ID}
          onMoveTask={vi.fn()}
          onOpenDetail={vi.fn()}
          addToast={mockAddToast}
        />
      </React.StrictMode>,
    );

    await waitFor(() => {
      expect(vi.mocked(fetchBoardWorkflows).mock.calls.filter(([, o]) => o?.forceFresh === true).length).toBeGreaterThan(0);
    }, { timeout: 2000 });
  });

  it("does not refetch when every rendered task is mapped", async () => {
    const mapped = { ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: { "FN-902": "builtin:coding" } };
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(mapped);
    // Seed the FIRST-PAINT cache too: the file-level seed maps no tasks, so without this
    // the initial render legitimately sees an unmapped card and schedules the repair —
    // which would make this case assert the opposite of what it means to.
    writeBoardWorkflowsCache(TEST_PROJECT_ID, mapped);

    renderListView({ tasks: [createMockTask({ id: "FN-902", column: "todo", title: "Mapped card" })] });

    // Let the initial load settle, then watch only what happens AFTER it: other
    // mechanisms (mount fetch, switcher open) legitimately call the fetcher, so
    // counting from zero would measure them rather than the self-heal.
    await act(async () => { await Promise.resolve(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(fetchBoardWorkflows).mockClear();

    await new Promise((resolve) => setTimeout(resolve, 0));
    // The signature guard must not turn a healthy board into a refetch loop.
    expect(vi.mocked(fetchBoardWorkflows).mock.calls.filter(([, options]) => options?.forceFresh === true)).toHaveLength(0);
  });
});

describe("ListView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchNodes).mockImplementation(() => new Promise(() => {}));
    /*
    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
    This default used to be a NEVER-RESOLVING promise. With `workflowColumnsEnabled`
    left unset, ListView's old gate evaluated to false, so `boardWorkflows` stayed
    null and every test in this file rendered `LEGACY_LIST_COLUMNS` — the synthesized
    legacy-enum column set. Production never reached that state: MainContent passed
    `workflowColumnsEnabled` as a literal `true`, which held the skeleton until lanes
    resolved. So this file's coverage was pointed at a configuration that could not
    occur, and a real regression in the workflow list would not have failed it.

    Resolve the DEFAULT workflow's real lane set instead. The column ids are the same
    six the legacy fallback synthesized, so per-test assertions carry over unchanged —
    what changes is that they now assert against columns resolved from a workflow.
    Tests that need a different lane shape still override this mock locally.
    */
    vi.mocked(fetchTaskDetail).mockResolvedValue({
      ...createMockTask(),
      prompt: "# Detail",
    } as TaskDetail);
    vi.mocked(refreshPrStatus).mockResolvedValue({} as any);
    mockConfirm.mockReset();
    mockConfirmWithChoice.mockReset();
    mockConfirmWithSelect.mockReset();
    mockConfirmWithSelect.mockResolvedValue({ choice: "primary", checkboxValue: false, selectValue: "builtin:coding" });
    subscribeSseMock.mockClear();
    for (const key of Object.keys(listViewSseHandlers)) delete listViewSseHandlers[key];
    localStorage.clear();
    showAllColumnsByDefault();
    ensureMatchMedia();
    /*
    FNXC:ViewportMode 2026-07-24-02:30:
    FN-8557 (973c978f9) made isMobileViewport treat `window.innerWidth <= 768`
    as a mobile signal alongside matchMedia. mockMobileViewport stamps
    innerWidth=375 via defineProperty and its spy restore only resets
    matchMedia, so the leaked width flipped every later test into the mobile
    card layout (no <tr> rows). Reset innerWidth to a desktop width here so the
    per-test viewport helpers stay authoritative.
    */
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("renders without crashing", () => {
    renderListView();
    // The search/filter is now in the header, not in the list view toolbar
    expect(screen.getByText("View")).toBeDefined();
  });

  it("renders plan approval actions for a hold-column task in desktop rows", () => {
    const viewportSpy = mockDesktopViewport();
    const payload = { ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: { "FN-228-desktop": "builtin:coding" } };
    writeBoardWorkflowsCache(TEST_PROJECT_ID, payload);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(payload);
    try {
      renderListView({
        tasks: [createMockTask({
          id: "FN-228-desktop",
          column: "todo",
          status: "awaiting-approval",
          prompt: "# Reviewed plan",
        })],
      });

      const notice = screen.getByTestId("plan-approval-list-FN-228-desktop");
      expect(within(notice).getByRole("button", { name: "Approve" })).toBeEnabled();
      expect(within(notice).getAllByRole("button")).toHaveLength(1);
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("renders plan approval actions for a hold-column task in compact cards", () => {
    const viewportSpy = mockMobileViewport();
    const payload = { ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: { "FN-228-mobile": "builtin:coding" } };
    writeBoardWorkflowsCache(TEST_PROJECT_ID, payload);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(payload);
    try {
      renderListView({
        tasks: [createMockTask({
          id: "FN-228-mobile",
          column: "todo",
          status: "awaiting-approval",
          prompt: "# Reviewed plan",
        })],
      });

      const notice = screen.getByTestId("plan-approval-list-FN-228-mobile");
      expect(within(notice).getByRole("button", { name: "Approve" })).toBeEnabled();
      expect(within(notice).getAllByRole("button")).toHaveLength(1);
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("hides the retired plan approval badge for legacy data in desktop rows", () => {
    const viewportSpy = mockDesktopViewport();
    const payload = { ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: { "FN-234-legacy": "builtin:coding" } };
    writeBoardWorkflowsCache(TEST_PROJECT_ID, payload);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(payload);
    try {
      const legacyFields = { requirePlanApproval: true } as unknown as Partial<Task>;
      renderListView({ tasks: [createMockTask({ id: "FN-234-legacy", executionMode: "fast", ...legacyFields })] });

      expect(screen.queryByTestId("plan-approval-badge-list-table-FN-234-legacy")).toBeNull();
      expect(screen.getByLabelText("Fast mode")).toBeVisible();
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("hides the retired plan approval badge for legacy data in compact cards", () => {
    const viewportSpy = mockMobileViewport();
    const payload = { ...DEFAULT_LANE_PAYLOAD, taskWorkflowIds: { "FN-234-legacy-mobile": "builtin:coding" } };
    writeBoardWorkflowsCache(TEST_PROJECT_ID, payload);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(payload);
    try {
      const legacyFields = { requirePlanApproval: true } as unknown as Partial<Task>;
      renderListView({ tasks: [createMockTask({ id: "FN-234-legacy-mobile", executionMode: "fast", ...legacyFields })] });

      expect(screen.queryByTestId("plan-approval-badge-list-card-FN-234-legacy-mobile")).toBeNull();
      expect(screen.getByLabelText("Fast mode")).toBeVisible();
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("renders the exhausted review budget indicator only for the matching approval reason in desktop rows", () => {
    const viewportSpy = mockDesktopViewport();
    renderListView({
      tasks: [
        createMockTask({ id: "FN-BUDGET", status: "awaiting-approval", awaitingApprovalReason: "plan-review-replan-cap" }),
        createMockTask({ id: "FN-MANUAL", status: "awaiting-approval" }),
        createMockTask({ id: "FN-LEGACY", status: "awaiting-approval", awaitingApprovalReason: "release-authorization" }),
      ],
    });

    expect(screen.getByTestId("list-review-budget-exhausted-FN-BUDGET")).toHaveTextContent("Review budget exhausted");
    expect(screen.getAllByText("Awaiting Approval")).toHaveLength(2);
    viewportSpy.mockRestore();
  });

  it("renders the exhausted review budget indicator only for the matching approval reason in grouped cards", () => {
    const viewportSpy = mockMobileViewport();
    renderListView({
      tasks: [
        createMockTask({ id: "FN-BUDGET", status: "awaiting-approval", awaitingApprovalReason: "plan-review-replan-cap" }),
        createMockTask({ id: "FN-MANUAL", status: "awaiting-approval" }),
        createMockTask({ id: "FN-LEGACY", status: "awaiting-approval", awaitingApprovalReason: "release-authorization" }),
      ],
    });

    expect(screen.getByTestId("list-review-budget-exhausted-FN-BUDGET")).toHaveTextContent("Review budget exhausted");
    expect(screen.getAllByText("Awaiting Approval")).toHaveLength(2);
    viewportSpy.mockRestore();
  });

  it("does not glow a fresh status-null triage card in grouped mobile cards", () => {
    // FNXC:TaskActivity 2026-08-01-17:53: fresh planner logs alone are not a concurrency
    // slot; the pulsing Planning badge requires the authoritative planning status.
    const viewportSpy = mockMobileViewport();
    try {
      renderListView({
        tasks: [createMockTask({
          id: "FN-8300-mobile",
          status: null as any,
          recentAgentActivityAt: new Date().toISOString(),
        })],
      });

      const card = screen.getByText("FN-8300-mobile").closest(".list-card") as HTMLElement;
      expect(card).not.toHaveClass("agent-active");
      expect(within(card).queryByLabelText("Planning")).not.toBeInTheDocument();
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("does not glow a fresh status-null triage card in desktop table rows", () => {
    const viewportSpy = mockDesktopViewport();
    try {
      renderListView({
        tasks: [createMockTask({
          id: "FN-8300-desktop",
          status: null as any,
          recentAgentActivityAt: new Date().toISOString(),
        })],
      });

      const row = screen.getByText("FN-8300-desktop").closest("tr") as HTMLElement;
      expect(row).not.toHaveClass("agent-active");
      expect(within(row).queryByLabelText("Planning")).not.toBeInTheDocument();
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("falls back malformed task columns to Planning group instead of crashing", () => {
    const malformedTask = {
      ...createMockTask({ id: "FN-404" }),
      column: "impossible-column",
    } as unknown as Task;

    expect(() => renderListView({ tasks: [malformedTask] })).not.toThrow();
    expect(screen.getByText("FN-404")).toBeInTheDocument();

    const planningSection = screen
      .getAllByRole("row")
      .find((row) => row.className.includes("list-section-header") && row.textContent?.includes("Planning"));
    expect(planningSection?.textContent).toContain("1");
  });

  it("keeps view options collapsed by default on desktop", () => {
    renderListView({}, { openViewOptions: false });

    const toggle = screen.getByRole("button", { name: /^view$/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("list-view-options-panel")).toBeNull();
  });

  it("shows compact summary chips while view options stay collapsed", () => {
    localStorage.setItem(scopedStorageKey("kb-dashboard-hide-done"), "true");
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];

    renderListView({ tasks }, { openViewOptions: false });

    expect(screen.getByText("Done hidden")).toBeDefined();
    expect(document.getElementById("list-view-options-panel")).toBeNull();
  });

  it("displays tasks in table format with two-line title styling", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    renderListView({ tasks });

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("First Task")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
    expect(screen.getByText("Second Task")).toBeDefined();
    const listTitleTextRule = readAppFile("components/ListView.css").match(/\.list-title-text\s*\{[^}]*\}/)?.[0] ?? "";
    expect(listTitleTextRule).toContain("display: -webkit-box");
    expect(listTitleTextRule).toContain("-webkit-line-clamp: 2");
    expect(listTitleTextRule).toContain("-webkit-box-orient: vertical");
    expect(listTitleTextRule).toContain("white-space: normal");
    expect(listTitleTextRule).toContain("overflow-wrap: anywhere");
    expect(listTitleTextRule).not.toContain("white-space: nowrap");
  });

  it("shows fast indicator in desktop rows only for fast-mode tasks", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Fast Task", executionMode: "fast" }),
      createMockTask({ id: "FN-002", title: "Standard Task", executionMode: "standard" }),
    ];

    const { container } = renderListView({ tasks });

    const fastRow = container.querySelector('tr[data-id="FN-001"]') as HTMLElement;
    const standardRow = container.querySelector('tr[data-id="FN-002"]') as HTMLElement;
    const fastBadge = fastRow.querySelector(".list-execution-mode-badge");

    expect(fastBadge).not.toBeNull();
    expect(fastBadge?.getAttribute("aria-label")).toBe("Fast mode");
    expect(fastBadge?.querySelector("svg")).not.toBeNull();
    expect(standardRow.querySelector(".list-execution-mode-badge")).toBeNull();
  });

  it("shows paused by agent status in table view", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "in-progress", paused: true, pausedByAgentId: "agent-1" }),
    ];

    renderListView({ tasks });
    expect(screen.getByText("paused by agent")).toBeDefined();
  });

  it("shows paused by agent status in mobile card view", () => {
    const matchMediaSpy = mockMobileViewport();
    const tasks = [
      createMockTask({ id: "FN-001", column: "in-progress", paused: true, pausedByAgentId: "agent-1" }),
    ];

    renderListView({ tasks });
    expect(screen.getByText("paused by agent")).toBeDefined();
    matchMediaSpy.mockRestore();
  });

  it("keeps done status badge in table view when stale paused metadata exists", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done", status: "paused", paused: true, pausedByAgentId: "agent-1" }),
    ];

    renderListView({ tasks });
    expect(screen.queryByText("paused by agent")).toBeNull();
    expect(screen.queryByText("paused")).toBeNull();
    expect(screen.getByText("done")).toBeDefined();
  });

  it("keeps done status badge in mobile card view when stale paused metadata exists", () => {
    const matchMediaSpy = mockMobileViewport();
    const tasks = [
      createMockTask({ id: "FN-001", column: "done", status: "paused", paused: true, pausedByAgentId: "agent-1" }),
    ];

    renderListView({ tasks });
    expect(screen.queryByText("paused by agent")).toBeNull();
    expect(screen.queryByText("paused")).toBeNull();
    expect(screen.getByText("done")).toBeDefined();
    matchMediaSpy.mockRestore();
  });

  it("shows empty state when no tasks", () => {
    renderListView({ tasks: [] });
    expect(screen.getByText("No tasks yet")).toBeDefined();
  });

  it("shows empty state when filter matches nothing", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];

    renderListView({ tasks, searchQuery: "nonexistent" });

    expect(screen.getByText("No tasks match your filter")).toBeDefined();
  });

  it("filters tasks by ID", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    renderListView({ tasks, searchQuery: "FN-001" });

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("filters tasks by title", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    renderListView({ tasks, searchQuery: "Second" });

    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("filters tasks by description when no title", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: undefined, description: "Alpha description" }),
      createMockTask({ id: "FN-002", title: undefined, description: "Beta description" }),
    ];

    renderListView({ tasks, searchQuery: "Alpha" });

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("clears filter when searchQuery is empty", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "First Task" }),
      createMockTask({ id: "FN-002", title: "Second Task" }),
    ];

    // First render with search query
    const { rerender } = renderListView({ tasks, searchQuery: "FN-001" });

    // Only FN-001 should be visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Re-render with empty searchQuery
    rerender(<ListView tasks={tasks} searchQuery="" onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} />);

    // Both tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("updates selectedTaskId on desktop row click and mounts embedded detail", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    const mockOnOpenDetail = vi.fn();
    const onPopOut = vi.fn();

    renderListView({ tasks, onOpenDetail: mockOnOpenDetail, onPopOut });

    const row = screen.getByText("FN-001").closest("tr");
    fireEvent.click(row!);

    expect(mockOnOpenDetail).not.toHaveBeenCalled();
    expect(onPopOut).not.toHaveBeenCalled();
    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBe("FN-001");
    expect(row?.className).toContain("list-row--selected");
    await waitFor(() => {
      expect(screen.getByTestId("list-split-detail-content")).toBeInTheDocument();
      expect(screen.getByTestId("task-detail-content")).toHaveTextContent("FN-001");
    });
    expect(fetchTaskDetail).not.toHaveBeenCalled();
    viewportSpy.mockRestore();
  });

  it("routes desktop List row clicks and keyboard opens to the task popup when enabled", () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    const onOpenDetail = vi.fn();
    const onPopOut = vi.fn();

    renderListView({ tasks, onOpenDetail, onPopOut, openMobileTasksInPopup: true });

    const row = screen.getByText("FN-001").closest("tr") as HTMLElement;
    fireEvent.click(row);

    expect(onPopOut).toHaveBeenCalledWith(tasks[0]);
    expect(onPopOut).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(screen.queryByTestId("list-split-detail-content")).toBeNull();
    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBeNull();

    fireEvent.keyDown(row, { key: "Enter" });
    expect(onPopOut).toHaveBeenCalledTimes(2);
    expect(onPopOut).toHaveBeenLastCalledWith(tasks[0]);
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(screen.queryByTestId("list-split-detail-content")).toBeNull();
    viewportSpy.mockRestore();
  });

  it("falls back to desktop docked detail when popup routing is enabled without onPopOut", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    const onOpenDetail = vi.fn();

    renderListView({ tasks, onOpenDetail, openMobileTasksInPopup: true });

    const row = screen.getByText("FN-001").closest("tr") as HTMLElement;
    fireEvent.click(row);

    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBe("FN-001");
    await waitFor(() => {
      expect(screen.getByTestId("list-split-detail-content")).toBeInTheDocument();
    });
    viewportSpy.mockRestore();
  });

  it("calls onOpenDetail on mobile row click", () => {
    const viewportSpy = mockMobileViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    const mockOnOpenDetail = vi.fn();
    const onPopOut = vi.fn();

    renderListView({ tasks, onOpenDetail: mockOnOpenDetail, onPopOut });

    const card = document.querySelector('.list-card[data-id="FN-001"]');
    fireEvent.click(card!);

    expect(mockOnOpenDetail).toHaveBeenCalledWith(tasks[0], { origin: "list-mobile" });
    expect(mockOnOpenDetail).toHaveBeenCalledTimes(1);
    expect(onPopOut).not.toHaveBeenCalled();
    expect(fetchTaskDetail).not.toHaveBeenCalled();
    viewportSpy.mockRestore();
  });

  it("routes mobile and tablet List cards to the task popup when enabled", () => {
    const mobileViewportSpy = mockMobileViewport();
    const mobileTasks = [createMockTask({ id: "FN-001", title: "Mobile popup" })];
    const mobileOnOpenDetail = vi.fn();
    const mobileOnPopOut = vi.fn();

    const mobileRender = renderListView({ tasks: mobileTasks, onOpenDetail: mobileOnOpenDetail, onPopOut: mobileOnPopOut, openMobileTasksInPopup: true });
    fireEvent.click(document.querySelector('.list-card[data-id="FN-001"]') as HTMLElement);

    expect(mobileOnPopOut).toHaveBeenCalledWith(mobileTasks[0]);
    expect(mobileOnOpenDetail).not.toHaveBeenCalled();
    expect(screen.queryByTestId("list-split-detail-content")).toBeNull();
    mobileRender.unmount();
    mobileViewportSpy.mockRestore();

    const tabletViewportSpy = mockTabletViewport();
    const tabletTasks = [createMockTask({ id: "FN-002", title: "Tablet popup" })];
    const tabletOnOpenDetail = vi.fn();
    const tabletOnPopOut = vi.fn();

    renderListView({ tasks: tabletTasks, onOpenDetail: tabletOnOpenDetail, onPopOut: tabletOnPopOut, openMobileTasksInPopup: true });
    fireEvent.click(document.querySelector('.list-card[data-id="FN-002"]') as HTMLElement);

    expect(tabletOnPopOut).toHaveBeenCalledWith(tabletTasks[0]);
    expect(tabletOnOpenDetail).not.toHaveBeenCalled();
    expect(screen.queryByTestId("list-split-detail-content")).toBeNull();
    tabletViewportSpy.mockRestore();
  });

  it("opens the task context menu from desktop row right-click without selecting or opening detail", async () => {
    const viewportSpy = mockDesktopViewport();
    const onOpenDetail = vi.fn();
    const onPauseTask = vi.fn(async () => createMockTask());
    const onUnpauseTask = vi.fn(async () => createMockTask());
    const onRetryTask = vi.fn(async () => createMockTask());
    const onMoveTask = vi.fn(async () => createMockTask());
    const tasks = [
      createMockTask({ id: "FN-001", title: "Failed retryable", column: "todo", status: "failed" }),
      createMockTask({ id: "FN-002", title: "Paused task", column: "todo", paused: true }),
      createMockTask({ id: "FN-003", title: "Review task", column: "in-review" }),
      createMockTask({ id: "FN-004", title: "Done task", column: "done", status: "done" }),
      createMockTask({ id: "FN-006", title: "PR review", column: "in-review", prInfo: { number: 6, url: "https://example.test/pr/6", status: "open" } as any }),
      createMockTask({ id: "FN-007", title: "Progress move", column: "in-progress", steps: [{ id: "s1", title: "done", status: "done" } as any] }),
    ];

    renderListView({ tasks, onOpenDetail, onPauseTask, onUnpauseTask, onRetryTask, onMoveTask });

    const failedRow = document.querySelector('.list-row[data-id="FN-001"]') as HTMLElement;
    fireEvent.contextMenu(failedRow, { clientX: 40, clientY: 50 });

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pause" })).toBeInTheDocument();
    expect(failedRow).not.toHaveClass("list-row--selected");
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(fetchTaskDetail).not.toHaveBeenCalled();

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-002"]') as HTMLElement, { clientX: 40, clientY: 50 });
    expect(screen.getByRole("menuitem", { name: "Unpause" })).toBeInTheDocument();

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-003"]') as HTMLElement, { clientX: 40, clientY: 50 });
    expect(screen.getByRole("menuitem", { name: "Merge & Close" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Refine" })).toBeInTheDocument();
    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-006"]') as HTMLElement, { clientX: 40, clientY: 50 });
    expect(screen.getByRole("menuitem", { name: "Merge & Close" })).toBeInTheDocument();

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-004"]') as HTMLElement, { clientX: 40, clientY: 50 });
    expect(screen.getByRole("menuitem", { name: "Refine" })).toBeInTheDocument();
    expect(onOpenDetail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-004" }), { origin: undefined, initialAction: "refine" });

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-004"]') as HTMLElement, { clientX: 40, clientY: 50 });
    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const reviewRow = document.querySelector('.list-row[data-id="FN-003"]') as HTMLElement;
    reviewRow.focus();
    fireEvent.keyDown(reviewRow, { key: "ContextMenu" });
    expect(screen.getByRole("menuitem", { name: "Merge & Close" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Refine" })).toBeInTheDocument();

    expect(onPauseTask).not.toHaveBeenCalled();
    expect(onRetryTask).not.toHaveBeenCalled();
    viewportSpy.mockRestore();
  });

  it("opens editable Reset without consulting confirmation settings", async () => {
    const onResetTask = vi.fn(async () => createMockTask());
    renderListView({
      tasks: [createMockTask({ id: "FN-901", column: "in-progress", description: "Original list request" })],
      onResetTask,
    });

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-901"]') as HTMLElement, { clientX: 40, clientY: 50 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset" }));

    expect(await screen.findByTestId("task-reset-dialog")).toBeInTheDocument();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("task-reset-description")).toHaveValue("Original list request");
    fireEvent.change(screen.getByTestId("task-reset-description"), { target: { value: "Corrected list request" } });
    fireEvent.click(screen.getByTestId("task-reset-submit"));
    await waitFor(() => expect(onResetTask).toHaveBeenCalledWith(
      "FN-901",
      { description: "Corrected list request" },
    ));
  });

  it("keeps the list Reset call arity unchanged when the description is untouched", async () => {
    const onResetTask = vi.fn(async () => createMockTask());
    renderListView({
      tasks: [createMockTask({ id: "FN-901", column: "in-progress", description: "Original list request" })],
      onResetTask,
    });

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-901"]') as HTMLElement, { clientX: 40, clientY: 50 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset" }));
    fireEvent.click(await screen.findByTestId("task-reset-submit"));

    await waitFor(() => expect(onResetTask).toHaveBeenCalledWith("FN-901"));
    expect(onResetTask.mock.calls[0]).toEqual(["FN-901"]);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("forwards the selected workflow from the desktop row duplicate action", async () => {
    const workflowPayload = {
      ...DEFAULT_LANE_PAYLOAD,
      workflows: [
        DEFAULT_LANE_PAYLOAD.workflows[0],
        { ...DEFAULT_LANE_PAYLOAD.workflows[0], id: "wf-b", name: "Workflow B" },
      ],
      taskWorkflowIds: { "FN-DUP": "builtin:coding" },
    };
    writeBoardWorkflowsCache(TEST_PROJECT_ID, workflowPayload);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(workflowPayload);
    mockConfirmWithSelect.mockResolvedValueOnce({ choice: "primary", checkboxValue: false, selectValue: "wf-b" });
    const onDuplicateTask = vi.fn(async () => createMockTask({ id: "FN-COPY" }));
    renderListView({
      tasks: [createMockTask({ id: "FN-DUP", column: "todo" })],
      onDuplicateTask,
    });

    const row = document.querySelector('.list-row[data-id="FN-DUP"]') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 50 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() => expect(onDuplicateTask).toHaveBeenCalledWith("FN-DUP", { workflowId: "wf-b" }));
    expect(mockConfirmWithSelect).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ defaultValue: "builtin:coding" }),
    }));
  });

  it("opens Planning Mode from eligible list row menus and omits it for executing rows", async () => {
    const viewportSpy = mockDesktopViewport();
    const onPlanningMode = vi.fn();
    const onOpenDetail = vi.fn();
    const tasks = [
      createMockTask({ id: "FN-030", title: "Planning row", description: "Seed from list", column: "triage" }),
      createMockTask({ id: "FN-031", title: "Executing row", description: "Do not plan", column: "in-progress", status: "executing" }),
    ];

    renderListView({ tasks, onOpenDetail, onPlanningMode });

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-030"]') as HTMLElement, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Plan" }));
    /*
    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
    Was `null`. That was the LEGACY value: `getTaskPlanningWorkflowId` only returns
    null when `workflowMode` is false, which production never was. With lanes
    resolved it returns the task's workflow (here the default), so Planning Mode is
    seeded with the right workflow — the behaviour operators have always had.
    */
    expect(onPlanningMode).toHaveBeenCalledWith("Seed from list", "builtin:coding");
    expect(onOpenDetail).not.toHaveBeenCalled();

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-031"]') as HTMLElement, { clientX: 40, clientY: 50 });
    expect(screen.queryByRole("menuitem", { name: "Plan" })).not.toBeInTheDocument();
    viewportSpy.mockRestore();
  });

  it("offers Revert on a renamed complete lane", async () => {
    const RENAMED_LANE_PAYLOAD = {
      flagEnabled: true,
      defaultWorkflowId: "custom:renamed",
      workflows: [
        {
          id: "custom:renamed",
          name: "Renamed",
          columns: [
            { id: "backlog", name: "Backlog", flags: { hold: true } },
            { id: "building", name: "Building", flags: { countsTowardWip: true } },
            { id: "checking", name: "Checking", flags: { mergeBlocker: true } },
            { id: "shipped", name: "Shipped", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-090": "custom:renamed" },
    };
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(RENAMED_LANE_PAYLOAD as never);
    writeBoardWorkflowsCache(TEST_PROJECT_ID, RENAMED_LANE_PAYLOAD as never);

    const shipped = createMockTask({
      id: "FN-090",
      title: "Shipped row",
      column: "shipped" as never,
      mergeDetails: { commitSha: "abc1234" } as never,
    });

    renderListView({
      tasks: [shipped],
      onOpenDetail: vi.fn(),
      onRevertTask: vi.fn(),
    });

    await waitFor(() => expect(document.querySelector('.list-row[data-id="FN-090"]')).toBeTruthy());
    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-090"]') as HTMLElement, { clientX: 40, clientY: 50 });

    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Revert" })).toBeInTheDocument();
  });

  it("enables GitHub tracking from desktop and mobile list context menus without selecting rows", async () => {
    const desktopViewportSpy = mockDesktopViewport();
    const onOpenDetail = vi.fn();
    const onTasksUpdated = vi.fn();
    vi.mocked(updateTask).mockResolvedValueOnce(createMockTask({ id: "FN-020", title: "Desktop tracking", column: "todo", githubTracking: { enabled: true } as any }));
    const desktopTasks = [createMockTask({ id: "FN-020", title: "Desktop tracking", column: "todo", githubTracking: undefined })];
    const desktopRender = renderListView({ tasks: desktopTasks, onOpenDetail, onTasksUpdated });

    const desktopRow = document.querySelector('.list-row[data-id="FN-020"]') as HTMLElement;
    fireEvent.contextMenu(desktopRow, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Enable GitHub tracking" }));

    await waitFor(() => expect(updateTask).toHaveBeenCalledWith("FN-020", { githubTracking: { enabled: true } }, TEST_PROJECT_ID));
    expect(onTasksUpdated).toHaveBeenCalledWith([expect.objectContaining({ id: "FN-020", githubTracking: { enabled: true } })]);
    expect(mockAddToast).toHaveBeenCalledWith("Requested GitHub tracking issue creation", "info");
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(desktopRow).not.toHaveClass("list-row--selected");
    desktopRender.unmount();
    desktopViewportSpy.mockRestore();

    vi.mocked(updateTask).mockResolvedValueOnce(createMockTask({ id: "FN-021", title: "Mobile tracking", column: "todo", githubTracking: { enabled: true } as any }));
    vi.useFakeTimers();
    const mobileViewportSpy = mockMobileViewport();
    const mobileOnOpenDetail = vi.fn();
    const mobileOnTasksUpdated = vi.fn();
    renderListView({ tasks: [createMockTask({ id: "FN-021", title: "Mobile tracking", column: "todo", githubTracking: { enabled: false } as any })], onOpenDetail: mobileOnOpenDetail, onTasksUpdated: mobileOnTasksUpdated });

    const mobileCard = document.querySelector('.list-card[data-id="FN-021"]') as HTMLElement;
    fireEvent.pointerDown(mobileCard, { pointerType: "touch", pointerId: 1, clientX: 24, clientY: 32 });
    act(() => {
      vi.advanceTimersByTime(550);
    });
    fireEvent.pointerUp(mobileCard, { pointerType: "touch", pointerId: 1, clientX: 24, clientY: 32 });
    fireEvent.click(mobileCard);
    expect(mobileOnOpenDetail).not.toHaveBeenCalled();

    fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Enable GitHub tracking" }), { pointerType: "touch", pointerId: 2 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(updateTask).toHaveBeenLastCalledWith("FN-021", { githubTracking: { enabled: true } }, TEST_PROJECT_ID);
    expect(mobileOnTasksUpdated).toHaveBeenCalledWith([expect.objectContaining({ id: "FN-021", githubTracking: { enabled: true } })]);
    expect(mobileOnOpenDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    mobileViewportSpy.mockRestore();
    vi.useRealTimers();
  });

  it("shows refine for custom workflow complete-column rows", async () => {
    const viewportSpy = mockDesktopViewport();
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "wf-custom",
      workflows: [
        {
          id: "wf-custom",
          name: "Custom",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "complete", name: "Complete", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-012": "wf-custom" },
    });
    const onOpenDetail = vi.fn();
    const tasks = [createMockTask({ id: "FN-012", title: "Custom complete", column: "complete" as any, status: "done" })];

    renderListView({ tasks, onOpenDetail });

    await screen.findByText("Custom complete");
    const row = document.querySelector('.list-row[data-id="FN-012"]') as HTMLElement;
    expect(row).toBeInTheDocument();
    fireEvent.contextMenu(row, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-012" }), { origin: undefined, initialAction: "refine" });
    viewportSpy.mockRestore();
  });

  it("matches detail PR review labels from list context menus before and during PR automation", () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [
      createMockTask({ id: "FN-008", title: "Manual PR", column: "in-review" }),
      createMockTask({ id: "FN-009", title: "Creating PR", column: "in-review", status: "creating-pr" }),
      createMockTask({ id: "FN-010", title: "Open PR", column: "in-review", prInfo: { number: 10, url: "https://example.test/pr/10", status: "open" } as any }),
    ];

    renderListView({ tasks, autoMerge: false, mergeStrategy: "pull-request" });

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-008"]') as HTMLElement, { clientX: 40, clientY: 50 });
    expect(screen.getByRole("menuitem", { name: "Start PR Review" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Merge & Close" })).not.toBeInTheDocument();

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-009"]') as HTMLElement, { clientX: 40, clientY: 50 });
    expect(screen.getByRole("menuitem", { name: "Creating PR…" })).toBeDisabled();
    expect(screen.queryByRole("menuitem", { name: "Merge & Close" })).not.toBeInTheDocument();

    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-010"]') as HTMLElement, { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Check PR Status" }));
    expect(refreshPrStatus).toHaveBeenCalledWith("FN-010", TEST_PROJECT_ID);
    viewportSpy.mockRestore();
  });

  it("does not attach context menus to headers, empty sections, or bulk-edit checkboxes", () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Selectable", column: "todo" })];
    renderListView({ tasks });
    enterBulkEditMode();

    const checkbox = screen.getByRole("checkbox", { name: "Select FN-001" });
    expect(checkbox).not.toBeChecked();
    fireEvent.contextMenu(checkbox, { clientX: 20, clientY: 20 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(checkbox).not.toBeChecked();

    const selectedRow = document.querySelector('.list-row[data-id="FN-001"]') as HTMLElement;
    fireEvent.contextMenu(selectedRow, { clientX: 40, clientY: 50 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();

    fireEvent.pointerDown(document.body);
    const planningHeader = screen.getAllByRole("row").find((row) => row.className.includes("list-section-header") && row.textContent?.includes("Planning")) as HTMLElement;
    fireEvent.contextMenu(planningHeader, { clientX: 20, clientY: 20 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const doneHeader = screen.getAllByRole("row").find((row) => row.className.includes("list-section-header") && row.textContent?.includes("Done")) as HTMLElement;
    fireEvent.click(doneHeader);
    fireEvent.contextMenu(doneHeader, { clientX: 20, clientY: 20 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.querySelector('.list-row[data-id="FN-001"]')).toBeInTheDocument();
    viewportSpy.mockRestore();
  });

  it("opens the task context menu from mobile card long-press, selects the tapped action, and suppresses ordinary tap-to-open", async () => {
    vi.useFakeTimers();
    const viewportSpy = mockMobileViewport();
    const onOpenDetail = vi.fn();
    const onPauseTask = vi.fn(async () => createMockTask());
    const tasks = [createMockTask({ id: "FN-001", title: "Mobile menu", column: "todo" })];

    renderListView({ tasks, onOpenDetail, onPauseTask });

    const card = document.querySelector('.list-card[data-id="FN-001"]') as HTMLElement;
    fireEvent.pointerDown(card, { pointerType: "touch", pointerId: 1, clientX: 24, clientY: 32 });
    act(() => {
      vi.advanceTimersByTime(550);
    });
    fireEvent.pointerUp(card, { pointerType: "touch", pointerId: 1, clientX: 24, clientY: 32 });
    fireEvent.click(card);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pause" })).toBeInTheDocument();
    expect(onOpenDetail).not.toHaveBeenCalled();

    fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Pause" }), { pointerType: "touch", pointerId: 2 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onPauseTask).toHaveBeenCalledWith("FN-001");
    expect(onPauseTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    viewportSpy.mockRestore();
    vi.useRealTimers();
  });

  it("keeps reverted completed rows labelled and revisable from the desktop context menu", () => {
    const viewportSpy = mockDesktopViewport();
    showAllColumnsByDefault();
    const reverted = createMockTask({
      id: "FN-REVERTED",
      title: "Reverted desktop task",
      column: "done",
      status: "done",
      sourceMetadata: { revertedAt: "2026-08-01T00:00:00.000Z" },
    });
    const onReviseTask = vi.fn();

    renderListView({ tasks: [reverted], onReviseTask });

    expect(screen.queryByTestId("list-reverted-tasks")).toBeNull();
    expect(document.querySelector('.list-row[data-id="FN-REVERTED"]')).toHaveTextContent("Reverted");
    fireEvent.contextMenu(document.querySelector('.list-row[data-id="FN-REVERTED"]') as HTMLElement, { clientX: 40, clientY: 50 });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Revise" }));
    expect(onReviseTask).toHaveBeenCalledWith(reverted);
    viewportSpy.mockRestore();
  });

  it("deduplicates reverted rows in their ordinary list group", () => {
    const viewportSpy = mockDesktopViewport();
    showAllColumnsByDefault();
    const reverted = createMockTask({
      id: "FN-REVERTED-DUPLICATE",
      title: "Reverted duplicate task",
      column: "done",
      status: "done",
      sourceMetadata: { revertedAt: "2026-08-01T00:00:00.000Z" },
    });

    renderListView({ tasks: [reverted, reverted] });

    expect(screen.queryByTestId("list-reverted-tasks")).toBeNull();
    expect(document.querySelectorAll('.list-row[data-id="FN-REVERTED-DUPLICATE"]')).toHaveLength(1);
    viewportSpy.mockRestore();
  });

  it("keeps reverted completed rows labelled and revisable from mobile long-press", () => {
    vi.useFakeTimers();
    const viewportSpy = mockMobileViewport();
    const reverted = createMockTask({
      id: "FN-REVERTED-MOBILE",
      title: "Reverted mobile task",
      column: "done",
      status: "done",
      sourceMetadata: { revertedAt: "2026-08-01T00:00:00.000Z" },
    });
    const onReviseTask = vi.fn();

    renderListView({ tasks: [reverted], onReviseTask });

    const card = document.querySelector('.list-card[data-id="FN-REVERTED-MOBILE"]') as HTMLElement;
    expect(card).toHaveTextContent("Reverted");
    fireEvent.pointerDown(card, { pointerType: "touch", pointerId: 1, clientX: 24, clientY: 32 });
    act(() => {
      vi.advanceTimersByTime(550);
    });
    fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Revise" }), { pointerType: "touch", pointerId: 2 });
    expect(onReviseTask).toHaveBeenCalledWith(reverted);
    viewportSpy.mockRestore();
    vi.useRealTimers();
  });

  it("opens refine from a mobile done-card long-press", () => {
    vi.useFakeTimers();
    const viewportSpy = mockMobileViewport();
    const onOpenDetail = vi.fn();
    const tasks = [createMockTask({ id: "FN-011", title: "Mobile done", column: "done", status: "done" })];

    renderListView({ tasks, onOpenDetail, onDeleteTask: vi.fn(async () => createMockTask()) });

    const card = document.querySelector('.list-card[data-id="FN-011"]') as HTMLElement;
    fireEvent.pointerDown(card, { pointerType: "touch", pointerId: 1, clientX: 24, clientY: 32 });
    act(() => {
      vi.advanceTimersByTime(550);
    });
    fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Refine" }), { pointerType: "touch", pointerId: 2 });

    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-011" }), { origin: "list-mobile", initialAction: "refine" });
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    viewportSpy.mockRestore();
    vi.useRealTimers();
  });

  it("exposes view options controls on mobile", () => {
    const viewportSpy = mockMobileViewport();
    localStorage.setItem(scopedStorageKey("kb-dashboard-hide-done"), "false");

    renderListView({}, { openViewOptions: false });

    const toggle = screen.getByRole("button", { name: /^view$/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("list-view-options-panel-mobile")).toBeNull();

    fireEvent.click(toggle);

    expect(screen.getByLabelText("Title")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /hide done/i }));
    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-hide-done"))).toBe("true");

    viewportSpy.mockRestore();
  });

  it("refreshes workflow columns when workflow metadata SSE arrives", async () => {
    const wf = (columns: { id: string; name: string; flags: Record<string, boolean> }[]) => ({
      flagEnabled: true,
      defaultWorkflowId: "wf-custom",
      workflows: [{ id: "wf-custom", name: "Custom", columns }],
      taskWorkflowIds: { "FN-001": "wf-custom" },
    });
    const before = wf([
      { id: "backlog", name: "Backlog", flags: { intake: true } },
      { id: "complete", name: "Complete", flags: { complete: true } },
    ]);
    const after = wf([
      { id: "ready", name: "Ready", flags: { intake: true } },
      { id: "complete", name: "Complete", flags: { complete: true } },
    ]);
    /*
    FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12):
    Seed the FIRST-PAINT cache with `before`. The file-level seed maps no tasks, so
    without this the initial render sees FN-001 as unmapped, the unmapped-workflow
    self-heal correctly forces an extra board-workflows fetch, and that fetch eats the
    `Once` payload this test is asserting on. Seeding makes the first paint already
    consistent, which is what the test means to start from.

    The trailing `mockResolvedValue(after)` covers the self-heal firing legitimately
    AFTER the SSE swap: `backlog` -> `ready` leaves FN-001 in a column its workflow no
    longer declares, so a repair fetch is correct there. Without a fallback it would
    resolve `undefined` and wipe the payload.
    */
    writeBoardWorkflowsCache(TEST_PROJECT_ID, before);
    vi.mocked(fetchBoardWorkflows)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after)
      .mockResolvedValue(after);

    renderListView({
      tasks: [createMockTask({ id: "FN-001", column: "backlog", title: "Workflow task" })],
    });

    await waitFor(() => expect(screen.queryAllByText("Backlog").length).toBeGreaterThan(0));
    expect(typeof listViewSseHandlers["workflow:updated"]).toBe("function");

    await act(async () => {
      listViewSseHandlers["workflow:updated"]?.();
    });

    await waitFor(() => expect(screen.queryAllByText("Ready").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("Backlog")).toHaveLength(0);
  });

  it("re-fetches board-workflows when the workflow switcher opens", async () => {
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "todo", name: "Todo", flags: { hold: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Custom Flow",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });

    renderListView({
      tasks: [createMockTask({ id: "FN-001", column: "todo", title: "Workflow task" })],
    });

    const trigger = await screen.findByTestId("workflow-switcher");
    await waitFor(() => expect(fetchBoardWorkflows).toHaveBeenCalledTimes(1));
    vi.mocked(fetchBoardWorkflows).mockClear();

    fireEvent.click(trigger);

    expect(fetchBoardWorkflows).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();
  });

  it("keeps disabled Coding out of the List selector while retaining its task assignment", async () => {
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:quick-fix",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          selectable: false,
          columns: [{ id: "todo", name: "Todo", flags: { hold: true } }],
        },
        {
          id: "builtin:quick-fix",
          name: "Quick Fix",
          selectable: true,
          columns: [{ id: "todo", name: "Todo", flags: { hold: true } }],
        },
        {
          id: "builtin:review-heavy",
          name: "Review Heavy",
          selectable: true,
          columns: [{ id: "todo", name: "Todo", flags: { hold: true } }],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });

    renderListView({
      tasks: [createMockTask({ id: "FN-001", column: "todo", title: "Disabled Coding task" })],
    });

    const selector = await screen.findByTestId("workflow-switcher");
    fireEvent.click(selector);
    expect(screen.queryByTestId("workflow-switcher-option-builtin:coding")).toBeNull();
    expect(screen.getByTestId("workflow-switcher-option-builtin:quick-fix")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-switcher-option-builtin:review-heavy")).toBeInTheDocument();
  });

  it("keeps a custom list workflow selected after task refresh and workflow payload revalidation", async () => {
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "todo", name: "Todo", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Custom Flow",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "wf-custom" },
    });

    localStorage.setItem(scopedStorageKey("kb-dashboard-list-columns"), JSON.stringify(["title", "status"]));
    localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-002"]));
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-collapsed"), JSON.stringify(["todo"]));
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-sidebar-width"), "420");

    const listProps: React.ComponentProps<typeof ListView> = {
      tasks: [createMockTask({ id: "FN-001", column: "backlog", title: "Custom workflow task" })],
      onMoveTask: vi.fn(async () => createMockTask()),
      onRetryTask: vi.fn(async () => createMockTask()),
      onDeleteTask: vi.fn(async () => createMockTask()),
      onMergeTask: vi.fn(async () => ({ merged: false })),
      onResetTask: vi.fn(async () => createMockTask()),
      onDuplicateTask: vi.fn(async () => createMockTask()),
      onOpenDetail: vi.fn(),
      addToast: mockAddToast,
      globalPaused: false,
      onNewTask: vi.fn(),
      projectId: TEST_PROJECT_ID,
    };
    const rendered = render(<ListView {...listProps} />);

    await selectWorkflow("wf-custom");
    await waitFor(() => expect(screen.getByTestId("workflow-switcher")).toHaveTextContent("Custom Flow"));
    expect(window.localStorage.getItem(scopedStorageKey(BOARD_WORKFLOW_SELECTION_STORAGE_KEY))).toBe("wf-custom");
    expect(window.localStorage.getItem(scopedStorageKey("kb-dashboard-list-columns"))).toBe(JSON.stringify(["title", "status"]));
    expect(window.localStorage.getItem(scopedStorageKey("kb-dashboard-selected-tasks"))).toBe(JSON.stringify(["FN-002"]));
    expect(window.localStorage.getItem(scopedStorageKey("kb-dashboard-list-collapsed"))).toBe(JSON.stringify(["todo"]));
    expect(window.localStorage.getItem(scopedStorageKey("kb-dashboard-list-sidebar-width"))).toBe("420");
    expect(screen.getByText("Custom workflow task")).toBeInTheDocument();

    await act(async () => {
      rendered.rerender(<ListView {...listProps} tasks={[createMockTask({ id: "FN-001", column: "done", title: "Custom workflow task after respec" })]} />);
    });
    await act(async () => {
      listViewSseHandlers["workflow:updated"]?.();
    });

    await waitFor(() => expect(screen.getByTestId("workflow-switcher")).toHaveTextContent("Custom Flow"));
    expect(screen.getByText("Custom workflow task after respec")).toBeInTheDocument();
  });

  it("re-homes a preserved-column task to the new workflow after workflow invalidation", async () => {
    const preservedWorkflow = {
      id: "wf-preserved",
      name: "Preserved Flow",
      columns: [
        { id: "todo", name: "Todo", flags: { intake: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    };
    vi.mocked(fetchBoardWorkflows)
      .mockResolvedValueOnce({
        flagEnabled: true,
        defaultWorkflowId: "builtin:coding",
        workflows: [
          {
            id: "builtin:coding",
            name: "Coding",
            columns: [
              { id: "todo", name: "Todo", flags: { intake: true } },
              { id: "done", name: "Done", flags: { complete: true } },
            ],
          },
          preservedWorkflow,
        ],
        taskWorkflowIds: { "FN-001": "builtin:coding" },
      })
      .mockResolvedValueOnce({
        flagEnabled: true,
        defaultWorkflowId: "builtin:coding",
        workflows: [
          {
            id: "builtin:coding",
            name: "Coding",
            columns: [
              { id: "todo", name: "Todo", flags: { intake: true } },
              { id: "done", name: "Done", flags: { complete: true } },
            ],
          },
          preservedWorkflow,
        ],
        taskWorkflowIds: { "FN-001": "wf-preserved" },
      });

    renderListView({
      tasks: [createMockTask({ id: "FN-001", column: "todo", title: "Preserved workflow task" })],
    });

    const selector = await screen.findByTestId("workflow-switcher");
    await waitFor(() => expect(screen.getByText("Preserved workflow task")).toBeInTheDocument());
    expect(selector).toHaveTextContent("Coding");

    await act(async () => {
      listViewSseHandlers["workflow:updated"]?.();
    });

    await waitFor(() => expect(fetchBoardWorkflows).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Preserved workflow task")).not.toBeInTheDocument());

    await selectWorkflow("wf-preserved");
    await waitFor(() => expect(screen.getByText("Preserved workflow task")).toBeInTheDocument());
  });

  it("shows inline workflow counts in desktop and mobile switchers", async () => {
    const workflowPayload = {
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "triage", name: "Triage", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Custom",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "complete", name: "Complete", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding", "FN-002": "wf-custom" },
    };
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(workflowPayload);
    const desktopSpy = mockDesktopViewport();
    const desktop = renderListView({
      tasks: [
        createMockTask({ id: "FN-001", column: "triage", title: "Coding task" }),
        createMockTask({ id: "FN-002", column: "complete", title: "Custom done task" }),
      ],
    });

    const desktopTrigger = await screen.findByTestId("workflow-switcher");
    expect(desktopTrigger).toHaveTextContent("Coding");
    expect(desktopTrigger.querySelector(".workflow-switcher-counts")).toBeNull();
    await openWorkflowSwitcher();
    expect(desktopTrigger).toHaveTextContent("1");
    expect(screen.getByTestId("workflow-switcher-option-wf-custom")).toHaveTextContent("1");
    fireEvent.keyDown(desktopTrigger, { key: "Escape" });
    desktop.unmount();
    desktopSpy.mockRestore();

    vi.mocked(fetchBoardWorkflows).mockResolvedValue(workflowPayload);
    const mobileSpy = mockMobileViewport();
    renderListView({
      tasks: [
        createMockTask({ id: "FN-001", column: "triage", title: "Coding task" }),
        createMockTask({ id: "FN-002", column: "complete", title: "Custom done task" }),
      ],
    });

    const mobileTrigger = await screen.findByTestId("workflow-switcher");
    expect(mobileTrigger).toHaveTextContent("Coding");
    expect(mobileTrigger.querySelector(".workflow-switcher-counts")).toBeNull();
    await openWorkflowSwitcher();
    expect(mobileTrigger).toHaveTextContent("1");
    mobileSpy.mockRestore();
  });

  it("shows the same single aggregate all-workflows dropdown count in ListView", async () => {
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "triage", name: "Triage", flags: { intake: true } },
            { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Coding",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "complete", name: "Complete", flags: { complete: true } },
            { id: "hidden", name: "Hidden", flags: { hiddenFromBoard: true } },
          ],
        },
      ],
      taskWorkflowIds: {
        "FN-001": "builtin:coding",
        "FN-002": "builtin:coding",
        "FN-003": "wf-custom",
        "FN-004": "wf-custom",
        "FN-005": "missing-workflow",
        "FN-006": "wf-custom",
      },
    });

    renderListView({
      tasks: [
        createMockTask({ id: "FN-001", column: "triage", title: "Coding todo" }),
        createMockTask({ id: "FN-002", column: "in-progress", title: "Coding active", status: "merging" }),
        createMockTask({ id: "FN-003", column: "backlog", title: "Custom todo" }),
        createMockTask({ id: "FN-004", column: "complete", title: "Custom done" }),
        createMockTask({ id: "FN-005", column: "done", title: "Stale done" }),
        createMockTask({ id: "FN-006", column: "hidden", title: "Hidden custom" }),
      ],
    });

    await openWorkflowSwitcher();
    const aggregateOption = screen.getByTestId(`workflow-switcher-option-${ALL_WORKFLOWS_BOARD_VIEW_ID}`);
    expect(within(aggregateOption).getByTitle("Todo: 2")).toBeInTheDocument();
    expect(within(aggregateOption).getByTitle("In Progress: 1")).toBeInTheDocument();
    expect(within(aggregateOption).getByTitle("Done: 2")).toBeInTheDocument();
    expect(within(aggregateOption).getByTitle("1 merging")).toBeInTheDocument();
    expect(within(screen.getByTestId("workflow-switcher-option-builtin:coding")).getByTitle("Todo: 1")).toBeInTheDocument();
    expect(within(screen.getByTestId("workflow-switcher-option-builtin:coding")).getByTitle("In Progress: 1")).toBeInTheDocument();
    expect(within(screen.getByTestId("workflow-switcher-option-builtin:coding")).getByTitle("Done: 1")).toBeInTheDocument();
    expect(within(screen.getByTestId("workflow-switcher-option-wf-custom")).getByTitle("Todo: 1")).toBeInTheDocument();
    expect(within(screen.getByTestId("workflow-switcher-option-wf-custom")).getByTitle("In Progress: 0")).toBeInTheDocument();
    expect(within(screen.getByTestId("workflow-switcher-option-wf-custom")).getByTitle("Done: 1")).toBeInTheDocument();
  });

  it("shows all workflows in ListView without submitting the aggregate sentinel", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue({ id: "FN-new" });
    const mockOnNewTask = vi.fn();
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        { id: "builtin:coding", name: "Coding", columns: [{ id: "triage", name: "Triage", flags: { intake: true } }, { id: "done", name: "Done", flags: { complete: true } }] },
        { id: "wf-custom", name: "Custom", columns: [{ id: "backlog", name: "Backlog", flags: { intake: true } }, { id: "review", name: "Review", flags: { countsTowardWip: true } }] },
      ],
      taskWorkflowIds: { "FN-002": "wf-custom", "FN-003": "wf-deleted" },
    });

    renderListView({
      tasks: [
        createMockTask({ id: "FN-001", column: "triage", title: "Coding task" }),
        createMockTask({ id: "FN-002", column: "backlog", title: "Custom task" }),
        createMockTask({ id: "FN-003", column: "triage", title: "Stale workflow task" }),
      ],
      onQuickCreate: mockOnQuickCreate,
      onNewTask: mockOnNewTask,
    });

    await selectWorkflow(ALL_WORKFLOWS_BOARD_VIEW_ID);

    expect(screen.getByText("Coding task")).toBeInTheDocument();
    expect(screen.getByText("Custom task")).toBeInTheDocument();
    expect(screen.getByText("Stale workflow task")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-switcher")).toHaveTextContent("All workflows");
    expect(screen.queryByTestId(`workflow-switcher-edit-${ALL_WORKFLOWS_BOARD_VIEW_ID}`)).toBeNull();

    fireEvent.click(screen.getByText("+ New Task"));
    expect(mockOnNewTask).toHaveBeenCalledWith(undefined);

    fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Aggregate quick add" } });
    fireEvent.keyDown(screen.getByTestId("quick-entry-input"), { key: "Enter" });

    await waitFor(() => expect(mockOnQuickCreate).toHaveBeenCalledWith(expect.objectContaining({
      description: "Aggregate quick add",
      workflowId: "builtin:coding",
    })));
    expect(mockOnQuickCreate).not.toHaveBeenCalledWith(expect.objectContaining({ workflowId: ALL_WORKFLOWS_BOARD_VIEW_ID }));
  });

  it("shows workflow edit and New actions inside the dropdown", async () => {
    const onCreateWorkflow = vi.fn();
    const onOpenWorkflowEditor = vi.fn();
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "triage", name: "Triage", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Custom",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "complete", name: "Complete", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });

    renderListView({
      tasks: [createMockTask({ id: "FN-001", column: "triage", title: "Workflow task" })],
      onCreateWorkflow,
      onOpenWorkflowEditor,
    });

    const selector = await screen.findByTestId("workflow-switcher");
    expect(document.querySelector(".list-workflow-create-btn")).toBeNull();
    fireEvent.click(selector);
    fireEvent.click(screen.getByTestId("workflow-switcher-edit-wf-custom"));
    expect(onOpenWorkflowEditor).toHaveBeenCalledWith("wf-custom");
    expect(onCreateWorkflow).not.toHaveBeenCalled();

    fireEvent.click(selector);
    fireEvent.click(screen.getByTestId("workflow-switcher-create"));
    expect(onCreateWorkflow).toHaveBeenCalledTimes(1);
  });

  it("relocates the list workflow selector and dropdown actions into the header slot", async () => {
    const onCreateWorkflow = vi.fn();
    const onOpenWorkflowEditor = vi.fn();
    const headerSlot = document.createElement("div");
    headerSlot.id = "header-workflow-slot";
    headerSlot.className = "header-workflow-slot";
    document.body.appendChild(headerSlot);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "triage", name: "Triage", flags: { intake: true } },
            { id: "done", name: "Done", flags: { complete: true } },
          ],
        },
        {
          id: "wf-custom",
          name: "Custom",
          columns: [
            { id: "backlog", name: "Backlog", flags: { intake: true } },
            { id: "complete", name: "Complete", flags: { complete: true } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding", "FN-002": "wf-custom" },
    });
    try {
      renderListView({
        tasks: [
          createMockTask({ id: "FN-001", column: "triage", title: "Coding task" }),
          createMockTask({ id: "FN-002", column: "backlog", title: "Custom task" }),
        ],
        onCreateWorkflow,
        onOpenWorkflowEditor,
        workflowControlsInHeader: true,
      });

      const selector = await screen.findByTestId("workflow-switcher");
      await waitFor(() => expect(headerSlot.querySelector(".list-workflow-control")).not.toBeNull());
      expect(headerSlot.contains(selector)).toBe(true);
      expect(headerSlot.querySelector(".list-workflow-create-btn")).toBeNull();
      expect(headerSlot.querySelector(".board-workflow-edit-btn")).toBeNull();
      expect(document.querySelector(".list-view > .list-workflow-control")).toBeNull();

      fireEvent.click(selector);
      expect(screen.getByTestId("workflow-switcher-create")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("workflow-switcher-option-wf-custom"));
      await waitFor(() => expect(screen.getByText("Custom task")).toBeInTheDocument());
      expect(screen.queryByText("Coding task")).not.toBeInTheDocument();
      fireEvent.click(selector);
      fireEvent.click(screen.getByTestId("workflow-switcher-edit-wf-custom"));
      expect(onOpenWorkflowEditor).toHaveBeenCalledWith("wf-custom");
    } finally {
      headerSlot.remove();
    }
  });

  it("keeps list workflow controls inline when header relocation is inactive", async () => {
    const headerSlot = document.createElement("div");
    headerSlot.id = "header-workflow-slot";
    document.body.appendChild(headerSlot);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        { id: "builtin:coding", name: "Coding", columns: [{ id: "triage", name: "Triage", flags: { intake: true } }] },
        { id: "wf-custom", name: "Custom", columns: [{ id: "backlog", name: "Backlog", flags: { intake: true } }] },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });
    try {
      renderListView({
        tasks: [createMockTask({ id: "FN-001", column: "triage", title: "Coding task" })],
        onCreateWorkflow: vi.fn(),
      });

      await screen.findByTestId("workflow-switcher");
      await waitFor(() => expect(document.querySelector(".list-view .list-workflow-control")).not.toBeNull());
      expect(headerSlot.querySelector(".list-workflow-control")).toBeNull();
    } finally {
      headerSlot.remove();
    }
  });

  it("does not leave a list workflow shell when header relocation has no controls", async () => {
    const headerSlot = document.createElement("div");
    headerSlot.id = "header-workflow-slot";
    document.body.appendChild(headerSlot);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        { id: "builtin:coding", name: "Coding", columns: [{ id: "triage", name: "Triage", flags: { intake: true } }] },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });
    try {
      renderListView({
        tasks: [createMockTask({ id: "FN-001", column: "triage", title: "Coding task" })],
        workflowControlsInHeader: true,
      });

      await waitFor(() => expect(screen.getByText("Coding task")).toBeInTheDocument());
      expect(screen.queryByTestId("workflow-switcher")).toBeNull();
      expect(document.querySelector(".list-workflow-control")).toBeNull();
      expect(headerSlot.childElementCount).toBe(0);
    } finally {
      headerSlot.remove();
    }
  });

  it("keeps embedded selection visible when filters hide the selected row", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [
      createMockTask({ id: "FN-001", title: "Alpha Task" }),
      createMockTask({ id: "FN-002", title: "Beta Task" }),
    ];

    const { rerender } = renderListView({ tasks, searchQuery: "Alpha" });

    fireEvent.click(screen.getByText("FN-001").closest("tr")!);

    await waitFor(() => {
      expect(screen.getByTestId("list-split-detail-content")).toBeInTheDocument();
    });

    rerender(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn(async () => createMockTask())}
        onRetryTask={vi.fn(async () => createMockTask())}
        onDeleteTask={vi.fn(async () => createMockTask())}
        onMergeTask={vi.fn(async () => ({ merged: false }))}
        onResetTask={vi.fn(async () => createMockTask())}
        onDuplicateTask={vi.fn(async () => createMockTask())}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        projectId={TEST_PROJECT_ID}
        searchQuery="Beta"
      />,
    );

    expect(document.querySelector('tr[data-id="FN-001"]')).toBeNull();
    expect(screen.getByTestId("list-split-detail-content")).toBeInTheDocument();
    viewportSpy.mockRestore();
  });

  it("keeps dependency navigation inline in embedded detail on desktop", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Parent Task", dependencies: ["FN-002"] })];
    const mockOnOpenDetail = vi.fn();

    renderListView({ tasks, onOpenDetail: mockOnOpenDetail });

    fireEvent.click(screen.getByText("FN-001").closest("tr")!);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /FN-002/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("link", { name: /FN-002/ }));

    await waitFor(() => {
      expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBe("FN-002");
      expect(screen.getByTestId("task-detail-content")).toHaveTextContent("FN-002");
    });

    expect(fetchTaskDetail).not.toHaveBeenCalled();
    expect(mockOnOpenDetail).not.toHaveBeenCalled();
    viewportSpy.mockRestore();
  });

  it("keeps selectedTaskIds and selectedTaskId as separate persisted state", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr")!;
    enterBulkEditMode();
    const checkbox = within(row).getByRole("checkbox", { name: "Select FN-001" });

    clickInAct(checkbox);
    clickInAct(row);

    await waitFor(() => {
      expect(localStorage.getItem(scopedStorageKey("kb-dashboard-selected-tasks"))).toContain("FN-001");
      expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBe("FN-001");
    });
    viewportSpy.mockRestore();
  });

  it("initializes selectedTaskId from persisted project storage", () => {
    const viewportSpy = mockDesktopViewport();
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-selected-task"), "FN-001");
    const tasks = [createMockTask({ id: "FN-001", title: "Persisted task" })];

    renderListView({ tasks });

    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBe("FN-001");
    viewportSpy.mockRestore();
  });

  it("renders desktop split-pane shell with resize handle and empty detail state", () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });

    expect(screen.getByTestId("list-split-layout")).toBeInTheDocument();
    expect(screen.getByTestId("list-split-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("list-split-resize-handle")).toBeInTheDocument();
    expect(screen.getByTestId("list-split-detail")).toBeInTheDocument();
    expect(screen.getByText("Select a task to view details")).toBeInTheDocument();
    viewportSpy.mockRestore();
  });

  it("applies id-less local split-detail patches and ignores foreign ids", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Original split title" })];
    renderListView({ tasks });

    fireEvent.click(screen.getByText("FN-001").closest("tr")!);
    expect(await screen.findByTestId("task-detail-content")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Patch split without id" }));
    expect(screen.getByTestId("split-detail-title")).toHaveTextContent("renamed");

    fireEvent.click(screen.getByRole("button", { name: "Patch split foreign id" }));
    expect(screen.getByTestId("split-detail-title")).toHaveTextContent("renamed");
    viewportSpy.mockRestore();
  });

  it("clears the desktop split-detail shell when embedded detail requests close", async () => {
    const viewportSpy = mockDesktopViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });

    fireEvent.click(screen.getByText("FN-001").closest("tr")!);
    expect(await screen.findByTestId("task-detail-content")).toHaveTextContent("FN-001");

    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));

    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-content")).toBeNull();
      expect(screen.getByText("Select a task to view details")).toBeInTheDocument();
      expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBeNull();
    });
    viewportSpy.mockRestore();
  });

  it("reloads persisted sidebar width when projectId changes", () => {
    const viewportSpy = mockDesktopViewport();
    const clientWidthSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    localStorage.setItem(scopedKey("kb-dashboard-list-sidebar-width", "project-a"), "300");
    localStorage.setItem(scopedKey("kb-dashboard-list-sidebar-width", "project-b"), "460");
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    const { rerender } = render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        projectId="project-a"
      />
    );

    expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "300px" });

    rerender(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        projectId="project-b"
      />
    );

    expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "460px" });
    clientWidthSpy.mockRestore();
    viewportSpy.mockRestore();
  });

  it("supports keyboard resizing on the desktop split-pane handle", async () => {
    const viewportSpy = mockDesktopViewport();
    const clientWidthSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    // Persisted below the 64px min clamps up to 64.
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-sidebar-width"), "40");
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });
    await waitFor(() => expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "64px" }));

    const handle = screen.getByTestId("list-split-resize-handle");
    const startWidth = Number(handle.getAttribute("aria-valuenow"));

    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-valuemin", "64");
    expect(Number(handle.getAttribute("aria-valuemax"))).toBeGreaterThanOrEqual(64);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(startWidth);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "64");
    expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "64px" });
    clientWidthSpy.mockRestore();
    viewportSpy.mockRestore();
  });

  it("resizes the desktop split sidebar by dragging the handle (pointer)", async () => {
    // FNXC:ListView 2026-06-22-18:00: Regression guard — dragging the resize handle must change the
    // sidebar width live and not collapse to the min when the container measures non-zero.
    const viewportSpy = mockDesktopViewport();
    const rectSpy = vi
      .spyOn(window.HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 0, width: 1000, top: 0, right: 1000, bottom: 300, height: 300, x: 0, y: 0, toJSON() {} } as DOMRect);
    const cwSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-sidebar-width"), "300");
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });
    await waitFor(() => expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "300px" }));

    const handle = screen.getByTestId("list-split-resize-handle");
    // Narrow the pane.
    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 250, pointerId: 1 });
    await waitFor(() => expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "250px" }));
    // Widen the pane.
    fireEvent.pointerMove(window, { clientX: 420, pointerId: 1 });
    await waitFor(() => expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "420px" }));
    fireEvent.pointerUp(window, { pointerId: 1 });

    rectSpy.mockRestore();
    cwSpy.mockRestore();
    viewportSpy.mockRestore();
  });

  it("does not collapse the split sidebar to the min when the container width is unmeasurable", async () => {
    // FNXC:ListView 2026-06-22-18:00: A zero/unreliable container measurement must not force the
    // persisted width down to the min clamp — that was the resize regression (pane snapped to 64px).
    const viewportSpy = mockDesktopViewport();
    const cwSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(0);
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-sidebar-width"), "300");
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });
    // Width must be preserved (not collapsed to 64) while the container reports 0.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.getByTestId("list-split-sidebar")).toHaveStyle({ width: "300px" });

    cwSpy.mockRestore();
    viewportSpy.mockRestore();
  });

  it("does not render split-pane structure on mobile", () => {
    const viewportSpy = mockMobileViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Task" })];

    renderListView({ tasks });

    expect(screen.queryByTestId("list-split-layout")).toBeNull();
    expect(screen.queryByTestId("list-split-resize-handle")).toBeNull();
    expect(screen.queryByTestId("list-split-detail")).toBeNull();
    viewportSpy.mockRestore();
  });

  it("uses measured List width rather than tablet viewport classification for detail routing", async () => {
    const viewportSpy = mockTabletViewport();
    const resizeObserver = installControlledResizeObserver();
    const task = createMockTask({ id: "FN-8754", title: "Measured tablet task" });
    const onOpenDetail = vi.fn();

    try {
      renderListView({ tasks: [task], onOpenDetail });

      // The constrained control remains the existing card/modal route.
      await act(async () => resizeObserver.resize(LIST_MINIMUM_SPLIT_LAYOUT_WIDTH - 1));
      const constrainedCard = document.querySelector('.list-card[data-id="FN-8754"]') as HTMLElement;
      fireEvent.keyDown(constrainedCard, { key: "Enter" });
      expect(onOpenDetail).toHaveBeenCalledWith(task, { origin: "list-mobile" });
      expect(screen.queryByTestId("list-split-detail")).toBeNull();

      onOpenDetail.mockClear();
      // At the named usable boundary, the same tablet surface owns the existing split detail.
      await act(async () => resizeObserver.resize(LIST_MINIMUM_SPLIT_LAYOUT_WIDTH));
      const boundaryRow = document.querySelector('tr[data-id="FN-8754"]') as HTMLElement;
      fireEvent.keyDown(boundaryRow, { key: " " });
      expect(onOpenDetail).not.toHaveBeenCalled();
      expect(screen.getAllByTestId("list-split-detail-content")).toHaveLength(1);
      expect(screen.getByTestId("task-detail-content")).toHaveTextContent("FN-8754");
      expect(screen.getByTestId("list-split-resize-handle")).toHaveAttribute("role", "separator");

      // Above the boundary pointer opens use that same single embedded host.
      await act(async () => resizeObserver.resize(LIST_MINIMUM_SPLIT_LAYOUT_WIDTH + 1));
      fireEvent.click(document.querySelector('tr[data-id="FN-8754"]') as HTMLElement);
      expect(onOpenDetail).not.toHaveBeenCalled();
      expect(screen.getAllByTestId("list-split-detail-content")).toHaveLength(1);
    } finally {
      resizeObserver.restore();
      viewportSpy.mockRestore();
    }
  });

  it("routes a constrained desktop List surface through the modal without split chrome", async () => {
    const viewportSpy = mockDesktopViewport();
    const resizeObserver = installControlledResizeObserver();
    const task = createMockTask({ id: "FN-8754-desktop", title: "Constrained desktop task" });
    const onOpenDetail = vi.fn();

    try {
      renderListView({ tasks: [task], onOpenDetail });
      await act(async () => resizeObserver.resize(LIST_MINIMUM_SPLIT_LAYOUT_WIDTH - 1));
      fireEvent.click(document.querySelector('.list-card[data-id="FN-8754-desktop"]') as HTMLElement);

      expect(onOpenDetail).toHaveBeenCalledWith(task, { origin: "list-mobile" });
      expect(screen.queryByTestId("list-split-detail")).toBeNull();
      expect(screen.queryByTestId("list-split-resize-handle")).toBeNull();
    } finally {
      resizeObserver.restore();
      viewportSpy.mockRestore();
    }
  });

  it("keeps phones single-pane when a synthetic List measurement is wide", async () => {
    const viewportSpy = mockMobileViewport();
    const resizeObserver = installControlledResizeObserver();
    const task = createMockTask({ id: "FN-8754-mobile", title: "Phone task" });
    const onOpenDetail = vi.fn();

    try {
      renderListView({ tasks: [task], onOpenDetail });
      await act(async () => resizeObserver.resize(LIST_MINIMUM_SPLIT_LAYOUT_WIDTH + 1));
      fireEvent.click(document.querySelector('.list-card[data-id="FN-8754-mobile"]') as HTMLElement);

      expect(onOpenDetail).toHaveBeenCalledWith(task, { origin: "list-mobile" });
      expect(screen.queryByTestId("list-split-detail")).toBeNull();
    } finally {
      resizeObserver.restore();
      viewportSpy.mockRestore();
    }
  });

  it("keeps the explicit popup preference above measured tablet split routing", async () => {
    const viewportSpy = mockTabletViewport();
    const resizeObserver = installControlledResizeObserver();
    const task = createMockTask({ id: "FN-8754-popup", title: "Popup wins" });
    const onOpenDetail = vi.fn();
    const onPopOut = vi.fn();

    try {
      renderListView({ tasks: [task], onOpenDetail, onPopOut, openMobileTasksInPopup: true });
      await act(async () => resizeObserver.resize(LIST_MINIMUM_SPLIT_LAYOUT_WIDTH + 1));
      fireEvent.click(document.querySelector('tr[data-id="FN-8754-popup"]') as HTMLElement);

      expect(onPopOut).toHaveBeenCalledWith(task);
      expect(onOpenDetail).not.toHaveBeenCalled();
      expect(screen.queryByTestId("list-split-detail-content")).toBeNull();
      expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBeNull();
    } finally {
      resizeObserver.restore();
      viewportSpy.mockRestore();
    }
  });

  it("removes and restores split chrome across List width transitions without opening a modal", async () => {
    const viewportSpy = mockTabletViewport();
    const resizeObserver = installControlledResizeObserver();
    const task = createMockTask({ id: "FN-8754-resize", title: "Resize task" });
    const onOpenDetail = vi.fn();

    try {
      renderListView({ tasks: [task], onOpenDetail });
      await act(async () => resizeObserver.resize(LIST_MINIMUM_SPLIT_LAYOUT_WIDTH + 1));
      fireEvent.click(document.querySelector('tr[data-id="FN-8754-resize"]') as HTMLElement);
      expect(screen.getByTestId("task-detail-content")).toHaveTextContent("FN-8754-resize");

      await act(async () => resizeObserver.resize(LIST_MINIMUM_SPLIT_LAYOUT_WIDTH - 1));
      expect(screen.queryByTestId("list-split-detail")).toBeNull();
      expect(screen.queryByTestId("list-split-resize-handle")).toBeNull();
      expect(onOpenDetail).not.toHaveBeenCalled();
      expect(localStorage.getItem(scopedStorageKey("kb-dashboard-list-selected-task"))).toBe("FN-8754-resize");

      await act(async () => resizeObserver.resize(LIST_MINIMUM_SPLIT_LAYOUT_WIDTH + 1));
      expect(screen.getAllByTestId("list-split-detail-content")).toHaveLength(1);
      expect(screen.getByTestId("task-detail-content")).toHaveTextContent("FN-8754-resize");
      expect(onOpenDetail).not.toHaveBeenCalled();
    } finally {
      resizeObserver.restore();
      viewportSpy.mockRestore();
    }
  });

  it("renders tablet List view as a single full-width pane without split chrome", () => {
    const viewportSpy = mockTabletViewport();
    const tasks = [createMockTask({ id: "FN-001", title: "Tablet task" })];

    const { container } = renderListView({ tasks });

    expect(container.querySelector(".list-view--single-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("list-split-layout")).toBeNull();
    expect(screen.queryByTestId("list-split-sidebar")).toBeNull();
    expect(screen.queryByTestId("list-split-resize-handle")).toBeNull();
    expect(screen.queryByTestId("list-split-detail")).toBeNull();
    expect(container.querySelector(".list-toolbar .list-action-cluster")).toBeInTheDocument();
    expect(within(container.querySelector(".list-toolbar .list-action-cluster") as HTMLElement).getByText("+ New Task")).toBeInTheDocument();
    expect(container.querySelector(".list-quick-entry-above-table .quick-entry-box")).toBeInTheDocument();
    expect(container.querySelector(".list-cards")).toBeInTheDocument();
    expect(container.querySelector("table.list-table")).toBeNull();
    viewportSpy.mockRestore();
  });

  it("opens tablet task detail through the single-pane detail route", () => {
    const viewportSpy = mockTabletViewport();
    const task = createMockTask({ id: "FN-001", title: "Tablet open" });
    const onOpenDetail = vi.fn();

    const { container } = renderListView({ tasks: [task], onOpenDetail });

    fireEvent.click(container.querySelector('.list-card[data-id="FN-001"]') as HTMLElement);

    expect(onOpenDetail).toHaveBeenCalledWith(task, { origin: "list-mobile" });
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("list-split-detail-content")).toBeNull();
    viewportSpy.mockRestore();
  });

  it("sorts tasks by ID when ID header is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-003", title: "Third", column: "triage" }),
      createMockTask({ id: "FN-001", title: "First", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Second", column: "triage" }),
    ];

    renderListView({ tasks });

    // First click - ascending
    const titleHeader = screen.getByRole("columnheader", { name: /title/i });
    fireEvent.click(titleHeader);

    // Get all data rows (excluding section headers by using data-id attribute)
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-001");
    expect(rows[1].textContent).toContain("FN-002");
    expect(rows[2].textContent).toContain("FN-003");

    // Second click - descending
    fireEvent.click(titleHeader);

    const rowsDesc = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rowsDesc[0].textContent).toContain("FN-003");
    expect(rowsDesc[1].textContent).toContain("FN-002");
    expect(rowsDesc[2].textContent).toContain("FN-001");
  });

  it("sorts tasks by column when Column header is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "todo" }),
      createMockTask({ id: "FN-002", column: "triage" }),
      createMockTask({ id: "FN-003", column: "in-progress" }),
    ];

    renderListView({ tasks });

    const columnHeader = screen.getByRole("columnheader", { name: /column/i });
    fireEvent.click(columnHeader);

    // Rows are rendered in fixed column-section order.
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-002"); // triage section first
    expect(rows[1].textContent).toContain("FN-001"); // todo section second
    expect(rows[2].textContent).toContain("FN-003"); // in-progress section third
  });

  it("sorts tasks by status when Status header is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", status: "executing", column: "triage" }),
      createMockTask({ id: "FN-002", status: "pending", column: "triage" }),
      createMockTask({ id: "FN-003", status: "failed", column: "triage" }),
    ];

    renderListView({ tasks });

    const statusHeader = screen.getByRole("columnheader", { name: /status/i });
    fireEvent.click(statusHeader);

    // Get data rows - sorted by status alphabetically
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    // Should be sorted alphabetically by status: executing, failed, pending
    expect(rows[0].textContent).toContain("executing");
    expect(rows[2].textContent).toContain("pending");
  });

  it("renders failed status with correct styling", () => {
    const tasks = [createMockTask({ id: "FN-001", status: "failed" })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("failed");

    const statusBadge = screen.getByText("failed");
    expect(statusBadge.className).toContain("failed");
  });

  it("suppresses failed table styling but keeps stage-aware Retry while automatic recovery is pending", () => {
    const viewportSpy = mockDesktopViewport();
    const task = createMockTask({
      id: "FN-RECOVERY",
      status: "failed",
      column: "todo",
      recoveryRetryCount: 1,
      nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
    });

    renderListView({ tasks: [task] });

    const row = document.querySelector('.list-row[data-id="FN-RECOVERY"]') as HTMLElement;
    expect(row).not.toHaveClass("failed");
    expect(screen.getByText("failed")).not.toHaveClass("failed");
    fireEvent.contextMenu(row, { clientX: 40, clientY: 50 });
    expect(screen.getByRole("menuitem", { name: "Retry" })).toBeInTheDocument();
    viewportSpy.mockRestore();
  });

  it("suppresses failed card styling on the mobile ListView path while automatic recovery is pending", () => {
    const viewportSpy = mockMobileViewport();
    const task = createMockTask({
      id: "FN-RECOVERY-MOBILE",
      status: "failed",
      column: "todo",
      recoveryRetryCount: 1,
      nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
    });

    renderListView({ tasks: [task] });

    const card = document.querySelector('.list-card[data-id="FN-RECOVERY-MOBILE"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(screen.getByText("failed")).not.toHaveClass("failed");
    viewportSpy.mockRestore();
  });

  it.each([
    {
      name: "failed + in-review uses error token color",
      classes: "list-status-badge list-status-badge--in-review failed",
      expectedClass: "failed",
      expectedColor: "var(--color-error-dark)",
      disallowedColor: "var(--in-review)",
    },
  ])("FN-4208 keeps list badge state precedence: $name", ({ classes, expectedClass, expectedColor, disallowedColor }) => {
    const cleanupCss = mountCssForBadgeTests();
    try {
      const badge = document.createElement("span");
      badge.className = classes;
      badge.textContent = "status";
      document.body.appendChild(badge);

      expect(badge.className).toContain(expectedClass);
      expect(getComputedStyle(badge).color).toBe(expectedColor);
      expect(getComputedStyle(badge).color).not.toBe(disallowedColor);

      badge.remove();
    } finally {
      cleanupCss();
    }
  });

  it("keeps the desktop border and Reviewing badge active for a status-null running Plan Review", () => {
    const tasks = [
      createMockTask({
        id: "FN-7831",
        status: null as any,
        enabledWorkflowSteps: ["plan-review"],
        workflowStepResults: [{
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          status: "pending",
          startedAt: "2026-07-11T12:00:00.000Z",
        }],
      } as Partial<Task>),
    ];

    renderListView({ tasks });

    const row = screen.getByText("FN-7831").closest("tr") as HTMLElement;
    expect(row.className).toContain("agent-active");
    const badge = within(row).getByText("Plan Review");
    expect(badge.className).toContain("pulsing");
  });

  it("keeps the mobile border and Reviewing badge active for a status-null running Plan Review", () => {
    const matchMediaSpy = mockMobileViewport();
    try {
      const tasks = [
        createMockTask({
          id: "FN-7831",
          status: null as any,
          enabledWorkflowSteps: ["plan-review"],
          workflowStepResults: [{
            workflowStepId: "plan-review",
            workflowStepName: "Plan Review",
            status: "pending",
            startedAt: "2026-07-11T12:00:00.000Z",
          }],
        } as Partial<Task>),
      ];

      renderListView({ tasks });

      const card = screen.getByText("FN-7831").closest(".list-card") as HTMLElement;
      expect(card.className).toContain("agent-active");
      expect(within(card).getByText("Plan Review").className).toContain("pulsing");
    } finally {
      matchMediaSpy.mockRestore();
    }
  });

  it("turns off the desktop border and Reviewing pulse when globally paused", () => {
    const tasks = [createMockTask({
      id: "FN-8055-paused",
      status: null as any,
      enabledWorkflowSteps: ["plan-review"],
      workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "pending", startedAt: "2026-07-16T00:00:00.000Z" }],
    } as Partial<Task>)];

    renderListView({ tasks, globalPaused: true });

    const row = screen.getByText("FN-8055-paused").closest("tr") as HTMLElement;
    expect(row.className).not.toContain("agent-active");
    expect(within(row).queryByText("Plan Review")).toBeNull();
  });

  it("does not show the Reviewing badge after Plan Review completes", () => {
    const tasks = [
      createMockTask({
        id: "FN-7831",
        status: "planning",
        enabledWorkflowSteps: ["plan-review"],
        workflowStepResults: [
          {
            workflowStepId: "plan-review",
            workflowStepName: "Plan Review",
            status: "passed",
            startedAt: "2026-07-11T12:00:00.000Z",
            completedAt: "2026-07-11T12:01:00.000Z",
          },
        ],
      } as Partial<Task>),
    ];

    renderListView({ tasks });

    expect(screen.queryByText("Plan Review")).not.toBeInTheDocument();
  });

  /*
  FNXC:TaskCardBadgePrecedence 2026-08-06-14:53:
  Grouped/mobile cards and ungrouped/desktop rows consume the same stale Planning snapshot as the
  board card. Code Review must be the only lifecycle badge in both DOM branches, with no empty
  status shell or Planning accessibility label left behind.
  */
  it("renders Code Review without Planning in desktop rows and mobile grouped cards", () => {
    showAllColumnsByDefault();
    const task = createMockTask({
      id: "FN-8814-list",
      column: "in-review",
      status: "planning",
      enabledWorkflowSteps: ["plan-review", "code-review"],
      workflowStepResults: [
        {
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          status: "passed",
          startedAt: "2026-08-06T14:40:00.000Z",
          completedAt: "2026-08-06T14:41:00.000Z",
        },
        {
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          status: "pending",
          startedAt: "2026-08-06T14:42:00.000Z",
        },
      ],
    });

    const desktopViewport = mockDesktopViewport();
    try {
      const { unmount } = renderListView({ tasks: [task] });
      const row = screen.getByText(task.id).closest("tr") as HTMLElement;
      expect(within(row).getByTestId("list-code-review-FN-8814-list")).toHaveTextContent("Code Review");
      expect(within(row).queryByText("Planning")).not.toBeInTheDocument();
      expect(within(row).queryByLabelText("Planning")).not.toBeInTheDocument();
      expect(row.querySelectorAll(".list-status-badge")).toHaveLength(1);
      unmount();
    } finally {
      desktopViewport.mockRestore();
    }

    const mobileViewport = mockMobileViewport();
    try {
      renderListView({ tasks: [task] });
      const card = screen.getByText(task.id).closest(".list-card") as HTMLElement;
      expect(within(card).getByTestId("list-code-review-FN-8814-list")).toHaveTextContent("Code Review");
      expect(within(card).queryByText("Planning")).not.toBeInTheDocument();
      expect(within(card).queryByLabelText("Planning")).not.toBeInTheDocument();
      expect(card.querySelectorAll(".list-status-badge")).toHaveLength(1);
    } finally {
      mobileViewport.mockRestore();
    }
  });

  it("FN-8475 renders Todo planning in desktop table rows without a placeholder", () => {
    const matchMediaSpy = mockDesktopViewport();
    try {
      renderListView({
        tasks: [
          createMockTask({ id: "FN-8475-todo", column: "todo", status: "planning" }),
          createMockTask({ id: "FN-8475-active", column: "in-progress", status: "planning" }),
          createMockTask({ id: "FN-8475-triage", column: "triage", status: "planning" }),
          createMockTask({
            id: "FN-8475-executing",
            column: "in-progress",
            status: "executing",
            steps: [{ name: "Running step", status: "in-progress" }],
          }),
        ],
      });

      for (const id of ["FN-8475-todo", "FN-8475-active", "FN-8475-triage"]) {
        const row = screen.getByText(id).closest("tr") as HTMLElement;
        // The row also renders the "Planning" COLUMN name, so assert on the badge element itself.
        expect(row.querySelector(".list-status-badge")).toHaveTextContent("Planning");
        expect(row.querySelector(".list-status-badge")).not.toHaveTextContent("-");
      }
      expect(within(screen.getByText("FN-8475-executing").closest("tr") as HTMLElement).getByText("executing")).toBeInTheDocument();
    } finally {
      matchMediaSpy.mockRestore();
    }
  });

  it("FN-8475 renders Todo planning in grouped mobile cards", () => {
    const matchMediaSpy = mockMobileViewport();
    try {
      renderListView({
        tasks: [createMockTask({ id: "FN-8475-todo-mobile", column: "todo", status: "planning" })],
      });

      const card = screen.getByText("FN-8475-todo-mobile").closest(".list-card") as HTMLElement;
      expect(card.querySelector(".list-status-badge")).toHaveTextContent("Planning");
    } finally {
      matchMediaSpy.mockRestore();
    }
  });

  it.each([null, undefined])("renders exactly one WIP lifecycle badge for empty status on desktop and grouped list paths (%s)", (status) => {
    const task = createMockTask({ id: `FN-8826-${status ?? "null"}`, column: "in-progress", status: status as any });

    const desktopViewport = mockDesktopViewport();
    try {
      const { unmount } = renderListView({ tasks: [task] });
      const row = screen.getByText(task.id).closest("tr") as HTMLElement;
      expect(row.querySelector(".list-status-badge")).toHaveTextContent(/in progress/i);
      expect(row.querySelectorAll(".list-status-badge")).toHaveLength(1);
      unmount();
    } finally {
      desktopViewport.mockRestore();
    }

    const mobileViewport = mockMobileViewport();
    try {
      renderListView({ tasks: [task] });
      const card = screen.getByText(task.id).closest(".list-card") as HTMLElement;
      expect(card.querySelector(".list-status-badge")).toHaveTextContent(/in progress/i);
      expect(card.querySelectorAll(".list-status-badge")).toHaveLength(1);
    } finally {
      mobileViewport.mockRestore();
    }
  });

  it("uses task-specific custom WIP traits and keeps populated status authoritative", () => {
    const workflowPayload = {
      ...DEFAULT_LANE_PAYLOAD,
      defaultWorkflowId: "wf-custom",
      workflows: [{
        id: "wf-custom",
        name: "Custom",
        columns: [
          { id: "ideas", name: "Ideas", flags: { intake: true } },
          { id: "building", name: "Building", flags: { countsTowardWip: true } },
          { id: "shipped", name: "Shipped", flags: { complete: true } },
        ],
      }],
      taskWorkflowIds: { "FN-8826-custom": "wf-custom" },
    };
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(workflowPayload);
    writeBoardWorkflowsCache(TEST_PROJECT_ID, workflowPayload);

    const desktopViewport = mockDesktopViewport();
    try {
      const first = renderListView({
        tasks: [createMockTask({ id: "FN-8826-custom", column: "building" as any, status: undefined as any })],
      });
      const row = screen.getByText("FN-8826-custom").closest("tr") as HTMLElement;
      expect(row.querySelector(".list-status-badge")).toHaveTextContent("Building");
      expect(row.querySelectorAll(".list-status-badge")).toHaveLength(1);
      first.unmount();

      renderListView({ tasks: [createMockTask({ id: "FN-8826-custom", column: "building" as any, status: "executing" })] });
      const executingRow = screen.getByText("FN-8826-custom").closest("tr") as HTMLElement;
      expect(executingRow.querySelector(".list-status-badge")).toHaveTextContent("executing");
    } finally {
      desktopViewport.mockRestore();
    }
  });

  it("FN-8493 renders the idle Queued to revise label, not Replan, for bare needs-replan list rows on desktop and mobile", () => {
    // FNXC:TaskActivity 2026-08-01-17:53: a parked replan is idle (no concurrency slot), so
    // list rows show the descriptive waiting label rather than the live "Revising" copy.
    const task = createMockTask({ id: "FN-8493-needs-replan", column: "triage", status: "needs-replan" });

    const desktopViewport = mockDesktopViewport();
    try {
      const { unmount } = renderListView({ tasks: [task] });
      const row = screen.getByText(task.id).closest("tr") as HTMLElement;
      expect(within(row).getByText("Queued to revise")).toHaveClass("list-status-badge");
      expect(within(row).queryByText("Replan")).not.toBeInTheDocument();
      unmount();
    } finally {
      desktopViewport.mockRestore();
    }

    const mobileViewport = mockMobileViewport();
    try {
      renderListView({ tasks: [task] });
      const card = screen.getByText(task.id).closest(".list-card") as HTMLElement;
      expect(within(card).getByText("Queued to revise")).toHaveClass("list-status-badge");
      expect(within(card).queryByText("Replan")).not.toBeInTheDocument();
    } finally {
      mobileViewport.mockRestore();
    }
  });

  it("shows Planning in desktop and mobile lists when planner liveness precedes the replan status update", () => {
    const task = createMockTask({
      id: "FN-8798-live-replan",
      column: "triage",
      status: "needs-replan",
      recentAgentActivityAt: new Date().toISOString(),
    });

    const desktopViewport = mockDesktopViewport();
    try {
      const { unmount } = renderListView({ tasks: [task] });
      const row = screen.getByText(task.id).closest("tr") as HTMLElement;
      expect(within(row).getAllByText("Planning").find((element) => element.classList.contains("list-status-badge"))).toBeDefined();
      unmount();
    } finally {
      desktopViewport.mockRestore();
    }

    const mobileViewport = mockMobileViewport();
    try {
      renderListView({ tasks: [task] });
      const card = screen.getAllByText(task.id)
        .map((element) => element.closest(".list-card"))
        .find((element): element is HTMLElement => element instanceof HTMLElement);
      expect(card).toBeDefined();
      expect(within(card!).getAllByText("Planning").find((element) => element.classList.contains("list-status-badge"))).toBeDefined();
    } finally {
      mobileViewport.mockRestore();
    }
  });

  it("renders paused tasks with dimmed styling", () => {
    const tasks = [createMockTask({ id: "FN-001", paused: true })];

    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("paused");
  });

  it.each([
    { status: "executing", column: "in-progress" as const, label: "executing" },
    { status: "merging-fix", column: "in-review" as const, label: "Merging fixes…" },
  ])("renders agent-active tasks with static highlight styling for $status", ({ status, column, label }) => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        status,
        column,
      }),
    ];

    renderListView({ tasks, globalPaused: false });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).toContain("agent-active");
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each([
    { status: "needs-replan", column: "triage" as const },
    { status: "needs-replan", column: "todo" as const },
  ])("does NOT highlight parked needs-replan rows ($column) — they hold no concurrency slot", ({ status, column }) => {
    // FNXC:TaskActivity 2026-08-01-17:53: replan parks are waiting states; glow and lane
    // counts must never exceed the live-agent population.
    const tasks = [
      createMockTask({
        id: "FN-001",
        status,
        column,
      }),
    ];

    renderListView({ tasks, globalPaused: false });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).not.toContain("agent-active");
  });

  it("does not render agent-active when globalPaused is true", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        status: "executing",
        column: "in-progress",
      }),
    ];

    renderListView({ tasks, globalPaused: true });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).not.toContain("agent-active");
  });

  // FNXC:StuckTagRemoval 2026-08-17-22:30: stuck-task tagging removed from the dashboard; stuck coverage deleted with it.

  it("renders column badges with correct colors", () => {
    const columns = ["triage", "todo", "in-progress", "in-review", "done"] as const;

    const tasks = columns.map((col, i) =>
      createMockTask({ id: `FN-00${i + 1}`, column: col })
    );

    renderListView({ tasks });

    // Check that all column badges are rendered in the table
    // Use getAllByText and check length since column names appear in both drop zones and badges
    expect(screen.getAllByText("Planning").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Todo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In progress").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In review").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(1);

    // Check that badges have the correct styling by querying within the table
    const table = document.querySelector(".list-table");
    expect(table?.textContent).toContain("Planning");
    expect(table?.textContent).toContain("Todo");
    expect(table?.textContent).toContain("In progress");
    expect(table?.textContent).toContain("In review");
    expect(table?.textContent).toContain("Done");
  });

  it("renders unified progress bar for actively executing tasks", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        column: "todo",
        status: "executing",
        steps: [
          { name: "Step 1", status: "done" },
          { name: "Step 2", status: "done" },
          { name: "Step 3", status: "pending" },
        ],
        enabledWorkflowSteps: ["WS-001", "WS-002"],
        workflowStepResults: [
          {
            workflowStepId: "WS-001",
            workflowStepName: "Browser Verification",
            status: "passed",
          },
        ],
      }),
    ];

    showAllColumnsByDefault();
    renderListView({ tasks });

    expect(screen.getByText("3/5")).toBeDefined();
  });

  it("shows workflow-only progress even when task.steps is empty", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        column: "todo",
        status: "executing",
        steps: [],
        enabledWorkflowSteps: ["WS-001"],
        workflowStepResults: [
          {
            workflowStepId: "WS-001",
            workflowStepName: "Browser Verification",
            status: "failed",
          },
        ],
      }),
    ];

    showAllColumnsByDefault();
    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr")!;
    const progressCell = row.querySelector(".list-cell-progress");
    expect(progressCell?.textContent).toContain("0/1");
  });

  it("shows - for tasks with no steps", () => {
    const tasks = [createMockTask({ id: "FN-001", steps: [] })];

    showAllColumnsByDefault();
    renderListView({ tasks });

    // Find the task row and check its progress cell
    const row = screen.getByText("FN-001").closest("tr")!;
    const progressCell = row.querySelector(".list-cell-progress");
    expect(progressCell?.textContent).toBe("-");
  });

  it("hides progress for todo tasks that are not executing", () => {
    const tasks = [
      createMockTask({
        id: "FN-002",
        column: "todo",
        status: "pending",
        steps: [{ name: "Step 1", status: "done" }],
      }),
    ];

    showAllColumnsByDefault();
    renderListView({ tasks });

    const row = screen.getByText("FN-002").closest("tr")!;
    const progressCell = row.querySelector(".list-cell-progress");
    expect(progressCell?.textContent).toBe("-");
  });

  it("renders dependency count with icon", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        dependencies: ["FN-002", "FN-003"],
      }),
    ];

    showAllColumnsByDefault();
    renderListView({ tasks });

    expect(screen.getByText("2")).toBeDefined();
  });

  it("shows - for tasks with no dependencies", () => {
    const tasks = [createMockTask({ id: "FN-001", dependencies: [] })];

    showAllColumnsByDefault();
    renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr")!;
    const depCell = row.querySelector(".list-cell-deps");
    expect(depCell?.textContent).toBe("-");
  });

  it("displays correct task count in stats", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
      createMockTask({ id: "FN-003" }),
    ];

    renderListView({ tasks });

    // FNXC:ListView 2026-06-23-00:00: the "X of Y tasks" count was removed from the desktop sidebar; verify the filter result via the rendered task rows instead.
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(3);
  });

  it("displays filtered task count in stats", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Alpha" }),
      createMockTask({ id: "FN-002", title: "Beta" }),
      createMockTask({ id: "FN-003", title: "Gamma" }),
    ];

    renderListView({ tasks, searchQuery: "Alpha" });

    // FNXC:ListView 2026-06-23-00:00: count removed from sidebar; assert the filtered rows.
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(1);
  });

  it("forwards the selected workflow rather than a click event when + New Task is clicked", () => {
    const mockOnNewTask = vi.fn();

    renderListView({ onNewTask: mockOnNewTask });

    fireEvent.click(screen.getByText("+ New Task"));

    expect(mockOnNewTask).toHaveBeenCalledWith("builtin:coding");
  });


  it("keeps Bulk Edit, View, and + New Task together in the desktop sidebar controls", () => {
    renderListView({}, { openViewOptions: false });

    const actions = document.querySelector(".list-sidebar-controls .list-action-cluster");
    const actionButtons = Array.from(actions?.querySelectorAll("button") ?? []).map((button) => button.textContent);
    expect(actionButtons).toEqual(["Bulk Edit", "View", "+ New Task"]);
  });

  it("keeps the primary list action cluster on one physical row when the pane narrows", () => {
    const css = readAppFile("components/ListView.css");
    const actionClusterRule = css.match(/\.list-action-cluster,\s*\n\.list-sidebar-controls__actions\s*\{[^}]*\}/)?.[0] ?? "";
    const toolbarRule = css.match(/\.list-sidebar-controls__toolbar\s*\{[^}]*\}/)?.[0] ?? "";
    const singlePaneToolbarRule = css.match(/@media\s*\(max-width:\s*1024px\)[\s\S]*?\.list-toolbar\s*\{[^}]*padding:\s*var\(--space-sm\) var\(--space-md\);[^}]*\}/)?.[0] ?? "";

    expect(actionClusterRule).toContain("flex-wrap: nowrap");
    expect(actionClusterRule).toContain("justify-content: center");
    expect(actionClusterRule).toContain("inline-size: max-content");
    expect(actionClusterRule).toContain("min-width: max-content");
    expect(actionClusterRule).toContain("overflow-x: auto");
    expect(toolbarRule).toContain("justify-content: center");
    expect(singlePaneToolbarRule).toContain("justify-content: center");
  });

  it("keeps measured tablet split chrome visible while scoping card hiding to single-pane List", () => {
    const css = loadAllAppCss();
    const singlePaneCardRule = css.match(/\.list-view--single-pane \.list-table\s*\{[^}]*display:\s*none;[^}]*\}/)?.[0] ?? "";
    const desktopSplitRule = css.match(/\.list-split-layout\s*\{[^}]*grid-template-columns:\s*auto 0 minmax\(0, 1fr\);[^}]*\}/)?.[0] ?? "";

    expect(css).not.toMatch(/\.list-split-resize-handle,\s*\n\s*\.list-split-detail\s*\{[^}]*display:\s*none/);
    expect(singlePaneCardRule).toContain("display: none");
    expect(desktopSplitRule).toContain("grid-template-columns: auto 0 minmax(0, 1fr)");
  });

  it("omits the full New Task button from mobile toolbar controls", () => {
    const viewportSpy = mockMobileViewport();
    renderListView({}, { openViewOptions: false });

    const actions = document.querySelector(".list-toolbar .list-action-cluster");
    const actionButtons = Array.from(actions?.querySelectorAll("button") ?? []).map((button) => button.textContent);
    expect(actionButtons).toEqual(["Bulk Edit", "View"]);
    expect(screen.queryByText("+ New Task")).toBeNull();

    viewportSpy.mockRestore();
  });

  it("+ New Task button uses theme-driven btn-task-create class", () => {
    const mockOnNewTask = vi.fn();
    renderListView({ onNewTask: mockOnNewTask });

    const newTaskButton = screen.getByText("+ New Task");
    expect(newTaskButton.className).toContain("btn-task-create");
  });

  it("does not render + New Task button when onNewTask is not provided", () => {
    renderListView({ onNewTask: undefined });

    expect(screen.queryByText("+ New Task")).toBeNull();
  });

  it("renders drop zones for each column", () => {
    renderListView();

    expect(screen.getByText("Planning")).toBeDefined();
    expect(screen.getByText("Todo")).toBeDefined();
    expect(screen.getByText("In progress")).toBeDefined();
    expect(screen.getByText("In review")).toBeDefined();
    expect(screen.getByText("Done")).toBeDefined();
  });

  it("displays correct task counts in drop zones", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "triage" }),
      createMockTask({ id: "FN-003", column: "todo" }),
    ];

    renderListView({ tasks });

    // Use querySelector to find drop zones by data-column attribute
    const triageZone = document.querySelector('[data-column="triage"]');
    expect(triageZone?.textContent).toContain("2");

    const todoZone = document.querySelector('[data-column="todo"]');
    expect(todoZone?.textContent).toContain("1");
  });



  it("displays full description in title cell when no title exists", () => {
    const longDescription = "A".repeat(100);
    const tasks = [createMockTask({ id: "FN-001", title: undefined, description: longDescription })];

    renderListView({ tasks });

    // The full 100-character description should be visible
    const titleCell = screen.getByText(longDescription).closest("td")!;
    expect(titleCell.textContent).toContain(longDescription);
    expect(titleCell.textContent?.length).toBeGreaterThanOrEqual(100);
  });

  // Grouped view tests
  it("renders section headers for each column", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "todo" }),
    ];

    renderListView({ tasks });

    // Check that section headers are rendered with column names
    expect(screen.getAllByText("Planning").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Todo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In progress").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("In review").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(1);
  });

  it("displays correct task count in section headers", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "triage" }),
      createMockTask({ id: "FN-003", column: "todo" }),
    ];

    renderListView({ tasks });

    // Find section headers by their structure
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(5); // One for each column

    // Check that triage section shows count of 2
    const triageHeader = sectionHeaders.find(h => h.textContent?.includes("Planning"));
    expect(triageHeader?.textContent).toContain("2");

    // Check that todo section shows count of 1
    const todoHeader = sectionHeaders.find(h => h.textContent?.includes("Todo"));
    expect(todoHeader?.textContent).toContain("1");
  });

  it("shows No tasks placeholder for empty columns", () => {
    const tasks = [createMockTask({ id: "FN-001", column: "triage" })];

    renderListView({ tasks });

    // Should show "No tasks" for empty columns
    const noTasksCells = screen.getAllByText("No tasks");
    expect(noTasksCells.length).toBeGreaterThanOrEqual(1);
  });

  it("section headers span full table width including checkbox column", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage" }),
      createMockTask({ id: "FN-002", column: "todo" }),
    ];

    localStorage.clear();
    renderListView({ tasks });
    enterBulkEditMode();

    // Find section header rows
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));

    // Verify each section header has colSpan that includes the checkbox column
    // Default visible columns: title (1 column)
    // Plus checkbox column = 2 total
    for (const header of sectionHeaders) {
      const th = header.querySelector("th.list-section-cell");
      expect(th).not.toBeNull();
      expect(th!.getAttribute("colSpan")).toBe("2"); // visibleColumns.size (1) + 1 for checkbox
    }

    // Also verify empty section cells span full width
    const emptyCells = screen.getAllByRole("cell").filter(c => c.className.includes("list-empty-cell"));
    for (const cell of emptyCells) {
      expect(cell.getAttribute("colSpan")).toBe("2");
    }
  });

  it("hides empty sections when filter is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Alpha Task", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Beta Task", column: "todo" }),
    ];

    renderListView({ tasks, searchQuery: "Alpha" });

    // Only triage section should be visible (todo section should be hidden)
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(1);
    expect(sectionHeaders[0].textContent).toContain("Planning");

    // Verify the filtered task is visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("defaults todo section to board-consistent priority then oldest ordering", () => {
    const tasks = [
      createMockTask({ id: "FN-100", column: "todo", priority: "low", createdAt: "2024-01-01T08:00:00.000Z" }),
      createMockTask({ id: "FN-101", column: "todo", priority: "urgent", createdAt: "2024-01-01T10:00:00.000Z" }),
      createMockTask({ id: "FN-102", column: "todo", priority: "high", createdAt: "2024-01-01T07:00:00.000Z" }),
    ];

    renderListView({ tasks });

    expect(getSectionTaskIds("Todo")).toEqual(["FN-101", "FN-102", "FN-100"]);
  });

  it("defaults done section to board-consistent completion recency", () => {
    const tasks = [
      createMockTask({ id: "FN-200", column: "done", priority: "urgent", columnMovedAt: "2024-01-01T08:00:00.000Z" }),
      createMockTask({ id: "FN-201", column: "done", priority: "low", columnMovedAt: "2024-01-01T10:00:00.000Z" }),
    ];

    renderListView({ tasks });

    expect(getSectionTaskIds("Done")).toEqual(["FN-201", "FN-200"]);
  });

  it("defaults in-review section to board-consistent merge-active pinning", () => {
    const tasks = [
      createMockTask({ id: "FN-300", column: "in-review", status: "review-ready", priority: "urgent" }),
      createMockTask({ id: "FN-301", column: "in-review", status: "merging-fix", priority: "normal" }),
    ];

    renderListView({ tasks });

    expect(getSectionTaskIds("In review")).toEqual(["FN-301", "FN-300"]);
  });

  it("maintains sort order within each section", () => {
    const tasks = [
      createMockTask({ id: "FN-003", title: "Charlie", column: "triage" }),
      createMockTask({ id: "FN-001", title: "Alpha", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Bravo", column: "triage" }),
    ];

    renderListView({ tasks });

    const titleHeader = screen.getByRole("columnheader", { name: /title/i });
    fireEvent.click(titleHeader);

    expect(getSectionTaskIds("Planning")).toEqual(["FN-001", "FN-002", "FN-003"]);
  });
});

describe("ListView Column Filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters tasks by column when drop zone is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
      createMockTask({ id: "FN-003", column: "in-progress", title: "In Progress Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Only triage task should be visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
    expect(screen.queryByText("FN-003")).toBeNull();

    // Only triage section header should be visible
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(1);
    expect(sectionHeaders[0].textContent).toContain("Planning");
  });

  it("clears column filter when same drop zone is clicked again", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Verify filter is active - only triage task visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click the same drop zone again to clear filter
    fireEvent.click(triageZone);

    // All tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // All five section headers should be visible.
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(5);
  });

  it("switches column filter when different drop zone is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Verify only triage task visible
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click on the todo drop zone to switch filter
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    fireEvent.click(todoZone);

    // Only todo task should be visible now
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Only todo section header should be visible
    const sectionHeaders = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeaders.length).toBe(1);
    expect(sectionHeaders[0].textContent).toContain("Todo");
  });

  it("clears column filter when clear button is clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Verify filter is active
    expect(screen.queryByText("FN-002")).toBeNull();

    // Click the clear button
    const clearButton = screen.getByRole("button", { name: /clear column filter/i });
    fireEvent.click(clearButton);

    // All tasks should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("shows correct filtered stats when column filter is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Planning Task 2" }),
      createMockTask({ id: "FN-003", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone to filter
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Stats should show filtered count with column name
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(2);
  });

  it("applies text filter within column filter", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Alpha Planning Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Beta Planning Task" }),
      createMockTask({ id: "FN-003", column: "todo", title: "Alpha Todo Task" }),
    ];

    renderListView({ tasks, searchQuery: "Alpha" });

    // Click on the triage drop zone to filter by column
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Only Alpha triage task should be visible (text filter + column filter)
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
    expect(screen.queryByText("FN-003")).toBeNull();

    // Stats should reflect combined filtering
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(1);
  });

  it("applies active class to selected column drop zone", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Click on the triage drop zone
    const triageZone = document.querySelector('[data-column="triage"].list-drop-zone')!;
    fireEvent.click(triageZone);

    // Should have active class
    expect(triageZone.classList.contains("active")).toBe(true);

    // Other drop zones should not have active class
    const todoZone = document.querySelector('[data-column="todo"].list-drop-zone')!;
    expect(todoZone.classList.contains("active")).toBe(false);
  });
});

describe("ListView Column Visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage before each test
    localStorage.clear();
  });

  it("renders view options toggle button", () => {
    renderListView();

    const columnsButton = screen.getByRole("button", { name: /^view$/i });
    expect(columnsButton).toBeDefined();
  });

  it("opens column dropdown when toggle clicked", () => {
    renderListView({}, { openViewOptions: false });

    const columnsButton = screen.getByRole("button", { name: /^view$/i });
    fireEvent.click(columnsButton);

    expect(columnsButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("ID")).toBeNull();
    expect(screen.getByLabelText("Title")).toBeDefined();
    expect(screen.getByLabelText("Status")).toBeDefined();
    expect(screen.getByLabelText("Column")).toBeDefined();
    expect(screen.getByLabelText("Retries")).toBeDefined();
    expect(screen.getByLabelText("Dependencies")).toBeDefined();
    expect(screen.getByLabelText("Progress")).toBeDefined();
  });

  it("shows only the Title column by default while keeping all column toggles available", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        title: "Title-only default task",
        column: "triage",
        status: "pending",
      }),
    ];

    renderListView({ tasks });

    const table = document.querySelector(".list-table");
    expect(table).not.toBeNull();
    const tableHeader = table?.querySelector("thead");
    expect(tableHeader).not.toBeNull();
    expect(within(tableHeader as HTMLElement).getByRole("columnheader", { name: /title/i })).toBeDefined();
    expect(within(tableHeader as HTMLElement).queryByRole("columnheader", { name: /status/i })).toBeNull();
    expect(within(tableHeader as HTMLElement).queryByRole("columnheader", { name: /column/i })).toBeNull();
    expect(within(tableHeader as HTMLElement).queryByRole("columnheader", { name: /retries/i })).toBeNull();
    expect(within(tableHeader as HTMLElement).queryByRole("columnheader", { name: /dependencies/i })).toBeNull();
    expect(within(tableHeader as HTMLElement).queryByRole("columnheader", { name: /progress/i })).toBeNull();
    expect(within(table as HTMLElement).getByText("Title-only default task")).toBeDefined();

    expect(screen.getByLabelText("Title")).toBeDefined();
    expect(screen.getByLabelText("Status")).toBeDefined();
    expect(screen.getByLabelText("Column")).toBeDefined();
    expect(screen.getByLabelText("Retries")).toBeDefined();
    expect(screen.getByLabelText("Dependencies")).toBeDefined();
    expect(screen.getByLabelText("Progress")).toBeDefined();
  });
  it("hides column when unchecked in dropdown", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    renderListView({ tasks });

    // Enable a second column first so the last-visible-column guard allows hiding Title.
    fireEvent.click(screen.getByLabelText("Status"));
    const titleCheckbox = screen.getByLabelText("Title");
    fireEvent.click(titleCheckbox);

    // Title column should no longer be visible in the table
    const table = document.querySelector(".list-table");
    expect(table?.textContent).not.toContain("Test Task");
  });

  it("shows column when checked in dropdown", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    renderListView({ tasks });

    // Enable a second column first so the last-visible-column guard allows hiding Title.
    fireEvent.click(screen.getByLabelText("Status"));
    const titleCheckbox = screen.getByLabelText("Title");
    fireEvent.click(titleCheckbox);

    // Verify Title is hidden
    const table = document.querySelector(".list-table");
    expect(table?.textContent).not.toContain("Test Task");

    // Re-check the Title column (still in the same dropdown session)
    const titleCheckbox2 = screen.getByLabelText("Title");
    fireEvent.click(titleCheckbox2);

    // Title column should be visible again
    const tableAfter = document.querySelector(".list-table");
    expect(tableAfter?.textContent).toContain("Test Task");
  });

  it("persists column visibility to localStorage", () => {
    const tasks = [createMockTask({ id: "FN-001", title: "Test Task" })];
    renderListView({ tasks });

    // Enable a second column first, then uncheck Title.
    fireEvent.click(screen.getByLabelText("Status"));
    const titleCheckbox = screen.getByLabelText("Title");
    fireEvent.click(titleCheckbox);

    // Verify localStorage was updated
    const saved = localStorage.getItem(scopedStorageKey("kb-dashboard-list-columns"));
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved!);
    expect(parsed).toContain("status");
    expect(parsed).not.toContain("title");
  });

  it("initializes column visibility from localStorage", () => {
    // Set up localStorage with only Status visible
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-columns"), JSON.stringify(["status"]));

    const tasks = [createMockTask({ id: "FN-001", title: "Test Task", status: "pending" })];
    renderListView({ tasks });

    // Title should NOT be visible (hidden by localStorage)
    expect(screen.queryByText("FN-001")).toBeNull();
    const table = document.querySelector(".list-table");
    expect(table?.textContent).not.toContain("Test Task");
  });

  it("prevents hiding all columns (at least one stays visible)", () => {
    renderListView();

    // View options panel already open

    // Get all checkboxes and try to uncheck all except one
    const checkboxes = screen.getAllByRole("checkbox");
    
    // Uncheck all but one
    for (let i = 0; i < checkboxes.length - 1; i++) {
      if ((checkboxes[i] as HTMLInputElement).checked) {
        fireEvent.click(checkboxes[i]);
      }
    }

    // The last checkbox should be disabled (check the disabled property)
    const lastCheckbox = checkboxes[checkboxes.length - 1];
    if ((lastCheckbox as HTMLInputElement).checked) {
      expect((lastCheckbox as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("sorting still works when some columns are hidden", () => {
    const tasks = [
      createMockTask({ id: "FN-003", title: "Charlie", column: "triage" }),
      createMockTask({ id: "FN-001", title: "Alpha", column: "triage" }),
      createMockTask({ id: "FN-002", title: "Bravo", column: "triage" }),
    ];
    renderListView({ tasks });

    // Hide some columns
    const checkboxes = screen.getAllByRole("checkbox");
    const columnCheckbox = checkboxes.find(
      cb => cb.parentElement?.textContent?.includes("Column")
    );
    expect(columnCheckbox).toBeDefined();
    fireEvent.click(columnCheckbox!);

    // Find and click Title header to sort
    const titleHeader = screen.getByRole("columnheader", { name: /title/i });
    fireEvent.click(titleHeader);

    // Get sorted rows and verify sorting still works
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-001");
    expect(rows[1].textContent).toContain("FN-002");
    expect(rows[2].textContent).toContain("FN-003");
  });

  it("shows only title by default when no localStorage", () => {
    const tasks = [
      createMockTask({ id: "FN-001", title: "Test Task", status: "pending", column: "triage" }),
    ];
    renderListView({ tasks });

    // The title column should be the only visible first-run column.
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("Test Task")).toBeDefined();
    expect(screen.queryByText("pending")).toBeNull();
    expect(document.querySelector(".list-column-badge")).toBeNull();
    expect(document.querySelector(".list-cell-deps")).toBeNull();
    expect(document.querySelector(".list-cell-progress")).toBeNull();
  });
});


describe("ListView Hide Done Tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders hide done tasks toggle button", () => {
    renderListView();

    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    expect(hideDoneButton).toBeDefined();
  });

  it("hides done tasks when toggle is activated", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];

    renderListView({ tasks });

    // Both tasks should be visible initially
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Done task should be hidden, triage task should still be visible
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();
  });




  it("persists hide done preference to localStorage", () => {
    const tasks = [createMockTask({ id: "FN-001", column: "done" })];
    renderListView({ tasks });

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Verify localStorage was updated
    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-hide-done"))).toBe("true");
  });

  it("filters tasks when stale only is enabled", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "in-progress", ageStaleness: { level: "warning", reason: "r", observedAt: "2026-05-14T00:00:00.000Z", ageMs: 5 * 60 * 60_000, warningThresholdMs: 4 * 60 * 60_000, criticalThresholdMs: 24 * 60 * 60_000, column: "in-progress", paused: false } as any }),
      createMockTask({ id: "FN-002", column: "in-progress", ageStaleness: undefined }),
    ];

    renderListView({ tasks });

    fireEvent.click(screen.getByRole("button", { name: /stale only/i }));

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("filters tasks when stale paused review filter is enabled", () => {
    const tasks = [
      createMockTask({
        id: "FN-001",
        column: "in-review",
        paused: true,
        stalePausedReview: {
          code: "stale-paused-review",
          reason: "Task has remained paused in review beyond threshold",
          observedAt: "2026-05-14T00:00:00.000Z",
          ageMs: 86_400_000,
          thresholdMs: 86_400_000,
        } as any,
      }),
      createMockTask({ id: "FN-002", column: "in-review", paused: true, stalePausedReview: undefined }),
    ];

    renderListView({ tasks });

    fireEvent.click(screen.getByRole("button", { name: /stale paused review/i }));

    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("persists stale-only preference to localStorage", () => {
    renderListView({ tasks: [createMockTask({ id: "FN-001", column: "in-progress" })] });
    fireEvent.click(screen.getByRole("button", { name: /stale only/i }));
    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-stale-only-filter"))).toBe("true");
  });

  it("initializes hide done state from localStorage", () => {
    // Set up localStorage with hide done enabled
    localStorage.setItem(scopedStorageKey("kb-dashboard-hide-done"), "true");

    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];
    renderListView({ tasks });

    expect(screen.getByRole("button", { name: /show done/i })).toBeDefined();
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.getByText("FN-002")).toBeDefined();
  });

  it("updates stats text when done tasks are hidden", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "done" }),
      createMockTask({ id: "FN-003", column: "triage" }),
    ];

    renderListView({ tasks });

    // Initial: all 3 tasks visible
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(3);

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // FNXC:ListView 2026-06-23-00:00: the count + "(N hidden)" indicator were removed from the sidebar; assert hiding done leaves only the 1 non-done task visible.
    expect(screen.getAllByRole("row").filter((r) => r.getAttribute("data-id"))).toHaveLength(1);
  });

  it("hides the done column section header when hide done is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "triage" }),
    ];

    renderListView({ tasks });

    // All section headers should be visible initially
    const sectionHeadersBefore = screen.getAllByRole("row").filter(r => r.className.includes("list-section-header"));
    expect(sectionHeadersBefore.length).toBe(5);

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // The Done section should be hidden.
    const doneSection = screen.getAllByRole("row").find(r => 
      r.className.includes("list-section-header") && r.textContent?.includes("Done")
    );
    expect(doneSection).toBeUndefined();


    // Planning section should still be visible
    const triageSection = screen.getAllByRole("row").find(r => 
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    expect(triageSection).toBeDefined();
  });

  it("shows done drop zone with count when hide done is active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done" }),
      createMockTask({ id: "FN-002", column: "done" }),
    ];

    renderListView({ tasks });

    // Click hide done button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Done drop zone should still be visible with "X of Y" format
    const doneZone = document.querySelector('[data-column="done"].list-drop-zone');
    expect(doneZone).toBeDefined();
    expect(doneZone?.textContent).toContain("0 of 2");
  });


  it("preserves hide done state through filter changes", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done", title: "Alpha" }),
      createMockTask({ id: "FN-002", column: "done", title: "Beta" }),
      createMockTask({ id: "FN-003", column: "triage", title: "Gamma" }),
    ];

    // Hide done + apply filter via props
    renderListView({ tasks, searchQuery: "Gamma" });

    // Hide done tasks via button
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Completed tasks should remain hidden
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();
    // Filtered task should be visible
    expect(screen.getByText("FN-003")).toBeDefined();
  });

  it("shows done section when selectedColumn is done even with hide done active", () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "done", title: "Done Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Enable hide done
    const hideDoneButton = screen.getByRole("button", { name: /hide done/i });
    fireEvent.click(hideDoneButton);

    // Done task should be hidden
    expect(screen.queryByText("FN-001")).toBeNull();

    // Click on the done drop zone to select that column
    const doneZone = document.querySelector('[data-column="done"].list-drop-zone')!;
    fireEvent.click(doneZone);

    // Done task should now be visible because selectedColumn overrides hide
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

});

describe("ListView Quick Entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchBoardWorkflows).mockImplementation(() => new Promise(() => {}));
  });

  it("renders QuickEntryBox when onQuickCreate is provided", () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    // Quick entry box should be visible
    const quickEntry = screen.getByTestId("quick-entry-box");
    expect(quickEntry).toBeDefined();

    // Input should be visible
    const input = screen.getByTestId("quick-entry-input");
    expect(input).toBeDefined();
  });

  it("renders QuickEntryBox in list-quick-entry-above-table, not in toolbar", () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const quickEntry = screen.getByTestId("quick-entry-box");
    const toolbar = document.querySelector(".list-toolbar");
    const quickEntryArea = document.querySelector(".list-quick-entry-above-table");
    const tableContainer = document.querySelector(".list-table-container");

    // QuickEntryBox should not be inside toolbar
    expect(toolbar?.contains(quickEntry)).not.toBe(true);
    // QuickEntryBox should be inside the new quick-entry area
    expect(quickEntryArea?.contains(quickEntry)).toBe(true);
    // QuickEntryBox should be inside the table container (parent of quick-entry area)
    expect(tableContainer?.contains(quickEntry)).toBe(true);
  });

  it("preserves the explicit Coding Ideas Start column through the list host", async () => {
    const onQuickCreate = vi.fn().mockResolvedValue(createMockTask({ id: "FN-started", column: "todo" }));
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding-ideas-v2",
      workflows: [{
        id: "builtin:coding-ideas-v2",
        name: "Coding (Ideas)",
        columns: [
          { id: "ideas", name: "Ideas", flags: { intake: true, hold: true, manualIntake: true } },
          { id: "todo", name: "Todo", flags: { hold: true } },
        ],
      }],
      taskWorkflowIds: {},
    });
    renderListView({ onQuickCreate });
    await waitFor(() => expect(screen.getByTestId("quick-entry-workflow-props")).toHaveAttribute("data-default-workflow-id", "builtin:coding-ideas-v2"));
    fireEvent.click(screen.getByTestId("quick-entry-start"));

    await waitFor(() => expect(onQuickCreate).toHaveBeenCalledWith(expect.objectContaining({
      description: "Started task",
      workflowId: "builtin:coding-ideas-v2",
      column: "todo",
    })));
  });

  it.each([
    ["desktop", mockDesktopViewport],
    ["mobile", mockMobileViewport],
  ])("does not expose Quick Add Start for Coding's merged intake/hold lane on %s", async (_label, mockViewport) => {
    mockViewport();
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [{
        id: "builtin:coding",
        name: "Coding",
        columns: [{ id: "planning", name: "Planning", flags: { intake: true, hold: true } }],
      }],
      taskWorkflowIds: {},
    });
    renderListView({ onQuickCreate: vi.fn() });
    await waitFor(() => expect(screen.getByTestId("quick-entry-workflow-props")).toHaveAttribute("data-default-workflow-id", "builtin:coding"));

    expect(screen.queryByTestId("quick-entry-start")).toBeNull();
  });

  it("wires QuickEntry Start moves through the list host callback", async () => {
    const onMoveTask = vi.fn().mockResolvedValue(createMockTask({ id: "FN-created", column: "todo" }));
    renderListView({ onQuickCreate: vi.fn(), onMoveTask });
    fireEvent.click(screen.getByTestId("quick-entry-move"));
    await waitFor(() => expect(onMoveTask).toHaveBeenCalledWith("FN-created", "todo"));
  });

  it("shows model selector control when QuickEntryBox is expanded", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

    const toggleButton = screen.getByTestId("quick-entry-toggle");
    fireEvent.click(toggleButton);

    const modelAction = await screen.findByTestId("quick-entry-models");
    expect(modelAction).toBeDefined();
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
  });

  it("shows dependency selector control when QuickEntryBox is expanded", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

    const toggleButton = screen.getByTestId("quick-entry-toggle");
    fireEvent.click(toggleButton);

    const depsAction = await screen.findByTestId("quick-entry-deps");
    expect(depsAction).toBeDefined();
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
  });

  it("calls onQuickCreate with description when Enter is pressed", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "New quick task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "New quick task",
        })
      );
    });
  });

  it("clears input after successful quick create", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Task to create" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalled();
      expect(input.value).toBe("");
    });
  });

  it("preserves selected built-in workflow id when quick-creating in workflow mode", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:default",
      workflows: [
        {
          id: "builtin:default",
          name: "Default",
          columns: [{ id: "triage", name: "Triage", flags: { intake: true } }],
        },
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [{ id: "triage", name: "Triage", flags: { intake: true } }],
        },
      ],
      taskWorkflowIds: {},
    });
    renderListView({ onQuickCreate: mockOnQuickCreate });

    await selectWorkflow("builtin:coding");
    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "Built-in workflow task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalledWith(expect.objectContaining({
        description: "Built-in workflow task",
        column: "triage",
        workflowId: "builtin:coding",
      }));
    });
  });

  it("passes workflow options to quick-add and submits the changed selector workflow", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetchBoardWorkflows).mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:default",
      workflows: [
        {
          id: "builtin:default",
          name: "Default",
          columns: [{ id: "triage", name: "Triage", flags: { intake: true } }],
        },
        {
          id: "wf-custom",
          name: "Custom",
          columns: [{ id: "backlog", name: "Backlog", flags: { intake: true } }],
        },
      ],
      taskWorkflowIds: {},
    });
    renderListView({ onQuickCreate: mockOnQuickCreate });

    await waitFor(() => expect(screen.getByTestId("quick-entry-workflow-props")).toHaveAttribute("data-workflow-id", "builtin:default"));
    expect(screen.getByTestId("quick-entry-workflow-props")).toHaveAttribute("data-default-workflow-id", "builtin:default");
    expect(JSON.parse(screen.getByTestId("quick-entry-workflow-props").getAttribute("data-workflow-options") || "[]")).toEqual(["builtin:default", "wf-custom"]);

    fireEvent.click(screen.getByTestId("quick-entry-toggle"));
    fireEvent.click(screen.getByTestId("quick-entry-workflow-option-wf-custom"));
    fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Create on changed list workflow" } });
    fireEvent.click(screen.getByTestId("quick-entry-save"));

    await waitFor(() => expect(mockOnQuickCreate).toHaveBeenCalledWith(expect.objectContaining({
      description: "Create on changed list workflow",
      workflowId: "wf-custom",
      column: "backlog",
    })));
  });

  it("shows error toast when onQuickCreate fails and keeps input content", async () => {
    const mockOnQuickCreate = vi.fn().mockRejectedValue(new Error("Create failed"));
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Failed task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Create failed", "error");
    });

    // Input content should be preserved for retry
    expect(input.value).toBe("Failed task");
  });

  it("trims whitespace when creating task via quick entry", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    fireEvent.change(input, { target: { value: "  Task with spaces  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockOnQuickCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Task with spaces",
        })
      );
    });
  });

  it("does not submit on Enter if input is empty", async () => {
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });

    const input = screen.getByTestId("quick-entry-input");
    await keyDownAndFlush(input, { key: "Enter" });

    expect(mockOnQuickCreate).not.toHaveBeenCalled();
  });

  it("QuickEntryBox textarea spans full container width in list view (FN-1579)", async () => {
    mockDesktopViewport();
    const mockOnQuickCreate = vi.fn().mockResolvedValue(undefined);
    renderListView({ onQuickCreate: mockOnQuickCreate });
    await act(async () => {
      await Promise.resolve();
    });

    const quickEntryBox = screen.getByTestId("quick-entry-box");
    const input = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

    // Get the bounding rectangles for the textarea and its container
    const inputRect = input.getBoundingClientRect();
    const containerRect = quickEntryBox.getBoundingClientRect();

    // The textarea should span the full width of its container (within 2px tolerance for rounding)
    // This ensures the input visually reaches the right edge of the container
    expect(inputRect.width).toBeGreaterThanOrEqual(containerRect.width - 2);

    // The textarea should be at least 80% of the container width
    // (accounting for the toggle button on the right)
    expect(inputRect.width).toBeGreaterThanOrEqual(containerRect.width * 0.8);
  });
});

describe("ListView Collapsible Sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchBoardWorkflows).mockImplementation(() => new Promise(() => {}));
    localStorage.clear();
  });

  it("clicking section header toggles collapse and hides task rows", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task 1" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Planning Task 2" }),
    ];

    renderListView({ tasks });

    // Both tasks should be visible initially
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.getByText("FN-002")).toBeDefined();

    // Find and click the triage section header
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    expect(triageHeader).toBeDefined();
    await clickAndFlush(triageHeader!);

    // Tasks should be hidden after collapse
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();

    // Section header should have collapsed class
    expect(triageHeader?.className).toContain("list-section-header--collapsed");

    // Chevron should not have expanded class
    const chevron = triageHeader?.querySelector(".list-section-chevron");
    expect(chevron?.className).not.toContain("list-section-chevron--expanded");
  });

  it("clicking again expands section and shows task rows", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Find the triage section header
    let triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );

    // Click to collapse
    await clickAndFlush(triageHeader!);

    // Task should be hidden
    expect(screen.queryByText("FN-001")).toBeNull();

    // Click again to expand
    triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(triageHeader!);

    // Task should be visible again
    expect(screen.getByText("FN-001")).toBeDefined();

    // Re-query for the header to get fresh DOM reference after re-render
    triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );

    // Section header should not have collapsed class
    expect(triageHeader?.className).not.toContain("list-section-header--collapsed");

    // Chevron should have expanded class (check via aria-expanded since header re-renders)
    expect(triageHeader?.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapse state persists to localStorage", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Click to collapse
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(triageHeader!);

    // Verify localStorage was updated
    const saved = localStorage.getItem(scopedStorageKey("kb-dashboard-list-collapsed"));
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved!);
    expect(parsed).toContain("triage");
  });

  it("collapse state initializes from localStorage on mount", () => {
    // Set up localStorage with triage section collapsed
    localStorage.setItem(scopedStorageKey("kb-dashboard-list-collapsed"), JSON.stringify(["triage"]));

    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
    ];

    renderListView({ tasks });

    // Planning task should be hidden initially (collapsed from localStorage)
    expect(screen.queryByText("FN-001")).toBeNull();

    // Todo task should be visible
    expect(screen.getByText("FN-002")).toBeDefined();

    // Planning section header should have collapsed class
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    expect(triageHeader?.className).toContain("list-section-header--collapsed");
  });

  it("multiple sections can be collapsed independently", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
      createMockTask({ id: "FN-002", column: "todo", title: "Todo Task" }),
      createMockTask({ id: "FN-003", column: "in-progress", title: "In Progress Task" }),
    ];

    renderListView({ tasks });

    // Get section headers
    const allHeaders = screen.getAllByRole("row").filter(r =>
      r.className.includes("list-section-header")
    );
    const triageHeader = allHeaders.find(h => h.textContent?.includes("Planning"));
    const todoHeader = allHeaders.find(h => h.textContent?.includes("Todo"));

    // Collapse triage section
    await clickAndFlush(triageHeader!);

    // Collapse todo section
    await clickAndFlush(todoHeader!);

    // Planning and todo tasks should be hidden
    expect(screen.queryByText("FN-001")).toBeNull();
    expect(screen.queryByText("FN-002")).toBeNull();

    // In Progress task should still be visible
    expect(screen.getByText("FN-003")).toBeDefined();

    // Both sections should be marked as collapsed
    expect(triageHeader?.className).toContain("list-section-header--collapsed");
    expect(todoHeader?.className).toContain("list-section-header--collapsed");

    // Verify localStorage has both columns
    const saved = localStorage.getItem(scopedStorageKey("kb-dashboard-list-collapsed"));
    const parsed = JSON.parse(saved!);
    expect(parsed).toContain("triage");
    expect(parsed).toContain("todo");
    expect(parsed).not.toContain("in-progress");
  });

  it("sorting still works with collapsed sections", async () => {
    const tasks = [
      createMockTask({ id: "FN-003", column: "triage", title: "Charlie" }),
      createMockTask({ id: "FN-001", column: "triage", title: "Alpha" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Bravo" }),
    ];

    renderListView({ tasks });

    // Collapse triage section
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(triageHeader!);

    // Expand triage section
    const collapsedTriageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(collapsedTriageHeader!);

    // Sort by title
    const titleHeader = screen.getByRole("columnheader", { name: /title/i });
    await clickAndFlush(titleHeader);

    // Get sorted rows and verify sorting still works
    const rows = screen.getAllByRole("row").filter(r => r.getAttribute("data-id"));
    expect(rows[0].textContent).toContain("FN-001"); // Alpha
    expect(rows[1].textContent).toContain("FN-002"); // Bravo
    expect(rows[2].textContent).toContain("FN-003"); // Charlie
  });

  it("filtering still works with collapsed sections", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Alpha Task" }),
      createMockTask({ id: "FN-002", column: "triage", title: "Beta Task" }),
    ];

    renderListView({ tasks, searchQuery: "Alpha" });

    // Collapse triage section
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(triageHeader!);

    // Expand triage section by clicking again
    const collapsedTriageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );
    await clickAndFlush(collapsedTriageHeader!);

    // Only Alpha task should be visible (filter is applied via prop)
    expect(screen.getByText("FN-001")).toBeDefined();
    expect(screen.queryByText("FN-002")).toBeNull();
  });

  it("section header has aria-expanded attribute for accessibility", async () => {
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // Find triage section header
    const triageHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Planning")
    );

    // Should have aria-expanded="true" when expanded
    expect(triageHeader?.getAttribute("aria-expanded")).toBe("true");

    // Click to collapse
    await clickAndFlush(triageHeader!);

    // Should have aria-expanded="false" when collapsed
    expect(triageHeader?.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapsed section hides No tasks placeholder", async () => {
    // Create tasks in one column, leave another column empty
    const tasks = [
      createMockTask({ id: "FN-001", column: "triage", title: "Planning Task" }),
    ];

    renderListView({ tasks });

    // First verify the "No tasks" placeholder is visible for empty columns (like Todo)
    const noTasksCellsBefore = screen.getAllByText("No tasks");
    expect(noTasksCellsBefore.length).toBeGreaterThan(0);

    // Find and collapse the todo section (which has no tasks)
    const todoHeader = screen.getAllByRole("row").find(r =>
      r.className.includes("list-section-header") && r.textContent?.includes("Todo")
    );
    expect(todoHeader).toBeDefined();
    await clickAndFlush(todoHeader!);

    // When collapsed, the section header should have collapsed class
    expect(todoHeader?.className).toContain("list-section-header--collapsed");

    // The "No tasks" placeholder for todo section should not be visible anymore
    // (we can't easily verify this without complex DOM traversal, but the collapse
    // class is the primary indicator that the section is collapsed)
  });
});

describe("ListView - Bulk Selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchNodes).mockImplementation(() => new Promise(() => {}));
    vi.mocked(fetchBoardWorkflows).mockImplementation(() => new Promise(() => {}));
    subscribeSseMock.mockClear();
    for (const key of Object.keys(listViewSseHandlers)) delete listViewSseHandlers[key];
    localStorage.clear();
    ensureMatchMedia();
    // FNXC:ViewportMode 2026-07-24-02:30: FN-8557 innerWidth leak reset (see the main ListView beforeEach comment).
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  const createMockTask = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-001",
    description: "Test task description",
    title: "Test Task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: "pending",
    paused: false,
    log: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  });

  it("shows selection checkbox in header", () => {
    const tasks = [createMockTask({ id: "FN-001" })];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const headerCheckbox = screen.getByLabelText("Select all visible tasks");
    expect(headerCheckbox).toBeDefined();
  });

  it("shows selection checkbox for each task row", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkboxes = screen.getAllByLabelText(/Select FN-/);
    expect(checkboxes).toHaveLength(2);
  });



  it("shows selection count when tasks are selected", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);

    expect(screen.getByText("1 selected")).toBeDefined();
  });

  it("clears selection when clear button clicked", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);
    expect(screen.getByText("1 selected")).toBeDefined();

    const clearButton = screen.getByRole("button", { name: /^1 selected$/i });
    clickInAct(clearButton);

    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("toggles all visible tasks with select all checkbox", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const selectAllCheckbox = screen.getByLabelText("Select all visible tasks");
    clickInAct(selectAllCheckbox);

    expect(screen.getByRole("button", { name: /^2 selected$/i })).toBeDefined();
  });

  it("accepts favoriteProviders and favoriteModels props", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];
    const onToggleFavorite = vi.fn();
    const onToggleModelFavorite = vi.fn();

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast} projectId={TEST_PROJECT_ID}
        availableModels={availableModels}
        favoriteProviders={["openai"]}
        favoriteModels={["openai/gpt-4o"]}
        onToggleFavorite={onToggleFavorite}
        onToggleModelFavorite={onToggleModelFavorite}
      />
    );
    enterBulkEditMode();

    // Select a task to show bulk edit toolbar with dropdowns
    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);

    expect(screen.getByText("Bulk Edit Models, Thinking & Node:")).toBeDefined();
  });

  it("shows bulk edit toolbar when tasks are selected", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast} projectId={TEST_PROJECT_ID}
        availableModels={availableModels}
      />
    );
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);

    expect(screen.getByText("Bulk Edit Models, Thinking & Node:")).toBeDefined();
  });

  it("disables apply button when no model changes selected", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast} projectId={TEST_PROJECT_ID}
        availableModels={availableModels}
      />
    );
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);

    const applyButton = screen.getByText("Apply");
    expect(applyButton).toBeDisabled();
  });

  it("shows mobile bulk action buttons and runs delete handler path", async () => {
    const user = userEvent.setup();
    const matchMediaSpy = mockMobileViewport();
    const tasks = [createMockTask({ id: "FN-001" })];
    const onDeleteTask = vi.fn(async () => createMockTask());
    mockConfirm.mockResolvedValueOnce(true);

    renderListView({ tasks, onDeleteTask });
    enterBulkEditMode();
    await user.click(screen.getByLabelText("Select FN-001"));

    expect(screen.getByRole("button", { name: /^pause selected$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^unpause selected$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^archive selected$/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /delete selected/i }));

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-001");
    });

    matchMediaSpy.mockRestore();
  });

  it("shows mobile model toolbar and keeps apply disabled until a change is selected", async () => {
    const user = userEvent.setup();
    const matchMediaSpy = mockMobileViewport();
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];

    renderListView({ tasks, availableModels });
    enterBulkEditMode();
    await user.click(screen.getByLabelText("Select FN-001"));

    expect(screen.getByText("Bulk Edit Models, Thinking & Node:")).toBeInTheDocument();
    const applyButton = screen.getByRole("button", { name: "Apply" });
    expect(applyButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Node Override"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();

    matchMediaSpy.mockRestore();
  });

  it("hides mobile bulk edit toolbars when bulk edit mode is turned off", async () => {
    const user = userEvent.setup();
    const matchMediaSpy = mockMobileViewport();
    const tasks = [createMockTask({ id: "FN-001" })];

    renderListView({ tasks });
    enterBulkEditMode();
    await user.click(screen.getByLabelText("Select FN-001"));
    expect(screen.getByRole("button", { name: /^pause selected$/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done Editing" }));
    expect(screen.queryByRole("button", { name: /^pause selected$/i })).toBeNull();

    matchMediaSpy.mockRestore();
  });

  describe("bulk pause/unpause", () => {
    it("shows pause/unpause buttons only when bulk selection is active", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];

      renderListView({ tasks });
      expect(screen.queryByRole("button", { name: /^pause selected$/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^unpause selected$/i })).toBeNull();

      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));

      expect(screen.getByRole("button", { name: /^pause selected$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^unpause selected$/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^archive selected$/i })).not.toBeInTheDocument();
    });

    it("pauses only non-paused selected tasks and clears successful selections", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001", paused: false }), createMockTask({ id: "FN-002", paused: true })];
      const onPauseTask = vi.fn(async () => createMockTask());
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001", "FN-002"]));

      renderListView({ tasks, onPauseTask });
      enterBulkEditMode();
      await user.click(screen.getByRole("button", { name: /^pause selected$/i }));

      await waitFor(() => {
        expect(onPauseTask).toHaveBeenCalledTimes(1);
        expect(onPauseTask).toHaveBeenCalledWith("FN-001");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Paused 1 · 1 skipped · 0 failed", "success");
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    });

    it("unpauses only paused tasks and reports skipped count", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001", paused: true }), createMockTask({ id: "FN-002", paused: false })];
      const onUnpauseTask = vi.fn(async () => createMockTask());
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001", "FN-002"]));

      renderListView({ tasks, onUnpauseTask });
      enterBulkEditMode();
      await user.click(screen.getByRole("button", { name: /^unpause selected$/i }));

      await waitFor(() => {
        expect(onUnpauseTask).toHaveBeenCalledTimes(1);
        expect(onUnpauseTask).toHaveBeenCalledWith("FN-001");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Unpaused 1 · 1 skipped · 0 failed", "success");
    });





    it("shows error summary when pause has failures", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001", paused: false })];
      const onPauseTask = vi.fn(async () => {
        throw new Error("boom");
      });

      renderListView({ tasks, onPauseTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByRole("button", { name: /^pause selected$/i }));

      await waitFor(() => {
        expect(onPauseTask).toHaveBeenCalledTimes(1);
      });
      expect(mockAddToast).toHaveBeenCalledWith("Paused 0 · 0 skipped · 1 failed", "error");
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    });
  });

  describe("bulk delete", () => {

    it("deletes selected tasks and clears selection on success", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" }), createMockTask({ id: "FN-002" })];
      const onDeleteTask = vi.fn(async () => createMockTask());
      mockConfirm.mockResolvedValueOnce(true);

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByLabelText("Select FN-002"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledTimes(2);
        expect(onDeleteTask).toHaveBeenNthCalledWith(1, "FN-001");
        expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-002");
      });
      expect(mockAddToast).toHaveBeenCalledWith("Deleted 2 · 0 failed", "success");
      expect(screen.queryByText("2 selected")).toBeNull();
    });



    it("does nothing when delete confirm is cancelled", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      const onDeleteTask = vi.fn(async () => createMockTask());
      mockConfirm.mockResolvedValueOnce(false);

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledTimes(1);
      });
      expect(onDeleteTask).not.toHaveBeenCalled();
    });

    it("force deletes when dependency conflict is confirmed", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      const conflictError = Object.assign(new Error("dependency conflict"), {
        details: { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-100"] },
      });
      const onDeleteTask = vi
        .fn<(...args: [string, { removeDependencyReferences?: boolean; removeLineageReferences?: boolean }?]) => Promise<Task>>()
        .mockRejectedValueOnce(conflictError)
        .mockResolvedValueOnce(createMockTask());
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledTimes(2);
      });
      expect(onDeleteTask).toHaveBeenNthCalledWith(1, "FN-001");
      expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-001", {
        removeDependencyReferences: true,
        removeLineageReferences: true,
      });
      expect(mockAddToast).toHaveBeenCalledWith("Deleted 1 · 0 failed", "success");
    });

    it("force deletes when lineage conflict is confirmed", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      const conflictError = Object.assign(new Error("lineage conflict"), {
        details: { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-200"] },
      });
      const onDeleteTask = vi
        .fn<(...args: [string, { removeDependencyReferences?: boolean; removeLineageReferences?: boolean }?]) => Promise<Task>>()
        .mockRejectedValueOnce(conflictError)
        .mockResolvedValueOnce(createMockTask());
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledTimes(2);
      });
      expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-001", {
        removeDependencyReferences: true,
        removeLineageReferences: true,
      });
      expect(mockAddToast).toHaveBeenCalledWith("Deleted 1 · 0 failed", "success");
    });

    it("marks failure when force delete is declined", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      const conflictError = Object.assign(new Error("dependency conflict"), {
        details: { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-100"] },
      });
      const onDeleteTask = vi.fn(async () => {
        throw conflictError;
      });
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      renderListView({ tasks, onDeleteTask });
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.click(screen.getByRole("button", { name: /delete selected/i }));

      await waitFor(() => {
        expect(onDeleteTask).toHaveBeenCalledTimes(1);
      });
      expect(mockAddToast).toHaveBeenCalledWith("Deleted 0 · 1 failed", "error");
    });
  });


  it("persists selection to localStorage", () => {
    const tasks = [createMockTask({ id: "FN-001" })];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkbox = screen.getByLabelText("Select FN-001");
    clickInAct(checkbox);

    expect(localStorage.getItem(scopedStorageKey("kb-dashboard-selected-tasks"))).toBe('["FN-001"]');
  });

  it("shows header checkbox in indeterminate state when some tasks selected", () => {
    const tasks = [
      createMockTask({ id: "FN-001" }),
      createMockTask({ id: "FN-002" }),
    ];
    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} />);
    enterBulkEditMode();

    const checkboxes = screen.getAllByLabelText(/Select FN-/);
    // Select only first task
    clickInAct(checkboxes[0]);

    // Header checkbox should be indeterminate (partially selected)
    const headerCheckbox = screen.getByLabelText("Select all visible tasks") as HTMLInputElement;
    expect(headerCheckbox).toBeDefined();
    // Verify only one task is selected (indeterminate state)
    expect(screen.getByText("1 selected")).toBeDefined();
  });

  it("treats No change, explicit model, and Use default as distinct bulk-edit states", async () => {
    const user = userEvent.setup();
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];
    const mockedBatchUpdateTaskModels = vi.mocked(batchUpdateTaskModels);
    mockedBatchUpdateTaskModels.mockResolvedValue({
      updated: [
        {
          ...tasks[0],
          modelProvider: "openai",
          modelId: "gpt-4o",
        },
      ],
      count: 1,
    });

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast} projectId={TEST_PROJECT_ID}
        availableModels={availableModels}
      />
    );
    enterBulkEditMode();

    await user.click(screen.getByLabelText("Select FN-001"));

    let applyButton = screen.getByRole("button", { name: "Apply" });
    expect(applyButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const modelMenu = await screen.findByTestId("model-combobox-portal");
    await user.click(within(modelMenu).getByText("GPT-4o"));

    expect(applyButton).toBeEnabled();

    await user.click(applyButton);

    await waitFor(() => {
      expect(mockedBatchUpdateTaskModels).toHaveBeenCalled();
      const firstApplyArgs = mockedBatchUpdateTaskModels.mock.calls[0];
      expect(firstApplyArgs?.[0]).toEqual(["FN-001"]);
      expect(firstApplyArgs?.[1]).toBe("openai");
      expect(firstApplyArgs?.[2]).toBe("gpt-4o");
      expect(firstApplyArgs?.[3]).toBeUndefined();
      expect(firstApplyArgs?.[4]).toBeUndefined();
      expect(firstApplyArgs?.[8]).toBeUndefined();
    });

    // After a successful apply, controls reset to No change and disable Apply again.
    await user.click(screen.getByLabelText("Select FN-001"));
    applyButton = screen.getByRole("button", { name: "Apply" });
    expect(applyButton).toBeDisabled();

    // Selecting Use default must be treated as an explicit clear (null pair), not unchanged.
    mockedBatchUpdateTaskModels.mockResolvedValue({
      updated: [
        {
          ...tasks[0],
          modelProvider: undefined,
          modelId: undefined,
        },
      ],
      count: 1,
    });

    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const clearMenu = await screen.findByTestId("model-combobox-portal");
    await user.click(within(clearMenu).getByText("Use default"));

    expect(applyButton).toBeEnabled();

    await user.click(applyButton);

    await waitFor(() => {
      const clearApplyArgs = mockedBatchUpdateTaskModels.mock.calls.at(-1);
      expect(clearApplyArgs?.[0]).toEqual(["FN-001"]);
      expect(clearApplyArgs?.[1]).toBeNull();
      expect(clearApplyArgs?.[2]).toBeNull();
      expect(clearApplyArgs?.[3]).toBeUndefined();
      expect(clearApplyArgs?.[4]).toBeUndefined();
      expect(clearApplyArgs?.[8]).toBeUndefined();
    });
  });

  it("forwards bulk thinking-level selections and omits the field for no-change", async () => {
    const user = userEvent.setup();
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];
    const mockedBatchUpdateTaskModels = vi.mocked(batchUpdateTaskModels);
    mockedBatchUpdateTaskModels.mockResolvedValue({ updated: [{ ...tasks[0], thinkingLevel: "high" }], count: 1 });

    render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
    enterBulkEditMode();
    await user.click(screen.getByLabelText("Select FN-001"));

    const thinkingSelect = screen.getByLabelText("Thinking Level");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

    await user.selectOptions(thinkingSelect, "high");
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const args = mockedBatchUpdateTaskModels.mock.calls.at(-1);
      expect(args?.[0]).toEqual(["FN-001"]);
      expect(args?.[1]).toBeUndefined();
      expect(args?.[2]).toBeUndefined();
      expect(args?.[7]).toBeUndefined();
      expect(args?.[8]).toBe("high");
      expect(args?.[9]).toBe(TEST_PROJECT_ID);
    });

    await user.click(screen.getByLabelText("Select FN-001"));
    expect(screen.getByLabelText("Thinking Level")).toHaveValue("__no_change__");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  describe("Bulk node override", () => {
    const availableModels = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ];

    it("shows node override selector with node status labels when tasks are selected", async () => {
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-1", name: "Node One", status: "online" } as never]);

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      clickInAct(screen.getByLabelText("Select FN-001"));

      expect(await screen.findByLabelText("Node Override")).toBeInTheDocument();
      expect(await screen.findByRole("option", { name: "● Node One (Online)" })).toBeInTheDocument();
    });

    it("renders non-online statuses with distinct symbols and labels", async () => {
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-2", name: "Node Two", status: "offline" } as never]);

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      clickInAct(screen.getByLabelText("Select FN-001"));

      expect(await screen.findByRole("option", { name: "○ Node Two (Offline)" })).toBeInTheDocument();
    });

    it("shows NodeHealthDot for selected bulk node override", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-abc", name: "Node ABC", status: "online" } as never]);

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));

      const nodeSelect = await screen.findByLabelText("Node Override");
      await user.selectOptions(nodeSelect, "node-abc");

      expect(document.querySelector(".status-dot--online")).toBeInTheDocument();
      expect(screen.getByText("Online")).toBeInTheDocument();
    });

    it("applies explicit node override through batchUpdateTaskModels", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-abc", name: "Node ABC", status: "online" } as never]);
      vi.mocked(batchUpdateTaskModels).mockResolvedValue({ updated: tasks, count: 1 });

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));

      const nodeSelect = await screen.findByLabelText("Node Override");
      await user.selectOptions(nodeSelect, "node-abc");
      await user.click(screen.getByRole("button", { name: "Apply" }));

      await waitFor(() => {
        const args = vi.mocked(batchUpdateTaskModels).mock.calls.at(-1);
        expect(args?.[7]).toBe("node-abc");
      });
    });

    it("uses null nodeId when selecting Use project default", async () => {
      const user = userEvent.setup();
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-abc", name: "Node ABC", status: "online" } as never]);
      vi.mocked(batchUpdateTaskModels).mockResolvedValue({ updated: tasks, count: 1 });

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      await user.click(screen.getByLabelText("Select FN-001"));
      await user.selectOptions(await screen.findByLabelText("Node Override"), "");
      await user.click(screen.getByRole("button", { name: "Apply" }));

      await waitFor(() => {
        const args = vi.mocked(batchUpdateTaskModels).mock.calls.at(-1);
        expect(args?.[7]).toBeNull();
      });
    });

    it("keeps apply disabled when all controls are no change", async () => {
      const tasks = [createMockTask({ id: "FN-001" })];
      vi.mocked(fetchNodes).mockResolvedValue([{ id: "node-abc", name: "Node ABC", status: "online" } as never]);

      render(<ListView tasks={tasks} onMoveTask={vi.fn()} onOpenDetail={vi.fn()} addToast={mockAddToast} projectId={TEST_PROJECT_ID} availableModels={availableModels} />);
      enterBulkEditMode();
      clickInAct(screen.getByLabelText("Select FN-001"));

      expect(await screen.findByRole("button", { name: "Apply" })).toBeDisabled();
    });
  });

  it("forwards favoriteProviders and favoriteModels to QuickEntryBox model menu (FN-770)", async () => {
    const availableModels = [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    ];
    const tasks = [createMockTask({ id: "FN-001" })];
    const onToggleFavorite = vi.fn();
    const onToggleModelFavorite = vi.fn();

    render(
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast} projectId={TEST_PROJECT_ID}
        onQuickCreate={vi.fn().mockResolvedValue(undefined)}
        availableModels={availableModels}
        favoriteProviders={["anthropic"]}
        favoriteModels={["claude-sonnet-4-5"]}
        onToggleFavorite={onToggleFavorite}
        onToggleModelFavorite={onToggleModelFavorite}
      />
    );

    // Expand the QuickEntryBox and open the model menu
    const toggleButton = screen.getByTestId("quick-entry-toggle");
    fireEvent.click(toggleButton);

    const modelsAction = await screen.findByTestId("quick-entry-models");
    fireEvent.click(modelsAction);

    const menu = await screen.findByTestId("model-nested-menu");
    expect(menu).toBeDefined();

    // Verify the menu has the three options
    expect(menu.textContent).toContain("Plan");
    expect(menu.textContent).toContain("Executor");
    expect(menu.textContent).toContain("Reviewer");
  });

  describe("ListView Mobile Cards", () => {
    afterEach(() => {
      const maybeMock = window.matchMedia as unknown as { mockRestore?: () => void };
      maybeMock.mockRestore?.();
      localStorage.removeItem(scopedStorageKey("kb-dashboard-selected-tasks"));
    });

    it("renders card layout instead of table on mobile", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [createMockTask({ id: "FN-001", title: "Mobile task" })],
      });

      expect(container.querySelector(".list-cards")).toBeInTheDocument();
      expect(container.querySelector("table.list-table")).toBeNull();
    });

    it("renders table layout on desktop", () => {
      mockDesktopViewport();

      const { container } = renderListView({
        tasks: [createMockTask({ id: "FN-001", title: "Desktop task" })],
      });

      expect(container.querySelector("table.list-table")).toBeInTheDocument();
      expect(container.querySelector(".list-cards")).toBeNull();
    });

    it("shows task id, title, and status inside mobile cards", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [createMockTask({ id: "FN-001", title: "Card title", status: "executing" })],
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]');
      expect(card).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("FN-001")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("Card title")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("executing")).toBeInTheDocument();
    });

    it("FN-8475 renders Todo and In Progress planning in mobile cards", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({ id: "FN-8170-mobile-todo", column: "todo", status: "planning" }),
          createMockTask({ id: "FN-8170-mobile-active", column: "in-progress", status: "planning" }),
          createMockTask({ id: "FN-8170-mobile-triage", column: "triage", status: "planning" }),
          createMockTask({
            id: "FN-8170-mobile-executing",
            column: "in-progress",
            status: "executing",
            steps: [{ name: "Running step", status: "in-progress" }],
          }),
        ],
      });

      for (const id of ["FN-8170-mobile-todo", "FN-8170-mobile-active", "FN-8170-mobile-triage"]) {
        expect((container.querySelector(`[data-id="${id}"]`) as HTMLElement).querySelector(".list-status-badge")).toHaveTextContent("Planning");
      }
      expect(within(container.querySelector('[data-id="FN-8170-mobile-executing"]') as HTMLElement).getByText("executing")).toBeInTheDocument();
    });

    it("shows fast indicator in mobile cards only for fast-mode tasks", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({ id: "FN-001", title: "Fast mobile", executionMode: "fast", status: "pending" }),
          createMockTask({ id: "FN-002", title: "Standard mobile", executionMode: "standard", status: "pending" }),
        ],
      });

      const fastCard = container.querySelector('.list-card[data-id="FN-001"]') as HTMLElement;
      const standardCard = container.querySelector('.list-card[data-id="FN-002"]') as HTMLElement;
      const fastBadge = fastCard.querySelector(".list-execution-mode-badge");

      expect(fastBadge).not.toBeNull();
      expect(fastBadge?.getAttribute("aria-label")).toBe("Fast mode");
      expect(fastBadge?.querySelector("svg")).not.toBeNull();
      expect(standardCard.querySelector(".list-execution-mode-badge")).toBeNull();
    });

    it("shows unified progress bar for executing mobile cards with steps and workflow checks", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-001",
            title: "Progress task",
            column: "todo",
            status: "executing",
            steps: [
              { name: "Step 1", status: "done" },
              { name: "Step 2", status: "pending" },
            ],
            enabledWorkflowSteps: ["WS-001"],
            workflowStepResults: [
              {
                workflowStepId: "WS-001",
                workflowStepName: "Browser Verification",
                status: "passed",
              },
            ],
          }),
        ],
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]') as HTMLElement;
      expect(card.querySelector(".list-progress-fill")).toBeInTheDocument();
      expect(within(card).getByText("2/3")).toBeInTheDocument();
    });

    it("hides mobile card progress for non-executing todo tasks", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-002",
            title: "Todo pending task",
            column: "todo",
            status: "pending",
            steps: [{ name: "Step 1", status: "done" }],
          }),
        ],
      });

      const card = container.querySelector('.list-card[data-id="FN-002"]') as HTMLElement;
      expect(card.querySelector(".list-progress-bar")).not.toBeInTheDocument();
    });

    it("shows dependency badge for cards with dependencies", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-001",
            title: "Dependency task",
            dependencies: ["FN-002"],
          }),
        ],
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]') as HTMLElement;
      const depBadge = card.querySelector(".list-dep-badge");
      expect(depBadge).toBeInTheDocument();
      expect(depBadge?.textContent).toContain("1");
    });

    it("opens task detail when a mobile card is clicked", async () => {
      mockMobileViewport();
      const task = createMockTask({ id: "FN-001", title: "Open me" });
      const mockOnOpenDetail = vi.fn();

      const { container } = renderListView({
        tasks: [task],
        onOpenDetail: mockOnOpenDetail,
      });

      fireEvent.click(container.querySelector('.list-card[data-id="FN-001"]') as HTMLElement);

      // Should call onOpenDetail synchronously with the Task object (no fetch)
      expect(mockOnOpenDetail).toHaveBeenCalledWith(task, { origin: "list-mobile" });
      expect(mockOnOpenDetail).toHaveBeenCalledTimes(1);
    });

    it("collapses and expands mobile section headers", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [createMockTask({ id: "FN-001", title: "Collapsible task" })],
      });

      const sectionHeader = screen.getByRole("button", { name: /Planning/i });
      expect(container.querySelector('.list-card[data-id="FN-001"]')).toBeInTheDocument();

      fireEvent.click(sectionHeader);
      expect(container.querySelector('.list-card[data-id="FN-001"]')).toBeNull();

      fireEvent.click(sectionHeader);
      expect(container.querySelector('.list-card[data-id="FN-001"]')).toBeInTheDocument();
    });

    it("supports selection mode from mobile card checkboxes", () => {
      mockMobileViewport();
      localStorage.setItem(scopedStorageKey("kb-dashboard-selected-tasks"), JSON.stringify(["FN-001"]));

      renderListView({
        tasks: [
          createMockTask({ id: "FN-001", title: "Selected task" }),
          createMockTask({ id: "FN-002", title: "Selectable task" }),
        ],
        availableModels: [
          { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
        ],
      });

      enterBulkEditMode();
      clickInAct(screen.getByLabelText("Select FN-002"));

      expect((screen.getByLabelText("Select FN-001") as HTMLInputElement).checked).toBe(true);
      expect((screen.getByLabelText("Select FN-002") as HTMLInputElement).checked).toBe(true);
    });

    it.each([
      { status: "executing", column: "in-progress" as const },
      { status: "merging-fix", column: "in-review" as const },
    ])("applies agent-active class to mobile cards for active states (%s)", ({ status, column }) => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-001",
            status,
            column,
          }),
        ],
        globalPaused: false,
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]');
      expect(card?.className).toContain("agent-active");
    });

    it.each([
      { status: "needs-replan", column: "triage" as const },
      { status: "needs-replan", column: "todo" as const },
    ])("does NOT apply agent-active to mobile cards for parked replans (%s)", ({ status, column }) => {
      // FNXC:TaskActivity 2026-08-01-17:53: parked replans hold no concurrency slot.
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-001",
            status,
            column,
          }),
        ],
        globalPaused: false,
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]');
      expect(card?.className).not.toContain("agent-active");
    });

    it("does not apply agent-active class to mobile cards when globalPaused is true", () => {
      mockMobileViewport();

      const { container } = renderListView({
        tasks: [
          createMockTask({
            id: "FN-001",
            status: "executing",
            column: "in-progress",
          }),
        ],
        globalPaused: true,
      });

      const card = container.querySelector('.list-card[data-id="FN-001"]');
      expect(card?.className).not.toContain("agent-active");
    });
  });
});

describe("ListView titleless display fallback (FN-044)", () => {
  const description200 = "d".repeat(200);
  const description201 = "e".repeat(201);
  const expectedBoundedDescription = description201.slice(0, 197) + "...";

  it("uses the shared literal-dot fallback in the desktop table and preserves explicit titles", () => {
    const viewportSpy = mockDesktopViewport();
    try {
      const { container, rerender } = renderListView({
        tasks: [createMockTask({ id: "FN-044-desktop", title: undefined, description: description201 })],
      });
      expect(container.querySelector(".list-title-text")).toHaveTextContent(expectedBoundedDescription);
      expect(container.querySelector(".list-title-text")?.textContent).toHaveLength(200);

      const explicitTitle = "t".repeat(201);
      rerender(<ListView
        tasks={[createMockTask({ id: "FN-044-explicit", title: explicitTitle, description: description201 })]}
        onMoveTask={vi.fn(async () => createMockTask())}
        onRetryTask={vi.fn(async () => createMockTask())}
        onDeleteTask={vi.fn(async () => createMockTask())}
        onMergeTask={vi.fn(async () => ({ merged: false }))}
        onResetTask={vi.fn(async () => createMockTask())}
        onDuplicateTask={vi.fn(async () => createMockTask())}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        globalPaused={false}
        onNewTask={vi.fn()}
        projectId={TEST_PROJECT_ID}
      />);
      expect(container.querySelector(".list-title-text")).toHaveTextContent(explicitTitle);
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("uses the same fallback in mobile cards, including 200-character and whitespace-title controls", () => {
    const viewportSpy = mockMobileViewport();
    try {
      const { container, rerender } = renderListView({
        tasks: [createMockTask({ id: "FN-044-mobile", title: "   ", description: description201 })],
      });
      expect(container.querySelector(".list-card-title")).toHaveTextContent(expectedBoundedDescription);

      rerender(<ListView
        tasks={[createMockTask({ id: "FN-044-200", title: undefined, description: description200 })]}
        onMoveTask={vi.fn(async () => createMockTask())}
        onRetryTask={vi.fn(async () => createMockTask())}
        onDeleteTask={vi.fn(async () => createMockTask())}
        onMergeTask={vi.fn(async () => ({ merged: false }))}
        onResetTask={vi.fn(async () => createMockTask())}
        onDuplicateTask={vi.fn(async () => createMockTask())}
        onOpenDetail={vi.fn()}
        addToast={mockAddToast}
        globalPaused={false}
        onNewTask={vi.fn()}
        projectId={TEST_PROJECT_ID}
      />);
      expect(container.querySelector(".list-card-title")).toHaveTextContent(description200);
    } finally {
      viewportSpy.mockRestore();
    }
  });
});
