import { describe, expect, it } from "vitest";
import { resolveDashboardWindowBounds } from "../context/DashboardWindowManagerContext";
import { loadAllAppCss, readAppFile } from "../test/cssFixture";

/*
FNXC:FloatingWindowSnap 2026-09-17-04:51:
FN-487 guards the two halves of the shell contract that no single render can show:
- `App` reserves the published band on `.dashboard-project-stack` and stops reserving the fixed bottom bar a second
  time while that band is active (otherwise FN-409's empty 36px band returns above the docked window);
- the stylesheets reserve that band EXACTLY ONCE, through the modifier the shell can drop.
The behaviour itself is proven on real gestures in `FloatingWindow.bottom-dock-reservation.test.tsx` and on the
production host in `PoppedOutChatWindows.bottom-dock.test.tsx`.
*/

/*
Each rule is matched from the character after the previous rule's closing brace, so consecutive rules are all
visited. A `(^|})` boundary group would consume that brace and silently skip every other rule.
*/
function ruleBodies(css: string, selectorFragment: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].includes(selectorFragment))
    .map((match) => match[2]);
}

describe("bottom dock reservation in the shell", () => {
  const app = readAppFile("App.tsx");
  const css = loadAllAppCss();

  /* (k) The shell reads the published reservation and applies it to the stack. */
  it("applies the published band to the project stack", () => {
    expect(app).toContain("const bottomDockReservationPx = useDashboardWindowBottomDockReservation();");
    expect(app).toContain("const bottomDockReservationActive = bottomDockReservationPx > 0;");
    expect(app).toContain('bottomDockReservationActive ? " dashboard-project-stack--bottom-dock" : ""');
    expect(app).toContain('"--bottom-dock-reservation": `${bottomDockReservationPx}px`');
  });

  /* (k) The band already covers the fixed bottom bar, so nothing reserves that bar a second time. */
  it("stops reserving the fixed bottom bar while a band is active", () => {
    expect(app).toContain("const shellFooterReservationVisible = shellFooterVisible && !terminalPinnedBelow && !bottomDockReservationActive;");
    expect(app).toContain("const terminalFooterVisible = shellFooterVisible && !bottomDockReservationActive;");
    expect(app).toContain("footerVisible={terminalFooterVisible}");
  });

  /*
  (l) The reservation must never feed the work area: a band that shrinks the work area would raise its own top edge,
  which would republish a taller band, and so on. `resolveDashboardWindowBounds` therefore accepts no such input.
  */
  it("keeps the work-area computation independent of the reservation", () => {
    const input = {
      viewportWidth: 1280,
      viewportHeight: 800,
      headerRect: null,
      footerRect: null,
      rightDockRect: null,
      leftNavRect: null,
    };
    const bounds = resolveDashboardWindowBounds(input);

    expect(resolveDashboardWindowBounds({ ...input, bottomDockReservation: 400 } as typeof input)).toEqual(bounds);

    const context = readAppFile("context/DashboardWindowManagerContext.tsx");
    const measureBody = context.match(/const measure = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[/)?.[1] ?? "";
    expect(measureBody.length).toBeGreaterThan(0);
    expect(measureBody).not.toContain("bottomDockReservation");
  });

  /* (n) The band is reserved exactly once, and only through the modifier the shell can drop. */
  it("reserves the band exactly once through the droppable modifier", () => {
    const modifierBodies = ruleBodies(css, ".dashboard-project-stack--bottom-dock");
    expect(modifierBodies.length).toBe(1);
    expect(modifierBodies[0]).toContain("padding-bottom: var(--bottom-dock-reservation, 0px);");

    // The base rule must never reserve on its own, or dropping the modifier would change nothing.
    const baseBodies = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1].trim() === ".dashboard-project-stack")
      .map((match) => match[2]);
    expect(baseBodies.length).toBeGreaterThan(0);
    for (const body of baseBodies) expect(body).not.toContain("padding-bottom");

    // No other rule may consume the same variable, which would reserve the band twice.
    const consumers = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
      .filter((match) => match[2].includes("--bottom-dock-reservation"))
      .map((match) => match[1].trim());
    expect(consumers).toEqual([".dashboard-project-stack--bottom-dock"]);
  });
});
