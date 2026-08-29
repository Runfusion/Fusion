import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowSelector } from "../WorkflowSelector";

vi.mock("lucide-react", () => ({
  Workflow: () => null,
}));

const fetchWorkflowsMock = vi.fn();
const fetchWorkflowMock = vi.fn();
vi.mock("../../api", () => ({
  fetchWorkflows: (...args: unknown[]) => fetchWorkflowsMock(...args),
  fetchWorkflow: (...args: unknown[]) => fetchWorkflowMock(...args),
  fetchProjectDefaultWorkflow: vi.fn(),
  setProjectDefaultWorkflow: vi.fn(),
}));

const mockConfirm = vi.fn();
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: mockConfirm }) }));

beforeEach(() => {
  localStorage.clear();
  mockConfirm.mockReset();
  fetchWorkflowsMock.mockReset();
  fetchWorkflowMock.mockReset();
  fetchWorkflowsMock.mockResolvedValue([
    { id: "wf-a", name: "Workflow A" },
    { id: "wf-b", name: "Workflow B" },
  ]);
  fetchWorkflowMock.mockResolvedValue({ id: "builtin:hidden", name: "Hidden built-in" });
});

describe("WorkflowSelector switch-with-active-session confirm (U9)", () => {
  it("shows the abort-warning confirm and applies the switch when confirmed", async () => {
    mockConfirm.mockResolvedValue(true);
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowSelector value="wf-a" onChange={onChange} hasActiveSession />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeDefined());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wf-b" } });
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("wf-b"));
  });

  it("does NOT apply the switch when the confirm is cancelled", async () => {
    mockConfirm.mockResolvedValue(false);
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowSelector value="wf-a" onChange={onChange} hasActiveSession />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeDefined());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wf-b" } });
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("skips the confirm when the task has no active session", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowSelector value="wf-a" onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeDefined());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wf-b" } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("wf-b"));
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("appends the current workflow when it is hidden from the filtered list", async () => {
    render(<WorkflowSelector value="builtin:hidden" onChange={vi.fn()} />);

    await waitFor(() => expect(fetchWorkflowMock).toHaveBeenCalledWith("builtin:hidden", undefined));
    expect(screen.getByRole("option", { name: "Hidden built-in" })).toBeDefined();
  });
});
