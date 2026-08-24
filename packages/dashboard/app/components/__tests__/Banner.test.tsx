import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Banner } from "../Banner";

describe("Banner", () => {
  it("renders title, children, and the selected tone", () => {
    render(<Banner tone="warning" title="Attention">Banner copy</Banner>);

    const root = screen.getByText("Banner copy").closest(".banner");
    expect(root).toHaveClass("banner--warning", "banner--inline", "banner--regular");
    expect(root).toHaveTextContent("Attention");
  });

  it("renders an accessible dismiss action only when provided", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Banner tone="info">Copy</Banner>);
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();

    rerender(<Banner tone="info" onDismiss={onDismiss} dismissLabel="Close notice">Copy</Banner>);
    fireEvent.click(screen.getByRole("button", { name: "Close notice" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("omits undefined icon and action slots", () => {
    const { container } = render(<Banner tone="neutral">Copy</Banner>);
    expect(container.querySelector(".banner__icon")).toBeNull();
    expect(container.querySelector(".banner__actions")).toBeNull();
  });

  it("forwards root semantics and caller classes", () => {
    render(
      <Banner tone="success" className="caller-class" role="alert" aria-live="assertive" aria-label="Banner label" data-testid="banner">
        Copy
      </Banner>,
    );
    const root = screen.getByTestId("banner");
    expect(root).toHaveClass("caller-class");
    expect(root).toHaveAttribute("role", "alert");
    expect(root).toHaveAttribute("aria-live", "assertive");
    expect(root).toHaveAttribute("aria-label", "Banner label");
  });

  it("supports section roots and chrome layout", () => {
    render(<Banner tone="error" as="section" layout="chrome">Copy</Banner>);
    expect(screen.getByText("Copy").closest("section")).toHaveClass("banner--chrome");
    expect(screen.getByText("Copy").closest("section")).not.toHaveClass("banner--inline");
  });
});
