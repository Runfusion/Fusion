import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskRecommendationsTab } from "../TaskRecommendationsTab";
import type { Task } from "@fusion/core";

const { createTaskFromRecommendation } = vi.hoisted(() => ({ createTaskFromRecommendation: vi.fn() }));
vi.mock("../../api", () => ({ createTaskFromRecommendation }));

const task: Task = {
  id: "FN-8829",
  description: "Completed task",
  column: "done",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  recommendations: [{
    id: "rec-1",
    title: "Add focused coverage",
    description: "Add a separate regression test for a related workflow.",
    category: "improvement",
  }],
};

describe("TaskRecommendationsTab", () => {
  it("renders one accessible empty message with no action for undefined or empty recommendations", () => {
    const view = render(<TaskRecommendationsTab task={{ ...task, recommendations: undefined }} projectId="project-a" />);

    expect(screen.getByText("No recommendations were produced for this task.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(createTaskFromRecommendation).not.toHaveBeenCalled();

    view.rerender(<TaskRecommendationsTab task={{ ...task, recommendations: [] }} projectId="project-a" />);
    expect(screen.getByText("No recommendations were produced for this task.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(createTaskFromRecommendation).not.toHaveBeenCalled();
  });

  it("renders exactly one create action and converges to Created after success", async () => {
    const parent = {
      ...task,
      recommendations: [{ ...task.recommendations![0], createdTaskId: "FN-8830" }],
    };
    const onTaskReconciled = vi.fn();
    createTaskFromRecommendation.mockResolvedValue({ task: { id: "FN-8830" }, parent });
    render(<TaskRecommendationsTab task={task} projectId="project-a" onTaskReconciled={onTaskReconciled} />);

    const button = screen.getByRole("button", { name: "Create task" });
    fireEvent.click(button);
    expect(button).toBeDisabled();

    expect(await screen.findByText("Created FN-8830")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create|Retry/ })).not.toBeInTheDocument();
    expect(createTaskFromRecommendation).toHaveBeenCalledWith("FN-8829", "rec-1", "project-a");
    expect(onTaskReconciled).toHaveBeenCalledWith(parent);
  });

  it("does not render an action for an already-created recommendation", () => {
    render(<TaskRecommendationsTab task={{ ...task, recommendations: [{ ...task.recommendations![0], createdTaskId: "FN-8830" }] }} projectId="project-a" />);

    expect(screen.getByText("Created FN-8830")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create|Retry/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No recommendations were produced for this task.")).not.toBeInTheDocument();
  });

  it("clears recommendation action state when retained detail switches tasks", async () => {
    createTaskFromRecommendation.mockResolvedValue({
      task: { id: "FN-8830" },
      parent: { ...task, recommendations: [{ ...task.recommendations![0], createdTaskId: "FN-8830" }] },
    });
    const { rerender } = render(<TaskRecommendationsTab task={task} projectId="project-a" />);

    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText("Created FN-8830");

    rerender(<TaskRecommendationsTab task={{ ...task, id: "FN-8831" }} projectId="project-a" />);
    expect(await screen.findByRole("button", { name: "Create task" })).toBeEnabled();
    await waitFor(() => expect(screen.queryByText("Created FN-8830")).not.toBeInTheDocument());
  });

  it("issues one request for rapid clicks and leaves a retry action after an intake conflict", async () => {
    createTaskFromRecommendation.mockReset();
    let rejectRequest: ((error: Error) => void) | undefined;
    createTaskFromRecommendation.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    render(<TaskRecommendationsTab task={task} projectId="project-a" />);

    const button = screen.getByRole("button", { name: "Create task" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(createTaskFromRecommendation).toHaveBeenCalledTimes(1);

    rejectRequest?.(new Error("duplicate_candidates"));
    expect(await screen.findByRole("button", { name: "Retry creating task" })).toBeEnabled();
  });

  it("keeps concurrent recommendation actions isolated", async () => {
    createTaskFromRecommendation.mockReset();
    let resolveFirst: ((value: { task: { id: string }; parent: Task }) => void) | undefined;
    let resolveSecond: ((value: { task: { id: string }; parent: Task }) => void) | undefined;
    createTaskFromRecommendation
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const secondRecommendation = {
      ...task.recommendations![0],
      id: "rec-2",
      title: "Add a separate feature",
    };
    const multiRecommendationTask = { ...task, recommendations: [task.recommendations![0], secondRecommendation] };
    render(<TaskRecommendationsTab task={multiRecommendationTask} projectId="project-a" />);

    const buttons = screen.getAllByRole("button", { name: "Create task" });
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(createTaskFromRecommendation).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("button", { name: "Creating…" })).toHaveLength(2);

    resolveFirst?.({
      task: { id: "FN-8830" },
      parent: { ...multiRecommendationTask, recommendations: [{ ...task.recommendations![0], createdTaskId: "FN-8830" }, secondRecommendation] },
    });
    expect(await screen.findByText("Created FN-8830")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();

    resolveSecond?.({
      task: { id: "FN-8831" },
      parent: { ...multiRecommendationTask, recommendations: [task.recommendations![0], { ...secondRecommendation, createdTaskId: "FN-8831" }] },
    });
    expect(await screen.findByText("Created FN-8831")).toBeInTheDocument();
  });
});
