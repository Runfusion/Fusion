import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentPermissionPolicyEditor } from "../AgentPermissionPolicyEditor";
import type { AgentPermissionPolicy } from "@fusion/core";

describe("AgentPermissionPolicyEditor", () => {
  it("preset dropdown switches all rules", () => {
    const onChange = vi.fn();
    render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={{ presetId: "unrestricted", rules: {
          git_write: "allow",
          file_write_delete: "allow",
          command_execution: "allow",
          network_api: "allow",
          task_agent_mutation: "allow",
        } }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "locked-down" } });
    const payload = onChange.mock.calls.at(-1)?.[0] as AgentPermissionPolicy;
    expect(payload.presetId).toBe("locked-down");
    expect(payload.rules.git_write).toBe("block");
  });

  it("changing one category flips to custom", () => {
    const onChange = vi.fn();
    render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={undefined}
        onChange={onChange}
      />,
    );

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[1], { target: { value: "require-approval" } });
    const payload = onChange.mock.calls.at(-1)?.[0] as AgentPermissionPolicy;
    expect(payload.presetId).toBe("custom");
  });

  it("agent override inherit preset emits undefined", () => {
    const onChange = vi.fn();
    render(
      <AgentPermissionPolicyEditor
        mode="agent-override"
        value={{ presetId: "custom", rules: {
          git_write: "allow",
          file_write_delete: "allow",
          command_execution: "allow",
          network_api: "allow",
          task_agent_mutation: "allow",
        } }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "inherit" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("shows inherit annotation from project default", () => {
    render(
      <AgentPermissionPolicyEditor
        mode="agent-override"
        value={undefined}
        projectDefault={{ git_write: "require-approval" }}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText("from project default: Require approval")).toBeInTheDocument();
  });
});
