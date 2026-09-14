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
import { loadComponentCss } from "../../test/cssFixture";

function readTaskDetailModalCss(): string {
  return loadComponentCss("TaskDetailModal.css");
}

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

  /*
  FNXC:TaskDetailDefinition 2026-09-14-20:20:
  FN-391 shows a product-language outcome above `Read plan`, selected from the plan the task already
  has — no second AI call, no new plan section. `What This Delivers` wins; a legacy plan falls back
  to `Before → After Transformation`; `Mission` is NEVER used, because the operator's complaint was
  precisely that Mission is too technical to read at a glance. `Read plan` keeps showing the
  complete PROMPT.md, Mission included.
  */
  it("prefers What This Delivers for the product outcome", () => {
    renderDefinition();

    const outcome = screen.getByTestId("task-detail-definition-outcome");
    expect(outcome).toHaveTextContent("Operators can confirm the expected outcome quickly.");
    expect(outcome).not.toHaveTextContent("Technical delivery details.");
  });

  it("falls back to Before → After Transformation for a legacy plan", () => {
    renderDefinition({ prompt: "# Task: FN-195 - Legacy\n\n## Before → After Transformation\n\nBefore it was manual; after it is automatic.\n\n## Mission\n\nTechnical delivery details.\n" });

    expect(screen.getByTestId("task-detail-definition-outcome")).toHaveTextContent("Before it was manual; after it is automatic.");
  });

  it.each([
    { label: "a Mission-only plan", prompt: "# Task: FN-195 - Mission only\n\n## Mission\n\nTechnical delivery details.\n" },
    { label: "an empty plan", prompt: "" },
    { label: "an empty What This Delivers section", prompt: "# Task: FN-195 - Empty\n\n## What This Delivers\n\n## Mission\n\nTechnical delivery details.\n" },
  ])("shows the localized placeholder for $label and never the Mission", ({ prompt }) => {
    renderDefinition({ prompt });

    expect(screen.queryByTestId("task-detail-definition-outcome")).toBeNull();
    expect(screen.getByTestId("task-detail-definition-outcome-empty")).toBeInTheDocument();
    expect(screen.getByTestId("task-detail-definition-outcome-empty")).not.toHaveTextContent("Technical delivery details.");
  });

  it("ignores a summary heading inside a code fence and uses only the first real one", () => {
    renderDefinition({
      prompt: "# Task: FN-195 - Fenced\n\n```md\n## What This Delivers\n\nFenced example text.\n```\n\n## What This Delivers\n\nThe real product outcome.\n\n## What This Delivers\n\nA duplicated heading.\n",
    });

    const outcome = screen.getByTestId("task-detail-definition-outcome");
    expect(outcome).toHaveTextContent("The real product outcome.");
    expect(outcome).not.toHaveTextContent("Fenced example text.");
    expect(outcome).not.toHaveTextContent("A duplicated heading.");
  });

  it("keeps Read plan beside the outcome and still opens the complete plan", () => {
    renderDefinition();

    const readPlan = screen.getByRole("button", { name: "Read plan" });
    expect(readPlan.closest(".detail-definition-outcome")).toBeInTheDocument();

    openPlan();
    const plan = screen.getByTestId("task-detail-plan-full");
    expect(plan).toHaveTextContent("Technical delivery details.");
    expect(plan).toHaveTextContent("Operators can confirm the expected outcome quickly.");
  });

  it("never leaks the previous task's outcome after a task change", () => {
    const view = renderDefinition({ id: "FN-FIRST", embedded: true });
    expect(screen.getByTestId("task-detail-definition-outcome")).toHaveTextContent("Operators can confirm the expected outcome quickly.");

    view.rerender(
      <TaskDetailContent
        task={makeTask({ id: "FN-SECOND", prompt: "# Task: FN-SECOND - Second\n\n## What This Delivers\n\nA different outcome entirely.\n", description: "Second description" })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const outcome = screen.getByTestId("task-detail-definition-outcome");
    expect(outcome).toHaveTextContent("A different outcome entirely.");
    expect(outcome).not.toHaveTextContent("Operators can confirm the expected outcome quickly.");
  });

  it("bounds the read-only description with token-only scrolling rules", () => {
    renderDefinition({ description: `${"Long description paragraph. ".repeat(60)}` });

    const body = screen.getByTestId("task-detail-definition-description");
    expect(body).toHaveClass("detail-definition-description-body");
    expect(body).toHaveAttribute("tabindex", "0");

    const css = readTaskDetailModalCss();
    const selectorIndex = css.indexOf(".detail-definition-description-body {");
    expect(selectorIndex).toBeGreaterThan(-1);
    const rule = css.slice(selectorIndex, css.indexOf("}", selectorIndex) + 1);
    expect(rule).toContain("overflow-y: auto");
    expect(rule).toContain("max-block-size");
    expect(rule).not.toMatch(/#[0-9a-f]{3,}|rgb\(/i);
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
