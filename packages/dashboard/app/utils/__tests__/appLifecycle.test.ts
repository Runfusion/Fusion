import { describe, expect, it } from "vitest";

import type { AiSessionSummary } from "../../api";
import {
  buildRemoteDashboardUrl,
  shouldShowSessionInBanner,
  isSessionNeedingInputForBanner,
  resolveDesktopShellRedirectTarget,
} from "../appLifecycle";

function makeSession(overrides: Partial<AiSessionSummary> & Pick<AiSessionSummary, "id">): AiSessionSummary {
  return {
    id: overrides.id,
    type: overrides.type ?? "planning",
    status: overrides.status ?? "generating",
    title: overrides.title ?? overrides.id,
    projectId: overrides.projectId ?? null,
    updatedAt: overrides.updatedAt ?? "2026-04-08T00:00:00.000Z",
  };
}

/*
FNXC:SessionBanner 2026-07-16-20:55:
FN-8229 replaces the footer AI pill with the banner for non-planning progress
and actionable states. Planning remains visible only through its docked view
and navigation badge, including retained error sessions.
*/
describe("shouldShowSessionInBanner", () => {
  it("includes non-planning generating, needs-input, and error sessions", () => {
    for (const status of ["generating", "awaiting_input", "error"] as const) {
      expect(shouldShowSessionInBanner(makeSession({ id: status, type: "subtask", status }))).toBe(true);
    }
  });

  it("excludes planning sessions at every status", () => {
    for (const status of ["generating", "awaiting_input", "error"] as const) {
      expect(shouldShowSessionInBanner(makeSession({ id: `planning-${status}`, type: "planning", status }))).toBe(false);
    }
  });

  it("keeps the needs-input predicate separate from generating progress", () => {
    expect(isSessionNeedingInputForBanner(makeSession({ id: "generating", type: "subtask", status: "generating" }))).toBe(false);
  });
});

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
