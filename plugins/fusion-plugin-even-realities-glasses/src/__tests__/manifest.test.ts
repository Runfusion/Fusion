import { describe, expect, it } from "vitest";
import manifest from "../../manifest.json";
import { validatePluginManifest } from "@fusion/plugin-sdk";

describe("manifest", () => {
  it("is valid", () => {
    expect(validatePluginManifest(manifest)).toMatchObject({ valid: true });
  });
});
