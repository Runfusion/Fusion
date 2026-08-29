import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("dashboard vitest config aliases runtime plugins to src", () => {
  const content = read("packages/dashboard/vitest.config.ts");
  assert.match(content, /@fusion-plugin-examples\/hermes-runtime/);
  assert.match(content, /@fusion-plugin-examples\/openclaw-runtime/);
  assert.match(content, /@fusion-plugin-examples\/paperclip-runtime/);
  assert.match(content, /plugins\/fusion-plugin-hermes-runtime\/src\/index\.ts/);
  assert.match(content, /plugins\/fusion-plugin-openclaw-runtime\/src\/index\.ts/);
  assert.match(content, /plugins\/fusion-plugin-paperclip-runtime\/src\/index\.ts/);
});

test("cli vitest config aliases runtime plugins to src", () => {
  const content = read("packages/cli/vitest.config.ts");
  assert.ok(content.includes("@fusion-plugin-examples\\/droid-runtime"));
  assert.ok(content.includes("@fusion-plugin-examples\\/hermes-runtime"));
  assert.ok(content.includes("@fusion-plugin-examples\\/openclaw-runtime"));
  assert.ok(content.includes("@fusion-plugin-examples\\/paperclip-runtime"));
  assert.match(content, /plugins\/fusion-plugin-hermes-runtime\/src\/index\.ts/);
  assert.match(content, /plugins\/fusion-plugin-openclaw-runtime\/src\/index\.ts/);
  assert.match(content, /plugins\/fusion-plugin-paperclip-runtime\/src\/index\.ts/);
});

test("engine and plugin-sdk vitest configs keep source aliases", () => {
  const engine = read("packages/engine/vitest.config.ts");
  const sdk = read("packages/plugin-sdk/vitest.config.ts");

  assert.match(engine, /@fusion\/core/);
  assert.match(engine, /\.\.\/core\/src\/index\.ts/);
  assert.match(engine, /@fusion\/plugin-sdk/);

  assert.match(sdk, /@fusion\/core/);
  assert.match(sdk, /\.\.\/core\/src\/index\.ts/);
});
