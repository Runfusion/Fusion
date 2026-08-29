import { describe, expect, it } from "vitest";
import { validateProjectNodeMapping } from "../project/node-dispatch-validation.js";

describe("validateProjectNodeMapping", () => {
  it("allows dispatch when mapping path is present", () => {
    expect(
      validateProjectNodeMapping({ nodeId: "node-1", mappedPath: "/work/project" }),
    ).toEqual({ allowed: true });
  });

  it("blocks dispatch when mapping is missing or blank", () => {
    expect(
      validateProjectNodeMapping({ nodeId: "node-1", mappedPath: undefined }),
    ).toEqual({
      allowed: false,
      code: "missing-project-mapping",
      reason: "Execution blocked: project has no path mapping for node node-1",
    });

    expect(
      validateProjectNodeMapping({ nodeId: "node-1", mappedPath: "   " }),
    ).toEqual({
      allowed: false,
      code: "missing-project-mapping",
      reason: "Execution blocked: project has no path mapping for node node-1",
    });
  });
});
