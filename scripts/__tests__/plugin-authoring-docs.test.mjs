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

function slugifyHeading(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
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

  const tocLines = tocMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

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
