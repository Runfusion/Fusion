import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TaskDetailContent } from "../TaskDetailModal";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";

setupTaskDetailModalHooks();

const fullPrompt = `# Task: FN-195 - Summary first

## What This Delivers

Operators can confirm the expected outcome quickly.

## Mission

Technical delivery details.

## Steps

### Step 1: Ship it
`;

function renderDefinition(options?: { id?: string; prompt?: string; description?: string; embedded?: boolean }) {
  return render(
    <TaskDetailContent
      task={makeTask({ id: options?.id ?? "FN-195", prompt: options?.prompt ?? fullPrompt, description: options?.description ?? "Keep **task intent** readable." })}
      initialTab="definition"
      embedded={options?.embedded}
      onRequestClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />,
  );
}

function openPlan(): void {
  fireEvent.click(screen.getByRole("button", { name: "Read plan" }));
}

describe("TaskDetailContent internal plan navigation", () => {
  it("shows the read-only task description before the plan action", () => {
    renderDefinition();

    expect(screen.getByTestId("task-detail-definition-description")).toHaveTextContent("Keep task intent readable.");
    expect(screen.queryByTestId("task-detail-plan-full")).toBeNull();
    expect(screen.getByRole("button", { name: "Read plan" })).toBeInTheDocument();
  });

  it("opens the complete PROMPT.md and returns without a disclosure", () => {
    renderDefinition();
    openPlan();

    const plan = screen.getByTestId("task-detail-plan-full");
    expect(plan).toHaveTextContent("Operators can confirm the expected outcome quickly.");
    expect(plan).toHaveTextContent("Technical delivery details.");
    expect(screen.queryByTestId("task-detail-plan-details-toggle")).toBeNull();
    expect(document.querySelector(".detail-tabs")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to definition" }));
    expect(screen.getByTestId("task-detail-definition-description")).toBeInTheDocument();
    expect(document.querySelector(".detail-tabs")).toBeInTheDocument();
  });

  it("renders legacy and summary-shaped plans through the same complete viewer", () => {
    renderDefinition({ prompt: "# Legacy\n\n## Mission\n\nLegacy plan stays visible." });
    openPlan();
    expect(screen.getByTestId("task-detail-plan-full")).toHaveTextContent("Legacy plan stays visible.");
  });

  it("keeps empty description and prompt states explicit", () => {
    renderDefinition({ description: "", prompt: "" });
    expect(screen.getByText("(no description)")).toBeInTheDocument();
    openPlan();
    expect(screen.getByText("(no prompt)")).toBeInTheDocument();
  });

  it("resets the internal plan route when task identity changes", () => {
    const view = renderDefinition({ id: "FN-FIRST", embedded: true });
    openPlan();
    expect(screen.getByTestId("task-detail-plan-document")).toBeInTheDocument();

    view.rerender(
      <TaskDetailContent
        task={makeTask({ id: "FN-SECOND", prompt: fullPrompt, description: "Second description" })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(screen.queryByTestId("task-detail-plan-document")).toBeNull();
    expect(screen.getByTestId("task-detail-definition-description")).toHaveTextContent("Second description");
  });

  it("keeps the complete prompt in the edit textarea", () => {
    renderDefinition();
    openPlan();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(document.querySelector(".spec-editor-textarea")).toHaveValue(fullPrompt);
  });

  it("uses token-only responsive styles for definition and plan navigation", () => {
    const css = readDashboardStylesSource();
    const selector = ".detail-definition-description {";
    const selectorIndex = css.indexOf(selector);
    const rule = css.slice(selectorIndex, css.indexOf("}", selectorIndex) + 1);
    expect(selectorIndex).toBeGreaterThan(-1);
    expect(rule).toContain("var(--space-md)");
    expect(rule).not.toMatch(/#[0-9a-f]|rgb\(|\d+px/i);
  });
});
