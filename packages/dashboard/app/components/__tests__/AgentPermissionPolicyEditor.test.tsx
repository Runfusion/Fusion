import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentPermissionPolicyEditor } from "../AgentPermissionPolicyEditor";
import {
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  type AgentPermissionPolicy,
} from "@fusion/core";

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

  it("shows network and task mutation examples", () => {
    render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={undefined}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText("fn_research_run (web/research)")).toBeInTheDocument();
    expect(screen.getByText("fn_task_create")).toBeInTheDocument();
  });

  it("renders exempt tools guidance", () => {
    render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={undefined}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText("Tools exempt from approval policy")).toBeInTheDocument();
    expect(screen.getByText(/bypass approval policy/i)).toBeInTheDocument();
    expect(screen.getByText("fn_send_message")).toBeInTheDocument();
  });

  it("does not duplicate fn tool examples across category rows", () => {
    const { container } = render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={undefined}
        onChange={() => {}}
      />,
    );

    const rowTools = Array.from(container.querySelectorAll(".agent-policy-examples code"))
      .map((node) => node.textContent ?? "")
      .filter((name) => name.startsWith("fn_"));

    expect(new Set(rowTools).size).toBe(rowTools.length);
  });

  it("renders exactly the action-gate categories as configurable rows", () => {
    const { container } = render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={undefined}
        onChange={() => {}}
      />,
    );

    const labels = Array.from(container.querySelectorAll(".agent-policy-row .agent-policy-cell strong"))
      .map((node) => node.textContent ?? "");

    expect(labels).toEqual([
      "Git writes",
      "File writes/deletes",
      "Command execution",
      "Network/API",
      "Task/agent mutation",
    ]);
    expect(labels).toHaveLength(AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.length);
  });

  it("keeps exempt tools panel read-only", () => {
    const { container } = render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={undefined}
        onChange={() => {}}
      />,
    );

    const details = container.querySelector(".agent-policy-exempt");
    expect(details).toBeTruthy();
    expect(details?.querySelector("input, select, button")).toBeNull();
  });
});
