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
});
