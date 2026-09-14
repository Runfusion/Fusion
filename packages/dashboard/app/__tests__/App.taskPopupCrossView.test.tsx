import { render, screen, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import {
  AppTaskPopoutWindows,
  useAppPoppedOutTaskState,
} from "../components/TaskDetailHostBoundaries";
import { DashboardWindowManagerProvider, DashboardWindowManagerScope } from "../context/DashboardWindowManagerContext";
import { DashboardWindowVisibilityToggle } from "../components/DashboardWindowVisibilityToggle";
import type { TaskView } from "../hooks/useViewState";

vi.mock("../components/TaskDetailModal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/TaskDetailModal")>();
  return {
    ...actual,
    /*
    A thin stand-in for the heavy detail surface: it keeps LOCAL state so the regressions can prove the window is the
    same live instance across views rather than a remounted copy, and it reports the `active` value it was given so the
    global-hide suspension contract stays observable.
    */
    TaskDetailContent: ({ task, active }: { task: Task; active?: boolean }) => {
      const [draft, setDraft] = useState("");
      return (
        <div className="task-detail-content--embedded" data-testid={`detail-${task.id}`} data-active={String(active !== false)}>
          <div className="modal-header">{task.id}</div>
          <input aria-label={`draft-${task.id}`} value={draft} onChange={(event) => setDraft(event.target.value)} />
        </div>
      );
    },
  };
});

function task(id: string): Task {
  return { id, title: id, status: "todo" } as Task;
}

const VIEWS: TaskView[] = ["board", "list", "planning", "agents", "settings", "chat", "plugin:sample" as TaskView];

/*
FNXC:TaskWindowIdentity 2026-09-14-17:46:
FN-392 symptom: a task window was scoped to the view it was opened from, so leaving that view hid it and reopening the
same task elsewhere created a second window. These regressions drive the real App pop-out owner and renderer: one task
owns one window per project, it stays the same visible node in every view, reopening focuses it instead of duplicating,
a project boundary closes every window, and only the global visibility manager suspends its content.
*/
function CrossViewHarness({ projectKey = "project-a" }: { projectKey?: string }) {
  const [taskView, setTaskView] = useState<TaskView>("board");
  const { entries, open, close, closeAll } = useAppPoppedOutTaskState({
    isMobile: false,
    pushNav: vi.fn(),
    removeNav: vi.fn(),
  });

  return (
    <DashboardWindowManagerProvider>
      <DashboardWindowManagerScope scopeKey={projectKey} />
      <output data-testid="current-view">{taskView}</output>
      {VIEWS.map((view) => (
        <button key={view} type="button" onClick={() => setTaskView(view)}>{`go ${view}`}</button>
      ))}
      <button type="button" onClick={() => open(task("FN-1"))}>{"open FN-1"}</button>
      <button type="button" onClick={() => open(task("FN-2"))}>{"open FN-2"}</button>
      <button type="button" onClick={() => open(task("FN-1"), "workflow")}>{"reopen FN-1 on workflow"}</button>
      <button type="button" onClick={() => close("FN-1")}>{"close FN-1"}</button>
      <button type="button" onClick={() => closeAll()}>{"switch project"}</button>
      <AppTaskPopoutWindows
        entries={entries}
        liveTasks={entries.map((entry) => entry.task)}
        onCloseTask={close}
        windowProps={{ addToast: vi.fn(), onDeleteTask: vi.fn(), onMergeTask: vi.fn() } as never}
      />
      <footer><DashboardWindowVisibilityToggle /></footer>
    </DashboardWindowManagerProvider>
  );
}

function windowNode(taskId: string) {
  return screen.getByTestId(`floating-window-task-detail-${taskId}`);
}

function overlayNode(taskId: string) {
  return screen.getByTestId(`floating-window-overlay-task-detail-${taskId}`);
}

describe("task windows travel across every dashboard view", () => {
  it("keeps one task window mounted, visible, and unchanged through every view", () => {
    render(<CrossViewHarness />);
    fireEvent.click(screen.getByRole("button", { name: "open FN-1" }));

    const node = windowNode("FN-1");
    const overlay = overlayNode("FN-1");
    const layer = overlay.style.zIndex;
    fireEvent.change(within(node).getByLabelText("draft-FN-1"), { target: { value: "notes locales" } });

    for (const view of VIEWS) {
      fireEvent.click(screen.getByRole("button", { name: `go ${view}` }));
      expect(screen.getByTestId("current-view")).toHaveTextContent(view);
      expect(windowNode("FN-1")).toBe(node);
      expect(overlayNode("FN-1")).toBe(overlay);
      expect(overlay).not.toHaveAttribute("aria-hidden");
      expect(overlay.className).not.toContain("floating-window-overlay--hidden");
      expect(overlay.style.zIndex).toBe(layer);
      expect(within(node).getByLabelText("draft-FN-1")).toHaveValue("notes locales");
      expect(screen.getByTestId("detail-FN-1")).toHaveAttribute("data-active", "true");
    }
  });

  it("focuses the existing window when the same task is reopened from another view", () => {
    render(<CrossViewHarness />);
    fireEvent.click(screen.getByRole("button", { name: "open FN-1" }));
    const node = windowNode("FN-1");
    fireEvent.change(within(node).getByLabelText("draft-FN-1"), { target: { value: "conservé" } });

    fireEvent.click(screen.getByRole("button", { name: "go list" }));
    fireEvent.click(screen.getByRole("button", { name: "reopen FN-1 on workflow" }));

    expect(screen.getAllByTestId(/^floating-window-task-detail-FN-1/)).toHaveLength(1);
    expect(windowNode("FN-1")).toBe(node);
    expect(within(node).getByLabelText("draft-FN-1")).toHaveValue("conservé");
  });

  it("keeps two distinct tasks side by side and closes exactly one by id", () => {
    render(<CrossViewHarness />);
    fireEvent.click(screen.getByRole("button", { name: "open FN-1" }));
    fireEvent.click(screen.getByRole("button", { name: "go planning" }));
    fireEvent.click(screen.getByRole("button", { name: "open FN-2" }));

    expect(windowNode("FN-1")).toBeInTheDocument();
    expect(windowNode("FN-2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "close FN-1" }));
    expect(screen.queryByTestId("floating-window-task-detail-FN-1")).toBeNull();
    expect(windowNode("FN-2")).toBeInTheDocument();
  });

  it("closes every task window at a project boundary", () => {
    render(<CrossViewHarness />);
    fireEvent.click(screen.getByRole("button", { name: "open FN-1" }));
    fireEvent.click(screen.getByRole("button", { name: "open FN-2" }));

    fireEvent.click(screen.getByRole("button", { name: "switch project" }));

    expect(screen.queryByTestId("floating-window-task-detail-FN-1")).toBeNull();
    expect(screen.queryByTestId("floating-window-task-detail-FN-2")).toBeNull();
  });

  it("suspends a task window's content only for a global hide, never for navigation", async () => {
    render(<CrossViewHarness />);
    fireEvent.click(screen.getByRole("button", { name: "open FN-1" }));
    expect(screen.getByTestId("detail-FN-1")).toHaveAttribute("data-active", "true");

    const toggle = await screen.findByTestId("dashboard-window-visibility-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("detail-FN-1")).toHaveAttribute("data-active", "false");
    expect(overlayNode("FN-1")).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(screen.getByRole("button", { name: "go agents" }));
    expect(screen.getByTestId("detail-FN-1")).toHaveAttribute("data-active", "false");

    fireEvent.click(toggle);
    expect(screen.getByTestId("detail-FN-1")).toHaveAttribute("data-active", "true");
  });
});
