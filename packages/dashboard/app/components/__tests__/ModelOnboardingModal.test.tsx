import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { ModelOnboardingModal } from "../ModelOnboardingModal";
import type { AuthProvider } from "../../api";
import { clearAuthToken } from "../../auth";
import type { Task } from "@fusion/core";

// Mock the API module
const mockFetchAuthStatus = vi.fn();
const mockLoginProvider = vi.fn();
const mockLogoutProvider = vi.fn();
const mockCancelProviderLogin = vi.fn();
const mockSubmitProviderManualCode = vi.fn();
const mockSaveApiKey = vi.fn();
const mockClearApiKey = vi.fn();
const mockFetchModels = vi.fn();
const mockFetchGlobalSettings = vi.fn();
const mockUpdateGlobalSettings = vi.fn();
const mockCreateTask = vi.fn();
const mockCreateAgent = vi.fn();
const mockFetchCustomProviders = vi.fn();
const mockCreateCustomProvider = vi.fn();
const mockFetchCursorCliStatus = vi.fn();
const mockSetCursorCliEnabled = vi.fn();
const mockSetCursorCliBinaryPath = vi.fn();
const mockUseShellConnection = vi.fn();
const mockConfirm = vi.fn();

vi.mock("../../api", () => ({
  fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
  loginProvider: (...args: unknown[]) => mockLoginProvider(...args),
  logoutProvider: (...args: unknown[]) => mockLogoutProvider(...args),
  cancelProviderLogin: (...args: unknown[]) => mockCancelProviderLogin(...args),
  submitProviderManualCode: (...args: unknown[]) => mockSubmitProviderManualCode(...args),
  saveApiKey: (...args: unknown[]) => mockSaveApiKey(...args),
  clearApiKey: (...args: unknown[]) => mockClearApiKey(...args),
  fetchModels: (...args: unknown[]) => mockFetchModels(...args),
  fetchGlobalSettings: (...args: unknown[]) => mockFetchGlobalSettings(...args),
  updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  createAgent: (...args: unknown[]) => mockCreateAgent(...args),
  fetchCustomProviders: (...args: unknown[]) => mockFetchCustomProviders(...args),
  createCustomProvider: (...args: unknown[]) => mockCreateCustomProvider(...args),
  fetchCursorCliStatus: (...args: unknown[]) => mockFetchCursorCliStatus(...args),
  setCursorCliEnabled: (...args: unknown[]) => mockSetCursorCliEnabled(...args),
  setCursorCliBinaryPath: (...args: unknown[]) => mockSetCursorCliBinaryPath(...args),
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

vi.mock("../CustomProviderForm", () => ({
  CustomProviderForm: ({ onSave }: { onSave?: () => void | Promise<void> }) => (
    <button
      type="button"
      data-testid="custom-providers-section"
      onClick={() => {
        void onSave?.({
          id: "custom-provider",
          name: "Custom Provider",
          baseUrl: "https://example.com",
          api: "openai-completions",
          models: [{ id: "example-model" }],
        });
      }}
    >
      Custom Providers Section
    </button>
  ),
}));

vi.mock("../PluginSlot", () => ({
  PluginSlot: ({ slotId }: { slotId: string }) => <div data-testid={`plugin-slot-${slotId}`}>Plugin slot: {slotId}</div>,
}));

// Mock model-onboarding-state
const mockGetOnboardingState = vi.fn();
const mockSaveOnboardingState = vi.fn();
const mockClearOnboardingState = vi.fn();
const mockMarkOnboardingCompleted = vi.fn();
const mockMarkStepSkipped = vi.fn();
const mockGetSkippedSteps = vi.fn();
const mockGetStepData = vi.fn();

vi.mock("../model-onboarding-state", () => ({
  getOnboardingState: (...args: unknown[]) => mockGetOnboardingState(...args),
  saveOnboardingState: (...args: unknown[]) => mockSaveOnboardingState(...args),
  clearOnboardingState: (...args: unknown[]) => mockClearOnboardingState(...args),
  markOnboardingCompleted: (...args: unknown[]) => mockMarkOnboardingCompleted(...args),
  markStepSkipped: (...args: unknown[]) => mockMarkStepSkipped(...args),
  getSkippedSteps: (...args: unknown[]) => mockGetSkippedSteps(...args),
  getStepData: (...args: unknown[]) => mockGetStepData(...args),
  ONBOARDING_FLOW_STEPS: ["ai-setup", "github", "project-setup", "agent", "first-task"],
}));

const mockTrackOnboardingEvent = vi.fn();

vi.mock("../onboarding-events", () => ({
  trackOnboardingEvent: (...args: unknown[]) => mockTrackOnboardingEvent(...args),
  getOnboardingSessionId: () => "test-session-id",
}));

// Mock ProviderIcon for test isolation
vi.mock("../../hooks/useShellConnection", () => ({
  useShellConnection: (...args: unknown[]) => mockUseShellConnection(...args),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: (...args: unknown[]) => mockConfirm(...args) }),
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider, size }: { provider: string; size?: string }) => (
    <span data-testid="provider-icon" data-provider={provider} data-size={size}>
      {provider} icon
    </span>
  ),
}));

vi.mock("../ExperimentalAgentOnboardingModal", () => ({
  ExperimentalAgentOnboardingModal: ({ isOpen, onClose, onUseDraft }: { isOpen: boolean; onClose: () => void; onUseDraft: (draft: any) => void }) => (
    isOpen ? (
      <div data-testid="agent-interview-modal">
        AI Interview Modal
        <button
          type="button"
          onClick={() => {
            onUseDraft({
              name: "Launch Coordinator",
              title: "Launch Planning Agent",
              icon: "◇",
              role: "not-a-real-role",
              instructionsText: "Coordinate launch tasks.",
              soul: "Strategic launch planner.",
              skills: ["planning", "review"],
              runtimeHint: "codex-local",
              maxTurns: 24,
              thinkingLevel: "medium",
            });
            onClose();
          }}
        >
          Use Draft
        </button>
      </div>
    ) : null
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
    Sparkles: () => <span data-testid="icon-sparkles">Sparkles</span>,
    UserRound: () => <span data-testid="icon-user-round">UserRound</span>,
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

const createdTaskMock = {
  id: "FN-0001",
  title: "Initial task",
  description: "Implement onboarding success flow\nAdditional details that should not render",
} as unknown as Task;

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

async function navigateToProjectSetupStep() {
  await navigateToGitHubStep();
  fireEvent.click(screen.getByText("Next →"));
  await waitFor(() => {
    expect(screen.getByText("Set Up Your Project")).toBeTruthy();
  });
}

async function navigateToFirstTaskStep() {
  await navigateToProjectSetupStep();
  fireEvent.click(screen.getByText("Next →"));
  await waitFor(() => {
    expect(screen.getByText("Create Your First Agent")).toBeTruthy();
  });
  fireEvent.click(screen.getByText("Skip for now"));
  await waitFor(() => {
    expect(screen.getByText("Create Your First Task")).toBeTruthy();
  });
}

function getProviderOrderInSection(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-testid^='onboarding-provider-card-']"))
    .map((card) => card.dataset.testid?.replace("onboarding-provider-card-", "") ?? "")
    .filter(Boolean);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAuthToken();
  localStorage.removeItem("fn.authToken");
  mockTrackOnboardingEvent.mockReset();
  mockFetchModels.mockResolvedValue({ models: defaultModels, favoriteProviders: [], favoriteModels: [] });
  mockFetchGlobalSettings.mockResolvedValue({});
  mockUpdateGlobalSettings.mockResolvedValue({});
  mockCreateTask.mockResolvedValue({ id: "FN-TEST", description: "test task" });
  mockCreateAgent.mockResolvedValue({ id: "agent-1" });
  mockFetchCustomProviders.mockResolvedValue({ providers: [] });
  mockCreateCustomProvider.mockResolvedValue({ provider: {} });
  mockLoginProvider.mockResolvedValue({ url: "https://auth.example.com/login" });
  mockLogoutProvider.mockResolvedValue({ success: true });
  mockCancelProviderLogin.mockResolvedValue({ success: true, cancelled: true });
  mockSubmitProviderManualCode.mockResolvedValue({ success: true, submitted: true });
  mockSaveApiKey.mockResolvedValue({ success: true });
  mockClearApiKey.mockResolvedValue({ success: true });
  mockFetchCursorCliStatus.mockResolvedValue({
    binary: { available: true, version: "0.1.0", binaryPath: "/usr/local/bin/cursor-agent", probeDurationMs: 8 },
    enabled: false,
    extension: null,
    ready: false,
  });
  mockSetCursorCliEnabled.mockResolvedValue({ enabled: true, restartRequired: false });
  mockConfirm.mockResolvedValue(true);
  // Default to no persisted state (start at ai-setup)
  mockGetOnboardingState.mockReturnValue(null);
  mockSaveOnboardingState.mockImplementation(() => {});
  mockClearOnboardingState.mockImplementation(() => {});
  mockMarkOnboardingCompleted.mockImplementation(() => {});
  mockMarkStepSkipped.mockImplementation(() => {});
  mockGetSkippedSteps.mockReturnValue([]);
  mockGetStepData.mockReturnValue(null);
  mockUseShellConnection.mockReturnValue({
    shellApi: null,
    ready: true,
    openConnectionManagerSignal: 0,
    state: { host: "web", activeProfileId: null, profiles: [] },
    saveProfile: vi.fn(),
    removeProfile: vi.fn(),
    setActiveProfile: vi.fn(),
  });
  // Reset mockFetchAuthStatus to default - use mockImplementation for clear control
  mockFetchAuthStatus.mockReset();
  mockFetchAuthStatus.mockImplementation(() => Promise.resolve({ providers: defaultAuthProviders }));
});

afterEach(() => {
  vi.useRealTimers();
  clearAuthToken();
  // Clean up localStorage
  localStorage.removeItem("kb-onboarding-state");
  localStorage.removeItem("fn.authToken");
});

describe("ModelOnboardingModal module exports", () => {
  it("does not export dead AppModals/auth onboarding symbols", async () => {
    const moduleExports = await import("../ModelOnboardingModal");

    expect("AppModals" in moduleExports).toBe(false);
    expect("useAuthOnboarding" in moduleExports).toBe(false);
    expect("UseAuthOnboardingOptions" in moduleExports).toBe(false);
  });
});

describe("ModelOnboardingModal", () => {
  describe("step structure", () => {
    it("renders the AI Setup step by default with all three step indicators", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      expect(screen.getByTestId("plugin-slot-onboarding-provider-card")).toBeInTheDocument();
      expect(screen.getByTestId("plugin-slot-onboarding-recommendation-card")).toBeInTheDocument();
      expect(screen.getByTestId("plugin-slot-onboarding-setup-help")).toBeInTheDocument();

      // Check step indicators
      expect(screen.getByText("AI Setup")).toBeTruthy();
      expect(screen.getByText("GitHub")).toBeTruthy();
      expect(screen.getByText("First Task")).toBeTruthy();

      // Check that AI Setup step is active
      expect(screen.getByText("AI Setup").closest(".model-onboarding-step-indicator")).toHaveClass("active");
    });

    it("shows Next button on first step, not Back", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Next →")).toBeTruthy();
      });

      // Back button should not exist on first step
      expect(screen.queryByText("← Back")).toBeNull();
    });

    it("shows Skip for now button on non-terminal steps", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Skip for now")).toBeTruthy();
      });
    });

    it("hides the redundant Skip for now on AI Setup once a provider is connected", async () => {
      // FNXC:Onboarding 2026-07-10-10:40: with a connected provider the user has effectively
      // completed the step, so only "Skip setup →" and "Next →" remain in the footer.
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Next →" })).toBeTruthy();
      });

      expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
      expect(screen.getByRole("button", { name: "Skip setup →" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Next →" })).toBeTruthy();
    });

    // FNXC:Onboarding 2026-07-03: the "Research runs require provider credentials and an enabled
    // Research View" note was intentionally removed from onboarding at the operator's request (it
    // belongs in Settings, not first-run), so the assertion that it renders no longer applies.

    it("hides deprecated google CLI and antigravity providers while keeping supported Google/Gemini entries", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "google", name: "Google", authenticated: false, type: "api_key" },
          { id: "gemini", name: "Gemini", authenticated: false, type: "api_key" },
          { id: "google-antigravity", name: "Google Antigravity", authenticated: false, type: "oauth" },
          { id: "antigravity", name: "Antigravity", authenticated: false, type: "oauth" },
          { id: "google-gemini-cli", name: "Google Gemini CLI", authenticated: false, type: "cli" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      expect(await screen.findByTestId("onboarding-provider-card-google")).toBeInTheDocument();
      expect(screen.getByTestId("onboarding-provider-card-gemini")).toBeInTheDocument();
      expect(screen.queryByTestId("onboarding-provider-card-google-antigravity")).not.toBeInTheDocument();
      expect(screen.queryByTestId("onboarding-provider-card-antigravity")).not.toBeInTheDocument();
      expect(screen.queryByText("Google Gemini CLI")).not.toBeInTheDocument();
    });

    it("shows Back and Next buttons on middle steps", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      // Both Back and Next should be visible
      expect(screen.getByText("← Back")).toBeTruthy();
      expect(screen.getByText("Next →")).toBeTruthy();
    });
  });

  describe("skip vs complete step tracking (FN-1937)", () => {
    it("does not mark AI Setup step as completed when Skip setup is clicked", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Skip setup →" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Skip setup →" }));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      const aiSetupIndicator = screen.getByRole("button", { name: "Go back to AI Setup" });
      expect(aiSetupIndicator).toHaveClass("skipped");
      expect(aiSetupIndicator).not.toHaveClass("done");
      expect(aiSetupIndicator.querySelector('[data-testid="icon-check-circle"]')).toBeNull();
    });

    it("marks AI Setup step as completed when Next is clicked", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Next →" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Next →" }));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      const aiSetupIndicator = screen.getByRole("button", { name: "Go back to AI Setup" });
      expect(aiSetupIndicator).toHaveClass("done");
      expect(aiSetupIndicator).not.toHaveClass("skipped");
    });

    it("does not add step to completedSteps when skipped", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Skip setup →" })).toBeTruthy();
      });

      mockSaveOnboardingState.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Skip setup →" }));

      await waitFor(() => {
        const hasSkipPersistence = mockSaveOnboardingState.mock.calls.some((call) => {
          const options = call[1] as { completedSteps?: string[]; skippedSteps?: string[] } | undefined;
          return !options?.completedSteps?.includes("ai-setup") && options?.skippedSteps?.includes("ai-setup");
        });
        expect(hasSkipPersistence).toBe(true);
      });
    });

    it("shows dash icon for skipped step in progress indicator", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Skip setup →" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Skip setup →" }));

      await waitFor(() => {
        const skipMark = document.querySelector(".onboarding-step-skip-mark");
        expect(skipMark).toBeTruthy();
        expect(skipMark).toHaveTextContent("–");
      });
    });

    it("allows going back to a skipped step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Skip setup →" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Skip setup →" }));
      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "← Back" }));
      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });
    });

    it("removes skipped status when step is completed after going back", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Skip setup →" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Skip setup →" }));
      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Go back to AI Setup" }));
      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      mockSaveOnboardingState.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Next →" }));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      const aiSetupIndicator = screen.getByRole("button", { name: "Go back to AI Setup" });
      expect(aiSetupIndicator).toHaveClass("done");
      expect(aiSetupIndicator).not.toHaveClass("skipped");

      const hasCompletedPersistence = mockSaveOnboardingState.mock.calls.some((call) => {
        const options = call[1] as { completedSteps?: string[]; skippedSteps?: string[] } | undefined;
        return options?.completedSteps?.includes("ai-setup") && !options?.skippedSteps?.includes("ai-setup");
      });
      expect(hasCompletedPersistence).toBe(true);
    });

    it("skipped step is clickable in progress indicator", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Skip setup →" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Skip setup →" }));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      const aiSetupIndicator = screen.getByRole("button", { name: "Go back to AI Setup" });
      expect(aiSetupIndicator).toHaveClass("skipped");

      fireEvent.click(aiSetupIndicator);
      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });
    });
  });

  describe("AI Setup step", () => {
    it("shows OAuth providers with Login button", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("OpenAI")).toBeTruthy();
      });

      expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      expect(screen.getByTestId("onboarding-apikey-save-openai")).toBeTruthy();
    });

    it("shows provider-specific API key field label and setup instructions", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("OpenAI API Key")).toBeTruthy();
      });

      expect(screen.queryByText("Create an API key from your OpenAI dashboard under API keys.")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Advanced setup details/ }));

      expect(
        screen.getByText("Create an API key from your OpenAI dashboard under API keys."),
      ).toBeTruthy();
    });

    it("shows dashboard link for API key provider after expanding setup details", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Advanced setup details/ })).toBeTruthy();
      });

      expect(screen.queryByRole("link", { name: "Get your API key →" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Advanced setup details/ }));

      const keyLink = screen.getByRole("link", { name: "Get your API key →" });
      expect(keyLink.getAttribute("href")).toBe("https://platform.openai.com/api-keys");
      expect(keyLink.getAttribute("target")).toBe("_blank");
    });

    it("renders OAuth and API key providers at the same time", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
        expect(screen.getByText("OpenAI")).toBeTruthy();
      });

      expect(screen.getByText("Login")).toBeTruthy();
      expect(screen.getByTestId("onboarding-apikey-save-openai")).toBeTruthy();
    });

    it("shows quick-start section and always-visible one-provider helper copy", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-quick-start-providers")).toBeTruthy();
      });

      expect(screen.getByText("Quick start providers")).toBeTruthy();
      expect(screen.getByText("You only need one provider to get started.")).toBeTruthy();
      expect(screen.getByRole("button", { name: /Advanced provider settings/ })).toBeTruthy();
    });

    it("orders practical quick-start providers without showing filtered providers", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "minimax", name: "MiniMax", authenticated: false, type: "api_key" },
          { id: "ollama", name: "Ollama", authenticated: false, type: "api_key" },
          { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" },
          { id: "google-antigravity", name: "Google Antigravity", authenticated: false, type: "oauth" },
          { id: "google", name: "Google", authenticated: false, type: "api_key" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      const quickStartSection = await screen.findByTestId("onboarding-quick-start-providers");
      expect(getProviderOrderInSection(quickStartSection)).toEqual(["anthropic", "openai", "google", "openrouter", "ollama"]);
      expect(screen.queryByTestId("onboarding-provider-card-google-antigravity")).toBeNull();
    });

    it("preserves split Anthropic quick-start cards and suppresses legacy Anthropic fallback", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "anthropic-api-key", name: "Anthropic API Key", authenticated: false, type: "api_key" },
          { id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      const quickStartSection = await screen.findByTestId("onboarding-quick-start-providers");
      expect(getProviderOrderInSection(quickStartSection)).toEqual(["anthropic-subscription", "anthropic-api-key", "openai"]);
      expect(within(quickStartSection).queryByTestId("onboarding-provider-card-anthropic")).toBeNull();
    });

    it("keeps advanced providers hidden by default until advanced settings is expanded", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "minimax", name: "MiniMax", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      expect(screen.queryByText("MiniMax")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Advanced provider settings/ }));

      await waitFor(() => {
        expect(screen.getByText("MiniMax")).toBeTruthy();
      });
    });

    it("shows connected non-quick-start providers outside the collapsed advanced section", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "minimax", name: "MiniMax", authenticated: true, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-connected-providers")).toBeTruthy();
      });

      const connectedSection = screen.getByTestId("onboarding-connected-providers");
      expect(within(connectedSection).getByText("MiniMax")).toBeTruthy();
      expect(screen.queryByTestId("onboarding-provider-card-minimax")).toBeTruthy();
      expect(screen.queryByTestId("onboarding-advanced-provider-settings")).toBeNull();
    });

    it("surfaces connected quick-start providers in the Connected section at the top of the step", async () => {
      /*
      FNXC:Onboarding 2026-07-10-10:15:
      After connecting a provider the user must immediately see it on step open, without scrolling:
      ALL connected providers render in "Connected providers" ABOVE quick start, and the connected
      provider leaves the quick-start list.
      */
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      const connectedSection = await screen.findByTestId("onboarding-connected-providers");
      expect(getProviderOrderInSection(connectedSection)).toEqual(["anthropic"]);

      const quickStartSection = screen.getByTestId("onboarding-quick-start-providers");
      expect(getProviderOrderInSection(quickStartSection)).toEqual(["openai"]);
      expect(
        connectedSection.compareDocumentPosition(quickStartSection) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // The "N of M providers connected" summary keeps working with the new layout.
      expect(screen.getByTestId("provider-summary")).toHaveTextContent("1 of 2 providers connected");
    });

    it("renders onboarding provider icon wrapper for connected advanced providers", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "minimax", name: "MiniMax", authenticated: true, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      const minimaxWrapper = await screen.findByTestId("onboarding-provider-icon-minimax");
      expect(within(minimaxWrapper).getByTestId("provider-icon")).toHaveAttribute("data-provider", "minimax");
    });

    it("places the single advanced-provider disclosure inside quick start before default model selection", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      const quickStartSection = await screen.findByTestId("onboarding-quick-start-providers");
      const advancedButtons = screen.getAllByRole("button", { name: /Advanced provider settings/ });
      expect(advancedButtons).toHaveLength(1);
      expect(quickStartSection).toContainElement(advancedButtons[0]);

      const defaultModelHeading = screen.getByText("Default Model (Optional)");
      expect(
        quickStartSection.compareDocumentPosition(defaultModelHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("shows empty advanced state when every visible provider is already quick-start", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      expect(await screen.findByTestId("onboarding-quick-start-providers")).toBeTruthy();
      expect(screen.queryByTestId("onboarding-advanced-provider-settings")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /Advanced provider settings/ }));

      expect(await screen.findByTestId("onboarding-advanced-provider-settings")).toHaveTextContent(
        "All currently available providers are already shown above.",
      );
    });

    it("keeps existing custom providers and add-custom controls in the quick-start advanced area", async () => {
      mockFetchCustomProviders.mockResolvedValueOnce({
        providers: [
          { id: "custom-openai", name: "Custom OpenAI", baseUrl: "https://example.com", api: "openai-responses", models: [] },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      const quickStartSection = await screen.findByTestId("onboarding-quick-start-providers");
      fireEvent.click(within(quickStartSection).getByRole("button", { name: /Advanced provider settings/ }));

      const advancedPanel = await screen.findByTestId("onboarding-advanced-provider-settings");
      expect(within(advancedPanel).getByText("Custom OpenAI")).toBeTruthy();
      expect(within(advancedPanel).getByRole("button", { name: /Add custom provider/ })).toBeTruthy();
    });

    it("shows the no-provider empty state without rendering leftover advanced-provider controls", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({ providers: [] });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      expect(await screen.findByText("No AI providers are configured. Please check your Fusion configuration.")).toBeTruthy();
      expect(screen.queryByTestId("onboarding-quick-start-providers")).toBeNull();
      expect(screen.queryByRole("button", { name: /Advanced provider settings/ })).toBeNull();
    });

    it("shows model dropdown in AI Setup step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Default Model (Optional)")).toBeTruthy();
      });

      expect(screen.getByTestId("mock-model-dropdown")).toBeTruthy();
    });

    it("allows model selection in AI Setup step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("mock-model-dropdown")).toBeTruthy();
      });

      const dropdown = screen.getByTestId("mock-model-dropdown");
      fireEvent.change(dropdown, { target: { value: "anthropic/claude-sonnet-4-5" } });

      await waitFor(() => {
        expect(screen.getByText(/Claude Sonnet 4\.5/)).toBeTruthy();
      });
    });

    it("initiates OAuth login when Login is clicked without appending token to external provider URLs", async () => {
      localStorage.setItem("fn.authToken", "daemon-token");
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(mockLoginProvider).toHaveBeenCalledWith("anthropic");
        expect(mockWindowOpen).toHaveBeenCalledWith("https://auth.example.com/login", "_blank");
      });
    });

    it("warns before starting manual-code oauth login and stops when cancelled", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth", requiresManualCode: true }],
      });
      vi.spyOn(window, "open").mockImplementation(vi.fn());
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      mockConfirm.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledWith({
          title: "Heads up — manual paste-back required",
          message:
            "After you sign in with Anthropic, the browser will try to redirect to a localhost address that this dashboard can't reach. The redirect tab will look like it failed. Before that happens, copy the full URL from the browser address bar — you'll paste it back here to finish login. Continue?",
          confirmLabel: "Continue to login",
          cancelLabel: "Cancel",
        });
      });
      expect(mockLoginProvider).not.toHaveBeenCalled();
    });

    it("continues manual-code oauth login after confirmation", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth", requiresManualCode: true }],
      });
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      mockConfirm.mockResolvedValueOnce(true);
      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalled();
        expect(mockLoginProvider).toHaveBeenCalledWith("anthropic");
        expect(mockWindowOpen).toHaveBeenCalledWith("https://auth.example.com/login", "_blank");
      });
    });

    it("skips the warning for oauth providers without manual-code fallback", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "google", name: "Google", authenticated: false, type: "oauth" }],
      });
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      const loginButton = await screen.findByText("Login");
      fireEvent.click(loginButton);

      await waitFor(() => {
        expect(mockConfirm).not.toHaveBeenCalled();
        expect(mockLoginProvider).toHaveBeenCalledWith("google");
        expect(mockWindowOpen).toHaveBeenCalledWith("https://auth.example.com/login", "_blank");
      });
    });

    it("appends daemon query token for same-origin OAuth login popup URLs", async () => {
      localStorage.setItem("fn.authToken", "daemon-token");
      mockLoginProvider.mockResolvedValueOnce({ url: "/api/auth/providers/anthropic/login?state=xyz" });
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(mockWindowOpen).toHaveBeenCalledWith(
          "/api/auth/providers/anthropic/login?state=xyz&fn_token=daemon-token",
          "_blank",
        );
      });
    });

    it("shows Anthropic pasted-code form and submits manual code", async () => {
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://claude.ai/oauth/authorize",
        manualCode: {
          prompt: "Paste the final redirect URL or authorization code",
          placeholder: "http://localhost:*/callback?code=...&state=... or just the code",
          helpText: "After Claude sign-in, copy the full browser URL (or just the code) and paste it here to finish login from this dashboard host.",
        },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      const prompt = await screen.findByText("Paste the final redirect URL or authorization code");
      const card = prompt.closest(".onboarding-provider-card") as HTMLElement;
      const textbox = within(card).getByRole("textbox");
      fireEvent.change(textbox, { target: { value: "anthropic-code" } });
      fireEvent.click(within(card).getByRole("button", { name: "Submit code" }));

      await waitFor(() => {
        expect(mockSubmitProviderManualCode).toHaveBeenCalledWith("anthropic", "anthropic-code");
      });
      expect(mockWindowOpen).toHaveBeenCalled();
    });

    it("scrolls the onboarding manual-code input into view on mobile focus", async () => {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)" || query === "(pointer: coarse)",
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });

      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });

      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://claude.ai/oauth/authorize",
        manualCode: {
          prompt: "Paste the final redirect URL or authorization code",
        },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      const prompt = await screen.findByText("Paste the final redirect URL or authorization code");
      const card = prompt.closest(".onboarding-provider-card") as HTMLElement;
      const textarea = within(card).getByRole("textbox");
      const scrollIntoView = vi.fn();
      Object.defineProperty(textarea, "scrollIntoView", {
        value: scrollIntoView,
        writable: true,
      });

      fireEvent.focus(textarea);

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalled();
      });
      expect(mockWindowOpen).toHaveBeenCalled();
    });

    it("renders github copilot device-code panel in onboarding", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const addToast = vi.fn();
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });

      mockFetchAuthStatus
        .mockResolvedValueOnce({
          providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth" }],
        })
        .mockResolvedValueOnce({
          providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth", loginInProgress: true }],
        })
        .mockResolvedValueOnce({
          providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: true, type: "oauth" }],
        });
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://auth.example.com/login",
        instructions: "Enter code: ABCD-1234",
        deviceCode: {
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
        },
      });

      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Advanced provider settings/ })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: /Advanced provider settings/ }));

      const copilotCard = await screen.findByTestId("onboarding-provider-card-github-copilot");
      fireEvent.click(within(copilotCard).getByRole("button", { name: "Login" }));

      expect(await within(copilotCard).findByText("ABCD-1234")).toBeTruthy();
      expect(within(copilotCard).queryByTestId("onboarding-login-instructions-github-copilot")).toBeNull();
      expect(mockWindowOpen).not.toHaveBeenCalled();
      expect(writeText).toHaveBeenCalledWith("ABCD-1234");
      expect(writeText).toHaveBeenCalledTimes(1);

      fireEvent.click(within(copilotCard).getByRole("button", { name: "Copy code" }));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("ABCD-1234");
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(addToast).toHaveBeenCalledWith("Copied code to clipboard", "success");
      });

      fireEvent.click(within(copilotCard).getByRole("button", { name: "Open GitHub" }));
      expect(mockWindowOpen).toHaveBeenCalledWith("https://github.com/login/device", "_blank");
    });

    it("uses execCommand fallback in onboarding when clipboard API is unavailable", async () => {
      const addToast = vi.fn();
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      const execSpy = vi.fn().mockReturnValue(true);
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: execSpy,
      });

      mockFetchAuthStatus
        .mockResolvedValueOnce({ providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth" }] })
        .mockResolvedValueOnce({ providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth", loginInProgress: true }] });
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://auth.example.com/login",
        deviceCode: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Advanced provider settings/ })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: /Advanced provider settings/ }));
      const copilotCard = await screen.findByTestId("onboarding-provider-card-github-copilot");
      fireEvent.click(within(copilotCard).getByRole("button", { name: "Login" }));
      await within(copilotCard).findByText("ABCD-1234");

      fireEvent.click(within(copilotCard).getByRole("button", { name: "Copy code" }));
      await waitFor(() => {
        expect(execSpy).toHaveBeenCalledWith("copy");
        expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Copied"), "success");
      });
    });

    it("shows error toast in onboarding when clipboard and fallback fail", async () => {
      const addToast = vi.fn();
      const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: vi.fn().mockReturnValue(false),
      });

      mockFetchAuthStatus
        .mockResolvedValueOnce({ providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth" }] })
        .mockResolvedValueOnce({ providers: [{ id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth", loginInProgress: true }] });
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://auth.example.com/login",
        deviceCode: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Advanced provider settings/ })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: /Advanced provider settings/ }));
      const copilotCard = await screen.findByTestId("onboarding-provider-card-github-copilot");
      fireEvent.click(within(copilotCard).getByRole("button", { name: "Login" }));
      await within(copilotCard).findByText("ABCD-1234");

      fireEvent.click(within(copilotCard).getByRole("button", { name: "Copy code" }));
      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(expect.stringContaining("manually"), "error");
      });
    });

    it("keeps OpenAI Codex manual-code UX available in onboarding", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "openai-codex", name: "OpenAI Codex", authenticated: false, type: "oauth" }],
      });
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://auth.openai.com/oauth/authorize",
        manualCode: {
          prompt: "Paste the final redirect URL or authorization code",
          placeholder: "http://localhost:1455/auth/callback?code=...&state=... or just the code",
          helpText: "After sign-in, OpenAI may redirect to a localhost callback that cannot open from this dashboard host. Copy the full browser URL from the address bar and paste it here.",
        },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Advanced provider settings/ })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: /Advanced provider settings/ }));

      await waitFor(() => {
        expect(screen.getByText("OpenAI Codex")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      expect(await screen.findByText("Paste the final redirect URL or authorization code")).toBeTruthy();
      expect(screen.getByText(/OpenAI may redirect to a localhost callback/)).toBeTruthy();
    });

    it("saves API key when Save is clicked", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

    it("scrolls onboarding content to top after successful API key save", async () => {
      mockFetchAuthStatus
        .mockResolvedValueOnce({
          providers: [
            { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
            { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
          ],
        })
        .mockResolvedValueOnce({
          providers: [
            { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
            { id: "openai", name: "OpenAI", authenticated: true, type: "api_key" },
          ],
        });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const content = document.querySelector(".model-onboarding-content") as HTMLDivElement;
      expect(content).toBeTruthy();
      const scrollToMock = vi.fn();
      Object.defineProperty(content, "scrollTo", {
        value: scrollToMock,
        writable: true,
      });
      content.scrollTop = 240;

      fireEvent.change(screen.getByTestId("onboarding-apikey-input-openai"), {
        target: { value: "sk-scroll-success" },
      });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(mockSaveApiKey).toHaveBeenCalledWith("openai", "sk-scroll-success");
        expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
      });

      await waitFor(() => {
        expect(screen.getByText("✓ API key saved")).toBeTruthy();
      });
    });

    it("does not scroll onboarding content to top when API key save fails", async () => {
      mockSaveApiKey.mockRejectedValueOnce(new Error("save failed"));
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const content = document.querySelector(".model-onboarding-content") as HTMLDivElement;
      expect(content).toBeTruthy();
      const scrollToMock = vi.fn();
      Object.defineProperty(content, "scrollTo", {
        value: scrollToMock,
        writable: true,
      });
      content.scrollTop = 180;

      fireEvent.change(screen.getByTestId("onboarding-apikey-input-openai"), {
        target: { value: "sk-scroll-fail" },
      });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(screen.getByText("save failed")).toBeTruthy();
      });

      expect(scrollToMock).not.toHaveBeenCalled();
      expect(content.scrollTop).toBe(180);
    });

    it("submits API key when Enter is pressed", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("GPT models — versatile for a wide range of tasks")).toBeTruthy();
      });

      // Verify the description is inside a provider card
      const description = screen.getByText("GPT models — versatile for a wide range of tasks");
      expect(description.closest(".onboarding-provider-card")).toBeTruthy();
    });

    it("renders cursor cli provider card when cursor provider is present", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "cursor-cli", name: "Cursor — via Cursor CLI", authenticated: true, type: "cli" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      expect(await screen.findByTestId("cursor-cli-provider-card")).toBeInTheDocument();
      expect(screen.getByText("Cursor — via Cursor CLI")).toBeInTheDocument();
      expect(screen.queryByLabelText("Cursor CLI binary path")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save & Test" })).not.toBeInTheDocument();
    });

    it("renders stable onboarding-provider-icon wrappers for provider cards", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
        expect(screen.getByText("OpenAI")).toBeTruthy();
      });

      const anthropicIconWrapper = screen.getByTestId("onboarding-provider-icon-anthropic");
      const openaiIconWrapper = screen.getByTestId("onboarding-provider-icon-openai");

      expect(within(anthropicIconWrapper).getByTestId("provider-icon")).toHaveAttribute("data-provider", "anthropic");
      expect(within(openaiIconWrapper).getByTestId("provider-icon")).toHaveAttribute("data-provider", "openai");
    });

    it("applies connected modifier class to authenticated provider cards", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      const { container } = render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Advanced provider settings/ })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: /Advanced provider settings/ }));

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Advanced provider settings/ })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: /Advanced provider settings/ }));

      await waitFor(() => {
        expect(screen.getByText("API Key")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /Advanced setup details/ }));
      expect(screen.getByText("Enter your API key for this provider.")).toBeTruthy();
    });
  });

  describe("API key validation and error feedback", () => {
    it("shows required validation when API key is empty", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(screen.getByText("API key is required")).toBeTruthy();
      });
      expect(mockSaveApiKey).not.toHaveBeenCalled();
    });

    it("shows format validation for known provider and blocks save", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "abc" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(
          screen.getByText("OpenAI keys should follow this format: Starts with sk- (e.g. sk-...)"),
        ).toBeTruthy();
      });
      expect(mockSaveApiKey).not.toHaveBeenCalled();
    });

    it("passes valid format to server", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "sk-test-key" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(mockSaveApiKey).toHaveBeenCalledWith("openai", "sk-test-key");
      });
    });

    it("shows actionable network error message", async () => {
      mockSaveApiKey.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "sk-network-test" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(screen.getByText("Could not reach the server. Check your connection and try again.")).toBeTruthy();
      });
      expect(input).toHaveClass("onboarding-apikey-input--error");
    });

    it("shows server error message inline", async () => {
      mockSaveApiKey.mockRejectedValueOnce(new Error("Unknown API key provider: xyz"));
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "sk-server-test" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(screen.getByText("Unknown API key provider: xyz")).toBeTruthy();
      });
      expect(input).toHaveClass("onboarding-apikey-input--error");
    });

    it("shows inline success confirmation", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "sk-success-test" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-success-openai")).toHaveTextContent("✓ Key saved");
      });
      expect(input).toHaveClass("onboarding-apikey-input--success");
    });

    it("auto-clears success message after timeout", async () => {
      vi.useFakeTimers();
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await act(async () => {
        await Promise.resolve();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "sk-timeout-test" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByTestId("onboarding-apikey-success-openai")).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(3100);
      });

      expect(screen.queryByTestId("onboarding-apikey-success-openai")).toBeNull();
    });

    it("clears inline error state when input changes", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      const formatError = "OpenAI keys should follow this format: Starts with sk- (e.g. sk-...)";
      fireEvent.change(input, { target: { value: "abc" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(screen.getByText(formatError)).toBeTruthy();
      });
      expect(input).toHaveClass("onboarding-apikey-input--error");

      fireEvent.change(input, { target: { value: "sk-corrected" } });

      await waitFor(() => {
        expect(screen.queryByText(formatError)).toBeNull();
      });
      expect(input).not.toHaveClass("onboarding-apikey-input--error");
    });

    it("clears inline success state when input changes", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "sk-before-edit" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-success-openai")).toBeTruthy();
      });
      expect(input).toHaveClass("onboarding-apikey-input--success");

      fireEvent.change(input, { target: { value: "sk-after-edit" } });

      await waitFor(() => {
        expect(screen.queryByTestId("onboarding-apikey-success-openai")).toBeNull();
      });
      expect(input).not.toHaveClass("onboarding-apikey-input--success");
    });

    it("shows format hint for known providers after expanding setup details", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Advanced setup details/ })).toBeTruthy();
      });

      expect(screen.queryByText("Format: Starts with sk-")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Advanced setup details/ }));

      await waitFor(() => {
        expect(screen.getByText("Format: Starts with sk-")).toBeTruthy();
      });
    });

    it("uses fallback validation for unknown providers", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "mystery-provider", name: "Mystery AI", authenticated: false, type: "api_key" },
        ],
      });
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Advanced provider settings/ })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: /Advanced provider settings/ }));

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-mystery-provider")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-mystery-provider");
      fireEvent.change(input, { target: { value: "short" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-mystery-provider"));

      await waitFor(() => {
        expect(screen.getByText(/At least 8 characters/)).toBeTruthy();
      });
      expect(mockSaveApiKey).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: "longenoughkey" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-mystery-provider"));

      await waitFor(() => {
        expect(mockSaveApiKey).toHaveBeenCalledWith("mystery-provider", "longenoughkey");
      });
    });

    it("allows skipping and continuing even when validation errors exist", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "abc" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(
          screen.getByText("OpenAI keys should follow this format: Starts with sk- (e.g. sk-...)"),
        ).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Skip setup →" }));
      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "← Back" }));
      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Next →" }));
      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });
    });
  });

  describe("GitHub step", () => {
    it("GitHub step shows optional fallback when neither OAuth nor gh CLI auth is available", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.getByText(/Dashboard GitHub OAuth is not configured/)).toBeTruthy();
      expect(screen.getByText(/GitHub CLI setup guidance above/)).toBeTruthy();
      // FNXC:Onboarding 2026-07-10-10:35: the in-body "Continue without GitHub →" CTA was
      // removed — footer "Skip GitHub →" is the single skip affordance for this step.
      expect(screen.queryByRole("button", { name: "Continue without GitHub →" })).toBeNull();
      expect(screen.getByRole("button", { name: "Skip GitHub →" })).toBeTruthy();
    });

    it("shows feature availability callout on GitHub step", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      const featureCallout = document.querySelector(".onboarding-feature-list");
      expect(featureCallout).toBeTruthy();
      expect(featureCallout).toHaveTextContent("Without GitHub");
      expect(featureCallout).toHaveTextContent("With GitHub");
      expect(featureCallout).toHaveTextContent("Create tasks manually");
      expect(featureCallout).toHaveTextContent("Import issues as tasks");

      const ctaContainer = screen.getByTestId("onboarding-github-connect-cta");
      expect(ctaContainer).toHaveClass("onboarding-github-connect-cta");
      const connectButton = screen.getByRole("button", { name: /Connect GitHub OAuth/ });
      expect(connectButton).toHaveClass("btn", "btn-primary", "btn-sm");
    });

    it("GitHub step description mentions task creation works without GitHub", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.getByText(/task creation works without it/i)).toBeTruthy();
    });

    it("shows a low-noise installed Git prerequisite note without replacing GitHub auth state", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
        gitCli: { available: true, version: "2.45.1", installUrl: "https://git-scm.com/downloads" },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      const prerequisite = screen.getByTestId("onboarding-git-prerequisite");
      expect(prerequisite).toHaveClass("onboarding-github-git-prerequisite--ready");
      expect(prerequisite).toHaveTextContent("Git prerequisite ready");
      expect(prerequisite).toHaveTextContent("2.45.1");
      expect(screen.getByTestId("github-status-badge")).toHaveTextContent("Not connected");
      expect(screen.getByRole("button", { name: /Connect/ })).toBeTruthy();
    });

    it("shows platform-aware install guidance when Git is missing on the Fusion host", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
        gitCli: { available: false, installUrl: "https://git-scm.com/downloads" },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      const prerequisite = screen.getByTestId("onboarding-git-prerequisite");
      expect(prerequisite).toHaveAttribute("role", "alert");
      expect(prerequisite).toHaveClass("onboarding-github-git-prerequisite--missing");
      expect(prerequisite).toHaveTextContent("Install Git before project setup");
      expect(prerequisite).toHaveTextContent("server host running Fusion");
      expect(prerequisite).toHaveTextContent("macOS");
      expect(prerequisite).toHaveTextContent("Windows");
      expect(prerequisite).toHaveTextContent("Linux");
      expect(screen.getByRole("link", { name: "Open Git install downloads" })).toHaveAttribute("href", "https://git-scm.com/downloads");
      expect(screen.getByRole("button", { name: /Connect/ })).toBeTruthy();
      expect(screen.getByText("No worries if you're not ready — connect GitHub anytime from Settings → Authentication.")).toBeTruthy();
    });

    it("keeps legacy auth status responses without gitCli free of empty prerequisite shells", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.queryByTestId("onboarding-git-prerequisite")).toBeNull();
      expect(screen.getByTestId("github-status-badge")).toHaveTextContent("Not connected");
    });

    it("keeps legacy auth status responses without ghCli non-blocking", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [],
        gitCli: { available: true, version: "2.45.1", installUrl: "https://git-scm.com/downloads" },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.getByTestId("onboarding-git-prerequisite")).toHaveTextContent("Git prerequisite ready");
      expect(screen.queryByTestId("github-status-badge")).toBeNull();
      expect(screen.queryByRole("button", { name: "Continue without GitHub →" })).toBeNull();
      expect(screen.getByRole("button", { name: "Skip GitHub →" })).toBeTruthy();
    });

    it("does not treat GitHub Copilot provider auth as GitHub integration readiness", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github-copilot", name: "GitHub Copilot", authenticated: true, type: "oauth" },
        ],
        ghCli: { available: false, authenticated: false },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.queryByTestId("github-status-badge")).toBeNull();
      expect(screen.getByText(/Dashboard GitHub OAuth is not configured/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Continue without GitHub →" })).toBeNull();
      expect(screen.getByRole("button", { name: "Skip GitHub →" })).toBeTruthy();
      expect(screen.queryByText(/GitHub is connected — issue imports/)).toBeNull();
    });

    it("models installed but unauthenticated gh CLI as not ready while preserving OAuth connect", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
        ghCli: { available: true, authenticated: false },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.getByTestId("github-status-badge")).toHaveTextContent("Not connected");
      const authCard = screen.getByTestId("onboarding-gh-cli-auth-card");
      expect(authCard).toHaveTextContent("Authenticate GitHub CLI");
      expect(authCard).toHaveTextContent("gh auth login");
      expect(screen.getByRole("button", { name: /Connect GitHub OAuth/ })).toBeTruthy();
      expect(screen.getByText(/task creation works without it/i)).toBeTruthy();
    });

    it("models missing gh CLI as not ready while preserving optional skip", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
        ghCli: { available: false, authenticated: false },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.getByTestId("github-status-badge")).toHaveTextContent("Not connected");
      const installCard = screen.getByTestId("onboarding-gh-cli-install-card");
      expect(installCard).toHaveTextContent("Install GitHub CLI");
      expect(installCard).toHaveTextContent("host running Fusion");
      // FNXC:Onboarding 2026-07-10-10:30: the per-OS install wall of text is collapsed
      // behind a single disclosure; expand it to see the platform instructions, and the
      // `gh` / `brew install gh` commands render as real <code> elements.
      expect(installCard).not.toHaveTextContent("macOS");
      fireEvent.click(within(installCard).getByRole("button", { name: /Show install instructions/ }));
      expect(installCard).toHaveTextContent("macOS");
      expect(installCard).toHaveTextContent("Windows");
      expect(installCard).toHaveTextContent("Linux");
      expect(installCard.querySelector("code")).toBeTruthy();
      expect(installCard).not.toHaveTextContent("`gh`");
      expect(screen.getByRole("link", { name: "Open GitHub CLI releases" })).toHaveAttribute("href", "https://github.com/cli/cli/releases/latest");
      expect(screen.getByRole("button", { name: /Connect GitHub OAuth/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Skip GitHub →" })).toBeTruthy();
    });

    it("shows GitHub CLI install guidance even when dashboard GitHub OAuth provider is absent", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [],
        ghCli: { available: false, authenticated: false },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.getByTestId("onboarding-gh-cli-install-card")).toHaveTextContent("Install GitHub CLI");
      expect(screen.getByText(/Dashboard GitHub OAuth is not configured/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Connect GitHub OAuth/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Continue without GitHub →" })).toBeNull();
      expect(screen.getByRole("button", { name: "Skip GitHub →" })).toBeTruthy();
    });

    it("preserves missing-Git guidance when GitHub OAuth provider is absent and gh CLI is ready", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [],
        ghCli: { available: true, authenticated: true },
        gitCli: { available: false, installUrl: "https://git-scm.com/downloads" },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.getByTestId("onboarding-git-prerequisite")).toHaveTextContent("Install Git before project setup");
      expect(screen.getByRole("button", { name: "Continue with gh CLI auth →" })).toBeTruthy();
      // FN-7624: no `github` OAuth provider is registered here (providers: []), so no dashboard
      // OAuth login affordance may render — clicking it used to call handleLogin("github") against
      // a provider that does not exist, surfacing a login error. Only the gh-CLI continue path is offered.
      expect(screen.queryByRole("button", { name: /Connect OAuth/ })).toBeNull();
    });

    it("FN-7624: never renders a dashboard GitHub OAuth login affordance when no github OAuth provider is registered, across all gh CLI states", async () => {
      const scenarios: Array<{ label: string; ghCli?: { available: boolean; authenticated: boolean } }> = [
        { label: "gh CLI missing", ghCli: { available: false, authenticated: false } },
        { label: "gh CLI unauthenticated", ghCli: { available: true, authenticated: false } },
        { label: "gh CLI authenticated", ghCli: { available: true, authenticated: true } },
      ];

      for (const scenario of scenarios) {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [],
          ghCli: scenario.ghCli,
        });

        const { unmount } = render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

        await navigateToGitHubStep();

        // No OAuth login trigger of any kind should render — no "Connect GitHub OAuth", no
        // "Connect OAuth (optional)", no leftover empty CTA wrapper — since providerAvailable is false.
        expect(screen.queryByRole("button", { name: /Connect OAuth/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /Connect GitHub OAuth/ })).toBeNull();
        expect(screen.queryByTestId("onboarding-github-connect-cta")).toBeNull();

        unmount();
      }
    });

    it("does not show a Git prerequisite shell when auth status fails to load", async () => {
      mockFetchAuthStatus.mockRejectedValueOnce(new Error("auth unavailable"));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.queryByTestId("onboarding-git-prerequisite")).toBeNull();
      expect(screen.queryByRole("button", { name: "Continue without GitHub →" })).toBeNull();
      expect(screen.getByRole("button", { name: "Skip GitHub →" })).toBeTruthy();
    });

    it("GitHub step shows connected state when already authenticated", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      // The "what GitHub unlocks" feature list is intentionally hidden when
      // GitHub is already connected — the modal renders a confirmation
      // sentence and the Disconnect control instead.
      expect(
        screen.getByText(
          /GitHub is connected — issue imports and pull request tracking are available/,
        ),
      ).toBeTruthy();
      expect(screen.getByTestId("onboarding-auth-status-github")).toBeTruthy();
      expect(screen.getByText("✓ Connected")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
      expect(screen.queryByTestId("onboarding-github-connect-cta")).toBeNull();
    });

    it("state-driven GitHub step: a ready connection suppresses install/auth guidance and the feature pitch", async () => {
      /*
      FNXC:Onboarding 2026-07-10-10:30:
      Surface Enumeration for the state-driven step: when GitHub is ready via EITHER path (OAuth or
      gh CLI), neither gh CLI setup card nor the with/without feature list may render — one primary
      path per state. Previously an OAuth-connected user was still told to install the GitHub CLI.
      */
      const readyScenarios = [
        {
          label: "OAuth connected, gh missing",
          providers: [{ id: "github", name: "GitHub", authenticated: true, type: "oauth" }],
          ghCli: { available: false, authenticated: false },
        },
        {
          label: "OAuth connected, gh unauthenticated",
          providers: [{ id: "github", name: "GitHub", authenticated: true, type: "oauth" }],
          ghCli: { available: true, authenticated: false },
        },
        {
          label: "gh authenticated, no OAuth provider",
          providers: [],
          ghCli: { available: true, authenticated: true },
        },
      ];

      for (const scenario of readyScenarios) {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: scenario.providers,
          ghCli: scenario.ghCli,
        });

        const { unmount } = render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

        await navigateToGitHubStep();

        expect(screen.queryByTestId("onboarding-gh-cli-install-card")).toBeNull();
        expect(screen.queryByTestId("onboarding-gh-cli-auth-card")).toBeNull();
        expect(document.querySelector(".onboarding-feature-list")).toBeNull();
        expect(screen.queryByRole("button", { name: "Continue without GitHub →" })).toBeNull();

        unmount();
      }
    });

    it("revalidates GitHub connection status when the window regains focus (mid-session gh auth)", async () => {
      /*
      FNXC:Onboarding 2026-07-10-10:10:
      Regression test for the stale-status bug: the user authenticated the gh CLI in a terminal while
      the wizard stayed open, and later steps still showed GitHub as not connected. Regaining window
      focus must refetch auth/gh status and flip the step to connected.
      */
      mockFetchAuthStatus.mockImplementation(() => Promise.resolve({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
        ghCli: { available: true, authenticated: false },
      }));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.getByTestId("github-status-badge")).toHaveTextContent("Not connected");

      // The user runs `gh auth login` in a terminal, then switches back to the dashboard.
      mockFetchAuthStatus.mockImplementation(() => Promise.resolve({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
        ghCli: { available: true, authenticated: true },
      }));

      fireEvent(window, new Event("focus"));

      await waitFor(() => {
        expect(screen.getByTestId("github-status-badge")).toHaveTextContent("✓ Connected");
      });
      expect(screen.queryByTestId("onboarding-gh-cli-auth-card")).toBeNull();
    });

    it("GitHub step explains gh CLI auth when OAuth provider is absent", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [],
        ghCli: { available: true, authenticated: true },
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      // The new component renders the "GitHub CLI is already authenticated"
      // copy in two places: the top-level description sentence and inside
      // the optional-OAuth explanation block. Both are valid; just confirm
      // at least one match (use getAllByText since there are two).
      expect(
        screen.getAllByText(/GitHub CLI is already authenticated/).length,
      ).toBeGreaterThan(0);
      // The optional-OAuth panel describes that dashboard OAuth is optional.
      expect(
        screen.getByText(/OAuth from the dashboard is optional/),
      ).toBeTruthy();
      expect(screen.queryByTestId("onboarding-github-connect-cta")).toBeNull();
    });

    describe("GitHub connection status feedback", () => {
      it("shows connected status with success feedback", async () => {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
          ],
        });

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

        await navigateToGitHubStep();

        const badge = screen.getByTestId("github-status-badge");
        expect(badge).toHaveTextContent("✓ Connected");
        expect(badge).toHaveClass("connected");
        expect(screen.getByText("GitHub OAuth is connected. You can import issues and track pull requests.")).toBeTruthy();
      });

      it("shows connected feedback when gh CLI is authenticated without GitHub OAuth", async () => {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
          ],
          ghCli: { available: true, authenticated: true },
        });

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

        await navigateToGitHubStep();

        const badge = screen.getByTestId("github-status-badge");
        expect(badge).toHaveTextContent("✓ Connected");
        expect(badge).toHaveClass("connected");
        expect(screen.getByText(/GitHub CLI is authenticated/)).toBeTruthy();
      });

      it("shows not-connected status and keeps default helper text", async () => {
        mockFetchAuthStatus.mockResolvedValueOnce({
          providers: [
            { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
          ],
        });

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

        await navigateToGitHubStep();

        fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

        await waitFor(() => {
          const badge = screen.getByTestId("github-status-badge");
          expect(badge).toHaveTextContent("✗ Connection failed");
          expect(badge).toHaveClass("retry");
        }, { timeout: 3000 });

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

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

        const { unmount } = render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

        await waitFor(() => {
          expect(screen.getByRole("button", { name: "Connect anyway" })).toBeTruthy();
        });

        fireEvent.click(screen.getByRole("button", { name: "Connect anyway" }));

        await waitFor(() => {
          expect(mockLoginProvider).toHaveBeenCalledWith("github");
        });
      });
    });

    it("allows navigating to First Task step via footer Skip GitHub", async () => {
      // FNXC:Onboarding 2026-07-10-10:35: the in-body "Continue without GitHub →" CTA was
      // removed; footer "Skip GitHub →" is the single skip affordance for this step.
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      fireEvent.click(screen.getByText("Skip GitHub →"));

      await waitFor(() => {
        expect(screen.getByText("Set Up Your Project")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Next →"));

      await waitFor(() => {
        expect(screen.getByText("Create Your First Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Skip for now"));

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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
    it("shows a blocking project setup prompt when no project is selected", async () => {
      render(
        <ModelOnboardingModal
          onComplete={vi.fn()}
          addToast={vi.fn()}
          projectId=""
        />,
      );

      await navigateToProjectSetupStep();

      expect(screen.getByTestId("onboarding-project-prerequisite")).toBeTruthy();
      expect(screen.getByText(/A project is required before first-task actions are available/)).toBeTruthy();
      expect(screen.queryByTestId("onboarding-first-task-input")).toBeNull();
      expect(screen.queryByText("Create a New Task")).toBeNull();
      expect(screen.queryByText("Import from GitHub")).toBeNull();
    });

    it("opens setup wizard callback from the blocking project setup prompt", async () => {
      const onOpenSetupWizard = vi.fn();
      render(
        <ModelOnboardingModal
          onComplete={vi.fn()}
          addToast={vi.fn()}
          projectId=""
          onOpenSetupWizard={onOpenSetupWizard}
        />,
      );

      await navigateToProjectSetupStep();

      fireEvent.click(screen.getByTestId("onboarding-open-setup-wizard"));
      expect(onOpenSetupWizard).toHaveBeenCalledTimes(1);
    });

    it("shows CTA options for creating first task", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      expect(screen.getByText("Create a New Task")).toBeTruthy();
      expect(screen.getByText("Import from GitHub")).toBeTruthy();
      expect(screen.getByText("Project selected — task creation and imports are available")).toBeTruthy();
    });

    it("shows empty-description validation and does not call createTask", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-task-error")).toBeTruthy();
      });
      expect(screen.getByText("Please enter a task description.")).toBeTruthy();
      expect(screen.getByText("Create Your First Task")).toBeTruthy();
      expect(mockCreateTask).not.toHaveBeenCalled();
    });

    it("shows server error and preserves typed task description", async () => {
      mockCreateTask.mockRejectedValueOnce(new Error("description is required"));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      const taskInput = screen.getByTestId("onboarding-first-task-input") as HTMLTextAreaElement;
      fireEvent.change(taskInput, { target: { value: "Build a login page" } });
      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));

      await waitFor(() => {
        expect(screen.getByText("description is required")).toBeTruthy();
      });
      expect(taskInput.value).toBe("Build a login page");
      expect(screen.getByText("Create Your First Task")).toBeTruthy();
    });

    it("allows retrying after an error and transitions to created-task success", async () => {
      mockCreateTask
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce({
          id: "FN-2000",
          title: "Build auth",
          description: "Build auth",
        } as Task);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      const taskInput = screen.getByTestId("onboarding-first-task-input") as HTMLTextAreaElement;
      fireEvent.change(taskInput, { target: { value: "Build auth" } });

      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));
      await waitFor(() => {
        expect(screen.getByText("temporary failure")).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));
      await waitFor(() => {
        expect(screen.getByText("Your first task is ready!")).toBeTruthy();
      });

      expect(screen.queryByTestId("onboarding-task-error")).toBeNull();
      expect(mockCreateTask).toHaveBeenCalledTimes(2);
      expect(mockCreateTask).toHaveBeenNthCalledWith(
        1,
        { description: "Build auth", source: { sourceType: "dashboard_ui" } },
        "proj_123",
      );
      expect(mockCreateTask).toHaveBeenNthCalledWith(
        2,
        { description: "Build auth", source: { sourceType: "dashboard_ui" } },
        "proj_123",
      );
    });

    it("disables first-task submit button while creating the task", async () => {
      let resolveCreateTask: ((value: Task) => void) | undefined;
      mockCreateTask.mockImplementationOnce(
        () =>
          new Promise<Task>((resolve) => {
            resolveCreateTask = resolve;
          }),
      );

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      fireEvent.change(screen.getByTestId("onboarding-first-task-input"), {
        target: { value: "Build a login page" },
      });

      const submitButton = screen.getByTestId("onboarding-first-task-submit") as HTMLButtonElement;
      fireEvent.click(submitButton);
      expect(submitButton.disabled).toBe(true);

      resolveCreateTask?.({ id: "FN-3000", title: "login", description: "Build a login page" } as Task);
      await waitFor(() => {
        expect(screen.getByText("Your first task is ready!")).toBeTruthy();
      });
    });

    it("clears first-task creation error as input changes", async () => {
      mockCreateTask.mockRejectedValueOnce(new Error("description is required"));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      const taskInput = screen.getByTestId("onboarding-first-task-input") as HTMLTextAreaElement;
      fireEvent.change(taskInput, { target: { value: "Build a login page" } });
      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-task-error")).toBeTruthy();
      });

      fireEvent.change(taskInput, { target: { value: "Build a login page with OAuth" } });

      await waitFor(() => {
        expect(screen.queryByTestId("onboarding-task-error")).toBeNull();
      });
    });

    it("renders network error message when createTask fails with Failed to fetch", async () => {
      mockCreateTask.mockRejectedValueOnce(new Error("Failed to fetch"));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      fireEvent.change(screen.getByTestId("onboarding-first-task-input"), {
        target: { value: "Build a login page" },
      });
      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));

      await waitFor(() => {
        expect(screen.getByText("Failed to fetch")).toBeTruthy();
      });
    });

    it("uses fallback message when createTask throws a non-Error value", async () => {
      mockCreateTask.mockRejectedValueOnce("unknown");

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      fireEvent.change(screen.getByTestId("onboarding-first-task-input"), {
        target: { value: "Build a login page" },
      });
      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));

      await waitFor(() => {
        expect(
          screen.getByText("Something went wrong creating your task. Please try again."),
        ).toBeTruthy();
      });
    });

    it("shows task-created success view after firstCreatedTask transitions from null", async () => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "first-task",
        completedSteps: ["ai-setup", "github"],
        skippedSteps: [],
        updatedAt: "2026-04-17T00:00:00.000Z",
        dismissed: false,
        completed: false,
        stepData: {},
      });

      const { rerender } = render(
        <ModelOnboardingModal
          onComplete={vi.fn()}
          addToast={vi.fn()}
          firstCreatedTask={null}
        projectId="proj_123" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      rerender(
        <ModelOnboardingModal
          onComplete={vi.fn()}
          addToast={vi.fn()}
          firstCreatedTask={createdTaskMock}
        projectId="proj_123" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Your first task is ready!")).toBeTruthy();
      });

      expect(screen.queryByText("Create a New Task")).toBeNull();
      expect(screen.getByText(createdTaskMock.id)).toBeTruthy();
      expect(screen.getByText("Implement onboarding success flow")).toBeTruthy();
    });

    it("shows the created task ID in the success view", async () => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "first-task",
        completedSteps: ["ai-setup", "github"],
        skippedSteps: [],
        updatedAt: "2026-04-17T00:00:00.000Z",
        dismissed: false,
        completed: false,
        stepData: {},
      });

      const { rerender } = render(
        <ModelOnboardingModal
          onComplete={vi.fn()}
          addToast={vi.fn()}
          firstCreatedTask={null}
        projectId="proj_123" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      rerender(
        <ModelOnboardingModal
          onComplete={vi.fn()}
          addToast={vi.fn()}
          firstCreatedTask={createdTaskMock}
        projectId="proj_123" />,
      );

      await waitFor(() => {
        expect(screen.getByText("FN-0001")).toBeTruthy();
      });
    });

    it("shows the first line of created task description in the success view", async () => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "first-task",
        completedSteps: ["ai-setup", "github"],
        skippedSteps: [],
        updatedAt: "2026-04-17T00:00:00.000Z",
        dismissed: false,
        completed: false,
        stepData: {},
      });

      const { rerender } = render(
        <ModelOnboardingModal
          onComplete={vi.fn()}
          addToast={vi.fn()}
          firstCreatedTask={null}
        projectId="proj_123" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      rerender(
        <ModelOnboardingModal
          onComplete={vi.fn()}
          addToast={vi.fn()}
          firstCreatedTask={createdTaskMock}
        projectId="proj_123" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Implement onboarding success flow")).toBeTruthy();
      });
    });

    it("View Task button calls onViewTask with task and then onComplete", async () => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "first-task",
        completedSteps: ["ai-setup", "github"],
        skippedSteps: [],
        updatedAt: "2026-04-17T00:00:00.000Z",
        dismissed: false,
        completed: false,
        stepData: {},
      });

      const onComplete = vi.fn();
      const onViewTask = vi.fn();
      const { rerender } = render(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onViewTask={onViewTask}
          firstCreatedTask={null}
        projectId="proj_123" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      rerender(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onViewTask={onViewTask}
          firstCreatedTask={createdTaskMock}
        projectId="proj_123" />,
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "View Task" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "View Task" }));

      expect(onViewTask).toHaveBeenCalledWith(createdTaskMock);
      expect(onComplete).toHaveBeenCalled();
    });

    it("Go to Dashboard button calls onComplete", async () => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "first-task",
        completedSteps: ["ai-setup", "github"],
        skippedSteps: [],
        updatedAt: "2026-04-17T00:00:00.000Z",
        dismissed: false,
        completed: false,
        stepData: {},
      });

      const onComplete = vi.fn();
      const onViewTask = vi.fn();
      const { rerender } = render(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onViewTask={onViewTask}
          firstCreatedTask={null}
        projectId="proj_123" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      rerender(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onViewTask={onViewTask}
          firstCreatedTask={createdTaskMock}
        projectId="proj_123" />,
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Go to Dashboard" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Go to Dashboard" }));

      expect(onComplete).toHaveBeenCalled();
      expect(onViewTask).not.toHaveBeenCalled();
    });

    it("keeps CTA cards visible and success hidden when firstCreatedTask is not provided", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} firstCreatedTask={null} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      expect(screen.getByText("Create a New Task")).toBeTruthy();
      expect(screen.queryByText("Your first task is ready!")).toBeNull();
    });

    it("Finish Setup still transitions to complete step when no task is created", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} firstCreatedTask={null} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      fireEvent.click(screen.getByText("Finish Setup"));

      await waitFor(() => {
        expect(screen.getByText("All Set!")).toBeTruthy();
      });
    });

    it("Import from GitHub card shows connection note when GitHub not connected", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      const githubImportCard = screen.getByTestId("cta-github-import");
      expect(githubImportCard).toHaveClass("onboarding-cta-card--disabled");
      expect(githubImportCard).toBeDisabled();
      expect(screen.getByText("Requires GitHub connection")).toBeTruthy();
    });

    it("Import from GitHub card cannot be clicked when GitHub is not connected", async () => {
      const onOpenGitHubImport = vi.fn();

      render(
        <ModelOnboardingModal
          onComplete={vi.fn()}
          addToast={vi.fn()}
          onOpenGitHubImport={onOpenGitHubImport}
          projectId="proj_123"
        />,
      );

      await navigateToFirstTaskStep();

      const githubImportCard = screen.getByTestId("cta-github-import");
      fireEvent.click(githubImportCard);

      expect(onOpenGitHubImport).not.toHaveBeenCalled();
      expect(mockMarkOnboardingCompleted).not.toHaveBeenCalled();
    });

    it("Import from GitHub card has no connection note when GitHub is connected", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      const githubImportCard = screen.getByTestId("cta-github-import");
      expect(githubImportCard).not.toHaveClass("onboarding-cta-card--disabled");
      expect(screen.queryByText("Requires GitHub connection")).toBeNull();
    });

    it("Create a New Task card is never dimmed regardless of GitHub status", async () => {
      const renderAndAssert = async () => {
        const view = render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);
        await navigateToFirstTaskStep();

        const createTaskCard = screen.getByText("Create a New Task").closest("button");
        expect(createTaskCard).toBeTruthy();
        expect(createTaskCard).not.toHaveClass("onboarding-cta-card--disabled");

        view.unmount();
      };

      await renderAndAssert();

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      await renderAndAssert();
    });

    it("shows skip note about CLI and board creation", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      expect(screen.getByText(/fn task create/)).toBeTruthy();
    });

    it("feature callout does not appear on ai-setup or first-task steps", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      expect(document.querySelector(".onboarding-feature-list")).toBeNull();

      await navigateToFirstTaskStep();

      expect(document.querySelector(".onboarding-feature-list")).toBeNull();
    });

    it("allows navigation back to GitHub step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Create Your First Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Set Up Your Project")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

    });
  });

  describe("completion", () => {
    it("marks onboarding complete and opens New Task without closing onboarding immediately", async () => {
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
        projectId="proj_123" />
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

      // Should open New Task flow but keep onboarding open for success handoff
      expect(onOpenNewTask).toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
      expect(screen.getByText("Create Your First Task")).toBeTruthy();
    });

    it("completes onboarding and calls onOpenGitHubImport callback", async () => {
      const onComplete = vi.fn();
      const onOpenGitHubImport = vi.fn();

      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onOpenGitHubImport={onOpenGitHubImport}
        projectId="proj_123" />
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

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} projectId="proj_123" />);

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

      // Completed indicators should remain in done state on the completion screen.
      const aiSetupIndicator = screen.getByRole("button", { name: "Go back to AI Setup" });
      const githubIndicator = screen.getByRole("button", { name: "Go back to GitHub" });
      const firstTaskIndicator = screen.getByRole("button", { name: "Go back to First Task" });
      expect(aiSetupIndicator).toHaveClass("done");
      expect(githubIndicator).toHaveClass("done");
      expect(firstTaskIndicator).toHaveClass("done");
      expect(document.querySelectorAll(".model-onboarding-step-connector.done")).toHaveLength(4);

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

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText(/No AI providers are configured/)).toBeTruthy();
      });
    });

    it("handles auth status fetch failure gracefully", async () => {
      mockFetchAuthStatus.mockRejectedValueOnce(new Error("Network error"));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        // Should still render the modal without crashing
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });
    });

    it("shows loading state while fetching providers", () => {
      // Make the fetch hang
      mockFetchAuthStatus.mockReturnValue(new Promise(() => {}));
      mockFetchModels.mockReturnValue(new Promise(() => {}));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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
      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Wait for async model/settings hydration before asserting selected value
      const dropdown = await screen.findByTestId("mock-model-dropdown") as HTMLSelectElement;
      await waitFor(() => {
        expect(dropdown.value).toBe("anthropic/claude-sonnet-4-5");
      });
    });

    it("leaves selectedModel empty when no default is configured in global settings", async () => {
      // Mock global settings with no default model
      mockFetchGlobalSettings.mockResolvedValueOnce({
        modelOnboardingComplete: true,
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // The model dropdown should be empty
      const dropdown = await screen.findByTestId("mock-model-dropdown") as HTMLSelectElement;
      expect(dropdown.value).toBe("");
    });

    it("handles fetchGlobalSettings failure gracefully", async () => {
      // Mock global settings fetch to fail
      mockFetchGlobalSettings.mockRejectedValueOnce(new Error("Network error"));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // The modal should still render with empty dropdown
      const dropdown = await screen.findByTestId("mock-model-dropdown") as HTMLSelectElement;
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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      // Verify auth status was fetched fresh (not stale)
      expect(mockFetchAuthStatus).toHaveBeenCalled();

      // GitHub should show as connected
      expect(await screen.findByTestId("onboarding-auth-status-github")).toBeTruthy();
      expect(await screen.findByText("✓ Connected")).toBeTruthy();

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Verify global settings was fetched to hydrate dropdown
      expect(mockFetchGlobalSettings).toHaveBeenCalled();

      // The model dropdown should be pre-populated with the saved default
      const dropdown = await screen.findByTestId("mock-model-dropdown") as HTMLSelectElement;
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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      // Wait for modal to show the first-task step
      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      // Verify global settings was fetched to hydrate any model selection state
      expect(mockFetchGlobalSettings).toHaveBeenCalled();

      // Navigate back to see if the model dropdown has the saved value
      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Create Your First Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Set Up Your Project")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // The model dropdown should be pre-populated with the saved default
      const dropdown = await screen.findByTestId("mock-model-dropdown") as HTMLSelectElement;
      expect(dropdown.value).toBe("openai/gpt-4o");
    });
  });

  describe("completion state tracking", () => {
    it("marks onboarding complete when Finish Setup is clicked", async () => {
      const onComplete = vi.fn();

      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      fireEvent.click(screen.getByText("Finish Setup"));

      await waitFor(() => {
        expect(screen.getByText("All Set!")).toBeTruthy();
      });

      expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          modelOnboardingComplete: true,
        }),
      );
      expect(mockClearOnboardingState).not.toHaveBeenCalled();
    });

    it("dismissing onboarding (Skip for now) does NOT call markOnboardingCompleted", async () => {
      const onComplete = vi.fn();

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} projectId="proj_123" />);

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
        projectId="proj_123" />
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

      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onOpenGitHubImport={onOpenGitHubImport}
        projectId="proj_123" />
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

    it("marks onboarding complete when first task is created inline", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      fireEvent.change(screen.getByTestId("onboarding-first-task-input"), {
        target: { value: "Create a basic deployment checklist" },
      });
      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));

      await waitFor(() => {
        expect(screen.getByText("Your first task is ready!")).toBeTruthy();
      });

      await waitFor(() => {
        expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      });
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          modelOnboardingComplete: true,
        }),
      );
    });

    it("marks onboarding complete when View Task is clicked after inline creation", async () => {
      const onComplete = vi.fn();
      const onViewTask = vi.fn();

      render(
        <ModelOnboardingModal
          onComplete={onComplete}
          addToast={vi.fn()}
          onViewTask={onViewTask}
        projectId="proj_123" />,
      );

      await navigateToFirstTaskStep();

      fireEvent.change(screen.getByTestId("onboarding-first-task-input"), {
        target: { value: "Wire up release notes" },
      });
      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));

      await waitFor(() => {
        expect(screen.getByText("Your first task is ready!")).toBeTruthy();
      });
      await waitFor(() => {
        expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      });

      mockMarkOnboardingCompleted.mockClear();
      mockUpdateGlobalSettings.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "View Task" }));

      expect(onViewTask).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalled();
      await waitFor(() => {
        expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      });
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          modelOnboardingComplete: true,
        }),
      );
    });

    it("marks onboarding complete when Go to Dashboard is clicked after inline creation", async () => {
      const onComplete = vi.fn();

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      fireEvent.change(screen.getByTestId("onboarding-first-task-input"), {
        target: { value: "Prepare telemetry checklist" },
      });
      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));

      await waitFor(() => {
        expect(screen.getByText("Your first task is ready!")).toBeTruthy();
      });
      await waitFor(() => {
        expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      });

      mockMarkOnboardingCompleted.mockClear();
      mockUpdateGlobalSettings.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "Go to Dashboard" }));

      expect(onComplete).toHaveBeenCalled();
      await waitFor(() => {
        expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      });
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          modelOnboardingComplete: true,
        }),
      );
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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      // Navigate to GitHub step
      await navigateToGitHubStep();

      // Click Next without connecting GitHub
      fireEvent.click(screen.getByText("Next →"));

      // Should advance to Project Setup first
      await waitFor(() => {
        expect(screen.getByText("Set Up Your Project")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Next →"));

      // Then advance to optional Agent step before First Task
      await waitFor(() => {
        expect(screen.getByText("Create Your First Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Skip for now"));

      // Then advance to First Task step
      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });
    });

    it("keeps one agent template tabbable after applying an AI draft", async () => {
      render(
        <ModelOnboardingModal
          onComplete={vi.fn()}
          addToast={vi.fn()}
          projectId="proj_123"
          agentOnboardingEnabled
        />,
      );

      await navigateToProjectSetupStep();
      fireEvent.click(screen.getByText("Next →"));

      await waitFor(() => {
        expect(screen.getByText("Create Your First Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("AI Interview"));
      expect(await screen.findByTestId("agent-interview-modal")).toBeTruthy();

      fireEvent.click(screen.getByText("Use Draft"));

      expect(await screen.findByText("Launch Coordinator")).toBeTruthy();
      expect(screen.getByText("Launch Planning Agent")).toBeTruthy();
      const ceoRadio = screen.getByRole("radio", { name: "CEO" });
      expect(ceoRadio).toHaveAttribute("tabIndex", "0");
      expect(ceoRadio).toHaveAttribute("aria-checked", "false");
    });

    it("allows completing full onboarding flow without any setup", async () => {
      // All providers not authenticated, no model selected
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      // Navigate through Project Setup to First Task step
      fireEvent.click(screen.getByText("Next →"));
      await waitFor(() => {
        expect(screen.getByText("Set Up Your Project")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Next →"));
      await waitFor(() => {
        expect(screen.getByText("Create Your First Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Skip for now"));
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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      // Should advance to Project Setup first
      await waitFor(() => {
        expect(screen.getByText("Set Up Your Project")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Next →"));

      await waitFor(() => {
        expect(screen.getByText("Create Your First Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Skip for now"));

      // Then advance to First Task step
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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Wait for provider fetch to settle, then confirm helper visibility.
      await waitFor(() => {
        expect(screen.getByText("Skip this step if you'd like — you can always add providers later from Settings.")).toBeTruthy();
      });
    });

    it("does not show helper text on AI Setup when a provider is authenticated", async () => {
      // At least one provider authenticated: true
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
      });

      // Wait for provider sections to render (auth fetch complete), then assert helper absence.
      await waitFor(() => {
        expect(screen.getByText("Quick start providers")).toBeTruthy();
      });
      expect(screen.queryByText("Skip this step if you'd like — you can always add providers later from Settings.")).toBeNull();
    });

    it("shows helper text on GitHub step when GitHub is available but not connected", async () => {
      // GitHub provider exists with authenticated: false
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      // Helper text should NOT be visible when GitHub is connected
      expect(screen.queryByText("No worries if you're not ready — connect GitHub anytime from Settings → Authentication.")).toBeNull();
    });
  });

  describe("Login action handling", () => {
    it("shows Cancel button while login is in progress", async () => {
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(screen.getByText("Cancel")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Cancel"));

      await waitFor(() => {
        expect(mockCancelProviderLogin).toHaveBeenCalledWith("anthropic");
        // Login button should be shown again
        expect(screen.getByText("Login")).toBeTruthy();
        // Waiting for login should no longer be shown
        expect(screen.queryByText("Waiting for login…")).toBeNull();
        // Cancel button should no longer be shown
        expect(screen.queryByText("Cancel")).toBeNull();
      });
    });

    it("shows cancel action for server-reported pending login", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [{ id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth", loginInProgress: true }],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Waiting for login…")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Cancel"));
      await waitFor(() => {
        expect(mockCancelProviderLogin).toHaveBeenCalledWith("anthropic");
      });
    });

    it("shows OAuth login instructions during pending auth and clears them on cancel", async () => {
      mockLoginProvider.mockResolvedValueOnce({
        url: "https://auth.example.com/login",
        instructions: "Use code WXYZ-9876 to finish authentication.",
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-login-instructions-anthropic").textContent).toContain("WXYZ-9876");
      });

      fireEvent.click(screen.getByText("Cancel"));

      await waitFor(() => {
        expect(mockCancelProviderLogin).toHaveBeenCalledWith("anthropic");
        expect(screen.queryByTestId("onboarding-login-instructions-anthropic")).toBeNull();
      });
    });

    it("does not show cancel action while logout is in progress", async () => {
      let resolveLogout: (() => void) | null = null;
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [{ id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" }],
      });
      mockLogoutProvider.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveLogout = resolve;
      }));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Logout")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Logout"));

      await waitFor(() => {
        expect(screen.getByText("Logging out…")).toBeTruthy();
      });
      expect(screen.queryByText("Cancel")).toBeNull();

      resolveLogout?.();
    });

    it("shows GitHub login instructions during connect attempts", async () => {
      mockFetchAuthStatus.mockImplementation(() => Promise.resolve({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      }));
      mockLoginProvider.mockImplementation((providerId: string) => {
        if (providerId === "github") {
          return Promise.resolve({
            url: "https://github.com/login/device",
            instructions: "Enter device code GH-2469 on github.com/login/device.",
          });
        }
        return Promise.resolve({ url: "https://auth.example.com/login" });
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);
      await navigateToGitHubStep();

      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-login-instructions-github").textContent).toContain("GH-2469");
      });

      fireEvent.click(screen.getByText("Cancel"));

      await waitFor(() => {
        expect(mockCancelProviderLogin).toHaveBeenCalledWith("github");
        expect(screen.queryByTestId("onboarding-login-instructions-github")).toBeNull();
      });
    });

    it("login failure shows error toast and sets outcome to failed", async () => {
      mockLoginProvider.mockRejectedValueOnce(new Error("Login failed: Invalid credentials"));

      const addToast = vi.fn();
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} projectId="proj_123" />);

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
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          "Login already in progress. Cancel it to retry.",
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
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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
        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} projectId="proj_123" />);
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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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
      let pollCallCount = 0;

      mockFetchAuthStatus.mockImplementation(() => {
        pollCallCount++;
        return Promise.resolve({
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              authenticated: false,
              loginInProgress: pollCallCount > 1,
              type: "oauth",
            },
          ],
        });
      });

      // Use act to render with fake timers
      await act(async () => {
        render(<ModelOnboardingModal onComplete={vi.fn()} addToast={addToast} projectId="proj_123" />);
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

      // Should show timeout/failure toast
      expect(addToast).toHaveBeenCalled();
      expect([
        ["Login timed out. Please try again.", "warning"],
        ["Login did not complete. Please try again.", "error"],
      ]).toContainEqual(addToast.mock.calls[0]);

      // Cancel button should not be shown after timeout
      expect(screen.queryByText("Cancel")).toBeNull();

      vi.useRealTimers();
    });
});

});

describe("ModelOnboardingModal progressive disclosure", () => {
  describe("AI Setup step disclosures", () => {
    it("renders all 4 disclosure trigger buttons in AI Setup step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      // Wait for async provider/model loading to settle before asserting all disclosures
      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeTruthy();
        expect(screen.getByText("What are AI providers?")).toBeTruthy();
        expect(screen.getByText("How does login work?")).toBeTruthy();
        expect(screen.getByText("What is an API key?")).toBeTruthy();
        expect(screen.getByText("How do I choose a model?")).toBeTruthy();
      });
    });

    it("multiple disclosures are independent", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      // Clicking again collapses only the clicked trigger
      fireEvent.click(trigger1);
      await waitFor(() => {
        expect(trigger1.getAttribute("aria-expanded")).toBe("false");
        expect(trigger2.getAttribute("aria-expanded")).toBe("true");
        expect(screen.queryByText(/AI providers like OpenAI and Anthropic/)).toBeNull();
      });
    });
  });

  describe("GitHub step disclosures", () => {
    it("renders GitHub integration disclosure in GitHub step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      expect(screen.getByText("What does GitHub integration do?")).toBeTruthy();
    });
  });

  describe("First Task step disclosures", () => {
    it("renders task creation disclosure in First Task step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToFirstTaskStep();

      expect(screen.getByText("What happens when I create a task?")).toBeTruthy();
    });
  });

  describe("Complete step disclosures", () => {
    it("does not render any disclosure triggers in complete step", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      const badge = screen.getByTestId("provider-status-badge");
      expect(badge).toHaveAttribute("data-status", "connected");
      expect(badge).toHaveTextContent("✓ Connected");
    });

    it("shows Not connected badge for unauthenticated provider", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      // Should show skip banner about AI provider
      const banners = screen.getAllByRole("status");
      expect(banners.some((b) => b.classList.contains("onboarding-skip-banner"))).toBe(true);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      // Should NOT show skip banner about AI provider
      expect(screen.queryByText("No AI provider connected")).toBeNull();
    });

    it("does not show any skip banner on AI Setup step", async () => {
      // No providers connected
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

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

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await navigateToGitHubStep();

      // Check that skip banner has role="status"
      const skipBanner = screen.getByText("No AI provider connected").closest(".onboarding-skip-banner");
      expect(skipBanner).toHaveAttribute("role", "status");
    });
  });

  describe("First-task readiness summary (FN-1939)", () => {
    const setFirstTaskState = (stepData: Record<string, unknown> = {}) => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "first-task",
        updatedAt: new Date().toISOString(),
        completedSteps: ["ai-setup", "github"],
        skippedSteps: [],
        dismissed: false,
        completed: false,
        completedAt: undefined,
        stepData,
      });
    };

    const getReadinessItem = (label: string): HTMLElement => {
      const readinessSummary = screen.getByTestId("readiness-summary");
      const row = within(readinessSummary)
        .getByText(label)
        .closest(".onboarding-readiness-item");

      expect(row).toBeTruthy();
      return row as HTMLElement;
    };

    it("shows all-connected message when everything is set up", async () => {
      setFirstTaskState();
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      const readinessSummary = screen.getByTestId("readiness-summary");
      expect(within(readinessSummary).getByText(/All integrations connected/)).toBeTruthy();
      expect(readinessSummary.querySelectorAll(".onboarding-readiness-item")).toHaveLength(0);
    });

    it("shows AI provider as missing when no provider is connected", async () => {
      setFirstTaskState();
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      const aiProviderItem = getReadinessItem("AI Provider");
      expect(aiProviderItem).toHaveAttribute("data-status", "missing");
      expect(aiProviderItem).toHaveClass("onboarding-readiness-item--missing");
      expect(aiProviderItem).toHaveTextContent(/Connect a provider in Settings/i);
    });

    it("shows AI provider as skipped when explicitly skipped", async () => {
      setFirstTaskState({
        "ai-setup": {
          skippedProviders: { anthropic: true },
        },
      });
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      await waitFor(() => {
        const aiProviderItem = getReadinessItem("AI Provider");
        expect(aiProviderItem).toHaveAttribute("data-status", "skipped");
        expect(aiProviderItem).toHaveTextContent(/AI agents won't be available/i);
      });
    });

    it("shows GitHub as missing when available but not connected", async () => {
      setFirstTaskState();
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      const githubItem = getReadinessItem("GitHub");
      expect(githubItem).toHaveAttribute("data-status", "missing");
      expect(githubItem).toHaveTextContent(/import issues as tasks/i);
    });

    it("shows GitHub as skipped when no GitHub provider is available", async () => {
      setFirstTaskState();
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      const githubItem = getReadinessItem("GitHub");
      expect(githubItem).toHaveAttribute("data-status", "skipped");
      expect(githubItem).toHaveTextContent(/connect anytime from Settings/i);
    });

    it("shows default model when selected", async () => {
      setFirstTaskState();
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });
      mockFetchGlobalSettings.mockResolvedValue({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      const modelItem = getReadinessItem("Default Model");
      expect(modelItem).toHaveAttribute("data-status", "connected");
      expect(modelItem).toHaveTextContent("Claude Sonnet 4.5");
    });

    it("hides default model item when no model is selected", async () => {
      setFirstTaskState();
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      expect(screen.queryByText("Default Model")).toBeNull();
    });

    it("removes first-task skip banners in favor of readiness summary", async () => {
      setFirstTaskState();
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} projectId="proj_123" />);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeTruthy();
      });

      expect(screen.getByTestId("readiness-summary")).toBeTruthy();
      expect(document.querySelectorAll(".onboarding-skip-banner")).toHaveLength(0);
    });
  });
});

describe("Custom providers disclosure", () => {
  it("shows add custom provider control on ai-setup and keeps form collapsed initially", async () => {
    render(
      <ModelOnboardingModal
        isOpen
        onClose={() => {}}
        onComplete={() => {}}
        addToast={() => {}}
      />,
    );

    expect(await screen.findByText("Set Up AI", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Advanced provider settings/i }));

    expect(await screen.findByText("Add custom provider")).toBeInTheDocument();
    expect(screen.queryByTestId("custom-providers-section")).toBeNull();
  });

  it("expands custom provider form when add custom provider is clicked", async () => {
    render(
      <ModelOnboardingModal
        isOpen
        onClose={() => {}}
        onComplete={() => {}}
        addToast={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Advanced provider settings/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Add custom provider/i }));

    expect(await screen.findByTestId("custom-providers-section")).toBeInTheDocument();
  });

  it("refreshes auth status and models after custom provider save", async () => {
    render(
      <ModelOnboardingModal
        isOpen
        onClose={() => {}}
        onComplete={() => {}}
        addToast={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Advanced provider settings/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Add custom provider/i }));

    const modelCallsBefore = mockFetchModels.mock.calls.length;

    fireEvent.click(await screen.findByTestId("custom-providers-section"));

    await waitFor(() => {
      expect(mockCreateCustomProvider).toHaveBeenCalled();
      expect(mockFetchCustomProviders).toHaveBeenCalled();
      expect(mockFetchModels.mock.calls.length).toBeGreaterThan(modelCallsBefore);
    });
  });
});
