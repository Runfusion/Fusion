import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewAgentDialog } from "../NewAgentDialog";
import * as apiModule from "../../api";

// Mock the API module
vi.mock("../../api", () => ({
  createAgent: vi.fn(),
  fetchModels: vi.fn(),
}));

// Mock CustomModelDropdown to simplify interaction testing
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) => (
    <div data-testid="custom-model-dropdown">
      <span data-testid="dropdown-label">{label}</span>
      <span data-testid="dropdown-value">{value}</span>
      <button
        data-testid="dropdown-select-anthropic"
        onClick={() => onChange("anthropic/claude-sonnet-4-5")}
      >
        Select Claude
      </button>
      <button
        data-testid="dropdown-select-default"
        onClick={() => onChange("")}
      >
        Use default
      </button>
    </div>
  ),
}));

// Mock ProviderIcon
vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => (
    <span data-testid={`provider-icon-${provider}`} />
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

const MOCK_MODELS_RESPONSE = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ],
  favoriteProviders: ["anthropic"],
  favoriteModels: ["anthropic/claude-sonnet-4-5"],
};

describe("NewAgentDialog", () => {
  const mockOnClose = vi.fn();
  const mockOnCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchModels.mockResolvedValue(MOCK_MODELS_RESPONSE);
    mockCreateAgent.mockResolvedValue({} as any);
  });

  describe("modal visibility", () => {
    it("renders nothing when isOpen is false", () => {
      const { container } = render(
        <NewAgentDialog isOpen={false} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );
      expect(container.innerHTML).toBe("");
    });

    it("renders the dialog when isOpen is true", () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );
      expect(screen.getByRole("dialog", { name: "Create new agent" })).toBeTruthy();
    });
  });

  describe("model dropdown", () => {
    it("fetches models on mount", () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );
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
        expect(screen.getByTestId("custom-model-dropdown")).toBeTruthy();
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

      expect(screen.getByTestId("custom-model-dropdown")).toBeTruthy();
      expect(screen.getByTestId("dropdown-label").textContent).toBe("Model");
      expect(screen.getByTestId("dropdown-value").textContent).toBe("");
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

      // Select a model from the mocked dropdown
      await user.click(screen.getByTestId("dropdown-select-anthropic"));

      expect(screen.getByTestId("dropdown-value").textContent).toBe("anthropic/claude-sonnet-4-5");
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
      await user.click(screen.getByTestId("dropdown-select-anthropic"));
      expect(screen.getByTestId("dropdown-value").textContent).toBe("anthropic/claude-sonnet-4-5");

      // Deselect (use default)
      await user.click(screen.getByTestId("dropdown-select-default"));
      expect(screen.getByTestId("dropdown-value").textContent).toBe("");
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
      await user.click(screen.getByTestId("dropdown-select-anthropic"));

      // Navigate to step 2
      await user.click(screen.getByText("Next"));

      // Summary should show model name
      expect(screen.getByTestId("provider-icon-anthropic")).toBeTruthy();
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
      await user.click(screen.getByTestId("dropdown-select-anthropic"));

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
      await user.click(screen.getByTestId("dropdown-select-anthropic"));

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
      expect(screen.getByTestId("custom-model-dropdown")).toBeTruthy();
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
      await user.click(screen.getByTestId("dropdown-select-anthropic"));

      // Close the dialog
      await user.click(screen.getByLabelText("Close"));

      expect(mockOnClose).toHaveBeenCalled();

      // Unmount and reopen - state should be reset
      unmount();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      // Name should be empty
      const newNameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
      expect(newNameInput.value).toBe("");
    });
  });

  describe("AI generation integration", () => {
    it("shows Generate with AI button in step 0", () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );
      expect(screen.getByText("Generate with AI")).toBeTruthy();
    });

    it("opens AgentGenerationModal when Generate with AI is clicked", async () => {
      const user = userEvent.setup();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

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
      expect(screen.getByTestId("custom-model-dropdown")).toBeTruthy();

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
    it("renders all 20 preset cards in step 0", () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );
      const presetCards = screen.getAllByTestId(/^preset-/);
      expect(presetCards).toHaveLength(20);
    });

    it("shows the quick start header text", () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );
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
      expect(screen.getByTestId("custom-model-dropdown")).toBeTruthy();
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

      // Re-open — state should be reset
      unmount();
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

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
      expect(screen.getByText("👁️")).toBeTruthy();

      // Create
      await user.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledOnce();
      });

      const createCall = mockCreateAgent.mock.calls[0][0];
      expect(createCall.name).toBe("Reviewer");
      expect(createCall.icon).toBe("👁️");
      // Title should be the preset's description
      expect(createCall.title).toBe("Reviews code changes for correctness, security, performance, and adherence to project coding standards.");
      expect(createCall.role).toBe("reviewer");
    });

    it("preset card titles show the professional title", () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      const ceoCard = screen.getByTestId("preset-ceo");
      expect(ceoCard.getAttribute("title")).toBe("Chief Executive Officer");

      const ctoCard = screen.getByTestId("preset-cto");
      expect(ctoCard.getAttribute("title")).toBe("Chief Technology Officer");
    });

    it("renders descriptions in all 20 preset cards", () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

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

    it("all presets have non-empty description strings", () => {
      // Import the array directly by checking the rendered cards
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

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

    it("name label shows required indicator when no preset is selected", () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

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

    it("Next button is disabled when no preset is selected and name is empty", () => {
      render(
        <NewAgentDialog isOpen={true} onClose={mockOnClose} onCreated={mockOnCreated} />,
      );

      // On initial render (step 0, no preset, empty name), Next should be disabled
      expect(screen.getByText("Next")).toBeDisabled();
    });
  });
});
