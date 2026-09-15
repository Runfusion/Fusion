import { describe, expect, it } from "vitest";
import { loadAllAppCss, readAppFile } from "../test/cssFixture";

/*
FNXC:TerminalLayout 2026-09-15-07:57:
FN-409 symptom acceptance (2): the fixed bottom bar's height must be reserved EXACTLY ONCE while the pinned
terminal is shown. The behaviour has two halves, each proven against production code elsewhere:

- The terminal publishes its effective pinned presentation
  (`TerminalModal.test.tsx` → "reports its pinned layout to the shell and clears it on unmount", plus the
  embedded and mobile negatives).
- The shell drops `project-content--with-footer`, `left-sidebar-nav--with-footer`, and `right-dock--with-footer`
  while that signal is true and restores them on detach/close
  (`components/__tests__/App.test.tsx` → "ne réserve la hauteur de la barre du bas qu'une seule fois…").

This file guards the remaining half that no render can show: that the STYLESHEETS do not smuggle in a second
equivalent reservation. If a future rule reserves the bar's height on an ancestor of the pinned terminal host,
the empty band returns even though both behavioural suites stay green.
*/

/** Rules that legitimately reserve the fixed bottom bar's height, keyed by the class the shell toggles. */
const SHELL_RESERVATION_MODIFIERS = [
  "project-content--with-footer",
  "left-sidebar-nav--with-footer",
  "right-dock--with-footer",
] as const;

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

describe("pinned terminal footer reservation", () => {
  const css = loadAllAppCss();
  const terminalCss = readAppFile("components/TerminalModal.css");

  it("keeps the pinned terminal host as the reserving consumer", () => {
    const host = terminalCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .match(/\.terminal-below-host--with-footer\s*\{([^{}]*)\}/)?.[1] ?? "";

    expect(host).toContain("--executor-footer-height: 36px;");
    expect(host).toContain("padding-bottom: calc(var(--icb-bottom-offset, 0px) + var(--executor-footer-height));");
  });

  it("keeps the base pinned host free of any unconditional reservation", () => {
    const base = terminalCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .match(/\.terminal-below-host\s*\{([^{}]*)\}/)?.[1] ?? "";

    expect(base).not.toContain("padding-bottom");
  });

  it.each(SHELL_RESERVATION_MODIFIERS)(
    "keeps %s reserving the bar only through the class the shell can drop",
    (modifier) => {
      const bodies = ruleBodies(css, `.${modifier}`);
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.some((body) => body.includes("--executor-footer-height"))).toBe(true);

      // The unmodified base selector must never reserve on its own, or dropping the modifier would change nothing.
      const baseSelector = modifier.replace("--with-footer", "");
      for (const body of ruleBodies(css, `.${baseSelector} `)) {
        expect(body).not.toMatch(/padding-bottom:[^;]*--executor-footer-height/);
      }
    },
  );

  it("routes the shell reservation through the pinned-terminal-aware derivation in App", () => {
    const app = readAppFile("App.tsx");

    // The shell consumers read the derived value; the terminal itself keeps the raw one.
    expect(app).toContain("const shellFooterReservationVisible = shellFooterVisible && !terminalPinnedBelow;");
    expect(app).toContain("onPinnedLayoutChange={handleTerminalPinnedLayoutChange}");
    expect(app).toContain('shellFooterReservationVisible && (!isMobile || !mobileKeyboardOpen) ? " project-content--with-footer"');
  });
});
