import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { useState } from "react";
import type { ResolvedWorkflowOptionalStep } from "@fusion/core";
import { WorkflowOptionalStepsDropdown } from "../WorkflowOptionalStepsDropdown";
import { readAppFile } from "../../test/cssFixture";

const STEP: ResolvedWorkflowOptionalStep = {
  templateId: "browser-verification",
  name: "Browser Verification",
  description: "Verify web application functionality using browser automation",
  icon: "globe",
  phase: "pre-merge",
  defaultOn: false,
};

const STEP_TWO: ResolvedWorkflowOptionalStep = {
  templateId: "test-review",
  name: "Test Review",
  description: "Review test coverage",
  icon: "check-circle",
  phase: "post-implementation",
  defaultOn: false,
};

const STEP_WITHOUT_DESCRIPTION: ResolvedWorkflowOptionalStep = {
  templateId: "docs",
  name: "Docs",
  icon: "file-text",
  phase: "post-implementation",
  defaultOn: false,
};

const DROPDOWN_CSS = readAppFile("components/WorkflowOptionalStepsDropdown.css");

// Controlled host: parent owns the enabled set, mirroring the create surfaces.
function Host({
  steps,
  initial = [],
  disabled = false,
  triggerTestId,
}: {
  steps: ResolvedWorkflowOptionalStep[];
  initial?: string[];
  disabled?: boolean;
  triggerTestId?: string;
}) {
  const [enabled, setEnabled] = useState<string[]>(initial);
  return (
    <WorkflowOptionalStepsDropdown
      steps={steps}
      enabledIds={enabled}
      onToggle={(id) =>
        setEnabled((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      }
      disabled={disabled}
      triggerTestId={triggerTestId}
    />
  );
}

function expectSharedButtonTrigger(trigger: HTMLElement) {
  expect(trigger).toHaveClass("btn", "btn-sm", "wf-optional-steps-dropdown-trigger");
  expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
  expect(trigger).toHaveAttribute("aria-expanded");
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkflowOptionalStepsDropdown CSS", () => {
  it("uses canonical dropdown theme tokens for the portal panel", () => {
    expect(DROPDOWN_CSS).toContain("background: var(--surface);");
    expect(DROPDOWN_CSS).toContain("border: 1px solid var(--border);");
    expect(DROPDOWN_CSS).toContain("border-radius: var(--radius);");
    expect(DROPDOWN_CSS).toContain("box-shadow: var(--shadow-lg);");
  });

  it("uses the dashboard accent token for option checkboxes", () => {
    const checkboxRule = DROPDOWN_CSS.match(
      /\.wf-optional-steps-dropdown-option input\[type="checkbox"\]\s*\{([^}]*)\}/,
    )?.[1] ?? "";

    expect(checkboxRule).toContain("accent-color: var(--todo);");
    expect(checkboxRule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(checkboxRule).not.toMatch(/\brgba?\(/i);
  });

  it("does not keep hardcoded color or px fallbacks in tokenized rules", () => {
    expect(DROPDOWN_CSS).not.toMatch(/var\(--[^,]+,\s*#/);
    expect(DROPDOWN_CSS).not.toMatch(/var\(--[^,]+,\s*\d+px/);
    expect(DROPDOWN_CSS).not.toContain("#4f7cff");
  });
});

describe("WorkflowOptionalStepsDropdown", () => {
  it("renders nothing when there are no optional steps", () => {
    const { container } = render(<Host steps={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("uses shared button classes and preserves trigger attributes when none are selected", () => {
    render(<Host steps={[STEP]} triggerTestId="custom-optional-steps-trigger" />);
    const trigger = screen.getByTestId("custom-optional-steps-trigger");
    expectSharedButtonTrigger(trigger);
    expect(trigger).toHaveTextContent("Steps: none");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("uses shared button classes and count label when multiple steps are selected", () => {
    render(<Host steps={[STEP, STEP_TWO]} initial={["browser-verification", "test-review"]} />);
    const trigger = screen.getByTestId("wf-optional-steps-dropdown-trigger");
    expectSharedButtonTrigger(trigger);
    expect(trigger).toHaveTextContent("Steps: 2 selected");
  });

  it("uses shared button classes and disabled semantics when submitting", () => {
    render(<Host steps={[STEP]} disabled />);
    const trigger = screen.getByTestId("wf-optional-steps-dropdown-trigger");
    expectSharedButtonTrigger(trigger);
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("Steps: none");
  });

  it("opens, toggles a step, and updates the trigger count", () => {
    render(<Host steps={[STEP]} />);
    const trigger = screen.getByTestId("wf-optional-steps-dropdown-trigger");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const option = screen.getByTestId("wf-optional-steps-dropdown-option-browser-verification");
    expect(option).toHaveAttribute("role", "option");
    expect(option).toHaveAttribute("aria-checked", "false");
    fireEvent.click(option);
    expect(screen.getByTestId("wf-optional-steps-dropdown-option-browser-verification")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(trigger).toHaveTextContent("Steps: 1 selected");
  });

  it("pre-checks a step seeded as enabled by the parent (defaultOn)", () => {
    render(<Host steps={[STEP]} initial={["browser-verification"]} />);
    fireEvent.click(screen.getByTestId("wf-optional-steps-dropdown-trigger"));
    expect(screen.getByTestId("wf-optional-steps-dropdown-option-browser-verification")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("exposes the panel as an accessible listbox labelled by the trigger", () => {
    render(<Host steps={[STEP]} />);
    fireEvent.click(screen.getByTestId("wf-optional-steps-dropdown-trigger"));
    const panel = screen.getByTestId("wf-optional-steps-dropdown-panel");
    expect(panel).toHaveAttribute("role", "listbox");
    expect(within(panel).getByText("Browser Verification")).toBeTruthy();
  });

  it("renders open-panel data states for multiple selections and optional descriptions", () => {
    render(<Host steps={[STEP, STEP_WITHOUT_DESCRIPTION, STEP_TWO]} initial={["browser-verification", "test-review"]} />);
    fireEvent.click(screen.getByTestId("wf-optional-steps-dropdown-trigger"));

    const panel = screen.getByTestId("wf-optional-steps-dropdown-panel");
    const selectedWithDescription = within(panel).getByTestId(
      "wf-optional-steps-dropdown-option-browser-verification",
    );
    const unselectedWithoutDescription = within(panel).getByTestId("wf-optional-steps-dropdown-option-docs");
    const secondSelected = within(panel).getByTestId("wf-optional-steps-dropdown-option-test-review");

    expect(selectedWithDescription).toHaveAttribute("role", "option");
    expect(selectedWithDescription).toHaveAttribute("aria-checked", "true");
    expect(within(selectedWithDescription).getByText("Verify web application functionality using browser automation")).toBeTruthy();
    expect(unselectedWithoutDescription).toHaveAttribute("role", "option");
    expect(unselectedWithoutDescription).toHaveAttribute("aria-checked", "false");
    expect(within(unselectedWithoutDescription).queryByText("Verify web application functionality using browser automation")).toBeNull();
    expect(secondSelected).toHaveAttribute("role", "option");
    expect(secondSelected).toHaveAttribute("aria-checked", "true");
  });

  it("keeps option rows accessible when the open panel starts with zero selected", () => {
    render(<Host steps={[STEP_WITHOUT_DESCRIPTION]} />);
    fireEvent.click(screen.getByTestId("wf-optional-steps-dropdown-trigger"));

    const option = screen.getByTestId("wf-optional-steps-dropdown-option-docs");
    expect(option).toHaveAttribute("role", "option");
    expect(option).toHaveAttribute("aria-checked", "false");
    expect(within(option).getByText("Docs")).toBeTruthy();
  });

  it("closes on Escape", () => {
    render(<Host steps={[STEP]} />);
    const trigger = screen.getByTestId("wf-optional-steps-dropdown-trigger");
    fireEvent.click(trigger);
    const panel = screen.getByTestId("wf-optional-steps-dropdown-panel");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByTestId("wf-optional-steps-dropdown-panel")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on outside click without losing selection", () => {
    render(
      <div>
        <Host steps={[STEP]} initial={["browser-verification"]} />
        <button data-testid="outside">outside</button>
      </div>,
    );
    const trigger = screen.getByTestId("wf-optional-steps-dropdown-trigger");
    fireEvent.click(trigger);
    expect(screen.getByTestId("wf-optional-steps-dropdown-panel")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("wf-optional-steps-dropdown-panel")).toBeNull();
    // Selection preserved.
    expect(trigger).toHaveTextContent("Steps: 1 selected");
  });
});
