import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SetupWizardModal } from "../SetupWizardModal";

// Mock the API and utils
const mockFetchFirstRunStatus = vi.fn();
const mockDetectProjects = vi.fn();
const mockRegisterProject = vi.fn();

vi.mock("../api", () => ({
  fetchFirstRunStatus: (...args: unknown[]) => mockFetchFirstRunStatus(...args),
  detectProjects: (...args: unknown[]) => mockDetectProjects(...args),
  registerProject: (...args: unknown[]) => mockRegisterProject(...args),
}));

vi.mock("../utils/projectDetection", () => ({
  scanForProjects: (...args: unknown[]) => mockDetectProjects(...args),
  suggestProjectName: (path: string) => path.split("/").pop() || "",
  isValidProjectName: (name: string) => /^[a-zA-Z0-9_-]+$/.test(name),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  X: () => <span data-testid="x-icon">×</span>,
  Loader2: () => <span data-testid="loader-icon">⟳</span>,
  FolderPlus: () => <span data-testid="folder-icon">📁</span>,
  Search: () => <span data-testid="search-icon">🔍</span>,
  CheckCircle: () => <span data-testid="check-icon">✓</span>,
  ArrowRight: () => <span data-testid="arrow-right">→</span>,
  ArrowLeft: () => <span data-testid="arrow-left">←</span>,
  Folder: () => <span data-testid="folder-small">📂</span>,
  Check: () => <span data-testid="check-small">✓</span>,
  AlertCircle: () => <span data-testid="alert-icon">⚠</span>,
  Pencil: () => <span data-testid="pencil-icon">✎</span>,
}));

const noop = () => {};

describe("SetupWizardModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Default: no projects, so wizard should auto-open
    mockFetchFirstRunStatus.mockResolvedValue({ hasProjects: false });
  });

  it("auto-opens when no projects exist", async () => {
    render(
      <SetupWizardModal
        onProjectRegistered={noop}
        onProjectsRegistered={noop}
        onClose={noop}
      />
    );

    // Wait for the effect to run
    await waitFor(() => {
      expect(mockFetchFirstRunStatus).toHaveBeenCalled();
    });

    // Should show welcome screen
    await waitFor(() => {
      expect(screen.getByText("Welcome to kb")).toBeDefined();
    });
  });

  it("does not auto-open when projects exist", async () => {
    mockFetchFirstRunStatus.mockResolvedValue({ hasProjects: true });

    render(
      <SetupWizardModal
        onProjectRegistered={noop}
        onProjectsRegistered={noop}
        onClose={noop}
      />
    );

    await waitFor(() => {
      expect(mockFetchFirstRunStatus).toHaveBeenCalled();
    });

    // Should not show welcome screen
    expect(screen.queryByText("Welcome to kb")).toBeNull();
  });

  it("shows welcome step with auto-detect and manual options", async () => {
    render(
      <SetupWizardModal
        onProjectRegistered={noop}
        onProjectsRegistered={noop}
        onClose={noop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Welcome to kb")).toBeDefined();
    });

    expect(screen.getByText("Auto-detect Projects")).toBeDefined();
    expect(screen.getByText("Add Manually")).toBeDefined();
  });

  it("transitions to detecting step when auto-detect clicked", async () => {
    mockDetectProjects.mockResolvedValue({ projects: [] });

    render(
      <SetupWizardModal
        onProjectRegistered={noop}
        onProjectsRegistered={noop}
        onClose={noop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Auto-detect Projects")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Auto-detect Projects"));

    await waitFor(() => {
      expect(screen.getByText("Detecting Projects...")).toBeDefined();
    });
  });

  it("shows review step with detected projects", async () => {
    mockDetectProjects.mockResolvedValue({
      projects: [
        { path: "/home/user/project1", suggestedName: "project1", existing: false },
        { path: "/home/user/project2", suggestedName: "project2", existing: false },
      ],
    });

    render(
      <SetupWizardModal
        onProjectRegistered={noop}
        onProjectsRegistered={noop}
        onClose={noop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Auto-detect Projects")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Auto-detect Projects"));

    await waitFor(() => {
      expect(screen.getByText("Review Detected Projects")).toBeDefined();
    });

    // Should show detected projects
    await waitFor(() => {
      expect(screen.getByText("project1")).toBeDefined();
      expect(screen.getByText("project2")).toBeDefined();
    });
  });

  it("transitions to manual step when manual option clicked", async () => {
    render(
      <SetupWizardModal
        onProjectRegistered={noop}
        onProjectsRegistered={noop}
        onClose={noop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Add Manually")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Add Manually"));

    await waitFor(() => {
      expect(screen.getByText("Add Project Manually")).toBeDefined();
    });
  });

  it("allows entering project details in manual step", async () => {
    render(
      <SetupWizardModal
        onProjectRegistered={noop}
        onProjectsRegistered={noop}
        onClose={noop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Add Manually")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Add Manually"));

    await waitFor(() => {
      expect(screen.getByLabelText("Project Path")).toBeDefined();
    });

    const pathInput = screen.getByLabelText("Project Path");
    fireEvent.change(pathInput, { target: { value: "/path/to/project" } });

    expect(pathInput).toHaveValue("/path/to/project");
  });

  it("calls onProjectRegistered when manual registration succeeds", async () => {
    const onProjectRegistered = vi.fn();
    mockRegisterProject.mockResolvedValue({
      id: "proj_123",
      name: "Test Project",
      path: "/path/to/project",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    render(
      <SetupWizardModal
        onProjectRegistered={onProjectRegistered}
        onProjectsRegistered={noop}
        onClose={noop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Add Manually")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Add Manually"));

    await waitFor(() => {
      expect(screen.getByLabelText("Project Path")).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText("Project Path"), {
      target: { value: "/path/to/project" },
    });
    fireEvent.change(screen.getByLabelText("Project Name"), {
      target: { value: "test-project" },
    });

    fireEvent.click(screen.getByText("Register Project"));

    await waitFor(() => {
      expect(onProjectRegistered).toHaveBeenCalled();
    });
  });

  it("persists wizard state to localStorage", async () => {
    mockDetectProjects.mockResolvedValue({
      projects: [{ path: "/home/user/project1", suggestedName: "project1", existing: false }],
    });

    render(
      <SetupWizardModal
        onProjectRegistered={noop}
        onProjectsRegistered={noop}
        onClose={noop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Auto-detect Projects")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Auto-detect Projects"));

    await waitFor(() => {
      expect(screen.getByText("Review Detected Projects")).toBeDefined();
    });

    // Check localStorage was updated
    await waitFor(() => {
      const saved = localStorage.getItem("kb-setup-wizard-state");
      expect(saved).toBeTruthy();
      const parsed = JSON.parse(saved!);
      expect(parsed.inProgress).toBe(true);
      expect(parsed.step).toBe("review");
    });
  });

  it("clears localStorage when closed", async () => {
    const onClose = vi.fn();
    
    // Pre-populate localStorage
    localStorage.setItem(
      "kb-setup-wizard-state",
      JSON.stringify({ inProgress: true, step: "review", detectedProjects: [] })
    );

    mockFetchFirstRunStatus.mockResolvedValue({ hasProjects: false });

    render(
      <SetupWizardModal
        onProjectRegistered={noop}
        onProjectsRegistered={noop}
        onClose={onClose}
      />
    );

    // Wait for modal to open
    await waitFor(() => {
      expect(screen.getByText("Review Detected Projects")).toBeDefined();
    });

    // Close the modal
    fireEvent.click(screen.getByLabelText("Close wizard"));

    expect(localStorage.getItem("kb-setup-wizard-state")).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });
});
