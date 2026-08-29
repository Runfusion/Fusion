import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import {
  createMockAgent,
  mockFetchAgent,
  mockFetchSettings,
  setupAgentDetailMocks,
} from "./AgentDetailView.test-helpers";
import { AgentDetailView } from "../AgentDetailView";

describe("AgentDetailView effective role model", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
  });

  it("shows a built-in merger's inherited project model", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      role: "merger" as any,
      roles: ["merger"] as any,
      metadata: { builtInWorkflowRole: true, workflowRole: "merger" },
      runtimeConfig: { enabled: false },
    }));
    mockFetchSettings.mockResolvedValue({
      defaultProviderOverride: "anthropic",
      defaultModelIdOverride: "claude-project",
    } as any);

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Dashboard" }));

    expect(await screen.findByText("anthropic/claude-project")).toBeInTheDocument();
  });

  it("keeps a complete agent model ahead of inherited settings", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      role: "merger" as any,
      roles: ["merger"] as any,
      runtimeConfig: { modelProvider: "openai", modelId: "agent-model" },
    }));
    mockFetchSettings.mockResolvedValue({
      defaultProviderOverride: "anthropic",
      defaultModelIdOverride: "claude-project",
    } as any);

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Dashboard" }));

    expect(await screen.findByText("openai/agent-model")).toBeInTheDocument();
    expect(screen.queryByText("anthropic/claude-project")).not.toBeInTheDocument();
  });
});
