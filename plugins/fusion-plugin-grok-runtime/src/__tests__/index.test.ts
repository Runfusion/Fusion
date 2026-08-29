import { describe, expect, it } from "vitest";
import plugin from "../index.js";

describe("grok plugin export", () => {
  it("declares grok-cli provider contribution", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-grok-runtime");
    expect(plugin.cliProviders?.[0]?.providerId).toBe("grok-cli");
    expect(plugin.cliProviders?.[0]?.statusRoute).toBe("/providers/grok-cli/status");
    expect(plugin.cliProviders?.[0]?.authRoute).toBe("/auth/grok-cli");
    expect(plugin.cliProviders?.[0]?.binaryName).toBe("grok");
  });
});
