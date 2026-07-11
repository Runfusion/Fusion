import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SetupProjectForm } from "../SetupProjectForm";

// Mock lucide-react
vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    Check: ({ size, ...props }: any) => <span {...props}>✓</span>,
    Loader2: ({ size, ...props }: any) => <span data-testid="loader" {...props}>⟳</span>,
    Folder: ({ size, ...props }: any) => <span {...props}>📁</span>,
    FolderOpen: ({ size, ...props }: any) => <span {...props}>📂</span>,
    ChevronRight: ({ size, ...props }: any) => <span {...props}>→</span>,
    ChevronUp: ({ size, ...props }: any) => <span {...props}>↑</span>,
    Eye: ({ size, ...props }: any) => <span {...props}>👁</span>,
    EyeOff: ({ size, ...props }: any) => <span {...props}>🙈</span>,
    AlertCircle: ({ size, ...props }: any) => <span {...props}>⚠</span>,
  };
});

// Mock the API
vi.mock("../../api", () => ({
  browseDirectory: vi.fn(),
}));

// Mock projectDetection utilities
vi.mock("../utils/projectDetection", () => ({
  validateProjectPath: vi.fn((path: string) => ({
    valid: path.length > 0,
    error: path.length === 0 ? "Path is required" : undefined,
  })),
  validateProjectName: vi.fn((name: string) => ({
    valid: name.length > 0 && /^[a-zA-Z0-9_-]+$/.test(name),
    error:
      name.length === 0
        ? "Name is required"
        : !/^[a-zA-Z0-9_-]+$/.test(name)
          ? "Use letters, numbers, hyphens, and underscores only"
          : undefined,
  })),
  suggestProjectName: vi.fn((path: string) => {
    const parts = path.split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  }),
}));

// Mock DirectoryPicker
vi.mock("../DirectoryPicker", () => ({
  DirectoryPicker: ({
    value,
    onChange,
    nodeId,
    localNodeId,
    placeholder,
    selectCreatedDirectory,
  }: {
    value: string;
    onChange: (path: string) => void;
    nodeId?: string;
    localNodeId?: string;
    placeholder?: string;
    selectCreatedDirectory?: boolean;
  }) => (
    <div data-testid="directory-picker">
      <input
        data-testid="directory-picker-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {nodeId !== undefined && (
        <span data-testid="node-id">{nodeId}</span>
      )}
      {localNodeId !== undefined && (
        <span data-testid="local-node-id">{localNodeId}</span>
      )}
      {selectCreatedDirectory && (
        <span data-testid="select-created-directory">enabled</span>
      )}
    </div>
  ),
}));

import { browseDirectory } from "../../api";

const mockBrowseDirectory = vi.mocked(browseDirectory);

const localNode: import("../../api").NodeInfo = {
  id: "local-1",
  name: "Local Node",
  type: "local",
  status: "online" as const,
  maxConcurrent: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const remoteNode: import("../../api").NodeInfo = {
  id: "remote-1",
  name: "Remote Node",
  type: "remote",
  url: "http://localhost:3001",
  status: "online" as const,
  maxConcurrent: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("SetupProjectForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowseDirectory.mockResolvedValue({
      currentPath: "/home/user",
      parentPath: "/home",
      entries: [],
    });
  });

  it("renders without crashing", () => {
    render(<SetupProjectForm onSubmit={vi.fn()} />);
    expect(screen.getByText("Directory Path")).toBeDefined();
  });

  it("opts into selecting directories created during project registration", () => {
    render(<SetupProjectForm onSubmit={vi.fn()} />);
    expect(screen.getByTestId("select-created-directory").textContent).toBe("enabled");
  });

  it("has disabled submit button initially", () => {
    render(<SetupProjectForm onSubmit={vi.fn()} />);
    const submitBtn = screen.getByText("Create Project").closest("button") as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  describe("node selector", () => {
    it("renders node selector when nodes are provided", () => {
      render(
        <SetupProjectForm
          onSubmit={vi.fn()}
          nodes={[localNode, remoteNode]}
        />
      );

      expect(screen.getByText("Runtime Node")).toBeDefined();
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("");

      // FNXC:SetupWizard 2026-07-10-11:00: registered local-type node records must NOT
      // render as a second near-identical option next to the built-in "Local node" default.
      const options = Array.from(select.querySelectorAll("option"));
      const optionValues = options.map((opt) => opt.value);
      expect(optionValues).not.toContain("local-1");
      expect(optionValues).toContain("remote-1");
      expect(optionValues.filter((value) => value === "")).toHaveLength(1);
    });

    it("hides the node selector when only a local node is in the list", () => {
      render(<SetupProjectForm onSubmit={vi.fn()} nodes={[localNode]} />);
      // FNXC:SetupWizard 2026-07-10-11:00: a single-local-node install has no runtime
      // choice to make — the selector (and its duplicate local option) is gone entirely.
      expect(screen.queryByText("Runtime Node")).toBeNull();
      expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("uses selectedNodeId as default value", () => {
      render(
        <SetupProjectForm
          onSubmit={vi.fn()}
          nodes={[localNode, remoteNode]}
          selectedNodeId="remote-1"
        />
      );

      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("remote-1");
    });

    it("passes nodeId and localNodeId to DirectoryPicker", () => {
      render(
        <SetupProjectForm
          onSubmit={vi.fn()}
          nodes={[localNode, remoteNode]}
          selectedNodeId="remote-1"
        />
      );

      // Select the remote node
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "remote-1" } });

      const nodeIdSpan = screen.getByTestId("node-id");
      const localNodeIdSpan = screen.getByTestId("local-node-id");

      expect(nodeIdSpan.textContent).toBe("remote-1");
      expect(localNodeIdSpan.textContent).toBe("local-1");
    });

    it("passes undefined nodeId when local node is selected", () => {
      render(
        <SetupProjectForm
          onSubmit={vi.fn()}
          nodes={[localNode, remoteNode]}
          // No selectedNodeId means local node (empty string)
        />
      );

      // Local node is selected by default (empty value)
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("");

      // nodeId should be undefined when local node is selected
      const nodeIdSpan = screen.queryByTestId("node-id");
      expect(nodeIdSpan).toBeNull();
    });
  });

  describe("form submission", () => {
    it("submits with nodeId when remote node is selected", async () => {
      const onSubmit = vi.fn();
      render(
        <SetupProjectForm
          onSubmit={onSubmit}
          nodes={[localNode, remoteNode]}
        />
      );

      // Select remote node
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "remote-1" } });

      // Fill path
      const pathInput = screen.getByTestId("directory-picker-input");
      fireEvent.change(pathInput, { target: { value: "/home/user/project" } });

      // Fill name
      const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "my-project" } });

      // Submit
      fireEvent.click(screen.getByText("Create Project"));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "my-project",
            path: "/home/user/project",
            isolationMode: "in-process",
            nodeId: "remote-1",
          })
        );
      });
    });

    it("submits with undefined nodeId when local node is selected", async () => {
      const onSubmit = vi.fn();
      render(
        <SetupProjectForm
          onSubmit={onSubmit}
          nodes={[localNode, remoteNode]}
        />
      );

      // Local node is selected by default (empty value)
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("");

      // Fill path
      const pathInput = screen.getByTestId("directory-picker-input");
      fireEvent.change(pathInput, { target: { value: "/home/user/project" } });

      // Fill name
      const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "my-project" } });

      // Submit
      fireEvent.click(screen.getByText("Create Project"));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "my-project",
            path: "/home/user/project",
            isolationMode: "in-process",
            nodeId: undefined,
          })
        );
      });
    });

    it("submits without nodeId field when no nodes provided", async () => {
      const onSubmit = vi.fn();
      render(
        <SetupProjectForm
          onSubmit={onSubmit}
          nodes={[]}
        />
      );

      // Fill path
      const pathInput = screen.getByTestId("directory-picker-input");
      fireEvent.change(pathInput, { target: { value: "/home/user/project" } });

      // Fill name
      const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "my-project" } });

      // Submit
      fireEvent.click(screen.getByText("Create Project"));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "my-project",
            path: "/home/user/project",
            isolationMode: "in-process",
            nodeId: undefined,
          })
        );
      });
    });
  });

  describe("validation", () => {
    it("enables submit when both path and name are valid", () => {
      render(<SetupProjectForm onSubmit={vi.fn()} nodes={[localNode]} />);

      const pathInput = screen.getByTestId("directory-picker-input");
      fireEvent.change(pathInput, { target: { value: "/valid/path" } });

      const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "valid-name" } });

      const submitBtn = screen.getByText("Create Project").closest("button") as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(false);
    });
  });
});
