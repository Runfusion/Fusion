import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExperimentalAgentOnboardingModal } from "../ExperimentalAgentOnboardingModal";
import * as apiModule from "../../api";

let streamHandlers: any;

const { mockCancel } = vi.hoisted(() => ({
  mockCancel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../api", () => ({
  startAgentOnboardingStreaming: vi.fn().mockResolvedValue({ sessionId: "onb-1" }),
  connectAgentOnboardingStream: vi.fn().mockImplementation((_sessionId, _projectId, handlers) => {
    streamHandlers = handlers;
    setTimeout(() => handlers.onQuestion?.({ id: "q1", type: "text", question: "What should this agent primarily help with?" }), 0);
    return { close: vi.fn(), isConnected: vi.fn(() => true) };
  }),
  respondToAgentOnboarding: vi.fn().mockImplementation(() => {
    setTimeout(
      () =>
        streamHandlers?.onSummary?.({
          name: "Docs Reviewer",
          role: "reviewer",
          instructionsText: "Review docs for accuracy and clarity. Focus on sequencing, examples, and edge cases.",
          thinkingLevel: "medium",
          maxTurns: 20,
          soul: "Thorough and empathetic reviewer.",
          memory: "- Follow docs style guide\n- Call out unclear steps",
          skills: ["docs", "review"],
          templateId: "reviewer-template",
          rationale: "Matched your request to the reviewer preset",
          heartbeatProcedurePath: ".fusion/agents/docs-reviewer/HEARTBEAT.md",
          heartbeatIntervalMs: 45000,
          heartbeatEnabled: true,
          modelHint: "anthropic/claude-sonnet-4-5",
          runtimeHint: "openclaw",
        }),
      0,
    );
    return Promise.resolve({ type: "question", data: {} });
  }),
  cancelAgentOnboarding: mockCancel,
}));

const mockStartAgentOnboardingStreaming = vi.mocked(apiModule.startAgentOnboardingStreaming);

describe("ExperimentalAgentOnboardingModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("walks onboarding flow and hands draft to create form", async () => {
    const onUseDraft = vi.fn();
    render(
      <ExperimentalAgentOnboardingModal
        isOpen={true}
        onClose={vi.fn()}
        onUseDraft={onUseDraft}
        existingAgents={[]}
      />,
    );

    fireEvent.change(screen.getByLabelText("What should this new agent own?"), { target: { value: "Review docs" } });
    fireEvent.click(screen.getByText("Start onboarding"));

    await waitFor(() => {
      expect(mockStartAgentOnboardingStreaming).toHaveBeenCalledWith(
        "Review docs",
        expect.objectContaining({ mode: "create" }),
        undefined,
      );
    });

    await screen.findByText("What should this agent primarily help with?");
    fireEvent.change(screen.getByLabelText("What should this agent primarily help with?"), { target: { value: "Docs" } });
    fireEvent.click(screen.getByText("Continue"));

    await screen.findByText("Draft ready for review");
    expect(screen.getByText("Template:")).toBeTruthy();
    expect(screen.getByText("reviewer-template")).toBeTruthy();
    expect(screen.getByText(/Matched your request/)).toBeTruthy();
    expect(screen.getByText("Soul / personality")).toBeTruthy();
    expect(screen.getByText("Thorough and empathetic reviewer.")).toBeTruthy();
    expect(screen.getByText("Core instructions")).toBeTruthy();
    expect(screen.getByText(/Review docs for accuracy and clarity\./)).toBeTruthy();
    expect(screen.getByText("Heartbeat summary")).toBeTruthy();
    expect(screen.getByText(/Procedure: \.fusion\/agents\/docs-reviewer\/HEARTBEAT\.md/)).toBeTruthy();
    expect(screen.getByText(/Interval: 45000ms/)).toBeTruthy();
    expect(screen.getByText(/Enabled: yes/)).toBeTruthy();
    expect(screen.getByText("Runtime summary")).toBeTruthy();
    expect(screen.getByText(/Model hint: anthropic\/claude-sonnet-4-5/)).toBeTruthy();
    expect(screen.getByText(/Runtime hint: openclaw/)).toBeTruthy();
    expect(screen.getByText("Starter memory / playbook")).toBeTruthy();
    expect(screen.getByText(/Follow docs style guide/)).toBeTruthy();
    expect(screen.getByText("Skills")).toBeTruthy();
    expect(screen.getByText("docs, review")).toBeTruthy();
    fireEvent.click(screen.getByText("Continue to agent form"));

    await waitFor(() => {
      expect(onUseDraft).toHaveBeenCalledWith(expect.objectContaining({ name: "Docs Reviewer" }));
    });
  });

  it("uses edit mode copy and sends edit context", async () => {
    render(
      <ExperimentalAgentOnboardingModal
        isOpen={true}
        onClose={vi.fn()}
        onUseDraft={vi.fn()}
        existingAgents={[]}
        mode="edit"
        existingAgentConfig={{
          name: "Editor",
          instructionsText: "Current instructions",
          messageResponseMode: "on-heartbeat",
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("What should this agent change or improve?"), { target: { value: "Make it clearer" } });
    fireEvent.click(screen.getByText("Start interview"));

    await waitFor(() => {
      expect(mockStartAgentOnboardingStreaming).toHaveBeenCalledWith(
        "Make it clearer",
        expect.objectContaining({
          mode: "edit",
          existingAgentConfig: expect.objectContaining({ name: "Editor" }),
        }),
        undefined,
      );
    });

    await screen.findByText("What should this agent primarily help with?");
    fireEvent.change(screen.getByLabelText("What should this agent primarily help with?"), { target: { value: "Docs" } });
    fireEvent.click(screen.getByText("Continue"));

    await screen.findByText("Updated draft ready for review");
    expect(screen.getByRole("button", { name: "Apply draft to settings" })).toBeTruthy();
  });

  it("renders stream errors and still closes cleanly", async () => {
    render(
      <ExperimentalAgentOnboardingModal
        isOpen={true}
        onClose={vi.fn()}
        onUseDraft={vi.fn()}
        existingAgents={[]}
      />,
    );

    fireEvent.change(screen.getByLabelText("What should this new agent own?"), { target: { value: "Review docs" } });
    fireEvent.click(screen.getByText("Start onboarding"));

    await waitFor(() => {
      streamHandlers?.onError?.("Service unavailable");
      expect(screen.getByText("Service unavailable")).toBeTruthy();
    });
  });

  it("cancels server session on close", async () => {
    const onClose = vi.fn();
    render(
      <ExperimentalAgentOnboardingModal
        isOpen={true}
        onClose={onClose}
        onUseDraft={vi.fn()}
        existingAgents={[]}
      />,
    );

    fireEvent.change(screen.getByLabelText("What should this new agent own?"), { target: { value: "Review docs" } });
    fireEvent.click(screen.getByText("Start onboarding"));

    await screen.findByText("What should this agent primarily help with?");
    fireEvent.click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(mockCancel).toHaveBeenCalledWith("onb-1", undefined);
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("resets onboarding state when closed and reopened", async () => {
    const { rerender } = render(
      <ExperimentalAgentOnboardingModal
        isOpen={true}
        onClose={vi.fn()}
        onUseDraft={vi.fn()}
        existingAgents={[]}
      />,
    );

    fireEvent.change(screen.getByLabelText("What should this new agent own?"), { target: { value: "Review docs" } });
    fireEvent.click(screen.getByText("Start onboarding"));
    await screen.findByText("What should this agent primarily help with?");

    rerender(
      <ExperimentalAgentOnboardingModal
        isOpen={false}
        onClose={vi.fn()}
        onUseDraft={vi.fn()}
        existingAgents={[]}
      />,
    );

    rerender(
      <ExperimentalAgentOnboardingModal
        isOpen={true}
        onClose={vi.fn()}
        onUseDraft={vi.fn()}
        existingAgents={[]}
      />,
    );

    expect(screen.getByLabelText("What should this new agent own?")).toBeTruthy();
    expect(screen.queryByText("What should this agent primarily help with?")).toBeNull();
  });

  it("always closes even when session cancel request fails", async () => {
    mockCancel.mockRejectedValueOnce(new Error("cancel failed"));
    const onClose = vi.fn();

    render(
      <ExperimentalAgentOnboardingModal
        isOpen={true}
        onClose={onClose}
        onUseDraft={vi.fn()}
        existingAgents={[]}
      />,
    );

    fireEvent.change(screen.getByLabelText("What should this new agent own?"), { target: { value: "Review docs" } });
    fireEvent.click(screen.getByText("Start onboarding"));

    await screen.findByText("What should this agent primarily help with?");
    fireEvent.click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(mockCancel).toHaveBeenCalledWith("onb-1", undefined);
      expect(onClose).toHaveBeenCalled();
    });
  });
});
