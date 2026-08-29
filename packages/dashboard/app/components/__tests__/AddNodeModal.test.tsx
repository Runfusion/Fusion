import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddNodeModal } from "../AddNodeModal";
import { assertModalGeometryRecoveryAndSheetContracts, assertRenderedModalTouchGeometry } from "./floatingWindowMigration.test-helpers";
import { expectStableTyping } from "./typingStability.test-helpers";

describe("AddNodeModal", () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    onDiscoverRemoteProjects: vi.fn().mockResolvedValue({ projects: [] }),
    addToast: vi.fn(),
    projects: [
      {
        id: "proj-1",
        name: "Project One",
        path: "/workspace/project-one",
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "proj-2",
        name: "Project Two",
        path: "/workspace/project-two",
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });


  /*
  FNXC:TypingStability 2026-07-26-22:15:
  Per-character typing guard. The FN-8606 floating-window migration made Planning Mode and Settings
  untypable and no test noticed, because field coverage here uses fireEvent.change, which never needs
  the input to stay mounted. This asserts the field keeps its DOM node, value, and focus while typed.
  */
  it("keeps the node name field mounted and focused while typing", async () => {
    render(<AddNodeModal {...defaultProps} />);
    const field = screen.getByPlaceholderText("Build Machine") as HTMLInputElement;
    await expectStableTyping(field, "build-01", () => screen.getByPlaceholderText("Build Machine"));
  });

  it("renders when isOpen is true", () => {
    render(<AddNodeModal {...defaultProps} />);

    expect(screen.getByLabelText("Add Node")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Build Machine")).toBeInTheDocument();
  });

  it("does not render when isOpen is false", () => {
    render(<AddNodeModal {...defaultProps} isOpen={false} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("validates required name field", async () => {
    render(<AddNodeModal {...defaultProps} />);

    // Try to submit without filling name
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(defaultProps.addToast).not.toHaveBeenCalled();
  });

  it("validates URL required when type is remote", async () => {
    render(<AddNodeModal {...defaultProps} />);

    // Switch to remote type
    fireEvent.click(screen.getByRole("button", { name: "Remote" }));

    // Fill name but not URL
    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Remote Node" },
    });

    // Try to submit
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    expect(await screen.findByText("URL is required for remote nodes")).toBeInTheDocument();
    expect(defaultProps.addToast).not.toHaveBeenCalled();
  });

  it("validates max concurrent range", async () => {
    render(<AddNodeModal {...defaultProps} />);

    // Fill name
    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Test Node" },
    });

    const maxConcurrentInput = screen.getAllByRole("spinbutton")[0];
    fireEvent.change(maxConcurrentInput, {
      target: { value: "15" },
    });

    // Try to submit
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    expect(await screen.findByText("Concurrency must be between 1 and 10")).toBeInTheDocument();
  });

  it("calls onSubmit with correct input on valid submission", async () => {
    render(<AddNodeModal {...defaultProps} />);

    // Fill form
    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Test Node" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    await waitFor(() => {
      expect(defaultProps.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        name: "Test Node",
        type: "local",
        url: undefined,
        apiKey: undefined,
        maxConcurrent: 2,
        projectMappings: [],
      }));
      expect(defaultProps.addToast).toHaveBeenCalledWith('Node "Test Node" registered', "success");
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  it("shows error toast on submission failure", async () => {
    const errorOnSubmit = vi.fn().mockRejectedValue(new Error("Network error"));
    render(<AddNodeModal {...defaultProps} onSubmit={errorOnSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Test Node" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    await waitFor(() => {
      expect(defaultProps.addToast).toHaveBeenCalledWith("Network error", "error");
      expect(defaultProps.onClose).not.toHaveBeenCalled();
    });
  });

  it("resets form on close", () => {
    render(<AddNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Test Node" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("handles Escape key to close", () => {
    render(<AddNodeModal {...defaultProps} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("toggles between local and remote type", async () => {
    render(<AddNodeModal {...defaultProps} />);

    // Initially local is selected
    const localBtn = screen.getByRole("button", { name: "Local" });
    const remoteBtn = screen.getByRole("button", { name: "Remote" });

    expect(localBtn).toHaveAttribute("aria-pressed", "true");
    expect(remoteBtn).toHaveAttribute("aria-pressed", "false");

    // Remote fields container should not be rendered
    expect(screen.queryByTestId("remote-fields-container")).not.toBeInTheDocument();

    // Switch to remote
    fireEvent.click(remoteBtn);

    expect(localBtn).toHaveAttribute("aria-pressed", "false");
    expect(remoteBtn).toHaveAttribute("aria-pressed", "true");

    // Remote fields container should be visible
    const remoteFieldsContainer = screen.getByTestId("remote-fields-container");
    expect(remoteFieldsContainer).toBeInTheDocument();

    // URL and API Key fields should be visible
    expect(screen.getByPlaceholderText("https://node.example.com")).toBeInTheDocument();

    // Switch back to local
    fireEvent.click(localBtn);

    expect(localBtn).toHaveAttribute("aria-pressed", "true");
    expect(remoteBtn).toHaveAttribute("aria-pressed", "false");

    // Remote fields container should be removed again
    expect(screen.queryByTestId("remote-fields-container")).not.toBeInTheDocument();
  });

  it("submit button is disabled while submitting", async () => {
    let resolveSubmit: () => void;
    const slowSubmit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        })
    );

    render(<AddNodeModal {...defaultProps} onSubmit={slowSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Test Node" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    // Button should show "Adding..." and be disabled
    expect(screen.getByRole("button", { name: "Adding..." })).toBeDisabled();

    // Resolve the submit
    resolveSubmit!();
  });

  it("clicking overlay closes modal", () => {
    render(<AddNodeModal {...defaultProps} />);

    // Click on the overlay (not the modal itself)
    fireEvent.pointerDown(document.body);

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("shows hint text for max concurrent field", () => {
    render(<AddNodeModal {...defaultProps} />);

    expect(screen.getByText("Max simultaneous task agents (1–10)")).toBeInTheDocument();
  });

  it("shows description text", () => {
    render(<AddNodeModal {...defaultProps} />);

    expect(
      screen.getByText("Register an existing Fusion node by providing its connection details and concurrency settings.")
    ).toBeInTheDocument();
  });

  it("submits remote node with URL and API key after discovery", async () => {
    const onDiscoverRemoteProjects = vi.fn().mockResolvedValue({
      projects: [{
        id: "remote-1",
        name: "Project One",
        path: "/srv/project-one",
        status: "active",
        isolationMode: "in-process",
      }],
    });
    render(<AddNodeModal {...defaultProps} onDiscoverRemoteProjects={onDiscoverRemoteProjects} />);

    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Remote Node" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remote" }));
    fireEvent.change(screen.getByPlaceholderText("https://node.example.com"), {
      target: { value: "https://node.example.com" },
    });
    fireEvent.change(screen.getByLabelText("API Key Mode"), {
      target: { value: "provide" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter node API key"), {
      target: { value: "secret-key" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Discover Remote Projects" }));

    await waitFor(() => {
      expect(onDiscoverRemoteProjects).toHaveBeenCalledWith({
        url: "https://node.example.com",
        apiKey: "secret-key",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    await waitFor(() => {
      expect(defaultProps.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        name: "Remote Node",
        type: "remote",
        url: "https://node.example.com",
        apiKey: "secret-key",
        maxConcurrent: 2,
        projectMappings: [],
      }));
    });
  });

  it("blocks remote submit until discovery succeeds", async () => {
    render(<AddNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Remote Node" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remote" }));
    fireEvent.change(screen.getByPlaceholderText("https://node.example.com"), {
      target: { value: "https://node.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    expect(await screen.findByText("Discover remote projects before adding this node.")).toBeInTheDocument();
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it("validates selected project path is required", async () => {
    render(<AddNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Node With Project" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Project One" }));
    fireEvent.change(screen.getByDisplayValue("/workspace/project-one"), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    expect(await screen.findByText("Path is required")).toBeInTheDocument();
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it("validates selected project path is absolute", async () => {
    render(<AddNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Node With Project" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Project One" }));
    fireEvent.change(screen.getByDisplayValue("/workspace/project-one"), {
      target: { value: "relative/path" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    expect(await screen.findByText("Path must be absolute")).toBeInTheDocument();
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it("prefills path from exact-name discovery match", async () => {
    const onDiscoverRemoteProjects = vi.fn().mockResolvedValue({
      projects: [{
        id: "remote-1",
        name: "Project One",
        path: "/remote/project-one",
        status: "active",
        isolationMode: "in-process",
      }],
    });
    render(<AddNodeModal {...defaultProps} onDiscoverRemoteProjects={onDiscoverRemoteProjects} />);

    fireEvent.click(screen.getByRole("button", { name: "Remote" }));
    fireEvent.change(screen.getByPlaceholderText("https://node.example.com"), {
      target: { value: "https://node.example.com" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Discover Remote Projects" }));
    await waitFor(() => {
      expect(onDiscoverRemoteProjects).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Project One" }));
    expect(screen.getByDisplayValue("/remote/project-one")).toBeInTheDocument();
  });

  it("leaves ambiguous name matches unresolved", async () => {
    const onDiscoverRemoteProjects = vi.fn().mockResolvedValue({
      projects: [
        {
          id: "remote-1",
          name: "Project One",
          path: "/remote/project-one-a",
          status: "active",
          isolationMode: "in-process",
        },
        {
          id: "remote-2",
          name: "Project One",
          path: "/remote/project-one-b",
          status: "paused",
          isolationMode: "child-process",
        },
      ],
    });
    render(<AddNodeModal {...defaultProps} onDiscoverRemoteProjects={onDiscoverRemoteProjects} />);

    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Remote Node" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remote" }));
    fireEvent.change(screen.getByPlaceholderText("https://node.example.com"), {
      target: { value: "https://node.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover Remote Projects" }));
    await waitFor(() => {
      expect(onDiscoverRemoteProjects).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Project One" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    expect(await screen.findByText("Path is required")).toBeInTheDocument();
  });

  it("shows discovery error inline", async () => {
    const onDiscoverRemoteProjects = vi.fn().mockRejectedValue(new Error("upstream unavailable"));
    render(<AddNodeModal {...defaultProps} onDiscoverRemoteProjects={onDiscoverRemoteProjects} />);

    fireEvent.click(screen.getByRole("button", { name: "Remote" }));
    fireEvent.change(screen.getByPlaceholderText("https://node.example.com"), {
      target: { value: "https://node.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover Remote Projects" }));

    expect(await screen.findByText("upstream unavailable")).toBeInTheDocument();
  });

  it("shows explicit zero-project discovery state", async () => {
    render(<AddNodeModal {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Remote" }));
    fireEvent.change(screen.getByPlaceholderText("https://node.example.com"), {
      target: { value: "https://node.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover Remote Projects" }));

    expect(await screen.findByText("No projects discovered on remote node.")).toBeInTheDocument();
  });

  it("submits selected project mappings", async () => {
    render(<AddNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Node With Project" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Project One" }));
    fireEvent.change(screen.getByDisplayValue("/workspace/project-one"), {
      target: { value: "/mnt/node/project-one" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    await waitFor(() => {
      expect(defaultProps.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        name: "Node With Project",
        projectMappings: [{ projectId: "proj-1", path: "/mnt/node/project-one" }],
      }));
    });
  });

  it("removes path input when project is deselected", () => {
    render(<AddNodeModal {...defaultProps} />);

    const checkbox = screen.getByRole("checkbox", { name: "Project One" });
    fireEvent.click(checkbox);
    expect(screen.getByDisplayValue("/workspace/project-one")).toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(screen.queryByDisplayValue("/workspace/project-one")).not.toBeInTheDocument();
  });
});

describe("AddNodeModal floating geometry", () => {
  it("uses its production header for touch drag and resize", () => {
    render(<AddNodeModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} onDiscoverRemoteProjects={vi.fn()} addToast={vi.fn()} projects={[]} />);
    assertRenderedModalTouchGeometry("add-node", screen.getByTestId("floating-window-add-node").querySelector(".modal-header") as HTMLElement);
    assertModalGeometryRecoveryAndSheetContracts("add-node", () => render(<AddNodeModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} onDiscoverRemoteProjects={vi.fn()} addToast={vi.fn()} projects={[]} />));
  });
});
