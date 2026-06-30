import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadAuthModule() {
  vi.resetModules();
  return import("../auth");
}

async function loadShellContextModule() {
  return import("../shell-context");
}

describe("shell handoff contract", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("builds and parses a valid remote launch", async () => {
    const {
      buildRemoteShellLaunchUrl,
      parseRemoteShellLaunchFromUrl,
      SHELL_TOKEN_PARAM,
      SHELL_KIND_PARAM,
      SHELL_MODE_PARAM,
      SHELL_PROFILE_ID_PARAM,
      SHELL_SERVER_BASE_URL_PARAM,
    } = await loadShellContextModule();

    const launchUrl = buildRemoteShellLaunchUrl({
      shellKind: "desktop",
      shellMode: "remote",
      profileId: "profile_1",
      serverBaseUrl: "https://remote.example.com/",
      serverLabel: "Remote A",
      token: "daemon-token",
      capabilities: { canOpenConnectionManager: true },
    });

    const parsedUrl = new URL(launchUrl);
    expect(parsedUrl.searchParams.get(SHELL_KIND_PARAM)).toBe("desktop");
    expect(parsedUrl.searchParams.get(SHELL_MODE_PARAM)).toBe("remote");
    expect(parsedUrl.searchParams.get(SHELL_PROFILE_ID_PARAM)).toBe("profile_1");
    expect(parsedUrl.searchParams.get(SHELL_SERVER_BASE_URL_PARAM)).toBe("https://remote.example.com");
    expect(parsedUrl.searchParams.get(SHELL_TOKEN_PARAM)).toBe("daemon-token");

    expect(parseRemoteShellLaunchFromUrl(launchUrl)).toEqual({
      shellKind: "desktop",
      shellMode: "remote",
      profileId: "profile_1",
      serverBaseUrl: "https://remote.example.com",
      serverLabel: "Remote A",
      token: "daemon-token",
      capabilities: { canOpenConnectionManager: true },
    });
  });

  it("rejects malformed or partial remote launch data", async () => {
    const { parseRemoteShellLaunchFromUrl } = await loadShellContextModule();

    expect(
      parseRemoteShellLaunchFromUrl(
        "https://remote.example.com/?shellKind=desktop&shellMode=remote&profileId=abc",
      ),
    ).toBeNull();

    expect(
      parseRemoteShellLaunchFromUrl(
        "https://remote.example.com/?shellKind=desktop&shellMode=remote&serverBaseUrl=https://remote.example.com",
      ),
    ).toBeNull();

    expect(
      parseRemoteShellLaunchFromUrl(
        "https://remote.example.com/?shellKind=unknown&shellMode=remote&profileId=abc&serverBaseUrl=https://remote.example.com",
      ),
    ).toBeNull();
  });
});

describe("auth helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("captures token from ?token= and cleans URL while preserving other params/hash", async () => {
    window.history.replaceState({}, "", "/dashboard?token=daemon-123&view=board&shellKind=desktop#focus");

    const { getAuthToken } = await loadAuthModule();

    expect(getAuthToken()).toBe("daemon-123");
    expect(window.localStorage.getItem("fn.authToken")).toBe("daemon-123");
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/dashboard?view=board&shellKind=desktop#focus",
    );
  });

  it("appends fn_token for same-origin API URLs and same-host websocket URLs", async () => {
    window.localStorage.setItem("fn.authToken", "daemon-abc");

    const { appendTokenQuery, QUERY_TOKEN_PARAM } = await loadAuthModule();

    expect(appendTokenQuery("/api/tasks?limit=1")).toBe(
      `/api/tasks?limit=1&${QUERY_TOKEN_PARAM}=daemon-abc`,
    );

    const wsUrl = `ws://${window.location.host}/api/events`;
    expect(appendTokenQuery(wsUrl)).toBe(`${wsUrl}?${QUERY_TOKEN_PARAM}=daemon-abc`);
  });

  it("does not append fn_token for cross-origin URLs", async () => {
    window.localStorage.setItem("fn.authToken", "daemon-abc");

    const { appendTokenQuery } = await loadAuthModule();

    const externalOAuth = "https://auth.provider.example/oauth/start?client_id=test";
    expect(appendTokenQuery(externalOAuth)).toBe(externalOAuth);
  });

  it("withTokenHeader adds bearer token without overwriting explicit Authorization", async () => {
    window.localStorage.setItem("fn.authToken", "daemon-xyz");

    const { withTokenHeader } = await loadAuthModule();

    const merged = new Headers(withTokenHeader({ "X-Test": "1" }));
    expect(merged.get("Authorization")).toBe("Bearer daemon-xyz");
    expect(merged.get("X-Test")).toBe("1");

    const explicit = new Headers(withTokenHeader({ Authorization: "Bearer pre-signed" }));
    expect(explicit.get("Authorization")).toBe("Bearer pre-signed");
  });

  it("returns original headers when no token is available", async () => {
    const { withTokenHeader } = await loadAuthModule();

    const original = { "X-Test": "no-token" };
    expect(withTokenHeader(original)).toBe(original);
  });
});

describe("installAuthFetch", () => {
  const originalFetch = window.fetch;

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    window.fetch = originalFetch;
    delete (window as Window & { __fnAuthFetchInstalled?: boolean }).__fnAuthFetchInstalled;
  });

  it("injects Authorization only for same-origin /api requests", async () => {
    window.localStorage.setItem("fn.authToken", "daemon-token");
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ auth: headers.get("Authorization") }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    window.fetch = fetchSpy as unknown as typeof window.fetch;

    const { installAuthFetch } = await loadAuthModule();
    installAuthFetch();

    const apiResponse = await fetch("/api/tasks");
    expect(await apiResponse.json()).toEqual({ auth: "Bearer daemon-token" });

    await fetch("https://example.com/api/tasks");
    const crossOriginHeaders = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers);
    expect(crossOriginHeaders.get("Authorization")).toBeNull();
  });

  it("fires the daemon auth recovery signal only for daemon auth 401 payloads and dedupes repeats", async () => {
    window.localStorage.setItem("fn.authToken", "stale-token");
    window.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: "Unauthorized", message: "Valid bearer token required" }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof window.fetch;

    const { installAuthFetch, AUTH_TOKEN_RECOVERY_REQUIRED_EVENT } = await loadAuthModule();
    installAuthFetch();

    const eventHandler = vi.fn();
    window.addEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, eventHandler);

    const first = await fetch("/api/tasks");
    expect(await first.json()).toEqual({ error: "Unauthorized", message: "Valid bearer token required" });
    await vi.waitFor(() => {
      expect(eventHandler).toHaveBeenCalledTimes(1);
    });

    await fetch("/api/tasks?next=1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(eventHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, eventHandler);
  });

  it("fires recovery only for the exact daemon-auth 401 shape on same-origin /api requests", async () => {
    window.localStorage.setItem("fn.authToken", "stale-token");
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const payload = url.includes("project-auth")
        ? { error: "Unauthorized", message: "Project auth required" }
        : { error: "Unauthorized", message: "Valid bearer token required" };

      return new Response(JSON.stringify(payload), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    window.fetch = fetchSpy as unknown as typeof window.fetch;

    const { installAuthFetch, AUTH_TOKEN_RECOVERY_REQUIRED_EVENT } = await loadAuthModule();
    installAuthFetch();

    const eventHandler = vi.fn();
    window.addEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, eventHandler);

    await fetch("https://example.com/api/tasks");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(eventHandler).not.toHaveBeenCalled();

    const projectAuthResponse = await fetch("/api/project-auth");
    expect(await projectAuthResponse.json()).toEqual({ error: "Unauthorized", message: "Project auth required" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(eventHandler).not.toHaveBeenCalled();

    const daemonAuthResponse = await fetch("/api/tasks");
    expect(await daemonAuthResponse.json()).toEqual({ error: "Unauthorized", message: "Valid bearer token required" });
    await vi.waitFor(() => {
      expect(eventHandler).toHaveBeenCalledTimes(1);
    });

    window.removeEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, eventHandler);
  });

  it("is idempotent and only installs one fetch wrapper", async () => {
    window.localStorage.setItem("fn.authToken", "daemon-token");
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok", { status: 200 }));
    window.fetch = fetchSpy as unknown as typeof window.fetch;

    const { installAuthFetch } = await loadAuthModule();
    installAuthFetch();
    installAuthFetch();

    await fetch("/api/tasks");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer daemon-token");
  });
});
