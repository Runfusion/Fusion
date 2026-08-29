import { describe, expect, it, vi } from "vitest";
import { createTransportRoutes } from "../routes/transport-routes.js";

describe("transport routes", () => {
  it("requires api key", async () => {
    const routes = createTransportRoutes(() => undefined);
    const route = routes.find((entry) => entry.path === "/transport/actions");
    const res = await route?.handler({ headers: {} }, { settings: {}, pluginId: "p" } as never);
    expect(res).toMatchObject({ status: 503 });
  });

  it("accepts action payloads", async () => {
    const receiveAction = vi.fn(async () => undefined);
    const routes = createTransportRoutes(() => ({ receiveAction } as never));
    const route = routes.find((entry) => entry.path === "/transport/actions");

    const res = await route?.handler(
      {
        headers: { authorization: "Bearer key" },
        body: { type: "start-work", taskId: "FN-1", timestamp: new Date().toISOString() },
      },
      { settings: { apiKey: "key" }, pluginId: "p" } as never,
    );

    expect(res).toMatchObject({ status: 202, body: { accepted: true } });
    expect(receiveAction).toHaveBeenCalledTimes(1);
  });
});
