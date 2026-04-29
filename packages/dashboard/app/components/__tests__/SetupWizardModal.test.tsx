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

vi.mock("../../auth", () => ({
  getAuthToken: vi.fn(() => undefined),
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
}));

import { registerProject } from "../../api";
import { getAuthToken, setAuthToken, clearAuthToken } from "../../auth";
import { useNodes } from "../../hooks/useNodes";

const mockRegisterProject = vi.mocked(registerProject);
const mockGetAuthToken = vi.mocked(getAuthToken);
const mockSetAuthToken = vi.mocked(setAuthToken);
const mockClearAuthToken = vi.mocked(clearAuthToken);
const mockUseNodes = vi.mocked(useNodes);

describe("SetupWizardModal", () => {
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthToken.mockReturnValue(undefined);
    reloadMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload: reloadMock });
  });

  it("renders with welcome message", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Welcome to Fusion")).toBeDefined();
    expect(screen.getByText("Project Name")).toBeDefined();
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

  it("existing-directory submit payload is unchanged", async () => {
    mockRegisterProject.mockResolvedValueOnce({
      id: "proj_existing",
      name: "existing-project",
      path: "/existing/project",
      status: "active",
      isolationMode: "in-process",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
      target: { value: "/existing/project" },
    });

    fireEvent.click(screen.getByText("Register Project"));

    await waitFor(() => {
      expect(mockRegisterProject).toHaveBeenCalledWith({
        name: "project",
        path: "/existing/project",
        isolationMode: "in-process",
        nodeId: undefined,
        cloneUrl: undefined,
      });
    });
  });

  it("clone mode renders repository url input and destination picker", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.click(screen.getByLabelText("Clone Git Repository"));

    expect(screen.getByLabelText("Repository URL")).toBeDefined();
    expect(screen.getByPlaceholderText("/path/for/new-clone")).toBeDefined();
    expect(screen.getByText(/Fusion will run git clone into the destination directory/)).toBeDefined();
  });

  it("clone mode submit sends cloneUrl payload", async () => {
    mockRegisterProject.mockResolvedValueOnce({
      id: "proj_clone",
      name: "fusion",
      path: "/tmp/fusion",
      status: "active",
      isolationMode: "in-process",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.click(screen.getByLabelText("Clone Git Repository"));
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/runfusion/fusion.git" },
    });
    fireEvent.change(screen.getByPlaceholderText("/path/for/new-clone"), {
      target: { value: "/tmp/fusion" },
    });

    fireEvent.click(screen.getByText("Register Project"));

    await waitFor(() => {
      expect(mockRegisterProject).toHaveBeenCalledWith({
        name: "fusion",
        path: "/tmp/fusion",
        isolationMode: "in-process",
        nodeId: undefined,
        cloneUrl: "https://github.com/runfusion/fusion.git",
      });
    });
  });

  it("register button disabled/enabled logic is mode-aware", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const registerBtn = screen.getByText("Register Project").closest("button")!;
    expect(registerBtn.disabled).toBe(true);

    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.click(screen.getByLabelText("Clone Git Repository"));
    fireEvent.change(screen.getByPlaceholderText("/path/for/new-clone"), {
      target: { value: "/tmp/repo" },
    });
    expect(registerBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/runfusion/fusion.git" },
    });
    expect(registerBtn.disabled).toBe(false);

    fireEvent.click(screen.getByLabelText("Use Existing Directory"));
    expect(registerBtn.disabled).toBe(false);
  });

  it("auto-suggested name updates until manually edited", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.click(screen.getByLabelText("Clone Git Repository"));

    const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
    const destinationInput = screen.getByPlaceholderText("/path/for/new-clone");

    fireEvent.change(destinationInput, { target: { value: "/tmp/fusion" } });
    expect(nameInput.value).toBe("fusion");

    fireEvent.change(destinationInput, { target: { value: "/tmp/fusion-next" } });
    expect(nameInput.value).toBe("fusion-next");

    fireEvent.change(nameInput, { target: { value: "custom-name" } });
    fireEvent.change(destinationInput, { target: { value: "/tmp/fusion-final" } });
    expect(nameInput.value).toBe("custom-name");
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
      expect(mockRegisterProject).toHaveBeenCalled();
    });
    expect(await screen.findByText("Path does not exist")).toBeDefined();
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
      expect(mockRegisterProject).toHaveBeenCalled();
    });
    expect(await screen.findByText("All Set!")).toBeDefined();
    expect(await screen.findByText("Get Started")).toBeDefined();

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

  it("shows a set token action when no browser auth token is stored", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Advanced settings"));

    expect(screen.getByLabelText("Browser Auth Token")).toBeDefined();
    expect(screen.getByRole("button", { name: "Set token" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Reset token" })).toBeNull();
  });

  it("stores a browser auth token and reloads the page", () => {
    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.change(screen.getByLabelText("Browser Auth Token"), {
      target: { value: "daemon-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set token" }));

    expect(mockSetAuthToken).toHaveBeenCalledWith("daemon-token");
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("shows reset when a browser auth token is already stored", () => {
    mockGetAuthToken.mockReturnValue("stored-token");

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Advanced settings"));

    expect(screen.getByRole("button", { name: "Update token" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Reset token" })).toBeDefined();
  });

  it("resets the stored browser auth token and reloads the page", () => {
    mockGetAuthToken.mockReturnValue("stored-token");

    render(
      <SetupWizardModal
        onProjectRegistered={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.click(screen.getByRole("button", { name: "Reset token" }));

    expect(mockClearAuthToken).toHaveBeenCalledTimes(1);
    expect(reloadMock).toHaveBeenCalledTimes(1);
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
