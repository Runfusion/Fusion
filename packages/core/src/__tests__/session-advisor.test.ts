import { describe, expect, it } from "vitest";
import { resolveTaskSessionAdvisorEnabled } from "../agents/session-advisor.js";

describe("resolveTaskSessionAdvisorEnabled", () => {
  it("defaults to off when nothing is set", () => {
    expect(resolveTaskSessionAdvisorEnabled({})).toEqual({
      enabled: false,
      source: "default",
    });
  });

  it("uses project default when task has no override", () => {
    expect(
      resolveTaskSessionAdvisorEnabled({}, { sessionAdvisorEnabledByDefault: true }),
    ).toEqual({ enabled: true, source: "project" });
    expect(
      resolveTaskSessionAdvisorEnabled({}, { sessionAdvisorEnabledByDefault: false }),
    ).toEqual({ enabled: false, source: "default" });
  });

  it("task override wins over project and workflow", () => {
    expect(
      resolveTaskSessionAdvisorEnabled(
        { sessionAdvisorEnabled: false },
        { sessionAdvisorEnabledByDefault: true },
        true,
      ),
    ).toEqual({ enabled: false, source: "task" });
    expect(
      resolveTaskSessionAdvisorEnabled(
        { sessionAdvisorEnabled: true },
        { sessionAdvisorEnabledByDefault: false },
        false,
      ),
    ).toEqual({ enabled: true, source: "task" });
  });

  it("falls back to workflow flag for backward compatibility", () => {
    expect(
      resolveTaskSessionAdvisorEnabled({}, { sessionAdvisorEnabledByDefault: false }, true),
    ).toEqual({ enabled: true, source: "workflow" });
  });

  it("project true wins over workflow false", () => {
    expect(
      resolveTaskSessionAdvisorEnabled({}, { sessionAdvisorEnabledByDefault: true }, false),
    ).toEqual({ enabled: true, source: "project" });
  });
});
