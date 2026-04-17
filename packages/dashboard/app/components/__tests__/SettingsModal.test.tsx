import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";
import type { Settings, ThemeMode, ColorTheme } from "@fusion/core";

type SettingsWithAutoArchive = Settings & {
  autoArchiveDoneTasksEnabled?: boolean;
  autoArchiveDoneAfterMs?: number;
  archiveAgentLogMode?: "none" | "compact" | "full";
};

const defaultSettings: SettingsWithAutoArchive = {
  maxConcurrent: 2,
  maxTriageConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: false,
  autoMerge: true,
  mergeStrategy: "direct",
  recycleWorktrees: false,
  worktreeInitCommand: "",
  testCommand: "",
  buildCommand: "",
  autoResolveConflicts: true,
  smartConflictResolution: true,
  modelPresets: [],
  autoSelectModelPreset: false,
  defaultPresetBySize: {},
  ntfyEnabled: false,
  ntfyTopic: undefined,
  ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review"],
  taskStuckTimeoutMs: undefined,
  maxStuckKills: 6,
  specStalenessEnabled: false,
  specStalenessMaxAgeMs: 6 * 60 * 60 * 1000,
  runStepsInNewSessions: false,
  maxParallelSteps: 2,
  showQuickChatFAB: false,
  settingsSyncEnabled: false,
  settingsSyncAuth: false,
  settingsSyncInterval: 900000,
  settingsSyncConflictResolution: "last-write-wins",
};

vi.mock("../../api", () => ({
  fetchSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  fetchSettingsByScope: vi.fn(() => Promise.resolve({ global: { ...defaultSettings }, project: {} })),
  updateSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  updateGlobalSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  fetchAuthStatus: vi.fn(() => Promise.resolve({ providers: [{ id: "anthropic", name: "Anthropic", authenticated: false }] })),
  loginProvider: vi.fn(() => Promise.resolve({ url: "https://auth.example.com/login" })),
  logoutProvider: vi.fn(() => Promise.resolve({ success: true })),
  saveApiKey: vi.fn(() => Promise.resolve({ success: true })),
  clearApiKey: vi.fn(() => Promise.resolve({ success: true })),
  fetchModels: vi.fn(() => Promise.resolve({
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
  })),
  testNtfyNotification: vi.fn(() => Promise.resolve({ success: true })),
  // Global concurrency mocks
  fetchGlobalConcurrency: vi.fn(() => Promise.resolve({ globalMaxConcurrent: 4, currentlyActive: 0, queuedCount: 0, projectsActive: {} })),
  updateGlobalConcurrency: vi.fn(() => Promise.resolve({ globalMaxConcurrent: 4, currentlyActive: 0, queuedCount: 0, projectsActive: {} })),
  // Plugin API mocks
  fetchPlugins: vi.fn(() => Promise.resolve([])),
  installPlugin: vi.fn(() => Promise.resolve({ id: "test-plugin", name: "Test Plugin", version: "1.0.0", state: "started" as const, enabled: true, settings: {}, settingsSchema: {} })),
  enablePlugin: vi.fn(() => Promise.resolve({ id: "test-plugin", name: "Test Plugin", version: "1.0.0", state: "started" as const, enabled: true, settings: {}, settingsSchema: {} })),
  disablePlugin: vi.fn(() => Promise.resolve({ id: "test-plugin", name: "Test Plugin", version: "1.0.0", state: "stopped" as const, enabled: false, settings: {}, settingsSchema: {} })),
  uninstallPlugin: vi.fn(() => Promise.resolve()),
  fetchPluginSettings: vi.fn(() => Promise.resolve({})),
  updatePluginSettings: vi.fn(() => Promise.resolve({})),
  reloadPlugin: vi.fn(() => Promise.resolve({ id: "test-plugin", name: "Test Plugin", version: "1.0.0", state: "started" as const, enabled: true, settings: {}, settingsSchema: {} })),
  fetchBackups: vi.fn(() => Promise.resolve({ backups: [], totalSize: 0 })),
  createBackup: vi.fn(() => Promise.resolve({ success: true })),
  exportSettings: vi.fn(() => Promise.resolve({ version: 1, exportedAt: new Date().toISOString(), global: undefined, project: {} })),
  importSettings: vi.fn(() => Promise.resolve({ success: true, globalCount: 0, projectCount: 0 })),
  fetchMemoryFiles: vi.fn(() => Promise.resolve({
    files: [
      {
        path: ".fusion/memory/DREAMS.md",
        label: "Dreams",
        layer: "dreams",
        size: 0,
        updatedAt: "2026-04-17T12:00:00.000Z",
      },
      {
        path: ".fusion/memory/MEMORY.md",
        label: "Long-term memory",
        layer: "long-term",
        size: 0,
        updatedAt: "2026-04-17T12:00:00.000Z",
      },
    ],
  })),
  fetchMemoryFile: vi.fn((path = ".fusion/memory/DREAMS.md") => Promise.resolve({ path, content: "" })),
  saveMemoryFile: vi.fn(() => Promise.resolve({ success: true })),
  compactMemory: vi.fn(() => Promise.resolve({ content: "# Compacted Memory\n\nImportant content." })),
  installQmd: vi.fn(() => Promise.resolve({ success: true, qmdAvailable: true, qmdInstallCommand: "bun add -g qmd" })),
  testMemoryRetrieval: vi.fn(() => Promise.resolve({
    query: "project memory",
    qmdAvailable: true,
    usedFallback: false,
    qmdInstallCommand: "bun add -g qmd",
    results: [],
  })),
}));

// Mock useMemoryBackendStatus hook
vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: vi.fn(() => ({
    status: {
      currentBackend: "qmd",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: false,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
      qmdAvailable: true,
      qmdInstallCommand: "bun add -g qmd",
    },
    currentBackend: "file",
    capabilities: {
      readable: true,
      writable: true,
      supportsAtomicWrite: true,
      hasConflictResolution: false,
      persistent: true,
    },
    availableBackends: ["file", "readonly", "qmd"],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

// Mock useMemoryBackendStatus hook
vi.mock("../../hooks/useMemoryBackendStatus", () => ({
  useMemoryBackendStatus: vi.fn(() => ({
    status: {
      currentBackend: "qmd",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: false,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
      qmdAvailable: true,
      qmdInstallCommand: "bun add -g qmd",
    },
    currentBackend: "file",
    capabilities: {
      readable: true,
      writable: true,
      supportsAtomicWrite: true,
      hasConflictResolution: false,
      persistent: true,
    },
    availableBackends: ["file", "readonly", "qmd"],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

// Mock PluginManager to avoid SSE setup in tests
vi.mock("../PluginManager", () => ({
  PluginManager: vi.fn(({ addToast }) => (
    <div data-testid="plugin-manager">
      <p>Plugin Manager Component</p>
      <button onClick={() => addToast?.("Plugin action", "success")}>Mock Plugin Action</button>
    </div>
  )),
}));

// Mock usePluginUiSlots hook
const mockUsePluginUiSlots = vi.fn(() => ({
  slots: [],
  getSlotsForId: vi.fn(() => []),
  loading: false,
  error: null,
}));

vi.mock("../../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: (...args: unknown[]) => mockUsePluginUiSlots(...args),
}));

import { fetchSettings, fetchSettingsByScope, updateSettings, updateGlobalSettings, fetchAuthStatus, loginProvider, logoutProvider, saveApiKey, clearApiKey, fetchModels, testNtfyNotification, fetchGlobalConcurrency, updateGlobalConcurrency } from "../../api";

const onClose = vi.fn();
const addToast = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsModal", () => {
  it("renders all sidebar section labels", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Each label appears in the sidebar nav
    expect(screen.getAllByText("General").length).toBeGreaterThanOrEqual(1);
    const nav = screen.getAllByText("Scheduling");
    expect(nav.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Worktrees").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Commands").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Merge").length).toBeGreaterThanOrEqual(1);
  });

  it("shows General fields when General section is selected", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click on General (Authentication is now default, so we need to navigate)
    fireEvent.click(screen.getAllByText("General")[0]);

    expect(screen.getByLabelText("Task Prefix")).toBeTruthy();
    // Fields from other sections should not be visible
    expect(screen.queryByLabelText("Max Concurrent Tasks")).toBeNull();
    expect(screen.queryByLabelText("Max Worktrees")).toBeNull();
  });

  it("invokes appearance callbacks when theme controls are used", async () => {
    const handleThemeModeChange = vi.fn();
    const handleColorThemeChange = vi.fn();

    render(
      <SettingsModal
        onClose={onClose}
        addToast={addToast}
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={handleThemeModeChange}
        onColorThemeChange={handleColorThemeChange}
      />,
    );

    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Appearance")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Light mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Forest theme" }));

    expect(handleThemeModeChange).toHaveBeenCalledWith("light");
    expect(handleColorThemeChange).toHaveBeenCalledWith("forest");
  });

  it("reflects selected appearance values when parent updates controlled props", async () => {
    function ControlledAppearanceModal() {
      const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
      const [colorTheme, setColorTheme] = useState<ColorTheme>("default");

      return (
        <SettingsModal
          onClose={onClose}
          addToast={addToast}
          themeMode={themeMode}
          colorTheme={colorTheme}
          onThemeModeChange={setThemeMode}
          onColorThemeChange={setColorTheme}
        />
      );
    }

    render(<ControlledAppearanceModal />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Appearance")[0]);

    const lightModeButton = screen.getByRole("button", { name: "Light mode" });
    const forestThemeButton = screen.getByRole("button", { name: "Forest theme" });

    fireEvent.click(lightModeButton);
    fireEvent.click(forestThemeButton);

    await waitFor(() => {
      expect(lightModeButton).toHaveAttribute("aria-pressed", "true");
      expect(forestThemeButton).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("Light / Forest")).toBeTruthy();
    });
  });

  it("Appearance controls invoke theme callbacks and keep UI state in sync", async () => {
    const user = userEvent.setup();
    const themeModeSpy = vi.fn();
    const colorThemeSpy = vi.fn();

    function ThemeHarness() {
      const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
      const [colorTheme, setColorTheme] = useState<ColorTheme>("default");

      return (
        <SettingsModal
          onClose={onClose}
          addToast={addToast}
          initialSection="appearance"
          themeMode={themeMode}
          colorTheme={colorTheme}
          onThemeModeChange={(mode) => {
            themeModeSpy(mode);
            setThemeMode(mode);
          }}
          onColorThemeChange={(theme) => {
            colorThemeSpy(theme);
            setColorTheme(theme);
          }}
        />
      );
    }

    render(<ThemeHarness />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getByText(/Dark \/ Default/)).toBeTruthy();

    await user.click(screen.getByLabelText("Light mode"));
    await user.click(screen.getByLabelText("Ocean theme"));

    expect(themeModeSpy).toHaveBeenCalledWith("light");
    expect(colorThemeSpy).toHaveBeenCalledWith("ocean");
    expect(screen.getByText(/Light \/ Ocean/)).toBeTruthy();

    const lightButton = screen.getByLabelText("Light mode");
    const oceanButton = screen.getByLabelText("Ocean theme");
    expect(lightButton.getAttribute("aria-pressed")).toBe("true");
    expect(oceanButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches section when clicking sidebar item", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click Scheduling
    fireEvent.click(screen.getByText("Scheduling"));
    expect(screen.getByLabelText("Max Concurrent Tasks")).toBeTruthy();
    expect(screen.getByLabelText("Global Max Concurrent")).toBeTruthy();
    expect(screen.queryByLabelText("Task Prefix")).toBeNull();

    // Click Commands
    fireEvent.click(screen.getByText("Commands"));
    expect(screen.getByLabelText("Test Command")).toBeTruthy();
    expect(screen.getByLabelText("Build Command")).toBeTruthy();
    expect(screen.queryByLabelText("Max Concurrent Tasks")).toBeNull();
  });

  it("invokes appearance callbacks when theme controls are used", async () => {
    const handleThemeModeChange = vi.fn();
    const handleColorThemeChange = vi.fn();

    render(
      <SettingsModal
        onClose={onClose}
        addToast={addToast}
        themeMode="dark"
        colorTheme="default"
        onThemeModeChange={handleThemeModeChange}
        onColorThemeChange={handleColorThemeChange}
      />,
    );

    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Appearance")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Light mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Forest theme" }));

    expect(handleThemeModeChange).toHaveBeenCalledWith("light");
    expect(handleColorThemeChange).toHaveBeenCalledWith("forest");
  });

  it("reflects selected appearance values when parent updates controlled props", async () => {
    function ControlledAppearanceModal() {
      const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
      const [colorTheme, setColorTheme] = useState<ColorTheme>("default");

      return (
        <SettingsModal
          onClose={onClose}
          addToast={addToast}
          themeMode={themeMode}
          colorTheme={colorTheme}
          onThemeModeChange={setThemeMode}
          onColorThemeChange={setColorTheme}
        />
      );
    }

    render(<ControlledAppearanceModal />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Appearance")[0]);

    const lightModeButton = screen.getByRole("button", { name: "Light mode" });
    const forestThemeButton = screen.getByRole("button", { name: "Forest theme" });

    fireEvent.click(lightModeButton);
    fireEvent.click(forestThemeButton);

    await waitFor(() => {
      expect(lightModeButton).toHaveAttribute("aria-pressed", "true");
      expect(forestThemeButton).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("Light / Forest")).toBeTruthy();
    });
  });

  it("all settings fields are present across all sections", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // General
    fireEvent.click(screen.getAllByText("General")[0]);
    expect(screen.getByLabelText("Task Prefix")).toBeTruthy();

    // Scheduling
    fireEvent.click(screen.getByText("Scheduling"));
    expect(screen.getByLabelText("Max Concurrent Tasks")).toBeTruthy();
    expect(screen.getByLabelText("Global Max Concurrent")).toBeTruthy();
    expect(screen.getByLabelText("Poll Interval (ms)")).toBeTruthy();

    // Worktrees
    fireEvent.click(screen.getByText("Worktrees"));
    expect(screen.getByLabelText("Max Worktrees")).toBeTruthy();
    expect(screen.getByLabelText("Worktree Init Command")).toBeTruthy();
    expect(screen.getByText("Recycle worktrees")).toBeTruthy();

    // Commands
    fireEvent.click(screen.getByText("Commands"));
    expect(screen.getByLabelText("Test Command")).toBeTruthy();
    expect(screen.getByLabelText("Build Command")).toBeTruthy();

    // Merge
    fireEvent.click(screen.getByText("Merge"));
    expect(screen.getByText("Auto-merge completed tasks")).toBeTruthy();
    expect(screen.getByLabelText("Auto-completion mode")).toBeTruthy();
    expect(screen.getByText("Include task ID in commit scope")).toBeTruthy();
    expect(screen.getByText("Auto-resolve conflicts in lock files and generated files")).toBeTruthy();
    expect(screen.getByText("Smart conflict resolution")).toBeTruthy();
  });

  it("shows Recycle worktrees checkbox in Worktrees section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Worktrees"));
    const checkbox = screen.getByLabelText("Recycle worktrees");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");
  });

  it("toggling recycleWorktrees checkbox sends true in save payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Worktrees"));
    const checkbox = screen.getByLabelText("Recycle worktrees");
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.recycleWorktrees).toBe(true);
  });

  it("Task Prefix field saves correctly when set", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("General")[0]);
    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "PROJ" } });
    expect(input.value).toBe("PROJ");

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.taskPrefix).toBe("PROJ");
  });

  it("Task Prefix field submits undefined when empty (uses default)", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("General")[0]);
    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.taskPrefix).toBeUndefined();
  });

  it("Task Prefix shows validation error for invalid input", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("General")[0]);
    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad" } });

    expect(screen.getByText("Prefix must be 1–10 uppercase letters")).toBeTruthy();
  });

  it("Task Prefix validation error prevents save", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("General")[0]);
    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad" } });

    fireEvent.click(screen.getByText("Save"));
    // Should not have called updateSettings due to validation error
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("shows Show quick chat button checkbox in General section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("General")[0]);
    const checkbox = screen.getByLabelText("Show quick chat button");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");
  });

  it("showQuickChatFAB defaults to unchecked (false) when not set", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("General")[0]);
    const checkbox = screen.getByLabelText("Show quick chat button") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("showQuickChatFAB defaults to checked when setting is true", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      showQuickChatFAB: true,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("General")[0]);
    const checkbox = screen.getByLabelText("Show quick chat button") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("showQuickChatFAB is unchecked when setting is false", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      showQuickChatFAB: false,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("General")[0]);
    const checkbox = screen.getByLabelText("Show quick chat button") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("toggling showQuickChatFAB checkbox sends true in save payload when checked", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("General")[0]);
    const checkbox = screen.getByLabelText("Show quick chat button");
    // Default is unchecked (false), click to check
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.showQuickChatFAB).toBe(true);
  });

  it("toggling showQuickChatFAB checkbox sends false in save payload when unchecked", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      showQuickChatFAB: true,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("General")[0]);
    const checkbox = screen.getByLabelText("Show quick chat button");
    // Default is checked (true), click to uncheck
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.showQuickChatFAB).toBe(false);
  });

  it("shows Auto-completion mode select in Merge section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const select = screen.getByLabelText("Auto-completion mode") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("direct");
  });

  it("saves pull-request mergeStrategy when selected", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const select = screen.getByLabelText("Auto-completion mode") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "pull-request" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.mergeStrategy).toBe("pull-request");
  });

  it("shows Include task ID in commit scope checkbox in Merge section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Include task ID in commit scope");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");
  });

  it("shows Auto-resolve conflicts checkbox in Merge section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Auto-resolve conflicts in lock files and generated files");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");
  });

  it("toggling includeTaskIdInCommit checkbox sends false in save payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Include task ID in commit scope");
    // Default is checked (true), click to uncheck
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.includeTaskIdInCommit).toBe(false);
  });

  it("shows Add author attribution to commits checkbox in Merge section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Add author attribution to commits");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");
  });

  it("toggling commitAuthorEnabled checkbox sends false in save payload when unchecked", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Add author attribution to commits");
    // Default is checked (true), click to uncheck
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.commitAuthorEnabled).toBe(false);
  });

  it("shows author name and email fields when commitAuthorEnabled is true", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    // Author name and email fields should be visible when author attribution is enabled
    expect(screen.getByLabelText("Author Name")).toBeTruthy();
    expect(screen.getByLabelText("Author Email")).toBeTruthy();
  });

  it("hides author name and email fields when commitAuthorEnabled is false", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      commitAuthorEnabled: false,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    // Author name and email fields should be hidden
    expect(screen.queryByLabelText("Author Name")).toBeNull();
    expect(screen.queryByLabelText("Author Email")).toBeNull();
  });

  it("sends custom author name and email in save payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));

    // Change author name
    const nameInput = screen.getByLabelText("Author Name");
    fireEvent.change(nameInput, { target: { value: "CustomBot" } });

    // Change author email
    const emailInput = screen.getByLabelText("Author Email");
    fireEvent.change(emailInput, { target: { value: "bot@example.com" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.commitAuthorName).toBe("CustomBot");
    expect(payload.commitAuthorEmail).toBe("bot@example.com");
  });

  it("clears author name to undefined when input is emptied", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      commitAuthorName: "SomeBot",
      commitAuthorEmail: "some@example.com",
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));

    // Clear author name
    const nameInput = screen.getByLabelText("Author Name");
    fireEvent.change(nameInput, { target: { value: "" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.commitAuthorName).toBeUndefined();
  });

  it("toggling autoResolveConflicts checkbox sends false in save payload when unchecked", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Auto-resolve conflicts in lock files and generated files");
    // Default is checked (true), click to uncheck
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.autoResolveConflicts).toBe(false);
  });

  it("autoResolveConflicts defaults to enabled (true) when setting is true", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      autoResolveConflicts: true,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Auto-resolve conflicts in lock files and generated files") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("shows Smart conflict resolution checkbox in Merge section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Smart conflict resolution");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");
  });

  it("toggling smartConflictResolution checkbox sends false in save payload when unchecked", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Smart conflict resolution");
    // Default is checked (true), click to uncheck
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.smartConflictResolution).toBe(false);
  });

  it("smartConflictResolution defaults to enabled (true) when setting is true", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      smartConflictResolution: true,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Smart conflict resolution") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("smartConflictResolution checkbox submits true in save payload when checked", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      smartConflictResolution: false,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Smart conflict resolution");
    // Default is unchecked (false), click to check
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.smartConflictResolution).toBe(true);
  });

  it("groupOverlappingFiles input has type checkbox", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Serialize tasks with overlapping files");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");
  });

  it("save button calls updateSettings with form data", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.maxConcurrent).toBe(2);
    expect(payload.pollIntervalMs).toBe(15000);
  });

  it("loads and saves the central global concurrency limit", async () => {
    (fetchGlobalConcurrency as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      globalMaxConcurrent: 8,
      currentlyActive: 3,
      queuedCount: 0,
      projectsActive: {},
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} initialSection="scheduling" />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    await waitFor(() => expect(fetchGlobalConcurrency).toHaveBeenCalled());

    const input = screen.getByLabelText("Global Max Concurrent") as HTMLInputElement;
    expect(input.value).toBe("8");

    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(updateGlobalConcurrency).toHaveBeenCalledWith({ globalMaxConcurrent: 10 }));
    const projectPayload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(projectPayload.globalMaxConcurrent).toBeUndefined();
  });

  it("saving in General section updates project settings with task prefix", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click on General to navigate to General section
    fireEvent.click(screen.getAllByText("General")[0]);

    // General section is project-scoped — change a project setting
    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "TEST" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    // Verify taskPrefix is saved as project setting
    const projectPayload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(projectPayload.taskPrefix).toBe("TEST");
  });

  it("saving in Models section updates global settings with default model", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click on "Models" (global models section)
    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Select a model
    const trigger = screen.getByLabelText("Default Model");
    await user.click(trigger);
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    fireEvent.click(screen.getByText("Save"));

    // Verify default model settings are saved as global settings
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));
    const globalPayload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(globalPayload.defaultProvider).toBe("anthropic");
    expect(globalPayload.defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("saving in Models section updates global fallback model", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click on "Models" (global models section)
    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    const trigger = screen.getByLabelText("Fallback Model");
    await user.click(trigger);
    await user.click(screen.getByText("GPT-4o"));

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));
    const globalPayload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(globalPayload.fallbackProvider).toBe("openai");
    expect(globalPayload.fallbackModelId).toBe("gpt-4o");
  });

  it("stores favoriteModels from fetchModels response", async () => {
    (fetchModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: false, contextWindow: 200000 },
      ],
      favoriteProviders: ["anthropic"],
      favoriteModels: ["anthropic/claude-sonnet-4-5"],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click on "Models" (global models section)
    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // No error thrown means favoriteModels was accepted
    expect(screen.getByLabelText("Default Model")).toBeTruthy();
  });

  it("saving in Project Models section updates project settings with planning and validator models", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click on "Project Models" (project-scoped models section)
    fireEvent.click(screen.getByText("Project Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Select planning model
    const planningTrigger = screen.getByLabelText("Planning Model");
    await user.click(planningTrigger);
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    // Select validator model
    const validatorTrigger = screen.getByLabelText("Validator Model");
    await user.click(validatorTrigger);
    await user.click(screen.getByText("GPT-4o"));

    fireEvent.click(screen.getByText("Save"));

    // Verify planning and validator settings are saved as project settings
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const projectPayload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(projectPayload.planningProvider).toBe("anthropic");
    expect(projectPayload.planningModelId).toBe("claude-sonnet-4-5");
    expect(projectPayload.validatorProvider).toBe("openai");
    expect(projectPayload.validatorModelId).toBe("gpt-4o");
  });

  it("saving in Project Models section updates project settings with execution model", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click on "Project Models" (project-scoped models section)
    fireEvent.click(screen.getByText("Project Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Select execution model
    const executionTrigger = screen.getByLabelText("Execution Model");
    await user.click(executionTrigger);
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    fireEvent.click(screen.getByText("Save"));

    // Verify execution settings are saved as project settings
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const projectPayload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(projectPayload.executionProvider).toBe("anthropic");
    expect(projectPayload.executionModelId).toBe("claude-sonnet-4-5");
  });

  it("saving in Project Models section updates planning and validator fallback models", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click on "Project Models" (project-scoped models section)
    fireEvent.click(screen.getByText("Project Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    const planningFallbackTrigger = screen.getByLabelText("Planning Fallback Model");
    await user.click(planningFallbackTrigger);
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    const validatorFallbackTrigger = screen.getByLabelText("Validator Fallback Model");
    await user.click(validatorFallbackTrigger);
    await user.click(screen.getByText("GPT-4o"));

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const projectPayload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(projectPayload.planningFallbackProvider).toBe("anthropic");
    expect(projectPayload.planningFallbackModelId).toBe("claude-sonnet-4-5");
    expect(projectPayload.validatorFallbackProvider).toBe("openai");
    expect(projectPayload.validatorFallbackModelId).toBe("gpt-4o");
  });

  it("shows Models and Project Models in sidebar", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getAllByText("Models").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Project Models").length).toBeGreaterThanOrEqual(1);
  });

  it("supports creating and saving a model preset", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Model presets are in Project Models section
    fireEvent.click(screen.getByText("Project Models"));
    await user.click(screen.getByText("Add Preset"));

    await user.type(screen.getByLabelText("Name"), "Budget");

    await user.click(screen.getByText("Save preset"));
    await user.click(screen.getByText("Save"));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.modelPresets).toEqual([
      expect.objectContaining({ id: "budget", name: "Budget" }),
    ]);
  });

  it("supports auto-select preset mappings by size", async () => {
    const user = userEvent.setup();
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      modelPresets: [
        { id: "budget", name: "Budget" },
        { id: "normal", name: "Normal" },
        { id: "complex", name: "Complex" },
      ],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Auto-select presets are in Project Models section
    fireEvent.click(screen.getByText("Project Models"));
    await user.click(screen.getByLabelText("Auto-select preset based on task size"));
    fireEvent.change(screen.getByLabelText("Small tasks (S):"), { target: { value: "budget" } });
    fireEvent.change(screen.getByLabelText("Medium tasks (M):"), { target: { value: "normal" } });
    fireEvent.change(screen.getByLabelText("Large tasks (L):"), { target: { value: "complex" } });

    await user.click(screen.getByText("Save"));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.autoSelectModelPreset).toBe(true);
    expect(payload.defaultPresetBySize).toEqual({ S: "budget", M: "normal", L: "complex" });
  });

  it("shows model selector with available models grouped by provider", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Models section has default model dropdown
    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Dropdown trigger should be present
    const trigger = screen.getByLabelText("Default Model");
    expect(trigger).toBeTruthy();
    expect(trigger.tagName).toBe("BUTTON");

    // Open dropdown to see models
    await user.click(trigger);

    // Models should be visible in dropdown
    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("GPT-4o")).toBeTruthy();

    // "Use default" appears twice (trigger text + dropdown option) - use getAllByText
    const useDefaultElements = screen.getAllByText("Use default");
    expect(useDefaultElements.length).toBeGreaterThanOrEqual(1);
  });

  it("selecting a model updates form with provider and model ID", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Models section has default model dropdown
    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Open dropdown and select a model
    const trigger = screen.getByLabelText("Default Model");
    await user.click(trigger);
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    fireEvent.click(screen.getByText("Save"));
    // defaultProvider and defaultModelId are global settings, so they go through updateGlobalSettings
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.defaultProvider).toBe("anthropic");
    expect(payload.defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("Use default option clears model selection (sends null for explicit clear)", async () => {
    const user = userEvent.setup();
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Models section has default model dropdown
    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Open dropdown and select "Use default"
    const trigger = screen.getByLabelText("Default Model");
    await user.click(trigger);

    // Find and click the "Use default" option in the dropdown
    const defaultOptions = screen.getAllByText("Use default");
    const dropdownDefault = defaultOptions.find((el) =>
      el.classList.contains("model-combobox-option-text--default")
    );
    if (dropdownDefault) {
      await user.click(dropdownDefault);
    }

    fireEvent.click(screen.getByText("Save"));
    // defaultProvider and defaultModelId are global settings
    // Clearing sends null (null-as-delete semantics)
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.defaultProvider).toBeNull();
    expect(payload.defaultModelId).toBeNull();
  });

  it("shows empty state when no models available", async () => {
    (fetchModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ models: [], favoriteProviders: [], favoriteModels: [] });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Models section shows empty state when no models available
    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    await waitFor(() => {
      expect(screen.getAllByText("No models available. Configure authentication first.").length).toBeGreaterThanOrEqual(1);
    });
  });

  // --- Planning & Validation model tests ---

  it("shows Project Models section with planning and validator model dropdowns", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Project Models section has planning and validator model dropdowns
    fireEvent.click(screen.getByText("Project Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Both dropdowns should be present
    expect(screen.getByLabelText("Planning Model")).toBeTruthy();
    expect(screen.getByLabelText("Validator Model")).toBeTruthy();
  });

  it("selecting a planning model updates form with provider and model ID", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Project Models section has planning model dropdown
    fireEvent.click(screen.getByText("Project Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Open planning model dropdown and select a model
    const trigger = screen.getByLabelText("Planning Model");
    await user.click(trigger);
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    fireEvent.click(screen.getByText("Save"));
    // planningProvider and planningModelId are project settings, so they go through updateSettings
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.planningProvider).toBe("anthropic");
    expect(payload.planningModelId).toBe("claude-sonnet-4-5");
  });

  it("selecting a validator model updates form with provider and model ID", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Project Models section has validator model dropdown
    fireEvent.click(screen.getByText("Project Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Open validator model dropdown and select a model
    const trigger = screen.getByLabelText("Validator Model");
    await user.click(trigger);
    await user.click(screen.getByText("GPT-4o"));

    fireEvent.click(screen.getByText("Save"));
    // validatorProvider and validatorModelId are project settings, so they go through updateSettings
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.validatorProvider).toBe("openai");
    expect(payload.validatorModelId).toBe("gpt-4o");
  });

  describe("scope-safe save payloads", () => {
    it("global lane edits go to updateGlobalSettings and NOT to project settings", async () => {
      const user = userEvent.setup();

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Navigate to Models (global section) and change default model
      fireEvent.click(screen.getByText("Models"));
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      const defaultTrigger = screen.getByLabelText("Default Model");
      await user.click(defaultTrigger);
      await user.click(screen.getByText("Claude Sonnet 4.5"));

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

      // Global settings should have the new default model
      const globalPayload = vi.mocked(updateGlobalSettings).mock.calls[0][0];
      expect(globalPayload.defaultProvider).toBe("anthropic");
      expect(globalPayload.defaultModelId).toBe("claude-sonnet-4-5");

      // Project settings should NOT contain global lane keys
      const projectPayload = vi.mocked(updateSettings).mock.calls[0][0];
      expect(projectPayload).not.toHaveProperty("defaultProvider");
      expect(projectPayload).not.toHaveProperty("defaultModelId");
    });

    it("project lane overrides go to updateSettings and NOT to global settings", async () => {
      const user = userEvent.setup();

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Navigate to Project Models section and change planning model
      fireEvent.click(screen.getByText("Project Models"));
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      const planningTrigger = screen.getByLabelText("Planning Model");
      await user.click(planningTrigger);
      await user.click(screen.getByText("GPT-4o"));

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

      // Project settings should have the planning override
      const projectPayload = vi.mocked(updateSettings).mock.calls[0][0];
      expect(projectPayload.planningProvider).toBe("openai");
      expect(projectPayload.planningModelId).toBe("gpt-4o");

      // Global settings should NOT contain project override keys
      const globalPayload = vi.mocked(updateGlobalSettings).mock.calls[0][0];
      expect(globalPayload).not.toHaveProperty("planningProvider");
      expect(globalPayload).not.toHaveProperty("planningModelId");
    });

    it("resetting a project lane sends null-as-delete payload", async () => {
      const user = userEvent.setup();
      // Set up with existing planning override in the merged settings
      const settingsWithOverride = {
        ...defaultSettings,
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      };
      (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce(settingsWithOverride);
      // And in scoped settings
      (fetchSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        global: { ...defaultSettings },
        project: {
          planningProvider: "anthropic",
          planningModelId: "claude-sonnet-4-5",
        },
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Navigate to Project Models section
      fireEvent.click(screen.getByText("Project Models"));
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Verify the planning lane shows as overridden
      const planningBadge = screen.getByText("Override (Project)");
      expect(planningBadge).toBeTruthy();

      // Click reset button for planning lane
      const resetButtons = screen.getAllByText("Reset");
      await user.click(resetButtons[0]);

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

      // Project settings should have null for the reset lane
      const projectPayload = vi.mocked(updateSettings).mock.calls[0][0];
      expect(projectPayload.planningProvider).toBeNull();
      expect(projectPayload.planningModelId).toBeNull();
    });

    it("inherited lanes are not written to project payload", async () => {
      const user = userEvent.setup();

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Navigate to Project Models section
      fireEvent.click(screen.getByText("Project Models"));
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Verify lanes show as inherited (don't change anything)
      const inheritedBadges = screen.getAllByText("Inherited (Global)");
      expect(inheritedBadges.length).toBeGreaterThanOrEqual(1);

      // Just save without changing anything
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

      // Project settings should NOT contain model lane keys (they're inherited)
      const projectPayload = vi.mocked(updateSettings).mock.calls[0][0];
      expect(projectPayload).not.toHaveProperty("planningProvider");
      expect(projectPayload).not.toHaveProperty("planningModelId");
      expect(projectPayload).not.toHaveProperty("validatorProvider");
      expect(projectPayload).not.toHaveProperty("validatorModelId");
    });
  });

  it("shows empty state in Models section when no models available", async () => {
    (fetchModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ models: [], favoriteProviders: [], favoriteModels: [] });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    await waitFor(() => {
      expect(screen.getAllByText("No models available. Configure authentication first.").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows Authentication in sidebar", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getAllByText("Authentication").length).toBeGreaterThanOrEqual(1);
  });

  it("Authentication nav item has globe icon in sidebar", async () => {
    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Find the Authentication nav item in the sidebar
    const authNavItem = container.querySelector(".settings-nav-item");
    expect(authNavItem).toBeTruthy();
    expect(authNavItem?.textContent?.trim()).toBe("Authentication");

    // Check that it has a globe icon (Globe icon component renders as SVG with specific aria-label)
    const globeIcon = authNavItem?.querySelector('[aria-label="Global setting"]');
    expect(globeIcon).toBeTruthy();
  });

  it("shows provider auth status when Authentication section is selected", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("✗ Not connected")).toBeTruthy();
  });

  it("shows authenticated status with checkmark", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [{ id: "anthropic", name: "Anthropic", authenticated: true }],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    expect(screen.getByText("✓ Active")).toBeTruthy();
    expect(screen.getByText("Logout")).toBeTruthy();
  });

  it("Login button calls loginProvider and opens URL", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Login"));
    await waitFor(() => expect(loginProvider).toHaveBeenCalledWith("anthropic"));

    expect(openSpy).toHaveBeenCalledWith("https://auth.example.com/login", "_blank");

    vi.unstubAllGlobals();
  });

  it("Logout button calls logoutProvider and refreshes status", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [{ id: "anthropic", name: "Anthropic", authenticated: true }],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Logout"));
    await waitFor(() => expect(logoutProvider).toHaveBeenCalledWith("anthropic"));

    // Should refresh auth status after logout
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalledTimes(2));
    expect(addToast).toHaveBeenCalledWith("Logged out", "success");
  });

  it("auth status badges have proper class names", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const authBadge = screen.getByTestId("auth-status-anthropic");
    expect(authBadge.className).toContain("auth-status-badge");
    expect(authBadge.className).toContain("authenticated");

    const unauthBadge = screen.getByTestId("auth-status-github");
    expect(unauthBadge.className).toContain("auth-status-badge");
    expect(unauthBadge.className).toContain("not-authenticated");
  });

  it("renders authenticated providers before unauthenticated when API returns mixed order", async () => {
    // API returns GitHub first (authenticated) and Anthropic second (not authenticated)
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "github", name: "GitHub", authenticated: true },
        { id: "anthropic", name: "Anthropic", authenticated: false },
      ],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // GitHub (authenticated) should appear first
    const container = document.body;
    const cards = container.querySelectorAll(".auth-provider-card");
    expect(cards.length).toBe(2);

    // First card should be GitHub (authenticated) - check by looking for "GitHub" text in first card
    const firstCardText = cards[0].textContent;
    expect(firstCardText).toContain("GitHub");
    expect(firstCardText).toContain("✓ Active");

    // Second card should be Anthropic (unauthenticated)
    const secondCardText = cards[1].textContent;
    expect(secondCardText).toContain("Anthropic");
    expect(secondCardText).toContain("✗ Not connected");
  });

  it("sorts providers alphabetically within each auth-state bucket", async () => {
    // API returns in reverse alphabetical order
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "zod", name: "Zod", authenticated: false },
        { id: "anthropic", name: "Anthropic", authenticated: false },
        { id: "azure", name: "Azure", authenticated: false },
      ],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const cards = document.body.querySelectorAll(".auth-provider-card");
    expect(cards.length).toBe(3);

    // Should be sorted alphabetically: Anthropic, Azure, Zod
    const names = Array.from(cards).map(card => {
      const strong = card.querySelector("strong");
      return strong?.textContent;
    });
    expect(names).toEqual(["Anthropic", "Azure", "Zod"]);
  });

  it("renders Authenticated and Available group labels in auth section", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // Should show "Authenticated" group label (authenticated providers)
    expect(screen.getAllByText("Authenticated").length).toBeGreaterThanOrEqual(1);
    // Should show "Available" group label (unauthenticated providers)
    expect(screen.getAllByText("Available").length).toBeGreaterThanOrEqual(1);
  });

  it("auth provider rows use auth-provider-card class", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const providerRow = screen.getByText("Anthropic").closest(".auth-provider-card");
    expect(providerRow).toBeTruthy();
  });

  it("model section renders CustomModelDropdown button", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // CustomModelDropdown renders as a button trigger, not a select element
    const trigger = screen.getByLabelText("Default Model");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");

    // Open dropdown to verify it works
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByPlaceholderText("Filter models…")).toBeTruthy();
  });

  it("checkbox labels use checkbox-label class", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const label = screen.getByText("Serialize tasks with overlapping files");
    expect(label.className).toContain("checkbox-label");
  });

  it("no inline style attributes remain on SettingsModal elements", async () => {
    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Check that no elements in the settings content have inline styles
    const elementsWithStyle = container.querySelectorAll("[style]");
    expect(elementsWithStyle.length).toBe(1);
  });

  it("shows Thinking Effort dropdown with correct options in Models section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    const select = screen.getByLabelText("Thinking Effort") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");

    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toEqual(["Default", "Off", "Minimal", "Low", "Medium", "High"]);
  });

  it("changing Thinking Effort dropdown updates form and is included in save payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    const select = screen.getByLabelText("Thinking Effort") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "high" } });

    fireEvent.click(screen.getByText("Save"));
    // defaultThinkingLevel is a global setting
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.defaultThinkingLevel).toBe("high");
  });

  it("Thinking Effort dropdown is hidden when selected model does not support reasoning", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    expect(screen.queryByLabelText("Thinking Effort")).toBeNull();
  });

  it("shows loading state during login", async () => {
    // Make loginProvider hang
    (loginProvider as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("open", vi.fn());

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Login"));

    // While login is in progress, button should show waiting state
    // (loginProvider hasn't resolved yet so we can't waitFor it)
    // The button will be disabled during the async operation

    vi.unstubAllGlobals();
  });

  it("opens to Authentication section when initialSection='authentication' is passed", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} initialSection="authentication" />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // Authentication content should be visible immediately
    expect(screen.getByText("Anthropic")).toBeTruthy();
    // General content should NOT be visible
    expect(screen.queryByLabelText("Task Prefix")).toBeNull();
  });

  it("defaults to Authentication section when no initialSection is passed", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // Authentication content should be visible (it's the default section now)
    expect(screen.getByText("Anthropic")).toBeTruthy();
    // General content should NOT be visible
    expect(screen.queryByLabelText("Task Prefix")).toBeNull();
  });

  it("shows sign-in hint when no providers are authenticated", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: false },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    expect(screen.getByText("Sign in to at least one provider to get started with AI models.")).toBeTruthy();
    // Provider rows should still be visible
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
  });

  it("hides sign-in hint when at least one provider is authenticated", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    expect(screen.queryByText("Sign in to at least one provider to get started with AI models.")).toBeNull();
    // Provider rows should still be visible
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
  });

  // --- API key provider tests ---

  it("renders password input and Save button for api_key providers", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" as const },
      ],
    });

    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const input = screen.getByPlaceholderText("Enter API key") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe("password");

    // The Save button should be inside the auth-apikey-section, not the global save
    const apiKeySection = container.querySelector(".auth-apikey-section");
    expect(apiKeySection).toBeTruthy();
    expect(apiKeySection!.querySelector("button")!.textContent?.trim()).toBe("Save");

    // Should NOT show Login button for api_key providers
    expect(screen.queryByText("Login")).toBeNull();
  });

  it("renders Clear button for authenticated api_key providers", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "openrouter", name: "OpenRouter", authenticated: true, type: "api_key" as const },
      ],
    });

    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // The Clear button should be inside the auth-apikey-section
    const apiKeySection = container.querySelector(".auth-apikey-section");
    expect(apiKeySection).toBeTruthy();
    expect(apiKeySection!.querySelector("button")!.textContent?.trim()).toBe("Clear");

    // Should NOT show Logout button for api_key providers
    expect(screen.queryByText("Logout")).toBeNull();
  });

  it("saves API key when Save is clicked", async () => {
    

    (fetchAuthStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        providers: [
          { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" as const },
        ],
      })
      .mockResolvedValueOnce({
        providers: [
          { id: "openrouter", name: "OpenRouter", authenticated: true, type: "api_key" as const },
        ],
      });

    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const input = screen.getByPlaceholderText("Enter API key");
    fireEvent.change(input, { target: { value: "sk-test-key-123" } });

    const apiKeySection = container.querySelector(".auth-apikey-section")!;
    fireEvent.click(apiKeySection.querySelector("button")!);

    await waitFor(() => expect(saveApiKey).toHaveBeenCalledWith("openrouter", "sk-test-key-123"));
    expect(addToast).toHaveBeenCalledWith("API key saved", "success");
  });

  it("shows error when saving empty API key", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" as const },
      ],
    });

    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const apiKeySection = container.querySelector(".auth-apikey-section")!;
    fireEvent.click(apiKeySection.querySelector("button")!);

    expect(screen.getByText("API key is required")).toBeTruthy();
  });

  it("clears API key when Clear is clicked", async () => {
    

    (fetchAuthStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        providers: [
          { id: "openrouter", name: "OpenRouter", authenticated: true, type: "api_key" as const },
        ],
      })
      .mockResolvedValueOnce({
        providers: [
          { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" as const },
        ],
      });

    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const apiKeySection = container.querySelector(".auth-apikey-section")!;
    fireEvent.click(apiKeySection.querySelector("button")!);

    await waitFor(() => expect(clearApiKey).toHaveBeenCalledWith("openrouter"));
    expect(addToast).toHaveBeenCalledWith("API key cleared", "success");
  });

  it("handles API key save error gracefully", async () => {
    
    (saveApiKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" as const },
      ],
    });

    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const input = screen.getByPlaceholderText("Enter API key");
    fireEvent.change(input, { target: { value: "sk-key" } });

    const apiKeySection = container.querySelector(".auth-apikey-section")!;
    fireEvent.click(apiKeySection.querySelector("button")!);

    await waitFor(() => expect(screen.getByText("Network error")).toBeTruthy());
  });

  it("shows input field after clearing API key (badge updates to not authenticated)", async () => {
    

    (fetchAuthStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        providers: [
          { id: "openrouter", name: "OpenRouter", authenticated: true, type: "api_key" as const },
        ],
      })
      .mockResolvedValueOnce({
        providers: [
          { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" as const },
        ],
      });

    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // Initially should show "Clear" button (authenticated)
    expect(container.querySelector(".auth-apikey-section button")?.textContent).toContain("Clear");

    // Click Clear
    fireEvent.click(container.querySelector(".auth-apikey-section button")!);

    await waitFor(() => expect(clearApiKey).toHaveBeenCalledWith("openrouter"));

    // After clearing, fetchAuthStatus should be called again (loadAuthStatus)
    // and the UI should show an input field (not authenticated state)
    await waitFor(() => {
      expect(container.querySelector(".auth-apikey-section input")).toBeTruthy();
    });
    expect(addToast).toHaveBeenCalledWith("API key cleared", "success");
  });

  it("handles API key clear error gracefully", async () => {
    

    (clearApiKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Clear failed"));

    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "openrouter", name: "OpenRouter", authenticated: true, type: "api_key" as const },
      ],
    });

    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const apiKeySection = container.querySelector(".auth-apikey-section")!;
    fireEvent.click(apiKeySection.querySelector("button")!);

    await waitFor(() => expect(clearApiKey).toHaveBeenCalledWith("openrouter"));
    expect(addToast).toHaveBeenCalledWith("Clear failed", "error");
  });

  it("shows Login for oauth providers and password input for api_key providers side by side", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" as const },
        { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" as const },
      ],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // OAuth provider shows Login
    expect(screen.getByText("Login")).toBeTruthy();
    // API key provider shows password input
    expect(screen.getByPlaceholderText("Enter API key")).toBeTruthy();
  });

  it("does not prefill stored key values in the input", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "openrouter", name: "OpenRouter", authenticated: true, type: "api_key" as const },
      ],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const input = screen.getByPlaceholderText("Enter API key") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  // --- Mobile structure tests (DOM classes that responsive CSS targets) ---

  it("has .settings-layout wrapping sidebar and content", async () => {
    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const layout = container.querySelector(".settings-layout");
    expect(layout).toBeTruthy();
    expect(layout!.querySelector(".settings-sidebar")).toBeTruthy();
    expect(layout!.querySelector(".settings-content")).toBeTruthy();
  });

  it("has .settings-sidebar with 17 .settings-nav-item buttons for all sections", async () => {
    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const sidebar = container.querySelector(".settings-sidebar");
    expect(sidebar).toBeTruthy();
    const navItems = sidebar!.querySelectorAll(".settings-nav-item");
    // 17 nav items (group headers are not nav items)
    expect(navItems.length).toBe(17);

    // Labels include scope icons (Globe for global, Folder for project)
    const labels = Array.from(navItems).map((el) => el.textContent?.trim());
    expect(labels).toEqual([
      "Authentication",
      "Pi Extensions",
      "Appearance",
      "Notifications",
      "Node Sync",
      "Models",
      "Project Models",
      "General",
      "Scheduling",
      "Worktrees",
      "Commands",
      "Merge",
      "Memory",
      "Experimental Features",
      "Prompts",
      "Backups",
      "Plugins",
    ]);
  });

  it("has .settings-content as sibling of .settings-sidebar", async () => {
    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const layout = container.querySelector(".settings-layout");
    const children = Array.from(layout!.children);
    const sidebar = children.find((el) => el.classList.contains("settings-sidebar"));
    const content = children.find((el) => el.classList.contains("settings-content"));
    expect(sidebar).toBeTruthy();
    expect(content).toBeTruthy();
  });

  it("marks the active nav item with .active class", async () => {
    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Default active section is Authentication (first in sidebar order)
    const activeItems = container.querySelectorAll(".settings-nav-item.active");
    expect(activeItems.length).toBe(1);
    expect(activeItems[0].textContent?.trim()).toBe("Authentication");

    // Switch to General
    fireEvent.click(screen.getAllByText("General")[0]);
    const newActive = container.querySelectorAll(".settings-nav-item.active");
    expect(newActive.length).toBe(1);
    expect(newActive[0].textContent?.trim()).toBe("General");
  });

  it("auth provider rows contain .auth-provider-info and action button", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });

    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Authentication")[0]);
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const rows = container.querySelectorAll(".auth-provider-card");
    expect(rows.length).toBe(2);

    for (const row of rows) {
      expect(row.querySelector(".auth-provider-info")).toBeTruthy();
      expect(row.querySelector("button")).toBeTruthy();
    }
  });

  // --- Notifications section tests ---

  it("shows Notifications in sidebar", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getAllByText("Notifications").length).toBeGreaterThanOrEqual(1);
  });

  it("shows ntfy enable checkbox in Notifications section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");
  });

  it("ntfy topic input is hidden when ntfy is disabled", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    expect(screen.queryByLabelText("ntfy Topic")).toBeNull();
  });

  it("ntfy topic input is visible when ntfy is enabled", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications");
    fireEvent.click(checkbox);

    expect(screen.getByLabelText("ntfy Topic")).toBeTruthy();
  });

  it("toggling ntfyEnabled checkbox sends true in save payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications");
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByText("Save"));
    // ntfyEnabled is a global setting, so it goes through updateGlobalSettings
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.ntfyEnabled).toBe(true);
  });

  it("openrouterModelSync checkbox defaults to enabled and sends false when toggled off", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // OpenRouter model sync is in Models section (global settings)
    fireEvent.click(screen.getByText("Models"));
    const checkbox = screen.getByLabelText("Sync OpenRouter model list at dashboard startup");
    expect(checkbox).toBeTruthy();
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.openrouterModelSync).toBe(false);
  });

  it("ntfy topic field saves correctly when set", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications");
    fireEvent.click(checkbox);

    const input = screen.getByLabelText("ntfy Topic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "my-topic" } });
    expect(input.value).toBe("my-topic");

    fireEvent.click(screen.getByText("Save"));
    // ntfyTopic is a global setting
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.ntfyTopic).toBe("my-topic");
  });

  it("ntfy topic field submits null when cleared (null-as-delete semantics)", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "existing-topic",
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const input = screen.getByLabelText("ntfy Topic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    fireEvent.click(screen.getByText("Save"));
    // ntfyTopic is a global setting - clearing it sends null (null-as-delete)
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.ntfyTopic).toBeNull(); // null means "explicitly clear this field"
  });

  it("ntfy topic shows validation error for invalid input", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications");
    fireEvent.click(checkbox);

    const input = screen.getByLabelText("ntfy Topic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "invalid topic with spaces!" } });

    expect(screen.getByText("Topic must be 1–64 alphanumeric, hyphen, or underscore characters")).toBeTruthy();
  });

  it("ntfyEnabled defaults to false when setting is undefined", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("ntfyEnabled shows correct state when enabled in settings", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.getByLabelText("ntfy Topic")).toBeTruthy();
  });

  it("re-opening modal shows previously saved notification settings", async () => {
    // First render with ntfy enabled
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "saved-topic",
    });

    const { unmount } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    const input = screen.getByLabelText("ntfy Topic") as HTMLInputElement;
    expect(input.value).toBe("saved-topic");

    unmount();
    vi.clearAllMocks();

    // Re-open modal - should still show saved settings
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "saved-topic",
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const newCheckbox = screen.getByLabelText("Enable ntfy.sh notifications") as HTMLInputElement;
    expect(newCheckbox.checked).toBe(true);
    const newInput = screen.getByLabelText("ntfy Topic") as HTMLInputElement;
    expect(newInput.value).toBe("saved-topic");
  });

  it("disabling ntfy persists correctly when saving", async () => {
    // Start with ntfy enabled
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    // Disable ntfy
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    fireEvent.click(screen.getByText("Save"));
    // ntfyEnabled is a global setting
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.ntfyEnabled).toBe(false);
  });

  it("shows ntfyEvents checkboxes when ntfy is enabled", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review"],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    await waitFor(() => expect(screen.getByLabelText("Task completed (in-review)")).toBeTruthy());
    expect(screen.getByLabelText("Task merged")).toBeTruthy();
    expect(screen.getByLabelText("Task failed")).toBeTruthy();
    expect(screen.getByLabelText("Plan needs approval")).toBeTruthy();
    expect(screen.getByLabelText("User review needed")).toBeTruthy();
  });

  it("shows awaiting-approval checkbox when ntfy is enabled", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review"],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    expect(screen.getByLabelText("Plan needs approval")).toBeTruthy();
  });

  it("hides ntfyEvents checkboxes when ntfy is disabled", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    expect(screen.queryByLabelText("Task completed (in-review)")).toBeNull();
    expect(screen.queryByLabelText("Task merged")).toBeNull();
    expect(screen.queryByLabelText("Task failed")).toBeNull();
    expect(screen.queryByLabelText("Plan needs approval")).toBeNull();
    expect(screen.queryByLabelText("User review needed")).toBeNull();
  });

  it("ntfyEvents checkboxes are all checked by default", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    expect((screen.getByLabelText("Task completed (in-review)") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Task merged") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Task failed") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Plan needs approval") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("User review needed") as HTMLInputElement).checked).toBe(true);
  });

  it("saves ntfyEvents correctly when checkboxes are toggled", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review"],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));

    // Uncheck "Task merged"
    const mergedCheckbox = screen.getByLabelText("Task merged");
    fireEvent.click(mergedCheckbox);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.ntfyEvents).toEqual(["in-review", "failed", "awaiting-approval", "awaiting-user-review"]);
  });

  it("sets ntfyEvents to null when all checkboxes are unchecked (null-as-delete)", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review"],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));

    // Uncheck all five
    fireEvent.click(screen.getByLabelText("Task completed (in-review)"));
    fireEvent.click(screen.getByLabelText("Task merged"));
    fireEvent.click(screen.getByLabelText("Task failed"));
    fireEvent.click(screen.getByLabelText("Plan needs approval"));
    fireEvent.click(screen.getByLabelText("User review needed"));

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.ntfyEvents).toBeNull(); // null means "explicitly clear this field"
  });

  it("restores ntfyEvents from saved settings", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyEvents: ["in-review"],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));
    expect((screen.getByLabelText("Task completed (in-review)") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Task merged") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Task failed") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Plan needs approval") as HTMLInputElement).checked).toBe(false);
  });

  // Node Sync section tests
  describe("Node Sync section", () => {
    it("Node Sync section renders with heading and toggle", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Node Sync"));
      expect(screen.getByText("Node Sync", { selector: "h4" })).toBeTruthy();
      expect(screen.getByLabelText("Enable automatic settings sync")).toBeTruthy();
    });

    it("sub-fields are hidden when sync is disabled", async () => {
      (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...defaultSettings,
        settingsSyncEnabled: false,
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Node Sync"));
      expect(screen.queryByLabelText("Sync interval")).toBeNull();
      expect(screen.queryByLabelText("Conflict resolution")).toBeNull();
    });

    it("sub-fields are visible when sync is enabled", async () => {
      (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...defaultSettings,
        settingsSyncEnabled: true,
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Node Sync"));
      expect(screen.getByLabelText("Enable automatic settings sync")).toBeTruthy();
      expect(screen.getByLabelText("Sync model auth credentials")).toBeTruthy();
      expect(screen.getByLabelText("Sync interval")).toBeTruthy();
      expect(screen.getByLabelText("Conflict resolution")).toBeTruthy();
    });

    it("toggle enables sync and updates form state", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Node Sync"));
      const checkbox = screen.getByLabelText("Enable automatic settings sync") as HTMLInputElement;
      expect(checkbox.checked).toBe(false);

      fireEvent.click(checkbox);
      expect((screen.getByLabelText("Enable automatic settings sync") as HTMLInputElement).checked).toBe(true);
    });

    it("interval dropdown changes form value", async () => {
      (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...defaultSettings,
        settingsSyncEnabled: true,
        settingsSyncInterval: 900000,
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Node Sync"));
      const select = screen.getByLabelText("Sync interval") as HTMLSelectElement;
      expect(select.value).toBe("900000");

      fireEvent.change(select, { target: { value: "3600000" } });
      expect(select.value).toBe("3600000");
    });

    it("conflict resolution dropdown changes form value", async () => {
      (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...defaultSettings,
        settingsSyncEnabled: true,
        settingsSyncConflictResolution: "last-write-wins",
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Node Sync"));
      const select = screen.getByLabelText("Conflict resolution") as HTMLSelectElement;
      expect(select.value).toBe("last-write-wins");

      fireEvent.change(select, { target: { value: "keep-local" } });
      expect(select.value).toBe("keep-local");
    });

    it("save persists global settings with sync enabled", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Node Sync"));
      const checkbox = screen.getByLabelText("Enable automatic settings sync");
      fireEvent.click(checkbox);

      fireEvent.click(screen.getByText("Save"));
      await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

      const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload.settingsSyncEnabled).toBe(true);
    });
  });

  // Model filter tests with CustomModelDropdown
  it("renders filter input in Models section dropdown", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Open dropdown to access filter input
    const trigger = screen.getByLabelText("Default Model");
    await user.click(trigger);

    // Filter input should be present in dropdown
    expect(screen.getByPlaceholderText("Filter models…")).toBeTruthy();
  });

  it("filters default model options in Models section", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Open dropdown
    const trigger = screen.getByLabelText("Default Model");
    await user.click(trigger);

    // Type a filter - only claude model should match
    const filterInput = screen.getByPlaceholderText("Filter models…");
    await user.type(filterInput, "claude");

    // Should show result count (1 model matches "claude")
    expect(screen.getByText("1 model")).toBeTruthy();

    // Only Claude should be visible, GPT-4o should be filtered out
    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
    expect(screen.queryByText("GPT-4o")).not.toBeInTheDocument();
  });

  it("clear button resets filter in Models section", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Open dropdown
    const trigger = screen.getByLabelText("Default Model");
    await user.click(trigger);

    // Type a filter
    const filterInput = screen.getByPlaceholderText("Filter models…");
    await user.type(filterInput, "openai");

    // Should show filtered count
    expect(screen.getByText("1 model")).toBeTruthy();

    // Click clear button
    const clearButton = screen.getByLabelText("Clear filter");
    await user.click(clearButton);

    // Filter should be cleared
    expect(filterInput).toHaveValue("");
    expect(screen.getByText("2 models")).toBeTruthy();

    // All models should be visible again
    expect(screen.getByText("GPT-4o")).toBeTruthy();
    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
  });

  it("shows empty state in Models section when filter matches nothing", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Open dropdown
    const trigger = screen.getByLabelText("Default Model");
    await user.click(trigger);

    // Type a filter that matches nothing
    const filterInput = screen.getByPlaceholderText("Filter models…");
    await user.type(filterInput, "nonexistent");

    // Should show no results message
    expect(screen.getByText(/No models match/)).toBeTruthy();
    expect(screen.getByText("0 models")).toBeTruthy();
  });

  // --- Test notification button tests ---

  it("Test notification button is disabled when ntfy is disabled", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));

    // When ntfy is disabled, the topic input (and test button) should not be visible
    expect(screen.queryByLabelText("ntfy Topic")).toBeNull();
    expect(screen.queryByRole("button", { name: /Test notification/i })).toBeNull();
  });

  it("Test notification button is disabled when topic is invalid", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));

    // Enable ntfy
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications");
    fireEvent.click(checkbox);

    // Enter invalid topic
    const input = screen.getByLabelText("ntfy Topic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "invalid topic with spaces!" } });

    // Test button should be disabled
    const testButton = screen.getByRole("button", { name: "Test notification" });
    expect(testButton).toBeDisabled();
  });

  it("Test notification button is enabled when ntfy is enabled with valid topic", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));

    // Enable ntfy
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications");
    fireEvent.click(checkbox);

    // Enter valid topic
    const input = screen.getByLabelText("ntfy Topic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "my-valid-topic" } });

    // Test button should be enabled
    const testButton = screen.getByRole("button", { name: "Test notification" });
    expect(testButton).toBeEnabled();
  });

  it("Clicking test button calls testNtfyNotification API", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));

    // Enable ntfy
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications");
    fireEvent.click(checkbox);

    // Enter valid topic
    const input = screen.getByLabelText("ntfy Topic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "my-valid-topic" } });

    // Click test button
    const testButton = screen.getByRole("button", { name: "Test notification" });
    fireEvent.click(testButton);

    await waitFor(() => expect(testNtfyNotification).toHaveBeenCalledTimes(1));
    expect(testNtfyNotification).toHaveBeenCalledWith({ ntfyEnabled: true, ntfyTopic: "my-valid-topic" }, undefined);
  });

  it("Success toast is shown when test notification succeeds", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));

    // Enable ntfy
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications");
    fireEvent.click(checkbox);

    // Enter valid topic
    const input = screen.getByLabelText("ntfy Topic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "my-valid-topic" } });

    // Click test button
    const testButton = screen.getByRole("button", { name: "Test notification" });
    fireEvent.click(testButton);

    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Test notification sent — check your ntfy app!", "success"));
  });

  it("Error toast is shown when test notification fails", async () => {
    // Mock the API to return an error
    (testNtfyNotification as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Notifications"));

    // Enable ntfy
    const checkbox = screen.getByLabelText("Enable ntfy.sh notifications");
    fireEvent.click(checkbox);

    // Enter valid topic
    const input = screen.getByLabelText("ntfy Topic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "my-valid-topic" } });

    // Click test button
    const testButton = screen.getByRole("button", { name: "Test notification" });
    fireEvent.click(testButton);

    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Network error", "error"));
  });

  // --- Stuck Task Timeout field tests ---

  it("shows Stuck Task Timeout field in Scheduling section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const input = screen.getByLabelText("Stuck Task Timeout (minutes)");
    expect(input).toBeTruthy();
    expect(input.getAttribute("type")).toBe("number");
    expect(input.getAttribute("min")).toBe("1");
    expect(input.getAttribute("step")).toBe("1");
  });

  it("Stuck Task Timeout field saves correctly when set to a value", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const input = screen.getByLabelText("Stuck Task Timeout (minutes)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    expect(input.value).toBe("10");

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.taskStuckTimeoutMs).toBe(600000);
  });

  it("Stuck Task Timeout field submits undefined when set to empty (disabled)", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      taskStuckTimeoutMs: 600000,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const input = screen.getByLabelText("Stuck Task Timeout (minutes)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.taskStuckTimeoutMs).toBeUndefined();
  });

  it("Stuck Task Timeout field shows helper text", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    expect(screen.getByText(/Timeout in minutes for detecting stuck tasks/)).toBeTruthy();
  });

  it("Stuck Task Timeout field displays correct minute value from milliseconds setting", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      taskStuckTimeoutMs: 600000,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const input = screen.getByLabelText("Stuck Task Timeout (minutes)") as HTMLInputElement;
    expect(input.value).toBe("10");
  });

  it("Max Stuck Retries field saves correctly when set to a value", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const input = screen.getByLabelText("Max Stuck Retries") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "8" } });
    expect(input.value).toBe("8");

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.maxStuckKills).toBe(8);
  });

  it("Max Stuck Retries field submits undefined when cleared", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      maxStuckKills: 6,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const input = screen.getByLabelText("Max Stuck Retries") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.maxStuckKills).toBeUndefined();
  });

  // --- Specification Staleness field tests ---

  it("shows Specification Staleness fields in Scheduling section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Enable specification staleness enforcement");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");

    const thresholdInput = screen.getByLabelText("Stale Spec Threshold (hours)");
    expect(thresholdInput).toBeTruthy();
    expect(thresholdInput.getAttribute("type")).toBe("number");
    expect(thresholdInput.getAttribute("min")).toBe("0");
  });

  it("shows auto-archive fields in Scheduling section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Enable automatic task archiving");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");

    const ageInput = screen.getByLabelText("Archive Completed Tasks After (days)");
    expect(ageInput).toBeTruthy();
    expect(ageInput.getAttribute("type")).toBe("number");
    expect(ageInput.getAttribute("min")).toBe("1");

    const logMode = screen.getByLabelText("Archive Agent Log") as HTMLSelectElement;
    expect(logMode).toBeTruthy();
    expect(logMode.value).toBe("compact");
  });

  it("auto-archive age input shows default days and disables when archiving is off", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const ageInput = screen.getByLabelText("Archive Completed Tasks After (days)") as HTMLInputElement;
    expect(ageInput.value).toBe("2");

    const checkbox = screen.getByLabelText("Enable automatic task archiving") as HTMLInputElement;
    const logMode = screen.getByLabelText("Archive Agent Log") as HTMLSelectElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(ageInput).toBeDisabled();
    expect(logMode).toBeDisabled();

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(ageInput).not.toBeDisabled();
    expect(logMode).not.toBeDisabled();
  });

  it("auto-archive age renders from milliseconds and converts days back to milliseconds on save", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      autoArchiveDoneTasksEnabled: true,
      autoArchiveDoneAfterMs: 5 * 24 * 60 * 60 * 1000,
      archiveAgentLogMode: "compact",
    } as SettingsWithAutoArchive);

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Enable automatic task archiving") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    const ageInput = screen.getByLabelText("Archive Completed Tasks After (days)") as HTMLInputElement;
    expect(ageInput.value).toBe("5");

    fireEvent.change(ageInput, { target: { value: "7" } });
    expect(ageInput.value).toBe("7");
    fireEvent.change(screen.getByLabelText("Archive Agent Log"), { target: { value: "none" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.autoArchiveDoneTasksEnabled).toBe(true);
    expect(payload.autoArchiveDoneAfterMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(payload.archiveAgentLogMode).toBe("none");
  });

  it("Specification Staleness threshold input is disabled when toggle is off", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const thresholdInput = screen.getByLabelText("Stale Spec Threshold (hours)") as HTMLInputElement;
    expect(thresholdInput).toBeDisabled();
  });

  it("Specification Staleness threshold input is enabled when toggle is on", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Enable specification staleness enforcement") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    const thresholdInput = screen.getByLabelText("Stale Spec Threshold (hours)") as HTMLInputElement;
    expect(thresholdInput).not.toBeDisabled();
  });

  it("Specification Staleness threshold displays rounded hours from milliseconds", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      specStalenessEnabled: true,
      specStalenessMaxAgeMs: 6 * 60 * 60 * 1000,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const thresholdInput = screen.getByLabelText("Stale Spec Threshold (hours)") as HTMLInputElement;
    expect(thresholdInput.value).toBe("6");
  });

  it("Specification Staleness threshold converts hours to milliseconds on save", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Enable specification staleness enforcement") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    const thresholdInput = screen.getByLabelText("Stale Spec Threshold (hours)") as HTMLInputElement;
    fireEvent.change(thresholdInput, { target: { value: "12" } });
    expect(thresholdInput.value).toBe("12");

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.specStalenessEnabled).toBe(true);
    expect(payload.specStalenessMaxAgeMs).toBe(12 * 60 * 60 * 1000);
  });

  it("Specification Staleness threshold of 0 hours persists 0 milliseconds", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Enable specification staleness enforcement") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    const thresholdInput = screen.getByLabelText("Stale Spec Threshold (hours)") as HTMLInputElement;
    fireEvent.change(thresholdInput, { target: { value: "0" } });
    expect(thresholdInput.value).toBe("0");

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.specStalenessEnabled).toBe(true);
    expect(payload.specStalenessMaxAgeMs).toBe(0);
  });

  it("Specification Staleness enabled with empty threshold submits without invalid numeric payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Enable specification staleness enforcement") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    const thresholdInput = screen.getByLabelText("Stale Spec Threshold (hours)") as HTMLInputElement;
    fireEvent.change(thresholdInput, { target: { value: "" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.specStalenessEnabled).toBe(true);
    expect(payload.specStalenessMaxAgeMs).toBeUndefined();
  });

  it("Disabling Specification Staleness retains configured max age", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      specStalenessEnabled: true,
      specStalenessMaxAgeMs: 8 * 60 * 60 * 1000,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Enable specification staleness enforcement") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    const thresholdInput = screen.getByLabelText("Stale Spec Threshold (hours)") as HTMLInputElement;
    expect(thresholdInput.value).toBe("8");
    expect(thresholdInput).not.toBeDisabled();

    // Disable the toggle
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(thresholdInput).toBeDisabled();

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.specStalenessEnabled).toBe(false);
    expect(payload.specStalenessMaxAgeMs).toBe(8 * 60 * 60 * 1000);
  });

  it("Specification Staleness helper text is visible", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    expect(screen.getByText(/Maximum age in hours before a specification is considered stale/)).toBeTruthy();
    expect(screen.getByText(/When enabled, tasks with stale specifications/)).toBeTruthy();
  });

  it("scope banners render for global and project sections with theme-aware icons", async () => {
    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Authentication is first (no scope banner) → should show no scope banner
    expect(container.querySelector(".settings-scope-project")).toBeNull();
    expect(container.querySelector(".settings-scope-global")).toBeNull();

    // Switch to Appearance → should show global banner with Globe icon (SVG, not emoji)
    fireEvent.click(screen.getAllByText("Appearance")[0]);
    const globalBanner = container.querySelector(".settings-scope-global");
    expect(globalBanner).toBeTruthy();
    expect(globalBanner?.textContent).toContain("Fusion");
    expect(container.querySelector(".settings-scope-project")).toBeNull();
    // Verify banner uses SVG icon, not emoji
    const globalIcon = globalBanner!.querySelector(".settings-scope-icon svg");
    expect(globalIcon).toBeTruthy();

    // Switch to General → should show project banner with Folder icon (SVG, not emoji)
    fireEvent.click(screen.getAllByText("General")[0]);
    const projectBanner = container.querySelector(".settings-scope-project");
    expect(projectBanner).toBeTruthy();
    expect(container.querySelector(".settings-scope-global")).toBeNull();
    // Verify banner uses SVG icon, not emoji
    const projectIcon = projectBanner!.querySelector(".settings-scope-icon svg");
    expect(projectIcon).toBeTruthy();

    // Switch to Models → should show global scope banner (Models is now a global-only section)
    fireEvent.click(screen.getAllByText("Models")[0]);
    const modelsBanner = container.querySelector(".settings-scope-global");
    expect(modelsBanner).toBeTruthy();
    expect(modelsBanner?.textContent).toContain("Fusion");
    expect(container.querySelector(".settings-scope-project")).toBeNull();
    // Verify Models banner uses Globe icon as SVG element
    const modelsIcon = modelsBanner!.querySelector(".settings-scope-icon svg");
    expect(modelsIcon).toBeTruthy();

    // Switch to Project Models → should show project scope banner
    fireEvent.click(screen.getByText("Project Models"));
    const projectModelsBanner = container.querySelector(".settings-scope-project");
    expect(projectModelsBanner).toBeTruthy();
    expect(projectModelsBanner?.textContent).toContain("project");
    expect(container.querySelector(".settings-scope-global")).toBeNull();
    // Verify Project Models banner uses Folder icon as SVG element
    const projectModelsIcon = projectModelsBanner!.querySelector(".settings-scope-icon svg");
    expect(projectModelsIcon).toBeTruthy();
  });

  // --- Settings save error handling tests ---

  it("shows error toast when settings save fails", async () => {
    (updateSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Failed to save settings"));

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Failed to save settings", "error"));

    // Modal should stay open on error
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows error toast when global settings save fails", async () => {
    (updateGlobalSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Failed to save global settings"));

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Switch to Models section
    fireEvent.click(screen.getByText("Models"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Failed to save global settings", "error"));

    // Modal should stay open on error
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes modal and shows success toast when settings save succeeds", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Settings saved", "success"));

    // Modal should close on success
    expect(onClose).toHaveBeenCalled();
  });

  it("handles network error during settings save", async () => {
    (updateSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Network error", "error"));
  });

  it("handles 500 server error during settings save", async () => {
    (updateSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Internal server error"));

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("Internal server error", "error"));
  });

  // --- Step Execution field tests (in Scheduling section) ---

  it("shows runStepsInNewSessions checkbox and maxParallelSteps input in Scheduling section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Run each step in a new session");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");

    const input = screen.getByLabelText("Maximum parallel steps");
    expect(input).toBeTruthy();
    expect(input.getAttribute("type")).toBe("number");
  });

  it("maxParallelSteps input is disabled when runStepsInNewSessions is false", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const input = screen.getByLabelText("Maximum parallel steps") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("toggling runStepsInNewSessions to true enables the maxParallelSteps input", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Run each step in a new session");
    fireEvent.click(checkbox);

    const input = screen.getByLabelText("Maximum parallel steps") as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });

  it("saving with runStepsInNewSessions true includes both fields in save payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const checkbox = screen.getByLabelText("Run each step in a new session");
    fireEvent.click(checkbox);

    const input = screen.getByLabelText("Maximum parallel steps") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.runStepsInNewSessions).toBe(true);
    expect(payload.maxParallelSteps).toBe(3);
  });

  describe("PluginSlot integration", () => {
    it("renders PluginSlot for settings-section in plugins section", async () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [{ pluginId: "test-plugin", slot: { slotId: "settings-section", label: "Test Settings", componentPath: "./test.js" } }],
        getSlotsForId: (id: string) => id === "settings-section" ? [{ pluginId: "test-plugin", slot: { slotId: "settings-section", label: "Test Settings", componentPath: "./test.js" } }] : [],
        loading: false,
        error: null,
      });
      const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Navigate to Plugins section
      await userEvent.click(screen.getByText("Plugins"));
      await waitFor(() => expect(screen.getByTestId("plugin-manager")).toBeDefined());

      // Verify slot renders
      const slot = container.querySelector('[data-slot-id="settings-section"]');
      expect(slot).not.toBeNull();
      expect(slot).toHaveAttribute("data-plugin-id", "test-plugin");
    });

    it("renders nothing when no plugins register for settings-section slot", async () => {
      mockUsePluginUiSlots.mockReturnValue({
        slots: [],
        getSlotsForId: vi.fn(() => []),
        loading: false,
        error: null,
      });
      const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      await userEvent.click(screen.getByText("Plugins"));
      await waitFor(() => expect(screen.getByTestId("plugin-manager")).toBeDefined());

      const slot = container.querySelector('[data-slot-id="settings-section"]');
      expect(slot).toBeNull();
    });
  });
});

describe("Prompts section", () => {
  it("renders the Prompts section in the sidebar", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getAllByText("Prompts").length).toBeGreaterThanOrEqual(1);
  });

  it("shows AgentPromptsManager when Prompts section is selected", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click on Prompts section in sidebar (first one is the nav item)
    fireEvent.click(screen.getAllByText("Prompts")[0]);

    // Should show scope banner (project-scoped)
    expect(screen.getByText("These settings only affect this project.")).toBeTruthy();

    // Should show the AgentPromptsManager with tabs
    expect(screen.getByTestId("tab-templates")).toBeTruthy();
    expect(screen.getByTestId("tab-assignments")).toBeTruthy();
    expect(screen.getByTestId("tab-overrides")).toBeTruthy();
  });

  it("shows built-in templates in Templates tab", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Prompts")[0]);

    // Templates tab should be active by default
    expect(screen.getByTestId("tab-templates")).toHaveClass(/active/);

    // Should show built-in templates
    expect(screen.getByTestId("builtin-template-default-executor")).toBeTruthy();
    expect(screen.getByTestId("builtin-template-default-triage")).toBeTruthy();
  });

  it("shows Assignments tab with role dropdowns", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Prompts")[0]);

    // Click Assignments tab
    fireEvent.click(screen.getByTestId("tab-assignments"));

    // Should show role assignment rows
    expect(screen.getByTestId("assignment-executor")).toBeTruthy();
    expect(screen.getByTestId("assignment-triage")).toBeTruthy();
    expect(screen.getByTestId("assignment-reviewer")).toBeTruthy();
    expect(screen.getByTestId("assignment-merger")).toBeTruthy();
  });

  it("shows Overrides tab with accordion items", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Prompts")[0]);

    // Click Overrides tab
    fireEvent.click(screen.getByTestId("tab-overrides"));

    // Should show override items (collapsed by default)
    expect(screen.getByTestId("override-executor-welcome")).toBeTruthy();
    expect(screen.getByTestId("override-triage-welcome")).toBeTruthy();
  });

  it("editing a prompt override includes override in save payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Prompts")[0]);

    // Click Overrides tab
    fireEvent.click(screen.getByTestId("tab-overrides"));

    // Expand the executor-welcome override by clicking the expand button
    fireEvent.click(screen.getByTestId("expand-executor-welcome"));

    // Wait for the expanded editor to appear
    await waitFor(() => {
      expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
    });

    // Find the textarea for executor-welcome
    const textarea = screen.getByTestId("override-input-executor-welcome") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    // Type custom content
    fireEvent.change(textarea, { target: { value: "My custom executor welcome message" } });
    expect(textarea.value).toBe("My custom executor welcome message");

    // Save
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    // Verify the payload contains the override
    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.promptOverrides).toBeDefined();
    expect(payload.promptOverrides["executor-welcome"]).toBe("My custom executor welcome message");
  });

  it("resetting an existing override sends null for that prompt key", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      promptOverrides: {
        "executor-welcome": "Custom override text",
      },
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Prompts")[0]);

    // Click Overrides tab
    fireEvent.click(screen.getByTestId("tab-overrides"));

    // Expand the executor-welcome override by clicking the expand button
    fireEvent.click(screen.getByTestId("expand-executor-welcome"));

    // Wait for the expanded editor to appear
    await waitFor(() => {
      expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
    });

    // Find and click the Reset button
    fireEvent.click(screen.getByTestId("reset-executor-welcome"));

    // Save
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    // Verify the payload contains null for the key
    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.promptOverrides).toBeDefined();
    expect(payload.promptOverrides["executor-welcome"]).toBeNull();
  });

  it("promptOverrides are sent as project settings (not global)", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Prompts")[0]);

    // Click Overrides tab
    fireEvent.click(screen.getByTestId("tab-overrides"));

    // Expand the executor-welcome override by clicking the expand button
    fireEvent.click(screen.getByTestId("expand-executor-welcome"));

    // Wait for the expanded editor to appear
    await waitFor(() => {
      expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
    });

    // Find the textarea and type content
    const textarea = screen.getByTestId("override-input-executor-welcome") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Custom message" } });

    // Save
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    // Verify promptOverrides is in the project patch (updateSettings), not global
    const projectPayload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(projectPayload.promptOverrides).toBeDefined();
    expect(projectPayload.promptOverrides["executor-welcome"]).toBe("Custom message");

    // Verify global settings may be called (for ntfyEvents etc), but promptOverrides should NOT be in global
    if (updateGlobalSettings.mock.calls.length > 0) {
      const globalPayload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(globalPayload.promptOverrides).toBeUndefined();
    }
  });

  it("shows customized badge and Reset button for existing overrides", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      promptOverrides: {
        "executor-welcome": "Custom override text",
      },
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Prompts")[0]);

    // Click Overrides tab
    fireEvent.click(screen.getByTestId("tab-overrides"));

    // Expand the executor-welcome override by clicking the expand button
    const expandBtn = screen.getByTestId("expand-executor-welcome");
    fireEvent.click(expandBtn);

    // Wait for the expanded editor to appear
    await waitFor(() => {
      expect(screen.getByTestId("override-input-executor-welcome")).toBeTruthy();
    });

    // Should show "customized" badge
    expect(screen.getByText("customized")).toBeTruthy();

    // Should show Reset button
    expect(screen.getByTestId("reset-executor-welcome")).toBeTruthy();
  });

  it("can create a custom template", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Prompts")[0]);

    // Templates tab should be active by default
    expect(screen.getByTestId("tab-templates")).toHaveClass(/active/);

    // Click "Add Custom Template" button
    fireEvent.click(screen.getByTestId("add-template-btn"));

    // Should show the template editor
    expect(screen.getByTestId("template-editor")).toBeTruthy();
    expect(screen.getByTestId("template-name-input")).toBeTruthy();
    expect(screen.getByTestId("template-description-input")).toBeTruthy();
    expect(screen.getByTestId("template-role-select")).toBeTruthy();
    expect(screen.getByTestId("template-prompt-input")).toBeTruthy();
  });

  it("saving with agentPrompts includes it in the save payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("Prompts")[0]);

    // Click "Add Custom Template" button
    fireEvent.click(screen.getByTestId("add-template-btn"));

    // Fill in the template
    fireEvent.change(screen.getByTestId("template-name-input"), { target: { value: "My Custom Template" } });
    fireEvent.change(screen.getByTestId("template-description-input"), { target: { value: "A custom template description" } });
    fireEvent.change(screen.getByTestId("template-prompt-input"), { target: { value: "Custom prompt text" } });

    // Save the template
    fireEvent.click(screen.getByTestId("save-template-btn"));

    // Save the settings
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    // Verify the payload contains agentPrompts with the custom template
    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.agentPrompts).toBeDefined();
    expect(payload.agentPrompts.templates).toBeDefined();
    expect(payload.agentPrompts.templates.length).toBe(1);
    expect(payload.agentPrompts.templates[0].name).toBe("My Custom Template");
  });

  describe("Reopen onboarding guide", () => {
    it("renders Reopen onboarding guide button in Authentication section when onReopenOnboarding is provided", async () => {
      const onReopenOnboarding = vi.fn();
      render(<SettingsModal onClose={onClose} addToast={addToast} onReopenOnboarding={onReopenOnboarding} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Navigate to Authentication section
      fireEvent.click(screen.getAllByText("Authentication")[0]);
      await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

      // Check that the reopen button is rendered
      expect(screen.getByText("Reopen onboarding guide")).toBeTruthy();
    });

    it("does not render Reopen onboarding guide button when onReopenOnboarding is not provided", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Navigate to Authentication section
      fireEvent.click(screen.getAllByText("Authentication")[0]);
      await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

      // Check that the reopen button is NOT rendered
      expect(screen.queryByText("Reopen onboarding guide")).toBeNull();
    });

    it("calls onReopenOnboarding when Reopen button is clicked", async () => {
      const onReopenOnboarding = vi.fn();
      render(<SettingsModal onClose={onClose} addToast={addToast} onReopenOnboarding={onReopenOnboarding} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Navigate to Authentication section
      fireEvent.click(screen.getAllByText("Authentication")[0]);
      await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

      // Click the reopen button
      fireEvent.click(screen.getByText("Reopen onboarding guide"));

      // Verify callback was called
      expect(onReopenOnboarding).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Regression tests for FN-1712: Settings UI model-lane scope UX.
   *
   * These tests guard the scope-split behavior introduced in FN-1712:
   * - Each model setting is rendered as a lane with dual controls (global baseline + project override)
   * - Inheritance indicators show whether a lane is overridden or inherited
   * - Save payloads are split by scope: global keys go to updateGlobalSettings, project keys to updateSettings
   * - Reset/clear interactions use null-as-delete semantics
   *
   * DOM selectors used:
   * - Project model lanes: id="${laneId}Model" (e.g., "planningModel", "validatorModel")
   * - Lane badges: .settings-lane-badge--override or .settings-lane-badge--inherited
   * - Badge text: "Override (Project)" or "Inherited (Global)"
   * - Reset button: text "Reset" in lane
   * - Fallback models: id="planningFallbackModel", id="validatorFallbackModel"
   * - Global models: id="defaultModel", id="fallbackModel", id="defaultThinkingLevel"
   */

  describe("Model lane rendering (FN-1712 scope UX)", () => {
    it("renders Project Models section with all three model lanes", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Navigate to Project Models section
      fireEvent.click(screen.getAllByText("Project Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Verify all three model lanes are rendered with labels
      expect(screen.getByLabelText("Planning Model")).toBeTruthy();
      expect(screen.getByLabelText("Validator Model")).toBeTruthy();
      expect(screen.getByLabelText("Title Summarization Model")).toBeTruthy();
    });

    it("renders Default Model and Fallback Model in global Models section", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Navigate to Models section (global)
      fireEvent.click(screen.getAllByText("Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Verify default and fallback model dropdowns
      expect(screen.getByLabelText("Default Model")).toBeTruthy();
      expect(screen.getByLabelText("Fallback Model")).toBeTruthy();
    });

    it("renders global baseline lane dropdowns in Models section", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      expect(screen.getByLabelText("Execution Model")).toBeTruthy();
      expect(screen.getByLabelText("Planning Model")).toBeTruthy();
      expect(screen.getByLabelText("Validator Model")).toBeTruthy();
      expect(screen.getByLabelText("Title Summarization Model")).toBeTruthy();
    });

    it("saving a global lane selection persists execution global lane keys", async () => {
      const user = userEvent.setup();
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      const executionTrigger = screen.getByLabelText("Execution Model");
      await user.click(executionTrigger);
      await user.click(screen.getByText("GPT-4o"));

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));
      const globalPayload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(globalPayload.executionGlobalProvider).toBe("openai");
      expect(globalPayload.executionGlobalModelId).toBe("gpt-4o");
    });

    it("clearing a global lane selection sends null for execution global lane keys", async () => {
      const user = userEvent.setup();
      (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...defaultSettings,
        executionGlobalProvider: "anthropic",
        executionGlobalModelId: "claude-sonnet-4-5",
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      const executionTrigger = screen.getByLabelText("Execution Model");
      await user.click(executionTrigger);
      const useDefaultOption = await screen.findByRole("option", { name: /use default/i });
      await user.click(useDefaultOption);

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));
      const globalPayload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(globalPayload.executionGlobalProvider).toBeNull();
      expect(globalPayload.executionGlobalModelId).toBeNull();
    });

    it("shows Use default placeholder text for each global model lane when unset", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      expect(screen.getByLabelText("Execution Model").textContent).toContain("Use default");
      expect(screen.getByLabelText("Planning Model").textContent).toContain("Use default");
      expect(screen.getByLabelText("Validator Model").textContent).toContain("Use default");
      expect(screen.getByLabelText("Title Summarization Model").textContent).toContain("Use default");
    });

    it("renders Thinking Effort select in global Models section", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Thinking Effort is a native select
      const select = screen.getByLabelText("Thinking Effort");
      expect(select.tagName).toBe("SELECT");

      // Verify expected options
      const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
      expect(options).toContain("Default");
      expect(options).toContain("Off");
      expect(options).toContain("Minimal");
      expect(options).toContain("Low");
      expect(options).toContain("Medium");
      expect(options).toContain("High");
    });

    it("renders Planning Fallback and Validator Fallback in project Models section", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Project Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Verify fallback model dropdowns
      expect(screen.getByLabelText("Planning Fallback Model")).toBeTruthy();
      expect(screen.getByLabelText("Validator Fallback Model")).toBeTruthy();
    });

    it("shows Inherited badge when project override is not set", async () => {
      // Mock fetchSettingsByScope to return project with no overrides
      (fetchSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        global: { themeMode: "dark", defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" },
        project: {},
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
      await waitFor(() => expect(fetchSettingsByScope).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Project Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Planning lane should show Inherited badge
      const planningLabel = screen.getByLabelText("Planning Model").closest(".form-group");
      expect(planningLabel?.querySelector(".settings-lane-badge--inherited")).toBeTruthy();
      expect(planningLabel?.textContent).toContain("Inherited (Global)");
    });

    it("shows Override badge when project override is set", async () => {
      // Mock fetchSettingsByScope to return project with override
      (fetchSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        global: { themeMode: "dark", defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" },
        project: { planningProvider: "openai", planningModelId: "gpt-4o" },
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
      await waitFor(() => expect(fetchSettingsByScope).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Project Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Planning lane should show Override badge
      const planningLabel = screen.getByLabelText("Planning Model").closest(".form-group");
      expect(planningLabel?.querySelector(".settings-lane-badge--override")).toBeTruthy();
      expect(planningLabel?.textContent).toContain("Override (Project)");

      // Should show Reset button when overridden
      expect(planningLabel?.textContent).toContain("Reset");
    });

    it("shows fallback text when both global and project are unset (automatic selection)", async () => {
      // Mock fetchSettingsByScope to return empty values
      (fetchSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        global: { themeMode: "dark" }, // No defaultProvider/defaultModelId set
        project: {}, // No override set
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
      await waitFor(() => expect(fetchSettingsByScope).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Default Model dropdown should show placeholder
      const dropdown = screen.getByLabelText("Default Model");
      expect(dropdown.textContent || dropdown.getAttribute("value")).toBeTruthy();
    });
  });

  describe("Save payload scope-split (FN-1712)", () => {
    it("global-only change calls updateGlobalSettings but not updateSettings for global keys", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Open the Default Model dropdown and select a model
      const user = userEvent.setup();
      const dropdownBtn = screen.getByRole("button", { name: /default model/i });
      await user.click(dropdownBtn);

      // Select a model from the dropdown
      const option = await screen.findByRole("option", { name: /gpt-4o/i });
      await user.click(option);

      // Save
      fireEvent.click(screen.getByText("Save"));
      await waitFor(() => {
        expect(updateGlobalSettings).toHaveBeenCalled();
      });

      // updateSettings should NOT be called with global keys
      const updateSettingsCalls = (updateSettings as ReturnType<typeof vi.fn>).mock.calls;
      const globalSettingsCalls = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls;

      // Verify global settings was called with defaultProvider/defaultModelId
      expect(globalSettingsCalls.length).toBeGreaterThan(0);
      const globalPayload = globalSettingsCalls[globalSettingsCalls.length - 1][0];
      expect(globalPayload).toHaveProperty("defaultProvider");
      expect(globalPayload).toHaveProperty("defaultModelId");

      // Verify project settings was NOT called with global keys (or check it doesn't contain them)
      if (updateSettingsCalls.length > 0) {
        const projectPayload = updateSettingsCalls[updateSettingsCalls.length - 1][0];
        expect(projectPayload.defaultProvider).toBeUndefined();
        expect(projectPayload.defaultModelId).toBeUndefined();
      }
    });

    it("project-only change calls updateSettings but not updateGlobalSettings for project keys", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Project Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Open Planning Model dropdown
      const user = userEvent.setup();
      const dropdownBtn = screen.getByRole("button", { name: /planning model/i });
      await user.click(dropdownBtn);

      // Select a model
      const option = await screen.findByRole("option", { name: /gpt-4o/i });
      await user.click(option);

      // Save
      fireEvent.click(screen.getByText("Save"));
      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalled();
      });

      // updateGlobalSettings should NOT be called with planning keys
      const updateGlobalSettingsCalls = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls;
      const updateSettingsCalls = (updateSettings as ReturnType<typeof vi.fn>).mock.calls;

      // Verify project settings was called with planningProvider/planningModelId
      expect(updateSettingsCalls.length).toBeGreaterThan(0);
      const projectPayload = updateSettingsCalls[updateSettingsCalls.length - 1][0];
      expect(projectPayload).toHaveProperty("planningProvider");
      expect(projectPayload).toHaveProperty("planningModelId");

      // Verify global settings was NOT called with planning keys
      if (updateGlobalSettingsCalls.length > 0) {
        const globalPayload = updateGlobalSettingsCalls[updateGlobalSettingsCalls.length - 1][0];
        expect(globalPayload.planningProvider).toBeUndefined();
        expect(globalPayload.planningModelId).toBeUndefined();
      }
    });

    it("mixed global and project changes call both endpoints with correct subsets", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      // Change global model
      fireEvent.click(screen.getAllByText("Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      let user = userEvent.setup();
      let dropdownBtn = screen.getByRole("button", { name: /default model/i });
      await user.click(dropdownBtn);
      let option = await screen.findByRole("option", { name: /gpt-4o/i });
      await user.click(option);

      // Change project model
      fireEvent.click(screen.getAllByText("Project Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      dropdownBtn = screen.getByRole("button", { name: /planning model/i });
      await user.click(dropdownBtn);
      option = await screen.findByRole("option", { name: /claude/i });
      await user.click(option);

      // Save
      fireEvent.click(screen.getByText("Save"));
      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalled();
        expect(updateGlobalSettings).toHaveBeenCalled();
      });

      const globalPayload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const projectPayload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Verify global payload contains only global keys
      expect(globalPayload).toHaveProperty("defaultProvider");
      expect(globalPayload).toHaveProperty("defaultModelId");
      expect(globalPayload.planningProvider).toBeUndefined();
      expect(globalPayload.planningModelId).toBeUndefined();

      // Verify project payload contains only project keys
      expect(projectPayload).toHaveProperty("planningProvider");
      expect(projectPayload).toHaveProperty("planningModelId");
      expect(projectPayload.defaultProvider).toBeUndefined();
      expect(projectPayload.defaultModelId).toBeUndefined();
    });
  });

  describe("Reset/clear null-as-delete semantics (FN-1712)", () => {
    it("resetting a project override sends null to delete it", async () => {
      // Mock fetchSettingsByScope to return project with override
      (fetchSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        global: { themeMode: "dark", planningGlobalProvider: "anthropic", planningGlobalModelId: "claude-sonnet-4-5" },
        project: { planningProvider: "openai", planningModelId: "gpt-4o" },
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
      await waitFor(() => expect(fetchSettingsByScope).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Project Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Should show Override badge and Reset button
      const planningLabel = screen.getByLabelText("Planning Model").closest(".form-group");
      expect(planningLabel?.textContent).toContain("Override (Project)");

      // Click Reset button - find the button with "Reset" text within the planning lane
      const resetBtn = screen.getByRole("button", { name: "Reset" });
      expect(resetBtn).toBeTruthy();
      fireEvent.click(resetBtn);

      // Save
      fireEvent.click(screen.getByText("Save"));
      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalled();
      });

      // Verify null-as-delete: planningProvider and planningModelId should be null (not undefined)
      const projectPayload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(projectPayload.planningProvider).toBeNull();
      expect(projectPayload.planningModelId).toBeNull();
    });

    it("clearing a global setting sends null to delete it", async () => {
      // Set up initial global settings with defaultProvider/defaultModelId set
      (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...defaultSettings,
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });

      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText("Models")[0]);
      await waitFor(() => expect(fetchModels).toHaveBeenCalled());

      // Open the Default Model dropdown
      const user = userEvent.setup();
      const dropdownBtn = screen.getByRole("button", { name: /default model/i });
      await user.click(dropdownBtn);

      // Select "Use default" option to clear
      const useDefaultOption = await screen.findByRole("option", { name: /use default/i });
      await user.click(useDefaultOption);

      // Save
      fireEvent.click(screen.getByText("Save"));
      await waitFor(() => {
        expect(updateGlobalSettings).toHaveBeenCalled();
      });

      // Verify null-as-delete: defaultProvider and defaultModelId should be null when clearing an existing value
      const globalPayload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(globalPayload.defaultProvider).toBeNull();
      expect(globalPayload.defaultModelId).toBeNull();
    });
  });

  describe("Memory section - file editor", () => {
    it("shows the memory file selector and defaults to dreams", async () => {
      render(<SettingsModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

      fireEvent.click(screen.getByText("Memory"));

      const selector = await screen.findByLabelText("Memory File") as HTMLSelectElement;
      expect(selector.value).toBe(".fusion/memory/DREAMS.md");
      expect(screen.getByText(/Choose any project memory file to view or edit/i)).toBeInTheDocument();
      expect(screen.queryByText("Compact Memory")).not.toBeInTheDocument();
    });
  });
});
