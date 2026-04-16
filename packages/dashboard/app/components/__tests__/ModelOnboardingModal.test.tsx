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
const mockGetStepData = vi.fn();

vi.mock("../model-onboarding-state", () => ({
  getOnboardingState: (...args: unknown[]) => mockGetOnboardingState(...args),
  saveOnboardingState: (...args: unknown[]) => mockSaveOnboardingState(...args),
  clearOnboardingState: (...args: unknown[]) => mockClearOnboardingState(...args),
  markOnboardingCompleted: (...args: unknown[]) => mockMarkOnboardingCompleted(...args),
  getStepData: (...args: unknown[]) => mockGetStepData(...args),
}));

// Mock ProviderIcon for test isolation
vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider, size }: { provider: string; size?: string }) => (
    <span data-testid="provider-icon" data-provider={provider} data-size={size}>
      {provider} icon
    </span>
  ),
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
  mockGetStepData.mockReturnValue(null);
  // Reset mockFetchAuthStatus to default - use mockImplementation for clear control
  mockFetchAuthStatus.mockReset();
  mockFetchAuthStatus.mockImplementation(() => Promise.resolve({ providers: defaultAuthProviders }));
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

    it("renders provider description for OAuth provider", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Claude models — strong at reasoning, analysis, and code")).toBeTruthy();
      });

      // Verify the description is inside a provider card
      const description = screen.getByText("Claude models — strong at reasoning, analysis, and code");
      expect(description.closest(".onboarding-provider-card")).toBeTruthy();
    });

    it("renders provider description for API key provider", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("GPT models — versatile for a wide range of tasks")).toBeTruthy();
      });

      // Verify the description is inside a provider card
      const description = screen.getByText("GPT models — versatile for a wide range of tasks");
      expect(description.closest(".onboarding-provider-card")).toBeTruthy();
    });

    it("renders ProviderIcon for each provider card", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
        expect(screen.getByText("OpenAI")).toBeTruthy();
      });

      // Verify provider icons are rendered for both providers
      const icons = screen.getAllByTestId("provider-icon");
      expect(icons.length).toBe(2);

      // Verify the data-provider attributes match expected IDs
      const anthropicIcon = icons.find((icon) => icon.getAttribute("data-provider") === "anthropic");
      const openaiIcon = icons.find((icon) => icon.getAttribute("data-provider") === "openai");
      expect(anthropicIcon).toBeTruthy();
      expect(openaiIcon).toBeTruthy();
    });

    it("applies connected modifier class to authenticated provider cards", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      const { container } = render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      // Verify the authenticated provider has the connected modifier class
      const connectedCards = container.querySelectorAll(".onboarding-provider-card--connected");
      expect(connectedCards.length).toBe(1);

      // Verify the connected card contains Anthropic
      const anthropicCard = connectedCards[0];
      expect(anthropicCard?.textContent?.includes("Anthropic")).toBe(true);

      // Verify non-authenticated provider does not have the modifier
      const allCards = container.querySelectorAll(".onboarding-provider-card");
      const connectedCardIds = Array.from(connectedCards).map((card) =>
        card.querySelector(".onboarding-provider-card__name")?.textContent
      );
      expect(connectedCardIds).toContain("Anthropic");
    });

    it("renders fallback description for unknown provider", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "unknown-provider", name: "Unknown", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("AI provider — connect to start using AI models")).toBeTruthy();
      });
    });
  });

  describe("GitHub step", () => {
    it("shows optional guidance when GitHub provider is not configured", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      expect(screen.getByText(/GitHub integration isn't set up yet/)).toBeTruthy();
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

  describe("Non-blocking progression", () => {
    it("allows advancing to GitHub step without authenticating any provider", async () => {
      // All providers return authenticated: false
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Click Next without any providers authenticated
      fireEvent.click(screen.getByText("Next →"));

      // Should advance to GitHub step
      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      // No error messages should appear
      expect(screen.queryByText(/error/i)).toBeNull();
    });

    it("allows advancing to GitHub step without selecting a model", async () => {
      // Default mock setup has no model selected
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Verify model dropdown is empty (no model selected)
      const dropdown = screen.getByTestId("mock-model-dropdown") as HTMLSelectElement;
      expect(dropdown.value).toBe("");

      // Click Next without selecting a model
      fireEvent.click(screen.getByText("Next →"));

      // Should advance to GitHub step successfully
      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });
    });

    it("allows advancing to First Task step without connecting GitHub", async () => {
      // GitHub provider exists but is not authenticated
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      // Navigate to GitHub step
      await navigateToGitHubStep();

      // Click Next without connecting GitHub
      fireEvent.click(screen.getByText("Next →"));

      // Should advance to First Task step
      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });
    });

    it("allows completing full onboarding flow without any setup", async () => {
      // All providers not authenticated, no model selected
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      // Navigate AI Setup → GitHub → First Task
      await navigateToFirstTaskStep();

      // Click Finish Setup
      fireEvent.click(screen.getByText("Finish Setup"));

      // Should complete onboarding successfully
      await waitFor(() => {
        expect(screen.getByText("All Set!")).toBeTruthy();
      });

      // Should call updateGlobalSettings with modelOnboardingComplete: true
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          modelOnboardingComplete: true,
        }),
      );
    });

    it("shows Optional badge on AI Setup and GitHub steps", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      // On AI Setup step, Optional badge should be visible
      await waitFor(() => {
        expect(screen.getByText("Optional")).toBeTruthy();
      });

      // Navigate to GitHub step
      await navigateToGitHubStep();

      // On GitHub step, Optional badge should be visible
      await waitFor(() => {
        expect(screen.getByText("Optional")).toBeTruthy();
      });

      // Navigate to First Task step
      fireEvent.click(screen.getByText("Next →"));

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      // On First Task step, NO Optional badge should be shown
      // (there should be only one "Optional" text if we go back, but at this point it should be 0)
      const optionalBadges = screen.queryAllByText("Optional");
      expect(optionalBadges.length).toBe(0);
    });

    it("shows skip-step links on AI Setup and GitHub steps", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // On AI Setup step, Skip setup link should be present
      expect(screen.getByText("Skip setup →")).toBeTruthy();

      // Click Skip setup
      fireEvent.click(screen.getByText("Skip setup →"));

      // Should advance to GitHub step
      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      // On GitHub step, Skip GitHub link should be present
      expect(screen.getByText("Skip GitHub →")).toBeTruthy();

      // Click Skip GitHub
      fireEvent.click(screen.getByText("Skip GitHub →"));

      // Should advance to First Task step
      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });
    });

    it("shows helper text on AI Setup when no providers authenticated", async () => {
      // All providers authenticated: false
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Helper text should be visible when no providers are authenticated
      expect(screen.getByText("Skip this step if you'd like — you can always add providers later from Settings.")).toBeTruthy();
    });

    it("does not show helper text on AI Setup when a provider is authenticated", async () => {
      // At least one provider authenticated: true
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Helper text should NOT be visible when a provider is authenticated
      expect(screen.queryByText("Skip this step if you'd like — you can always add providers later from Settings.")).toBeNull();
    });

    it("shows helper text on GitHub step when GitHub is available but not connected", async () => {
      // GitHub provider exists with authenticated: false
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      // Helper text should be visible when GitHub is available but not connected
      expect(screen.getByText("No worries if you're not ready — connect GitHub anytime from Settings → Authentication.")).toBeTruthy();
    });

    it("does not show helper text on GitHub step when GitHub is connected", async () => {
      // GitHub provider exists with authenticated: true
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      // Helper text should NOT be visible when GitHub is connected
      expect(screen.queryByText("No worries if you're not ready — connect GitHub anytime from Settings → Authentication.")).toBeNull();
    });
  });

  describe("Login action handling", () => {
    it("shows Cancel button while login is in progress", async () => {
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(screen.getByText("Waiting for login…")).toBeTruthy();
        expect(screen.getByText("Cancel")).toBeTruthy();
      });
    });

    it("cancels login when Cancel button is clicked", async () => {
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(screen.getByText("Cancel")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Cancel"));

      await waitFor(() => {
        // Login button should be shown again
        expect(screen.getByText("Login")).toBeTruthy();
        // Waiting for login should no longer be shown
        expect(screen.queryByText("Waiting for login…")).toBeNull();
        // Cancel button should no longer be shown
        expect(screen.queryByText("Cancel")).toBeNull();
      });
    });

    it("login failure shows error toast and sets outcome to failed", async () => {
      mockLoginProvider.mockRejectedValueOnce(new Error("Login failed: Invalid credentials"));

      const addToast = vi.fn();
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Login failed: Invalid credentials", "error");
      });

      // Login button should be shown again
      expect(screen.getByText("Login")).toBeTruthy();

      // Error message should be shown
      expect(screen.getByText("Login failed. Please try again.")).toBeTruthy();
    });

    it("409 concurrent login shows specific toast message", async () => {
      const error = new Error("Login already in progress");
      (error as unknown as { status: number }).status = 409;
      mockLoginProvider.mockRejectedValueOnce(error);

      const addToast = vi.fn();
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          "Login already in progress. Please wait or cancel the current attempt.",
          "warning"
        );
      });
    });

    it("successful login shows success toast and persists outcome", async () => {
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      // Track call count to return different values
      let callCount = 0;
      mockFetchAuthStatus.mockImplementation(() => {
        callCount++;
        // First call (initial load) - provider is NOT authenticated
        // Subsequent calls (polling) - provider IS authenticated
        return Promise.resolve({
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              authenticated: callCount > 1,
              type: "oauth",
            },
          ],
        });
      });

      const addToast = vi.fn();
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} />);

      // Wait for Login button to appear (provider not authenticated initially)
      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      // Click Login
      fireEvent.click(screen.getByText("Login"));

      // Wait for the login to complete (poll detects authenticated on 2nd call)
      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Login successful", "success");
      }, { timeout: 3000 });

      // Check that login outcome was persisted
      const saveCall = mockSaveOnboardingState.mock.calls.find(
        (call) => call[1]?.stepData?.["ai-setup"]?.loginOutcomes?.anthropic === "success"
      );
      expect(saveCall).toBeDefined();
    });

    it("login outcome persisted to stepData after successful login", async () => {
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      // Track call count to return different values
      let callCount = 0;
      mockFetchAuthStatus.mockImplementation(() => {
        callCount++;
        // First call (initial load) - provider is NOT authenticated
        // Subsequent calls (polling) - provider IS authenticated
        return Promise.resolve({
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              authenticated: callCount > 1,
              type: "oauth",
            },
          ],
        });
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      // Wait for Login button to appear
      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      // Click Login
      fireEvent.click(screen.getByText("Login"));

      // Wait for saveOnboardingState to be called with success outcome
      await waitFor(() => {
        const successCall = mockSaveOnboardingState.mock.calls.find(
          (call) => call[1]?.stepData?.["ai-setup"]?.loginOutcomes?.anthropic === "success"
        );
        expect(successCall).toBeDefined();
      }, { timeout: 3000 });
    });

    it("stale pending outcomes are filtered on mount", async () => {
      // Mock getStepData to return a stale pending outcome
      mockGetStepData.mockReturnValueOnce({
        loginOutcomes: {
          anthropic: "pending", // Stale - from previous session
          openai: "success", // Valid terminal outcome
        },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Navigate to trigger a save that would persist the filtered outcomes
      // The pending outcome should NOT be persisted (filtered out)
      const saveCalls = mockSaveOnboardingState.mock.calls;
      const hasAnthropicPending = saveCalls.some((call) => {
        const stepData = call[1]?.stepData;
        return stepData?.["ai-setup"]?.loginOutcomes?.anthropic === "pending";
      });
      expect(hasAnthropicPending).toBe(false);
    });

    it("retry after timeout shows Login button again", async () => {
      // Set up getStepData to return a timeout outcome
      mockGetStepData.mockReturnValueOnce({
        loginOutcomes: {
          anthropic: "timeout",
        },
      });

      const addToast = vi.fn();

      await act(async () => {
        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} />);
      });

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // The timeout message should be shown (rendered from persisted outcome)
      // Note: This test verifies the persistence layer works - the timeout message
      // appears based on loginOutcomes state, not current auth status
      expect(screen.getByText("Login timed out. Please try again.")).toBeTruthy();

      // Cancel button should not be shown (no login in progress)
      expect(screen.queryByText("Cancel")).toBeNull();
    });

    it("navigation remains enabled during login", async () => {
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(screen.getByText("Waiting for login…")).toBeTruthy();
      });

      // Navigation buttons should NOT be disabled during login
      const nextButton = screen.getByText("Next →") as HTMLButtonElement;
      expect(nextButton.disabled).toBe(false);

      const skipButton = screen.getByText("Skip setup →");
      expect(skipButton).toBeTruthy();
    });

    it("login timeout after max polls (simulated with fake timers)", async () => {
      // This test verifies the timeout mechanism works correctly
      // Using vi.useFakeTimers for deterministic timing
      vi.useFakeTimers();

      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      const addToast = vi.fn();

      // Use act to render with fake timers
      await act(async () => {
        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} />);
      });

      // Click Login to start the login flow
      await act(async () => {
        fireEvent.click(screen.getByText("Login"));
      });

      expect(screen.getByText("Waiting for login…")).toBeTruthy();

      // Advance time past MAX_POLL_CYCLES * 2000ms = 300000ms
      // MAX_POLL_CYCLES = 150, so 151 polls to trigger timeout
      await act(async () => {
        await vi.advanceTimersByTimeAsync(302000);
      });

      // Should show timeout toast
      expect(addToast).toHaveBeenCalledWith("Login timed out. Please try again.", "warning");

      // Cancel button should not be shown after timeout
      expect(screen.queryByText("Cancel")).toBeNull();

      vi.useRealTimers();
    });
  });
});
