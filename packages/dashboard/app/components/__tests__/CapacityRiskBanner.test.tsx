import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CapacityRiskBanner } from "../CapacityRiskBanner";

describe("CapacityRiskBanner", () => {
  it("renders nothing when signal is null", () => {
    const { container } = render(<CapacityRiskBanner signal={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when signal is not at risk", () => {
    const { container } = render(
      <CapacityRiskBanner
        signal={{
          atRisk: false,
          todoCount: 10,
          inProgressCount: 2,
          inReviewCount: 1,
          idleNonEphemeralAgentCount: 1,
          threshold: 20,
          reason: "ok",
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders counts and threshold when at risk", () => {
    render(
      <CapacityRiskBanner
        signal={{
          atRisk: true,
          todoCount: 21,
          inProgressCount: 3,
          inReviewCount: 2,
          idleNonEphemeralAgentCount: 0,
          threshold: 20,
          reason: "todo-exceeds-threshold-and-no-idle-agents",
        }}
      />,
    );

    expect(screen.getByText(/Todo 21/)).toBeInTheDocument();
    expect(screen.getByText(/threshold 20/)).toBeInTheDocument();
    expect(screen.getByText(/In Progress 3/)).toBeInTheDocument();
    expect(screen.getByText(/In Review 2/)).toBeInTheDocument();
    expect(screen.getByText(/Idle agents 0/)).toBeInTheDocument();
  });

  it("calls onDismiss when dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    render(
      <CapacityRiskBanner
        signal={{
          atRisk: true,
          todoCount: 21,
          inProgressCount: 3,
          inReviewCount: 2,
          idleNonEphemeralAgentCount: 0,
          threshold: 20,
          reason: "todo-exceeds-threshold-and-no-idle-agents",
        }}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /dismiss capacity warning/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
