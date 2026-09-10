import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthTokenRecoveryPage } from "../AuthTokenRecoveryPage";
import { clearAuthToken, setAuthToken } from "../../auth";
import { readAppFile } from "../../test/cssFixture";

vi.mock("../../auth", () => ({
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
}));

describe("AuthTokenRecoveryPage", () => {
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
    render(<AuthTokenRecoveryPage open={false} />);

    expect(screen.queryByRole("main", { name: "Authentication token required" })).toBeNull();
  });

  it("renders one focused, blocking page without modal affordances", () => {
    const { container, rerender } = render(<AuthTokenRecoveryPage open={true} />);

    const page = screen.getByRole("main", { name: "Authentication token required" });
    const input = screen.getByLabelText("Replacement token");
    expect(page).toHaveClass("auth-token-recovery-page");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toBe(document.activeElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(container.querySelector(".modal-overlay, .modal, .modal-md, [aria-modal]")).toBeNull();

    fireEvent.keyDown(page, { key: "Escape" });
    fireEvent.click(page);
    rerender(<AuthTokenRecoveryPage open={true} />);

    expect(screen.getAllByRole("main", { name: "Authentication token required" })).toHaveLength(1);
    expect(document.querySelectorAll(".auth-token-recovery-page")).toHaveLength(1);
  });

  it("focuses the token input when recovery opens after mount", () => {
    const { rerender } = render(<AuthTokenRecoveryPage open={false} />);

    rerender(<AuthTokenRecoveryPage open={true} />);

    expect(screen.getByLabelText("Replacement token")).toBe(document.activeElement);
  });

  it("refuses empty and whitespace-only form submissions", () => {
    render(<AuthTokenRecoveryPage open={true} />);
    const input = screen.getByLabelText("Replacement token");
    const submit = screen.getByRole("button", { name: "Set token and reload" });

    expect(submit).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    fireEvent.change(input, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.submit(input.closest("form")!);

    expect(setAuthToken).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("trims and stores a replacement token through the submit button", () => {
    render(<AuthTokenRecoveryPage open={true} />);

    fireEvent.change(screen.getByLabelText("Replacement token"), { target: { value: "  new-token  " } });
    fireEvent.click(screen.getByRole("button", { name: "Set token and reload" }));

    expect(setAuthToken).toHaveBeenCalledOnce();
    expect(setAuthToken).toHaveBeenCalledWith("new-token");
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it("submits a trimmed token exactly once when Enter is pressed", async () => {
    const user = userEvent.setup();
    render(<AuthTokenRecoveryPage open={true} />);

    await user.type(screen.getByLabelText("Replacement token"), "  new-token  {Enter}");

    expect(setAuthToken).toHaveBeenCalledOnce();
    expect(setAuthToken).toHaveBeenCalledWith("new-token");
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it("clears the token and reloads without submitting the form", () => {
    render(<AuthTokenRecoveryPage open={true} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear token and retry" }));

    expect(clearAuthToken).toHaveBeenCalledOnce();
    expect(setAuthToken).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it("owns a token-only fullscreen and responsive safe-area CSS contract", () => {
    const css = readAppFile("components/AuthTokenRecoveryPage.css");
    const pageRule = css.match(/\.auth-token-recovery-page\s*\{([^}]*)\}/s)?.[1] ?? "";
    const mobileRule = css.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? "";

    expect(pageRule).toContain("position: fixed");
    expect(pageRule).toContain("inset: 0");
    expect(pageRule).toContain("min-height: 100dvh");
    expect(pageRule).toContain("overflow-y: auto");
    expect(pageRule).toContain("env(safe-area-inset-top, 0)");
    expect(pageRule).toContain("env(safe-area-inset-bottom, 0)");
    expect(mobileRule).toContain(".auth-token-recovery-page");
    expect(mobileRule).toContain("env(safe-area-inset-left, 0)");
    expect(mobileRule).toContain("env(safe-area-inset-right, 0)");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css.replace(/max-width:\s*768px/g, "")).not.toMatch(/\b(?!0(?:\.0+)?px\b)\d+(?:\.\d+)?px\b/);
    expect(css).not.toMatch(/\.modal(?:-|\b)|aria-modal/);
  });
});
