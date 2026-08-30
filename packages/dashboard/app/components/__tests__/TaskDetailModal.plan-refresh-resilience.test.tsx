import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import * as dashboardApi from "../../api";
import {TaskDetailContent, TaskDetailModal} from "../TaskDetailModal";
import type {Task, TaskDetail} from "@fusion/core";

setupTaskDetailModalHooks();

const completePlan = `# Task: FN-237 - Stable plan

## Original Description

Keep the task plan visible.

## What This Delivers

The Definition summary stays visible.

## Before → After Transformation

- **Before:** the plan disappears
- **After:** the plan remains

## Mission

Implement the durable fix.
`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

const contentHandlers = {
  onRequestClose: noop,
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

function expectCompletePlanVisible(): void {
  const summary = screen.getByTestId("task-detail-plan-summary");
  expect(summary).toHaveTextContent("The Definition summary stays visible.");
  expect(summary).toHaveTextContent("the plan disappears");
  expect(summary).toHaveTextContent("the plan remains");
  expect(screen.getByTestId("task-detail-plan-details-toggle")).toBeInTheDocument();
  expect(screen.queryByText("(no prompt)")).not.toBeInTheDocument();
}

function makeSlimTask(id: string): Task {
  const task = makeTask({id, prompt: completePlan}) as Task & {prompt?: string};
  delete task.prompt;
  return task;
}

function renderContent(task: Task, options: {active?: boolean; embedded?: boolean} = {}) {
  return render(
    <TaskDetailContent
      task={task}
      initialTab="definition"
      active={options.active}
      embedded={options.embedded}
      {...contentHandlers}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskDetail Definition plan refresh resilience", () => {
  it("retains the summary and disclosure in the modal after an empty narrow refresh", async () => {
    const id = "FN-237-empty";
    vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValueOnce({id, prompt: ""});
    vi.mocked(dashboardApi.fetchTaskDetail).mockReturnValueOnce(new Promise<TaskDetail>(() => {}));

    render(
      <TaskDetailModal
        task={makeTask({id, prompt: completePlan})}
        initialTab="definition"
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await waitFor(() => expect(dashboardApi.fetchTaskPrompt).toHaveBeenCalledWith(id, undefined));
    expectCompletePlanVisible();
  });

  it.each([
    ["an absent prompt", undefined],
    ["a whitespace-only prompt", "  \n\t"],
  ])("retains the plan for %s", async (_label, prompt) => {
    const id = `FN-237-${prompt === undefined ? "absent" : "whitespace"}`;
    vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValueOnce({id, prompt});
    vi.mocked(dashboardApi.fetchTaskDetail).mockReturnValueOnce(new Promise<TaskDetail>(() => {}));

    renderContent(makeTask({id, prompt: completePlan}));

    await waitFor(() => expect(dashboardApi.fetchTaskPrompt).toHaveBeenCalledWith(id, undefined));
    expectCompletePlanVisible();
  });

  it("adopts a legitimately shorter non-blank rewrite", async () => {
    const id = "FN-237-shorter";
    vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValueOnce({id, prompt: "# Short rewritten plan"});

    renderContent(makeTask({id, prompt: completePlan}));

    expect(await screen.findByText("Short rewritten plan")).toBeInTheDocument();
    expect(screen.queryByText("The Definition summary stays visible.")).not.toBeInTheDocument();
  });

  it("issues one authoritative re-read while repeated degraded ticks are coalesced", async () => {
    vi.useFakeTimers();
    const id = "FN-237-reverify";
    const reverify = deferred<TaskDetail>();
    vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValue({id, prompt: ""});
    vi.mocked(dashboardApi.fetchTaskDetail).mockReturnValue(reverify.promise);

    renderContent(makeTask({id, status: "planning", prompt: completePlan}));
    await act(async () => {});
    expect(dashboardApi.fetchTaskDetail).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(dashboardApi.fetchTaskDetail).toHaveBeenCalledTimes(1);
    expectCompletePlanVisible();

    await act(async () => { reverify.resolve(makeTask({id, prompt: completePlan})); });
    expectCompletePlanVisible();
  });

  it.each([
    ["an equal task clock", "2026-01-01T00:00:00Z"],
    ["a strictly older task clock", "2025-12-31T23:59:59Z"],
  ])("lets the authoritative re-read clear a retained narrow plan with %s", async (_label, reverifyClock) => {
    const id = `FN-237-clear-${reverifyClock.slice(0, 4)}`;
    vi.mocked(dashboardApi.fetchTaskPrompt)
      .mockResolvedValueOnce({id, prompt: completePlan})
      .mockResolvedValueOnce({id, prompt: ""});
    vi.mocked(dashboardApi.fetchTaskDetail).mockResolvedValueOnce(makeTask({
      id,
      prompt: "",
      updatedAt: reverifyClock,
    }));
    const task = makeTask({id, status: "planning", prompt: completePlan, updatedAt: "2026-01-01T00:00:00Z"});

    const {rerender} = renderContent(task);
    await waitFor(() => expect(dashboardApi.fetchTaskPrompt).toHaveBeenCalledTimes(1));
    expectCompletePlanVisible();

    rerender(<TaskDetailContent task={task} initialTab="definition" active={false} {...contentHandlers} />);
    rerender(<TaskDetailContent task={task} initialTab="definition" active {...contentHandlers} />);
    await waitFor(() => expect(screen.getByText("(no prompt)")).toBeInTheDocument());
    expect(screen.queryByTestId("task-detail-plan-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-detail-plan-details-toggle")).not.toBeInTheDocument();
  });

  it("keeps a loaded embedded plan through hide, reveal, and a failed refetch", async () => {
    const id = "FN-237-reveal";
    vi.mocked(dashboardApi.fetchTaskDetail)
      .mockResolvedValueOnce(makeTask({id, prompt: completePlan}))
      .mockRejectedValueOnce(new Error("transient detail failure"));
    vi.mocked(dashboardApi.fetchTaskPrompt).mockImplementation(() => new Promise(() => {}));
    const task = makeSlimTask(id);

    const {rerender} = renderContent(task, {active: false, embedded: true});
    rerender(<TaskDetailContent task={task} initialTab="definition" active embedded {...contentHandlers} />);
    await waitFor(expectCompletePlanVisible);

    rerender(<TaskDetailContent task={task} initialTab="definition" active={false} embedded {...contentHandlers} />);
    rerender(<TaskDetailContent task={task} initialTab="definition" active embedded {...contentHandlers} />);
    await waitFor(() => expect(dashboardApi.fetchTaskDetail).toHaveBeenCalledTimes(2));

    expectCompletePlanVisible();
    expect(screen.queryByTestId("loading-spinner")).not.toBeInTheDocument();
  });

  it("clears the preceding plan when an embedded host switches task identity", async () => {
    const first = makeTask({id: "FN-237-first", prompt: completePlan});
    const second = makeSlimTask("FN-237-second");
    vi.mocked(dashboardApi.fetchTaskPrompt).mockImplementation(() => new Promise(() => {}));
    vi.mocked(dashboardApi.fetchTaskDetail).mockImplementation(() => new Promise(() => {}));

    const {rerender} = renderContent(first, {embedded: true});
    expectCompletePlanVisible();
    rerender(<TaskDetailContent task={second} initialTab="definition" embedded {...contentHandlers} />);

    await waitFor(() => expect(screen.queryByText("The Definition summary stays visible.")).not.toBeInTheDocument());
  });

  it("keeps the empty rendering for a task that never had a plan", async () => {
    const id = "FN-237-no-plan";
    vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValueOnce({id});

    renderContent(makeTask({id, prompt: ""}));

    expect(await screen.findByText("(no prompt)")).toBeInTheDocument();
    expect(screen.queryByTestId("task-detail-plan-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-detail-plan-details-toggle")).not.toBeInTheDocument();
    expect(dashboardApi.fetchTaskDetail).not.toHaveBeenCalled();
  });

  it.each([375, 1024])("retains the plan after a degraded refresh at %ipx", async (width) => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {configurable: true, value: width});
    window.dispatchEvent(new Event("resize"));
    const id = `FN-237-viewport-${width}`;
    vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValueOnce({id, prompt: ""});
    vi.mocked(dashboardApi.fetchTaskDetail).mockImplementation(() => new Promise(() => {}));

    try {
      renderContent(makeTask({id, prompt: completePlan}));
      await waitFor(() => expect(dashboardApi.fetchTaskPrompt).toHaveBeenCalled());
      expectCompletePlanVisible();
    } finally {
      Object.defineProperty(window, "innerWidth", {configurable: true, value: originalWidth});
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("keeps the summary throughout a degraded planning tick followed by a good tick", async () => {
    vi.useFakeTimers();
    const id = "FN-237-poll-recovery";
    vi.mocked(dashboardApi.fetchTaskPrompt)
      .mockResolvedValueOnce({id, prompt: ""})
      .mockResolvedValueOnce({id, prompt: completePlan});
    vi.mocked(dashboardApi.fetchTaskDetail).mockImplementation(() => new Promise(() => {}));

    renderContent(makeTask({id, status: "planning", prompt: completePlan}));
    await act(async () => {});
    expectCompletePlanVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expectCompletePlanVisible();
    expect(screen.queryByText("(no prompt)")).not.toBeInTheDocument();
  });

  it("overlays only narrow prompt evidence observed after a detail request was issued", async () => {
    const id = "FN-237-sequence";
    const firstDetail = deferred<TaskDetail>();
    const secondDetail = deferred<TaskDetail>();
    const secondNarrow = deferred<{id: string; prompt?: string}>();
    vi.mocked(dashboardApi.fetchTaskDetail)
      .mockReturnValueOnce(firstDetail.promise)
      .mockReturnValueOnce(secondDetail.promise);
    vi.mocked(dashboardApi.fetchTaskPrompt)
      .mockResolvedValueOnce({id, prompt: completePlan})
      .mockReturnValueOnce(secondNarrow.promise);
    const task = makeSlimTask(id);

    const {rerender} = renderContent(task, {embedded: true});
    await waitFor(() => expect(dashboardApi.fetchTaskPrompt).toHaveBeenCalledTimes(1));
    await act(async () => { firstDetail.resolve(makeTask({id, prompt: "# Older detail"})); });
    await waitFor(expectCompletePlanVisible);

    rerender(<TaskDetailContent task={task} initialTab="definition" active={false} embedded {...contentHandlers} />);
    rerender(<TaskDetailContent task={task} initialTab="definition" active embedded {...contentHandlers} />);
    await waitFor(() => expect(dashboardApi.fetchTaskDetail).toHaveBeenCalledTimes(2));
    await act(async () => { secondDetail.resolve(makeTask({id, prompt: ""})); });

    expect(await screen.findByText("(no prompt)")).toBeInTheDocument();
    expect(screen.queryByText("The Definition summary stays visible.")).not.toBeInTheDocument();
  });

  it("does not re-stamp a predating narrow prompt over a Feed resync detail", async () => {
    const id = "FN-237-feed";
    vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValueOnce({id, prompt: completePlan});
    vi.mocked(dashboardApi.fetchTaskDetail).mockResolvedValueOnce(makeTask({id, prompt: ""}));

    renderContent(makeTask({id, prompt: completePlan}));
    await waitFor(expectCompletePlanVisible);
    fireEvent.click(screen.getByRole("button", {name: "Activity"}));
    fireEvent.click(await screen.findByRole("menuitem", {name: "Feed"}));
    await waitFor(() => expect(dashboardApi.fetchTaskDetail).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", {name: "Plan"}));

    expect(await screen.findByText("(no prompt)")).toBeInTheDocument();
    expect(screen.queryByText("The Definition summary stays visible.")).not.toBeInTheDocument();
  });
});
