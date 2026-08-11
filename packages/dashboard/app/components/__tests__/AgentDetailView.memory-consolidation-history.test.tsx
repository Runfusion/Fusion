import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  createMockAgent,
  mockFetchAgent,
  mockFetchAgentMemoryConsolidations,
  setupAgentDetailMocks,
} from "./AgentDetailView.test-helpers";
import { AgentDetailView } from "../AgentDetailView";

describe("AgentDetailView Memory Keeper consolidation history", () => {
  beforeEach(() => setupAgentDetailMocks());

  async function openMemoryTab() {
    await waitFor(() => expect(screen.getByRole("heading", { name: "Test Agent" })).toBeInTheDocument());
    fireEvent.click(screen.getByText("Agent Memory"));
  }

  it("renders the empty history for the built-in Memory Keeper", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ metadata: { builtInMemoryAgent: true } }));
    mockFetchAgentMemoryConsolidations.mockResolvedValue({ agentId: "agent-001", events: [] });
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await openMemoryTab();
    expect(await screen.findByText("No consolidation activity yet.")).toBeInTheDocument();
  });

  it("renders completed, skipped, and failed audit metadata", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ metadata: { builtInMemoryAgent: true } }));
    mockFetchAgentMemoryConsolidations.mockResolvedValue({
      agentId: "agent-001",
      events: [
        { id: "completed", timestamp: "2026-08-11T10:00:00.000Z", mutationType: "memory:consolidation-completed", runId: "run-1", metadata: { parsedFiles: 2, recallCreated: 1 } },
        { id: "skipped", timestamp: "2026-08-11T11:00:00.000Z", mutationType: "memory:consolidation-skipped", runId: "run-2", metadata: { reason: "disabled" } },
        { id: "failed", timestamp: "2026-08-11T12:00:00.000Z", mutationType: "memory:consolidation-failed", runId: "run-3", metadata: { stage: "graph" } },
      ],
    });
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await openMemoryTab();
    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/parsedFiles: 2/)).toBeInTheDocument();
    expect(screen.getByText(/reason: disabled/)).toBeInTheDocument();
    expect(screen.getByText(/stage: graph/)).toBeInTheDocument();
  });

  it("does not show the section for an unrelated agent", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ metadata: {} }));
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await openMemoryTab();
    expect(screen.queryByLabelText("Consolidation history")).not.toBeInTheDocument();
    expect(mockFetchAgentMemoryConsolidations).not.toHaveBeenCalled();
  });
});
