import test from "node:test";
import assert from "node:assert/strict";
import { maskSource } from "../lib/source-projection.mjs";
import {
  SELF_EXCLUDED_PATHS, isCorpusPath, partitionCorpus, detectLegacyBindings,
  detectQuotedAccess, detectsPrerebaseSpecifier, checkExemption, listTrackedFiles,
  listAllTrackedFiles, protectedCorpusHoles, scanSources, checkDocs,
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
