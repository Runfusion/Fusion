import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { UpdateAvailableBanner } from "../UpdateAvailableBanner";

const mockFetchSystemInfo = vi.hoisted(() => vi.fn());
const mockInstallUpdate = vi.hoisted(() => vi.fn());
const mockRequestSystemRestart = vi.hoisted(() => vi.fn());

vi.mock("../../api", () => ({
  fetchSystemInfo: (...args: unknown[]) => mockFetchSystemInfo(...args),
  installUpdate: (...args: unknown[]) => mockInstallUpdate(...args),
  requestSystemRestart: (...args: unknown[]) => mockRequestSystemRestart(...args),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    RefreshCw: ({ className }: { className?: string }) => <span data-testid="icon-refresh" className={className} />,
  };
});

const successfulInstall = { currentVersion: "0.6.0", latestVersion: "0.7.0", updated: true };

function renderBanner() {
  return render(<UpdateAvailableBanner latestVersion="0.7.0" currentVersion="0.6.0" onDismiss={vi.fn()} />);
}

async function completeInstall() {
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await screen.findByText("Updated to v0.7.0 — restart Fusion to apply");
}

describe("UpdateAvailableBanner", () => {
  beforeEach(() => {
    mockFetchSystemInfo.mockReset();
    mockInstallUpdate.mockReset();
    mockRequestSystemRestart.mockReset();
    mockFetchSystemInfo.mockResolvedValue({ restartSupported: true });
    mockInstallUpdate.mockResolvedValue(successfulInstall);
    mockRequestSystemRestart.mockResolvedValue({ scheduled: true });
  });

  it("renders version information with release notes and learn more links", () => {
    renderBanner();

    expect(screen.getByText(/Update available: v0.7.0 \(current: v0.6.0\)/)).toBeInTheDocument();
    expect(screen.getByText("fn update")).toBeInTheDocument();
    expect(screen.getByText(/or pull this source checkout/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Release notes" })).toHaveAttribute(
      "href",
      "https://github.com/Runfusion/Fusion/blob/main/CHANGELOG.md",
    );
    expect(screen.getByRole("link", { name: "Learn more" })).toHaveAttribute("href", "https://runfusion.ai");
  });

  it("dismiss button calls onDismiss", () => {
    const onDismiss = vi.fn();

    render(<UpdateAvailableBanner latestVersion="0.7.0" currentVersion="0.6.0" onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("can be hidden by parent on dismiss", () => {
    function Harness() {
      const [visible, setVisible] = useState(true);
      if (!visible) return null;
      return (
        <UpdateAvailableBanner
          latestVersion="0.7.0"
          currentVersion="0.6.0"
          onDismiss={() => setVisible(false)}
        />
      );
    }

    render(<Harness />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("disables update-now while installing and then renders an enabled restart button", async () => {
    let resolveInstall: ((result: typeof successfulInstall) => void) | undefined;
    mockInstallUpdate.mockReturnValueOnce(new Promise((resolve) => {
      resolveInstall = resolve;
    }));

    renderBanner();

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(screen.getByTestId("icon-refresh")).toHaveClass("spinning");

    resolveInstall?.(successfulInstall);

    await screen.findByText("Updated to v0.7.0 — restart Fusion to apply");
    expect(screen.getByRole("button", { name: "Restart Fusion" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
  });

  it("restarts a supervised host with the update-banner reason", async () => {
    renderBanner();
    await completeInstall();

    fireEvent.click(screen.getByRole("button", { name: "Restart Fusion" }));

    await waitFor(() => expect(mockRequestSystemRestart).toHaveBeenCalledWith("update-banner"));
    expect(await screen.findByText("Restarting… Your connection will close shortly.")).toBeInTheDocument();
  });

  /*
  FNXC:UpdateBanner 2026-07-25-10:05:
  Restart capability is advisory, not a hard block: the button always reaches the
  server so an operator sees the real refusal instead of a control that silently
  does nothing (a failed or stale /system/info probe used to disable it outright).
  */
  it("shows manual guidance but still attempts the restart when unsupported", async () => {
    mockFetchSystemInfo.mockResolvedValueOnce({ restartSupported: false });
    mockRequestSystemRestart.mockRejectedValueOnce(new Error("Restart is not available: no supervising parent."));
    renderBanner();
    await completeInstall();

    const restartButton = screen.getByRole("button", { name: "Restart Fusion" });
    expect(restartButton).toBeEnabled();
    expect(screen.getByText(/Needs a supervising parent/)).toBeInTheDocument();

    fireEvent.click(restartButton);

    await waitFor(() => expect(mockRequestSystemRestart).toHaveBeenCalledWith("update-banner"));
    expect(await screen.findByText(/Restart is not available: no supervising parent\./)).toBeInTheDocument();
  });

  it("allows a restart attempt while system info is still loading", async () => {
    mockFetchSystemInfo.mockReturnValueOnce(new Promise(() => {}));
    renderBanner();
    await completeInstall();

    expect(screen.getByRole("button", { name: "Restart Fusion" })).toBeEnabled();
    expect(screen.queryByText(/Needs a supervising parent/)).not.toBeInTheDocument();
  });

  it("shows manual guidance when system info cannot be loaded", async () => {
    mockFetchSystemInfo.mockRejectedValueOnce(new Error("network unavailable"));
    renderBanner();
    await completeInstall();

    await waitFor(() => expect(screen.getByText(/Needs a supervising parent/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Restart Fusion" })).toBeEnabled();
  });

  it("shows a disabled spinning restart action while a restart request is in flight", async () => {
    mockRequestSystemRestart.mockReturnValueOnce(new Promise(() => {}));
    renderBanner();
    await completeInstall();

    fireEvent.click(screen.getByRole("button", { name: "Restart Fusion" }));

    expect(screen.getByRole("button", { name: /Restarting/ })).toBeDisabled();
    expect(screen.getByTestId("icon-refresh")).toHaveClass("spinning");
  });

  it("shows a re-clickable inline error when restart rejects", async () => {
    mockRequestSystemRestart.mockRejectedValueOnce(new Error("restart conflict"));
    renderBanner();
    await completeInstall();

    fireEvent.click(screen.getByRole("button", { name: "Restart Fusion" }));

    expect(await screen.findByText("restart conflict")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart Fusion" })).toBeEnabled();
  });

  it("shows a re-clickable inline error when restart is not scheduled", async () => {
    mockRequestSystemRestart.mockResolvedValueOnce({ scheduled: false });
    renderBanner();
    await completeInstall();

    fireEvent.click(screen.getByRole("button", { name: "Restart Fusion" }));

    expect(await screen.findByText("Restart could not be scheduled. Try restarting Fusion manually.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart Fusion" })).toBeEnabled();
  });

  it("shows install errors inline without rendering a restart button or removing retry", async () => {
    mockInstallUpdate.mockResolvedValueOnce({
      currentVersion: "0.6.0",
      latestVersion: "0.7.0",
      updated: false,
      error: "permission denied",
    });

    renderBanner();

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() => expect(mockInstallUpdate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Update failed: permission denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update now" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Restart Fusion" })).not.toBeInTheDocument();
  });

  it.each([
    ["supported", true],
    ["unsupported", false],
  ])("keeps the mobile action row and %s restart control in the document", async (_state, restartSupported) => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 480 });
    mockFetchSystemInfo.mockResolvedValueOnce({ restartSupported });

    renderBanner();
    await completeInstall();

    const actions = document.querySelector(".update-available-banner__actions");
    const restartButton = screen.getByRole("button", { name: "Restart Fusion" });
    expect(actions).toBeInTheDocument();
    expect(actions).toContainElement(restartButton);
    expect(restartButton).toBeInTheDocument();
    expect(restartButton).toHaveProperty("disabled", false);
    if (!restartSupported) expect(screen.getByText(/Needs a supervising parent/)).toBeInTheDocument();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
  });
});
