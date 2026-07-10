import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NewAgentDialog } from "../NewAgentDialog";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchModels: vi.fn().mockResolvedValue({
      models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
    }),
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchPluginRuntimes: vi.fn().mockResolvedValue({ runtimes: [] }),
    createAgent: vi.fn().mockResolvedValue({ id: "agent-1" }),
  };
});

vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    thinkingLevel,
    onThinkingLevelChange,
    defaultThinkingLevel,
  }: {
    thinkingLevel?: string;
    onThinkingLevelChange?: (value: string) => void;
    defaultThinkingLevel?: string;
  }) => (
    <div data-testid="agent-model-dropdown">
      <select
        data-testid="custom-model-dropdown-thinking"
        value={thinkingLevel || ""}
        onChange={(e) => onThinkingLevelChange?.(e.target.value)}
      >
        {defaultThinkingLevel ? <option value="">Default ({defaultThinkingLevel})</option> : null}
        <option value="off">Off</option>
        <option value="minimal">Minimal</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="xhigh">Very High</option>
      </select>
    </div>
  ),
}));

vi.mock("../SkillMultiselect", () => ({
  SkillMultiselect: () => <div data-testid="skill-multiselect" />,
}));

vi.mock("../AgentGenerationModal", () => ({
  AgentGenerationModal: () => null,
}));

vi.mock("../ExperimentalAgentOnboardingModal", () => ({
  ExperimentalAgentOnboardingModal: () => null,
}));

describe("NewAgentDialog thinking level", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("uses CustomModelDropdown thinking control with concrete-only agent semantics", async () => {
    render(<NewAgentDialog isOpen onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByTestId("agent-dialog-tab-custom"));
    const thinkingSelect = await screen.findByTestId("custom-model-dropdown-thinking") as HTMLSelectElement;

    expect(Array.from(thinkingSelect.options).map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(thinkingSelect.value).toBe("off");
    expect(screen.queryByText(/Default/)).toBeNull();
    expect(screen.queryByLabelText("Thinking Level")).toBeNull();

    fireEvent.change(thinkingSelect, { target: { value: "xhigh" } });

    await waitFor(() => expect((screen.getByTestId("custom-model-dropdown-thinking") as HTMLSelectElement).value).toBe("xhigh"));
  });
});
