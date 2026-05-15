import { describe, expect, it } from "vitest";

import type { SandboxBackend, SandboxCapabilities, SandboxPolicy, SandboxRunOptions, SandboxRunResult } from "../types.js";

describe("SandboxBackend types", () => {
  it("accepts a minimal mock backend", async () => {
    const backend: SandboxBackend = {
      capabilities(): SandboxCapabilities {
        return {
          id: "native",
          supportsNetworkPolicy: false,
          supportsFilesystemPolicy: false,
          platform: "any",
        };
      },
      async prepare(_policy: SandboxPolicy): Promise<void> {},
      async run(_command: string, _options: SandboxRunOptions): Promise<SandboxRunResult> {
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          signal: null,
          timedOut: false,
          bufferExceeded: false,
        };
      },
      async dispose(): Promise<void> {},
    };

    await expect(backend.prepare({ allowNetwork: true })).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
  });
});
