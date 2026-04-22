import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewAgentDialog } from "../NewAgentDialog";
import * as apiModule from "../../api";

// Mock the API module
vi.mock("../../api", () => ({
  createAgent: vi.fn(),
  fetchModels: vi.fn(),
  updateGlobalSettings: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
}));

// Mock SkillMultiselect
vi.mock("../SkillMultiselect", () => ({
  SkillMultiselect: ({ value, onChange, id }: { value: string[]; onChange: (v: string[]) => void; id?: string }) => (
    <div data-testid="skill-multiselect">
      <span data-testid="skill-multiselect-value">{JSON.stringify(value)}</span>
      <button data-testid="add-skill-1" onClick={() => onChange([...value, "skill-1"])}>Add Skill 1</button>
      <button data-testid="add-skill-2" onClick={() => onChange([...value, "skill-2"])}>Add Skill 2</button>
      <button data-testid="remove-skill-1" onClick={() => onChange(value.filter(s => s !== "skill-1"))}>Remove Skill 1</button>
    </div>
  ),
}));

// Mock AgentGenerationModal
vi.mock("../AgentGenerationModal", () => ({
  AgentGenerationModal: ({ isOpen, onClose, onGenerated }: { isOpen: boolean; onClose: () => void; onGenerated: (spec: any) => void }) => {
    if (!isOpen) return null;
    return (
      <div data-testid="agent-generation-modal">
        <span data-testid="generation-modal-open">Modal Open</span>
        <button
          data-testid="generation-modal-close"
          onClick={onClose}
        >
          Close Modal
        </button>
        <button
          data-testid="generation-modal-apply"
          onClick={() =>
            onGenerated({
              title: "Generated Agent",
              icon: "🤖",
              role: "reviewer",
              description: "Generated description for testing",
              systemPrompt: "# System prompt\nYou are a helpful agent.",
              thinkingLevel: "medium",
              maxTurns: 25,
            })
          }
        >
          Apply Generated Spec
        </button>
        <button
          data-testid="generation-modal-apply-custom-role"
          onClick={() =>
            onGenerated({
              title: "Custom Role Agent",
              icon: "🔧",
              role: "security-auditor",
              description: "Custom role not in AgentCapability",
              systemPrompt: "# Security auditor prompt",
              thinkingLevel: "high",
              maxTurns: 50,
            })
          }
        >
          Apply Custom Role Spec
        </button>
      </div>
    );
  },
}));

const mockCreateAgent = vi.mocked(apiModule.createAgent);
const mockFetchModels = vi.mocked(apiModule.fetchModels);
const mockUpdateGlobalSettings = vi.mocked(apiModule.updateGlobalSettings);
const mockFetchDiscoveredSkills = vi.mocked(apiModule.fetchDiscoveredSkills);

const MOCK_MODELS_RESPONSE = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ],
  favoriteProviders: ["anthropic"],
  favoriteModels: ["anthropic/claude-sonnet-4-5"],
};

const MOCK_SKILLS_RESPONSE = [
  { id: "skill-1", name: "Skill One", path: "/path/skill-1", relativePath: "skills/skill-1", enabled: true, metadata: { source: "*", scope: "user" as const, origin: "top-level" as const } },
  { id: "skill-2", name: "Skill Two", path: "/path/skill-2", relativePath: "skills/skill-2", enabled: true, metadata: { source: "*", scope: "user" as const, origin: "top-level" as const } },
];

async function openModelDropdown(label = "Model") {
  fireEvent.click(screen.getByRole("button", { name: label }));

  await waitFor(() => {
    expect(document.body.querySelector('[data-testid="model-combobox-portal"]')).not.toBeNull();
  });

  return document.body.querySelector('[data-testid="model-combobox-portal"]') as HTMLElement;
}

function clickModelOption(portal: HTMLElement, optionText: RegExp) {
  const option = within(portal)
    .getAllByRole("option")
    .find((candidate) => optionText.test(candidate.textContent ?? ""));
  expect(option).toBeTruthy();
  fireEvent.click(option!);
}

describe("NewAgentDialog", () => {
  const mockOnClose = vi.fn();
  const mockOnCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchModels.mockResolvedValue(MOCK_MODELS_RESPONSE);
    mockCreateAgent.mockResolvedValue({} as any);
    mockUpdateGlobalSettings.mockResolvedValue({});
    mockFetchDiscoveredSkills.mockResolvedValue(MOCK_SKILLS_RESPONSE);
  });

  describe("modal visibility", () => {
    it("renders nothing when isOpen is false", () => {
      const { container } = render(
        <NewAgentDialog isOpen={false} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );
      expect(container.innerHTML).toBe("");
    });

    it("renders the dialog when isOpen is true", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });
      expect(screen.getByRole("dialog", { name: "Create new agent" })).toBeTruthy();
    });
  });

  describe("model dropdown", () => {
    it("fetches models on mount", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });
      expect(mockFetchModels).toHaveBeenCalledOnce();
    });

    it("shows loading state then model dropdown on step 1", async () => {
      // Create a slow promise to see loading state
      let resolveModels: (v: any) => void;
      mockFetchModels.mockReturnValue(new Promise(r => { resolveModels = r; }));

      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      // Navigate to step 1 (model config step) by filling name and clicking Next
      const nameInput = screen.getByLabelText(/Name/);
      await fireEvent.change(nameInput, { target: { value: "Test Agent" } });
      await fireEvent.click(screen.getByText("Next"));

      // Should show loading
      expect(screen.getByText("Loading models…")).toBeTruthy();

      // Resolve models
      resolveModels!(MOCK_MODELS_RESPONSE);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
      });
    });

    it("shows model dropdown on step 1 after models load", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      // Wait for models to load
      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalledOnce();
      });

      // Navigate to step 1
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      const modelTrigger = screen.getByRole("button", { name: "Model" });
      expect(modelTrigger).toBeTruthy();
      expect(modelTrigger.textContent).toContain("Use default");
    });

    it("selecting a model from dropdown updates state", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      // Wait for models to load
      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalledOnce();
      });

      // Navigate to step 1
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Claude Sonnet 4.5");
    });

    it("deselecting model sets value back to default", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // Select a model
      const selectPortal = await openModelDropdown();
      clickModelOption(selectPortal, /Claude Sonnet 4.5/i);
      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Claude Sonnet 4.5");

      // Deselect (use default)
      const defaultPortal = await openModelDropdown();
      fireEvent.click(within(defaultPortal).getByRole("option", { name: "Use default" }));
      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Use default");
    });
  });

  describe("summary display", () => {
    it("shows 'default' in summary when no model selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 2
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));

      // Summary should show "default" for model
      const modelRow = screen.getByText("Model").closest(".agent-dialog-summary-row");
      expect(modelRow).toBeTruthy();
      expect(modelRow!.querySelector("em")?.textContent).toBe("default");
    });

    it("shows model name and provider icon in summary when model selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // Select a model
      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      // Navigate to step 2
      await user.click(screen.getByText("Next"));

      // Summary should show model name
      expect(screen.getByTestId("anthropic-icon")).toBeTruthy();
      expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
    });
  });

  describe("agent creation", () => {
    it("creates agent with selected model", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Step 0: Fill name
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");

      // Step 1: Navigate and select model
      await user.click(screen.getByText("Next"));
      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      // Step 2: Navigate to summary and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("Test Agent");
      expect(createCall.runtimeConfig).toEqual({
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("creates agent without model when default selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Step 0: Fill name
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");

      // Step 1: Leave model as default
      await user.click(screen.getByText("Next"));

      // Step 2: Navigate and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("Test Agent");
      // No runtimeConfig when all values are defaults
      expect(createCall.runtimeConfig).toBeUndefined();
    });

    it("creates agent with model and thinking level", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Step 0: Fill name
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Thinking Agent");

      // Step 1: Select model and thinking level
      await user.click(screen.getByText("Next"));
      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      const thinkingSelect = screen.getByLabelText(/Thinking Level/);
      await user.selectOptions(thinkingSelect, "high");

      // Step 2: Create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.runtimeConfig).toEqual({
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "high",
      });
    });
  });

  describe("error handling", () => {
    it("handles fetchModels failure gracefully", async () => {
      mockFetchModels.mockRejectedValue(new Error("Network error"));

      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1 — should still show the dropdown (empty models)
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // Dropdown should still render (just with empty models)
      expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
    });
  });

  describe("close and reset", () => {
    it("resets state on close", async () => {
      const user = userEvent.setup();
      const { unmount } = render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Fill in name
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Agent Name");

      // Navigate to step 1 and select model
      await user.click(screen.getByText("Next"));
      const portal = await openModelDropdown();
      clickModelOption(portal, /Claude Sonnet 4.5/i);

      // Close the dialog
      await user.click(screen.getByLabelText("Close"));

      expect(mockOnClose).toHaveBeenCalled();

      // Unmount and reopen - state should be reset; wait for the second fetchModels useEffect to settle
      unmount();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledTimes(2));

      // Name should be empty
      const newNameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
      expect(newNameInput.value).toBe("");
    });
  });

  describe("AI generation integration", () => {
    it("shows Generate with AI button in step 0", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });
      expect(screen.getByText("Generate with AI")).toBeTruthy();
    });

    it("opens AgentGenerationModal when Generate with AI is clicked", async () => {
      const user = userEvent.setup();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      // Generation modal should not be open initially
      expect(screen.queryByTestId("agent-generation-modal")).toBeNull();

      // Click the Generate with AI button
      await user.click(screen.getByText("Generate with AI"));

      // Generation modal should now be open
      expect(screen.getByTestId("agent-generation-modal")).toBeTruthy();
    });

    it("populates form fields and advances to step 1 when spec is applied", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Open generation modal and apply spec
      await user.click(screen.getByText("Generate with AI"));
      await user.click(screen.getByTestId("generation-modal-apply"));

      // Should advance to step 1 (model config)
      expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();

      // Navigate to step 2 to verify the summary
      await user.click(screen.getByText("Next"));

      // Verify name was populated from spec.title
      const summaryText = screen.getByText("Generated Agent");
      expect(summaryText).toBeTruthy();

      // Verify icon is shown
      expect(screen.getByText("🤖")).toBeTruthy();
    });

    it("maps known role to AgentCapability", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Open generation modal and apply spec with role "reviewer"
      await user.click(screen.getByText("Generate with AI"));
      await user.click(screen.getByTestId("generation-modal-apply"));

      // After generation, we're on Step 1 — navigate to summary (step 2)
      await user.click(screen.getByText("Next"));

      // Role should be mapped correctly to "Reviewer"
      const roleRow = screen.getByText("Role").closest(".agent-dialog-summary-row");
      expect(roleRow?.textContent).toContain("Reviewer");
    });

    it("maps unknown role to custom", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Open generation modal and apply spec with unknown role "security-auditor"
      await user.click(screen.getByText("Generate with AI"));
      await user.click(screen.getByTestId("generation-modal-apply-custom-role"));

      // After generation, we're on Step 1 — navigate to summary (step 2)
      await user.click(screen.getByText("Next"));

      // Role should default to "Custom"
      const roleRow = screen.getByText("Role").closest(".agent-dialog-summary-row");
      expect(roleRow?.textContent).toContain("Custom");
    });

    it("applies runtime config from generated spec", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Open generation modal and apply spec
      await user.click(screen.getByText("Generate with AI"));
      await user.click(screen.getByTestId("generation-modal-apply"));

      // Step 1: verify thinking level and max turns were applied
      const thinkingSelect = screen.getByLabelText(/Thinking Level/) as HTMLSelectElement;
      expect(thinkingSelect.value).toBe("medium");

      const maxTurnsInput = screen.getByLabelText(/Max Turns/) as HTMLInputElement;
      expect(maxTurnsInput.value).toBe("25");
    });

    it("closes generation modal without affecting form on cancel", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      // Fill in a name first
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Manual Name");

      // Open generation modal
      await user.click(screen.getByText("Generate with AI"));
      expect(screen.getByTestId("agent-generation-modal")).toBeTruthy();

      // Close the generation modal without applying
      await user.click(screen.getByTestId("generation-modal-close"));

      // Should still be on step 0 with original name
      const nameAfter = screen.getByLabelText(/Name/) as HTMLInputElement;
      expect(nameAfter.value).toBe("Manual Name");
      expect(screen.queryByTestId("agent-generation-modal")).toBeNull();
    });

    it("creates agent with icon from generated spec", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Open generation modal and apply spec
      await user.click(screen.getByText("Generate with AI"));
      await user.click(screen.getByTestId("generation-modal-apply"));

      // After generation, we're on Step 1 — navigate to summary (step 2) and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("Generated Agent");
      expect(createCall.icon).toBe("🤖");
      expect(createCall.title).toBe("Generated description for testing");
      expect(createCall.role).toBe("reviewer");
      expect(createCall.runtimeConfig).toEqual({
        thinkingLevel: "medium",
        maxTurns: 25,
      });
    });
  });

  describe("preset selection", () => {
    it("renders all 20 preset cards in step 0", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });
      const presetCards = screen.getAllByTestId(/^preset-/);
      expect(presetCards).toHaveLength(20);
    });

    it("shows the quick start header text", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });
      expect(screen.getByText("Choose a preset or fill in details manually")).toBeTruthy();
    });

    it("clicking a preset populates name, title, icon, and role", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the "Engineer" preset
      await user.click(screen.getByTestId("preset-engineer"));

      // Should advance to step 1 (model config), go back to verify fields
      await user.click(screen.getByText("Back"));

      // Verify form fields were populated
      const nameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
      expect(nameInput.value).toBe("Engineer");

      const titleInput = screen.getByLabelText(/Title/) as HTMLInputElement;
      // Title should be set to the preset's description (not the professional title)
      expect(titleInput.value).toBe("Implements features, fixes bugs, and writes well-tested code across the full application stack.");

      // Verify role was set to engineer
      const roleGrid = document.querySelector(".agent-role-grid");
      const engineerRoleButton = roleGrid?.querySelector(".agent-role-option.selected");
      expect(engineerRoleButton?.textContent).toContain("Engineer");
    });

    it("clicking a preset advances directly to step 1", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the "CTO" preset
      await user.click(screen.getByTestId("preset-cto"));

      // Should be on step 1 — model dropdown visible
      expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
    });

    it("selected preset card has .selected CSS class", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the "CEO" preset
      await user.click(screen.getByTestId("preset-ceo"));

      // Go back to step 0 to verify visual feedback
      await user.click(screen.getByText("Back"));

      const ceoCard = screen.getByTestId("preset-ceo");
      expect(ceoCard.classList.contains("selected")).toBe(true);
    });

    it("clicking a different preset updates the selection", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click CEO preset
      await user.click(screen.getByTestId("preset-ceo"));
      await user.click(screen.getByText("Back"));

      // Click CTO preset
      await user.click(screen.getByTestId("preset-cto"));
      await user.click(screen.getByText("Back"));

      // Only CTO should be selected
      expect(screen.getByTestId("preset-cto").classList.contains("selected")).toBe(true);
      expect(screen.getByTestId("preset-ceo").classList.contains("selected")).toBe(false);

      // Name should be updated
      const nameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
      expect(nameInput.value).toBe("CTO");
    });

    it("user can override preset values with manual entry after selection", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset
      await user.click(screen.getByTestId("preset-engineer"));
      await user.click(screen.getByText("Back"));

      // Override the name manually
      const nameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
      await user.clear(nameInput);
      await user.type(nameInput, "My Custom Engineer");

      expect(nameInput.value).toBe("My Custom Engineer");
    });

    it("dialog reset clears preset selection", async () => {
      const user = userEvent.setup();
      const { unmount } = render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset
      await user.click(screen.getByTestId("preset-ceo"));

      // Close the dialog
      await user.click(screen.getByLabelText("Close"));
      expect(mockOnClose).toHaveBeenCalled();

      // Re-open — state should be reset; wait for the second fetchModels useEffect to settle
      unmount();
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledTimes(2));

      // Name should be empty (no preset selected)
      const nameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
      expect(nameInput.value).toBe("");

      // No preset cards should be selected
      const selectedCards = document.querySelectorAll(".agent-preset-card.selected");
      expect(selectedCards).toHaveLength(0);
    });

    it("creates agent with preset fields through the full flow", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the "Reviewer" preset (advances to step 1)
      await user.click(screen.getByTestId("preset-reviewer"));

      // Step 1: navigate to summary
      await user.click(screen.getByText("Next"));

      // Step 2: verify summary and create
      // Verify name
      expect(screen.getByText("Reviewer")).toBeTruthy();
      // Verify icon
      expect(screen.getByText("⊙")).toBeTruthy();

      // Create
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("Reviewer");
      expect(createCall.icon).toBe("⊙");
      // Title should be the preset's description
      expect(createCall.title).toBe("Reviews code changes for correctness, security, performance, and adherence to project coding standards.");
      expect(createCall.role).toBe("reviewer");
      // Soul should be populated from preset
      expect(createCall.soul).toBeTruthy();
      expect(typeof createCall.soul).toBe("string");
      // instructionsText should be populated from preset
      expect(createCall.instructionsText).toBeTruthy();
      expect(typeof createCall.instructionsText).toBe("string");
    });

    it("preset card titles show the professional title", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      const ceoCard = screen.getByTestId("preset-ceo");
      expect(ceoCard.getAttribute("title")).toBe("Chief Executive Officer");

      const ctoCard = screen.getByTestId("preset-cto");
      expect(ctoCard.getAttribute("title")).toBe("Chief Technology Officer");
    });

    it("renders descriptions in all 20 preset cards", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      // Every preset should have a description element rendered
      const descriptionElements = screen.getAllByText(/.\./, {
        selector: ".agent-preset-description",
      });
      expect(descriptionElements).toHaveLength(20);

      // Verify each description is non-empty
      descriptionElements.forEach((el) => {
        expect(el.textContent?.length).toBeGreaterThan(10);
      });
    });

    it("all presets have non-empty description strings", async () => {
      // Import the array directly by checking the rendered cards
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      const presetIds = [
        "ceo", "cto", "cmo", "cfo", "engineer", "backend-engineer",
        "frontend-engineer", "fullstack-engineer", "qa-engineer",
        "devops-engineer", "ci-engineer", "security-engineer",
        "data-engineer", "ml-engineer", "product-manager", "designer",
        "marketing-manager", "technical-writer", "triage", "reviewer",
      ];

      presetIds.forEach((id) => {
        const card = screen.getByTestId(`preset-${id}`);
        const desc = card.querySelector(".agent-preset-description");
        expect(desc).toBeTruthy();
        expect((desc as HTMLElement).textContent?.length).toBeGreaterThan(0);
      });
    });

    it("selecting a preset sets title to the description value", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the CEO preset
      await user.click(screen.getByTestId("preset-ceo"));

      // Go back to verify the title field
      await user.click(screen.getByText("Back"));

      const titleInput = screen.getByLabelText(/Title/) as HTMLInputElement;
      expect(titleInput.value).toBe("Oversees project strategy, sets priorities, and coordinates between departments to ensure alignment with business goals.");
    });

    it("name label shows required indicator when no preset is selected", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      // On initial render (step 0, no preset), the * required indicator should be visible
      const nameLabel = screen.getByText("Name", { selector: "label" });
      const requiredSpan = nameLabel.querySelector(".agent-dialog-required");
      expect(requiredSpan).toBeTruthy();
      expect(requiredSpan?.textContent).toBe("*");
    });

    it("name label does not show required indicator when preset is selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset
      await user.click(screen.getByTestId("preset-engineer"));

      // Preset advances to step 1, go back to step 0
      await user.click(screen.getByText("Back"));

      // The * required indicator should NOT be visible when a preset is selected
      const nameLabel = screen.getByText("Name", { selector: "label" });
      const requiredSpan = nameLabel.querySelector(".agent-dialog-required");
      expect(requiredSpan).toBeNull();
    });

    it("Next button is enabled when preset is selected even if name is empty", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset (this fills the name and advances to step 1)
      await user.click(screen.getByTestId("preset-ceo"));

      // Go back to step 0
      await user.click(screen.getByText("Back"));

      // Clear the name field
      const nameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
      await user.clear(nameInput);
      expect(nameInput.value).toBe("");

      // Next button should still be enabled because a preset was selected
      expect(screen.getByText("Next")).not.toBeDisabled();
    });

    it("Next button is disabled when no preset is selected and name is empty", async () => {
      await act(async () => {
        render(
          <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
        );
      });

      // On initial render (step 0, no preset, empty name), Next should be disabled
      expect(screen.getByText("Next")).toBeDisabled();
    });

    it("selecting a preset sets soul and instructionsText in the create agent call", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the QA Engineer preset
      await user.click(screen.getByTestId("preset-qa-engineer"));

      // Navigate to summary and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("QA Engineer");
      // Soul should be the QA Engineer preset soul
      expect(createCall.soul).toContain("thorough and methodical QA engineer");
      // instructionsText should contain QA-specific instructions
      expect(createCall.instructionsText).toContain("full test suite");
      expect(createCall.instructionsText).toContain("regression tests");
    });

    it("selecting a preset then overriding instructions manually uses the manual value", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset (advances to step 1)
      await user.click(screen.getByTestId("preset-engineer"));

      // Go back to step 0 to override instructions
      await user.click(screen.getByText("Back"));

      // Override the instructionsText manually
      const instructionsTextarea = screen.getByLabelText(/Inline Instructions/) as HTMLTextAreaElement;
      await user.clear(instructionsTextarea);
      await user.type(instructionsTextarea, "My custom instructions");

      // Navigate through and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      // The manually entered instructions should be used, not the preset's
      expect(createCall.instructionsText).toBe("My custom instructions");
      // Soul should still be from the preset
      expect(createCall.soul).toContain("reliable and versatile engineer");
    });

    it("clicking a preset populates soul and instructionsText fields", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Click the CTO preset
      await user.click(screen.getByTestId("preset-cto"));

      // Go back to step 0 to verify fields
      await user.click(screen.getByText("Back"));

      // Verify soul was populated
      const soulTextarea = screen.getByLabelText(/Soul/) as HTMLTextAreaElement;
      expect(soulTextarea.value).toContain("pragmatic technologist");

      // Verify instructionsText was populated
      const instructionsTextarea = screen.getByLabelText(/Inline Instructions/) as HTMLTextAreaElement;
      expect(instructionsTextarea.value).toContain("Evaluate technology choices");
    });

    it("selecting a different preset updates soul and instructionsText", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select CEO preset
      await user.click(screen.getByTestId("preset-ceo"));
      await user.click(screen.getByText("Back"));

      // Verify CEO soul is set
      let soulTextarea = screen.getByLabelText(/Soul/) as HTMLTextAreaElement;
      expect(soulTextarea.value).toContain("strategic leader");

      // Select a different preset (DevOps Engineer)
      await user.click(screen.getByTestId("preset-devops-engineer"));
      await user.click(screen.getByText("Back"));

      // Verify soul updated to DevOps
      soulTextarea = screen.getByLabelText(/Soul/) as HTMLTextAreaElement;
      expect(soulTextarea.value).toContain("infrastructure-minded engineer");

      // Verify instructions updated
      const instructionsTextarea = screen.getByLabelText(/Inline Instructions/) as HTMLTextAreaElement;
      expect(instructionsTextarea.value).toContain("rollback plan");
    });

    it("dialog reset clears soul and instructionsText from preset", async () => {
      const user = userEvent.setup();
      const { unmount } = render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Select a preset
      await user.click(screen.getByTestId("preset-cto"));

      // Close the dialog — wait for the state updates to flush before unmounting
      await user.click(screen.getByLabelText("Close"));
      expect(mockOnClose).toHaveBeenCalled();

      // Re-open — wait for the fetchModels useEffect to settle after remount
      unmount();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledTimes(2));

      // Soul and instructionsText should be empty
      const soulTextarea = screen.getByLabelText(/Soul/) as HTMLTextAreaElement;
      expect(soulTextarea.value).toBe("");

      const instructionsTextarea = screen.getByLabelText(/Inline Instructions/) as HTMLTextAreaElement;
      expect(instructionsTextarea.value).toBe("");
    });
  });

  describe("model favorites persistence", () => {
    it("persists provider favorite toggle via updateGlobalSettings", async () => {
      mockFetchModels.mockResolvedValue({
        models: MOCK_MODELS_RESPONSE.models,
        favoriteProviders: ["anthropic"],
        favoriteModels: [],
      });

      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      const user = userEvent.setup();
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      const portal = await openModelDropdown();
      fireEvent.click(within(portal).getByRole("button", { name: "Remove anthropic from favorites" }));

      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({
        favoriteProviders: [],
        favoriteModels: expect.any(Array),
      });
    });

    it("rolls back local favorite state when updateGlobalSettings fails", async () => {
      // Provider rollback should use provider favorites only; if all models are favorited,
      // provider rows may be hidden in the dropdown.
      mockFetchModels.mockResolvedValue({
        models: MOCK_MODELS_RESPONSE.models,
        favoriteProviders: ["anthropic"],
        favoriteModels: [],
      });
      mockUpdateGlobalSettings.mockRejectedValueOnce(new Error("Network error"));

      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalledOnce();
      });

      const user = userEvent.setup();
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      const portal = await openModelDropdown();
      const removeButton = within(portal).getByRole("button", { name: "Remove anthropic from favorites" });
      fireEvent.click(removeButton);

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalled();
      });

      const portalAfterRollback = document.body.querySelector('[data-testid="model-combobox-portal"]') as HTMLElement;
      expect(within(portalAfterRollback).getByRole("button", { name: "Remove anthropic from favorites" })).toBeTruthy();
    });
  });

  describe("skill selection", () => {
    it("renders SkillMultiselect in Step 1", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // SkillMultiselect should be visible in step 1
      expect(screen.getByTestId("skill-multiselect")).toBeTruthy();
    });

    it("shows selected skills in summary on step 2", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1 and add a skill
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // Add a skill using the mocked button
      await user.click(screen.getByTestId("add-skill-1"));

      // Navigate to step 2
      await user.click(screen.getByText("Next"));

      // Summary should show skill count
      expect(screen.getByText(/1 skill/)).toBeTruthy();
    });

    it("includes metadata.skills in createAgent call when skills are selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate to step 1
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));

      // Add skills
      await user.click(screen.getByTestId("add-skill-1"));
      await user.click(screen.getByTestId("add-skill-2"));

      // Navigate to step 2 and create
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.metadata).toEqual({ skills: ["skill-1", "skill-2"] });
    });

    it("does not include metadata when no skills are selected", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledOnce());

      // Navigate through steps without adding skills
      const nameInput = screen.getByLabelText(/Name/);
      await user.type(nameInput, "Test Agent");
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Next"));
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.metadata).toBeUndefined();
    });
  });
});
