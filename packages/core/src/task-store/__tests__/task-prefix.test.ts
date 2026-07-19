import { describe, it, expect } from "vitest";
import { resolveTaskPrefix } from "../task-prefix.js";

/*
FNXC:MissionTaskPrefix 2026-07-19-13:15:
Shared helper used by createTaskWithDistributedReservation (FN fallback) and
createTaskBackend (KB fallback). Keep preference order: input → settings → fallback.
*/
describe("resolveTaskPrefix", () => {
  it("prefers a non-empty mission input hint over settings and fallback", () => {
    expect(resolveTaskPrefix(" err ", "FN", "KB")).toBe("ERR");
  });

  it("falls back to settings when the input hint is blank", () => {
    expect(resolveTaskPrefix("  ", "fn-board", "KB")).toBe("FN-BOARD");
    expect(resolveTaskPrefix(undefined, "fn-board", "KB")).toBe("FN-BOARD");
  });

  it("uses the path-specific fallback when neither hint nor settings are set", () => {
    expect(resolveTaskPrefix(undefined, undefined, "FN")).toBe("FN");
    expect(resolveTaskPrefix(undefined, undefined, "KB")).toBe("KB");
  });
});
