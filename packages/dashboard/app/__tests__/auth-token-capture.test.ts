import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadAuthModule() {
  vi.resetModules();
  return import("../auth");
}

describe("remote login token capture", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("replaces an existing dashboard token with the remote-login handoff token", async () => {
    window.localStorage.setItem("fn.authToken", "old-dashboard-token");
    window.history.replaceState({}, "", "/?token=remote-daemon-token");
    const { getAuthToken, installAuthFetch } = await loadAuthModule();
    const fetch = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", fetch);

    expect(getAuthToken()).toBe("remote-daemon-token");
    expect(window.localStorage.getItem("fn.authToken")).toBe("remote-daemon-token");
    installAuthFetch();
    await window.fetch("/api/settings");

    expect(fetch).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
      headers: expect.any(Headers),
    }));
    expect((fetch.mock.calls[0]?.[1] as RequestInit).headers as Headers).toHaveProperty("get");
    expect(((fetch.mock.calls[0]?.[1] as RequestInit).headers as Headers).get("Authorization")).toBe("Bearer remote-daemon-token");
  });
});
