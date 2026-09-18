import { describe, expect, it } from "vitest";
import { finalizeCliExtensionPaths } from "../extension-paths.js";

const SELF = "/fusion/self-extension.ts";
const DISCOVERED = "/project/.fusion/extensions/local.ts";
const PACKAGE = "/packages/unrelated-extension/index.ts";
const VENDORED = "/fusion/node_modules/@fusion/pi-claude-cli/index.ts";
const EXTERNAL = "/usr/local/lib/node_modules/pi-claude-cli/index.ts";
const DROID = "/fusion/node_modules/@fusion/droid-cli/index.ts";
const LLAMA = "/fusion/node_modules/@fusion/llama-cpp/index.ts";

describe("finalizeCliExtensionPaths", () => {
  it("applies one Claude precedence policy across the assembled CLI candidates", () => {
    const result = finalizeCliExtensionPaths({
      selfExtensionPaths: [SELF],
      discoveredExtensionPaths: [DISCOVERED],
      packageExtensionPaths: [PACKAGE, VENDORED, EXTERNAL],
      claudeCliPaths: [VENDORED],
      droidCliPaths: [DROID],
      llamaCppPaths: [LLAMA],
    });

    expect(result).toEqual([
      VENDORED,
      SELF,
      DISCOVERED,
      PACKAGE,
      DROID,
      LLAMA,
    ]);
  });

  it("preserves candidate order when no vendored Claude adapter is enabled", () => {
    const result = finalizeCliExtensionPaths({
      selfExtensionPaths: [SELF],
      discoveredExtensionPaths: [DISCOVERED],
      packageExtensionPaths: [PACKAGE],
      claudeCliPaths: [],
      droidCliPaths: [DROID],
      llamaCppPaths: [LLAMA],
    });

    expect(result).toEqual([SELF, DISCOVERED, PACKAGE, DROID, LLAMA]);
  });
});
