import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { App } from "../../App";
import type { Settings } from "@kb/core";

const defaultSettings: Settings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: false,
  autoMerge: true,
  recycleWorktrees: false,
  worktreeInitCommand: "",
  testCommand: "",
  buildCommand: "",
};

vi.mock("../../api", () => ({
  fetchTasks: vi.fn(() => Promise.resolve([])),
  fetchConfig: vi.fn(() => Promise.resolve({ maxConcurrent: 2 })),
  fetchSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  updateSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  fetchAuthStatus: vi.fn(() =>
    Promise.resolve({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: false },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    }),
  ),
  loginProvider: vi.fn(() => Promise.resolve({ url: "https://auth.example.com/login" })),
  logoutProvider: vi.fn(() => Promise.resolve({ success: true })),
  fetchModels: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../hooks/useTasks", () => ({
  useTasks: () => ({
    tasks: [],
    createTask: vi.fn(),
    moveTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    retryTask: vi.fn(),
  }),
}));

import { fetchAuthStatus, fetchSettings, updateSettings } from "../../api";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("App auto-open Settings on unauthenticated", () => {
  it("auto-opens Settings to Authentication tab when all providers are unauthenticated", async () => {
    render(<App />);

    // Wait for the auth status check and settings modal to appear
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // The Settings modal should be open showing Authentication content
    // fetchSettings is called twice: once by App useEffect, once by SettingsModal
    await waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(2));

    // Authentication section should be active — auth status is fetched when section is active
    // Wait for the auth providers to appear
    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeTruthy();
    });
    expect(screen.getByText("GitHub")).toBeTruthy();

    // General section should NOT be showing
    expect(screen.queryByLabelText("Task Prefix")).toBeNull();
  });

  it("does NOT auto-open Settings when at least one provider is authenticated", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "github", name: "GitHub", authenticated: false },
      ],
    });

    render(<App />);

    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());

    // Settings modal should NOT be open — no modal overlay
    // fetchSettings called once by App useEffect only (not by SettingsModal)
    await waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(1));

    // No settings modal content
    expect(screen.queryByText("Settings")).toBeNull();
  });

  it("does NOT auto-open Settings when fetchAuthStatus fails", async () => {
    (fetchAuthStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    render(<App />);

    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());
    await waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(1));

    // Settings modal should NOT be open
    expect(screen.queryByText("Settings")).toBeNull();
  });

  it("re-opening Settings via gear icon defaults to General tab after auto-opened close", async () => {
    render(<App />);

    // Wait for auto-open
    await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());
    await waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeTruthy();
    });

    // Close the auto-opened settings modal via Cancel button
    fireEvent.click(screen.getByText("Cancel"));

    // Settings modal should be closed
    await waitFor(() => {
      expect(screen.queryByText("Anthropic")).toBeNull();
    });

    // Open settings again via the gear icon button
    const settingsButton = screen.getByTitle("Settings");
    fireEvent.click(settingsButton);

    // Now it should open to General section (default)
    await waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Task Prefix")).toBeTruthy();
    expect(screen.queryByText("Anthropic")).toBeNull();
  });
});

describe("App global pause (hard stop)", () => {
  it("initializes global pause state from fetchSettings", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      globalPause: true,
    });

    render(<App />);

    // When globally paused, the stop button should show "Start AI engine"
    await waitFor(() => {
      expect(screen.getByTitle("Start AI engine")).toBeTruthy();
    });
  });

  it("shows Stop button when globalPause is false", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      globalPause: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Stop AI engine")).toBeTruthy();
    });
  });

  it("toggles global pause state and calls updateSettings", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      globalPause: false,
    });

    render(<App />);

    // Wait for initial render
    await waitFor(() => {
      expect(screen.getByTitle("Stop AI engine")).toBeTruthy();
    });

    // Click the stop button
    fireEvent.click(screen.getByTitle("Stop AI engine"));

    // Should optimistically switch to "Start" state
    await waitFor(() => {
      expect(screen.getByTitle("Start AI engine")).toBeTruthy();
    });

    // Should call updateSettings with globalPause: true
    expect(updateSettings).toHaveBeenCalledWith({ globalPause: true });
  });

  it("reverts global pause state on updateSettings failure", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      globalPause: false,
    });
    (updateSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Stop AI engine")).toBeTruthy();
    });

    // Click the stop button — will fail
    fireEvent.click(screen.getByTitle("Stop AI engine"));

    // Should revert back to "Stop" state after failure
    await waitFor(() => {
      expect(screen.getByTitle("Stop AI engine")).toBeTruthy();
    });
  });
});

describe("App engine pause (soft pause)", () => {
  it("initializes engine pause state from fetchSettings", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      enginePaused: true,
    });

    render(<App />);

    // When engine is paused, the pause button should show "Resume scheduling"
    await waitFor(() => {
      expect(screen.getByTitle("Resume scheduling")).toBeTruthy();
    });
  });

  it("shows Pause button when enginePaused is false", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      enginePaused: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Pause scheduling")).toBeTruthy();
    });
  });

  it("toggles engine pause state and calls updateSettings", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...defaultSettings,
      enginePaused: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Pause scheduling")).toBeTruthy();
    });

    // Click the pause button
    fireEvent.click(screen.getByTitle("Pause scheduling"));

    // Should optimistically switch to "Resume" state
    await waitFor(() => {
      expect(screen.getByTitle("Resume scheduling")).toBeTruthy();
    });

    // Should call updateSettings with enginePaused: true
    expect(updateSettings).toHaveBeenCalledWith({ enginePaused: true });
  });
});
