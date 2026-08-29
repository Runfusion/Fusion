import { describe, expect, it, vi } from "vitest";

import type { AiSessionSummary } from "../../api";
import {
  buildRemoteDashboardUrl,
  shouldShowSessionInBanner,
  isSessionNeedingInputForBanner,
  resolveDesktopShellRedirectTarget,
  executeCliSessionBannerAction,
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

/*
FNXC:WorkflowLifecycleColumns 2026-08-01-02:10:

THE INVARIANT: the CLI-session banner's Cancel returns the card to ITS OWN hold lane.

CENSUS-INVISIBLE IN TWO WAYS AT ONCE — the literal lived in a call argument AND in the dep's TYPE
(`moveTask: (id: string, column: "todo")`), so the signature itself prevented any caller from passing
anything else. No scan for comparisons could reach either.

Post-U12 the rejection in `moves.ts` is live: a move to a column the workflow does not declare throws
"Unknown column for this workflow" unless the caller sets `recoveryRehome`, which this is not. So on a
renamed board **Cancel threw instead of cancelling** — an operator-facing button that fails.

WIRED, NOT OPTIONAL. `App.tsx` supplies `resolveCancelColumn` from the board-workflow metadata it
already holds. An optional parameter no caller fills is the inert shape this program has found five
times; adding a sixth to fix a broken button would have been worse than leaving it.

REVERT PROOF, measured: restore the hardcoded `"todo"` and the renamed case moves to `todo` instead of
the board's own hold lane.
*/
describe("CLI banner cancel resolves the board's own hold lane", () => {
  const baseDeps = () => ({
    retryTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    openAuthenticationSettings: vi.fn(),
    addToast: vi.fn(),
  });

  it("moves to the RENAMED hold lane when the caller resolves one", async () => {
    const deps = { ...baseDeps(), resolveCancelColumn: () => "backlog" };

    await executeCliSessionBannerAction({ id: "FN-1" } as never, "cancel", deps as never);

    expect(deps.moveTask).toHaveBeenCalledWith("FN-1", "backlog");
  });

  it("keeps the legacy destination when metadata has not resolved", async () => {
    // Board-workflow metadata is absent on first paint and for remote projects; the documented
    // fallback must stay exactly today's behaviour rather than refusing to cancel.
    const deps = { ...baseDeps(), resolveCancelColumn: () => undefined };

    await executeCliSessionBannerAction({ id: "FN-2" } as never, "cancel", deps as never);

    expect(deps.moveTask).toHaveBeenCalledWith("FN-2", "todo");
  });

  it("keeps the legacy destination when no resolver is supplied at all", async () => {
    const deps = baseDeps();

    await executeCliSessionBannerAction({ id: "FN-3" } as never, "cancel", deps as never);

    expect(deps.moveTask).toHaveBeenCalledWith("FN-3", "todo");
  });
});
