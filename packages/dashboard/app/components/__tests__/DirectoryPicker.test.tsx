import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DirectoryPicker } from "../DirectoryPicker";

// Mock lucide-react
vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    Folder: ({ size, ...props }: any) => <span data-testid="folder-icon" {...props}>📁</span>,
    FolderOpen: ({ size, ...props }: any) => <span data-testid="folder-open-icon" {...props}>📂</span>,
    ChevronRight: ({ size, ...props }: any) => <span {...props}>→</span>,
    ChevronUp: ({ size, ...props }: any) => <span {...props}>↑</span>,
    Loader2: ({ size, ...props }: any) => <span data-testid="loader" {...props}>⟳</span>,
    Eye: ({ size, ...props }: any) => <span {...props}>👁</span>,
    EyeOff: ({ size, ...props }: any) => <span {...props}>🙈</span>,
    AlertCircle: ({ size, ...props }: any) => <span {...props}>⚠</span>,
  };
});

// Mock the API
vi.mock("../../api", () => ({
  browseDirectory: vi.fn(),
}));

import { browseDirectory } from "../../api";

const mockBrowseDirectory = vi.mocked(browseDirectory);

describe("DirectoryPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowseDirectory.mockResolvedValue({
      currentPath: "/home/user",
      parentPath: "/home",
      entries: [
        { name: "projects", path: "/home/user/projects", hasChildren: true },
        { name: "Documents", path: "/home/user/Documents", hasChildren: true },
        { name: "empty-dir", path: "/home/user/empty-dir", hasChildren: false },
      ],
    });
  });

  it("renders with value and placeholder", () => {
    render(
      <DirectoryPicker
        value="/some/path"
        onChange={vi.fn()}
        placeholder="Select a directory"
      />
    );

    const input = screen.getByPlaceholderText("Select a directory") as HTMLInputElement;
    expect(input.value).toBe("/some/path");
    expect(screen.getByText("Browse")).toBeDefined();
  });

  it("calls onChange when typing in the input", () => {
    const onChange = vi.fn();
    render(<DirectoryPicker value="" onChange={onChange} />);

    const input = screen.getByPlaceholderText("/path/to/your/project");
    fireEvent.change(input, { target: { value: "/new/path" } });

    expect(onChange).toHaveBeenCalledWith("/new/path");
  });

  it("opens browser panel and fetches entries on Browse click", async () => {
    render(<DirectoryPicker value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByText("Browse"));

    await waitFor(() => {
      expect(mockBrowseDirectory).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByText("projects")).toBeDefined();
      expect(screen.getByText("Documents")).toBeDefined();
      expect(screen.getByText("empty-dir")).toBeDefined();
    });
  });

  it("navigates into a directory on click", async () => {
    render(<DirectoryPicker value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByText("Browse"));

    await waitFor(() => {
      expect(screen.getByText("projects")).toBeDefined();
    });

    // Now click on "projects" to navigate into it
    mockBrowseDirectory.mockResolvedValueOnce({
      currentPath: "/home/user/projects",
      parentPath: "/home/user",
      entries: [
        { name: "my-app", path: "/home/user/projects/my-app", hasChildren: true },
      ],
    });

    fireEvent.click(screen.getByText("projects"));

    await waitFor(() => {
      expect(mockBrowseDirectory).toHaveBeenCalledWith("/home/user/projects", false, undefined, undefined);
    });
  });

  it("calls onChange when Select is clicked", async () => {
    const onChange = vi.fn();
    render(<DirectoryPicker value="" onChange={onChange} />);

    fireEvent.click(screen.getByText("Browse"));

    await waitFor(() => {
      expect(screen.getByText("projects")).toBeDefined();
    });

    const selectButton = screen.getByRole("button", { name: "Select" });
    expect(selectButton.classList.contains("btn")).toBe(true);
    expect(selectButton.classList.contains("btn-primary")).toBe(true);
    expect(selectButton.classList.contains("directory-picker-select-btn")).toBe(true);

    fireEvent.click(selectButton);
    expect(onChange).toHaveBeenCalledWith("/home/user");
  });

  it("shows loading state while fetching", async () => {
    let resolvePromise: (val: any) => void;
    mockBrowseDirectory.mockImplementation(
      () => new Promise((resolve) => { resolvePromise = resolve; })
    );

    render(<DirectoryPicker value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Browse"));

    await waitFor(() => {
      expect(screen.getByText("Loading…")).toBeDefined();
    });

    // Resolve to clean up
    resolvePromise!({
      currentPath: "/home/user",
      parentPath: "/home",
      entries: [],
    });

    await waitFor(() => {
      expect(screen.getByText("No subdirectories")).toBeDefined();
    });
  });

  it("shows error state on fetch failure", async () => {
    mockBrowseDirectory.mockRejectedValueOnce(new Error("Permission denied"));

    render(<DirectoryPicker value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Browse"));

    await waitFor(() => {
      expect(screen.getByText("Permission denied")).toBeDefined();
    });
  });

  it("closes browser on second Browse click", async () => {
    render(<DirectoryPicker value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByText("Browse"));
    await waitFor(() => {
      expect(screen.getByText("projects")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Browse"));
    expect(screen.queryByText("projects")).toBeNull();
  });

  it("browses remote node when nodeId is provided", async () => {
    render(
      <DirectoryPicker
        value=""
        onChange={vi.fn()}
        nodeId="remote-1"
        localNodeId="local-1"
      />
    );

    fireEvent.click(screen.getByText("Browse"));

    await waitFor(() => {
      expect(mockBrowseDirectory).toHaveBeenCalledWith(undefined, false, "remote-1", "local-1");
    });
  });

  it("falls back to local browsing when nodeId matches localNodeId", async () => {
    render(
      <DirectoryPicker
        value=""
        onChange={vi.fn()}
        nodeId="local-1"
        localNodeId="local-1"
      />
    );

    fireEvent.click(screen.getByText("Browse"));

    await waitFor(() => {
      expect(mockBrowseDirectory).toHaveBeenCalledWith(undefined, false, "local-1", "local-1");
    });
  });

  it("navigating directories passes nodeId", async () => {
    render(
      <DirectoryPicker
        value=""
        onChange={vi.fn()}
        nodeId="remote-1"
        localNodeId="local-1"
      />
    );

    fireEvent.click(screen.getByText("Browse"));

    await waitFor(() => {
      expect(screen.getByText("projects")).toBeDefined();
    });

    // Navigate into projects directory
    mockBrowseDirectory.mockResolvedValueOnce({
      currentPath: "/home/user/projects",
      parentPath: "/home/user",
      entries: [
        { name: "my-app", path: "/home/user/projects/my-app", hasChildren: true },
      ],
    });

    fireEvent.click(screen.getByText("projects"));

    await waitFor(() => {
      expect(mockBrowseDirectory).toHaveBeenCalledWith("/home/user/projects", false, "remote-1", "local-1");
    });
  });
});
