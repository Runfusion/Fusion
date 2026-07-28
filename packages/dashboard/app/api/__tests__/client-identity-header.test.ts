/*
FNXC:TaskDeleteAttribution 2026-07-26-14:30:
Client half of the delete-attribution invariant. The server can only label a request `operator-ui`
if the dashboard actually sends `x-fusion-client: dashboard-ui`; without this the UI's own Delete
click would report as `api-unattributed` and the four-delete incident would still be unattributable.

Asserted centrally (on `api()`, not on `deleteTask`) because that is where the header is set —
covering the authenticated and unauthenticated branches, the with-caller-headers case, and the
task-delete call itself so no future route has to remember the header.
*/

import { afterEach, describe, expect, it, vi } from "vitest";
import { FUSION_CLIENT_HEADER, FUSION_DASHBOARD_UI_CLIENT } from "@fusion/core";
import { api } from "../client";
import { deleteTask } from "../tasks-lifecycle";
import * as auth from "../../auth";

function mockFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

function sentHeaders(spy: ReturnType<typeof mockFetch>): Headers {
  const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers ?? {});
}

describe("dashboard API client identity header", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stamps the dashboard-ui client header on unauthenticated requests", async () => {
    vi.spyOn(auth, "getAuthToken").mockReturnValue(undefined);
    const spy = mockFetch();

    await api("/tasks");

    expect(sentHeaders(spy).get(FUSION_CLIENT_HEADER)).toBe(FUSION_DASHBOARD_UI_CLIENT);
  });

  it("stamps the client header on authenticated requests too", async () => {
    vi.spyOn(auth, "getAuthToken").mockReturnValue("token-1");
    const spy = mockFetch();

    await api("/tasks");

    expect(sentHeaders(spy).get(FUSION_CLIENT_HEADER)).toBe(FUSION_DASHBOARD_UI_CLIENT);
  });

  it("keeps the client header when the caller supplies its own headers", async () => {
    vi.spyOn(auth, "getAuthToken").mockReturnValue(undefined);
    const spy = mockFetch();

    await api("/tasks", { method: "POST", headers: { "X-Custom": "1" } });

    const headers = sentHeaders(spy);
    expect(headers.get(FUSION_CLIENT_HEADER)).toBe(FUSION_DASHBOARD_UI_CLIENT);
    expect(headers.get("X-Custom")).toBe("1");
  });

  it("sends the client header on the task delete call (the surface that was unattributable)", async () => {
    vi.spyOn(auth, "getAuthToken").mockReturnValue(undefined);
    const spy = mockFetch();

    await deleteTask("FN-8600");

    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("DELETE");
    expect(sentHeaders(spy).get(FUSION_CLIENT_HEADER)).toBe(FUSION_DASHBOARD_UI_CLIENT);
  });
});
