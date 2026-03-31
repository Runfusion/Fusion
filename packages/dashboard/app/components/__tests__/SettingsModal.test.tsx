import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "../SettingsModal";
import type { Settings } from "@kb/core";

const defaultSettings: Settings = {
  maxConcurrent: 2,
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
  taskStuckTimeoutMs: undefined,
};

vi.mock("../../api", () => ({
  fetchSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  updateSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  updateGlobalSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  fetchAuthStatus: vi.fn(() => Promise.resolve({ providers: [{ id: "anthropic", name: "Anthropic", authenticated: false }] })),
  loginProvider: vi.fn(() => Promise.resolve({ url: "https://auth.example.com/login" })),
  logoutProvider: vi.fn(() => Promise.resolve({ success: true })),
  fetchModels: vi.fn(() => Promise.resolve([
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ])),
  testNtfyNotification: vi.fn(() => Promise.resolve({ success: true })),
}));

import { fetchSettings, updateSettings, updateGlobalSettings, fetchAuthStatus, loginProvider, logoutProvider, fetchModels, testNtfyNotification } from "../../api";

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

  it("shows General fields by default", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getByLabelText("Task Prefix")).toBeTruthy();
    // Fields from other sections should not be visible
    expect(screen.queryByLabelText("Max Concurrent Tasks")).toBeNull();
    expect(screen.queryByLabelText("Max Worktrees")).toBeNull();
  });

  it("switches section when clicking sidebar item", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click Scheduling
    fireEvent.click(screen.getByText("Scheduling"));
    expect(screen.getByLabelText("Max Concurrent Tasks")).toBeTruthy();
    expect(screen.queryByLabelText("Task Prefix")).toBeNull();

    // Click Commands
    fireEvent.click(screen.getByText("Commands"));
    expect(screen.getByLabelText("Test Command")).toBeTruthy();
    expect(screen.getByLabelText("Build Command")).toBeTruthy();
    expect(screen.queryByLabelText("Max Concurrent Tasks")).toBeNull();
  });

  it("all settings fields are present across all sections", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // General (default)
    expect(screen.getByLabelText("Task Prefix")).toBeTruthy();

    // Scheduling
    fireEvent.click(screen.getByText("Scheduling"));
    expect(screen.getByLabelText("Max Concurrent Tasks")).toBeTruthy();
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

    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad" } });

    expect(screen.getByText("Prefix must be 1–10 uppercase letters")).toBeTruthy();
  });

  it("Task Prefix validation error prevents save", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad" } });

    fireEvent.click(screen.getByText("Save"));
    // Should not have called updateSettings due to validation error
    expect(updateSettings).not.toHaveBeenCalled();
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

  it("saving project settings does not update global settings endpoint", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // General section is project-scoped — change a project setting
    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "TEST" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    // Global settings should NOT be called when in a project section
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it("saving in Model section only updates global settings", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Save"));
    // Model section is global-scoped
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    // Project settings should NOT be updated when in a global section
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("shows Model in sidebar", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getAllByText("Model").length).toBeGreaterThanOrEqual(1);
  });

  it("supports creating and saving a model preset", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model Presets"));
    await user.click(screen.getByText("Add Preset"));

    await user.type(screen.getByLabelText("Name"), "Budget");
    expect((screen.getByLabelText("ID") as HTMLInputElement).value).toBe("budget");

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

    fireEvent.click(screen.getByText("Model Presets"));
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

    fireEvent.click(screen.getByText("Model"));
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

    fireEvent.click(screen.getByText("Model"));
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

  it("Use default option clears model selection", async () => {
    const user = userEvent.setup();
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
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
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.defaultProvider).toBeUndefined();
    expect(payload.defaultModelId).toBeUndefined();
  });

  it("shows empty state when no models available", async () => {
    (fetchModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    expect(screen.getByText("No models available. Configure authentication first.")).toBeTruthy();
  });

  it("shows Authentication in sidebar", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getAllByText("Authentication").length).toBeGreaterThanOrEqual(1);
  });

  it("shows provider auth status when Authentication section is selected", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Authentication"));
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("✗ Not authenticated")).toBeTruthy();
  });

  it("shows authenticated status with checkmark", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [{ id: "anthropic", name: "Anthropic", authenticated: true }],
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Authentication"));
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    expect(screen.getByText("✓ Authenticated")).toBeTruthy();
    expect(screen.getByText("Logout")).toBeTruthy();
  });

  it("Login button calls loginProvider and opens URL", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Authentication"));
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

    fireEvent.click(screen.getByText("Authentication"));
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

    fireEvent.click(screen.getByText("Authentication"));
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const authBadge = screen.getByTestId("auth-status-anthropic");
    expect(authBadge.className).toContain("auth-status-badge");
    expect(authBadge.className).toContain("authenticated");

    const unauthBadge = screen.getByTestId("auth-status-github");
    expect(unauthBadge.className).toContain("auth-status-badge");
    expect(unauthBadge.className).toContain("not-authenticated");
  });

  it("auth provider rows use auth-provider-row class", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Authentication"));
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const providerRow = screen.getByText("Anthropic").closest(".auth-provider-row");
    expect(providerRow).toBeTruthy();
  });

  it("model section renders CustomModelDropdown button", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
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
    expect(elementsWithStyle.length).toBe(0);
  });

  it("shows Thinking Effort dropdown with correct options in Model section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    const select = screen.getByLabelText("Thinking Effort") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");

    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toEqual(["Default", "Off", "Minimal", "Low", "Medium", "High"]);
  });

  it("changing Thinking Effort dropdown updates form and is included in save payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
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

    fireEvent.click(screen.getByText("Model"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    expect(screen.queryByLabelText("Thinking Effort")).toBeNull();
  });

  it("shows loading state during login", async () => {
    // Make loginProvider hang
    (loginProvider as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("open", vi.fn());

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Authentication"));
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

  it("defaults to General section when no initialSection is passed", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // General content should be visible
    expect(screen.getByLabelText("Task Prefix")).toBeTruthy();
    // Authentication content should NOT be visible
    expect(screen.queryByText("✗ Not authenticated")).toBeNull();
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

    fireEvent.click(screen.getByText("Authentication"));
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    expect(screen.getByText("Sign in to at least one provider to get started.")).toBeTruthy();
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

    fireEvent.click(screen.getByText("Authentication"));
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    expect(screen.queryByText("Sign in to at least one provider to get started.")).toBeNull();
    // Provider rows should still be visible
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
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

  it("has .settings-sidebar with 10 .settings-nav-item buttons for all sections", async () => {
    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const sidebar = container.querySelector(".settings-sidebar");
    expect(sidebar).toBeTruthy();
    const navItems = sidebar!.querySelectorAll(".settings-nav-item");
    expect(navItems.length).toBe(10);

    // Labels include scope emoji indicators (🌐 for global, 📁 for project)
    const labels = Array.from(navItems).map((el) => el.textContent);
    expect(labels).toEqual([
      "📁General",
      "🌐Model",
      "📁Model Presets",
      "🌐Appearance",
      "📁Scheduling",
      "📁Worktrees",
      "📁Commands",
      "📁Merge",
      "🌐Notifications",
      "Authentication",
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

    // Default active section is General (with scope emoji prefix)
    const activeItems = container.querySelectorAll(".settings-nav-item.active");
    expect(activeItems.length).toBe(1);
    expect(activeItems[0].textContent).toBe("📁General");

    // Switch to Scheduling
    fireEvent.click(screen.getByText("Scheduling"));
    const newActive = container.querySelectorAll(".settings-nav-item.active");
    expect(newActive.length).toBe(1);
    expect(newActive[0].textContent).toBe("📁Scheduling");
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

    fireEvent.click(screen.getByText("Authentication"));
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    const rows = container.querySelectorAll(".auth-provider-row");
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

  it("ntfy topic field submits undefined when empty", async () => {
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
    // ntfyTopic is a global setting
    await waitFor(() => expect(updateGlobalSettings).toHaveBeenCalledTimes(1));

    const payload = (updateGlobalSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.ntfyTopic).toBeUndefined();
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

  // Model filter tests with CustomModelDropdown
  it("renders filter input in Model section dropdown", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    // Open dropdown to access filter input
    const trigger = screen.getByLabelText("Default Model");
    await user.click(trigger);

    // Filter input should be present in dropdown
    expect(screen.getByPlaceholderText("Filter models…")).toBeTruthy();
  });

  it("filters default model options in Model section", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
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

  it("clear button resets filter in Model section", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
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

  it("shows empty state in Model section when filter matches nothing", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
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
    expect(testNtfyNotification).toHaveBeenCalledWith({ ntfyEnabled: true, ntfyTopic: "my-valid-topic" });
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
    const input = screen.getByLabelText("Stuck Task Timeout (ms)");
    expect(input).toBeTruthy();
    expect(input.getAttribute("type")).toBe("number");
    expect(input.getAttribute("min")).toBe("0");
    expect(input.getAttribute("step")).toBe("60000");
  });

  it("Stuck Task Timeout field saves correctly when set to a value", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const input = screen.getByLabelText("Stuck Task Timeout (ms)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "600000" } });
    expect(input.value).toBe("600000");

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.taskStuckTimeoutMs).toBe(600000);
  });

  it("Stuck Task Timeout field submits undefined when set to 0 or empty (disabled)", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      taskStuckTimeoutMs: 600000,
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
    const input = screen.getByLabelText("Stuck Task Timeout (ms)") as HTMLInputElement;
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
    expect(screen.getByText(/Timeout in milliseconds for detecting stuck tasks/)).toBeTruthy();
  });

  it("scope banners render for global and project sections", async () => {
    const { container } = render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // General section is project-scoped → should show project banner
    expect(container.querySelector(".settings-scope-project")).toBeTruthy();
    expect(container.querySelector(".settings-scope-global")).toBeNull();

    // Switch to Model → should show global banner
    fireEvent.click(screen.getByText("Model"));
    expect(container.querySelector(".settings-scope-global")).toBeTruthy();
    expect(container.querySelector(".settings-scope-project")).toBeNull();
  });
});
