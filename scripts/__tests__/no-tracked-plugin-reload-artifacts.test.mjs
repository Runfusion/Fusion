import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/*
FNXC:PluginLoader 2026-08-11-09:58:
FN-8990 requires reload scratch copies to remain untracked. Gitignore cannot
remove a path already in git's index, so inspect tracked files directly.
*/
function getTrackedReloadArtifacts() {
  return execFileSync("git", ["ls-files"], { cwd: rootDir, encoding: "utf8" })
    .split("\n")
    .filter((path) => /\.index\.reload-\d+\.ts$/.test(path));
}

test("plugin hot-reload scratch copies are never tracked", () => {
  const artifacts = getTrackedReloadArtifacts();
  assert.deepEqual(
    artifacts,
    [],
    `Tracked plugin hot-reload scratch copies:\n${artifacts.map((path) => `- ${path}`).join("\n")}`,
  );
});
