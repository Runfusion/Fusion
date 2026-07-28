import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Settings } from "@fusion/core";
import { GlobalGeneralSection } from "../GlobalGeneralSection";
import type { SettingsFormState } from "../context";

function renderSection(formOverrides: Partial<Settings> = {}) {
  let form = { ...formOverrides } as SettingsFormState;
  const setForm = vi.fn((updater: SettingsFormState | ((previous: SettingsFormState) => SettingsFormState)) => {
    form = typeof updater === "function" ? updater(form) : updater;
  });

  const view = render(<GlobalGeneralSection form={form} setForm={setForm} />);
  setForm.mockImplementation((updater: SettingsFormState | ((previous: SettingsFormState) => SettingsFormState)) => {
    form = typeof updater === "function" ? updater(form) : updater;
    view.rerender(<GlobalGeneralSection form={form} setForm={setForm} />);
  });
  return { getForm: () => form };
}

describe("GlobalGeneralSection agent tool-output budget", () => {
  it("stores the explicit unlimited sentinel and disables the numeric input", () => {
    const { getForm } = renderSection();
    const noLimit = screen.getByLabelText("No limit on agent tool output");
    const limit = screen.getByLabelText("Agent tool-output limit");

    fireEvent.click(noLimit);
    expect(getForm().agentToolOutputMaxChars).toBe(0);
    expect(limit).toBeDisabled();

    fireEvent.click(noLimit);
    expect(getForm().agentToolOutputMaxChars).toBeNull();
    expect(limit).not.toBeDisabled();
  });

  it("stores a number and clears back to the inherited default", () => {
    const { getForm } = renderSection();
    const limit = screen.getByLabelText("Agent tool-output limit");

    fireEvent.change(limit, { target: { value: "500" } });
    expect(getForm().agentToolOutputMaxChars).toBe(500);

    fireEvent.change(limit, { target: { value: "" } });
    expect(getForm().agentToolOutputMaxChars).toBeNull();
  });
});
