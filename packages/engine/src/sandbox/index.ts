import { BubblewrapBackend } from "./bubblewrap-backend.js";
import { NativeSandboxBackend } from "./native.js";
import type { SandboxBackend, SandboxCapabilities } from "./types.js";

export type {
  SandboxBackend,
  SandboxCapabilities,
  SandboxPolicy,
  SandboxRunOptions,
  SandboxRunResult,
} from "./types.js";

let sandboxBackendOverrideForTests: SandboxBackend | null = null;

export function __setSandboxBackendForTests(backend: SandboxBackend | null): void {
  sandboxBackendOverrideForTests = backend;
}

export function __resetSandboxBackendForTests(): void {
  sandboxBackendOverrideForTests = null;
}

export function resolveSandboxBackend(options?: { backendId?: SandboxCapabilities["id"] }): SandboxBackend {
  if (sandboxBackendOverrideForTests) {
    return sandboxBackendOverrideForTests;
  }

  if (options?.backendId === "bubblewrap" && process.platform === "linux") {
    return new BubblewrapBackend();
  }

  return new NativeSandboxBackend();
}
