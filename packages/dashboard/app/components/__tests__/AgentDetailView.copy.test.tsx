import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  mockFetchAgent,
  setupAgentDetailMocks,
} from "./AgentDetailView.test-helpers";
import { AgentDetailView } from "../AgentDetailView";

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function mockClipboardFallback(result: boolean) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const execCommand = vi.fn().mockReturnValue(result);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  return execCommand;
}

describe("AgentDetailView clipboard copy", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
    Object.defineProperty(document, "execCommand", { configurable: true, value: originalExecCommand });
  });

  it("copies the agent id through execCommand when Clipboard API is unavailable", async () => {
    const execCommand = mockClipboardFallback(true);
    const addToast = vi.fn();

    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={addToast} />);
    await waitFor(() => expect(mockFetchAgent).toHaveBeenCalled());

    await userEvent.click(screen.getByTitle("Copy Agent ID"));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(addToast).toHaveBeenCalledWith("Agent ID copied to clipboard", "success");
  });

  it("shows the failure toast instead of false success when both clipboard paths fail", async () => {
    const execCommand = mockClipboardFallback(false);
    const addToast = vi.fn();

    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={addToast} />);
    await waitFor(() => expect(mockFetchAgent).toHaveBeenCalled());

    await userEvent.click(screen.getByTitle("Copy Agent ID"));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(addToast).toHaveBeenCalledWith("Failed to copy agent ID", "error");
    expect(addToast).not.toHaveBeenCalledWith("Agent ID copied to clipboard", "success");
  });
});
