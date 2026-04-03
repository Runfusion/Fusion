import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScriptsModal } from "../ScriptsModal";
import type { ScriptEntry } from "../../api";

const mockScripts: Record<string, string> = {
  build: "npm run build",
  test: "pnpm test",
  lint: "eslint src --ext .ts,.tsx",
};

vi.mock("../../api", () => ({
  fetchScripts: vi.fn(() => Promise.resolve({})),
  addScript: vi.fn(() => Promise.resolve({ name: "new-script", command: "echo hello" })),
  removeScript: vi.fn(() => Promise.resolve()),
}));

import {
  fetchScripts,
  addScript,
  removeScript,
} from "../../api";

const onClose = vi.fn();
const addToast = vi.fn();
const onRunScript = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ScriptsModal", () => {
  it("has the 'open' class on the modal overlay when visible", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce(mockScripts);

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    const overlay = screen.getByTestId("scripts-modal");
    expect(overlay.classList.contains("modal-overlay")).toBe(true);
    expect(overlay.classList.contains("open")).toBe(true);
  });

  it("does not render when closed", () => {
    const { container } = render(
      <ScriptsModal isOpen={false} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders list of scripts", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce(mockScripts);

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByText("build")).toBeInTheDocument();
      expect(screen.getByText("test")).toBeInTheDocument();
      expect(screen.getByText("lint")).toBeInTheDocument();
    });
  });

  it("shows empty state when no scripts exist", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce({});

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });
    // Use getAllByText since the header also shows "No scripts defined" text
    expect(screen.getAllByText(/No scripts defined/).length).toBeGreaterThan(0);
  });

  it("opens create form when Add Script button is clicked", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce({});

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-script-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-script-btn"));

    expect(screen.getByTestId("script-name-input")).toBeInTheDocument();
    expect(screen.getByTestId("script-command-input")).toBeInTheDocument();
  });

  it("submits new script", async () => {
    vi.mocked(fetchScripts)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-script-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-script-btn"));

    const nameInput = screen.getByTestId("script-name-input");
    const commandInput = screen.getByTestId("script-command-input");

    fireEvent.change(nameInput, { target: { value: "new-script" } });
    fireEvent.change(commandInput, { target: { value: "echo hello" } });

    fireEvent.click(screen.getByTestId("script-save-btn"));

    await waitFor(() => {
      expect(addScript).toHaveBeenCalledWith("new-script", "echo hello", undefined);
      expect(addToast).toHaveBeenCalledWith("Script created", "success");
    });
  });

  it("validates script name (alphanumeric, hyphens, underscores only)", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce({});

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-script-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-script-btn"));

    const nameInput = screen.getByTestId("script-name-input");
    fireEvent.change(nameInput, { target: { value: "invalid name with spaces" } });

    await waitFor(() => {
      expect(screen.getByTestId("script-name-error")).toBeInTheDocument();
    });
    // Verify the error message contains expected text
    expect(screen.getByTestId("script-name-error").textContent).toContain("letters");
  });

  it("allows valid script names with hyphens and underscores", async () => {
    vi.mocked(fetchScripts)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-script-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-script-btn"));

    const nameInput = screen.getByTestId("script-name-input");
    const commandInput = screen.getByTestId("script-command-input");

    fireEvent.change(nameInput, { target: { value: "my-script_v2" } });
    fireEvent.change(commandInput, { target: { value: "echo test" } });

    fireEvent.click(screen.getByTestId("script-save-btn"));

    await waitFor(() => {
      expect(addScript).toHaveBeenCalledWith("my-script_v2", "echo test", undefined);
    });
  });

  it("runs script when Run button is clicked", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce(mockScripts);

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("run-script-build")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("run-script-build"));

    expect(onRunScript).toHaveBeenCalledWith("build", "npm run build");
  });

  it("shows delete confirmation", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce(mockScripts);

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("run-script-build")).toBeInTheDocument();
    });

    // Click delete button
    fireEvent.click(screen.getByTestId("delete-script-build"));

    // Confirm delete buttons should appear
    await waitFor(() => {
      expect(screen.getByTestId("confirm-delete-script-build")).toBeInTheDocument();
      expect(screen.getByTestId("cancel-delete-script-build")).toBeInTheDocument();
    });
  });

  it("deletes script when confirmed", async () => {
    vi.mocked(fetchScripts)
      .mockResolvedValueOnce(mockScripts)
      .mockResolvedValueOnce({});

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("delete-script-build")).toBeInTheDocument();
    });

    // Click delete button
    fireEvent.click(screen.getByTestId("delete-script-build"));

    // Confirm delete
    await waitFor(() => {
      expect(screen.getByTestId("confirm-delete-script-build")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-delete-script-build"));

    await waitFor(() => {
      expect(removeScript).toHaveBeenCalledWith("build", undefined);
      expect(addToast).toHaveBeenCalledWith("Script deleted", "success");
    });
  });

  it("cancels delete when cancel is clicked", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce(mockScripts);

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("delete-script-build")).toBeInTheDocument();
    });

    // Click delete button
    fireEvent.click(screen.getByTestId("delete-script-build"));

    // Cancel delete
    await waitFor(() => {
      expect(screen.getByTestId("cancel-delete-script-build")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("cancel-delete-script-build"));

    // Script should still be visible, delete button back to normal
    await waitFor(() => {
      expect(screen.getByTestId("delete-script-build")).toBeInTheDocument();
      expect(removeScript).not.toHaveBeenCalled();
    });
  });

  it("shows error toast when API call fails", async () => {
    vi.mocked(fetchScripts).mockRejectedValueOnce(new Error("Network error"));

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Network error"), "error");
    });
  });

  it("cancels form when Cancel button is clicked", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce({});

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-script-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-script-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("script-save-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("script-cancel-btn"));

    // Form should be closed, back to list view
    await waitFor(() => {
      expect(screen.getByTestId("add-script-btn")).toBeInTheDocument();
    });
  });

  it("edits existing script", async () => {
    vi.mocked(fetchScripts)
      .mockResolvedValueOnce(mockScripts)
      .mockResolvedValueOnce(mockScripts);

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("edit-script-build")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("edit-script-build"));

    await waitFor(() => {
      expect(screen.getByTestId("script-name-input")).toBeInTheDocument();
      expect(screen.getByTestId("script-command-input")).toBeInTheDocument();
    });

    const commandInput = screen.getByTestId("script-command-input");
    fireEvent.change(commandInput, { target: { value: "npm run build:prod" } });

    fireEvent.click(screen.getByTestId("script-save-btn"));

    await waitFor(() => {
      expect(addScript).toHaveBeenCalledWith("build", "npm run build:prod", undefined);
      expect(addToast).toHaveBeenCalledWith("Script updated", "success");
    });
  });

  it("shows validation error when script name is empty", async () => {
    vi.mocked(fetchScripts)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-script-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-script-btn"));

    const commandInput = screen.getByTestId("script-command-input");
    fireEvent.change(commandInput, { target: { value: "echo test" } });

    // Try to save with empty name
    fireEvent.click(screen.getByTestId("script-save-btn"));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Script name is required", "error");
    });
  });

  it("shows validation error when command is empty", async () => {
    vi.mocked(fetchScripts)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-script-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-script-btn"));

    const nameInput = screen.getByTestId("script-name-input");
    fireEvent.change(nameInput, { target: { value: "test-script" } });

    // Try to save with empty command
    fireEvent.click(screen.getByTestId("script-save-btn"));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Script command is required", "error");
    });
  });

  it("handles duplicate script name error", async () => {
    vi.mocked(fetchScripts)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    vi.mocked(addScript).mockRejectedValueOnce(new Error("A script with this name already exists"));

    render(
      <ScriptsModal isOpen={true} onClose={onClose} addToast={addToast} onRunScript={onRunScript} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-script-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-script-btn"));

    fireEvent.change(screen.getByTestId("script-name-input"), { target: { value: "test-script" } });
    fireEvent.change(screen.getByTestId("script-command-input"), { target: { value: "echo test" } });

    fireEvent.click(screen.getByTestId("script-save-btn"));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("A script with this name already exists", "error");
    });
  });
});
