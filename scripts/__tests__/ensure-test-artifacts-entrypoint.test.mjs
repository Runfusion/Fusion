import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const script = resolve(root, "scripts/ensure-test-artifacts.mjs");
const artifact = await import(pathToFileURL(script).href);

test("control: exported artifact helper computes a source hash", () => {
  assert.match(artifact.computeCombinedSourceHash(root), /^[a-f0-9]{64}$/);
});

test("main-module detection handles Windows argv paths on every host", () => {
  const windowsScript = String.raw`C:\fusion repo\scripts\ensure-test-artifacts.mjs`;
  const windowsModuleUrl = "file:///C:/fusion%20repo/scripts/ensure-test-artifacts.mjs";

  assert.equal(pathToFileURL(windowsScript, { windows: true }).href, windowsModuleUrl);
  assert.equal(artifact.isMainModule(windowsModuleUrl, windowsScript, true), true);
  assert.equal(artifact.isMainModule(`file://${windowsScript}`, windowsScript, true), false);
});

test("artifact CLI executes on this OS and emits the same source hash", () => {
  const output = execFileSync(process.execPath, [script, "--print-source-hash"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  assert.equal(
    output,
    artifact.computeCombinedSourceHash(root),
    "plain Node entrypoint must execute rather than silently no-op",
  );
});
