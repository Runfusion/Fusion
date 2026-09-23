import { describe, expect, it } from "vitest";
import { externalSessionCursorAfter, externalSessionListQuerySchema, externalSessionPageCursor } from "../external-sessions/read-contract.js";

describe("remote-session page contract", () => {
  it("bounds page size and rejects ambiguous filters and unbounded cursors", () => {
    expect(externalSessionListQuerySchema.parse({})).toEqual({ limit: 50 });
    for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { hostId: ["a", "b"] },
      { provider: " padded " }, { cursor: "a".repeat(2049) }, { unexpected: true }]) {
      expect(externalSessionListQuerySchema.safeParse(query).success).toBe(false);
    }
  });
  it("binds cursor identity to the project and exact filters while allowing a different page size", () => {
    const query = { hostId: "host-a", provider: "runtime", limit: 2 };
    const id = "a".repeat(64);
    const cursor = externalSessionPageCursor("project-a", query, id);
    expect(externalSessionCursorAfter("project-a", { ...query, limit: 1, cursor })).toBe(id);
    for (const [project, filters] of [["project-b", query], ["project-a", { ...query, hostId: "host-b" }],
      ["project-a", { provider: "runtime" }], ["project-a", { ...query, provider: "other" }]] as const) {
      expect(() => externalSessionCursorAfter(project, { ...filters, cursor })).toThrow("scope mismatch");
    }
  });
  it("rejects malformed, structurally invalid and unsupported-version cursors", () => {
    for (const cursor of ["a", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({
      schemaVersion: 2, projectId: "project", afterId: "a".repeat(64) })).toString("base64url")]) {
      expect(() => externalSessionCursorAfter("project", { cursor })).toThrow();
    }
    expect(externalSessionCursorAfter("project", {})).toBeUndefined();
  });
});
