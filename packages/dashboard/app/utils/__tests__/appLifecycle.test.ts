import { describe, expect, it } from "vitest";

import { buildRemoteDashboardUrl, resolveDesktopShellRedirectTarget } from "../appLifecycle";

describe("resolveDesktopShellRedirectTarget", () => {
  const remoteProfile = {
    id: "remote-1",
    serverUrl: "https://fusionstudio:4040",
    authToken: "tok-123",
  };

  it("returns null for non-desktop-shell hosts", () => {
    expect(
      resolveDesktopShellRedirectTarget(
        {
          host: "web",
          desktopMode: "local",
          activeProfileId: null,
          profiles: [],
          localRuntime: { state: "running", baseUrl: "http://127.0.0.1:50123" },
        },
        "https://fusionstudio:4040/",
      ),
    ).toBeNull();

    expect(
      resolveDesktopShellRedirectTarget(
        {
          host: "mobile-shell",
          desktopMode: "local",
          activeProfileId: null,
          profiles: [],
          localRuntime: { state: "running", baseUrl: "http://127.0.0.1:50123" },
        },
        "https://fusionstudio:4040/",
      ),
    ).toBeNull();
  });

  it("returns null when desktopMode is undefined", () => {
    expect(
      resolveDesktopShellRedirectTarget(
        {
          host: "desktop-shell",
          activeProfileId: null,
          profiles: [],
        },
        "https://fusionstudio:4040/",
      ),
    ).toBeNull();
  });

  it("resolves the local runtime origin (baseUrl) when switching remote -> local", () => {
    const target = resolveDesktopShellRedirectTarget(
      {
        host: "desktop-shell",
        desktopMode: "local",
        activeProfileId: "remote-1",
        profiles: [remoteProfile],
        localRuntime: { state: "running", baseUrl: "http://127.0.0.1:50123", port: 50123 },
      },
      "https://fusionstudio:4040/",
    );
    expect(target).toBe("http://127.0.0.1:50123");
  });

  it("falls back to localhost:<port> when localRuntime has no baseUrl", () => {
    const target = resolveDesktopShellRedirectTarget(
      {
        host: "desktop-shell",
        desktopMode: "local",
        activeProfileId: null,
        profiles: [],
        localRuntime: { state: "running", port: 50123 },
      },
      "https://fusionstudio:4040/",
    );
    expect(target).toBe("http://localhost:50123");
  });

  it("returns null when the local runtime is not running", () => {
    for (const state of ["stopped", "starting", "error"] as const) {
      expect(
        resolveDesktopShellRedirectTarget(
          {
            host: "desktop-shell",
            desktopMode: "local",
            activeProfileId: null,
            profiles: [],
            localRuntime: { state, baseUrl: "http://127.0.0.1:50123" },
          },
          "https://fusionstudio:4040/",
        ),
      ).toBeNull();
    }

    expect(
      resolveDesktopShellRedirectTarget(
        {
          host: "desktop-shell",
          desktopMode: "local",
          activeProfileId: null,
          profiles: [],
          localRuntime: undefined,
        },
        "https://fusionstudio:4040/",
      ),
    ).toBeNull();
  });

  it("returns null when already on the local runtime origin", () => {
    expect(
      resolveDesktopShellRedirectTarget(
        {
          host: "desktop-shell",
          desktopMode: "local",
          activeProfileId: null,
          profiles: [],
          localRuntime: { state: "running", baseUrl: "http://127.0.0.1:50123" },
        },
        "http://127.0.0.1:50123/",
      ),
    ).toBeNull();
  });

  it("resolves buildRemoteDashboardUrl(...) when switching local -> a remote profile", () => {
    const target = resolveDesktopShellRedirectTarget(
      {
        host: "desktop-shell",
        desktopMode: "remote",
        activeProfileId: "remote-1",
        profiles: [remoteProfile],
        localRuntime: { state: "stopped" },
      },
      "http://127.0.0.1:50123/",
    );
    expect(target).toBe(buildRemoteDashboardUrl(remoteProfile.serverUrl, remoteProfile.authToken));
  });

  it("returns null when already on the target remote url", () => {
    const nextUrl = buildRemoteDashboardUrl(remoteProfile.serverUrl, remoteProfile.authToken);
    expect(
      resolveDesktopShellRedirectTarget(
        {
          host: "desktop-shell",
          desktopMode: "remote",
          activeProfileId: "remote-1",
          profiles: [remoteProfile],
        },
        nextUrl,
      ),
    ).toBeNull();
  });

  it("returns null when there is no matching/active profile", () => {
    expect(
      resolveDesktopShellRedirectTarget(
        {
          host: "desktop-shell",
          desktopMode: "remote",
          activeProfileId: null,
          profiles: [remoteProfile],
        },
        "http://127.0.0.1:50123/",
      ),
    ).toBeNull();

    expect(
      resolveDesktopShellRedirectTarget(
        {
          host: "desktop-shell",
          desktopMode: "remote",
          activeProfileId: "missing",
          profiles: [remoteProfile],
        },
        "http://127.0.0.1:50123/",
      ),
    ).toBeNull();
  });
});
