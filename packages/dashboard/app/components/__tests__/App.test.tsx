import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { App } from "../../App";
import type { Settings } from "@fusion/core";

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

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
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
    fetchGitRemotes: vi.fn(() => Promise.resolve([])),
    fetchTaskDetail: vi.fn((id: string) => Promise.resolve({
      id,
      title: `Task ${id}`,
      description: "Deep linked task",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      log: [],
      prompt: "",
    })),
  };
});

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

import { fetchAuthStatus, fetchSettings, fetchTaskDetail, updateSettings } from "../../api";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("App deep link handling", () => {
  const originalLocation = window.location;
  const originalReplaceState = window.history.replaceState;

  beforeEach(() => {
    window.history.replaceState = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/"),
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    window.history.replaceState = originalReplaceState;
  });

  it("fetches and opens the task modal when task query param is present", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-123"),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-123");
    });

    await waitFor(() => {
      expect(screen.getByText("Task FN-123")).toBeTruthy();
    });

    expect(window.history.replaceState).toHaveBeenCalledWith(
      {},
      "",
      "http://localhost:3000/",
    );
  });

  it("shows an error toast when the deep-linked task cannot be loaded", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-404"),
    });
    (fetchTaskDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Not found"));

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-404");
    });

    await waitFor(() => {
      expect(screen.getByText("Task FN-404 not found")).toBeTruthy();
    });
  });

  it("does nothing when no task query param is present", async () => {
    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    expect(fetchTaskDetail).not.toHaveBeenCalled();
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });
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

describe("App view switching", () => {
  it("renders Board view by default", async () => {
    render(<App />);

    // Wait for the app to render and check that the board is visible
    await waitFor(() => {
      expect(screen.getByRole("main")).toBeTruthy();
    });

    // Board should be rendered
    expect(screen.getByRole("main").className).toContain("board");
  });

  it("renders ListView when view is switched to list", async () => {
    render(<App />);

    // Wait for the header to render with view toggle
    await waitFor(() => {
      expect(screen.getByTitle("List view")).toBeTruthy();
    });

    // Click to switch to list view
    fireEvent.click(screen.getByTitle("List view"));

    // List view should be rendered (it has a different structure)
    await waitFor(() => {
      expect(document.querySelector(".list-view")).toBeTruthy();
    });
  });

  it("switches back to Board view from list view", async () => {
    render(<App />);

    // Wait for the header to render
    await waitFor(() => {
      expect(screen.getByTitle("List view")).toBeTruthy();
    });

    // Switch to list view
    fireEvent.click(screen.getByTitle("List view"));
    await waitFor(() => {
      expect(document.querySelector(".list-view")).toBeTruthy();
    });

    // Switch back to board view
    fireEvent.click(screen.getByTitle("Board view"));
    await waitFor(() => {
      expect(document.querySelector(".board")).toBeTruthy();
    });
  });

  it("opens the NewTaskModal from the list view new-task button", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("List view")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("List view"));

    await waitFor(() => {
      expect(document.querySelector(".list-view")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("+ New Task"));

    // The NewTaskModal should be visible with its header and description field
    await waitFor(() => {
      expect(screen.getByText("New Task")).toBeTruthy();
      expect(screen.getByPlaceholderText("What needs to be done?")).toBeTruthy();
    });
  });

  it("persists view preference to localStorage", async () => {
    // Clear any previous value
    localStorage.removeItem("kb-dashboard-view");

    render(<App />);

    // Wait for the header to render
    await waitFor(() => {
      expect(screen.getByTitle("List view")).toBeTruthy();
    });

    // Switch to list view
    fireEvent.click(screen.getByTitle("List view"));

    // Should have saved to localStorage
    await waitFor(() => {
      expect(localStorage.getItem("kb-dashboard-view")).toBe("list");
    });
  });

  it("initializes view from localStorage if available", async () => {
    // Set localStorage to list view
    localStorage.setItem("kb-dashboard-view", "list");

    render(<App />);

    // Wait for the app to render
    await waitFor(() => {
      expect(document.querySelector(".list-view")).toBeTruthy();
    });

    // List view should be active
    expect(screen.getByTitle("List view").className).toContain("active");

    // Cleanup
    localStorage.removeItem("kb-dashboard-view");
  });

  it("shows view toggle buttons in header", async () => {
    render(<App />);

    // Wait for the header to render with view toggle
    await waitFor(() => {
      expect(screen.getByTitle("Board view")).toBeTruthy();
      expect(screen.getByTitle("List view")).toBeTruthy();
    });
  });
});

describe("App GitHub import", () => {
  it("opens GitHub import modal when import button is clicked", async () => {
    render(<App />);

    // Wait for the header to render
    await waitFor(() => {
      expect(screen.getByTitle("Import from GitHub")).toBeTruthy();
    });

    // Click the import button
    fireEvent.click(screen.getByTitle("Import from GitHub"));

    // Modal should be visible
    expect(screen.getByText("Import from GitHub")).toBeTruthy();
  });

  it("closes GitHub import modal on cancel", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Import from GitHub")).toBeTruthy();
    });

    // Open the modal
    fireEvent.click(screen.getByTitle("Import from GitHub"));
    expect(screen.getByText("Import from GitHub")).toBeTruthy();

    // Close the modal - use getAllByRole since there might be multiple buttons
    const cancelButtons = screen.getAllByRole("button", { name: /Cancel/i });
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    // Modal should be closed - the Load button from the modal should be gone
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^Load$/i })).toBeNull();
    });
  });
});

describe("App Planning Mode", () => {
  it("opens Planning Mode modal when plan button is clicked", async () => {
    render(<App />);

    // Wait for the header to render
    await waitFor(() => {
      expect(screen.getByTitle("Create a task with AI planning")).toBeTruthy();
    });

    // Click the plan button
    fireEvent.click(screen.getByTitle("Create a task with AI planning"));

    // Planning modal should be visible
    await waitFor(() => {
      expect(screen.getByText("Planning Mode")).toBeTruthy();
    });
  });

  it("closes Planning Mode modal on close button click", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Create a task with AI planning")).toBeTruthy();
    });

    // Open the modal
    fireEvent.click(screen.getByTitle("Create a task with AI planning"));
    await waitFor(() => {
      expect(screen.getByText("Planning Mode")).toBeTruthy();
    });

    // Close the modal using the close button
    fireEvent.click(screen.getByLabelText("Close"));

    // Modal should be closed
    await waitFor(() => {
      expect(screen.queryByText("Transform your idea into a detailed task")).toBeNull();
    });
  });

  it("renders planning modal with correct initial state", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Create a task with AI planning")).toBeTruthy();
    });

    // Open the modal
    fireEvent.click(screen.getByTitle("Create a task with AI planning"));

    // Initial view should show
    await waitFor(() => {
      expect(screen.getByText("Transform your idea into a detailed task")).toBeTruthy();
      expect(screen.getByPlaceholderText(/e.g., Build a user authentication system with login/)).toBeTruthy();
      expect(screen.getByText("Start Planning")).toBeTruthy();
    });
  });
});
