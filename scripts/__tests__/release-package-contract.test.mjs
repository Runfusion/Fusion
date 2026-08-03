import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

const source = readFileSync(new URL("../release.mjs", import.meta.url), "utf8");

test("local releases build the complete published package surface", () => {
  assert.match(
    source,
    /info\("Building all packages…"\);\s*run\("pnpm build:full"\);/,
    "release.mjs must enable the full CLI package build before packing",
  );
});

test("release smoke typechecks a consumer of the packed plugin SDK", () => {
  const smokeStart = source.indexOf("function runReleaseSmoke()");
  const smokeEnd = source.indexOf("function cleanupSmoke", smokeStart);
  const smoke = source.slice(smokeStart, smokeEnd);

  assert.notEqual(smokeStart, -1);
  assert.notEqual(smokeEnd, -1);
  assert.match(smoke, /plugin-sdk-consumer\.ts/);
  assert.match(smoke, /@runfusion\/fusion\/plugin-sdk/);
  assert.match(smoke, /spawnSync\(\s*"pnpm",\s*\["exec", "tsc", "--project", consumerTsconfigPath\]/);
  assert.match(smoke, /timeout: 120_000/);
  assert.match(smoke, /if \(typecheck\.status !== 0\)/);
});
