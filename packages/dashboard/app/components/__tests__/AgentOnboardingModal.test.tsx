import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { AgentOnboardingModal } from "../AgentOnboardingModal";
import { createAgent } from "../../api";

let streamHandlers: any;
let respondCount = 0;
const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");

vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, onChange, label, id, models, thinkingLevel, onThinkingLevelChange }: any) => (
    <div data-testid="custom-model-dropdown" data-default-thinking-level="">
      <label htmlFor={id}>{label}</label>
      <select id={id} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Use default</option>
        {models.map((model: any) => {
          const modelValue = `${model.provider}/${model.id}`;
          return <option key={modelValue} value={modelValue}>{modelValue}</option>;
        })}
      </select>
      {onThinkingLevelChange ? (
        <select aria-label={`${label} thinking level`} value={thinkingLevel ?? ""} onChange={(event) => onThinkingLevelChange(event.target.value)}>
          {["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      ) : null}
    </div>
  ),
}));

vi.mock("../../api", () => ({
  startAgentOnboardingStreaming: vi.fn().mockResolvedValue({ sessionId: "onb-1" }),
  fetchModels: vi.fn().mockResolvedValue({ models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }], favoriteProviders: [], favoriteModels: [] }),
  connectAgentOnboardingStream: vi.fn().mockImplementation((_sessionId, _projectId, handlers) => {
    streamHandlers = handlers;
    setTimeout(() => handlers.onQuestion?.({ id: "q1", type: "text", question: "What should this agent primarily help with?" }), 0);
    return { close: vi.fn(), isConnected: vi.fn(() => true) };
  }),
  respondToAgentOnboarding: vi.fn().mockImplementation(() => {
    respondCount += 1;
    if (respondCount === 1) {
      setTimeout(() => streamHandlers?.onQuestion?.({ id: "q2", type: "text", question: "Second question" }), 0);
    } else {
      setTimeout(() => streamHandlers?.onSummary?.({
        name: "Docs Reviewer",
        role: "reviewer",
        instructionsText: "Review docs",
        thinkingLevel: "medium",
        maxTurns: 20,
      }), 0);
    }
    return Promise.resolve({ type: "question", data: {} });
  }),
  retryAgentOnboardingSession: vi.fn().mockResolvedValue({ success: true }),
  stopAgentOnboardingGeneration: vi.fn().mockResolvedValue({ success: true }),
  cancelAgentOnboarding: vi.fn().mockResolvedValue(undefined),
  createAgent: vi.fn().mockResolvedValue({ id: "agent-1" }),
}));

afterEach(() => {
  respondCount = 0;
  streamHandlers = undefined;
  vi.mocked(createAgent).mockClear();
  if (originalScrollHeightDescriptor) {
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", originalScrollHeightDescriptor);
  } else {
    Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
  }
});

describe("AgentOnboardingModal", () => {
  it("walks onboarding flow through summary and create", async () => {
    const onCreated = vi.fn();
    render(
      <AgentOnboardingModal
        isOpen={true}
        onClose={vi.fn()}
        onCreated={onCreated}
        addToast={vi.fn()}
        existingAgents={[]}
      />,
    );

    fireEvent.change(screen.getByLabelText("What do you want this agent to do?"), { target: { value: "Review docs" } });
    fireEvent.click(screen.getByText("Start onboarding"));

    await screen.findByText("What should this agent primarily help with?");
    fireEvent.change(screen.getByLabelText("What should this agent primarily help with?"), { target: { value: "Docs" } });
    fireEvent.click(screen.getByText("Continue"));

    await screen.findByText("Second question");
    fireEvent.change(screen.getByLabelText("Second question"), { target: { value: "More docs" } });
    fireEvent.click(screen.getByText("Continue"));

    await screen.findByText("Review generated configuration");
    expect(screen.queryByLabelText("Thinking level")).not.toBeInTheDocument();
    const thinkingSelect = screen.getByLabelText("Model thinking level");
    expect(thinkingSelect).toHaveValue("medium");
    fireEvent.change(thinkingSelect, { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "openai/gpt-4o" } });
    fireEvent.click(screen.getByText("Create agent"));

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({
            thinkingLevel: "high",
            model: "openai/gpt-4o",
          }),
        }),
        undefined,
      );
    });

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
  });

  describe("autosize", () => {
    it("grows the intent textarea up to the 640px cap", async () => {
      Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
        configurable: true,
        get() {
          const value = (this as HTMLTextAreaElement).value;
          if (!value) return 24;
          if (value.includes("cap")) return 800;
          return 200;
        },
      });

      render(
        <AgentOnboardingModal
          isOpen={true}
          onClose={vi.fn()}
          onCreated={vi.fn()}
          addToast={vi.fn()}
          existingAgents={[]}
        />,
      );

      const textarea = screen.getByLabelText("What do you want this agent to do?") as HTMLTextAreaElement;

      await userEvent.type(textarea, "Draft onboarding intent");
      await waitFor(() => {
        expect(textarea.style.height).toBe("200px");
      });

      await userEvent.type(textarea, " cap");
      await waitFor(() => {
        expect(textarea.style.height).toBe("640px");
      });
    });
  });
});
