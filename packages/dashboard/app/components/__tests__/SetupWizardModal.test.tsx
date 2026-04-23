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

// Mock useNodes hook
vi.mock("../../hooks/useNodes", () => ({
  useNodes: vi.fn(() => ({
    nodes: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

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
import { useNodes } from "../../hooks/useNodes";

const mockRegisterProject = vi.mocked(registerProject);
const mockUseNodes = vi.mocked(useNodes);

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

    expect(screen.getByText("Welcome to Fusion")).toBeDefined();
    expect(screen.getByText(/Let's set up your first project/)).toBeDefined();
    expect(screen.getByLabelText("Fusion logo")).toBeDefined();
    expect(screen.getByText("Advanced settings")).toBeDefined();
    expect(screen.getByRole("link", { name: "Need help?" })).toHaveAttribute(
      "href",
      "https://github.com/runfusion/fusion/discussions"
    );
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

  it("reveals advanced settings on demand", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByText("Runtime Node")).toBeNull();
    expect(screen.queryByText("In-Process")).toBeNull();

    fireEvent.click(screen.getByText("Advanced settings"));

    expect(screen.getByText("Runtime Node")).toBeDefined();
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

    fireEvent.click(screen.getByText("Advanced settings"));

    // Initially in-process is selected
    const inProcessRadio = screen.getByDisplayValue("in-process") as HTMLInputElement;
    const childProcessRadio = screen.getByDisplayValue("child-process") as HTMLInputElement;

    expect(inProcessRadio.checked).toBe(true);
    expect(childProcessRadio.checked).toBe(false);

    fireEvent.click(childProcessRadio);
    expect(childProcessRadio.checked).toBe(true);
  });

  describe("node selector", () => {
    const localNode = {
      id: "local-1",
      name: "Local Node",
      type: "local" as const,
      status: "online" as const,
      maxConcurrent: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const remoteNode = {
      id: "remote-1",
      name: "Remote Node",
      type: "remote" as const,
      url: "http://localhost:3001",
      status: "online" as const,
      maxConcurrent: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it("node selector is present when nodes load", () => {
      mockUseNodes.mockImplementation(() => ({
        nodes: [localNode, remoteNode],
        loading: false,
        error: null,
        refresh: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        unregister: vi.fn(),
        healthCheck: vi.fn(),
      }));

      render(
        <SetupWizardModal
          onProjectRegistered={vi.fn()}
          onClose={vi.fn()}
        />
      );

      fireEvent.click(screen.getByText("Advanced settings"));

      expect(screen.getByText("Runtime Node")).toBeDefined();
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("");

      // Check options directly by querying the select's children
      const options = Array.from(select.querySelectorAll("option"));
      const optionValues = options.map((opt) => opt.value);
      const optionLabels = options.map((opt) => opt.label);
      expect(optionValues).toContain("local-1");
      expect(optionValues).toContain("remote-1");
    });

    it("registration includes selected nodeId", async () => {
      mockUseNodes.mockImplementation(() => ({
        nodes: [localNode, remoteNode],
        loading: false,
        error: null,
        refresh: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        unregister: vi.fn(),
        healthCheck: vi.fn(),
      }));

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

      render(
        <SetupWizardModal
          onProjectRegistered={vi.fn()}
          onClose={vi.fn()}
        />
      );

      fireEvent.click(screen.getByText("Advanced settings"));

      // Select the remote node
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "remote-1" } });

      // Fill path and name
      fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
        target: { value: "/home/user/project" },
      });
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "test-project" },
      });

      // Register
      fireEvent.click(screen.getByText("Register Project"));

      await waitFor(() => {
        expect(mockRegisterProject).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "test-project",
            path: "/home/user/project",
            isolationMode: "in-process",
            nodeId: "remote-1",
          })
        );
      });
    });

    it("registration includes undefined nodeId when local node selected", async () => {
      mockUseNodes.mockImplementation(() => ({
        nodes: [localNode],
        loading: false,
        error: null,
        refresh: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        unregister: vi.fn(),
        healthCheck: vi.fn(),
      }));

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

      render(
        <SetupWizardModal
          onProjectRegistered={vi.fn()}
          onClose={vi.fn()}
        />
      );

      fireEvent.click(screen.getByText("Advanced settings"));

      // Local node is selected by default (empty value)
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("");

      // Fill path and name
      fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
        target: { value: "/home/user/project" },
      });
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "test-project" },
      });

      // Register
      fireEvent.click(screen.getByText("Register Project"));

      await waitFor(() => {
        expect(mockRegisterProject).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "test-project",
            path: "/home/user/project",
            isolationMode: "in-process",
            nodeId: undefined,
          })
        );
      });
    });
  });
});
