import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SetupWizardModal } from "../SetupWizardModal";

// Mock lucide-react
vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    X: ({ size, ...props }: any) => <span data-testid="close-icon" {...props}>×</span>,
    Loader2: ({ size, ...props }: any) => <span data-testid="loader" {...props}>⟳</span>,
    Sparkles: ({ size, ...props }: any) => <span data-testid="sparkles-icon" {...props}>✨</span>,
    CheckCircle: ({ size, ...props }: any) => <span data-testid="check-icon" {...props}>✓</span>,
    Folder: ({ size, ...props }: any) => <span {...props}>📁</span>,
    FolderOpen: ({ size, ...props }: any) => <span {...props}>📂</span>,
    ChevronRight: ({ size, ...props }: any) => <span {...props}>→</span>,
    ChevronUp: ({ size, ...props }: any) => <span {...props}>↑</span>,
    Eye: ({ size, ...props }: any) => <span {...props}>👁</span>,
    EyeOff: ({ size, ...props }: any) => <span {...props}>🙈</span>,
    AlertCircle: ({ size, ...props }: any) => <span {...props}>⚠</span>,
  };
});

// Mock api module
vi.mock("../../api", () => ({
  registerProject: vi.fn(),
  browseDirectory: vi.fn().mockResolvedValue({
    currentPath: "/home/user",
    parentPath: "/home",
    entries: [],
  }),
}));

import { registerProject } from "../../api";

const mockRegisterProject = vi.mocked(registerProject);

describe("SetupWizardModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with welcome message", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Welcome to kb")).toBeDefined();
    expect(screen.getByText(/Let's set up your first project/)).toBeDefined();
  });

  it("has DirectoryPicker for path selection", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    // DirectoryPicker renders an input and a Browse button
    expect(screen.getByPlaceholderText("/path/to/your/project")).toBeDefined();
    expect(screen.getByText("Browse")).toBeDefined();
  });

  it("auto-populates project name from selected directory path", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    // Type a path in the DirectoryPicker input
    const pathInput = screen.getByPlaceholderText("/path/to/your/project");
    fireEvent.change(pathInput, { target: { value: "/home/user/my-awesome-project" } });

    const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
    expect(nameInput.value).toBe("my-awesome-project");
  });

  it("register button is disabled when required fields are empty", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const registerBtn = screen.getByText("Register Project").closest("button")!;
    expect(registerBtn.disabled).toBe(true);
  });

  it("register button is enabled when path and name are provided", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
      target: { value: "/home/user/project" },
    });
    // Name auto-populates; ensure it's not empty
    const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
    expect(nameInput.value).toBe("project");

    const registerBtn = screen.getByText("Register Project").closest("button")!;
    expect(registerBtn.disabled).toBe(false);
  });

  it("shows error state on registration failure", async () => {
    mockRegisterProject.mockRejectedValueOnce(new Error("Path does not exist"));

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
      target: { value: "/bad/path" },
    });
    fireEvent.change(screen.getByPlaceholderText("my-project"), {
      target: { value: "test-project" },
    });

    fireEvent.click(screen.getByText("Register Project"));

    await waitFor(() => {
      expect(screen.getByText("Path does not exist")).toBeDefined();
    });
  });

  it("shows completion state after successful registration", async () => {
    const mockProject = {
      id: "proj_123",
      name: "test-project",
      path: "/home/user/project",
      status: "active" as const,
      isolationMode: "in-process" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockRegisterProject.mockResolvedValueOnce(mockProject);

    const onProjectRegistered = vi.fn();
    render(
      <SetupWizardModal
        onProjectRegistered={onProjectRegistered}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
      target: { value: "/home/user/project" },
    });
    fireEvent.change(screen.getByPlaceholderText("my-project"), {
      target: { value: "test-project" },
    });

    fireEvent.click(screen.getByText("Register Project"));

    await waitFor(() => {
      expect(screen.getByText("All Set!")).toBeDefined();
      expect(screen.getByText("Get Started")).toBeDefined();
    });

    expect(onProjectRegistered).toHaveBeenCalledWith(mockProject);
  });

  it("close button calls onClose", () => {
    const onClose = vi.fn();
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByLabelText("Close wizard"));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders isolation mode radio cards", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("In-Process")).toBeDefined();
    expect(screen.getByText("Child-Process")).toBeDefined();
    expect(screen.getByText("Recommended")).toBeDefined();
  });

  it("can switch isolation mode", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    // Initially in-process is selected
    const inProcessRadio = screen.getByDisplayValue("in-process") as HTMLInputElement;
    const childProcessRadio = screen.getByDisplayValue("child-process") as HTMLInputElement;

    expect(inProcessRadio.checked).toBe(true);
    expect(childProcessRadio.checked).toBe(false);

    fireEvent.click(childProcessRadio);
    expect(childProcessRadio.checked).toBe(true);
  });
});
