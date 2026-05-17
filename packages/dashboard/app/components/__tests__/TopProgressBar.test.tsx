import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopProgressBar } from "../TopProgressBar";

describe("TopProgressBar", () => {
  it("renders visible progressbar semantics", () => {
    render(<TopProgressBar visible={true} />);

    const progressBar = screen.getByRole("progressbar", { name: "Loading" });
    expect(progressBar).toHaveAttribute("aria-busy", "true");
    expect(progressBar).toHaveAttribute("data-visible", "true");
  });

  it("stays mounted but hidden when not visible", () => {
    render(<TopProgressBar visible={false} />);

    const progressBar = screen.getByRole("progressbar", { name: "Loading" });
    expect(progressBar).toHaveAttribute("aria-busy", "false");
    expect(progressBar).toHaveAttribute("data-visible", "false");
  });

  it("derives visibility only from the visible prop across rerenders", () => {
    const { rerender } = render(<TopProgressBar visible={true} />);

    const progressBar = screen.getByRole("progressbar", { name: "Loading" });
    expect(progressBar).toHaveAttribute("aria-busy", "true");
    expect(progressBar).toHaveAttribute("data-visible", "true");

    rerender(<TopProgressBar visible={false} />);

    expect(progressBar).toHaveAttribute("aria-busy", "false");
    expect(progressBar).toHaveAttribute("data-visible", "false");
  });
});
