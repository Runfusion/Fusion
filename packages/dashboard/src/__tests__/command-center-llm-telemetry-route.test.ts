import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveLlmTelemetryWindow } from "../routes/register-command-center-routes.js";

/*
FNXC:LaneTelemetry 2026-11-04-05:09:
RUFU-284 (R1/R5): the LLM-telemetry route is a THIRD accounting source beside `/command-center/tokens`,
so the two things worth pinning cheaply are (a) the window vocabulary the panel and the server agree on,
and (b) the wiring — that the route reads through `aggregateLlmLaneTelemetry` on the async layer rather
than reaching for the token aggregators, which would silently sum two accounting systems.
Driving the real aggregation needs PostgreSQL and is covered by `lane-usage-analytics.test.ts` in core;
the route half is wiring, and is labelled as such here in the style of
`command-center-analytics-column-flags.test.ts`.
*/

function query(window?: unknown): { window: unknown } {
  return { window };
}

describe("RUFU-284 command-center llm-telemetry route", () => {
  it("defaults an absent or unknown window to 1h, matching every other Command Center resolver", () => {
    expect(resolveLlmTelemetryWindow(query(undefined) as never)).toBe("1h");
    expect(resolveLlmTelemetryWindow(query("7d") as never)).toBe("1h");
    expect(resolveLlmTelemetryWindow(query(undefined) as never)).toBe("1h");
  });

  it("accepts exactly the two short windows the panel offers", () => {
    expect(resolveLlmTelemetryWindow(query("10m") as never)).toBe("10m");
    expect(resolveLlmTelemetryWindow(query("1h") as never)).toBe("1h");
  });

  it("is registered on the command-center path and reads the usage-event aggregate", () => {
    const source = readFileSync(new URL("../routes/register-command-center-routes.ts", import.meta.url), "utf8");

    expect(source).toContain('router.get("/command-center/llm-telemetry"');
    expect(source).toContain("aggregateLlmLaneTelemetry(");
    // Wiring proof: a route that forgot the resolver would silently serve 1h for ?window=10m.
    expect(source).toMatch(/resolveLlmTelemetryWindow\(req\.query\)[\s\S]{0,240}aggregateLlmLaneTelemetry/);
  });

  it("keeps the two accounting sources in separate handlers so nothing can sum them", () => {
    /*
    FNXC:LaneTelemetry 2026-11-04-07:30 (R1):
    "Never summed with the task/chat totals" is only true while neither handler reads the other's source.
    One cross-reference would double-count the same spend and the panel would print it as a single number,
    so the separation is pinned as a call-site rule over the real route module.
    */
    const source = readFileSync(new URL("../routes/register-command-center-routes.ts", import.meta.url), "utf8");
    const tokensAt = source.indexOf('router.get("/command-center/tokens"');
    const llmAt = source.indexOf('router.get("/command-center/llm-telemetry"');
    const nextRouteAfterLlm = source.indexOf("router.get(", llmAt + 10);
    const tokensHandler = source.slice(tokensAt, llmAt);
    const llmHandler = source.slice(llmAt, nextRouteAfterLlm);

    // The spend handler must not reach into usage_events...
    expect(tokensHandler).not.toContain("aggregateLlmLaneTelemetry");
    // ...and the telemetry handler must not reach into the token columns.
    expect(llmHandler).not.toContain("aggregateTokenAnalytics");
    // Both symbols are still used somewhere, so the split is real and not one route having been deleted.
    expect(source).toContain("aggregateTokenAnalytics(");
  });
});
