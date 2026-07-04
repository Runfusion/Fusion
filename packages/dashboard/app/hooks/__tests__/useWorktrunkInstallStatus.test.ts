import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

import { useWorktrunkInstallStatus } from "../useWorktrunkInstallStatus";

/*
FNXC:WindowsTerminalStartup 2026-07-03-16:25:
The worktrunk status probe hits `GET /api/worktrunk/status`, which resolves +
probes the `wt` binary server-side; on Windows `wt` is Windows Terminal, so an
automatic probe on Settings mount pops its native version/Help dialog. The hook
must only auto-fetch when worktrunk integration is enabled (user opted in) —
never on a plain mount — so opening Settings can't trigger the dialog.
*/
describe("useWorktrunkInstallStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "installed", version: "0.4.2" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("does not probe worktrunk status on mount when disabled", async () => {
    renderHook(() => useWorktrunkInstallStatus("p1", { enabled: false }));
    // Give any (incorrect) effect a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not probe worktrunk status on mount when options are omitted", async () => {
    renderHook(() => useWorktrunkInstallStatus("p1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes worktrunk status on mount when enabled (user opted in)", async () => {
    renderHook(() => useWorktrunkInstallStatus("p1", { enabled: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/worktrunk/status");
  });

  it("probes exactly once when enabled flips false -> true live (the SettingsModal toggle path)", async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useWorktrunkInstallStatus("p1", { enabled }),
      { initialProps: { enabled: false } },
    );
    // No probe while disabled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    // Toggling on triggers exactly one probe.
    rerender({ enabled: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/worktrunk/status");
  });
});
