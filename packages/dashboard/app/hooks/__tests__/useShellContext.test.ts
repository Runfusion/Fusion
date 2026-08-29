import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useShellContext } from "../useShellContext";

const mockUseNativeShellContext = vi.fn();

vi.mock("../../context/ShellContext", () => ({
  useShellContext: () => mockUseNativeShellContext(),
}));

describe("useShellContext", () => {
  it("returns shell context from URL handoff when present", () => {
    window.history.replaceState({}, "", "/?shellKind=desktop&shellMode=remote&profileId=p1&serverBaseUrl=https://remote.example.com");
    mockUseNativeShellContext.mockReturnValue({
      state: { host: "web", activeProfileId: null, profiles: [] },
    });

    const { result } = renderHook(() => useShellContext());

    expect(result.current.shellContext).toMatchObject({
      shellKind: "desktop",
      shellMode: "remote",
      profileId: "p1",
      serverBaseUrl: "https://remote.example.com",
    });
    expect(result.current.isDesktopShell).toBe(true);
  });

  it("falls back to normalized desktop local shell context", () => {
    window.history.replaceState({}, "", "/");
    mockUseNativeShellContext.mockReturnValue({
      state: { host: "desktop-shell", desktopMode: "local", activeProfileId: null, profiles: [] },
    });

    const { result } = renderHook(() => useShellContext());

    expect(result.current.shellContext).toEqual({
      shellKind: "desktop",
      shellMode: "local",
      capabilities: { canOpenConnectionManager: true },
    });
  });

  it("returns null context in plain browser sessions", () => {
    window.history.replaceState({}, "", "/");
    mockUseNativeShellContext.mockReturnValue({
      state: { host: "web", activeProfileId: null, profiles: [] },
    });

    const { result } = renderHook(() => useShellContext());

    expect(result.current.shellContext).toBeNull();
    expect(result.current.isDesktopShell).toBe(false);
    expect(result.current.isMobileShell).toBe(false);
  });
});
