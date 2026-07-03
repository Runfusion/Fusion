import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAuthOnboarding } from "../useAuthOnboarding";
import * as api from "../../api";

// Mock model-onboarding-state for isOnboardingCompleted
const mockIsOnboardingCompleted = vi.fn();
const mockTrackOnboardingEvent = vi.fn();

vi.mock("../../api", () => ({
  fetchAuthStatus: vi.fn(),
  fetchGlobalSettings: vi.fn(),
}));

vi.mock("../../components/model-onboarding-state", () => ({
  isOnboardingCompleted: (...args: unknown[]) => mockIsOnboardingCompleted(...args),
  ONBOARDING_FLOW_STEPS: ["ai-setup", "github", "project-setup", "agent", "first-task"],
}));

vi.mock("../../components/onboarding-events", () => ({
  trackOnboardingEvent: (...args: unknown[]) => mockTrackOnboardingEvent(...args),
  getOnboardingSessionId: () => "test-session-id",
}));

const mockFetchAuthStatus = vi.mocked(api.fetchAuthStatus);
const mockFetchGlobalSettings = vi.mocked(api.fetchGlobalSettings);

describe("useAuthOnboarding", () => {
  const openModelOnboarding = vi.fn();
  const openSettings = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockTrackOnboardingEvent.mockReset();
  });

  // --- Trigger branches ---

  it("opens onboarding when no providers are authenticated and onboarding is incomplete", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "openai", name: "OpenAI", authenticated: false }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: false,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);

    renderHook(() =>
      useAuthOnboarding({
        projectId: "proj_123",
        setupWizardOpen: false,
        openModelOnboarding,
        openSettings,
      }),
    );

    await waitFor(() => {
      expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    });

    expect(mockTrackOnboardingEvent).toHaveBeenCalledWith("onboarding:auto-triggered", { trigger: "first-run" });
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("opens onboarding on a brand-new install even when the provider list is empty", async () => {
    // Regression: a fresh install (e.g. desktop first launch) can report zero providers; the
    // old `providers.length > 0` gate skipped onboarding entirely. First-run must still fire.
    mockFetchAuthStatus.mockResolvedValue({ providers: [] });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: undefined,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);
    mockIsOnboardingCompleted.mockReturnValue(false);

    renderHook(() =>
      useAuthOnboarding({
        projectId: undefined,
        setupWizardOpen: false,
        openModelOnboarding,
        openSettings,
      }),
    );

    await waitFor(() => {
      expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    });
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("opens onboarding when modelOnboardingComplete is undefined (first-run detection)", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "openai", name: "OpenAI", authenticated: false }],
    });
    // Explicit first-run: modelOnboardingComplete is undefined (not explicitly false)
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: undefined,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);

    renderHook(() =>
      useAuthOnboarding({
        projectId: "proj_123",
        setupWizardOpen: false,
        openModelOnboarding,
        openSettings,
      }),
    );

    await waitFor(() => {
      expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    });

    expect(openSettings).not.toHaveBeenCalled();
  });

  it("opens authentication settings when onboarding is complete but no providers are authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "anthropic", name: "Anthropic", authenticated: false }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: true,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    } as never);

    renderHook(() =>
      useAuthOnboarding({
        projectId: "proj_123",
        setupWizardOpen: false,
        openModelOnboarding,
        openSettings,
      }),
    );

    await waitFor(() => {
      expect(openSettings).toHaveBeenCalledWith("authentication");
    });

    expect(mockTrackOnboardingEvent).toHaveBeenCalledWith("onboarding:auto-triggered", { trigger: "missing-provider" });
    expect(openModelOnboarding).not.toHaveBeenCalled();
  });

  it("opens onboarding when providers are authenticated but default model is missing", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "anthropic", name: "Anthropic", authenticated: true }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: false,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);

    renderHook(() =>
      useAuthOnboarding({
        projectId: "proj_123",
        setupWizardOpen: false,
        openModelOnboarding,
        openSettings,
      }),
    );

    await waitFor(() => {
      expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    });

    expect(openSettings).not.toHaveBeenCalled();
  });

  it("does NOT auto-open when authenticated provider exists and default model is configured", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "anthropic", name: "Anthropic", authenticated: true }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: true,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    } as never);

    renderHook(() =>
      useAuthOnboarding({
        projectId: "proj_123",
        setupWizardOpen: false,
        openModelOnboarding,
        openSettings,
      }),
    );

    // Give time for any async calls to resolve
    await waitFor(() => {
      expect(mockFetchAuthStatus).toHaveBeenCalledTimes(1);
    });

    // Neither onboarding nor settings should open
    expect(openModelOnboarding).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("does nothing when auth status fetch fails", async () => {
    mockFetchAuthStatus.mockRejectedValueOnce(new Error("network"));

    renderHook(() =>
      useAuthOnboarding({
        projectId: "proj_123",
        setupWizardOpen: false,
        openModelOnboarding,
        openSettings,
      }),
    );

    await waitFor(() => {
      expect(mockFetchAuthStatus).toHaveBeenCalledTimes(1);
    });

    expect(openModelOnboarding).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
    expect(mockFetchGlobalSettings).not.toHaveBeenCalled();
  });

  it("does not auto-trigger model onboarding when setupWizardOpen is true", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "openai", name: "OpenAI", authenticated: false }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: false,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);

    renderHook(() =>
      useAuthOnboarding({
        projectId: "proj_123",
        setupWizardOpen: true,
        openModelOnboarding,
        openSettings,
      }),
    );

    await waitFor(() => {
      expect(openModelOnboarding).not.toHaveBeenCalled();
      expect(mockFetchAuthStatus).not.toHaveBeenCalled();
    });
  });

  it("auto-triggers model onboarding when setupWizardOpen transitions from true to false", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "openai", name: "OpenAI", authenticated: false }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: false,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);

    const { rerender } = renderHook(
      ({ setupWizardOpen }: { setupWizardOpen: boolean }) =>
        useAuthOnboarding({
          projectId: "proj_123",
          setupWizardOpen,
          openModelOnboarding,
          openSettings,
        }),
      {
        initialProps: { setupWizardOpen: true },
      },
    );

    await waitFor(() => {
      expect(openModelOnboarding).not.toHaveBeenCalled();
      expect(mockFetchAuthStatus).not.toHaveBeenCalled();
    });

    rerender({ setupWizardOpen: false });

    await waitFor(() => {
      expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    });
  });

  it("auto-triggers model onboarding before a projectId exists so brand-new users start with AI setup", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "openai", name: "OpenAI", authenticated: false }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: false,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);

    renderHook(() =>
      useAuthOnboarding({
        projectId: undefined,
        setupWizardOpen: false,
        openModelOnboarding,
        openSettings,
      }),
    );

    await waitFor(() => {
      expect(mockFetchAuthStatus).toHaveBeenCalledTimes(1);
      expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    });
  });

  it("does not stack model onboarding on top of a setup wizard that opens mid-fetch", async () => {
    let resolveAuth: (value: { providers: Array<{ id: string; name: string; authenticated: boolean }> }) => void = () => {};
    mockFetchAuthStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveAuth = resolve;
      }) as never,
    );
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: false,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);

    const { rerender } = renderHook(
      ({ setupWizardOpen }: { setupWizardOpen: boolean }) =>
        useAuthOnboarding({
          projectId: "proj_123",
          setupWizardOpen,
          openModelOnboarding,
          openSettings,
        }),
      { initialProps: { setupWizardOpen: false } },
    );

    // Wizard opens while fetch is still pending.
    rerender({ setupWizardOpen: true });
    resolveAuth({ providers: [{ id: "openai", name: "OpenAI", authenticated: false }] });

    await waitFor(() => {
      expect(mockFetchAuthStatus).toHaveBeenCalled();
    });
    // Onboarding must not open while wizard is up.
    expect(openModelOnboarding).not.toHaveBeenCalled();

    // After wizard closes, onboarding takes over.
    rerender({ setupWizardOpen: false });
    await waitFor(() => {
      expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    });
  });

  // --- One-shot guard ---

  it("does not re-trigger onboarding when projectId changes after initial bootstrap", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "openai", name: "OpenAI", authenticated: false }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: false,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);

    // First render with project 1
    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useAuthOnboarding({
          projectId,
          setupWizardOpen: false,
          openModelOnboarding,
          openSettings,
        }),
      {
        initialProps: { projectId: "proj_1" },
      },
    );

    await waitFor(() => {
      expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    });

    // Simulate project context churn - change projectId prop
    rerender({ projectId: "proj_2" });

    // Onboarding should NOT open again (one-shot guard prevents repeat)
    expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("does not re-trigger when openModelOnboarding reference changes", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "openai", name: "OpenAI", authenticated: false }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: false,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);

    const { rerender } = renderHook(
      ({ open }: { open: () => void }) =>
        useAuthOnboarding({
          projectId: "proj_123",
          setupWizardOpen: false,
          openModelOnboarding: open,
          openSettings,
        }),
      {
        initialProps: { open: openModelOnboarding },
      },
    );

    await waitFor(() => {
      expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    });

    // Simulate a new function reference (e.g., after modal manager re-render)
    const newOpenOnboarding = vi.fn();
    rerender({ open: newOpenOnboarding });

    // Should NOT trigger again
    expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    expect(newOpenOnboarding).not.toHaveBeenCalled();
  });

  it("does not re-trigger when openSettings reference changes", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "anthropic", name: "Anthropic", authenticated: false }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: true,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    } as never);

    const { rerender } = renderHook(
      ({ open }: { open: (section?: string) => void }) =>
        useAuthOnboarding({
          projectId: "proj_123",
          setupWizardOpen: false,
          openModelOnboarding,
          openSettings: open,
        }),
      {
        initialProps: { open: openSettings },
      },
    );

    await waitFor(() => {
      expect(openSettings).toHaveBeenCalledWith("authentication");
    });

    // Simulate a new function reference
    const newOpenSettings = vi.fn();
    rerender({ open: newOpenSettings });

    // Should NOT trigger again
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(newOpenSettings).not.toHaveBeenCalled();
  });

  // --- isOnboardingCompleted integration ---

  it("auto-open is suppressed when isOnboardingCompleted() returns true even if modelOnboardingComplete is undefined", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "openai", name: "OpenAI", authenticated: false }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: undefined,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);
    // Simulate locally completed onboarding
    mockIsOnboardingCompleted.mockReturnValue(true);

    renderHook(() =>
      useAuthOnboarding({
        projectId: "proj_123",
        setupWizardOpen: false,
        openModelOnboarding,
        openSettings,
      }),
    );

    // Give time for any async calls to resolve
    await waitFor(() => {
      expect(mockFetchAuthStatus).toHaveBeenCalledTimes(1);
    });

    // Neither onboarding nor settings should open because local completion suppresses it
    expect(openModelOnboarding).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("auto-open still fires when neither server nor local completion flag is set", async () => {
    mockFetchAuthStatus.mockResolvedValue({
      providers: [{ id: "openai", name: "OpenAI", authenticated: false }],
    });
    mockFetchGlobalSettings.mockResolvedValue({
      modelOnboardingComplete: false,
      defaultProvider: undefined,
      defaultModelId: undefined,
    } as never);
    // No local completion
    mockIsOnboardingCompleted.mockReturnValue(false);

    renderHook(() =>
      useAuthOnboarding({
        projectId: "proj_123",
        setupWizardOpen: false,
        openModelOnboarding,
        openSettings,
      }),
    );

    await waitFor(() => {
      expect(openModelOnboarding).toHaveBeenCalledTimes(1);
    });

    expect(openSettings).not.toHaveBeenCalled();
  });
});
