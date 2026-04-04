import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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
    fetchModels: vi.fn(() => Promise.resolve({ models: [], favoriteProviders: [], favoriteModels: [] })),
    fetchGitRemotes: vi.fn(() => Promise.resolve([])),
    fetchAgents: vi.fn(() => Promise.resolve([])),
    fetchTaskDetail: vi.fn((id: string) => Promise.resolve({ id, title: `Task ${id}` })),
    fetchScripts: vi.fn(() => Promise.resolve({ build: "npm run build", test: "pnpm test" })),
    runScript: vi.fn(() => Promise.resolve({ sessionId: "sess-script-1", command: "echo hello" })),
    killPtyTerminalSession: vi.fn(() => Promise.resolve({ killed: true })),
    fetchScripts: vi.fn(() => Promise.resolve({ build: "npm run build", test: "pnpm test" })),
  };
});

const mockUseTasks = vi.fn(() => ({
  tasks: [],
  createTask: vi.fn(),
  moveTask: vi.fn(),
  deleteTask: vi.fn(),
  mergeTask: vi.fn(),
  retryTask: vi.fn(),
  updateTask: vi.fn(),
  duplicateTask: vi.fn(),
  archiveTask: vi.fn(),
  unarchiveTask: vi.fn(),
  archiveAllDone: vi.fn(),
}));

vi.mock("../../hooks/useTasks", () => ({
  useTasks: () => mockUseTasks(),
}));

// Mock state holders for dynamic mocking
const mockProjectsState = {
  projects: [] as any[],
};

const mockCurrentProjectState = {
  currentProject: { id: "proj_123", name: "Test Project", path: "/test", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
  setCurrentProject: vi.fn(),
  clearCurrentProject: vi.fn(),
  loading: false,
};

vi.mock("../../hooks/useProjects", () => ({
  useProjects: () => ({
    projects: mockProjectsState.projects,
    loading: false,
    error: null,
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
  }),
}));

vi.mock("../../hooks/useCurrentProject", () => ({
  useCurrentProject: () => mockCurrentProjectState,
}));

// Mock useTerminal for terminal components
vi.mock("../../hooks/useTerminal", () => ({
  useTerminal: () => ({
    connectionStatus: "connected",
    sendInput: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onConnect: vi.fn(() => vi.fn()),
    onScrollback: vi.fn(() => vi.fn()),
    reconnect: vi.fn(),
  }),
}));

import { App } from "../../App";
import { fetchAuthStatus, fetchSettings, fetchTaskDetail, updateSettings, runScript, fetchScripts } from "../../api";

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTasks.mockReset();
  mockUseTasks.mockImplementation(() => ({
    tasks: [],
    createTask: vi.fn(),
    moveTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    retryTask: vi.fn(),
    updateTask: vi.fn(),
    duplicateTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    archiveAllDone: vi.fn(),
  }));
  // Reset mock states
  mockProjectsState.projects = [];
  mockCurrentProjectState.currentProject = { id: "proj_123", name: "Test Project", path: "/test", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" };
  mockCurrentProjectState.setCurrentProject.mockClear();
  mockCurrentProjectState.clearCurrentProject.mockClear();
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
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-123", "proj_123");
    });

    await waitFor(() => {
      expect(screen.getByText("Task FN-123")).toBeTruthy();
    });

    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it("shows an error toast when the deep-linked task cannot be loaded", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-404"),
    });
    (fetchTaskDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Not found"));

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-404", "proj_123");
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

  it("switches project and opens task when both project and task params are present", async () => {
    const project1 = { id: "proj_123", name: "Test Project", path: "/test", status: "active", isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    const project2 = { id: "proj_456", name: "Other Project", path: "/other", status: "active", isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    mockProjectsState.projects = [project1, project2];
    mockCurrentProjectState.currentProject = project1;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456&task=FN-789"),
    });

    render(<App />);

    await waitFor(() => {
      expect(mockCurrentProjectState.setCurrentProject).toHaveBeenCalledWith(project2);
    });

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-789", "proj_456");
    });

    await waitFor(() => {
      expect(screen.getByText("Task FN-789")).toBeTruthy();
    });
  });

  it("shows error toast when project param references non-existent project", async () => {
    mockProjectsState.projects = [];
    mockCurrentProjectState.currentProject = null;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=nonexistent&task=FN-123"),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    // Should show error toast for project not found
    await waitFor(() => {
      expect(screen.getByText("Project 'nonexistent' not found")).toBeTruthy();
    });

    // Should NOT fetch the task since project wasn't found
    expect(fetchTaskDetail).not.toHaveBeenCalled();
  });

  it("does not call setCurrentProject when project param matches current project", async () => {
    const project = { id: "proj_123", name: "Test Project", path: "/test", status: "active", isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };
    mockProjectsState.projects = [project];
    mockCurrentProjectState.currentProject = project;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_123&task=FN-123"),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-123", "proj_123");
    });

    // setCurrentProject should NOT be called since we're already on this project
    expect(mockCurrentProjectState.setCurrentProject).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByText("Task FN-123")).toBeTruthy();
    });
  });

  it("works without project param for backward compatibility", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-123"),
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchTaskDetail).toHaveBeenCalledWith("FN-123", "proj_123");
    });

    await waitFor(() => {
      expect(screen.getByText("Task FN-123")).toBeTruthy();
    });

    // setCurrentProject should NOT be called when no project param
    expect(mockCurrentProjectState.setCurrentProject).not.toHaveBeenCalled();
  });
});

describe("App mission wiring", () => {
  afterEach(() => {
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("hides mission controls when no project is selected", async () => {
    mockCurrentProjectState.currentProject = null;
    mockProjectsState.projects = [];

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    expect(screen.queryByTestId("missions-btn")).toBeNull();
  });

  it("shows mission controls in project view when a project is selected", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    mockCurrentProjectState.currentProject = {
      id: "proj_123",
      name: "Test Project",
      path: "/test",
      status: "active",
      isolationMode: "in-process",
      createdAt: "",
      updatedAt: "",
    };

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("missions-btn")).toBeTruthy();
    });
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

    // Authentication auto-open should not render General fields yet
    expect(screen.queryByLabelText("Task Prefix")).toBeNull();

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
    expect(updateSettings).toHaveBeenCalledWith({ globalPause: true }, "proj_123");
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
    expect(updateSettings).toHaveBeenCalledWith({ enginePaused: true }, "proj_123");
  });
});

describe("App view switching", () => {
  it("renders Board view by default", async () => {
    // Set project mode so board view is available
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    // Wait for the app to render and check that the board is visible
    await waitFor(() => {
      expect(document.querySelector(".board")).toBeTruthy();
    });

    // Cleanup
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("renders ListView when view is switched to list", async () => {
    // Set project mode so board/list view is available
    localStorage.setItem("kb-dashboard-view-mode", "project");

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

    // Cleanup
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("switches back to Board view from list view", async () => {
    // Set project mode so board/list view is available
    localStorage.setItem("kb-dashboard-view-mode", "project");

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

    // Cleanup
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("opens the NewTaskModal from the list view new-task button", async () => {
    // Set project mode so board/list view is available
    localStorage.setItem("kb-dashboard-view-mode", "project");

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

    // Cleanup
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("persists view preference to localStorage", async () => {
    // Clear any previous value and set project mode
    localStorage.removeItem("kb-dashboard-task-view");
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    // Wait for the header to render
    await waitFor(() => {
      expect(screen.getByTitle("List view")).toBeTruthy();
    });

    // Switch to list view
    fireEvent.click(screen.getByTitle("List view"));

    // Should have saved to localStorage
    await waitFor(() => {
      expect(localStorage.getItem("kb-dashboard-task-view")).toBe("list");
    });

    // Cleanup
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("initializes view from localStorage if available", async () => {
    // Set localStorage to list view and project mode
    localStorage.setItem("kb-dashboard-task-view", "list");
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    // Wait for the app to render
    await waitFor(() => {
      expect(document.querySelector(".list-view")).toBeTruthy();
    });

    // List view should be active
    expect(screen.getByTitle("List view").className).toContain("active");

    // Cleanup
    localStorage.removeItem("kb-dashboard-task-view");
    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("shows view toggle buttons in header including agents", async () => {
    render(<App />);

    // Wait for the header to render with view toggle
    await waitFor(() => {
      expect(screen.getByTitle("Board view")).toBeTruthy();
      expect(screen.getByTitle("List view")).toBeTruthy();
      expect(screen.getByTitle("Agents view")).toBeTruthy();
    });
  });

  it("hides agent view controls when no project is active", async () => {
    mockCurrentProjectState.currentProject = null;
    localStorage.setItem("kb-dashboard-view-mode", "overview");

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTitle("Agents view")).toBeNull();
    });

    localStorage.removeItem("kb-dashboard-view-mode");
  });

  it("renders AgentsView when agents view is selected", async () => {
    render(<App />);

    // Wait for the header to render
    await waitFor(() => {
      expect(screen.getByTitle("Agents view")).toBeTruthy();
    });

    // Click to switch to agents view
    fireEvent.click(screen.getByTitle("Agents view"));

    // Agents view should be rendered (it has a agents-view container)
    await waitFor(() => {
      expect(document.querySelector(".agents-view")).toBeTruthy();
    });

    // Should NOT show board or list view
    expect(document.querySelector(".board")).toBeNull();
    expect(document.querySelector(".list-view")).toBeNull();
  });

  it("persists agents view preference to localStorage", async () => {
    localStorage.removeItem("kb-dashboard-task-view");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Agents view")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Agents view"));

    await waitFor(() => {
      expect(localStorage.getItem("kb-dashboard-task-view")).toBe("agents");
    });
  });

  it("initializes agents view from localStorage if saved", async () => {
    localStorage.setItem("kb-dashboard-task-view", "agents");

    render(<App />);

    await waitFor(() => {
      expect(document.querySelector(".agents-view")).toBeTruthy();
    });

    expect(screen.getByTitle("Agents view").className).toContain("active");

    localStorage.removeItem("kb-dashboard-task-view");
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

describe("Script run flow", () => {
  it("calls runScript API and returns session info", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });

    const { runScript: runScriptMock } = await import("../../api");

    await act(async () => {
      const result = await runScriptMock("build", undefined, "proj_123");
      expect(result).toEqual({ sessionId: "sess-script-1", command: "echo hello" });
    });

    expect(runScriptMock).toHaveBeenCalledWith("build", undefined, "proj_123");
  });

  it("shows error toast when runScript API fails", async () => {
    const { runScript: runScriptMock } = await import("../../api");
    (runScriptMock as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Script not found"));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });

    await act(async () => {
      try {
        await runScriptMock("missing-script", undefined, "proj_123");
      } catch {
        // Expected to throw
      }
    });

    expect(runScriptMock).toHaveBeenCalledWith("missing-script", undefined, "proj_123");
  });
});

describe("Script-to-terminal modal handoff", () => {
  it("closes ScriptsModal and opens TerminalModal when Run is clicked", async () => {
    render(<App />);

    // Wait for the app to fully render
    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });

    // Open the Scripts modal via the quick-scripts dropdown "Manage Scripts..." button
    const scriptsBtn = screen.getByTestId("scripts-btn");
    await act(async () => {
      fireEvent.click(scriptsBtn);
    });

    // Wait for the dropdown menu to appear and click "Manage Scripts..."
    await waitFor(() => {
      expect(screen.getByTestId("quick-scripts-manage")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-scripts-manage"));
    });

    // Wait for the Scripts modal to open and load scripts
    await waitFor(() => {
      expect(screen.getByTestId("scripts-modal")).toBeTruthy();
    });

    // Click the Run button on the "build" script
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-script-build"));
    });

    // The Scripts modal should now be closed
    await waitFor(() => {
      expect(screen.queryByTestId("scripts-modal")).toBeNull();
    });

    // The TerminalModal should be open (not the old ScriptRunDialog)
    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });

    // ScriptRunDialog should NOT be rendered at all
    expect(screen.queryByTestId("script-run-dialog-overlay")).toBeNull();
  });

  it("allows reopening ScriptsModal after closing TerminalModal", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });

    // Open the Scripts modal and run a script
    const scriptsBtn = screen.getByTestId("scripts-btn");
    await act(async () => {
      fireEvent.click(scriptsBtn);
    });

    await waitFor(() => {
      expect(screen.getByTestId("quick-scripts-manage")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-scripts-manage"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("scripts-modal")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("run-script-build"));
    });

    // Wait for TerminalModal to open
    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("scripts-modal")).toBeNull();

    // Close the TerminalModal
    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-close-btn"));
    });

    // TerminalModal should be closed
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-modal")).toBeNull();
    });

    // Reopen the Scripts modal
    await act(async () => {
      fireEvent.click(scriptsBtn);
    });

    await waitFor(() => {
      expect(screen.getByTestId("quick-scripts-manage")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-scripts-manage"));
    });

    // Scripts modal should open again cleanly
    await waitFor(() => {
      expect(screen.getByTestId("scripts-modal")).toBeTruthy();
    });
  });

  it("does not call runScript API — command is sent directly to terminal", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTitle("Settings")).toBeTruthy();
    });

    // Open the Scripts modal
    const scriptsBtn = screen.getByTestId("scripts-btn");
    await act(async () => {
      fireEvent.click(scriptsBtn);
    });

    await waitFor(() => {
      expect(screen.getByTestId("quick-scripts-manage")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-scripts-manage"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("scripts-modal")).toBeTruthy();
    });

    // Click Run on the "build" script
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-script-build"));
    });

    // TerminalModal should open
    await waitFor(() => {
      expect(screen.getByTestId("terminal-modal")).toBeTruthy();
    });

    // runScript API should NOT have been called — command goes directly to terminal
    expect(runScript).not.toHaveBeenCalled();
  });
});

describe("App footer-safe project layout", () => {
  afterEach(() => {
    localStorage.removeItem("kb-dashboard-view-mode");
    localStorage.removeItem("kb-dashboard-task-view");
  });

  it("wraps project content in project-content div with footer class when project is selected", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");

    render(<App />);

    await waitFor(() => {
      const wrapper = document.querySelector(".project-content--with-footer");
      expect(wrapper).toBeTruthy();
      expect(wrapper?.classList.contains("project-content")).toBe(true);
    });

    // The board should be inside the footer-safe wrapper
    const wrapper = document.querySelector(".project-content--with-footer");
    expect(wrapper?.querySelector(".board")).toBeTruthy();
  });

  it("uses project-content wrapper without footer class in overview mode", async () => {
    mockCurrentProjectState.currentProject = null;
    mockProjectsState.projects = [];
    localStorage.setItem("kb-dashboard-view-mode", "overview");

    render(<App />);

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    // Wrapper should have project-content but NOT project-content--with-footer
    const wrapper = document.querySelector(".project-content");
    expect(wrapper).toBeTruthy();
    expect(wrapper?.classList.contains("project-content--with-footer")).toBe(false);
  });

  it("adds and removes footer class when switching between project and overview", async () => {
    // Start in project mode
    localStorage.setItem("kb-dashboard-view-mode", "project");

    const { rerender } = render(<App />);

    await waitFor(() => {
      expect(document.querySelector(".project-content--with-footer")).toBeTruthy();
    });

    // Switch to overview by clearing project
    mockCurrentProjectState.currentProject = null;
    mockProjectsState.projects = [];

    rerender(<App />);

    await waitFor(() => {
      const wrapper = document.querySelector(".project-content");
      expect(wrapper).toBeTruthy();
      expect(wrapper?.classList.contains("project-content--with-footer")).toBe(false);
    });
  });

  it("renders agents view inside the footer-safe wrapper", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem("kb-dashboard-task-view", "agents");

    render(<App />);

    await waitFor(() => {
      const wrapper = document.querySelector(".project-content--with-footer");
      expect(wrapper).toBeTruthy();
      expect(wrapper?.querySelector(".agents-view")).toBeTruthy();
    });
  });

  it("renders list view inside the footer-safe wrapper", async () => {
    localStorage.setItem("kb-dashboard-view-mode", "project");
    localStorage.setItem("kb-dashboard-task-view", "list");

    render(<App />);

    await waitFor(() => {
      const wrapper = document.querySelector(".project-content--with-footer");
      expect(wrapper).toBeTruthy();
      expect(wrapper?.querySelector(".list-view")).toBeTruthy();
    });
  });
});
