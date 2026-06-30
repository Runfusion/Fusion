import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardWorkflowDefinition } from "../../api";
import { loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { computeMenuWidth, OPTION_DECORATIONS_WIDTH, WorkflowSwitcher } from "../WorkflowSwitcher";
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

function menuWidth() {
  const menu = screen.getByRole("listbox", { name: "Workflow" });
  return Number.parseFloat(menu.style.width);
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeMenuWidth", () => {
  it("keeps short-name menus at or above the min width and trigger width", () => {
    expect(computeMenuWidth({ longestNameWidth: 12, triggerWidth: 180, viewportWidth: 1024 })).toBe(240);
    expect(computeMenuWidth({ longestNameWidth: 12, triggerWidth: 280, viewportWidth: 1024 })).toBe(280);
  });

  it("grows with long names plus the option decorations budget", () => {
    const longestNameWidth = 420;
    expect(computeMenuWidth({ longestNameWidth, triggerWidth: 180, viewportWidth: 1024 })).toBe(longestNameWidth + OPTION_DECORATIONS_WIDTH);
  });

  it("caps content-driven width to the padded viewport", () => {
    expect(computeMenuWidth({ longestNameWidth: 1200, triggerWidth: 180, viewportWidth: 390, horizontalPadding: 16 })).toBe(358);
  });

  it("uses trigger dominance when the collapsed control is wider than the content budget", () => {
    expect(computeMenuWidth({ longestNameWidth: 20, triggerWidth: 360, viewportWidth: 1024 })).toBe(360);
  });
});

describe("WorkflowSwitcher", () => {
  it("renders the active workflow without compact counts while collapsed", () => {
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={vi.fn()}
        counts={countMap([["coding", { todo: 3, inProgress: 1, done: 5, merging: 0 }]])}
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

  it("widens the open listbox for long workflow names without changing the trigger sizing contract", () => {
    /* Surface Enumeration: this covers short/long populated options through the shared Board/ListView switcher component seam, with CSS assertions for the collapsed trigger and mobile viewport overflow safety net. */
    const ctxStub = {
      font: "",
      measureText: (text: string) => ({ width: text.length * 8 }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctxStub as CanvasRenderingContext2D);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });

    const { unmount } = render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={vi.fn()} counts={countMap()} />);
    fireEvent.click(screen.getByTestId("workflow-switcher"));
    const shortWidth = menuWidth();
    unmount();

    render(
      <WorkflowSwitcher
        workflows={[
          workflows[0],
          { id: "long", name: "Release Engineering Workflow With Very Long Name", columns: [] },
        ]}
        value="coding"
        onChange={vi.fn()}
        counts={countMap()}
      />,
    );
    fireEvent.click(screen.getByTestId("workflow-switcher"));
    const longWidth = menuWidth();

    expect(shortWidth).toBeGreaterThanOrEqual(240);
    expect(longWidth).toBeGreaterThan(shortWidth);

    const css = loadAllAppCssBaseOnly();
    const triggerRule = cssRuleFor(css, ".workflow-switcher-trigger");
    expect(triggerRule).toMatch(/max-width:\s*calc\(var\(--space-xl\) \* 12\)/);
    const currentNameRule = cssRuleFor(css, ".workflow-switcher-current-name,\n.workflow-switcher-option-name");
    expect(currentNameRule).toMatch(/text-overflow:\s*ellipsis/);
    const switcherCss = readFileSync("app/components/WorkflowSwitcher.css", "utf8");
    expect(switcherCss).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*max-width:\s*calc\(100vw - var\(--space-xl\)\);/);
  });

  it("matches the ProjectSelector trigger and menu chrome without reverting to the old styling", () => {
    /* Surface Enumeration: CSS parity covers the shared Board/ListView WorkflowSwitcher render seam, the header portal slot, desktop menu chrome, mobile max-width safety, selected/highlighted rows, count-badge preservation, and light-theme selected tint without changing behavior. */
    const css = loadAllAppCssBaseOnly();

    const triggerRule = cssRuleFor(css, ".workflow-switcher-trigger");
    expect(triggerRule).toMatch(/background:\s*transparent/);
    expect(triggerRule).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(triggerRule).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(triggerRule).toMatch(/padding:\s*calc\(var\(--space-xs\) \+ var\(--space-xs\) \/ 2\)/);
    expect(triggerRule).toMatch(/color:\s*var\(--text-muted\)/);
    expect(triggerRule).toMatch(/transition:\s*background var\(--transition-fast\), color var\(--transition-fast\), border-color var\(--transition-fast\)/);
    expect(triggerRule).not.toMatch(/background:\s*var\(--bg-secondary\)/);
    expect(triggerRule).not.toMatch(/border-radius:\s*var\(--radius-sm\)/);

    const triggerHoverRule = cssRuleFor(css, ".workflow-switcher-trigger:hover");
    expect(triggerHoverRule).toMatch(/background:\s*var\(--card-hover\)/);
    expect(triggerHoverRule).toMatch(/color:\s*var\(--text\)/);
    expect(triggerHoverRule).toMatch(/border-color:\s*var\(--text-dim\)/);

    const triggerOpenRule = cssRuleFor(css, ".workflow-switcher-trigger[aria-expanded=\"true\"]");
    expect(triggerOpenRule).toMatch(/color:\s*var\(--text\)/);
    expect(triggerOpenRule).toMatch(/border-color:\s*var\(--text-dim\)/);
    expect(triggerOpenRule).not.toMatch(/background:\s*var\(--bg-tertiary\)/);

    const menuRule = cssRuleFor(css, ".workflow-switcher-menu");
    expect(menuRule).toMatch(/padding:\s*var\(--space-sm\)/);
    expect(menuRule).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(menuRule).toMatch(/box-shadow:\s*var\(--shadow-lg\)/);
    expect(menuRule).not.toMatch(/border-radius:\s*var\(--radius\)/);
    expect(menuRule).not.toMatch(/box-shadow:\s*var\(--shadow\)/);

    const optionsRule = cssRuleFor(css, ".workflow-switcher-options");
    expect(optionsRule).toMatch(/scrollbar-width:\s*thin/);
    expect(optionsRule).toMatch(/scrollbar-color:\s*var\(--text-dim\) transparent/);
    expect(cssRuleFor(css, ".workflow-switcher-options::-webkit-scrollbar-thumb")).toMatch(/background-color:\s*var\(--text-dim\)/);

    const optionRowRule = cssRuleFor(css, ".workflow-switcher-option-row");
    expect(optionRowRule).toMatch(/border-radius:\s*var\(--radius-md\)/);
    const optionRule = cssRuleFor(css, ".workflow-switcher-option");
    expect(optionRule).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(optionRule).toMatch(/padding:\s*var\(--space-sm\) calc\(var\(--space-sm\) \+ var\(--space-xs\)\)/);

    const selectedRule = cssRuleFor(css, ".workflow-switcher-option-row--selected");
    expect(selectedRule).toMatch(/background:\s*color-mix\(in srgb, var\(--todo\) 15%, transparent\)/);
  });

  it("fires onOpen only on click-driven closed-to-open transitions", () => {
    const onOpen = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={vi.fn()} counts={countMap()} onOpen={onOpen} />);

    const trigger = screen.getByTestId("workflow-switcher");
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it.each(["ArrowDown", "ArrowUp", "Enter", " "])("fires onOpen when %s opens the dropdown from the keyboard", (key) => {
    const onOpen = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={vi.fn()} counts={countMap()} onOpen={onOpen} />);

    const trigger = screen.getByTestId("workflow-switcher");
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.keyDown(trigger, { key });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listbox", { name: "Workflow" })).toBeInTheDocument();
  });

  it("does not fire onOpen when Escape or outside mousedown closes and fires again after reopening", () => {
    const onOpen = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={vi.fn()} counts={countMap()} onOpen={onOpen} />);

    const trigger = screen.getByTestId("workflow-switcher");
    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(document.body);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("calls onChange when an option is selected", () => {
    const onChange = vi.fn();
    render(<WorkflowSwitcher workflows={workflows} value="coding" onChange={onChange} counts={countMap()} />);

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-option-design"));

    expect(onChange).toHaveBeenCalledWith("design");
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();
  });

  it("renders an accessible aggregate option before workflows without an edit shell", () => {
    const onChange = vi.fn();
    const onEditWorkflow = vi.fn();
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="__all_workflows__"
        onChange={onChange}
        counts={countMap([["__all_workflows__", { todo: 4, inProgress: 3, done: 2, merging: 1 }]])}
        aggregateOption={{ id: "__all_workflows__", name: "All workflows" }}
        onEditWorkflow={onEditWorkflow}
      />,
    );

    expect(screen.getByTestId("workflow-switcher")).toHaveAccessibleName("Select workflow. Current workflow: All workflows");
    fireEvent.click(screen.getByTestId("workflow-switcher"));

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("All workflows")]));
    expect(options[0]).toHaveAttribute("data-testid", "workflow-switcher-option-__all_workflows__");
    expect(screen.getByTestId("workflow-switcher-option-__all_workflows__")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("workflow-switcher-edit-__all_workflows__")).toBeNull();
    expect(screen.getByTestId("workflow-switcher-edit-coding")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-switcher-option-__all_workflows__")).toHaveTextContent("4");

    fireEvent.click(screen.getByTestId("workflow-switcher-option-design"));
    expect(onChange).toHaveBeenCalledWith("design");
    expect(onEditWorkflow).not.toHaveBeenCalled();
  });

  it("supports keyboard selection of the aggregate option", () => {
    const onChange = vi.fn();
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={onChange}
        counts={countMap()}
        aggregateOption={{ id: "__all_workflows__", name: "All workflows" }}
      />,
    );

    const trigger = screen.getByTestId("workflow-switcher");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("__all_workflows__");
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

  it("renders per-row edit buttons that close without selecting workflows", () => {
    const onChange = vi.fn();
    const onEditWorkflow = vi.fn();
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={onChange}
        counts={countMap()}
        onEditWorkflow={onEditWorkflow}
      />,
    );

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    fireEvent.click(screen.getByTestId("workflow-switcher-edit-design"));

    expect(onEditWorkflow).toHaveBeenCalledWith("design");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();
  });

  it("renders a persistent New workflow footer for single and many workflow lists", () => {
    const onCreateWorkflow = vi.fn();
    const { rerender } = render(
      <WorkflowSwitcher
        workflows={[workflows[0]]}
        value="coding"
        onChange={vi.fn()}
        counts={countMap()}
        onCreateWorkflow={onCreateWorkflow}
      />,
    );

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    expect(screen.getByTestId("workflow-switcher-create")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("workflow-switcher-create"));
    expect(onCreateWorkflow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox", { name: "Workflow" })).not.toBeInTheDocument();

    const manyWorkflows = Array.from({ length: 8 }, (_, index) => ({
      id: `workflow-${index}`,
      name: `Workflow ${index}`,
      columns: [],
    }));
    rerender(
      <WorkflowSwitcher
        workflows={manyWorkflows}
        value="workflow-0"
        onChange={vi.fn()}
        counts={countMap()}
        onCreateWorkflow={onCreateWorkflow}
      />,
    );

    fireEvent.click(screen.getByTestId("workflow-switcher"));
    expect(screen.getByTestId("workflow-switcher-create")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(manyWorkflows.length);
  });

  it("keeps Enter selection scoped to highlighted workflow options when actions exist", () => {
    const onChange = vi.fn();
    const onEditWorkflow = vi.fn();
    const onCreateWorkflow = vi.fn();
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={onChange}
        counts={countMap()}
        onEditWorkflow={onEditWorkflow}
        onCreateWorkflow={onCreateWorkflow}
      />,
    );

    const trigger = screen.getByTestId("workflow-switcher");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("design");
    expect(onEditWorkflow).not.toHaveBeenCalled();
    expect(onCreateWorkflow).not.toHaveBeenCalled();
  });

  it("renders populated and zero counts only after the dropdown expands", () => {
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={vi.fn()}
        counts={countMap([["coding", { todo: 3, inProgress: 1, done: 5, merging: 0 }]])}
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

  it("shows a merging indicator only for workflows with merging tasks", () => {
    render(
      <WorkflowSwitcher
        workflows={workflows}
        value="coding"
        onChange={vi.fn()}
        counts={countMap([
          ["coding", { todo: 3, inProgress: 1, done: 5, merging: 1 }],
          ["design", { todo: 0, inProgress: 2, done: 0, merging: 0 }],
        ])}
      />,
    );

    const trigger = screen.getByTestId("workflow-switcher");
    expect(trigger.querySelector(".workflow-switcher-merging-indicator")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.querySelector(".workflow-switcher-merging-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-switcher-option-coding").querySelector(".workflow-switcher-merging-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-switcher-option-design").querySelector(".workflow-switcher-merging-indicator")).toBeNull();
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

  it("styles the merging indicator with a flashing animation and reduced-motion fallback", () => {
    const css = loadAllAppCssBaseOnly();
    const switcherCss = readFileSync("app/components/WorkflowSwitcher.css", "utf8");
    const indicatorRule = cssRuleFor(css, ".workflow-switcher-merging-indicator");

    expect(indicatorRule).toContain("background: var(--color-warning);");
    expect(indicatorRule).toContain("animation: workflow-switcher-merging-pulse");
    expect(switcherCss).toContain("@keyframes workflow-switcher-merging-pulse");
    expect(switcherCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.workflow-switcher-merging-indicator\s*\{[^}]*animation:\s*none;/);
  });
});
