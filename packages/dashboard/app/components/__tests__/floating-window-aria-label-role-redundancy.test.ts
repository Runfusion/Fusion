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
const ROLE_WORD_AT_END = /[^A-Za-z](dialog|modal|window)\s*[`"']\s*\}?\s*$/i;

/*
FNXC:Accessibility 2026-07-30-17:05:
The value is extracted by BRACE MATCHING rather than by one regex over the raw source.

The first version of this guard used a single pattern with `[^`"']*?` for the label body. Every real
call site interpolates a translator call — ``ariaLabel={`${t("scripts.title", "Scripts")} dialog`}``
— and those inner DOUBLE QUOTES terminate that character class, so the pattern matched none of the
thirteen offenders. It passed against hand-written samples like ``{`Settings dialog`}`` that happen
to contain no quotes, which is how it looked correct while covering nothing.

Caught by mutation: re-adding the suffix to ScriptsModal in its original template-literal form left
the suite green. A guard that cannot fail on the exact defect it was written for is worse than none,
so the extraction is now structural and the case table below carries the real, quote-bearing shapes.
*/
function extractAriaLabelValues(text: string): string[] {
  const values: string[] = [];
  const PROP = /ariaLabel=/g;
  for (let m = PROP.exec(text); m; m = PROP.exec(text)) {
    let i = m.index + m[0].length;
    if (text[i] === "{") {
      let depth = 0;
      const start = i;
      for (; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") {
          depth -= 1;
          if (depth === 0) { values.push(text.slice(start, i + 1)); break; }
        }
      }
    } else if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      const end = text.indexOf(quote, i + 1);
      if (end > i) values.push(text.slice(i, end + 1));
    }
  }
  return values;
}

/*
FNXC:Accessibility 2026-07-30-21:10:
THE ROLE WORD CAN ALSO SIT INSIDE THE TRANSLATED DEFAULT, and the end-of-value scan cannot see it.

`ariaLabel={t("scripts.title", "Scripts dialog")}` renders the accessible name "Scripts dialog" —
the identical defect — but the value does not END in the role word: a `")` closes the call after it.
The suffix form above was the shape the original thirteen had; this is the shape the NEXT one takes,
because the rendered label is the translator's default string and "dialog" reads as part of the title
to whoever writes it.

Found by mutation against the shipped guard: re-adding the role word in this position left the suite
green. So each quoted literal that is actually RENDERED is checked with the same matcher, not just
the whole value.

I18N KEYS ARE EXCLUDED, or this would fire on every `t("agents.onboarding.dialogLabel", ...)` — the
key is an identifier, never announced. Key-shaped means dotted and whitespace-free, which no real
accessible name is.
*/
const KEY_SHAPED = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)+$/;

function renderedLiterals(value: string): string[] {
  const literals = value.match(/"[^"]*"|'[^']*'/g) ?? [];
  return literals.filter((literal) => !KEY_SHAPED.test(literal.slice(1, -1)));
}

/** Every string a screen reader could end up announcing for one `ariaLabel` call site. */
function announceableParts(value: string): string[] {
  return [value, ...renderedLiterals(value)];
}

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

  /*
  THE MATCHER ITSELF IS COVERED, because the scan above is only as good as this regex: loosening it
  (or breaking it during an unrelated edit) would leave a guard that scans everything and finds
  nothing, reporting success while covering zero. The negative cases matter more than the positive
  ones — each is a real string in this codebase that must NOT be flagged.
  */
  it.each<[source: string, shouldFlag: boolean, why: string]>([
    /* THE REAL SHAPES FIRST — every one of the thirteen offenders looked like this, with quotes
       inside the interpolation. The original regex missed all of them. */
    ['ariaLabel={`${t("scripts.title", "Scripts")} dialog`}', true, "interpolated t() + suffix — the actual defect"],
    ['ariaLabel={`${t("nodes.modalAriaLabel", "Node details for {{name}}", { name: node.name })} dialog`}', true, "nested braces AND quotes"],
    ['ariaLabel={t("scripts.title", "Scripts") + " dialog"}', true, "concatenation, not interpolation"],
    ["ariaLabel={`Settings dialog`}", true, "quote-free template literal"],
    ['ariaLabel="Git Manager dialog"', true, "plain string"],
    ["ariaLabel={`Node details modal`}", true, "'modal' is equally redundant"],
    /* THE SECOND POSITION: inside the translated default, where the value does not end in the role
       word. These are the cases the suffix-only matcher was blind to. */
    ['ariaLabel={t("scripts.title", "Scripts dialog")}', true, "role word inside the t() default"],
    ['ariaLabel={`${t("scripts.title", "Scripts modal")}`}', true, "inside the default, interpolated"],
    ['ariaLabel={t("git.title", "Git Manager dialog", { repo })}', true, "default followed by an options arg"],
    ['ariaLabel={t("settings.title", "Settings")}', false, "the fixed form — a bare t() call"],
    /* The KEY of a t() call routinely contains the word and is never announced — flagging it would
       make the guard unusable, and one such key is live in the tree today. */
    ['ariaLabel={t("agents.onboarding.dialogLabel", "AI Interview")}', false, "role word in the KEY only"],
    ['ariaLabel={t("nodes.detail.modal", "Node details")}', false, "key ends in a role word"],
    ['ariaLabel={`${t("nodes.addNode", "Add Node")}`}', false, "interpolation with no suffix"],
    ['ariaLabel="Settings"', false, "a clean literal"],
    ['ariaLabel="Dialog settings"', false, "role word present but not trailing"],
    ['ariaLabel="Windows update"', false, "'Windows' merely contains a role word"],
  ])("matcher: %s -> %s (%s)", (source, shouldFlag) => {
    const flagged = extractAriaLabelValues(source)
      .flatMap(announceableParts)
      .some((part) => ROLE_WORD_AT_END.test(part));
    expect(flagged).toBe(shouldFlag);
  });

  it("no ariaLabel ends in a word the dialog role already announces", () => {
    const offenders: string[] = [];
    for (const { file, text } of componentSources()) {
      for (const value of extractAriaLabelValues(text)) {
        if (announceableParts(value).some((part) => ROLE_WORD_AT_END.test(part))) {
          offenders.push(`${file}: ${value.slice(0, 100)}`);
        }
      }
    }
    expect(
      offenders,
      `An aria-label ending in its own role is announced twice ("Settings dialog, dialog").\n`
      + `Drop the trailing role word — role="dialog" already conveys it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
