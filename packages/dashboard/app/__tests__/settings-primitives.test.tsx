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

  /*
  FNXC:SettingsHelp 2026-07-15-21:10:
  Help is deferred behind a "?" beside the label, so these pin the parts that are easy to break silently:
   - the trigger exists and toggles (click is the ONLY interaction a touch device has — a hover-only tip is invisible on mobile, and this suite runs in jsdom where hover cannot be simulated anyway);
   - the copy stays in the DOM and reachable via `aria-describedby` while closed, because deferring it visually must not remove it from assistive tech, in-page find, or the settings search index;
   - the error band is NOT deferred.
  */
  it("puts help behind a trigger that toggles on click", () => {
    render(
      <SettingsFieldRow htmlFor="theme" label="Theme" help="Pick a theme">
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    const trigger = screen.getByRole("button", { name: "Show help" });
    const tip = trigger.closest(".settings-help")!;

    expect(tip).toHaveAttribute("data-open", "false");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(tip).toHaveAttribute("data-open", "true");
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(trigger);
    expect(tip).toHaveAttribute("data-open", "false");
  });

  it("keeps help copy in the accessibility tree while collapsed", () => {
    render(
      <SettingsFieldRow htmlFor="theme" label="Theme" help="Pick a theme">
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    const trigger = screen.getByRole("button", { name: "Show help" });
    const describedBy = trigger.getAttribute("aria-describedby")!;
    const bubble = document.getElementById(describedBy);

    // Present and readable even though the row is collapsed — not display:none.
    expect(bubble).not.toBeNull();
    expect(bubble).toHaveTextContent("Pick a theme");
    expect(screen.getByText("Pick a theme")).toBeInTheDocument();
  });

  it("closes an open tip on Escape", () => {
    render(
      <SettingsFieldRow htmlFor="theme" label="Theme" help="Pick a theme">
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    const trigger = screen.getByRole("button", { name: "Show help" });
    fireEvent.click(trigger);
    expect(trigger.closest(".settings-help")).toHaveAttribute("data-open", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.closest(".settings-help")).toHaveAttribute("data-open", "false");
  });

  it("closes an open tip when pointing elsewhere, so a tap on mobile cannot strand it", () => {
    render(
      <SettingsFieldRow htmlFor="theme" label="Theme" help="Pick a theme">
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    const trigger = screen.getByRole("button", { name: "Show help" });
    fireEvent.click(trigger);
    expect(trigger.closest(".settings-help")).toHaveAttribute("data-open", "true");

    fireEvent.pointerDown(document.body);
    expect(trigger.closest(".settings-help")).toHaveAttribute("data-open", "false");
  });

  /*
  FNXC:SettingsHelp 2026-07-15-22:25:
  Only one tip may be open. The outside-pointerdown handler is not sufficient on its own: `click` fires with NO pointer event when a keyboard operator presses Enter/Space on a focused trigger, so opening a second tip that way used to leave the first bubble open underneath it — observed as two overlapping bubbles on a phone-sized viewport.
  Asserted with a bare `click()` precisely because that is the no-pointerdown path.
  */
  it("closes any other open tip when one opens, including without a pointer event", () => {
    render(
      <>
        <SettingsFieldRow htmlFor="alpha" label="Alpha" help="Alpha help">
          <input aria-label="a" />
        </SettingsFieldRow>
        <SettingsFieldRow htmlFor="beta" label="Beta" help="Beta help">
          <input aria-label="b" />
        </SettingsFieldRow>
      </>,
    );
    const [alphaBtn, betaBtn] = screen.getAllByRole("button", { name: "Show help" });
    const alpha = alphaBtn.closest(".settings-help")!;
    const beta = betaBtn.closest(".settings-help")!;

    fireEvent.click(alphaBtn);
    expect(alpha).toHaveAttribute("data-open", "true");

    // No pointerdown — the keyboard path.
    fireEvent.click(betaBtn);
    expect(beta).toHaveAttribute("data-open", "true");
    expect(alpha).toHaveAttribute("data-open", "false");
  });

  it("renders no help trigger when a row has no help", () => {
    render(
      <SettingsFieldRow htmlFor="theme" label="Theme">
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    expect(screen.queryByRole("button", { name: "Show help" })).not.toBeInTheDocument();
  });

  it("keeps the error band inline rather than behind the help trigger", () => {
    render(
      <SettingsFieldRow htmlFor="theme" label="Theme" help="Pick a theme" error="Required">
        <input aria-label="control" />
      </SettingsFieldRow>,
    );
    // A validation message the operator must go looking for is one they will not see.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Required");
    expect(alert.closest(".settings-help")).toBeNull();
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

  /*
  FNXC:SettingsSecurity 2026-07-15-18:52:
  Masking is asserted, not assumed. This primitive hardcoded `type="text"`, which is why every token row (ntfy access token, GitHub/GitLab tokens, Cloudflare tunnel token) had to stay hand-rolled to avoid rendering a stored secret in plain text.
  A regression here would not throw and would not look broken in review — the field simply renders the token — so it is pinned by a test rather than left to a reviewer noticing a missing prop.
  */
  it("defaults to a text input", () => {
    render(<SettingsTextRow descriptor={descriptor} value="Ada" onChange={() => {}} />);
    expect(screen.getByRole("textbox")).toHaveAttribute("type", "text");
  });

  it("masks a password row and suppresses autofill by default", () => {
    render(
      <SettingsTextRow
        descriptor={{ key: "apiToken", label: "API token", type: "password" }}
        value="tk_secret"
        onChange={() => {}}
      />,
    );
    // A password input is deliberately not exposed with the textbox role.
    const input = document.querySelector("#apiToken") as HTMLInputElement;
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("tk_secret");
    // Without this a browser offers to save the operator's API token.
    expect(input).toHaveAttribute("autocomplete", "off");
  });

  it("lets a descriptor override autocomplete on a password row", () => {
    render(
      <SettingsTextRow
        descriptor={{ key: "apiToken", label: "API token", type: "password", autoComplete: "new-password" }}
        value=""
        onChange={() => {}}
      />,
    );
    expect(document.querySelector("#apiToken")).toHaveAttribute("autocomplete", "new-password");
  });

  it("renders a url row without forcing autocomplete off", () => {
    render(
      <SettingsTextRow
        descriptor={{ key: "baseUrl", label: "Base URL", type: "url" }}
        value="https://ntfy.sh"
        onChange={() => {}}
      />,
    );
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("type", "url");
    // autocomplete suppression is a secret-bearing concern, not a URL one.
    expect(input).not.toHaveAttribute("autocomplete");
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
