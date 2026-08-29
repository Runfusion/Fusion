import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrackingRepoSelect } from "../TrackingRepoSelect";

describe("TrackingRepoSelect", () => {
  it("renders suggestions and selected option", () => {
    render(
      <TrackingRepoSelect
        id="tracking"
        value="octo/widgets"
        onChange={vi.fn()}
        options={[
          { value: "octo/widgets", label: "octo/widgets" },
          { value: "acme/cli", label: "acme/cli" },
        ]}
      />,
    );

    const select = screen.getByRole("combobox");
    expect(select).toHaveValue("octo/widgets");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("fires onChange when selecting suggestion", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <TrackingRepoSelect
        id="tracking"
        value=""
        onChange={onChange}
        options={[
          { value: "octo/widgets", label: "octo/widgets" },
          { value: "acme/cli", label: "acme/cli" },
        ]}
      />,
    );

    await user.selectOptions(screen.getByRole("combobox"), "acme/cli");
    expect(onChange).toHaveBeenCalledWith("acme/cli");
  });

  it("shows custom input and edits custom value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    function Harness() {
      const [value, setValue] = React.useState("");
      return (
        <TrackingRepoSelect
          id="tracking"
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          options={[{ value: "octo/widgets", label: "octo/widgets" }]}
        />
      );
    }

    render(<Harness />);

    await user.selectOptions(screen.getByRole("combobox"), "__custom__");
    const input = screen.getByRole("textbox");
    await user.type(input, "custom/repo");

    expect(onChange).toHaveBeenLastCalledWith("custom/repo");
  });

  it("treats non-suggestion value as custom", () => {
    render(
      <TrackingRepoSelect
        id="tracking"
        value="other/repo"
        onChange={vi.fn()}
        options={[{ value: "octo/widgets", label: "octo/widgets" }]}
      />,
    );

    expect(screen.getByRole("combobox")).toHaveValue("__custom__");
    expect(screen.getByRole("textbox")).toHaveValue("other/repo");
  });

  it("deduplicates duplicate suggestions", () => {
    render(
      <TrackingRepoSelect
        id="tracking"
        value=""
        onChange={vi.fn()}
        options={[
          { value: "octo/widgets", label: "octo/widgets", source: "A" },
          { value: "octo/widgets", label: "octo/widgets", source: "B" },
        ]}
      />,
    );

    const options = screen.getAllByRole("option");
    expect(options.filter((option) => option.getAttribute("value") === "octo/widgets")).toHaveLength(1);
  });

  it("renders loading/error hints without disabling custom entry", () => {
    const { rerender } = render(
      <TrackingRepoSelect
        id="tracking"
        value=""
        onChange={vi.fn()}
        options={[]}
        loading
      />,
    );

    expect(screen.getByText("Loading detected GitHub remotes…")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();

    rerender(
      <TrackingRepoSelect
        id="tracking"
        value=""
        onChange={vi.fn()}
        options={[]}
        error="Unable to load remotes"
      />,
    );

    expect(screen.getByText("Unable to load remotes")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});
