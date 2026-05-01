import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DroidCliProviderCard } from "../DroidCliProviderCard";

const fetchDroidCliStatus = vi.fn();
const setDroidCliEnabled = vi.fn();

vi.mock("../../api", () => ({
  fetchDroidCliStatus: (...args: unknown[]) => fetchDroidCliStatus(...args),
  setDroidCliEnabled: (...args: unknown[]) => setDroidCliEnabled(...args),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Loader2: ({ className }: { className?: string }) => <span data-testid="loader" className={className}>loader</span>,
  };
});

const baseStatus = {
  binary: { available: true, version: "1.2.3", binaryPath: "/usr/local/bin/droid", probeDurationMs: 9 },
  enabled: false,
  extension: { status: "ok" as const },
  ready: false,
};

describe("DroidCliProviderCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchDroidCliStatus.mockResolvedValue(baseStatus);
    setDroidCliEnabled.mockResolvedValue({ enabled: true, restartRequired: true });
  });

  it("renders with loading state before probe resolves", () => {
    fetchDroidCliStatus.mockReturnValue(new Promise(() => {}));
    render(<DroidCliProviderCard authenticated={false} />);
    expect(screen.getByText(/Probing local CLI/i)).toBeInTheDocument();
  });

  it("renders compact mode", async () => {
    render(<DroidCliProviderCard authenticated={false} compact />);
    const card = await screen.findByTestId("droid-cli-provider-card");
    expect(card).toHaveClass("auth-provider-card");
  });

  it("renders full mode", async () => {
    render(<DroidCliProviderCard authenticated={false} compact={false} />);
    const card = await screen.findByTestId("droid-cli-provider-card");
    expect(card).toHaveClass("onboarding-provider-card");
  });

  it("Test button re-fetches status", async () => {
    render(<DroidCliProviderCard authenticated={false} />);
    await screen.findByText(/Click Enable to route AI calls through it/i);
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(fetchDroidCliStatus).toHaveBeenCalledTimes(2));
  });

  it("Enable calls setDroidCliEnabled(true) and disables button when binary unavailable", async () => {
    fetchDroidCliStatus.mockResolvedValueOnce({ ...baseStatus, binary: { ...baseStatus.binary, available: false } });
    render(<DroidCliProviderCard authenticated={false} />);
    const enable = await screen.findByRole("button", { name: "Enable" });
    expect(enable).toBeDisabled();

    fetchDroidCliStatus.mockResolvedValue({ ...baseStatus, binary: { ...baseStatus.binary, available: true } });
    render(<DroidCliProviderCard authenticated={false} />);
    const secondEnable = await screen.findAllByRole("button", { name: "Enable" });
    fireEvent.click(secondEnable[1]);
    await waitFor(() => expect(setDroidCliEnabled).toHaveBeenCalledWith(true));
  });

  it("Disable calls setDroidCliEnabled(false)", async () => {
    fetchDroidCliStatus.mockResolvedValue({ ...baseStatus, enabled: true, ready: true });
    setDroidCliEnabled.mockResolvedValue({ enabled: false, restartRequired: true });
    render(<DroidCliProviderCard authenticated={true} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    await waitFor(() => expect(setDroidCliEnabled).toHaveBeenCalledWith(false));
  });

  it("shows restart-required toast after toggle", async () => {
    render(<DroidCliProviderCard authenticated={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable" }));
    expect(await screen.findByText(/Factory AI \(via Droid CLI\) models are now visible/i)).toBeInTheDocument();
  });

  it("shows error toast when toggle fails", async () => {
    setDroidCliEnabled.mockRejectedValueOnce(new Error("boom"));
    render(<DroidCliProviderCard authenticated={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable" }));
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});
