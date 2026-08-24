import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __test_resetPendingUpdateInstall, pendingUpdateInstallState, usePendingUpdateInstall } from "../usePendingUpdateInstall";
import * as api from "../../api";

vi.mock("../../api", () => ({ checkForUpdate: vi.fn() }));
const checkForUpdate = vi.mocked(api.checkForUpdate);
const pending = { currentVersion: "1.0.0", latestVersion: "2.0.0", updated: true, outcome: "installed" as const };

describe("pendingUpdateInstallState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __test_resetPendingUpdateInstall();
  });

  it("hydrates once for simultaneous consumers and retains a successful target across remount", async () => {
    checkForUpdate.mockResolvedValue({ currentVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: true, pendingInstall: pending });
    const first = renderHook(() => usePendingUpdateInstall());
    const second = renderHook(() => usePendingUpdateInstall());
    await waitFor(() => expect(first.result.current).toMatchObject(pending));
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    first.unmount();
    second.unmount();
    const remount = renderHook(() => usePendingUpdateInstall({ hydrate: false }));
    expect(remount.result.current).toMatchObject(pending);
  });

  it("keeps a late successful install after an initiating component unmounts and ignores stale empty reads", async () => {
    let resolve!: (value: { currentVersion: string; latestVersion: string | null; updateAvailable: boolean }) => void;
    checkForUpdate.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const mounted = renderHook(() => usePendingUpdateInstall());
    mounted.unmount();
    act(() => pendingUpdateInstallState.record(pending));
    await act(async () => { resolve({ currentVersion: "1.0.0", latestVersion: null, updateAvailable: false }); });
    expect(pendingUpdateInstallState.getSnapshot()).toMatchObject(pending);
  });

  it("rejects malformed and unsuccessful payloads", () => {
    act(() => pendingUpdateInstallState.record({ updated: true }));
    expect(pendingUpdateInstallState.getSnapshot()).toBeUndefined();
    act(() => pendingUpdateInstallState.record({ ...pending, updated: false }));
    expect(pendingUpdateInstallState.getSnapshot()).toBeUndefined();
  });
});
