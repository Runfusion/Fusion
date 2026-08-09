// @vitest-environment node

import express, { type Request } from "express";
import { describe, expect, it } from "vitest";
import { createAuthMiddleware } from "../auth-middleware.js";
import { resolveRequestActor } from "../request-actor.js";
import { request } from "../test-request.js";

function createApp(token?: string) {
  const app = express();
  app.use(express.json());
  if (token) app.use(createAuthMiddleware(token));
  app.post("/api/actor", (req, res) => res.json(resolveRequestActor(req as Request)));
  return app;
}

describe("resolveRequestActor", () => {
  it("reports only middleware-verified daemon credentials", async () => {
    const app = createApp("shared-token");

    const header = await request(app, "POST", "/api/actor", "{}", { authorization: "Bearer shared-token", "Content-Type": "application/json" });
    const query = await request(app, "POST", "/api/actor?fn_token=shared-token", "{}", { "Content-Type": "application/json" });
    const rejected = await request(app, "POST", "/api/actor", "{}", { authorization: "Bearer invalid", "Content-Type": "application/json" });

    expect(header.body).toEqual({ kind: "api", id: "http:verified-token" });
    expect(query.body).toEqual({ kind: "api", id: "http:verified-token" });
    expect(rejected.status).toBe(401);
  });

  it("does not upgrade attribution from unverified client input", async () => {
    const app = createApp();
    const arbitraryHeader = "Bearer attacker-controlled-token";

    const noCredential = await request(app, "POST", "/api/actor", "{}", { "Content-Type": "application/json" });
    const header = await request(app, "POST", "/api/actor", JSON.stringify({ verifiedDaemonRequest: true }), { authorization: arbitraryHeader, "Content-Type": "application/json", "x-verified-daemon-request": "true" });
    const query = await request(app, "POST", "/api/actor?fn_token=attacker-controlled-token", "{}", { "Content-Type": "application/json" });

    expect(noCredential.body).toEqual({ kind: "api", id: "http:unverified" });
    expect(header.body).toEqual({ kind: "api", id: "http:unverified" });
    expect(query.body).toEqual({ kind: "api", id: "http:unverified" });
    for (const actor of [noCredential.body, header.body, query.body]) {
      expect(actor.kind).not.toBe("human");
      expect(JSON.stringify(actor)).not.toContain("attacker-controlled-token");
    }
  });
});
