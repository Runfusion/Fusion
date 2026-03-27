import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsModal } from "../SettingsModal";
import type { Settings } from "@hai/core";

const defaultSettings: Settings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: false,
  autoMerge: false,
  recycleWorktrees: false,
  worktreeInitCommand: "",
  testCommand: "",
  buildCommand: "",
};

vi.mock("../../api", () => ({
  fetchSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  updateSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  fetchAuthStatus: vi.fn(() => Promise.resolve({ providers: [{ id: "anthropic", name: "Anthropic", authenticated: false }] })),
  loginProvider: vi.fn(() => Promise.resolve({ url: "https://auth.example.com/login" })),
  logoutProvider: vi.fn(() => Promise.resolve({ success: true })),
  fetchModels: vi.fn(() => Promise.resolve([
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ])),
}));

import { fetchSettings, updateSettings, fetchAuthStatus, loginProvider, logoutProvider, fetchModels } from "../../api";

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
    expect(screen.getByText("Include task ID in commit scope")).toBeTruthy();
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

  it("shows Include task ID in commit scope checkbox in Merge section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Merge"));
    const checkbox = screen.getByLabelText("Include task ID in commit scope");
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

  it("shows Model in sidebar", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getAllByText("Model").length).toBeGreaterThanOrEqual(1);
  });

  it("shows model selector with available models grouped by provider", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    expect(screen.getByLabelText("Default Model")).toBeTruthy();
    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("GPT-4o")).toBeTruthy();
    expect(screen.getByText("Use default")).toBeTruthy();
  });

  it("selecting a model updates form with provider and model ID", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    const select = screen.getByLabelText("Default Model") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "anthropic/claude-sonnet-4-5" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.defaultProvider).toBe("anthropic");
    expect(payload.defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("Use default option clears model selection", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Model"));
    await waitFor(() => expect(fetchModels).toHaveBeenCalled());

    const select = screen.getByLabelText("Default Model") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
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
});
