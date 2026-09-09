import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { maskSource } from "../lib/source-projection.mjs";
import {
  SELF_EXCLUDED_PATHS, isCorpusPath, partitionCorpus, detectLegacyBindings,
  detectQuotedAccess, detectsPrerebaseSpecifier, checkExemption, listTrackedFiles,
  listAllTrackedFiles, protectedCorpusHoles, scanSources, checkDocs,
  DOCS_ROW_CONTRACT, formatFailureMessage,
} from "../check-prerebase-inert.mjs";
import { readStaticGateChecks } from "../run-static-gate-checks.mjs";

test("projections preserve offsets while retaining specifiers", () => {
  const source = 'import { aiMergeTask } from "./merger.js"; // prose\nconst label = `text`;';
  const code = maskSource(source, { blankStrings: true });
  const specifier = maskSource(source, { blankStrings: false });
  assert.equal(code.length, source.length); assert.equal(specifier.length, source.length);
  assert.equal(code.indexOf("aiMergeTask"), specifier.indexOf("aiMergeTask"));
  assert.equal(code.includes("./merger.js"), false); assert.equal(specifier.includes("./merger.js"), true);
  const inline = maskSource('const value = 1; // aiMergeTask must remain prose', { blankStrings: true });
  assert.equal(inline.includes("aiMergeTask"), false);
  // FNXC:MergerUnification 2026-08-09-12:36: A regex character class can
  // contain comment delimiters; the projection must not let it hide code.
  for (const sourceWithRegex of [
    "const pattern = /[//]/; aiMergeTask();",
    "const pattern = /[/*]/; aiMergeTask();",
    "if (enabled) /[//]/.test(value); aiMergeTask();",
    "const quotient = value / /[//]/.test(value); aiMergeTask();",
  ]) {
    assert.ok(maskSource(sourceWithRegex, { blankStrings: true }).includes("aiMergeTask"));
  }
});
test("binding and quoted-access layers cover live forms but not prose", () => {
  assert.ok(detectLegacyBindings(maskSource('import { aiMergeTask as legacy } from "@fusion/engine"; legacy();', { blankStrings: true })).length);
  assert.ok(detectLegacyBindings(maskSource('const { aiMergeTask: legacy } = engine; engine?.aiMergeTask();', { blankStrings: true })).length);
  assert.equal(detectLegacyBindings(maskSource('// aiMergeTask\nconst text = "legacy aiMergeTask pipeline";', { blankStrings: true })).length, 0);
  const computed = maskSource('engine["aiMergeTask"](ctx)', { blankStrings: false });
  assert.equal(detectLegacyBindings(maskSource('engine["aiMergeTask"](ctx)', { blankStrings: true })).length, 0);
  assert.ok(detectQuotedAccess(computed).length);
});
test("specifier layer is binding-position anchored and accepts package paths", () => {
  assert.equal(detectsPrerebaseSpecifier(maskSource('import thing from "@fusion/engine/merge/merger-auto-prerebase.js";', { blankStrings: false })), true);
  assert.equal(detectsPrerebaseSpecifier(maskSource('const names = ["merger-auto-prerebase.js"];', { blankStrings: false })), false);
  assert.equal(detectsPrerebaseSpecifier(maskSource("const data = 'import \\\"@fusion/engine/merge/merger-auto-prerebase.js\\\"';", { blankStrings: false })), false);
  assert.equal(detectsPrerebaseSpecifier(maskSource("const data = 'require(\\\"./merger-auto-prerebase.js\\\")';", { blankStrings: false })), false);
  assert.equal(detectQuotedAccess(maskSource("const data = 'engine[\\\"aiMergeTask\\\"](ctx)';", { blankStrings: false })).length, 0);
});
test("corpus uses exact exclusions and exact self exclusions", () => {
  assert.deepEqual(SELF_EXCLUDED_PATHS, ["scripts/check-prerebase-inert.mjs", "scripts/lib/source-projection.mjs"]);
  assert.equal(isCorpusPath("packages/dashboard/app/public/sw.js"), true);
  assert.equal(isCorpusPath("packages/core/src/types/audit/run-audit.ts"), true);
  assert.equal(isCorpusPath("plugins/fusion-plugin-reports/src/index.ts"), true);
  assert.equal(isCorpusPath("scripts/check-prerebase-inert.mjs"), false);
  assert.equal(isCorpusPath("scripts/copy-of-check-prerebase-inert.mjs"), true);
  assert.equal(isCorpusPath("packages/engine/src/__tests__/x.ts"), false);
});
test("exempt paths are isolated from general layers and retain strict shapes", () => {
  const paths = ["packages/engine/src/merger.ts", "packages/engine/src/index.ts", "plugins/x/src/a.ts"];
  const { exempt, general } = partitionCorpus(paths);
  assert.deepEqual(exempt, paths.slice(0, 2)); assert.deepEqual(general, paths.slice(2));
  const merger = 'export async function aiMergeTask(\n) {}';
  const index = 'export { aiMergeTask } from "./merger.js";';
  assert.ok(detectLegacyBindings(maskSource(merger, { blankStrings: true })).length);
  assert.ok(detectLegacyBindings(maskSource(index, { blankStrings: true })).length);
  assert.equal(checkExemption("packages/engine/src/merger.ts", maskSource(merger, { blankStrings: true }), maskSource(merger, { blankStrings: false }), merger), null);
  assert.equal(checkExemption("packages/engine/src/index.ts", maskSource(index, { blankStrings: true }), maskSource(index, { blankStrings: false }), index), null);
});
test("real tracked corpus has no protected-source holes and gate is wired", () => {
  const corpus = new Set(listTrackedFiles());
  assert.ok(corpus.size > 0);
  for (const path of ["packages/core/src/types/audit/run-audit.ts", "packages/dashboard/app/public/sw.js"]) assert.ok(corpus.has(path), path);
  assert.deepEqual(protectedCorpusHoles(listAllTrackedFiles(), [...corpus]), []);
  assert.deepEqual(checkDocs(), []); assert.deepEqual(scanSources(), []);
  assert.ok(readStaticGateChecks().includes("scripts/check-prerebase-inert.mjs"));
});

function createDocsFixture({ rows = DOCS_ROW_CONTRACT, architecture = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fusion-prerebase-docs-"));
  const settingsRows = Object.entries(rows).map(([setting, contract]) => `| \`${setting}\` | type | default | ${contract.required.join(" ")} |`);
  const docsDir = join(root, "docs");
  mkdirSync(docsDir);
  writeFileSync(join(docsDir, "settings-reference.md"), settingsRows.join("\n"));
  writeFileSync(join(docsDir, "architecture.md"), architecture);
  return root;
}

// FNXC:MergerUnification 2026-09-09-07:46: Iterate the exported contract so a
// new mechanical claim cannot be added without a negative fixture proof.
test("docs contract rejects every omitted or forbidden claim token", () => {
  for (const [setting, contract] of Object.entries(DOCS_ROW_CONTRACT)) {
    for (const token of contract.required) {
      const mutated = Object.fromEntries(Object.entries(DOCS_ROW_CONTRACT).map(([name, item]) => [name, {
        ...item,
        required: name === setting ? item.required.filter((candidate) => candidate !== token) : item.required,
      }]));
      const root = createDocsFixture({ rows: mutated });
      try {
        assert.ok(checkDocs(root).includes(`docs contract: ${setting}: missing required claim token: ${token}`));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    for (const token of contract.forbidden) {
      const root = createDocsFixture({ rows: Object.fromEntries(Object.entries(DOCS_ROW_CONTRACT).map(([name, item]) => [name, {
        ...item,
        required: name === setting ? [...item.required, token] : item.required,
      }])) });
      try {
        assert.ok(checkDocs(root).includes(`docs contract: ${setting}: forbidden claim token: ${token}`));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});
test("docs contract accepts corrected rows and identifies missing rows", () => {
  const root = createDocsFixture();
  try {
    assert.deepEqual(checkDocs(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const missing = { ...DOCS_ROW_CONTRACT };
  delete missing.prerebaseHotFiles;
  const missingRoot = createDocsFixture({ rows: missing });
  try {
    assert.ok(checkDocs(missingRoot).includes("docs contract: missing prerebaseHotFiles row"));
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
});
test("docs contract requires an aiMergeTask legacy qualifier on its line", () => {
  const unqualified = createDocsFixture({ architecture: "aiMergeTask performs merge flow" });
  try {
    assert.deepEqual(checkDocs(unqualified), ["docs contract: architecture: unqualified aiMergeTask mention on line 1"]);
  } finally {
    rmSync(unqualified, { recursive: true, force: true });
  }
  const qualified = createDocsFixture({ architecture: "legacy aiMergeTask performs merge flow" });
  try {
    assert.deepEqual(checkDocs(qualified), []);
  } finally {
    rmSync(qualified, { recursive: true, force: true });
  }
});
test("failure guidance names the current AGENTS legacy-prerebase item", () => {
  const agents = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");
  const itemTitle = agents.match(/^\d+\. \*\*(Legacy auto-prerebase is inert\.)\*\*/m)?.[1];
  assert.ok(itemTitle);
  assert.ok(formatFailureMessage([]).includes(itemTitle));
});
