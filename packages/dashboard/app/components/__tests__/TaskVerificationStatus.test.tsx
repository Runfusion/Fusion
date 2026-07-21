import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskVerificationRequest } from "@fusion/core";
import { TaskVerificationStatus } from "../TaskVerificationStatus";

const base: TaskVerificationRequest = {
  taskId: "FN-8296",
  requestId: "request-1",
  profile: "verify:fast",
  command: "pnpm verify:fast",
  scope: "workspace",
  requestedBy: "chat",
  requestedAt: "2026-07-30T00:00:00.000Z",
  status: "requested",
};

describe("TaskVerificationStatus", () => {
  it("renders nothing without a request", () => {
    const { container } = render(<TaskVerificationStatus request={null} />);
    expect(container.firstChild).toBeNull();
  });

  it.each(["requested", "running", "passed", "failed", "rejected"] as const)("renders the %s lifecycle state", (status) => {
    render(<TaskVerificationStatus request={{ ...base, status, ...(status === "rejected" ? { rejectionReason: "Worktree unavailable" } : {}) }} />);
    expect(screen.getByTestId("task-verification-status")).toHaveClass(`task-verification-status--${status}`);
    expect(screen.getByText(status, { exact: true })).toBeInTheDocument();
  });
});
