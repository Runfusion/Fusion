import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConnectNodeModal } from "../ConnectNodeModal";
import type { NodeInfo } from "../../api";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "node_test",
    name: "Test Node",
    type: "remote",
    status: "online",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ConnectNodeModal", () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onConnected: vi.fn(),
    addToast: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders when open", () => {
    render(<ConnectNodeModal {...defaultProps} />);

    expect(screen.getByLabelText("Connect to Node")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Build Server")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("192.168.1.100 or my-server.local")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(<ConnectNodeModal {...defaultProps} open={false} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("validates required name field", async () => {
    render(<ConnectNodeModal {...defaultProps} />);

    // Fill in host but not name
    fireEvent.change(screen.getByPlaceholderText("192.168.1.100 or my-server.local"), {
      target: { value: "192.168.1.100" },
    });

    // Try to submit
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Node name is required")).toBeInTheDocument();
    expect(defaultProps.addToast).not.toHaveBeenCalled();
  });

  it("validates required host field", () => {
    render(<ConnectNodeModal {...defaultProps} />);

    // Get the host input directly
    const hostInput = screen.getByPlaceholderText("192.168.1.100 or my-server.local");
    expect(hostInput).toBeInTheDocument();

    // Host should be empty initially
    expect(hostInput).toHaveValue("");
  });

  it("validates port range", async () => {
    render(<ConnectNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("Build Server"), {
      target: { value: "Test Node" },
    });
    fireEvent.change(screen.getByPlaceholderText("192.168.1.100 or my-server.local"), {
      target: { value: "192.168.1.100" },
    });

    // Port input is the number input (maxConcurrent is also a number input)
    const portInput = screen.getAllByRole("spinbutton")[0];
    fireEvent.change(portInput, {
      target: { value: "99999" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Port must be between 1 and 65535")).toBeInTheDocument();
  });

  it("shows URL preview as host and port are filled", () => {
    render(<ConnectNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("192.168.1.100 or my-server.local"), {
      target: { value: "192.168.1.100" },
    });

    expect(screen.getByText("http://192.168.1.100:3001")).toBeInTheDocument();
  });

  it("updates URL preview when port changes", () => {
    render(<ConnectNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("192.168.1.100 or my-server.local"), {
      target: { value: "my-server.local" },
    });

    // Port is the first number input
    const portInput = screen.getAllByRole("spinbutton")[0];
    fireEvent.change(portInput, { target: { value: "8080" } });

    expect(screen.getByText("http://my-server.local:8080")).toBeInTheDocument();
  });

  it("strips protocol from host in URL preview", () => {
    render(<ConnectNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("192.168.1.100 or my-server.local"), {
      target: { value: "https://my-server.local" },
    });

    expect(screen.getByText("http://my-server.local:3001")).toBeInTheDocument();
  });

  it("calls onConnected with registered node on success", async () => {
    const node = makeNode({ name: "Test Node", url: "http://192.168.1.100:3001" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(node),
    });

    render(<ConnectNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("Build Server"), {
      target: { value: "Test Node" },
    });
    fireEvent.change(screen.getByPlaceholderText("192.168.1.100 or my-server.local"), {
      target: { value: "192.168.1.100" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(defaultProps.onConnected).toHaveBeenCalledWith(node);
      expect(defaultProps.addToast).toHaveBeenCalledWith('Connected to "Test Node"', "success");
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  it("shows error toast on API failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "Invalid node configuration" }),
    });

    render(<ConnectNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("Build Server"), {
      target: { value: "Test Node" },
    });
    fireEvent.change(screen.getByPlaceholderText("192.168.1.100 or my-server.local"), {
      target: { value: "invalid-host" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(defaultProps.addToast).toHaveBeenCalledWith("Invalid node configuration", "error");
      expect(defaultProps.onClose).not.toHaveBeenCalled();
    });
  });

  it("resets form on close", () => {
    render(<ConnectNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("Build Server"), {
      target: { value: "Test Node" },
    });
    fireEvent.change(screen.getByPlaceholderText("192.168.1.100 or my-server.local"), {
      target: { value: "192.168.1.100" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("handles Escape key to close", () => {
    render(<ConnectNodeModal {...defaultProps} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("disables connect button when host is empty", () => {
    render(<ConnectNodeModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("Build Server"), {
      target: { value: "Test Node" },
    });

    const connectButton = screen.getByRole("button", { name: "Connect" });
    expect(connectButton).toBeDisabled();
  });

  it("uses custom onSubmit if provided", async () => {
    const customOnSubmit = vi.fn().mockResolvedValue(makeNode({ name: "Custom Node" }));
    const node = makeNode({ name: "Custom Node" });

    render(<ConnectNodeModal {...defaultProps} onSubmit={customOnSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("Build Server"), {
      target: { value: "Custom Node" },
    });
    fireEvent.change(screen.getByPlaceholderText("192.168.1.100 or my-server.local"), {
      target: { value: "192.168.1.100" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(customOnSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Custom Node",
          url: "http://192.168.1.100:3001",
        })
      );
      expect(defaultProps.onConnected).toHaveBeenCalledWith(node);
    });

    // fetch should not have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
