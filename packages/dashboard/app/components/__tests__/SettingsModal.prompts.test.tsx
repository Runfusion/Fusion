import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  mockFetchSettings,
  mockFetchSettingsByScope,
  mockUpdateSettings,
  mockUpdateGlobalSettings,
  mockFetchAuthStatus,
  mockFetchModels,
  mockUseMobileKeyboard,
  mockUseMemoryBackendStatus,
  mockUseWorktrunkInstallStatus,
  mockConfirm,
  defaultSettings,
  renderModal,
  waitForSettingsModalReady,
  settingsModalUser,
  installSettingsModalEnv,
} from "./SettingsModal.test-harness";

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
    fetchSettingsByScope: (...args: unknown[]) => mockFetchSettingsByScope(...args),
    updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
    updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
    fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
    fetchModels: (...args: unknown[]) => mockFetchModels(...args),
  });
});

vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: (...args: unknown[]) => mockUseMemoryBackendStatus(...args),
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: unknown[]) => mockUseMobileKeyboard(...args),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: (...args: unknown[]) => mockConfirm(...args) }),
}));

vi.mock("../../hooks/useWorktrunkInstallStatus", () => ({
  useWorktrunkInstallStatus: (...args: unknown[]) => mockUseWorktrunkInstallStatus(...args),
}));

vi.mock("../PluginManager", () => ({
  PluginManager: () => <div data-testid="plugin-manager">Plugin manager content</div>,
}));

vi.mock("../PiExtensionsManager", () => ({
  PiExtensionsManager: () => <div data-testid="pi-extensions-manager">Pi extensions content</div>,
}));

describe("SettingsModal Prompts section", () => {
  installSettingsModalEnv();

  it("explains prompt ownership, opens workflow settings, and keeps prompt tabs", async () => {
    const onOpenWorkflowSettings = vi.fn();
    mockFetchSettings.mockResolvedValue({
      ...defaultSettings,
      agentPrompts: {
        templates: [
          {
            id: "custom-executor",
            name: "Custom Executor",
            description: "Custom executor system prompt",
            role: "executor",
            prompt: "Custom executor prompt",
          },
        ],
      },
      promptOverrides: { "executor-welcome": "Custom welcome" },
    });
    mockFetchSettingsByScope.mockResolvedValue({
      global: defaultSettings,
      project: {
        agentPrompts: {
          templates: [
            {
              id: "custom-executor",
              name: "Custom Executor",
              description: "Custom executor system prompt",
              role: "executor",
              prompt: "Custom executor prompt",
            },
          ],
        },
        promptOverrides: { "executor-welcome": "Custom welcome" },
      },
    });

    renderModal({ initialSection: "prompts", onOpenWorkflowSettings });
    await waitForSettingsModalReady();

    expect(screen.getByText(/agent role system prompt templates, role assignments, and global PromptKey segment overrides/i)).toBeInTheDocument();
    expect(screen.getByText(/Per-workflow step prompts for prompt and gate nodes live in the Workflow Editor/i)).toBeInTheDocument();

    await settingsModalUser.click(screen.getByRole("button", { name: "Open workflow settings" }));
    expect(onOpenWorkflowSettings).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("button", { name: /Templates/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Assignments/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Overrides/i })).toBeInTheDocument();
    expect(screen.getByText("Custom Executor")).toBeInTheDocument();
  });

  it("disables the workflow settings affordance when standalone wiring is absent", async () => {
    renderModal({ initialSection: "prompts" });
    await waitForSettingsModalReady();

    const button = screen.getByRole("button", { name: "Open workflow settings" });
    expect(button).toBeDisabled();
    await settingsModalUser.click(button);
  });
});
