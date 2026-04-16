import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ModelOnboardingModal } from "../ModelOnboardingModal";
import type { AuthProvider } from "../../api";

// Mock the API module
const mockFetchAuthStatus = vi.fn();
const mockLoginProvider = vi.fn();
const mockLogoutProvider = vi.fn();
const mockSaveApiKey = vi.fn();
const mockClearApiKey = vi.fn();
const mockFetchModels = vi.fn();
const mockFetchGlobalSettings = vi.fn();
const mockUpdateGlobalSettings = vi.fn();

vi.mock("../../api", () => ({
  fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
  loginProvider: (...args: unknown[]) => mockLoginProvider(...args),
  logoutProvider: (...args: unknown[]) => mockLogoutProvider(...args),
  saveApiKey: (...args: unknown[]) => mockSaveApiKey(...args),
  clearApiKey: (...args: unknown[]) => mockClearApiKey(...args),
  fetchModels: (...args: unknown[]) => mockFetchModels(...args),
  fetchGlobalSettings: (...args: unknown[]) => mockFetchGlobalSettings(...args),
  updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
}));

// Mock CustomModelDropdown since it has complex portal behavior
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <select
      data-testid="mock-model-dropdown"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder ?? "Select…"}</option>
      <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5</option>
      <option value="openai/gpt-4o">GPT-4o</option>
    </select>
  ),
}));

// Mock model-onboarding-state
const mockGetOnboardingState = vi.fn();
const mockSaveOnboardingState = vi.fn();
const mockClearOnboardingState = vi.fn();
const mockMarkOnboardingCompleted = vi.fn();

vi.mock("../model-onboarding-state", () => ({
  getOnboardingState: (...args: unknown[]) => mockGetOnboardingState(...args),
  saveOnboardingState: (...args: unknown[]) => mockSaveOnboardingState(...args),
  clearOnboardingState: (...args: unknown[]) => mockClearOnboardingState(...args),
  markOnboardingCompleted: (...args: unknown[]) => mockMarkOnboardingCompleted(...args),
}));

const defaultAuthProviders: AuthProvider[] = [
  { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
  { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
];

const defaultModels = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: false, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
];

// Navigate through steps helper
async function navigateToGitHubStep() {
  await waitFor(() => {
    expect(screen.getByText("Next →")).toBeTruthy();
  });
  fireEvent.click(screen.getByText("Next →"));
  await waitFor(() => {
    expect(screen.getByText("Connect GitHub")).toBeTruthy();
  });
}

async function navigateToFirstTaskStep() {
  await navigateToGitHubStep();
  fireEvent.click(screen.getByText("Next →"));
  await waitFor(() => {
    expect(screen.getByText("Create Your First Task")).toBeTruthy();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchAuthStatus.mockResolvedValue({ providers: defaultAuthProviders });
  mockFetchModels.mockResolvedValue({ models: defaultModels, favoriteProviders: [], favoriteModels: [] });
  mockFetchGlobalSettings.mockResolvedValue({});
  mockUpdateGlobalSettings.mockResolvedValue({});
  mockLoginProvider.mockResolvedValue({ url: "https://auth.example.com/login" });
  mockLogoutProvider.mockResolvedValue({ success: true });
  mockSaveApiKey.mockResolvedValue({ success: true });
  mockClearApiKey.mockResolvedValue({ success: true });
  // Default to no persisted state (start at ai-setup)
  mockGetOnboardingState.mockReturnValue(null);
  mockSaveOnboardingState.mockImplementation(() => {});
  mockClearOnboardingState.mockImplementation(() => {});
  mockMarkOnboardingCompleted.mockImplementation(() => {});
});

afterEach(() => {
  // Clean up localStorage
  localStorage.removeItem("kb-onboarding-state");
});

describe("ModelOnboardingModal", () => {
  describe("step structure", () => {
    it("renders the AI Setup step by default with all three step indicators", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Check step indicators
      expect(screen.getByText("AI Setup")).toBeTruthy();
      expect(screen.getByText("GitHub")).toBeTruthy();
      expect(screen.getByText("First Task")).toBeTruthy();

      // Check that AI Setup step is active
      expect(screen.getByText("AI Setup").closest(".model-onboarding-step-indicator")).toHaveClass("active");
    });

    it("shows Next button on first step, not Back", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Next →")).toBeTruthy();
      });

      // Back button should not exist on first step
      expect(screen.queryByText("← Back")).toBeNull();
    });

    it("shows Skip for now button on non-terminal steps", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Skip for now")).toBeTruthy();
      });
    });

    it("shows Back and Next buttons on middle steps", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      // Both Back and Next should be visible
      expect(screen.getByText("← Back")).toBeTruthy();
      expect(screen.getByText("Next →")).toBeTruthy();
    });
  });

  describe("AI Setup step", () => {
    it("shows OAuth providers with Login button", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      expect(screen.getByText("✗ Not authenticated")).toBeTruthy();
      expect(screen.getByText("Login")).toBeTruthy();
    });

    it("shows API key providers with key input", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("OpenAI")).toBeTruthy();
      });

      expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      expect(screen.getByTestId("onboarding-apikey-save-openai")).toBeTruthy();
    });

    it("renders OAuth and API key providers at the same time", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
        expect(screen.getByText("OpenAI")).toBeTruthy();
      });

      expect(screen.getByText("Login")).toBeTruthy();
      expect(screen.getByTestId("onboarding-apikey-save-openai")).toBeTruthy();
    });

    it("shows model dropdown in AI Setup step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Default Model (Optional)")).toBeTruthy();
      });

      expect(screen.getByTestId("mock-model-dropdown")).toBeTruthy();
    });

    it("allows model selection in AI Setup step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("mock-model-dropdown")).toBeTruthy();
      });

      const dropdown = screen.getByTestId("mock-model-dropdown");
      fireEvent.change(dropdown, { target: { value: "anthropic/claude-sonnet-4-5" } });

      await waitFor(() => {
        expect(screen.getByText(/Claude Sonnet 4\.5/)).toBeTruthy();
      });
    });

    it("initiates OAuth login when Login is clicked", async () => {
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(mockLoginProvider).toHaveBeenCalledWith("anthropic");
        expect(mockWindowOpen).toHaveBeenCalledWith("https://auth.example.com/login", "_blank");
      });
    });

    it("saves API key when Save is clicked", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "sk-test-key-123" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(mockSaveApiKey).toHaveBeenCalledWith("openai", "sk-test-key-123");
      });
    });

    it("shows Save button as disabled when API key input is empty", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-save-openai")).toBeTruthy();
      });

      const saveBtn = screen.getByTestId("onboarding-apikey-save-openai") as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(true);
    });

    it("clears API key when Remove Key is clicked for authenticated provider", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: true, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("✓ Key saved")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Remove Key"));

      await waitFor(() => {
        expect(mockClearApiKey).toHaveBeenCalledWith("openai");
      });
    });

    it("does NOT render API key values in the DOM", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai") as HTMLInputElement;
      // Input should be empty initially (never prefilled)
      expect(input.value).toBe("");
      expect(input.type).toBe("password");
    });
  });

  describe("GitHub step", () => {
    it("shows optional guidance when GitHub provider is not configured", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      expect(screen.getByText(/GitHub integration is not configured/)).toBeTruthy();
      expect(screen.getByText("Continue without GitHub →")).toBeTruthy();
    });

    it("shows GitHub status and login/logout actions when GitHub provider is present", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      // Use more specific selector to avoid matching the header title
      expect(screen.getByTestId("onboarding-auth-status-github")).toBeTruthy();
      expect(screen.getByText("✗ Not connected")).toBeTruthy();
      expect(screen.getByText("Connect")).toBeTruthy();
    });

    it("shows connected status when GitHub is authenticated", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      expect(screen.getByTestId("onboarding-auth-status-github")).toBeTruthy();
      expect(screen.getByText("✓ Connected")).toBeTruthy();
      expect(screen.getByText("Disconnect")).toBeTruthy();
    });

    it("allows navigating to First Task step via Continue without GitHub", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      fireEvent.click(screen.getByText("Continue without GitHub →"));

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });
    });

    it("allows navigation back to AI Setup step", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();
      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });
    });

    it("clicking completed AI Setup step indicator navigates back without removing from completedSteps", async () => {
      // Start on GitHub step with AI Setup already completed
      mockGetOnboardingState.mockReturnValueOnce({
        currentStep: "github",
        completedSteps: ["ai-setup"],
        updatedAt: "2024-01-01T00:00:00.000Z",
        dismissed: false,
        completed: false,
        stepData: {},
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      // AI Setup step indicator should be clickable (shows as done)
      const aiSetupIndicator = screen.getByRole("button", { name: "Go back to AI Setup" });
      expect(aiSetupIndicator).toBeTruthy();

      // Click the AI Setup step indicator
      fireEvent.click(aiSetupIndicator);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Verify saveOnboardingState was called with AI Setup still in completedSteps
      const saveCalls = mockSaveOnboardingState.mock.calls;
      const lastSaveCall = saveCalls[saveCalls.length - 1];
      expect(lastSaveCall[0]).toBe("ai-setup");
      expect(lastSaveCall[1]?.completedSteps).toContain("ai-setup");
    });
  });

  describe("First Task step", () => {
    it("shows CTA options for creating first task", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToFirstTaskStep();

      expect(screen.getByText("Create a New Task")).toBeTruthy();
      expect(screen.getByText("Import from GitHub")).toBeTruthy();
    });

    it("shows skip note about CLI and board creation", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToFirstTaskStep();

      expect(screen.getByText(/fn task create/)).toBeTruthy();
    });

    it("allows navigation back to GitHub step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToFirstTaskStep();

      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });
    });
  });

  describe("completion", () => {
    it("completes onboarding and calls onOpenNewTask callback", async () => {
      const onComplete = vi.fn();
      const onOpenNewTask = vi.fn();

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onOpenNewTask={onOpenNewTask}
        />
      );

      // Select a model
      await waitFor(() => {
        expect(screen.getByTestId("mock-model-dropdown")).toBeTruthy();
      });
      const dropdown = screen.getByTestId("mock-model-dropdown");
      fireEvent.change(dropdown, { target: { value: "anthropic/claude-sonnet-4-5" } });

      // Navigate through all steps
      await navigateToFirstTaskStep();

      // Click Create a New Task
      fireEvent.click(screen.getByText("Create a New Task"));

      // Should mark onboarding complete
      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            modelOnboardingComplete: true,
            defaultProvider: "anthropic",
            defaultModelId: "claude-sonnet-4-5",
          }),
        );
      });

      // Should close modal and call both callbacks
      expect(onComplete).toHaveBeenCalled();
      expect(onOpenNewTask).toHaveBeenCalled();
    });

    it("completes onboarding and calls onOpenGitHubImport callback", async () => {
      const onComplete = vi.fn();
      const onOpenGitHubImport = vi.fn();

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onOpenGitHubImport={onOpenGitHubImport}
        />
      );

      // Navigate through all steps
      await navigateToFirstTaskStep();

      // Click Import from GitHub
      fireEvent.click(screen.getByText("Import from GitHub"));

      // Should mark onboarding complete
      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            modelOnboardingComplete: true,
          }),
        );
      });

      // Should close modal and call both callbacks
      expect(onComplete).toHaveBeenCalled();
      expect(onOpenGitHubImport).toHaveBeenCalled();
    });

    it("completes with Finish Setup button (no CTA)", async () => {
      const onComplete = vi.fn();

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      // Navigate through all steps
      await navigateToFirstTaskStep();

      // Click Finish Setup
      await waitFor(() => {
        expect(screen.getByText("Finish Setup")).toBeTruthy();
      });
      fireEvent.click(screen.getByText("Finish Setup"));

      // Should show completion screen
      await waitFor(() => {
        expect(screen.getByText("All Set!")).toBeTruthy();
      });

      // Click Get Started to close
      fireEvent.click(screen.getByText("Get Started"));
      expect(onComplete).toHaveBeenCalled();
    });

    it("completes without model selection", async () => {
      const onComplete = vi.fn();

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      // Navigate through all steps without selecting model
      await navigateToFirstTaskStep();

      // Click Finish Setup
      fireEvent.click(screen.getByText("Finish Setup"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            modelOnboardingComplete: true,
          }),
        );
      });
    });
  });

  describe("dismiss / skip", () => {
    it("marks onboarding complete when dismissed via X button", async () => {
      const onComplete = vi.fn();

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Click the X close button
      const closeBtn = screen.getByLabelText("Skip onboarding");
      fireEvent.click(closeBtn);

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({
          modelOnboardingComplete: true,
        });
      });

      expect(onComplete).toHaveBeenCalled();
    });

    it("marks onboarding complete when Skip for now is clicked", async () => {
      const onComplete = vi.fn();

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Skip for now")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Skip for now"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({
          modelOnboardingComplete: true,
        });
      });

      expect(onComplete).toHaveBeenCalled();
    });

    it("still calls onComplete even if global settings save fails", async () => {
      const onComplete = vi.fn();
      mockUpdateGlobalSettings.mockRejectedValueOnce(new Error("Network error"));

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Skip for now")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Skip for now"));

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalled();
      });
    });
  });

  describe("edge cases", () => {
    it("shows empty state when no providers are configured", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({ providers: [] });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText(/No AI providers are configured/)).toBeTruthy();
      });
    });

    it("handles auth status fetch failure gracefully", async () => {
      mockFetchAuthStatus.mockRejectedValueOnce(new Error("Network error"));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        // Should still render the modal without crashing
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });
    });

    it("shows loading state while fetching providers", () => {
      // Make the fetch hang
      mockFetchAuthStatus.mockReturnValue(new Promise(() => {}));
      mockFetchModels.mockReturnValue(new Promise(() => {}));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      expect(screen.getByText("Loading providers…")).toBeTruthy();
    });

    it("works without optional callbacks", async () => {
      const onComplete = vi.fn();

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      // Render without onOpenNewTask and onOpenGitHubImport
      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      // Navigate through all steps
      await navigateToFirstTaskStep();

      // Click Finish Setup - should work without callbacks
      fireEvent.click(screen.getByText("Finish Setup"));

      await waitFor(() => {
        expect(screen.getByText("All Set!")).toBeTruthy();
      });
    });
  });

  describe("global settings hydration", () => {
    it("pre-populates selectedModel from global settings defaultProvider/defaultModelId", async () => {
      // Mock global settings with a saved default model
      mockFetchGlobalSettings.mockResolvedValueOnce({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        modelOnboardingComplete: true,
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // The model dropdown should be pre-populated with the saved default
      const dropdown = screen.getByTestId("mock-model-dropdown") as HTMLSelectElement;
      expect(dropdown.value).toBe("anthropic/claude-sonnet-4-5");
    });

    it("leaves selectedModel empty when no default is configured in global settings", async () => {
      // Mock global settings with no default model
      mockFetchGlobalSettings.mockResolvedValueOnce({
        modelOnboardingComplete: true,
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // The model dropdown should be empty
      const dropdown = screen.getByTestId("mock-model-dropdown") as HTMLSelectElement;
      expect(dropdown.value).toBe("");
    });

    it("handles fetchGlobalSettings failure gracefully", async () => {
      // Mock global settings fetch to fail
      mockFetchGlobalSettings.mockRejectedValueOnce(new Error("Network error"));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // The modal should still render with empty dropdown
      const dropdown = screen.getByTestId("mock-model-dropdown") as HTMLSelectElement;
      expect(dropdown.value).toBe("");
    });

    it("reopening with persisted github step loads auth status fresh and shows correct badges", async () => {
      // Mock persisted state showing user was on github step
      mockGetOnboardingState.mockReturnValueOnce({
        currentStep: "github",
        completedSteps: ["ai-setup"],
        updatedAt: "2024-01-01T00:00:00.000Z",
        dismissed: false,
        completed: false,
        stepData: {},
      });

      // Mock auth status with some authenticated providers
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      // Verify auth status was fetched fresh (not stale)
      expect(mockFetchAuthStatus).toHaveBeenCalled();

      // GitHub should show as connected
      expect(screen.getByTestId("onboarding-auth-status-github")).toBeTruthy();
      expect(screen.getByText("✓ Connected")).toBeTruthy();

      // Should show Disconnect instead of Connect
      expect(screen.getByText("Disconnect")).toBeTruthy();
    });

    it("reopening with persisted selected model hydrates dropdown via loadGlobalSettings", async () => {
      // Mock global settings with a saved default model
      mockFetchGlobalSettings.mockResolvedValueOnce({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        modelOnboardingComplete: false,
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Verify global settings was fetched to hydrate dropdown
      expect(mockFetchGlobalSettings).toHaveBeenCalled();

      // The model dropdown should be pre-populated with the saved default
      const dropdown = screen.getByTestId("mock-model-dropdown") as HTMLSelectElement;
      expect(dropdown.value).toBe("anthropic/claude-sonnet-4-5");
    });

    it("reopening at github step with persisted model selection hydrates correctly", async () => {
      // Mock persisted state showing user was on first-task step
      mockGetOnboardingState.mockReturnValueOnce({
        currentStep: "first-task",
        completedSteps: ["ai-setup", "github"],
        updatedAt: "2024-01-01T00:00:00.000Z",
        dismissed: false,
        completed: false,
        stepData: {},
      });

      // Mock global settings with a saved default model
      mockFetchGlobalSettings.mockResolvedValueOnce({
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        modelOnboardingComplete: false,
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      // Wait for modal to show the first-task step
      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      // Verify global settings was fetched to hydrate any model selection state
      expect(mockFetchGlobalSettings).toHaveBeenCalled();

      // Navigate back to see if the model dropdown has the saved value
      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // The model dropdown should be pre-populated with the saved default
      const dropdown = screen.getByTestId("mock-model-dropdown") as HTMLSelectElement;
      expect(dropdown.value).toBe("openai/gpt-4o");
    });
  });

  describe("completion state tracking", () => {
    it("completing onboarding (Finish Setup) calls markOnboardingCompleted instead of clearOnboardingState", async () => {
      const onComplete = vi.fn();

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      await navigateToFirstTaskStep();

      // Click Finish Setup
      fireEvent.click(screen.getByText("Finish Setup"));

      // Should show completion screen
      await waitFor(() => {
        expect(screen.getByText("All Set!")).toBeTruthy();
      });

      // Should call markOnboardingCompleted (not clearOnboardingState)
      expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      expect(mockClearOnboardingState).not.toHaveBeenCalled();
    });

    it("dismissing onboarding (Skip for now) does NOT call markOnboardingCompleted", async () => {
      const onComplete = vi.fn();

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Skip for now")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Skip for now"));

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalled();
      });

      // Should NOT call markOnboardingCompleted (dismiss is not completion)
      expect(mockMarkOnboardingCompleted).not.toHaveBeenCalled();
    });

    it("dismissing onboarding (X button) does NOT call markOnboardingCompleted", async () => {
      const onComplete = vi.fn();

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Click the X close button
      const closeBtn = screen.getByLabelText("Skip onboarding");
      fireEvent.click(closeBtn);

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalled();
      });

      // Should NOT call markOnboardingCompleted (dismiss is not completion)
      expect(mockMarkOnboardingCompleted).not.toHaveBeenCalled();
    });

    it("Create a New Task CTA calls markOnboardingCompleted", async () => {
      const onComplete = vi.fn();
      const onOpenNewTask = vi.fn();

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onOpenNewTask={onOpenNewTask}
        />
      );

      await navigateToFirstTaskStep();

      // Click Create a New Task
      fireEvent.click(screen.getByText("Create a New Task"));

      await waitFor(() => {
        expect(onOpenNewTask).toHaveBeenCalled();
      });

      // Should call markOnboardingCompleted
      expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      expect(mockClearOnboardingState).not.toHaveBeenCalled();
    });

    it("Import from GitHub CTA calls markOnboardingCompleted", async () => {
      const onComplete = vi.fn();
      const onOpenGitHubImport = vi.fn();

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onOpenGitHubImport={onOpenGitHubImport}
        />
      );

      await navigateToFirstTaskStep();

      // Click Import from GitHub
      fireEvent.click(screen.getByText("Import from GitHub"));

      await waitFor(() => {
        expect(onOpenGitHubImport).toHaveBeenCalled();
      });

      // Should call markOnboardingCompleted
      expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      expect(mockClearOnboardingState).not.toHaveBeenCalled();
    });
  });
});
