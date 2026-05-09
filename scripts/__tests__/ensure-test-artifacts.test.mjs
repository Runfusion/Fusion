import test from "node:test";
import assert from "node:assert/strict";
import {
  detectMissingArtifacts,
  ensureTestArtifacts,
  REQUIRED_BUILD_PACKAGES,
} from "../ensure-test-artifacts.mjs";

test("detectMissingArtifacts returns missing package list", () => {
  const missing = detectMissingArtifacts("/repo", () => false);
  assert.equal(missing.length, REQUIRED_BUILD_PACKAGES.length);
  assert.equal(missing[0].name, "@fusion/core");
});

test("ensureTestArtifacts skips build when nothing is missing", () => {
  let called = false;
  const built = ensureTestArtifacts("/repo", () => {
    called = true;
  }, () => true);

  assert.equal(called, false);
  assert.deepEqual(built, []);
});

test("ensureTestArtifacts builds only missing packages", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.includes("fusion-plugin-openclaw-runtime"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/openclaw-runtime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/openclaw-runtime", "build"]);
});

test("detectMissingArtifacts flags @fusion/dashboard when dist/index.js is missing", () => {
  const missing = detectMissingArtifacts("/repo", (fullPath) => !fullPath.endsWith("packages/dashboard/dist/index.js"));
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion/dashboard"));
});

test("ensureTestArtifacts rebuilds @fusion/dashboard when its dist is missing", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("packages/dashboard/dist/index.js"),
  );

  assert.deepEqual(built, ["@fusion/dashboard"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion/dashboard", "build"]);
});

test("detectMissingArtifacts flags hermes when dist/index.js exists but dist/cli-spawn.js is missing", () => {
  const missing = detectMissingArtifacts("/repo", (fullPath) => !fullPath.endsWith("dist/cli-spawn.js"));
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion-plugin-examples/hermes-runtime"));
});

test("ensureTestArtifacts rebuilds hermes for incomplete dist artifacts", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-hermes-runtime/dist/cli-spawn.js"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/hermes-runtime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/hermes-runtime", "build"]);
});

test("detectMissingArtifacts flags openclaw when dist/index.js exists but transitive files are missing", () => {
  const missing = detectMissingArtifacts(
    "/repo",
    (fullPath) => fullPath.endsWith("plugins/fusion-plugin-openclaw-runtime/dist/index.js"),
  );
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion-plugin-examples/openclaw-runtime"));
});

test("ensureTestArtifacts rebuilds openclaw for incomplete dist artifacts", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-openclaw-runtime/dist/runtime-adapter.js"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/openclaw-runtime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/openclaw-runtime", "build"]);
});
