import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { LoadingSpinner } from "../LoadingSpinner";

describe("LoadingSpinner", () => {
  it("renders a lucide svg carrying the animate-spin utility (so it actually spins)", () => {
    const { container } = render(<LoadingSpinner label="Loading…" />);

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // The animation only runs if the svg has the global spin utility class.
    expect(svg).toHaveClass("animate-spin");
    expect(svg).toHaveAttribute("fill", "none"); // lucide stroke-only loader
  });

  it("shows the provided label text alongside the spinner", () => {
    render(<LoadingSpinner label="Loading specification…" />);
    expect(screen.getByText("Loading specification…")).toBeInTheDocument();
  });

  it("exposes a live status region for assistive tech", () => {
    render(<LoadingSpinner label="Loading…" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveClass("loading-spinner");
  });

  it("renders an icon-only spinner when no label is given", () => {
    const { container } = render(<LoadingSpinner />);
    expect(container.querySelector("svg")).toHaveClass("animate-spin");
    expect(container.querySelector(".loading-spinner__label")).toBeNull();
  });

  it("merges a caller className onto the wrapper for layout slotting", () => {
    render(<LoadingSpinner label="Loading…" className="spec-loading" />);
    const status = screen.getByRole("status");
    expect(status).toHaveClass("loading-spinner");
    expect(status).toHaveClass("spec-loading");
  });
});
