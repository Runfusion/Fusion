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
  binary: { available: true, authenticated: true, apiKeyDetected: true, version: "1.0.0", binaryPath: "/usr/local/bin/grok", probeDurationMs: 5 },
  enabled: true,
  binaryPath: "/usr/local/bin/grok",
  extension: null,
  ready: true,
};

/*
FNXC:GrokCli 2026-07-09-00:00:
FN-7716: regression coverage mirroring CursorCliProviderCard.test.tsx (FN-7695). The compact
card's below-header content (status line + binary-path control) must be nested inside
`.grok-cli-provider-card__body` (data-testid="grok-cli-provider-card-body") rather than being a
bare direct child of `.auth-provider-card`. The non-compact onboarding layout must NOT render
this wrapper. Also covers the Symptom Verification invariant: binary-available-but-no-key must
render a non-blocking ready state (no "Set GROK_API_KEY" blocking copy) with only a subtle
informational apiKeyDetected hint — the CLI owns its own authentication.
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

  /*
  FNXC:GrokCli 2026-07-09-00:00:
  FN-7716 Symptom Verification: BEFORE the fix, binary-available + no-key
  rendered a blocking "Set GROK_API_KEY" not-authenticated message and the
  Enable action was effectively meaningless because `authenticated` was
  false. AFTER the fix, this exact state (`authenticated: true,
  apiKeyDetected: false`) must render a non-blocking connected/ready state
  plus only a subtle informational hint — never the blocking copy.
  */
  it("shows a non-blocking ready state (not a blocking no-API-key error) when the binary is available but no key is detected", async () => {
    fetchGrokCliStatus.mockResolvedValue({
      ...baseStatus,
      binary: { ...baseStatus.binary, authenticated: true, apiKeyDetected: false },
    });

    render(<GrokCliProviderCard authenticated compact />);

    const status = await screen.findByText(/Connected/i);
    expect(status).toBeInTheDocument();

    const hint = await screen.findByText(/No Grok API key detected by Fusion/i);
    expect(hint.textContent).toContain("GROK_API_KEY");

    expect(screen.queryByText(/Set GROK_API_KEY/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Binary found, but no API key is configured/i)).not.toBeInTheDocument();

    const enableButton = screen.queryByRole("button", { name: /Enable/i });
    expect(enableButton).not.toBeInTheDocument();
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
