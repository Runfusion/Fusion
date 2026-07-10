import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CursorCliProviderCard } from "../CursorCliProviderCard";

const fetchCursorCliStatus = vi.fn();
const setCursorCliBinaryPath = vi.fn();
const setCursorCliEnabled = vi.fn();

vi.mock("../../api", () => ({
  fetchCursorCliStatus: (...args: unknown[]) => fetchCursorCliStatus(...args),
  setCursorCliBinaryPath: (...args: unknown[]) => setCursorCliBinaryPath(...args),
  setCursorCliEnabled: (...args: unknown[]) => setCursorCliEnabled(...args),
}));

const baseStatus = {
  binary: { available: true, version: "1.0.0", binaryPath: "/usr/local/bin/cursor-agent", probeDurationMs: 5 },
  enabled: true,
  binaryPath: "/usr/local/bin/cursor-agent",
  extension: null,
  ready: true,
};

/*
FNXC:CursorCli 2026-07-08-00:00:
Regression coverage for FN-7695: the compact card's below-header content (status line +
binary-path control) must be nested inside `.cursor-cli-provider-card__body`
(data-testid="cursor-cli-provider-card-body") rather than being a bare direct child of
`.auth-provider-card`, so it inherits the same horizontal/bottom inset as the header. The
non-compact onboarding layout must NOT render this wrapper (its content already lives in the
padded `.onboarding-provider-card__body`).
*/
describe("CursorCliProviderCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchCursorCliStatus.mockResolvedValue(baseStatus);
    setCursorCliEnabled.mockResolvedValue({ enabled: true, binaryPath: baseStatus.binaryPath, restartRequired: true });
    setCursorCliBinaryPath.mockResolvedValue({ enabled: true, binaryPath: baseStatus.binaryPath, restartRequired: true });
  });

  it("wraps compact status line + binary-path control in the padded body wrapper", async () => {
    render(<CursorCliProviderCard authenticated compact />);

    const body = await screen.findByTestId("cursor-cli-provider-card-body");
    expect(body).toHaveClass("cursor-cli-provider-card__body");

    // Status line must be inside the body wrapper.
    const status = await screen.findByText(/Connected/i);
    expect(body).toContainElement(status);

    // Binary-path control (label + input) must be inside the body wrapper too.
    const label = screen.getByText("Cursor CLI binary path");
    expect(body).toContainElement(label);
    const input = screen.getByLabelText("Cursor CLI binary path");
    expect(body).toContainElement(input);

    // The wrapper must be a child of the card root, not a sibling bare child alongside it.
    const card = screen.getByTestId("cursor-cli-provider-card");
    expect(card).toContainElement(body);
  });

  it("keeps the body wrapper present before the status probe resolves (Probing…)", async () => {
    fetchCursorCliStatus.mockReturnValue(new Promise(() => {}));
    render(<CursorCliProviderCard authenticated={false} compact />);

    const body = await screen.findByTestId("cursor-cli-provider-card-body");
    const status = await screen.findByText(/Probing local CLI/i);
    expect(body).toContainElement(status);
  });

  it("keeps the body wrapper present when a pathMessage is shown after a failed save", async () => {
    setCursorCliBinaryPath.mockRejectedValueOnce(new Error("binary not found"));
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();

    render(<CursorCliProviderCard authenticated compact />);
    const input = await screen.findByLabelText("Cursor CLI binary path");
    await user.clear(input);
    await user.type(input, "/tmp/does-not-exist");

    const saveButton = screen.getByRole("button", { name: /Save & Test/i });
    await user.click(saveButton);

    const errorText = await screen.findByText("binary not found");
    const body = screen.getByTestId("cursor-cli-provider-card-body");
    expect(body).toContainElement(errorText);
  });

  it("does not render the body wrapper in the non-compact onboarding layout", async () => {
    render(<CursorCliProviderCard authenticated />);

    const card = await screen.findByTestId("cursor-cli-provider-card");
    expect(card).toHaveClass("onboarding-provider-card");
    await waitFor(() => expect(fetchCursorCliStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("cursor-cli-provider-card-body")).not.toBeInTheDocument();
  });
});
