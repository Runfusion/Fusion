/*
FNXC:TuiRawLogs 2026-08-26-14:40:
Raw mode exists so a terminal click-drag can select log text cleanly. Two properties make that true,
and both were wrong in the first attempt:

  - it must replace the WHOLE frame, above the layout choice. It was added inside the single-pane
    layout only, which renders on a NARROW terminal; a wide terminal draws the grid layout instead
    (System / Stats / Utilities / Settings beside Logs), so the toggle flipped state and nothing moved
    on screen.
  - it must release mouse reporting, which this panel enables for wheel scrolling and which swallows
    a click-drag before the terminal ever sees it.

And the binding is SHIFT+V because the Utilities panel already advertises `[v] Auto-Kill Vitest` on
the same screen; the handlers are mutually exclusive at runtime, but two `[v]` legends at once is a UI
anyone would misread.
*/
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const appSource = () => readFile(new URL("../app.tsx", import.meta.url), "utf8");

describe("TUI raw logs mode", () => {
  it("escapes above the layout choice, so it works on wide and narrow terminals alike", async () => {
    const source = await appSource();

    const rawReturn = source.indexOf("state.mode === \"status\" && state.logsRawMode");
    // The grid is the WIDE layout, and the one the first attempt never reached.
    const gridRender = source.indexOf("<StatusModeGrid");
    const singleRender = source.indexOf("<StatusModeSingle");
    expect(rawReturn, "raw mode must be reachable").toBeGreaterThan(-1);
    expect(gridRender).toBeGreaterThan(-1);
    expect(rawReturn, "the escape must precede the grid layout").toBeLessThan(gridRender);
    expect(rawReturn, "the escape must precede the single-pane layout").toBeLessThan(singleRender);

    // Exactly one place may render it: a second copy inside a layout is how the grid was missed.
    expect(source.split("<RawLogs ").length - 1).toBe(1);
  });

  it("releases mouse reporting so a click-drag reaches the terminal", async () => {
    const source = await appSource();
    expect(source).toContain("!state.logsExpandedMode && !state.logsRawMode");
  });

  it("binds SHIFT+V, leaving lowercase v to the Utilities auto-kill toggle", async () => {
    const source = await appSource();

    expect(source).toContain('if (input === "V") {');
    // The lowercase legend the Utilities panel owns must stay untouched.
    expect(source).toContain('{ key: "v", label: t("tui.utilitiesAutoKillVitest"');
    // And the raw-mode handler must not claim lowercase v.
    expect(source).not.toContain('if (input === "v" || input === "V") {\n        controller.setLogsRawMode');
  });

  it("leaves a visible way out", async () => {
    const source = await appSource();
    expect(source).toContain("tui.rawLogsHint");
    // Esc must clear raw mode before the expanded-entry escape, or the two modes fight.
    const escapeBlock = source.slice(source.indexOf("if (key.escape) {", source.indexOf("logsFocused")));
    expect(escapeBlock.indexOf("state.logsRawMode")).toBeLessThan(escapeBlock.indexOf("state.logsExpandedMode"));
  });
});
