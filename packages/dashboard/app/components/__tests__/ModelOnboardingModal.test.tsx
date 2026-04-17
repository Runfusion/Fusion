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

// Mock lucide-react icons - preserve actual icons for other components
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    X: () => <span data-testid="icon-x">X</span>,
    Loader2: ({ className }: { className?: string }) => <span data-testid="icon-loader" className={className}>Loader2</span>,
    CheckCircle: () => <span data-testid="icon-check-circle">CheckCircle</span>,
    Key: () => <span data-testid="icon-key">Key</span>,
    Zap: () => <span data-testid="icon-zap">Zap</span>,
    GitPullRequest: () => <span data-testid="icon-git-pull-request">GitPullRequest</span>,
    Rocket: () => <span data-testid="icon-rocket">Rocket</span>,
    Plus: () => <span data-testid="icon-plus">Plus</span>,
    ChevronRight: () => <span data-testid="icon-chevron-right">ChevronRight</span>,
  };
});

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
  vi.useRealTimers();
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

      // Check status badges - first badge should be for Anthropic
      const badges = screen.getAllByTestId("provider-status-badge");
      expect(badges.length).toBeGreaterThanOrEqual(1);
      expect(badges[0]).toHaveAttribute("data-status", "not-connected");
      expect(badges[0]).toHaveTextContent("Not connected");
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

    it("shows provider-specific API key field label and setup instructions", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("OpenAI API Key")).toBeTruthy();
      });

      expect(
        screen.getByText("Create an API key from your OpenAI dashboard under API keys."),
      ).toBeTruthy();
    });

    it("shows usage disclosure and dashboard link for API key provider", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Where is this key used?")).toBeTruthy();
      });

      const keyLink = screen.getByRole("link", { name: "Get your API key →" });
      expect(keyLink.getAttribute("href")).toBe("https://platform.openai.com/api-keys");
      expect(keyLink.getAttribute("target")).toBe("_blank");
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

    it("submits API key when Enter is pressed", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "sk-enter-submit" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(mockSaveApiKey).toHaveBeenCalledWith("openai", "sk-enter-submit");
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

    it("shows saved status and clears API key when Remove Key is clicked for authenticated provider", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: true, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("✓ API key saved")).toBeTruthy();
      });

      expect(screen.getByText("Remove Key")).toBeTruthy();
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

    it("uses fallback API key instructions for unknown API-key provider", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "mystery-provider", name: "Mystery AI", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("API Key")).toBeTruthy();
      });

      expect(screen.getByText("Enter your API key for this provider.")).toBeTruthy();
    });
  });

  describe("GitHub step", () => {
    it("GitHub step shows fallback when no GitHub provider", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      expect(screen.getByText(/GitHub integration isn't set up yet/)).toBeTruthy();
      expect(screen.getByText(/Settings → Authentication/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Continue without GitHub →" })).toBeTruthy();
    });

    it("GitHub step shows benefits list with connect action", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      expect(screen.getByText("Connect GitHub to unlock issue and PR integration:")).toBeTruthy();
      expect(screen.getByText(/Import issues as tasks/)).toBeTruthy();
      expect(screen.getByText(/Track pull requests/)).toBeTruthy();
      expect(screen.getByText(/Link code changes/)).toBeTruthy();

      const ctaContainer = screen.getByTestId("onboarding-github-connect-cta");
      expect(ctaContainer).toHaveClass("onboarding-github-connect-cta");
      const connectButton = screen.getByRole("button", { name: /Connect/ });
      expect(connectButton).toHaveClass("btn", "btn-primary", "btn-sm");
    });

    it("GitHub step shows connected state when already authenticated", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      expect(screen.getByText(/Import issues as tasks/)).toBeTruthy();
      expect(screen.getByTestId("onboarding-auth-status-github")).toBeTruthy();
      expect(screen.getByText("✓ Connected")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
      expect(screen.queryByTestId("onboarding-github-connect-cta")).toBeNull();
    });

    describe("GitHub connection status feedback", () => {
      it("shows connected status with success feedback", async () => {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
          ],
        });

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

        await navigateToGitHubStep();

        const badge = screen.getByTestId("github-status-badge");
        expect(badge).toHaveTextContent("✓ Connected");
        expect(badge).toHaveClass("connected");
        expect(screen.getByText("GitHub is connected. You can import issues and track pull requests.")).toBeTruthy();
      });

      it("shows not-connected status and keeps default helper text", async () => {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
          ],
        });

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

        await navigateToGitHubStep();

        const badge = screen.getByTestId("github-status-badge");
        expect(badge).toHaveTextContent("Not connected");
        expect(badge).toHaveClass("not-connected");
        expect(screen.queryByText("Connection failed or timed out.")).toBeNull();
        expect(screen.getByText("No worries if you're not ready — connect GitHub anytime from Settings → Authentication.")).toBeTruthy();
      });

      it("shows pending status while GitHub login is in progress", async () => {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
          ],
        });
        mockLoginProvider.mockImplementationOnce(() => new Promise(() => {}));

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

        await navigateToGitHubStep();

        fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

        await waitFor(() => {
          const badge = screen.getByTestId("github-status-badge");
          expect(badge).toHaveTextContent("⏳ Connecting…");
          expect(badge).toHaveClass("pending");
        });
      });

      it("shows failed status feedback with retry action", async () => {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
          ],
        });
        mockLoginProvider.mockRejectedValueOnce(new Error("GitHub login failed"));

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

        await navigateToGitHubStep();

        fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

        await waitFor(() => {
          const badge = screen.getByTestId("github-status-badge");
          expect(badge).toHaveTextContent("✗ Connection failed");
          expect(badge).toHaveClass("retry");
        });

        expect(screen.getByText("Connection failed or timed out.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      });

      it("retries login from failed feedback", async () => {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
          ],
        });
        mockLoginProvider
          .mockRejectedValueOnce(new Error("Initial GitHub failure"))
          .mockImplementationOnce(() => new Promise(() => {}));

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

        await navigateToGitHubStep();

        fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

        await waitFor(() => {
          expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
        });

        fireEvent.click(screen.getByRole("button", { name: "Retry" }));

        await waitFor(() => {
          expect(mockLoginProvider).toHaveBeenCalledTimes(2);
        });
      });

      it("persists skipped status from Skip GitHub link and restores skipped feedback", async () => {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
          ],
        });

        const { unmount } = render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

        await navigateToGitHubStep();

        fireEvent.click(screen.getByText("Skip GitHub →"));

        const persistedSkipCall = mockSaveOnboardingState.mock.calls.some((call) => {
          return call[1]?.stepData?.github?.skipped === true;
        });
        expect(persistedSkipCall).toBe(true);

        unmount();

        const persistedState = {
          currentStep: "github",
          completedSteps: ["ai-setup"],
          updatedAt: "2026-04-17T00:00:00.000Z",
          dismissed: false,
          completed: false,
          stepData: {
            github: {
              skipped: true,
            },
          },
        };
        mockGetOnboardingState.mockReturnValue(persistedState);
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
          ],
        });

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

        await waitFor(() => {
          expect(screen.getByText("Connect GitHub")).toBeTruthy();
        });

        const badge = screen.getByTestId("github-status-badge");
        expect(badge).toHaveTextContent("Skipped");
        expect(badge).toHaveClass("skipped");
        expect(screen.getByText(/GitHub was skipped/)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Connect anyway" })).toBeTruthy();
      });

      it("connects from skipped feedback via Connect anyway", async () => {
        const persistedState = {
          currentStep: "github",
          completedSteps: ["ai-setup"],
          updatedAt: "2026-04-17T00:00:00.000Z",
          dismissed: false,
          completed: false,
          stepData: {
            github: {
              skipped: true,
            },
          },
        };
        mockGetOnboardingState.mockReturnValue(persistedState);
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
          ],
        });

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

        await waitFor(() => {
          expect(screen.getByRole("button", { name: "Connect anyway" })).toBeTruthy();
        });

        fireEvent.click(screen.getByRole("button", { name: "Connect anyway" }));

        await waitFor(() => {
          expect(mockLoginProvider).toHaveBeenCalledWith("github");
        });
      });
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
      vi.useFakeTimers();
      fireEvent.click(screen.getByText("Login"));

      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2000);
      });

      // Wait for the login to complete (poll detects authenticated on 2nd call)
      expect(addToast).toHaveBeenCalledWith("Login successful", "success");

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
      vi.useFakeTimers();
      fireEvent.click(screen.getByText("Login"));

      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2000);
      });

      // Wait for saveOnboardingState to be called with success outcome
      const successCall = mockSaveOnboardingState.mock.calls.find(
        (call) => call[1]?.stepData?.["ai-setup"]?.loginOutcomes?.anthropic === "success"
      );
      expect(successCall).toBeDefined();
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

describe("ModelOnboardingModal progressive disclosure", () => {
  describe("AI Setup step disclosures", () => {
    it("renders all 4 disclosure trigger buttons in AI Setup step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Verify all 4 disclosures are present
      expect(screen.getByText("What are AI providers?")).toBeTruthy();
      expect(screen.getByText("How does login work?")).toBeTruthy();
      expect(screen.getByText("What is an API key?")).toBeTruthy();
      expect(screen.getByText("How do I choose a model?")).toBeTruthy();
    });

    it("clicking disclosure trigger expands content", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("What are AI providers?")).toBeTruthy();
      });

      const trigger = screen.getByRole("button", { name: /What are AI providers\?/ });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(trigger);

      await waitFor(() => {
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByText(/AI providers like OpenAI and Anthropic/)).toBeTruthy();
      });
    });

    it("clicking disclosure trigger again collapses content", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("What are AI providers?")).toBeTruthy();
      });

      const trigger = screen.getByRole("button", { name: /What are AI providers\?/ });

      // Open
      fireEvent.click(trigger);
      await waitFor(() => {
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
      });

      // Close
      fireEvent.click(trigger);
      await waitFor(() => {
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByText(/AI providers like OpenAI and Anthropic/)).toBeNull();
      });
    });

    it("multiple disclosures are independent", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("What are AI providers?")).toBeTruthy();
        expect(screen.getByText("What is an API key?")).toBeTruthy();
      });

      const trigger1 = screen.getByRole("button", { name: /What are AI providers\?/ });
      const trigger2 = screen.getByRole("button", { name: /What is an API key\?/ });

      // Open first disclosure
      fireEvent.click(trigger1);
      await waitFor(() => {
        expect(trigger1.getAttribute("aria-expanded")).toBe("true");
        expect(trigger2.getAttribute("aria-expanded")).toBe("false");
        expect(screen.getByText(/AI providers like OpenAI and Anthropic/)).toBeTruthy();
      });

      // Open second disclosure
      fireEvent.click(trigger2);
      await waitFor(() => {
        expect(trigger1.getAttribute("aria-expanded")).toBe("true");
        expect(trigger2.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByText(/An API key is a secret token/)).toBeTruthy();
      });
    });
  });

  describe("GitHub step disclosures", () => {
    it("renders GitHub integration disclosure in GitHub step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      expect(screen.getByText("What does GitHub integration do?")).toBeTruthy();
    });
  });

  describe("First Task step disclosures", () => {
    it("renders task creation disclosure in First Task step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToFirstTaskStep();

      expect(screen.getByText("What happens when I create a task?")).toBeTruthy();
    });
  });

  describe("Complete step disclosures", () => {
    it("does not render any disclosure triggers in complete step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToFirstTaskStep();

      // Click Finish Setup
      fireEvent.click(screen.getByText("Finish Setup"));

      await waitFor(() => {
        expect(screen.getByText("All Set!")).toBeTruthy();
      });

      // Verify no disclosure triggers exist
      expect(screen.queryByText("What are AI providers?")).toBeNull();
      expect(screen.queryByText("How does login work?")).toBeNull();
      expect(screen.queryByText("What is an API key?")).toBeNull();
      expect(screen.queryByText("How do I choose a model?")).toBeNull();
      expect(screen.queryByText("What does GitHub integration do?")).toBeNull();
      expect(screen.queryByText("What happens when I create a task?")).toBeNull();
    });
  });

  // FN-1901: Provider Connection Status Display Tests
  describe("Provider connection status display (FN-1901)", () => {
    it("shows Connected badge for authenticated provider", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      const badge = screen.getByTestId("provider-status-badge");
      expect(badge).toHaveAttribute("data-status", "connected");
      expect(badge).toHaveTextContent("✓ Connected");
    });

    it("shows Not connected badge for unauthenticated provider", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      const badges = screen.getAllByTestId("provider-status-badge");
      const anthropicBadge = badges.find(b =>
        b.closest(".onboarding-provider-card")?.textContent?.includes("Anthropic")
      );
      expect(anthropicBadge).toHaveAttribute("data-status", "not-connected");
      expect(anthropicBadge).toHaveTextContent("Not connected");
    });

    it("shows Skipped badge for providers when user moves past ai-setup without connecting", async () => {
      // Start at ai-setup with unconnected providers
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      // Navigate to GitHub step (triggers skip-tracking effect)
      fireEvent.click(screen.getByText("Next →"));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      // Navigate back to AI Setup
      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Verify the provider now shows Skipped badge
      const badges = screen.getAllByTestId("provider-status-badge");
      const anthropicBadge = badges.find(b =>
        b.closest(".onboarding-provider-card")?.textContent?.includes("Anthropic")
      );
      expect(anthropicBadge).toHaveAttribute("data-status", "skipped");
      expect(anthropicBadge).toHaveTextContent("Skipped");
    });

    it("does not mark providers as skipped when at least one is authenticated", async () => {
      // Set up: anthropic is authenticated, openai is not
      // Use mockImplementation so subsequent calls also return the correct providers
      mockFetchAuthStatus.mockImplementation(() =>
        Promise.resolve({
          providers: [
            { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
            { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
          ],
        })
      );

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      // Navigate away and back
      fireEvent.click(screen.getByText("Next →"));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Verify anthropic shows Connected (not Skipped)
      const badges = screen.getAllByTestId("provider-status-badge");
      const anthropicBadge = badges.find(b =>
        b.closest(".onboarding-provider-card")?.textContent?.includes("Anthropic")
      );
      expect(anthropicBadge).toHaveAttribute("data-status", "connected");

      // Verify openai shows Not connected (not Skipped)
      const openaiBadge = badges.find(b =>
        b.closest(".onboarding-provider-card")?.textContent?.includes("OpenAI")
      );
      expect(openaiBadge).toHaveAttribute("data-status", "not-connected");
    });

    it("removes skipped status when provider becomes authenticated", async () => {
      // Start with unconnected provider
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      // Navigate away to trigger skip-tracking
      fireEvent.click(screen.getByText("Next →"));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      // Now mock returns authenticated provider
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      // Navigate back to AI Setup (loads fresh auth status)
      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Verify the provider now shows Connected (skipped status removed)
      const badge = screen.getByTestId("provider-status-badge");
      expect(badge).toHaveAttribute("data-status", "connected");
    });

    it("persists skipped providers to onboarding stepData", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      // Navigate away
      fireEvent.click(screen.getByText("Next →"));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      // Verify saveOnboardingState was called with skippedProviders
      const saveCall = mockSaveOnboardingState.mock.calls.find(
        (call) => call[1]?.stepData?.["ai-setup"]?.skippedProviders?.anthropic === true
      );
      expect(saveCall).toBeDefined();
    });

    it("restores skipped providers from persisted state on mount", async () => {
      // Set up persisted state with anthropic as skipped
      // Use mockReturnValue (not mockReturnValueOnce) since getOnboardingState is called multiple times
      mockGetOnboardingState.mockReturnValue({
        currentStep: "ai-setup",
        updatedAt: new Date().toISOString(),
        completedSteps: [],
        dismissed: false,
        completed: false,
        completedAt: undefined,
        stepData: {
          "ai-setup": {
            skippedProviders: { anthropic: true },
          },
        },
      });

      // Provider is not authenticated
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      // Verify the provider shows Skipped immediately
      const badge = screen.getByTestId("provider-status-badge");
      expect(badge).toHaveAttribute("data-status", "skipped");
      expect(badge).toHaveTextContent("Skipped");
    });

    it("shows provider summary with connected count", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      const summary = screen.getByTestId("provider-summary");
      expect(summary).toHaveTextContent("1 of 2 providers connected");
      expect(summary).toHaveClass("onboarding-provider-summary--connected");
    });

    it("shows provider summary with skipped count", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      // Navigate away to trigger skip-tracking
      fireEvent.click(screen.getByText("Next →"));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      // Navigate back
      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      const summary = screen.getByTestId("provider-summary");
      expect(summary).toHaveTextContent("1 provider skipped");
      expect(summary).toHaveClass("onboarding-provider-summary--skipped");
    });

    it("shows provider summary with none connected", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      const summary = screen.getByTestId("provider-summary");
      expect(summary).toHaveTextContent("No providers connected yet");
      expect(summary).toHaveClass("onboarding-provider-summary--none");
    });

    it("does not show provider summary during loading", async () => {
      // Don't resolve the mock immediately
      mockFetchAuthStatus.mockImplementation(() => new Promise(() => {}));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      // Summary should not exist while loading
      expect(screen.queryByTestId("provider-summary")).toBeNull();

      // Should show loading state
      expect(screen.getByText("Loading providers…")).toBeTruthy();
    });

    it("GitHub step shows Connected/Not connected badge", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      // GitHub should show Not connected
      expect(screen.getByTestId("onboarding-auth-status-github")).toHaveTextContent("Not connected");
      expect(screen.getByTestId("github-status-badge")).toHaveClass("auth-status-badge", "not-connected");
    });
  });

  describe("Skip-state messaging", () => {
    it("shows AI provider skip banner on GitHub step when no provider connected", async () => {
      // Start at ai-setup with no AI providers connected
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      // Should show skip banner about AI provider
      const banners = screen.getAllByRole("status");
      expect(banners.some(b => b.classList.contains("onboarding-skip-banner"))).toBe(true);

      const skipBanner = screen.getByText("No AI provider connected").closest(".onboarding-skip-banner");
      expect(skipBanner).toBeTruthy();
      expect(skipBanner).toHaveTextContent(/AI features like task planning and code generation won't be available/);
    });

    it("does not show AI provider skip banner on GitHub step when provider is connected", async () => {
      // Start with an AI provider already connected
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      // Should NOT show skip banner about AI provider
      expect(screen.queryByText("No AI provider connected")).toBeNull();
    });

    it("shows GitHub skip banner on First Task step when GitHub not connected", async () => {
      // AI provider connected but GitHub not connected
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToFirstTaskStep();

      // Should show skip banner about GitHub
      const skipBanner = screen.getByText("GitHub not connected").closest(".onboarding-skip-banner");
      expect(skipBanner).toBeTruthy();
      expect(skipBanner).toHaveTextContent(/won't be able to import issues from GitHub/);
    });

    it("does not show GitHub skip banner on First Task step when GitHub is connected", async () => {
      // Both AI and GitHub connected - mock for all auth status calls
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToFirstTaskStep();

      // Should NOT show skip banner about GitHub (use querySelector to avoid matching the auth badge)
      const skipBanners = document.querySelectorAll(".onboarding-skip-banner");
      const githubSkipBanner = Array.from(skipBanners).find(
        (banner) => banner.textContent?.includes("GitHub not connected")
      );
      expect(githubSkipBanner).toBeUndefined();
    });

    it("shows both skip banners on First Task step when both AI and GitHub are skipped", async () => {
      // Neither AI nor GitHub connected
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToFirstTaskStep();

      // Should show BOTH skip banners
      expect(screen.getByText("GitHub not connected")).toBeTruthy();
      expect(screen.getByText("No AI provider connected")).toBeTruthy();

      // Both should have the skip-banner class
      const githubBanner = screen.getByText("GitHub not connected").closest(".onboarding-skip-banner");
      const aiBanner = screen.getByText("No AI provider connected").closest(".onboarding-skip-banner");
      expect(githubBanner).toBeTruthy();
      expect(aiBanner).toBeTruthy();
    });

    it("does not show any skip banner on AI Setup step", async () => {
      // No providers connected
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Should NOT show any skip banners on AI Setup step
      expect(screen.queryByText("onboarding-skip-banner")).toBeNull();
      const skipBanners = document.querySelectorAll(".onboarding-skip-banner");
      expect(skipBanners.length).toBe(0);
    });

    it("skip banners have role=status for accessibility", async () => {
      // Set up with no AI provider connected
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await navigateToGitHubStep();

      // Check that skip banner has role="status"
      const skipBanner = screen.getByText("No AI provider connected").closest(".onboarding-skip-banner");
      expect(skipBanner).toHaveAttribute("role", "status");
    });
  });
});
