import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { UpdateAvailableBanner } from "../UpdateAvailableBanner";

const mockInstallUpdate = vi.hoisted(() => vi.fn());

vi.mock("../../api", () => ({
  installUpdate: (...args: unknown[]) => mockInstallUpdate(...args),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    RefreshCw: ({ className }: { className?: string }) => <span data-testid="icon-refresh" className={className} />,
  };
});

describe("UpdateAvailableBanner", () => {
  beforeEach(() => {
    mockInstallUpdate.mockReset();
    mockInstallUpdate.mockResolvedValue({ currentVersion: "0.6.0", latestVersion: "0.7.0", updated: true });
  });
  it("renders version information with release notes and learn more links", () => {
    render(
      <UpdateAvailableBanner latestVersion="0.7.0" currentVersion="0.6.0" onDismiss={vi.fn()} />,
    );

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

    render(
      <UpdateAvailableBanner latestVersion="0.7.0" currentVersion="0.6.0" onDismiss={onDismiss} />,
    );

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

  it("disables update-now while installing and then shows restart hint", async () => {
    let resolveInstall: ((result: { currentVersion: string; latestVersion: string; updated: boolean }) => void) | undefined;
    mockInstallUpdate.mockReturnValueOnce(new Promise((resolve) => {
      resolveInstall = resolve;
    }));

    render(<UpdateAvailableBanner latestVersion="0.7.0" currentVersion="0.6.0" onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(screen.getByTestId("icon-refresh")).toHaveClass("spinning");

    resolveInstall?.({ currentVersion: "0.6.0", latestVersion: "0.7.0", updated: true });

    expect(await screen.findByText("Updated to v0.7.0 — restart Fusion to apply")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
  });

  it("shows install errors inline without removing retry button", async () => {
    mockInstallUpdate.mockResolvedValueOnce({
      currentVersion: "0.6.0",
      latestVersion: "0.7.0",
      updated: false,
      error: "permission denied",
    });

    render(<UpdateAvailableBanner latestVersion="0.7.0" currentVersion="0.6.0" onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() => expect(mockInstallUpdate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Update failed: permission denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update now" })).not.toBeDisabled();
  });
});
