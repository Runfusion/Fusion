import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShellConnectionStatus } from "../ShellConnectionStatus";
import type { ShellConnectionNativeResult } from "../../shell-native";

function makeStatus(overrides: Partial<ShellConnectionNativeResult> = {}): ShellConnectionNativeResult {
  return {
    hostKind: "desktop-shell",
    available: true,
    mode: "remote",
    profileId: "p1",
    profileLabel: "Prod",
    serverOrigin: "https://fusion.example.com",
    openConnectionManager: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe("ShellConnectionStatus", () => {
  // FNXC:ShellConnectionStatusPill 2026-07-10-14:25:
  // The header pill must render the host kind exactly once ("Desktop · Local mode"), never the old duplicated "Desktop  Desktop local mode".
  it("renders local desktop mode without duplicating the host kind", () => {
    render(<ShellConnectionStatus status={makeStatus({ mode: "local" })} />);
    expect(screen.getByText("Desktop · Local mode")).toBeInTheDocument();
    expect(screen.getByText("Switch server")).toBeInTheDocument();
    expect(screen.queryByText("Desktop local mode")).toBeNull();
    const button = screen.getByTestId("shell-connection-status-button");
    expect((button.textContent?.match(/Desktop/g) ?? []).length).toBe(1);
  });

  it("renders remote desktop mode summary", () => {
    render(<ShellConnectionStatus status={makeStatus()} />);
    expect(screen.getByText("Desktop · Prod · https://fusion.example.com")).toBeInTheDocument();
    expect(screen.getByText("Switch server")).toBeInTheDocument();
    expect(screen.getByTestId("shell-connection-status-button")).toHaveAttribute("type", "button");
    const button = screen.getByTestId("shell-connection-status-button");
    expect((button.textContent?.match(/Desktop/g) ?? []).length).toBe(1);
  });

  it("renders remote mobile mode summary", () => {
    render(
      <ShellConnectionStatus
        status={makeStatus({ hostKind: "mobile-shell", mode: "remote", profileLabel: "Tablet", serverOrigin: "https://remote.example.com" })}
      />,
    );
    expect(screen.getByText("Mobile · Tablet · https://remote.example.com")).toBeInTheDocument();
    expect(screen.getByText("Manage connections")).toBeInTheDocument();
    const button = screen.getByTestId("shell-connection-status-button");
    expect((button.textContent?.match(/Mobile/g) ?? []).length).toBe(1);
  });

  it("renders unavailable connection info with a single host-kind mention", () => {
    render(
      <ShellConnectionStatus
        status={makeStatus({ mode: "remote", profileId: undefined, profileLabel: undefined, serverOrigin: undefined })}
      />,
    );
    expect(screen.getByText("Desktop · Connection info unavailable")).toBeInTheDocument();
    const button = screen.getByTestId("shell-connection-status-button");
    expect((button.textContent?.match(/Desktop/g) ?? []).length).toBe(1);
  });

  it("hides in browser/unsupported mode", () => {
    const { rerender } = render(<ShellConnectionStatus status={makeStatus({ hostKind: "browser", available: false })} />);
    expect(screen.queryByTestId("shell-connection-status-button")).toBeNull();

    rerender(<ShellConnectionStatus status={makeStatus({ hostKind: "mobile-shell", available: false })} />);
    expect(screen.queryByTestId("shell-connection-status-button")).toBeNull();
  });

  it("invokes action and reports failures", async () => {
    const onError = vi.fn();
    const openConnectionManager = vi.fn(async () => ({ ok: false as const, reason: "failed" as const, error: "no bridge" }));
    render(<ShellConnectionStatus status={makeStatus({ openConnectionManager })} onError={onError} />);

    fireEvent.click(screen.getByTestId("shell-connection-status-button"));
    await waitFor(() => expect(openConnectionManager).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith("no bridge");
  });
});
