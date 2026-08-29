import { describe, it, expect } from "vitest";
import { TerminalViewportRegistry } from "../terminal-viewport.js";

/*
FNXC:TerminalSharing 2026-08-19-02:45:
A PTY has one size but a shared session has many viewers. Applying every viewer's resize verbatim is
last-writer-wins: measured live, viewer A at 80x24 had its shell report 200x50 the moment viewer B
attached on a bigger screen, while A still drew 80 columns — wrapped lines and a broken cursor, with
full-screen programs worst hit. The agreed size is the per-dimension minimum, so content fits inside
every viewer.
*/
describe("TerminalViewportRegistry", () => {
  it("sizes to the smallest attached viewer per dimension", () => {
    const registry = new TerminalViewportRegistry();
    registry.set("s1", "a", { cols: 80, rows: 50 });
    expect(registry.effectiveSize("s1")).toEqual({ cols: 80, rows: 50 });

    registry.set("s1", "b", { cols: 200, rows: 24 });
    // Narrowest columns from A, shortest rows from B.
    expect(registry.effectiveSize("s1")).toEqual({ cols: 80, rows: 24 });
  });

  it("gives room back when a viewer leaves", () => {
    const registry = new TerminalViewportRegistry();
    registry.set("s1", "a", { cols: 80, rows: 24 });
    registry.set("s1", "b", { cols: 200, rows: 50 });
    expect(registry.effectiveSize("s1")).toEqual({ cols: 80, rows: 24 });

    registry.remove("s1", "a");
    expect(registry.effectiveSize("s1")).toEqual({ cols: 200, rows: 50 });
  });

  it("reports no opinion until a viewer has actually measured itself", () => {
    const registry = new TerminalViewportRegistry();
    expect(registry.effectiveSize("s1")).toBeNull();
    // A freshly attached socket must not pin the session to a placeholder size.
    registry.set("s1", "a", { cols: 0, rows: 0 });
    registry.set("s1", "b", { cols: Number.NaN, rows: 24 });
    expect(registry.effectiveSize("s1")).toBeNull();
    expect(registry.viewerCount("s1")).toBe(0);
  });

  it("keeps sessions independent and forgets a dead one", () => {
    const registry = new TerminalViewportRegistry();
    registry.set("s1", "a", { cols: 80, rows: 24 });
    registry.set("s2", "a", { cols: 200, rows: 50 });
    expect(registry.effectiveSize("s1")).toEqual({ cols: 80, rows: 24 });
    expect(registry.effectiveSize("s2")).toEqual({ cols: 200, rows: 50 });

    registry.clear("s1");
    expect(registry.effectiveSize("s1")).toBeNull();
    expect(registry.effectiveSize("s2")).toEqual({ cols: 200, rows: 50 });
  });

  it("re-measures rather than accumulating when one viewer resizes repeatedly", () => {
    const registry = new TerminalViewportRegistry();
    registry.set("s1", "a", { cols: 80, rows: 24 });
    registry.set("s1", "a", { cols: 120, rows: 40 });
    expect(registry.viewerCount("s1")).toBe(1);
    expect(registry.effectiveSize("s1")).toEqual({ cols: 120, rows: 40 });
  });
});
