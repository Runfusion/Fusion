import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GatedActionApprovalDetails } from "../GatedActionApprovalDetails";
import type { ApprovalRequestDetail } from "../../api";

describe("GatedActionApprovalDetails", () => {
  it("renders the tool name, command, and working directory for a bash payload", () => {
    const targetAction: ApprovalRequestDetail["targetAction"] = {
      category: "command_execution",
      action: "bash",
      summary: "Run: pnpm test",
      resourceType: "tool",
      resourceId: "bash",
      context: {
        toolName: "bash",
        toolArgs: { command: "pnpm test", cwd: "/project/.worktrees/fn-001" },
        source: "agent-gating",
        command: "pnpm test",
        cwd: "/project/.worktrees/fn-001",
      },
    };

    render(<GatedActionApprovalDetails targetAction={targetAction} />);

    expect(screen.getByTestId("gated-action-approval-details")).toBeInTheDocument();
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.getByText("/project/.worktrees/fn-001")).toBeInTheDocument();
  });

  it("renders structured arguments for an fn_* tool payload", () => {
    const targetAction: ApprovalRequestDetail["targetAction"] = {
      category: "task_agent_mutation",
      action: "fn_task_update",
      summary: "fn_task_update {id: FN-1, status: done}",
      resourceType: "tool",
      resourceId: "fn_task_update",
      context: {
        toolName: "fn_task_update",
        toolArgs: { id: "FN-1", status: "done" },
        source: "agent-gating",
      },
    };

    render(<GatedActionApprovalDetails targetAction={targetAction} />);

    expect(screen.getByText("fn_task_update")).toBeInTheDocument();
    expect(screen.getByText(/"id": "FN-1"/)).toBeInTheDocument();
    expect(screen.getByText(/"status": "done"/)).toBeInTheDocument();
  });

  it("gracefully handles missing context", () => {
    const targetAction: ApprovalRequestDetail["targetAction"] = {
      category: "command_execution",
      action: "bash",
      summary: "Agent gated action for bash",
      resourceType: "tool",
      resourceId: "bash",
    };

    render(<GatedActionApprovalDetails targetAction={targetAction} />);

    expect(screen.getByTestId("gated-action-approval-details")).toBeInTheDocument();
    expect(screen.getByText("bash")).toBeInTheDocument();
  });
});
