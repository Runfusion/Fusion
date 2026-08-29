import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "../../styles.css";
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
          review_gate_bypass: "allow",
          file_scope: "allow",
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
          review_gate_bypass: "allow",
          file_scope: "allow",
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
    expect(screen.getAllByText("fn_task_create").length).toBeGreaterThan(0);
  });

  it("renders an empty state for exact tool overrides", () => {
    render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={undefined}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText("Exact tool overrides")).toBeInTheDocument();
    expect(screen.getByTestId("agent-policy-tool-empty")).toHaveTextContent("No exact tool overrides configured.");
    expect(screen.getByTestId("agent-policy-tool-add")).toBeInTheDocument();
  });

  it("adds and replaces a fn_task_create block override", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={{ presetId: "custom", rules: {
          git_write: "allow",
          file_write_delete: "allow",
          command_execution: "allow",
          network_api: "allow",
          task_agent_mutation: "allow",
          review_gate_bypass: "allow",
          file_scope: "allow",
        } }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Tool override tool"), { target: { value: "fn_task_create" } });
    fireEvent.change(screen.getByLabelText("Tool override disposition"), { target: { value: "block" } });
    fireEvent.click(screen.getByRole("button", { name: "Add override" }));
    const blockedPayload = onChange.mock.calls.at(-1)?.[0] as AgentPermissionPolicy;
    expect(blockedPayload.toolRules).toEqual({ fn_task_create: "block" });

    rerender(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={blockedPayload}
        onChange={onChange}
      />,
    );
    expect(screen.getAllByTestId("agent-policy-tool-row")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Tool override disposition"), { target: { value: "require-approval" } });
    fireEvent.click(screen.getByRole("button", { name: "Update override" }));
    const updatedPayload = onChange.mock.calls.at(-1)?.[0] as AgentPermissionPolicy;
    expect(updatedPayload.toolRules).toEqual({ fn_task_create: "require-approval" });
  });

  it("removing the final exact tool override leaves no row shell", () => {
    const onChange = vi.fn();
    render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={{ presetId: "custom", rules: {
          git_write: "allow",
          file_write_delete: "allow",
          command_execution: "allow",
          network_api: "allow",
          task_agent_mutation: "allow",
          review_gate_bypass: "allow",
          file_scope: "allow",
        }, toolRules: { fn_task_create: "block" } }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove exact override for fn_task_create" }));
    const payload = onChange.mock.calls.at(-1)?.[0] as AgentPermissionPolicy;
    expect(payload.toolRules).toBeUndefined();
  });

  it("shows inherited project default exact tool disposition in agent override mode", () => {
    render(
      <AgentPermissionPolicyEditor
        mode="agent-override"
        value={{ presetId: "custom", rules: {
          git_write: "allow",
          file_write_delete: "allow",
          command_execution: "allow",
          network_api: "allow",
          task_agent_mutation: "allow",
          review_gate_bypass: "allow",
          file_scope: "allow",
        }, toolRules: { fn_task_create: "allow" } }}
        projectDefaultToolRules={{ fn_task_create: "block" }}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText("project default exact rule: Block")).toBeInTheDocument();
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

    const rowCategories = Array.from(container.querySelectorAll(".agent-policy-row"))
      .map((row) => row.getAttribute("data-category"))
      .filter((value): value is string => typeof value === "string");

    expect(new Set(rowCategories)).toEqual(new Set(AGENT_PERMISSION_POLICY_ACTION_CATEGORIES));
    expect(rowCategories).toHaveLength(AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.length);
  });

  // FN-7737: file_scope category row regression coverage.
  it("renders the file_scope row and emits an updated rules payload when its disposition changes", () => {
    const onChange = vi.fn();
    render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={{ presetId: "custom", rules: {
          git_write: "allow",
          file_write_delete: "allow",
          command_execution: "allow",
          network_api: "allow",
          task_agent_mutation: "allow",
          review_gate_bypass: "allow",
          file_scope: "allow",
        } }}
        onChange={onChange}
      />,
    );

    const row = screen.getByText("File Scope expansion").closest(".agent-policy-row");
    expect(row).toBeTruthy();
    expect(row).toHaveAttribute("data-category", "file_scope");

    const select = row!.querySelector("select") as HTMLSelectElement;
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: "block" } });

    const payload = onChange.mock.calls.at(-1)?.[0] as AgentPermissionPolicy;
    expect(payload.rules.file_scope).toBe("block");
    expect(payload.rules.task_agent_mutation).toBe("allow");
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

  it("applies space-xl indentation to policy bullet lists", () => {
    const { container } = render(
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={undefined}
        onChange={() => {}}
      />,
    );

    const examplesList = container.querySelector(".agent-policy-examples");
    const exemptList = container.querySelector(".agent-policy-exempt-list");
    expect(examplesList).toBeTruthy();
    expect(exemptList).toBeTruthy();

    const spaceXl = getComputedStyle(document.documentElement).getPropertyValue("--space-xl").trim();
    expect(spaceXl).not.toBe("");

    if (!examplesList || !exemptList) {
      return;
    }

    const examplesPaddingLeft = getComputedStyle(examplesList).paddingLeft;
    const exemptPaddingLeft = getComputedStyle(exemptList).paddingLeft;
    const expectedPaddingLeft = examplesPaddingLeft === "var(--space-xl)" ? "var(--space-xl)" : spaceXl;

    expect(examplesPaddingLeft).toBe(expectedPaddingLeft);
    expect(exemptPaddingLeft).toBe(expectedPaddingLeft);
  });
});
