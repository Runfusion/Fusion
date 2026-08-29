import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MANIFEST_PATH,
  loadManifest,
  planCommands,
  renderReport,
  summarize,
  validateManifest,
} from "../workflow-reliability-release-check.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), "../..");

const expectedChecklistIds = [
  "author-import-save-discover-reload",
  "selected-workflow-execution-fail-closed",
  "gate-advisory-readonly-revise-required-artifact",
  "automerge-hard-cancel-file-scope-recovery",
  "restart-selection-progress-run-audit",
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("manifest parses, covers all five release-check items, and references existing seam files", () => {
  const manifest = loadManifest(DEFAULT_MANIFEST_PATH, { rootDir: repoRoot });

  assert.equal(manifest.version, 1);
  assert.equal(typeof manifest._comment, "string");
  assert.deepEqual(manifest.checklist.map((item) => item.id), expectedChecklistIds);
  assert.equal(manifest.manual.length, 0);

  for (const item of manifest.checklist) {
    assert.equal(typeof item.title, "string");
    assert.equal(typeof item.journey, "string");
    assert.ok(item.seams.length >= 1, `${item.id} should map to at least one automated seam`);
    for (const seam of item.seams) {
      assert.match(seam.package, /^@fusion\/(core|dashboard|engine)$/);
      assert.ok(existsSync(path.join(repoRoot, seam.file)), `${seam.file} should exist`);
    }
  }

  assert.deepEqual(validateManifest(manifest, { repoRoot, existsSync }), { ok: true, errors: [] });
});

test("planned commands are targeted package-scoped vitest invocations", () => {
  const manifest = loadManifest(DEFAULT_MANIFEST_PATH, { rootDir: repoRoot });
  const commands = planCommands(manifest);

  assert.deepEqual(commands.map((command) => command.package), ["@fusion/core", "@fusion/dashboard", "@fusion/engine"]);
  for (const command of commands) {
    assert.equal(command.command, "pnpm");
    assert.deepEqual(command.args.slice(0, 5), ["--filter", command.package, "exec", "vitest", "run"]);
    assert.ok(command.args.includes("--silent=passed-only"));
    assert.ok(command.args.includes("--reporter=dot"));
    assert.ok(command.files.length >= 1);
    for (const file of command.files) assert.ok(file.startsWith("packages/"));
  }
});

test("validateManifest fails closed on dangling seam files and uncovered checklist items", () => {
  const manifest = loadManifest(DEFAULT_MANIFEST_PATH, { rootDir: repoRoot });
  const dangling = clone(manifest);
  dangling.checklist[0].seams[0].file = "packages/core/src/__tests__/missing-workflow-release-check.test.ts";

  const danglingResult = validateManifest(dangling, { repoRoot, existsSync: (candidate) => !String(candidate).includes("missing-workflow-release-check") });
  assert.equal(danglingResult.ok, false);
  assert.match(danglingResult.errors.join("\n"), /file does not exist/);

  const uncovered = clone(manifest);
  uncovered.checklist[1].seams = [];
  const uncoveredResult = validateManifest(uncovered, { repoRoot, existsSync: () => true });
  assert.equal(uncoveredResult.ok, false);
  assert.match(uncoveredResult.errors.join("\n"), /must have at least one seam or a manual automationDeferredReason/);
});

test("validateManifest rejects unknown packages and accepts explicit manual deferrals", () => {
  const manifest = loadManifest(DEFAULT_MANIFEST_PATH, { rootDir: repoRoot });
  const unknownPackage = clone(manifest);
  unknownPackage.checklist[0].seams[0].package = "@fusion/unknown";

  const unknownPackageResult = validateManifest(unknownPackage, { repoRoot, existsSync: () => true });
  assert.equal(unknownPackageResult.ok, false);
  assert.match(unknownPackageResult.errors.join("\n"), /unknown package/);

  const manual = clone(manifest);
  manual.checklist[0].seams = [];
  manual.manual = [{
    id: manual.checklist[0].id,
    title: manual.checklist[0].title,
    automationDeferredReason: "Requires a human-only external signoff artifact.",
  }];
  assert.deepEqual(validateManifest(manual, { repoRoot, existsSync: () => true }), { ok: true, errors: [] });
});

test("summarize and renderReport roll up pass, fail, manual, text, and stable JSON", () => {
  const summary = summarize([
    {
      id: "passed-item",
      title: "Passed item",
      journey: "A passing synthetic item",
      seams: [{ package: "@fusion/core", file: "one.test.ts", status: "PASS" }],
      manual: null,
    },
    {
      id: "failed-item",
      title: "Failed item",
      journey: "A failing synthetic item",
      seams: [{ package: "@fusion/engine", file: "two.test.ts", status: "FAIL", exitCode: 1 }],
      manual: null,
    },
    {
      id: "manual-item",
      title: "Manual item",
      journey: "A manual synthetic item",
      seams: [],
      manual: { id: "manual-item", title: "Manual item", automationDeferredReason: "Human inspection only." },
    },
  ]);

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.counts, { pass: 1, fail: 1, manual: 1, total: 3 });
  assert.deepEqual(summary.items.map((item) => item.status), ["PASS", "FAIL", "MANUAL"]);

  const text = renderReport(summary);
  assert.match(text, /Overall: FAIL \(1 passed, 1 failed, 1 manual, 3 total\)/);
  assert.match(text, /FAIL: failed-item/);
  assert.match(text, /MANUAL: Human inspection only\./);

  const json = renderReport(summary, { json: true });
  assert.deepEqual(JSON.parse(json), summary);
  assert.ok(json.startsWith('{\n  "ok": false,'));
});
