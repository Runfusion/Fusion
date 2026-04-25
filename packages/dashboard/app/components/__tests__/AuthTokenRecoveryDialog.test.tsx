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

  it("renders a blocking dialog with disabled set button until token is entered", () => {
    render(<AuthTokenRecoveryDialog open={true} />);

    expect(screen.getByRole("dialog", { name: "Authentication token required" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();

    const setTokenButton = screen.getByRole("button", { name: "Set token and reload" });
    expect(setTokenButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Replacement token"), { target: { value: "abc123" } });
    expect(setTokenButton).toBeEnabled();
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
