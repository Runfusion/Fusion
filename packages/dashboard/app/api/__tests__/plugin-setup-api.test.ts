import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPluginSetupStatus, installPluginSetup } from "../../api";

describe("plugin setup API helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetchPluginSetupStatus calls setup-status endpoint with encoded id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ hasSetup: true, status: "installed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await fetchPluginSetupStatus("plugin/id");

    expect(result).toEqual({ hasSetup: true, status: "installed" });
    /*
    FNXC:TaskDeleteAttribution 2026-07-30-06:20:
    Header keys are LOWERCASE and now include the client stamp. `app/api/client.ts` builds request
    headers through a `Headers` object (which lower-cases every key) and sets
    `x-fusion-client: dashboard-ui` on every dashboard-originated request so the server can attribute
    the caller — the FN-8609 delete-attribution surface.

    This asserted `"Content-Type"`, and `objectContaining` compares keys case-SENSITIVELY, so it broke
    on the casing alone. Rather than just lower-casing the key, this now pins the client stamp too:
    that header is the point of the feature, and nothing else in this file covered it.
    */
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/plugins/plugin%2Fid/setup-status",
      expect.objectContaining({
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-fusion-client": "dashboard-ui",
        }),
      }),
    );
  });

  it("fetchPluginSetupStatus includes projectId query parameter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ hasSetup: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await fetchPluginSetupStatus("my-plugin", "project/one");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/plugins/my-plugin/setup-status?projectId=project%2Fone",
      expect.any(Object),
    );
  });

  it("installPluginSetup posts to setup install endpoint and supports project scope", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await installPluginSetup("my plugin", "proj");

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/plugins/my%20plugin/setup/install?projectId=proj",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
