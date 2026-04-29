import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NodeHealthDot } from "../NodeHealthDot";

describe("NodeHealthDot", () => {
  it.each(["online", "offline", "error", "connecting"] as const)("renders status dot for %s", (status) => {
    render(<NodeHealthDot status={status} />);
    expect(document.querySelector(`.status-dot--${status}`)).toBeInTheDocument();
  });

  it("shows label when requested", () => {
    render(<NodeHealthDot status="online" showLabel />);
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("hides label by default", () => {
    render(<NodeHealthDot status="online" />);
    expect(document.querySelector(".node-health-dot__label")).toBeNull();
  });

  it("applies compact class", () => {
    render(<NodeHealthDot status="online" compact />);
    expect(document.querySelector(".node-health-dot--compact")).toBeInTheDocument();
  });

  it("sets accessible label and title", () => {
    render(<NodeHealthDot status="online" />);
    const wrapper = screen.getByLabelText("Node status: Online");
    expect(wrapper).toHaveAttribute("title", "Online");
  });
});
