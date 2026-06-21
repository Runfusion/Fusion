import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BoardWorkflowDefinition } from "../../api";
import { loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { WorkflowSwitcher } from "../WorkflowSwitcher";
import type { WorkflowStatusCounts } from "../workflowStatusCounts";

const workflows: BoardWorkflowDefinition[] = [
  {
    id: "coding",
    name: "Coding",
    columns: [],
  },
  {
    id: "design",
    name: "Design",
    columns: [],
  },
];

function countMap(entries: Array<[string, WorkflowStatusCounts]> = []) {
  return new Map<string, WorkflowStatusCounts>(entries);
}

function cssRuleFor(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("WorkflowSwitcher", () => {
  it("renders the active workflow without compact counts while collapsed", () => {
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={vi.fn()}
        counts={countMap([["coding", { todo: 3, inProgress: 1, done: 5 }]])}
      />,
    );

    const trigger = screen.getByTestId("workflow-switcher");
    expect(trigger).toHaveTextContent("Coding");
    expect(within(trigger).queryByText("3", { selector: ".workflow-switcher-count--todo" })).not.toBeInTheDocument();
    expect(within(trigger).queryByText("1", { selector: ".workflow-switcher-count--in-progress" })).not.toBeInTheDocument();
    expect(within(trigger).queryByText("5", { selector: ".workflow-switcher-count--done" })).not.toBeInTheDocument();
    expect(trigger.querySelector(".workflow-switcher-counts--trigger")).toBeNull();
    expect(trigger).toHaveAccessibleName("Select workflow. Current workflow: Coding");
  });

  it("opens and closes the portaled listbox", () => {
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={vi.fn()} counts={countMap()} />);

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();
    expect(screen.getByTestId("workflow-switcher-option-coding")).toHaveAttribute("aria-selected", "true");

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();
  });

  it("calls onChange when an option is selected", () => {
    const onChange = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={onChange} counts={countMap()} />);

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-option-design"));

    expect(onChange).toHaveBeenCalledWith("design");
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();
  });

  it("supports keyboard navigation and escape dismissal", () => {
    const onChange = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={onChange} counts={countMap()} />);

    const trigger = screen.getByTestId("workflow-switcher");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("design");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();
  });

  it("renders populated and zero counts only after the dropdown expands", () => {
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={vi.fn()}
        counts={countMap([["coding", { todo: 3, inProgress: 1, done: 5 }]])}
      />,
    );

    const trigger = screen.getByTestId("workflow-switcher");
    expect(trigger.querySelector(".workflow-switcher-counts")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(within(trigger).getByText("3", { selector: ".workflow-switcher-count--todo" })).toBeInTheDocument();
    expect(within(trigger).getByText("1", { selector: ".workflow-switcher-count--in-progress" })).toBeInTheDocument();
    expect(within(trigger).getByText("5", { selector: ".workflow-switcher-count--done" })).toBeInTheDocument();

    const codingOption = screen.getByTestId("workflow-switcher-option-coding");
    expect(within(codingOption).getByText("3", { selector: ".workflow-switcher-count--todo" })).toBeInTheDocument();
    expect(within(codingOption).getByText("1", { selector: ".workflow-switcher-count--in-progress" })).toBeInTheDocument();
    expect(within(codingOption).getByText("5", { selector: ".workflow-switcher-count--done" })).toBeInTheDocument();

    const designOption = screen.getByTestId("workflow-switcher-option-design");
    expect(within(designOption).getByText("0", { selector: ".workflow-switcher-count--todo" })).toBeInTheDocument();
    expect(within(designOption).getByText("0", { selector: ".workflow-switcher-count--in-progress" })).toBeInTheDocument();
    expect(within(designOption).getByText("0", { selector: ".workflow-switcher-count--done" })).toBeInTheDocument();
  });

  it("colors status counts with board column color tokens", () => {
    const css = loadAllAppCssBaseOnly();
    const badgeRules = [
      [".workflow-switcher-count--todo", "--todo"],
      [".workflow-switcher-count--in-progress", "--in-progress"],
      [".workflow-switcher-count--done", "--done"],
    ] as const;

    for (const [selector, token] of badgeRules) {
      const rule = cssRuleFor(css, selector);
      expect(rule).toMatch(new RegExp(`color:\\s*var\\(${token}\\)`));
      expect(rule).not.toMatch(/var\(--(?:text-muted|color-warning|color-success)\)/);
      expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
    }
  });
});
