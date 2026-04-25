import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PostOnboardingRecommendations } from "../PostOnboardingRecommendations";

const mockFetchAuthStatus = vi.fn();
const mockFetchGlobalSettings = vi.fn();

vi.mock("../../api", () => ({
  fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
  fetchGlobalSettings: (...args: unknown[]) => mockFetchGlobalSettings(...args),
}));

const mockIsOnboardingCompleted = vi.fn();
const mockIsPostOnboardingDismissed = vi.fn();
const mockDismissPostOnboardingRecommendations = vi.fn();

vi.mock("../model-onboarding-state", () => ({
  isOnboardingCompleted: (...args: unknown[]) => mockIsOnboardingCompleted(...args),
  isPostOnboardingDismissed: (...args: unknown[]) => mockIsPostOnboardingDismissed(...args),
  dismissPostOnboardingRecommendations: (...args: unknown[]) => mockDismissPostOnboardingRecommendations(...args),
  ONBOARDING_FLOW_STEPS: ["ai-setup", "github", "project-setup", "first-task"],
}));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    X: () => <span data-testid="icon-x">X</span>,
    Lightbulb: () => <span data-testid="icon-lightbulb">Lightbulb</span>,
    CheckCircle: () => <span data-testid="icon-check-circle">CheckCircle</span>,
    AlertCircle: () => <span data-testid="icon-alert-circle">AlertCircle</span>,
    Key: () => <span data-testid="icon-key">Key</span>,
    GitPullRequest: () => <span data-testid="icon-git-pull-request">GitPullRequest</span>,
    Zap: () => <span data-testid="icon-zap">Zap</span>,
  };
});

describe("PostOnboardingRecommendations", () => {
  const onOpenSettings = vi.fn();
  const onOpenModelOnboarding = vi.fn();

  const renderComponent = () => render(
    <PostOnboardingRecommendations
      onOpenSettings={onOpenSettings}
      onOpenModelOnboarding={onOpenModelOnboarding}
    />,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnboardingCompleted.mockReturnValue(true);
    mockIsPostOnboardingDismissed.mockReturnValue(false);

    mockFetchAuthStatus.mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "github", name: "GitHub", authenticated: true },
      ],
    });

    mockFetchGlobalSettings.mockResolvedValue({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });
  });

  it("renders nothing when onboarding is not completed", () => {
    mockIsOnboardingCompleted.mockReturnValue(false);

    const { container } = renderComponent();

    expect(container.firstChild).toBeNull();
    expect(mockFetchAuthStatus).not.toHaveBeenCalled();
    expect(mockFetchGlobalSettings).not.toHaveBeenCalled();
  });

  it("renders nothing when post-onboarding is dismissed", () => {
    mockIsPostOnboardingDismissed.mockReturnValue(true);

    const { container } = renderComponent();

    expect(container.firstChild).toBeNull();
    expect(mockFetchAuthStatus).not.toHaveBeenCalled();
    expect(mockFetchGlobalSettings).not.toHaveBeenCalled();
  });

  it("renders nothing when all setup items are complete", async () => {
    const { container } = renderComponent();

    await waitFor(() => {
      expect(mockFetchAuthStatus).toHaveBeenCalledTimes(1);
      expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
    });

    expect(container.firstChild).toBeNull();
  });

  it("renders Connect AI Provider recommendation when no AI provider is authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: false },
        { id: "github", name: "GitHub", authenticated: true },
      ],
    });

    renderComponent();

    expect(await screen.findByText("Connect AI Provider")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set Up AI" })).toBeInTheDocument();
  });

  it("renders Select Default Model recommendation when no default model is set", async () => {
    mockFetchGlobalSettings.mockResolvedValue({});

    renderComponent();

    expect(await screen.findByText("Select Default Model")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose Model" })).toBeInTheDocument();
  });

  it("renders Connect GitHub recommendation when GitHub exists but is not authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });

    renderComponent();

    expect(await screen.findByText("Connect GitHub to import issues and track pull requests")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeInTheDocument();
  });

  it("renders multiple recommendations when multiple setup items are incomplete", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: false },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });
    mockFetchGlobalSettings.mockResolvedValue({});

    renderComponent();

    expect(await screen.findByText("Connect AI Provider")).toBeInTheDocument();
    expect(screen.getByText("Select Default Model")).toBeInTheDocument();
    expect(screen.getAllByText("Connect GitHub").length).toBeGreaterThan(0);
  });

  it("clicking Set Up AI calls onOpenModelOnboarding", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: false },
        { id: "github", name: "GitHub", authenticated: true },
      ],
    });

    renderComponent();

    const button = await screen.findByRole("button", { name: "Set Up AI" });
    fireEvent.click(button);

    expect(onOpenModelOnboarding).toHaveBeenCalledTimes(1);
  });

  it("clicking Choose Model calls onOpenSettings with global-models", async () => {
    mockFetchGlobalSettings.mockResolvedValue({});

    renderComponent();

    const button = await screen.findByRole("button", { name: "Choose Model" });
    fireEvent.click(button);

    expect(onOpenSettings).toHaveBeenCalledWith("global-models");
  });

  it("clicking Connect GitHub calls onOpenSettings with authentication", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });

    renderComponent();

    const button = await screen.findByRole("button", { name: "Connect GitHub" });
    fireEvent.click(button);

    expect(onOpenSettings).toHaveBeenCalledWith("authentication");
  });

  it("clicking dismiss calls dismissPostOnboardingRecommendations", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: false },
        { id: "github", name: "GitHub", authenticated: true },
      ],
    });

    renderComponent();

    const dismissButton = await screen.findByRole("button", { name: "Dismiss recommendations" });
    fireEvent.click(dismissButton);

    expect(mockDismissPostOnboardingRecommendations).toHaveBeenCalledTimes(1);
  });

  it("returns null on API error", async () => {
    mockFetchAuthStatus.mockRejectedValue(new Error("network failure"));

    const { container } = renderComponent();

    await waitFor(() => {
      expect(mockFetchAuthStatus).toHaveBeenCalledTimes(1);
    });

    expect(container.firstChild).toBeNull();
  });
});
