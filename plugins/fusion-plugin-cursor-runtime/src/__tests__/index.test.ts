import { describe, expect, it } from "vitest";
import plugin from "../index.js";

describe("cursor plugin export", () => {
  it("declares cursor-cli provider contribution", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-cursor-runtime");
    expect(plugin.cliProviders?.[0]?.providerId).toBe("cursor-cli");
    expect(plugin.cliProviders?.[0]?.statusRoute).toBe("/providers/cursor-cli/status");
  });
});
