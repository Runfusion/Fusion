import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AuthTokenRecoveryDialog } from "../AuthTokenRecoveryDialog";
import { clearAuthToken, setAuthToken } from "../../auth";

vi.mock("../../auth", () => ({
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
}));

describe("AuthTokenRecoveryDialog", () => {
  const originalLocation = window.location;
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });
  });

  it("does not render when closed", () => {
    render(<AuthTokenRecoveryDialog open={false} />);
    expect(screen.queryByRole("dialog", { name: "Authentication token required" })).toBeNull();
  });

  it("renders a blocking shared-modal dialog, focuses the token input, and disables set until input is populated", () => {
    render(<AuthTokenRecoveryDialog open={true} />);

    const dialog = screen.getByRole("dialog", { name: "Authentication token required" });
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();

    const overlay = dialog.closest(".auth-token-recovery-overlay");
    expect(overlay).toBeTruthy();

    if (!overlay) {
      throw new Error("Expected auth token recovery overlay");
    }

    expect(overlay.classList.contains("modal-overlay")).toBe(true);
    expect(overlay.classList.contains("open")).toBe(true);
    expect(dialog.classList.contains("modal")).toBe(true);
    expect(dialog.classList.contains("modal-md")).toBe(true);

    const input = screen.getByLabelText("Replacement token");
    expect(document.activeElement).toBe(input);

    const setTokenButton = screen.getByRole("button", { name: "Set token and reload" });
    expect(setTokenButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "   " } });
    expect(setTokenButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "abc123" } });
    expect(setTokenButton).toBeEnabled();
  });

  it("focuses the token input when recovery opens after the app shell was already mounted", () => {
    const { rerender } = render(<AuthTokenRecoveryDialog open={false} />);

    rerender(<AuthTokenRecoveryDialog open={true} />);

    const tokenInput = screen.getByLabelText("Replacement token");
    expect(screen.getByRole("dialog", { name: "Authentication token required" })).toBeInTheDocument();
    expect(tokenInput).toBe(document.activeElement);
  });

  it("keeps a single blocking dialog when duplicate open signals rerender it", () => {
    const { rerender } = render(<AuthTokenRecoveryDialog open={true} />);

    rerender(<AuthTokenRecoveryDialog open={true} />);

    expect(screen.getAllByRole("dialog", { name: "Authentication token required" })).toHaveLength(1);
    expect(document.querySelectorAll(".auth-token-recovery-overlay")).toHaveLength(1);
  });

  it("does not define auth-specific modal layering outside the shared modal classes", () => {
    const css = readFileSync("app/components/AuthTokenRecoveryDialog.css", "utf8");

    expect(css).not.toMatch(/auth-token-recovery-overlay\s*\{[^}]*z-index/s);
  });

  it("trims and stores replacement token before reloading", () => {
    render(<AuthTokenRecoveryDialog open={true} />);

    fireEvent.change(screen.getByLabelText("Replacement token"), { target: { value: "  new-token  " } });
    fireEvent.click(screen.getByRole("button", { name: "Set token and reload" }));

    expect(setAuthToken).toHaveBeenCalledWith("new-token");
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("clears token and reloads when user retries without replacement token", () => {
    render(<AuthTokenRecoveryDialog open={true} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear token and retry" }));

    expect(clearAuthToken).toHaveBeenCalledTimes(1);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss on Escape key", () => {
    render(<AuthTokenRecoveryDialog open={true} />);

    const overlay = document.querySelector(".auth-token-recovery-overlay");
    expect(overlay).toBeTruthy();

    if (!overlay) {
      throw new Error("Expected auth token recovery overlay");
    }

    fireEvent.keyDown(overlay, { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "Authentication token required" })).toBeInTheDocument();
  });
});
