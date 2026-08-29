import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Column, Task, TaskDetail } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

const sharedProps = {
  onMoveTask: noopMove,
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

function renderDetail({
  task,
  initialTab,
  embedded = false,
}: {
  task: Task | TaskDetail;
  initialTab?: "definition" | "documents" | "stats" | "workflow" | "logs" | "retries" | "pr" | "summary" | "terminal";
  embedded?: boolean;
}) {
  if (embedded) {
    return render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab={initialTab}
        task={task}
      />,
    );
  }

  return render(
    <TaskDetailModal
      {...sharedProps}
      initialTab={initialTab}
      task={task}
      onClose={noop}
    />,
  );
}

function rerenderDetail(
  rerender: ReturnType<typeof render>["rerender"],
  {
    task,
    initialTab,
    embedded = false,
  }: {
    task: Task | TaskDetail;
    initialTab?: "definition" | "documents" | "stats" | "workflow" | "logs" | "retries" | "pr" | "summary" | "terminal";
    embedded?: boolean;
  },
) {
  if (embedded) {
    rerender(
      <TaskDetailContent
        {...sharedProps}
        embedded
        initialTab={initialTab}
        task={task}
      />,
    );
    return;
  }

  rerender(
    <TaskDetailModal
      {...sharedProps}
      initialTab={initialTab}
      task={task}
      onClose={noop}
    />,
  );
}

function expectActivitySegment(name: "Live" | "Feed" | "Raw") {
  if (!screen.queryByRole("menu", { name: "Activity views" })) {
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
  }
  expect(screen.getByRole("menuitem", { name })).toHaveAttribute("aria-current", "true");
}

/*
FNXC:TaskDetailTabPersistence 2026-07-17-17:46:
FN-8256 / issue #2282 covers the modal and embedded hosts because both share
TaskDetailContent. Live board/SSE column props must not reset user-selected tab
state; only the dedicated invalid-tab guards may redirect the user to Plan.
*/
describe("TaskDetailModal tab persistence", () => {
  it.each([
    {
      label: "the modal host during todo to in-progress",
      initialTab: "definition" as const,
      from: "todo" as Column,
      to: "in-progress" as Column,
      activeTab: "Plan",
      embedded: false,
      slim: false,
    },
    {
      label: "the embedded optimistic host during in-progress to in-review",
      initialTab: "documents" as const,
      from: "in-progress" as Column,
      to: "in-review" as Column,
      activeTab: "Artifacts",
      embedded: true,
      slim: true,
    },
    {
      label: "the modal host during in-review to done",
      initialTab: "stats" as const,
      from: "in-review" as Column,
      to: "done" as Column,
      activeTab: "Stats",
      embedded: false,
      slim: false,
    },
    {
      label: "the embedded host during a board-drag-equivalent live prop update",
      initialTab: "workflow" as const,
      from: "in-progress" as Column,
      to: "todo" as Column,
      activeTab: "Workflow",
      embedded: true,
      slim: false,
    },
  ])("preserves a non-default tab in $label", ({ initialTab, from, to, activeTab, embedded, slim }) => {
    const fullTask = makeTask({ id: `FN-${from}-${to}`, column: from, prompt: "# Full task" });
    const task = slim ? (() => {
      const { prompt: _prompt, ...optimisticTask } = fullTask;
      return optimisticTask as Task;
    })() : fullTask;
    const view = renderDetail({ task, initialTab, embedded });

    expect(screen.getByRole("button", { name: activeTab })).toHaveClass("detail-tab-active");

    rerenderDetail(view.rerender, {
      task: { ...task, column: to },
      initialTab,
      embedded,
    });

    expect(screen.getByRole("button", { name: activeTab })).toHaveClass("detail-tab-active");
  });

  it("preserves a selected non-default Activity segment across a live column update", () => {
    const task = makeTask({ column: "todo", prompt: "# Full task" });
    const view = renderDetail({ task, initialTab: "logs" });

    expectActivitySegment("Feed");
    rerenderDetail(view.rerender, { task: { ...task, column: "in-progress" }, initialTab: "logs" });

    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
    expectActivitySegment("Feed");
  });

  it("does not collapse expanded retries on a column-only update", () => {
    const task = makeTask({
      column: "in-progress",
      prompt: "# Full task",
      retrySummary: { total: 1, recovery: 1 } as TaskDetail["retrySummary"],
    });
    const view = renderDetail({ task, initialTab: "retries" });

    expect(screen.getByRole("button", { name: "Collapse retries details" })).toHaveAttribute("aria-expanded", "true");
    rerenderDetail(view.rerender, { task: { ...task, column: "in-review" }, initialTab: "retries" });

    expect(screen.getByRole("button", { name: "Collapse retries details" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps caller-driven initialTab changes as the only tab reinitialization path", () => {
    const task = makeTask({ column: "todo", prompt: "# Full task", retrySummary: { total: 1, recovery: 1 } as TaskDetail["retrySummary"] });
    const view = renderDetail({ task });

    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");

    rerenderDetail(view.rerender, { task, initialTab: "definition" });
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");

    rerenderDetail(view.rerender, { task, initialTab: "logs" });
    expectActivitySegment("Feed");

    rerenderDetail(view.rerender, { task, initialTab: "retries" });
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");
    expect(screen.getByRole("button", { name: "Collapse retries details" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the PR guard when a task leaves in-review", async () => {
    const task = makeTask({ column: "in-review", prompt: "# Full task" });
    const view = renderDetail({ task, initialTab: "pr" });

    expect(screen.getByRole("button", { name: "Pull Request" })).toHaveClass("detail-tab-active");
    rerenderDetail(view.rerender, { task: { ...task, column: "todo" }, initialTab: "pr" });

    await waitFor(() => expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active"));
  });

  it("keeps the Summary guard when a task leaves done", async () => {
    const task = makeTask({ column: "done", prompt: "# Full task" });
    const view = renderDetail({ task, initialTab: "summary" });

    expect(screen.getByRole("button", { name: "Summary" })).toHaveClass("detail-tab-active");
    rerenderDetail(view.rerender, { task: { ...task, column: "in-review" }, initialTab: "summary" });

    await waitFor(() => expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active"));
  });

  it("keeps the Terminal guard when the mocked CLI session disappears", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      const body = url.toString().includes("FN-TERMINAL")
        ? { sessions: [{ id: "session-8256", taskId: "FN-TERMINAL", agentState: "ready", adapterId: "claude" }] }
        : { sessions: [] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;

    try {
      const task = makeTask({ id: "FN-TERMINAL", column: "in-progress", prompt: "# Full task" });
      const view = renderDetail({ task });

      await waitFor(() => expect(screen.getByRole("button", { name: "Session" })).toBeInTheDocument());
      /*
      FNXC:TaskDetailTabs 2026-07-24-00:00:
      Settle pending CLI-session fetch commits and click a freshly-queried node: clicking
      right after the tab appears raced the cliSession hydration re-render on loaded CI
      shards (full-suite run 30070825088), dispatching on a detached node so the tab never
      activated. Same detached-node class d7752931b fixed for PlanningModeModal Proceed.
      */
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Session" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Session" })).toHaveClass("detail-tab-active"));

      rerenderDetail(view.rerender, { task: makeTask({ id: "FN-NO-SESSION", column: "in-progress", prompt: "# Full task" }) });
      await waitFor(() => expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
