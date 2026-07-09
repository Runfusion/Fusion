import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { GrokCliProviderCard } from "../GrokCliProviderCard";

const fetchGrokCliStatus = vi.fn();
const setGrokCliBinaryPath = vi.fn();
const setGrokCliEnabled = vi.fn();

vi.mock("../../api", () => ({
  fetchGrokCliStatus: (...args: unknown[]) => fetchGrokCliStatus(...args),
  setGrokCliBinaryPath: (...args: unknown[]) => setGrokCliBinaryPath(...args),
  setGrokCliEnabled: (...args: unknown[]) => setGrokCliEnabled(...args),
}));

const baseStatus = {
  binary: { available: true, authenticated: true, version: "1.0.0", binaryPath: "/usr/local/bin/grok", probeDurationMs: 5 },
  enabled: true,
  binaryPath: "/usr/local/bin/grok",
  extension: null,
  ready: true,
};

/*
FNXC:GrokCli 2026-07-08-00:00:
Regression coverage mirroring CursorCliProviderCard.test.tsx (FN-7695) for FN-7705: the compact
card's below-header content (status line + binary-path control) must be nested inside
`.grok-cli-provider-card__body` (data-testid="grok-cli-provider-card-body") rather than being a
bare direct child of `.auth-provider-card`. The non-compact onboarding layout must NOT render
this wrapper. Additionally covers the API-key-auth-specific "no API key configured" status text
that has no Cursor equivalent (Cursor is OAuth/session, not API-key).
*/
describe("GrokCliProviderCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchGrokCliStatus.mockResolvedValue(baseStatus);
    setGrokCliEnabled.mockResolvedValue({ enabled: true, binaryPath: baseStatus.binaryPath, restartRequired: true });
    setGrokCliBinaryPath.mockResolvedValue({ enabled: true, binaryPath: baseStatus.binaryPath, restartRequired: true });
  });

  it("wraps compact status line + binary-path control in the padded body wrapper", async () => {
    render(<GrokCliProviderCard authenticated compact />);

    const body = await screen.findByTestId("grok-cli-provider-card-body");
    expect(body).toHaveClass("grok-cli-provider-card__body");

    const status = await screen.findByText(/Connected/i);
    expect(body).toContainElement(status);

    const label = screen.getByText("Grok CLI binary path");
    expect(body).toContainElement(label);
    const input = screen.getByLabelText("Grok CLI binary path");
    expect(body).toContainElement(input);

    const card = screen.getByTestId("grok-cli-provider-card");
    expect(card).toContainElement(body);
  });

  it("keeps the body wrapper present before the status probe resolves (Probing…)", async () => {
    fetchGrokCliStatus.mockReturnValue(new Promise(() => {}));
    render(<GrokCliProviderCard authenticated={false} compact />);

    const body = await screen.findByTestId("grok-cli-provider-card-body");
    const status = await screen.findByText(/Probing local CLI/i);
    expect(body).toContainElement(status);
  });

  it("shows an actionable no-API-key message when the binary is available but no key is configured", async () => {
    fetchGrokCliStatus.mockResolvedValue({
      ...baseStatus,
      binary: { ...baseStatus.binary, authenticated: false },
    });

    render(<GrokCliProviderCard authenticated={false} compact />);

    const status = await screen.findByText(/GROK_API_KEY/i);
    expect(status.textContent).toContain("~/.grok/user-settings.json");
  });

  it("keeps the body wrapper present when a pathMessage is shown after a failed save", async () => {
    setGrokCliBinaryPath.mockRejectedValueOnce(new Error("binary not found"));
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();

    render(<GrokCliProviderCard authenticated compact />);
    const input = await screen.findByLabelText("Grok CLI binary path");
    await user.clear(input);
    await user.type(input, "/tmp/does-not-exist");

    const saveButton = screen.getByRole("button", { name: /Save & Test/i });
    await user.click(saveButton);

    const errorText = await screen.findByText("binary not found");
    const body = screen.getByTestId("grok-cli-provider-card-body");
    expect(body).toContainElement(errorText);
  });

  it("does not render the body wrapper in the non-compact onboarding layout", async () => {
    render(<GrokCliProviderCard authenticated />);

    const card = await screen.findByTestId("grok-cli-provider-card");
    expect(card).toHaveClass("onboarding-provider-card");
    await waitFor(() => expect(fetchGrokCliStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("grok-cli-provider-card-body")).not.toBeInTheDocument();
  });
});
