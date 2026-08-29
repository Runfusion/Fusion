import assert from "node:assert/strict";
import test from "node:test";

import { buildDesktopVitestArgs } from "../test-args";

test("defaults to concise dot output when no caller selects a reporter", () => {
  assert.deepEqual(buildDesktopVitestArgs([]), ["run", "--silent=passed-only", "--reporter=dot"]);
  assert.deepEqual(buildDesktopVitestArgs(["src/__tests__/main.test.ts"]), [
    "run",
    "--silent=passed-only",
    "src/__tests__/main.test.ts",
    "--reporter=dot",
  ]);
});

test("forwards exact CI JSON timing flags without adding a conflicting default", () => {
  const shardFlags = ["--reporter=json", "--outputFile.json=.timings/timings-shard1-0.json"];
  assert.deepEqual(buildDesktopVitestArgs(shardFlags), ["run", "--silent=passed-only", ...shardFlags]);
});

test("preserves supported split reporter/output syntax and multiple reporters", () => {
  const callerArgs = [
    "--reporter",
    "json",
    "--outputFile.json",
    ".timings/timings-shard2-0.json",
    "--reporter=verbose",
    "--shard=1/2",
  ];
  assert.deepEqual(buildDesktopVitestArgs(callerArgs), ["run", "--silent=passed-only", ...callerArgs]);
});

test("recognizes the supported short reporter form", () => {
  assert.deepEqual(buildDesktopVitestArgs(["-r=json"]), ["run", "--silent=passed-only", "-r=json"]);
  assert.deepEqual(buildDesktopVitestArgs(["-r", "json"]), ["run", "--silent=passed-only", "-r", "json"]);
});
