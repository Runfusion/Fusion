import { describe, expect, it } from "vitest";
import plugin from "../index.js";

describe("omp plugin export", () => {
  it("declares omp-cli provider contribution and omp runtime", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-omp-runtime");
    expect(plugin.manifest.runtime?.runtimeId).toBe("omp");
    expect(plugin.runtime?.metadata.runtimeId).toBe("omp");
    expect(plugin.cliProviders?.[0]?.providerId).toBe("omp-cli");
    expect(plugin.cliProviders?.[0]?.statusRoute).toBe("/providers/omp-cli/status");
    expect(plugin.cliProviders?.[0]?.authRoute).toBe("/auth/omp-cli");
    expect(plugin.cliProviders?.[0]?.binaryName).toBe("omp");
    expect(plugin.cliProviders?.[0]?.runtime?.runtimeId).toBe("omp");
  });
});
