import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddNodeModal } from "../AddNodeModal";
import type { NodeInfo } from "../../api";

describe("AddNodeModal", () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
    const overlay = screen.getByRole("dialog").parentElement!;
    fireEvent.click(overlay);

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("shows hint text for max concurrent field", () => {
    render(<AddNodeModal {...defaultProps} />);

    expect(screen.getByText("Max simultaneous task agents (1–10)")).toBeInTheDocument();
  });

  it("shows description text", () => {
    render(<AddNodeModal {...defaultProps} />);

    expect(
      screen.getByText("Provision a managed Docker node with guided defaults, then expand Advanced for host/TLS/env/mount overrides.")
    ).toBeInTheDocument();
  });

  it("submits remote node with URL and API key", async () => {
    render(<AddNodeModal {...defaultProps} />);

    // Fill name
    fireEvent.change(screen.getByPlaceholderText("Build Machine"), {
      target: { value: "Remote Node" },
    });

    // Switch to remote
    fireEvent.click(screen.getByRole("button", { name: "Remote" }));

    // Fill URL and API key
    fireEvent.change(screen.getByPlaceholderText("https://node.example.com"), {
      target: { value: "https://node.example.com" },
    });
    fireEvent.change(screen.getByLabelText("API Key Mode"), {
      target: { value: "provide" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter node API key"), {
      target: { value: "secret-key" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));

    await waitFor(() => {
      expect(defaultProps.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        name: "Remote Node",
        type: "remote",
        url: "https://node.example.com",
        apiKey: "secret-key",
        maxConcurrent: 2,
      }));
    });
  });
});
