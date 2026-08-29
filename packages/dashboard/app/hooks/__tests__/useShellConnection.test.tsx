import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useShellConnection } from "../useShellConnection";

const { mockUseShellContext } = vi.hoisted(() => ({
  mockUseShellContext: vi.fn(),
}));

vi.mock("../../context/ShellContext", () => ({
  useShellContext: mockUseShellContext,
}));

describe("useShellConnection", () => {
  it("normalizes invalid active profile and exposes helper actions", async () => {
    const shellApi = {
      saveProfile: vi.fn(async () => ({ id: "p1", name: "Prod", serverUrl: "https://fusion.example.com", createdAt: "", updatedAt: "" })),
      deleteProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => ({ host: "mobile-shell", activeProfileId: "p1", profiles: [] })),
    };

    mockUseShellContext.mockReturnValue({
      shellApi,
      ready: true,
      openConnectionManagerSignal: 0,
      state: {
        host: "mobile-shell",
        activeProfileId: "missing",
        profiles: [{ id: "p1", name: "Prod", serverUrl: "https://fusion.example.com", createdAt: "", updatedAt: "" }],
      },
    });

    const { result } = renderHook(() => useShellConnection());
    expect(result.current.state.activeProfileId).toBeNull();

    await result.current.saveProfile({ name: "Prod", serverUrl: "https://fusion.example.com" });
    await result.current.removeProfile("p1");
    await result.current.setActiveProfile("p1");

    expect(shellApi.saveProfile).toHaveBeenCalled();
    expect(shellApi.deleteProfile).toHaveBeenCalledWith("p1");
    expect(shellApi.setActiveProfile).toHaveBeenCalledWith("p1");
  });

  it("keeps browser mode stable", async () => {
    mockUseShellContext.mockReturnValue({
      shellApi: null,
      ready: true,
      openConnectionManagerSignal: 0,
      state: { host: "web", activeProfileId: null, profiles: [] },
    });

    const { result } = renderHook(() => useShellConnection());
    await expect(result.current.saveProfile({ name: "Prod", serverUrl: "https://fusion.example.com" })).rejects.toThrow(
      "Saving connection profiles is only available in native shell mode",
    );
  });
});
