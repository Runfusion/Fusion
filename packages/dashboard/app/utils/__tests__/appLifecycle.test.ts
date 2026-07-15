import { describe, expect, it } from "vitest";

import type { AiSessionSummary } from "../../api";
import {
  buildRemoteDashboardUrl,
  isPlanningAwaitingInput,
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
FNXC:SessionBanner 2026-07-05-00:00:
Symptom Verification (FN-7614): planning `awaiting_input` sessions must be excluded from the banner feed
(`isSessionNeedingInputForBanner(s) && !isPlanningAwaitingInput(s)`), while planning `error` and non-planning
awaiting-input sessions must remain — this is the invariant the App.tsx `sessionsNeedingInput` filter relies on.
*/
describe("isPlanningAwaitingInput", () => {
  it("is true only for planning sessions awaiting input", () => {
    expect(isPlanningAwaitingInput(makeSession({ id: "p1", type: "planning", status: "awaiting_input" }))).toBe(true);
  });

  it("is false for planning sessions in other statuses", () => {
    expect(isPlanningAwaitingInput(makeSession({ id: "p2", type: "planning", status: "generating" }))).toBe(false);
    expect(isPlanningAwaitingInput(makeSession({ id: "p3", type: "planning", status: "error" }))).toBe(false);
  });

  it("is false for non-planning sessions even when awaiting input", () => {
    expect(isPlanningAwaitingInput(makeSession({ id: "c1", type: "cli-agent", status: "awaiting_input" }))).toBe(false);
  });
});

describe("sessionsNeedingInput banner filter (isSessionNeedingInputForBanner + !isPlanningAwaitingInput)", () => {
  function bannerFilter(sessions: AiSessionSummary[]): AiSessionSummary[] {
    return sessions.filter((s) => isSessionNeedingInputForBanner(s) && !isPlanningAwaitingInput(s));
  }

  it("excludes a lone planning awaiting_input session from the banner feed", () => {
    const sessions = [makeSession({ id: "p1", type: "planning", status: "awaiting_input" })];
    expect(bannerFilter(sessions)).toEqual([]);
  });

  it("keeps planning error sessions in the banner feed", () => {
    const errorSession = makeSession({ id: "p2", type: "planning", status: "error" });
    expect(bannerFilter([errorSession])).toEqual([errorSession]);
  });

  it("keeps non-planning awaiting-input sessions in the banner feed", () => {
    const cliSession = makeSession({ id: "c1", type: "cli-agent", status: "awaiting_input" });
    expect(bannerFilter([cliSession])).toEqual([cliSession]);
  });

  it("excludes planning-awaiting-input while keeping a mixed non-planning awaiting-input session", () => {
    const planningAwaiting = makeSession({ id: "p3", type: "planning", status: "awaiting_input" });
    const cliAwaiting = makeSession({ id: "c2", type: "cli-agent", status: "awaiting_input" });
    expect(bannerFilter([planningAwaiting, cliAwaiting])).toEqual([cliAwaiting]);
  });

  it("excludes generating planning sessions (never in the banner or badge input)", () => {
    const generating = makeSession({ id: "p4", type: "planning", status: "generating" });
    expect(bannerFilter([generating])).toEqual([]);
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
