import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const docPath = path.resolve(__dirname, "../../docs/PLUGIN_AUTHORING.md");
const doc = readFileSync(docPath, "utf8");

const expectedSections = [
  "Getting Started",
  "Plugin Manifest Reference",
  "Plugin Settings Schema",
  "Available Hooks and Signatures",
  "Registering Tools",
  "Registering Routes",
  "Registering UI Slots",
  "Registering Top-Level Dashboard Views",
  "Registering Agent Runtimes",
  "Plugin Context API Reference",
  "Plugin Lifecycle States",
  "Testing Plugins",
  "Publishing Plugins",
  "Example Plugins",
  "Registering Skills",
  "Registering Workflow Steps",
  "Contributing Prompt Modifications",
  "Plugin Binary Setup Hooks",
];

/*
FNXC:PluginAuthoringDocs 2026-07-31-04:30:
ONE HYPHEN PER SPACE, not one per RUN — GitHub does not collapse whitespace when it builds an anchor.

`\s+ -> "-"` agrees with GitHub for every title whose words are single-spaced, which is why it went
unnoticed: the two differ only once punctuation is stripped from BETWEEN words, leaving a gap.
`### Theming & Overlay Layering for Dashboard Views` is the live case — GitHub emits
`theming--overlay-...` (the `&` is removed, both spaces survive) and the document's own link uses it,
while this helper produced the single-hyphen form.

Latent until the nested-anchor check below started resolving sub-entries against real headings: the
numbered top-level titles contain no punctuation, so the two spellings agreed on all eighteen.
*/
function slugifyHeading(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s/g, "-");
}

test("PLUGIN_AUTHORING headings are sequentially numbered 1..18 with expected titles", () => {
  const headingMatches = [...doc.matchAll(/^##\s+(\d+)\.\s+(.+)$/gm)];
  const numbered = headingMatches.map((m) => ({ number: Number(m[1]), title: m[2].trim() }));

  assert.equal(numbered.length, expectedSections.length);

  for (let i = 0; i < expectedSections.length; i += 1) {
    assert.equal(numbered[i].number, i + 1);
    assert.equal(numbered[i].title, expectedSections[i]);
  }
});

test("PLUGIN_AUTHORING TOC includes top-level dashboard views and anchors align to headings", () => {
  const tocMatch = doc.match(/## Table of Contents\n\n([\s\S]*?)\n---/);
  assert.ok(tocMatch, "Table of Contents block should exist");

  /*
  FNXC:PluginAuthoringDocs 2026-07-31-18:20:
  NESTED TOC entries are legal Markdown, and this parser rejected them by flattening indentation away.

  `- [Theming & Overlay Layering for Dashboard Views](...)` sits indented under item 8 — an ordinary
  sub-entry. The old code trimmed every line first and then required ALL of them to match the
  top-level `N. [title](#anchor)` shape, so adding a perfectly valid sub-entry turned this assertion
  red on `main`, and it has been red since.

  Indentation is the discriminator, so it is read BEFORE trimming. Sub-entries are still required to
  be well-formed links — they are simply not top-level sections and do not participate in the
  numbering or the count. A malformed TOP-LEVEL line still fails exactly as before, which is the guard
  this test exists to be.
  */
  const rawTocLines = tocMatch[1].split("\n").filter((line) => line.trim());

  /*
  FNXC:PluginAuthoringDocs 2026-07-31-04:20:
  A NESTED ENTRY'S ANCHOR IS CHECKED TOO, not merely its shape.

  Accepting sub-entries fixed the false rejection above, but left them validated only for link SHAPE:
  MEASURED on that fix, pointing this sub-entry at `#kb-nonexistent-anchor` kept the suite green,
  while the identical corruption in a top-level entry failed. A TOC guard whose whole purpose is that
  links resolve cannot check that for one class of entry and not the other — a dead sub-link is found
  by a reader clicking it, which is the outcome this file exists to prevent.

  Resolved against the document's own headings via the same `slugifyHeading` the top-level check uses,
  so both classes answer to one definition of "this anchor exists".
  */
  const headingAnchors = new Set(
    [...doc.matchAll(/^#{2,6}\s+(.+)$/gm)].map((m) => slugifyHeading(m[1])),
  );
  const subEntries = rawTocLines.filter((line) => /^\s+/.test(line));
  for (const line of subEntries) {
    const trimmed = line.replace(/\s+$/, "");
    const shape = trimmed.match(/^\s+-\s+\[(.+)\]\(#(.+)\)$/);
    assert.ok(shape, `Invalid nested TOC line: ${line}`);
    assert.ok(
      headingAnchors.has(shape[2]),
      `Nested TOC anchor #${shape[2]} matches no heading in PLUGIN_AUTHORING.md (entry: ${shape[1]})`,
    );
  }

  const tocLines = rawTocLines.filter((line) => !/^\s/.test(line)).map((line) => line.trim());

  const tocEntries = tocLines.map((line) => {
    const m = line.match(/^(\d+)\.\s+\[(.+)\]\(#(.+)\)$/);
    assert.ok(m, `Invalid TOC line: ${line}`);
    return {
      number: Number(m[1]),
      title: m[2],
      anchor: m[3],
    };
  });

  assert.equal(tocEntries.length, expectedSections.length);

  for (let i = 0; i < expectedSections.length; i += 1) {
    const sectionNumber = i + 1;
    const expectedTitle = expectedSections[i];
    const expectedAnchor = slugifyHeading(`${sectionNumber}. ${expectedTitle}`);

    assert.equal(tocEntries[i].number, sectionNumber);
    assert.equal(tocEntries[i].title, expectedTitle);
    assert.equal(tocEntries[i].anchor, expectedAnchor);
  }

  const topLevelEntry = tocEntries.find((entry) => entry.number === 8);
  assert.ok(topLevelEntry, "TOC should include section 8");
  assert.equal(topLevelEntry.title, "Registering Top-Level Dashboard Views");
});

test("PLUGIN_AUTHORING documents executorRuntimeEnv hook signature in hook reference", () => {
  assert.match(
    doc,
    /\| `executorRuntimeEnv` \| `\(taskCtx: ExecutorRuntimeTaskContext, ctx: PluginContext\) => Promise<ExecutorRuntimeEnvContribution> \\| ExecutorRuntimeEnvContribution` \|/,
  );
});

test("PLUGIN_AUTHORING documents executorRuntimeEnv runtime env contract and PATH injection example", () => {
  assert.match(doc, /### `executorRuntimeEnv`: task-scoped executor subprocess environment/);
  assert.match(doc, /does \*\*not\*\* apply to internal git plumbing subprocesses/);
  assert.match(doc, /pathPrepend` must be an array of absolute path strings/);
  assert.match(doc, /must not include `PATH`; use `pathPrepend` instead/);
  assert.match(doc, /later plugins override earlier values and the engine logs a warning/);
  assert.match(doc, /later plugins are placed earlier in the final prepend list/);
  assert.match(doc, /pathPrepend: \[toolDir\]/);
});
