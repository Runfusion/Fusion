import { describe, it, expect } from "vitest";
import { reconcileDroidCliPaths } from "../plugins/pi-extensions.js";

const VENDORED = "/repo/packages/droid-cli/index.ts";
const GLOBAL_NPM = "/opt/homebrew/lib/node_modules/droid-cli/index.ts";
const PI_AGENT = "/Users/u/.pi/agent/extensions/droid-cli/index.ts";
const UNRELATED = "/Users/u/.pi/agent/extensions/quota.ts";

describe("reconcileDroidCliPaths", () => {
  it("returns input unchanged when no vendored path is supplied", () => {
    const input = [GLOBAL_NPM, UNRELATED];
    expect(reconcileDroidCliPaths(input, null)).toEqual(input);
  });

  it("drops a globally-installed droid-cli and prepends the vendored path", () => {
    const result = reconcileDroidCliPaths([GLOBAL_NPM, UNRELATED], VENDORED);
    expect(result).toEqual([VENDORED, UNRELATED]);
  });

  it("drops droid-cli installed under .pi/agent/extensions/", () => {
    const result = reconcileDroidCliPaths([PI_AGENT, UNRELATED], VENDORED);
    expect(result).toEqual([VENDORED, UNRELATED]);
  });

  it("keeps the vendored path exactly once even if it appears in input", () => {
    const result = reconcileDroidCliPaths(
      [VENDORED, GLOBAL_NPM, UNRELATED],
      VENDORED,
    );
    expect(result).toEqual([VENDORED, UNRELATED]);
  });

  it("preserves the relative order of unrelated extension paths", () => {
    const a = "/ext/a.ts";
    const b = "/ext/b.ts";
    const c = "/ext/c.ts";
    const result = reconcileDroidCliPaths([a, GLOBAL_NPM, b, c], VENDORED);
    expect(result).toEqual([VENDORED, a, b, c]);
  });

  it("does not mistake substrings of droid-cli for the package", () => {
    const looksLike = "/ext/some-droid-cli-helper/index.ts";
    const result = reconcileDroidCliPaths([looksLike], VENDORED);
    expect(result).toEqual([VENDORED, looksLike]);
  });

  it("matches case-insensitively (e.g. on macOS-cased filesystems)", () => {
    const upper = "/opt/homebrew/lib/node_modules/DROID-CLI/index.ts";
    const result = reconcileDroidCliPaths([upper], VENDORED);
    expect(result).toEqual([VENDORED]);
  });
});
