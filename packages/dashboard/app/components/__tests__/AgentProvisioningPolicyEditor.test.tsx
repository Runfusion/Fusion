import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AGENT_PROVISIONING_APPROVAL_MODES, type ProjectSettings } from "@fusion/core";
import { AgentProvisioningPolicyEditor } from "../AgentProvisioningPolicyEditor";

describe("AgentProvisioningPolicyEditor", () => {
  const baseValue: ProjectSettings["agentProvisioning"] = {
    approvalMode: "trusted-only",
    trustedRoles: ["reviewer"],
    trustedAgentIds: ["agent-1"],
    alwaysApproveDelete: true,
  };

  it("renders all approval mode options", () => {
    render(<AgentProvisioningPolicyEditor value={baseValue} onChange={() => {}} />);

    const optionValues = screen
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);

    expect(optionValues).toEqual(AGENT_PROVISIONING_APPROVAL_MODES);
  });

  it("updates approval mode while preserving other fields", () => {
    const onChange = vi.fn();
    render(<AgentProvisioningPolicyEditor value={baseValue} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Approval mode"), { target: { value: "always" } });

    expect(onChange).toHaveBeenLastCalledWith({ ...baseValue, approvalMode: "always" });
  });

  it("tokenizes trusted roles input", () => {
    const onChange = vi.fn();
    render(<AgentProvisioningPolicyEditor value={baseValue} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Trusted roles"), { target: { value: "reviewer, ceo" } });

    expect(onChange).toHaveBeenLastCalledWith({ ...baseValue, trustedRoles: ["reviewer", "ceo"] });
  });

  it("round-trips alwaysApproveDelete", () => {
    const onChange = vi.fn();
    render(<AgentProvisioningPolicyEditor value={baseValue} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Always require approval for fn_agent_delete"));

    expect(onChange).toHaveBeenLastCalledWith({ ...baseValue, alwaysApproveDelete: false });
  });

  it("references provisioning tool names in help copy", () => {
    render(<AgentProvisioningPolicyEditor value={baseValue} onChange={() => {}} />);

    expect(screen.getByText("fn_agent_create")).toBeInTheDocument();
    expect(screen.getByText("fn_agent_delete")).toBeInTheDocument();
  });
});
