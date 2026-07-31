// @vitest-environment node

/*
FNXC:Accessibility 2026-07-30-16:30:
A DIALOG'S ACCESSIBLE NAME MUST NOT RESTATE ITS ROLE.

`FloatingWindow` renders `role="dialog"` and `aria-label={ariaLabel}` on the SAME element
(FloatingWindow.tsx:628 and :631). A screen reader announces the role itself, so an accessible name
ending in "dialog" is read back as "Settings dialog, dialog". Thirteen callers had grown that suffix
by copy-paste.

WHY THIS IS A SOURCE SCAN RATHER THAN A RENDER TEST. The defect is a property VALUE at the call
site, and there is no single render that reaches all thirteen modals — each needs its own store,
route and fixture set, and several are lazy-loaded. A per-modal render test would pin the three or
four someone bothered to write and let the next copy-paste through, which is the failure mode
AGENTS.md's "fix the invariant, not the repro" rule exists to stop. Scanning every caller is the
only assertion that covers the whole surface.

The scan is deliberately narrow: it looks only for the role name at the END of the label, where it
is redundant. A label that legitimately contains the word mid-string ("Close confirmation dialog"
on a BUTTON, which is not a dialog) is untouched, and button labels are out of scope entirely
because this only inspects `ariaLabel` props passed to FloatingWindow-family components.
*/

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* `import.meta.url`, matching the sibling source-scanning test (terminal-scrollback-floor) —
   these run as ESM, where `__dirname` is not defined. */
const COMPONENTS_DIR = resolve(fileURLToPath(import.meta.url), "../..");

/** Role words that a `role="dialog"` host already announces on its own. */
const REDUNDANT_ROLE_SUFFIX = /ariaLabel=\{?[`"'][^`"']*?[^A-Za-z](dialog|modal|window)[`"']\}?/gi;

function componentSources(): { file: string; text: string }[] {
  return readdirSync(COMPONENTS_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => ({ file: name, text: readFileSync(resolve(COMPONENTS_DIR, name), "utf8") }));
}

describe("a FloatingWindow's accessible name never restates its role", () => {
  /*
  ANTI-VACUITY. A scan that silently matched zero files would pass forever — including after a
  refactor renamed the prop or moved these components. Assert the corpus is real and that it still
  contains the prop this test is about, so the guard fails loudly instead of going quiet.
  */
  it("scans a real corpus that still uses ariaLabel (anti-vacuity)", () => {
    const sources = componentSources();
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.filter((s) => s.text.includes("ariaLabel=")).length).toBeGreaterThan(5);
  });

  it("no ariaLabel ends in a word the dialog role already announces", () => {
    const offenders: string[] = [];
    for (const { file, text } of componentSources()) {
      for (const match of text.matchAll(REDUNDANT_ROLE_SUFFIX)) {
        offenders.push(`${file}: ${match[0].slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      `An aria-label ending in its own role is announced twice ("Settings dialog, dialog").\n`
      + `Drop the trailing role word — role="dialog" already conveys it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
