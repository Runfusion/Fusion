import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TaskDetailContent } from "../TaskDetailModal";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";

setupTaskDetailModalHooks();

const summaryPrompt = `# Task: FN-195 - Summary first

## Original Description

<!-- fusion-original-description:start -->
Keep task intent readable.
<!-- fusion-original-description:end -->

## What This Delivers

Operators can confirm the expected outcome quickly.

## Before → After Transformation

- **Before:** intent is buried
- **After:** intent is visible

## Mission

Technical delivery details.

## File Scope

- \`packages/dashboard/app/components/TaskDetailModal.tsx\`

## Steps

### Step 1: Ship it
`;

function renderDefinition(prompt = summaryPrompt, options?: { id?: string; embedded?: boolean }) {
  return render(
    <TaskDetailContent
      task={makeTask({ id: options?.id ?? "FN-195", prompt })}
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

describe("TaskDetailContent plan summary", () => {
  it("shows What This Delivers and Before → After before collapsed details", () => {
    renderDefinition();

    const summary = screen.getByTestId("task-detail-plan-summary");
    const toggle = screen.getByTestId("task-detail-plan-details-toggle");
    expect(summary).toHaveTextContent("Operators can confirm the expected outcome quickly.");
    expect(summary).toHaveTextContent("intent is buried");
    expect(screen.queryByTestId("task-detail-plan-details")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("reveals and re-hides the technical remainder without duplicating summary content", () => {
    renderDefinition();
    const toggle = screen.getByTestId("task-detail-plan-details-toggle");

    fireEvent.click(toggle);
    const details = screen.getByTestId("task-detail-plan-details");
    expect(details).toHaveTextContent("Technical delivery details.");
    expect(details).toHaveTextContent("File Scope");
    expect(details).not.toHaveTextContent("Operators can confirm the expected outcome quickly.");
    expect(screen.getByTestId("task-detail-plan-summary")).not.toHaveTextContent("Technical delivery details.");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide details");

    fireEvent.click(toggle);
    expect(screen.queryByTestId("task-detail-plan-details")).toBeNull();
    expect(toggle).toHaveTextContent("See more details");
  });

  it("supports the existing Before → After-only plan shape", () => {
    renderDefinition("# Task: FN-195\n\n## Before → After Transformation\n\n- **After:** intent is visible\n\n## Mission\n\nShip it.\n");

    expect(screen.getByTestId("task-detail-plan-summary")).toHaveTextContent("intent is visible");
    expect(screen.getByTestId("task-detail-plan-details-toggle")).toBeInTheDocument();
  });

  it("renders legacy plans in full without a disclosure", () => {
    renderDefinition("# Task: FN-195\n\n## Mission\n\nLegacy plan stays visible.\n");

    expect(screen.queryByTestId("task-detail-plan-summary")).toBeNull();
    expect(screen.queryByTestId("task-detail-plan-details-toggle")).toBeNull();
    expect(screen.getByText("Legacy plan stays visible.")).toBeInTheDocument();
  });

  it("does not render an empty disclosure or summary shell", () => {
    const summaryOnly = "# Task: FN-195\n\n## What This Delivers\n\nOperators can confirm it.\n";
    const { rerender } = renderDefinition(summaryOnly);

    expect(screen.getByTestId("task-detail-plan-summary")).toHaveTextContent("Operators can confirm it.");
    expect(screen.queryByTestId("task-detail-plan-details-toggle")).toBeNull();

    rerender(
      <TaskDetailContent
        task={makeTask({ id: "FN-196", prompt: "" })}
        initialTab="definition"
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(screen.getByText("(no prompt)")).toBeInTheDocument();
    expect(screen.queryByTestId("task-detail-plan-summary")).toBeNull();
    expect(screen.queryByTestId("task-detail-plan-details-toggle")).toBeNull();
  });

  it("uses the same contract in embedded hosts and resets when task identity changes", () => {
    const { rerender, container } = renderDefinition(summaryPrompt, { id: "FN-FIRST", embedded: true });
    const toggle = screen.getByTestId("task-detail-plan-details-toggle");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".task-detail-content--embedded")).toContainElement(
      screen.getByTestId("task-detail-plan-summary"),
    );

    rerender(
      <TaskDetailContent
        task={makeTask({ id: "FN-SECOND", prompt: summaryPrompt })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(screen.getByTestId("task-detail-plan-details-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("task-detail-plan-details")).toBeNull();
  });

  it("keeps the complete prompt in the edit textarea", () => {
    renderDefinition();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(document.querySelector(".spec-editor-textarea")).toHaveValue(summaryPrompt);
  });

  it("styles the disclosure with token-only rules at the mobile breakpoint", () => {
    const css = readDashboardStylesSource();
    const selector = ".detail-section--plan-prompt .detail-plan-details-toggle";
    const selectorIndex = css.indexOf(selector);
    const mobileIndex = css.indexOf("@media (max-width: 768px)");
    const mobileSelectorIndex = css.indexOf(selector, mobileIndex);

    expect(selectorIndex).toBeGreaterThan(-1);
    expect(css.slice(selectorIndex, css.indexOf("}", selectorIndex) + 1)).toContain("var(--space-xs)");
    expect(mobileSelectorIndex).toBeGreaterThan(mobileIndex);
    expect(css.slice(selectorIndex, css.indexOf("}", selectorIndex) + 1)).not.toMatch(/#[0-9a-f]|rgb\(|\d+px/i);
  });
});
