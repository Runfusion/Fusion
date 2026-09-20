import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AntigravityCliProviderCard } from "../AntigravityCliProviderCard";

const fetchAntigravityCliStatus = vi.fn();
const setAntigravityCliBinaryPath = vi.fn();
const setAntigravityCliEnabled = vi.fn();

vi.mock("../../api", () => ({
  fetchAntigravityCliStatus: (...args: unknown[]) => fetchAntigravityCliStatus(...args),
  setAntigravityCliBinaryPath: (...args: unknown[]) => setAntigravityCliBinaryPath(...args),
  setAntigravityCliEnabled: (...args: unknown[]) => setAntigravityCliEnabled(...args),
}));

const baseStatus = {
  binary: { available: true, version: "1.0.0", binaryPath: "/usr/local/bin/agy", probeDurationMs: 5 },
  enabled: true,
  binaryPath: "/usr/local/bin/agy",
  extension: null,
  ready: true,
};

/*
FNXC:AntigravityCli 2026-07-08-00:00:
Regression coverage for FN-7695: the compact card's below-header content (status line +
binary-path control) must be nested inside `.antigravity-cli-provider-card__body`
(data-testid="antigravity-cli-provider-card-body") rather than being a bare direct child of
`.auth-provider-card`, so it inherits the same horizontal/bottom inset as the header. The
non-compact onboarding layout must NOT render this wrapper (its content already lives in the
padded `.onboarding-provider-card__body`).
*/
describe("AntigravityCliProviderCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAntigravityCliStatus.mockResolvedValue(baseStatus);
    setAntigravityCliEnabled.mockResolvedValue({ enabled: true, binaryPath: baseStatus.binaryPath, restartRequired: true });
    setAntigravityCliBinaryPath.mockResolvedValue({ enabled: true, binaryPath: baseStatus.binaryPath, restartRequired: true });
  });

  it("wraps compact status line + binary-path control in the padded body wrapper", async () => {
    render(<AntigravityCliProviderCard authenticated compact />);

    const body = await screen.findByTestId("antigravity-cli-provider-card-body");
    expect(body).toHaveClass("antigravity-cli-provider-card__body");

    // Status line must be inside the body wrapper.
    const status = await screen.findByText(/Connected/i);
    expect(body).toContainElement(status);

    // Binary-path control (label + input) must be inside the body wrapper too.
    const label = screen.getByText("Antigravity CLI binary path");
    expect(body).toContainElement(label);
    const input = screen.getByLabelText("Antigravity CLI binary path");
    expect(body).toContainElement(input);

    // The wrapper must be a child of the card root, not a sibling bare child alongside it.
    const card = screen.getByTestId("antigravity-cli-provider-card");
    expect(card).toContainElement(body);
  });

  it("keeps the body wrapper present before the status probe resolves (Probing…)", async () => {
    fetchAntigravityCliStatus.mockReturnValue(new Promise(() => {}));
    render(<AntigravityCliProviderCard authenticated={false} compact />);

    const body = await screen.findByTestId("antigravity-cli-provider-card-body");
    const status = await screen.findByText(/Probing local CLI/i);
    expect(body).toContainElement(status);
  });

  it("keeps the body wrapper present when a pathMessage is shown after a failed save", async () => {
    setAntigravityCliBinaryPath.mockRejectedValueOnce(new Error("binary not found"));
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();

    render(<AntigravityCliProviderCard authenticated compact />);
    const input = await screen.findByLabelText("Antigravity CLI binary path");
    await user.clear(input);
    await user.type(input, "/tmp/does-not-exist");

    const saveButton = screen.getByRole("button", { name: /Save & Test/i });
    await user.click(saveButton);

    const errorText = await screen.findByText("binary not found");
    const body = screen.getByTestId("antigravity-cli-provider-card-body");
    expect(body).toContainElement(errorText);
  });

  it("does not render the body wrapper in the non-compact onboarding layout", async () => {
    render(<AntigravityCliProviderCard authenticated />);

    const card = await screen.findByTestId("antigravity-cli-provider-card");
    expect(card).toHaveClass("onboarding-provider-card");
    await waitFor(() => expect(fetchAntigravityCliStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("antigravity-cli-provider-card-body")).not.toBeInTheDocument();
  });
});
