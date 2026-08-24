import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

const staleModule = "@fusion/dashboard/app/utils/taskStuck";
const files = [
  "packages/dashboard/package.json",
  "packages/dashboard/vite.config.ts",
  "packages/dashboard/vitest.config.ts",
  "packages/dashboard/tsconfig.app.json",
  "packages/dashboard/tsconfig.test-check.json",
  "plugins/fusion-plugin-dependency-graph/tsconfig.json",
];

test("removed taskStuck module has no package, build, test, or plugin aliases", () => {
  for (const file of files) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.equal(source.includes(staleModule), false, `${file} still references ${staleModule}`);
  }
});
