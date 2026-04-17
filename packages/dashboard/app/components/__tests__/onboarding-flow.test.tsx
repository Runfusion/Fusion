import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { useState } from "react";
import { ModelOnboardingModal } from "../ModelOnboardingModal";
import { OnboardingResumeCard } from "../OnboardingResumeCard";
import { PostOnboardingRecommendations } from "../PostOnboardingRecommendations";
import { useAuthOnboarding } from "../../hooks/useAuthOnboarding";
import type { AuthProvider } from "../../api";
import type { Task } from "@fusion/core";

const mockFetchAuthStatus = vi.fn();
const mockFetchGlobalSettings = vi.fn();
const mockFetchModels = vi.fn();
const mockLoginProvider = vi.fn();
const mockLogoutProvider = vi.fn();
const mockSaveApiKey = vi.fn();
const mockClearApiKey = vi.fn();
const mockUpdateGlobalSettings = vi.fn();
const mockCreateTask = vi.fn();

vi.mock("../../api", () => ({
  fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
  fetchGlobalSettings: (...args: unknown[]) => mockFetchGlobalSettings(...args),
  fetchModels: (...args: unknown[]) => mockFetchModels(...args),
  loginProvider: (...args: unknown[]) => mockLoginProvider(...args),
  logoutProvider: (...args: unknown[]) => mockLogoutProvider(...args),
  saveApiKey: (...args: unknown[]) => mockSaveApiKey(...args),
  clearApiKey: (...args: unknown[]) => mockClearApiKey(...args),
  updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
  createTask: (...args: unknown[]) => mockCreateTask(...args),
}));

const mockGetOnboardingState = vi.fn();
const mockSaveOnboardingState = vi.fn();
const mockClearOnboardingState = vi.fn();
const mockMarkOnboardingCompleted = vi.fn();
const mockMarkStepSkipped = vi.fn();
const mockGetSkippedSteps = vi.fn();
const mockGetStepData = vi.fn();
const mockGetOnboardingResumeStep = vi.fn();
const mockIsOnboardingResumable = vi.fn();
const mockIsOnboardingCompleted = vi.fn();
const mockIsPostOnboardingDismissed = vi.fn();
const mockDismissPostOnboardingRecommendations = vi.fn();

vi.mock("../model-onboarding-state", () => ({
  getOnboardingState: (...args: unknown[]) => mockGetOnboardingState(...args),
  saveOnboardingState: (...args: unknown[]) => mockSaveOnboardingState(...args),
  clearOnboardingState: (...args: unknown[]) => mockClearOnboardingState(...args),
  markOnboardingCompleted: (...args: unknown[]) => mockMarkOnboardingCompleted(...args),
  markStepSkipped: (...args: unknown[]) => mockMarkStepSkipped(...args),
  getSkippedSteps: (...args: unknown[]) => mockGetSkippedSteps(...args),
  getStepData: (...args: unknown[]) => mockGetStepData(...args),
  getOnboardingResumeStep: (...args: unknown[]) => mockGetOnboardingResumeStep(...args),
  isOnboardingResumable: (...args: unknown[]) => mockIsOnboardingResumable(...args),
  isOnboardingCompleted: (...args: unknown[]) => mockIsOnboardingCompleted(...args),
  isPostOnboardingDismissed: (...args: unknown[]) => mockIsPostOnboardingDismissed(...args),
  dismissPostOnboardingRecommendations: (...args: unknown[]) => mockDismissPostOnboardingRecommendations(...args),
}));

vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <select data-testid="mock-model-dropdown" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{placeholder ?? "Select…"}</option>
      <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5</option>
      <option value="openai/gpt-4o">GPT-4o</option>
    </select>
  ),
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider, size }: { provider: string; size?: string }) => (
    <span data-testid="provider-icon" data-provider={provider} data-size={size}>
      {provider} icon
    </span>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    X: () => <span data-testid="icon-x">X</span>,
    Loader2: ({ className }: { className?: string }) => (
      <span data-testid="icon-loader" className={className}>
        Loader2
      </span>
    ),
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

const createdTaskMock = {
  id: "FN-0001",
  title: "Initial task",
  description: "Implement onboarding success flow\nAdditional details that should not render",
} as unknown as Task;

let mockStore: Record<string, string> = {};

const mockLocalStorage = {
  getItem: (key: string) => mockStore[key] ?? null,
  setItem: (key: string, value: string) => {
    mockStore[key] = value;
  },
  removeItem: (key: string) => {
    delete mockStore[key];
  },
  clear: () => {
    mockStore = {};
  },
};

interface RenderModalOverrides {
  onComplete?: () => void;
  addToast?: (message: string, type?: "success" | "error" | "warning" | "info") => void;
  onOpenNewTask?: () => void;
  onOpenGitHubImport?: () => void;
  onViewTask?: (task: Task) => void;
  firstCreatedTask?: Task | null;
}

interface RenderModalResult extends RenderResult {
  onComplete: () => void;
  addToast: (message: string, type?: "success" | "error" | "warning" | "info") => void;
  onOpenNewTask: () => void;
  onOpenGitHubImport: () => void;
  onViewTask: (task: Task) => void;
}

function renderModal(overrides: RenderModalOverrides = {}): RenderModalResult {
  const onComplete = overrides.onComplete ?? vi.fn();
  const addToast = overrides.addToast ?? vi.fn();
  const onOpenNewTask = overrides.onOpenNewTask ?? vi.fn();
  const onOpenGitHubImport = overrides.onOpenGitHubImport ?? vi.fn();
  const onViewTask = overrides.onViewTask ?? vi.fn();

  const result = render(
    <ModelOnboardingModal
      onComplete={onComplete}
      addToast={addToast}
      onOpenNewTask={onOpenNewTask}
      onOpenGitHubImport={onOpenGitHubImport}
      onViewTask={onViewTask}
      firstCreatedTask={overrides.firstCreatedTask ?? null}
    />,
  );

  return {
    ...result,
    onComplete,
    addToast,
    onOpenNewTask,
    onOpenGitHubImport,
    onViewTask,
  };
}

async function advanceThroughSteps(_renderResult: RenderResult, actions: Array<"next" | "skip">): Promise<RenderResult> {
  for (const action of actions) {
    const previousTitle = screen.getByRole("heading", { level: 2 }).textContent;

    if (action === "next") {
      fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    } else {
      const skipButton =
        screen.queryByRole("button", { name: "Skip setup →" })
        ?? screen.queryByRole("button", { name: "Skip GitHub →" });

      expect(skipButton).toBeTruthy();
      fireEvent.click(skipButton!);
    }

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 }).textContent).not.toBe(previousTitle);
    });
  }

  return _renderResult;
}

async function dismissModal(_renderResult: RenderResult): Promise<RenderResult> {
  fireEvent.click(screen.getByRole("button", { name: "Skip onboarding" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  return _renderResult;
}

async function simulateFirstTaskCreation(
  _renderResult: RenderResult,
  description: string,
): Promise<RenderResult> {
  const input = screen.getByTestId("onboarding-first-task-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: description } });
  fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));
  return _renderResult;
}

function getResumeCard(onResume: () => void = vi.fn()): RenderResult {
  return render(<OnboardingResumeCard onResume={onResume} />);
}

function hasSavedStateCall(
  step: string,
  matcher?: (options: {
    completedSteps?: string[];
    skippedSteps?: string[];
  } | undefined) => boolean,
): boolean {
  return mockSaveOnboardingState.mock.calls.some(([savedStep, options]) => {
    if (savedStep !== step) {
      return false;
    }

    if (!matcher) {
      return true;
    }

    return matcher(options as { completedSteps?: string[]; skippedSteps?: string[] } | undefined);
  });
}

interface AuthOnboardingHarnessProps {
  openModelOnboardingSpy?: () => void;
  openSettingsSpy?: (section?: string) => void;
}

function AuthOnboardingHarness({ openModelOnboardingSpy, openSettingsSpy }: AuthOnboardingHarnessProps) {
  const [modelOnboardingOpen, setModelOnboardingOpen] = useState(false);

  const openModelOnboarding = () => {
    openModelOnboardingSpy?.();
    setModelOnboardingOpen(true);
  };

  const openSettings = (section?: string) => {
    openSettingsSpy?.(section);
  };

  useAuthOnboarding({
    projectId: "project-onboarding-flow",
    openModelOnboarding,
    openSettings,
  });

  return (
    <>
      {modelOnboardingOpen ? (
        <ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />
      ) : (
        <div data-testid="onboarding-modal-closed" />
      )}
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();

  mockStore = {};
  vi.stubGlobal("localStorage", mockLocalStorage);

  mockGetOnboardingState.mockReturnValue(null);
  mockSaveOnboardingState.mockImplementation(() => {});
  mockClearOnboardingState.mockImplementation(() => {});
  mockMarkOnboardingCompleted.mockImplementation(() => {});
  mockMarkStepSkipped.mockImplementation(() => {});
  mockGetSkippedSteps.mockReturnValue([]);
  mockGetStepData.mockReturnValue(null);
  mockGetOnboardingResumeStep.mockReturnValue(null);
  mockIsOnboardingResumable.mockReturnValue(false);
  mockIsOnboardingCompleted.mockReturnValue(false);
  mockIsPostOnboardingDismissed.mockReturnValue(false);
  mockDismissPostOnboardingRecommendations.mockImplementation(() => {});

  mockFetchAuthStatus.mockResolvedValue({ providers: defaultAuthProviders });
  mockFetchModels.mockResolvedValue({ models: defaultModels, favoriteProviders: [], favoriteModels: [] });
  mockFetchGlobalSettings.mockResolvedValue({});
  mockLoginProvider.mockResolvedValue({ url: "https://auth.example.com/login" });
  mockLogoutProvider.mockResolvedValue({ success: true });
  mockSaveApiKey.mockResolvedValue({ success: true });
  mockClearApiKey.mockResolvedValue({ success: true });
  mockUpdateGlobalSettings.mockResolvedValue({});
  mockCreateTask.mockResolvedValue(createdTaskMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("onboarding flow integration", () => {
  describe("first-run flow", () => {
    it("first-run flow: hook triggers modal open and modal renders AI Setup step", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: defaultAuthProviders,
      });
      mockFetchGlobalSettings.mockResolvedValue({ modelOnboardingComplete: false });
      mockIsOnboardingCompleted.mockReturnValue(false);

      const openModelOnboardingSpy = vi.fn();

      render(<AuthOnboardingHarness openModelOnboardingSpy={openModelOnboardingSpy} />);

      await waitFor(() => {
        expect(openModelOnboardingSpy).toHaveBeenCalledTimes(1);
      });

      expect(screen.getByRole("dialog")).toBeInTheDocument();

      const aiSetupIndicator = screen.getByText("AI Setup").closest(".model-onboarding-step-indicator");
      expect(aiSetupIndicator).toHaveClass("active");
      expect(screen.getByText("Set Up AI")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next →" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Skip for now" })).toBeInTheDocument();
    });

    it("first-run flow: local completion suppresses modal even when server says incomplete", async () => {
      mockFetchGlobalSettings.mockResolvedValue({ modelOnboardingComplete: false });
      mockIsOnboardingCompleted.mockReturnValue(true);

      const openModelOnboardingSpy = vi.fn();

      render(<AuthOnboardingHarness openModelOnboardingSpy={openModelOnboardingSpy} />);

      await waitFor(() => {
        expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
      });

      expect(openModelOnboardingSpy).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByTestId("onboarding-modal-closed")).toBeInTheDocument();
    });

    it("first-run flow: completed state in both server and local prevents auto-open", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });
      mockFetchGlobalSettings.mockResolvedValue({
        modelOnboardingComplete: true,
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });
      mockIsOnboardingCompleted.mockReturnValue(true);

      const openModelOnboardingSpy = vi.fn();
      const openSettingsSpy = vi.fn();

      render(
        <AuthOnboardingHarness
          openModelOnboardingSpy={openModelOnboardingSpy}
          openSettingsSpy={openSettingsSpy}
        />,
      );

      await waitFor(() => {
        expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
      });

      expect(openModelOnboardingSpy).not.toHaveBeenCalled();
      expect(openSettingsSpy).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByTestId("onboarding-modal-closed")).toBeInTheDocument();
    });
  });

  describe("dismissal flow", () => {
    it("dismissal flow: dismissing on GitHub step saves state with currentStep=github", async () => {
      const renderResult = renderModal();

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Next →" })).toBeInTheDocument();
      });
      await advanceThroughSteps(renderResult, ["next"]);

      await dismissModal(renderResult);

      await waitFor(() => {
        expect(hasSavedStateCall("github")).toBe(true);
      });

      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ modelOnboardingComplete: true });
      expect(renderResult.onComplete).toHaveBeenCalledTimes(1);
      expect(mockMarkOnboardingCompleted).not.toHaveBeenCalled();
    });

    it("dismissal flow: dismissing preserves completedSteps array", async () => {
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next"]);
      await dismissModal(renderResult);

      await waitFor(() => {
        expect(
          hasSavedStateCall(
            "github",
            (options) => options?.completedSteps?.includes("ai-setup") === true,
          ),
        ).toBe(true);
      });

      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("dismissal flow: dismissing on first-task step saves skipped GitHub state", async () => {
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "skip"]);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeInTheDocument();
      });

      await dismissModal(renderResult);

      expect(mockMarkStepSkipped).toHaveBeenCalledWith("github");
      await waitFor(() => {
        expect(
          hasSavedStateCall(
            "first-task",
            (options) => options?.skippedSteps?.includes("github") === true,
          ),
        ).toBe(true);
      });
    });

    it("dismissal flow: dismissing still works when updateGlobalSettings fails", async () => {
      mockUpdateGlobalSettings.mockRejectedValueOnce(new Error("save failed"));
      const renderResult = renderModal();

      await dismissModal(renderResult);

      expect(renderResult.onComplete).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("dismissal flow: resume card renders after dismissal with saved progress", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "github",
        label: "GitHub",
        completedSteps: ["ai-setup"],
      });

      getResumeCard();

      expect(screen.getByText("Continue Setup")).toBeInTheDocument();
      expect(screen.getByText(/GitHub/)).toBeInTheDocument();
      expect(screen.getByText(/1 of 3 step complete/)).toBeInTheDocument();
    });
  });

  describe("resume flow", () => {
    it("resume flow: modal reopens at the persisted step", async () => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "github",
        completedSteps: ["ai-setup"],
        skippedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      });

      renderModal();

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
      });

      const aiSetupIndicator = screen.getByRole("button", { name: "Go back to AI Setup" });
      expect(aiSetupIndicator).toHaveClass("done");
      expect(screen.getByRole("button", { name: "← Back" })).toBeInTheDocument();
    });

    it("resume flow: resume card triggers modal open", () => {
      mockGetOnboardingResumeStep.mockReturnValue({
        currentStep: "github",
        label: "GitHub",
        completedSteps: ["ai-setup"],
      });

      const onResume = vi.fn();
      getResumeCard(onResume);

      fireEvent.click(screen.getByRole("button", { name: "Continue onboarding" }));
      expect(onResume).toHaveBeenCalledTimes(1);
    });

    it("resume flow: resumed modal can continue forward to first-task", async () => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "github",
        completedSteps: ["ai-setup"],
        skippedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      });

      const renderResult = renderModal();

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
      });

      await advanceThroughSteps(renderResult, ["next"]);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeInTheDocument();
      });

      const githubIndicator = screen.getByRole("button", { name: "Go back to GitHub" });
      expect(githubIndicator).toHaveClass("done");
    });

    it("resume flow: resumed modal can go back to completed step", async () => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "github",
        completedSteps: ["ai-setup"],
        skippedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      });

      renderModal();

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Go back to AI Setup" }));

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeInTheDocument();
      });
    });

    it("resume flow: no resume card when onboarding is completed", () => {
      mockGetOnboardingResumeStep.mockReturnValue(null);

      const { container } = getResumeCard();

      expect(container.firstChild).toBeNull();
    });

    it("resume flow: resumed modal restores skipped providers from stepData", async () => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "github",
        completedSteps: ["ai-setup"],
        skippedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {
          "ai-setup": {
            skippedProviders: { anthropic: true },
          },
        },
      });

      renderModal();

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Go back to AI Setup" }));

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeInTheDocument();
      });

      const anthropicCard = screen.getByText("Anthropic").closest(".onboarding-provider-card");
      expect(anthropicCard).toBeTruthy();
      expect(within(anthropicCard as HTMLElement).getByText("Skipped")).toBeInTheDocument();
    });
  });

  describe("skip warnings flow", () => {
    it("skip warnings: skipping AI Setup shows warning banner on GitHub step", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Skip setup →" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Skip setup →" }));

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
      });

      expect(screen.getByText("No AI provider connected")).toBeInTheDocument();
      expect(mockMarkStepSkipped).toHaveBeenCalledWith("ai-setup");
    });

    it("skip warnings: GitHub step shows 'not connected' status and no banner when AI is set up", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next"]);

      await waitFor(() => {
        expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
      });

      expect(screen.queryByText("No AI provider connected")).toBeNull();
      expect(screen.getByTestId("github-status-badge")).toHaveTextContent("Not connected");
    });

    it("skip warnings: first-task readiness summary shows AI Provider as 'missing' when no provider connected", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "github", name: "GitHub", authenticated: false, type: "oauth" },
        ],
      });

      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeInTheDocument();
      });

      const readinessSummary = screen.getByTestId("readiness-summary");
      const aiProviderItem = within(readinessSummary).getByText("AI Provider").closest(".onboarding-readiness-item");
      expect(aiProviderItem).toHaveAttribute("data-status", "missing");
      expect(screen.getByText("Connect a provider in Settings → AI Setup")).toBeInTheDocument();
    });

    it("skip warnings: first-task readiness summary shows AI Provider as 'skipped' when providers were explicitly skipped", async () => {
      const renderResult = renderModal();

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeInTheDocument();
      });

      await advanceThroughSteps(renderResult, ["skip", "skip"]);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeInTheDocument();
      });

      const readinessSummary = screen.getByTestId("readiness-summary");
      const aiProviderItem = within(readinessSummary).getByText("AI Provider").closest(".onboarding-readiness-item");
      expect(aiProviderItem).toHaveAttribute("data-status", "skipped");
      expect(screen.getByText("AI agents won't be available until you connect a provider")).toBeInTheDocument();
    });

    it("skip warnings: GitHub shows as 'skipped' in readiness when GitHub is not available", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
        ],
      });

      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeInTheDocument();
      });

      const readinessSummary = screen.getByTestId("readiness-summary");
      const githubItem = within(readinessSummary).getByText("GitHub").closest(".onboarding-readiness-item");
      expect(githubItem).toHaveAttribute("data-status", "skipped");
      expect(screen.getByText("You can connect anytime from Settings")).toBeInTheDocument();
    });

    it("skip warnings: all-connected readiness summary when everything is set up", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });
      mockFetchGlobalSettings.mockResolvedValue({
        modelOnboardingComplete: true,
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeInTheDocument();
      });

      expect(screen.getByText("✓ All integrations connected")).toBeInTheDocument();
    });

    it("skip warnings: Import from GitHub CTA shows connection requirement note when GitHub not connected", async () => {
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeInTheDocument();
      });

      expect(screen.getByText("Requires GitHub connection")).toBeInTheDocument();
    });
  });

  describe("task creation flow", () => {
    it("task creation flow: inline task creation shows success state and marks onboarding complete", async () => {
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);
      await simulateFirstTaskCreation(renderResult, "Ship onboarding telemetry");

      await waitFor(() => {
        expect(mockCreateTask).toHaveBeenCalledWith({ description: "Ship onboarding telemetry" });
      });

      expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ modelOnboardingComplete: true });
      expect(screen.getByText("Your first task is ready!")).toBeInTheDocument();
    });

    it("task creation flow: View Task button navigates and completes onboarding", async () => {
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);
      await simulateFirstTaskCreation(renderResult, "View task flow");

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "View Task" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "View Task" }));

      expect(renderResult.onViewTask).toHaveBeenCalledWith(createdTaskMock);
      expect(renderResult.onComplete).toHaveBeenCalled();
      expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
    });

    it("task creation flow: Go to Dashboard button completes onboarding and closes modal", async () => {
      function ModalHost() {
        const [isOpen, setIsOpen] = useState(true);

        return isOpen ? (
          <ModelOnboardingModal
            onComplete={() => {
              setIsOpen(false);
            }}
            addToast={vi.fn()}
          />
        ) : (
          <div data-testid="modal-host-closed" />
        );
      }

      render(<ModalHost />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Next →" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Next →" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Next →" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Next →" }));

      await waitFor(() => {
        expect(screen.getByText("Create Your First Task")).toBeInTheDocument();
      });

      const input = screen.getByTestId("onboarding-first-task-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "Close after dashboard handoff" } });
      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Go to Dashboard" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Go to Dashboard" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });

      expect(screen.getByTestId("modal-host-closed")).toBeInTheDocument();
    });

    it("task creation flow: Finish Setup button (without creating task) completes onboarding", async () => {
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);

      fireEvent.click(screen.getByRole("button", { name: "Finish Setup" }));

      await waitFor(() => {
        expect(screen.getByText("All Set!")).toBeInTheDocument();
      });

      expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
    });

    it("task creation flow: Create a New Task CTA completes onboarding and triggers external task dialog", async () => {
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);

      fireEvent.click(screen.getByRole("button", { name: /Create a New Task/i }));

      await waitFor(() => {
        expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      });

      expect(renderResult.onOpenNewTask).toHaveBeenCalled();
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ modelOnboardingComplete: true });
    });

    it("task creation flow: Import from GitHub CTA completes onboarding and triggers import", async () => {
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);

      fireEvent.click(screen.getByRole("button", { name: /Import from GitHub/i }));

      await waitFor(() => {
        expect(mockMarkOnboardingCompleted).toHaveBeenCalled();
      });

      expect(renderResult.onOpenGitHubImport).toHaveBeenCalled();
      expect(renderResult.onComplete).toHaveBeenCalled();
    });

    it("task creation flow: validation error on empty description does not call createTask", async () => {
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);

      fireEvent.click(screen.getByTestId("onboarding-first-task-submit"));

      expect(mockCreateTask).not.toHaveBeenCalled();
      expect(screen.getByText(/please enter a task description/i)).toBeInTheDocument();
    });

    it("task creation flow: server error preserves typed description for retry", async () => {
      mockCreateTask.mockRejectedValueOnce(new Error("Task API unavailable"));
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);
      await simulateFirstTaskCreation(renderResult, "Retryable task");

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-task-error")).toBeInTheDocument();
      });

      const input = screen.getByTestId("onboarding-first-task-input") as HTMLTextAreaElement;
      expect(input.value).toBe("Retryable task");
    });

    it("task creation flow: Get Started button on complete step closes the modal", async () => {
      const renderResult = renderModal();

      await advanceThroughSteps(renderResult, ["next", "next"]);

      fireEvent.click(screen.getByRole("button", { name: "Finish Setup" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Get Started/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /Get Started/i }));

      expect(renderResult.onComplete).toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("revisit flow", () => {
    it("revisit flow: no auto-open when onboarding is completed (server flag)", async () => {
      mockFetchAuthStatus.mockResolvedValue({
        providers: [{ id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" }],
      });
      mockFetchGlobalSettings.mockResolvedValue({
        modelOnboardingComplete: true,
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });
      mockIsOnboardingCompleted.mockReturnValue(true);

      const openModelOnboardingSpy = vi.fn();
      const openSettingsSpy = vi.fn();

      render(
        <AuthOnboardingHarness
          openModelOnboardingSpy={openModelOnboardingSpy}
          openSettingsSpy={openSettingsSpy}
        />,
      );

      await waitFor(() => {
        expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
      });

      expect(openModelOnboardingSpy).not.toHaveBeenCalled();
      expect(openSettingsSpy).not.toHaveBeenCalled();
    });

    it("revisit flow: no resume card when onboarding is completed", () => {
      mockGetOnboardingResumeStep.mockReturnValue(null);

      const { container } = getResumeCard();

      expect(container.firstChild).toBeNull();
    });

    it("revisit flow: PostOnboardingRecommendations renders after completion with incomplete setup", async () => {
      mockIsOnboardingCompleted.mockReturnValue(true);
      mockIsPostOnboardingDismissed.mockReturnValue(false);
      mockFetchAuthStatus.mockResolvedValue({ providers: defaultAuthProviders });
      mockFetchGlobalSettings.mockResolvedValue({
        defaultProvider: undefined,
        defaultModelId: undefined,
      });

      render(
        <PostOnboardingRecommendations
          onOpenSettings={vi.fn()}
          onOpenModelOnboarding={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Recommended Next Steps")).toBeInTheDocument();
      });

      expect(screen.getByText("Connect AI Provider")).toBeInTheDocument();
    });

    it("revisit flow: PostOnboardingRecommendations dismiss persists", async () => {
      mockIsOnboardingCompleted.mockReturnValue(true);
      mockIsPostOnboardingDismissed.mockReturnValue(false);
      mockFetchAuthStatus.mockResolvedValue({ providers: defaultAuthProviders });
      mockFetchGlobalSettings.mockResolvedValue({
        defaultProvider: undefined,
        defaultModelId: undefined,
      });

      render(
        <PostOnboardingRecommendations
          onOpenSettings={vi.fn()}
          onOpenModelOnboarding={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Recommended Next Steps")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Dismiss recommendations" }));

      expect(mockDismissPostOnboardingRecommendations).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Recommended Next Steps")).toBeNull();
    });

    it("revisit flow: PostOnboardingRecommendations does not render when everything is configured", async () => {
      mockIsOnboardingCompleted.mockReturnValue(true);
      mockIsPostOnboardingDismissed.mockReturnValue(false);
      mockFetchAuthStatus.mockResolvedValue({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
          { id: "github", name: "GitHub", authenticated: true, type: "oauth" },
        ],
      });
      mockFetchGlobalSettings.mockResolvedValue({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      const { container } = render(
        <PostOnboardingRecommendations
          onOpenSettings={vi.fn()}
          onOpenModelOnboarding={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
      });

      expect(container.firstChild).toBeNull();
    });

    it("revisit flow: re-opening modal after completion starts fresh at ai-setup", async () => {
      mockGetOnboardingState.mockReturnValue({
        currentStep: "complete",
        completed: true,
        completedSteps: ["ai-setup", "github", "first-task"],
        skippedSteps: [],
        dismissed: false,
        stepData: {},
      });

      renderModal();

      await waitFor(() => {
        expect(screen.getByText("Set Up AI")).toBeInTheDocument();
      });

      const aiSetupIndicator = screen.getByText("AI Setup").closest(".model-onboarding-step-indicator");
      expect(aiSetupIndicator).toHaveClass("active");
      expect(screen.queryByText("All Set!")).toBeNull();
    });

    it("revisit flow: modal can be opened manually after auto-trigger was suppressed", async () => {
      mockFetchGlobalSettings.mockResolvedValue({
        modelOnboardingComplete: true,
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });
      mockIsOnboardingCompleted.mockReturnValue(true);

      const openModelOnboardingSpy = vi.fn();

      render(<AuthOnboardingHarness openModelOnboardingSpy={openModelOnboardingSpy} />);

      await waitFor(() => {
        expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
      });

      expect(openModelOnboardingSpy).not.toHaveBeenCalled();

      renderModal();

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next →" })).toBeInTheDocument();
    });
  });
});
