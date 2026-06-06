// @vitest-environment jsdom
/**
 * Settings UI primitives (U8 / KTD-10) — behavior + typing contract.
 *
 * Scope here is behavior and value typing (visual polish is verified in U9's
 * browser pass): each primitive renders label/help/error, the scope badge
 * renders, change events propagate with correctly-typed values (numbers not
 * strings, booleans, the selected option value), and the clearable affordance
 * emits the null-as-delete signal that preserves the modal's clear semantics.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

import {
  SettingsFieldRow,
  SettingsToggleRow,
  SettingsNumberRow,
  SettingsSelectRow,
  SettingsTextRow,
  SettingsTextareaRow,
  SettingsSection,
} from "../components/settings";

expect.extend(jestDomMatchers);

afterEach(() => cleanup());

describe("SettingsFieldRow", () => {
  it("renders label, help, and error", () => {
    render(
      <SettingsFieldRow label="Theme" help="Pick a theme" error="Required">
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    expect(screen.getByText("Theme")).toBeInTheDocument();
    expect(screen.getByText("Pick a theme")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
  });

  it("renders a scope badge when scope is set", () => {
    render(
      <SettingsFieldRow label="Theme" scope="global">
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    const badge = screen.getByTestId("settings-field-row-scope");
    expect(badge).toHaveTextContent("global");
    expect(badge).toHaveClass("settings-field-row-scope--global");
  });

  it("renders no scope badge by default", () => {
    render(
      <SettingsFieldRow label="Theme">
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    expect(screen.queryByTestId("settings-field-row-scope")).not.toBeInTheDocument();
  });

  it("renders the clear affordance and fires onClear when clearable", () => {
    const onClear = vi.fn();
    render(
      <SettingsFieldRow label="Theme" clearable onClear={onClear}>
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("hides the clear affordance when not clearable", () => {
    render(
      <SettingsFieldRow label="Theme">
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    expect(screen.queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument();
  });
});

describe("SettingsToggleRow", () => {
  const descriptor = { key: "notify", label: "Notifications", help: "Toggle alerts" };

  it("renders label and help and reflects value", () => {
    render(<SettingsToggleRow descriptor={descriptor} value={true} onChange={() => {}} />);
    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.getByText("Toggle alerts")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("emits a boolean on change", () => {
    const onChange = vi.fn();
    render(<SettingsToggleRow descriptor={descriptor} value={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(typeof onChange.mock.calls[0][0]).toBe("boolean");
  });

  it("emits null when cleared", () => {
    const onChange = vi.fn();
    render(<SettingsToggleRow descriptor={descriptor} value={true} onChange={onChange} clearable />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe("SettingsNumberRow", () => {
  const descriptor = { key: "max", label: "Max parallel", min: 1, max: 10, step: 1 };

  it("renders label and reflects value", () => {
    render(<SettingsNumberRow descriptor={descriptor} value={4} onChange={() => {}} />);
    expect(screen.getByText("Max parallel")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).toHaveValue(4);
  });

  it("emits a number, not a string", () => {
    const onChange = vi.fn();
    render(<SettingsNumberRow descriptor={descriptor} value={4} onChange={onChange} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "7" } });
    expect(onChange).toHaveBeenCalledWith(7);
    expect(typeof onChange.mock.calls[0][0]).toBe("number");
  });

  it("emits null when emptied", () => {
    const onChange = vi.fn();
    render(<SettingsNumberRow descriptor={descriptor} value={4} onChange={onChange} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("emits null when cleared", () => {
    const onChange = vi.fn();
    render(<SettingsNumberRow descriptor={descriptor} value={4} onChange={onChange} clearable />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows an empty field for a null value", () => {
    render(<SettingsNumberRow descriptor={descriptor} value={null} onChange={() => {}} />);
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
  });
});

describe("SettingsSelectRow", () => {
  const descriptor = {
    key: "theme",
    label: "Theme",
    options: [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
  };

  it("renders all options", () => {
    render(<SettingsSelectRow descriptor={descriptor} value="light" onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Dark" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("light");
  });

  it("emits the selected value", () => {
    const onChange = vi.fn();
    render(<SettingsSelectRow descriptor={descriptor} value="light" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "dark" } });
    expect(onChange).toHaveBeenCalledWith("dark");
  });

  it("emits null when cleared", () => {
    const onChange = vi.fn();
    render(<SettingsSelectRow descriptor={descriptor} value="dark" onChange={onChange} clearable />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe("SettingsTextRow", () => {
  const descriptor = { key: "name", label: "Display name", placeholder: "e.g. Ada" };

  it("renders label and placeholder and reflects value", () => {
    render(<SettingsTextRow descriptor={descriptor} value="Ada" onChange={() => {}} />);
    expect(screen.getByText("Display name")).toBeInTheDocument();
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("Ada");
    expect(input).toHaveAttribute("placeholder", "e.g. Ada");
  });

  it("emits the string value", () => {
    const onChange = vi.fn();
    render(<SettingsTextRow descriptor={descriptor} value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Grace" } });
    expect(onChange).toHaveBeenCalledWith("Grace");
    expect(typeof onChange.mock.calls[0][0]).toBe("string");
  });

  it("emits null when cleared", () => {
    const onChange = vi.fn();
    render(<SettingsTextRow descriptor={descriptor} value="Ada" onChange={onChange} clearable />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe("SettingsTextareaRow", () => {
  const descriptor = { key: "notes", label: "Notes", placeholder: "Anything..." };

  it("renders label and reflects value", () => {
    render(<SettingsTextareaRow descriptor={descriptor} value="hello" onChange={() => {}} />);
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("hello");
  });

  it("emits the string value", () => {
    const onChange = vi.fn();
    render(<SettingsTextareaRow descriptor={descriptor} value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "line1\nline2" } });
    expect(onChange).toHaveBeenCalledWith("line1\nline2");
    expect(typeof onChange.mock.calls[0][0]).toBe("string");
  });

  it("emits null when cleared", () => {
    const onChange = vi.fn();
    render(<SettingsTextareaRow descriptor={descriptor} value="hi" onChange={onChange} clearable />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe("SettingsSection", () => {
  it("renders title, description, and children", () => {
    render(
      <SettingsSection title="General" description="Top-level options">
        <div data-testid="child">content</div>
      </SettingsSection>,
    );
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByText("Top-level options")).toBeInTheDocument();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("renders without a description", () => {
    render(
      <SettingsSection title="General">
        <div>content</div>
      </SettingsSection>,
    );
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });
});
