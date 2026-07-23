import { BubblewrapBackend } from "./bubblewrap-backend.js";
import { ContainerSandboxBackend } from "./container.js";
import { NativeSandboxBackend } from "./native.js";
import { SandboxExecBackend } from "./sandbox-exec-backend.js";
import { withSandboxAudit } from "./audit.js";
import type { RunAuditor } from "../util/run-audit.js";
import type { SandboxBackend, SandboxCapabilities } from "./types.js";

export { buildContainerArgv } from "./container-argv.js";
export { ContainerSandboxBackend } from "./container.js";
export { SandboxProvisioningPendingError, requireSandboxProvisioningApproval } from "./provisioning-gate.js";

export type {
  SandboxBackend,
  SandboxCapabilities,
  SandboxFallbackEvent,
  SandboxPolicy,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxRunStreamingOptions,
  SandboxStreamingResult,
} from "./types.js";

let sandboxBackendOverrideForTests: SandboxBackend | null = null;

export function __setSandboxBackendForTests(backend: SandboxBackend | null): void {
  sandboxBackendOverrideForTests = backend;
}

export function __resetSandboxBackendForTests(): void {
  sandboxBackendOverrideForTests = null;
}

export function resolveSandboxBackend(options?: {
  backendId?: SandboxCapabilities["id"];
  auditor?: RunAuditor;
}): SandboxBackend {
  const resolved = (() => {
    if (sandboxBackendOverrideForTests) {
      return sandboxBackendOverrideForTests;
    }

    if (options?.backendId === "bubblewrap" && process.platform === "linux") {
      return new BubblewrapBackend();
    }

    if (options?.backendId === "podman" || options?.backendId === "docker") {
      return new ContainerSandboxBackend({ runtime: options.backendId });
    }

    if (options?.backendId === "sandbox-exec") {
      if (process.platform === "darwin") {
        return new SandboxExecBackend();
      }
      return new NativeSandboxBackend();
    }

    return new NativeSandboxBackend();
  })();

  if (!options?.auditor) {
    return resolved;
  }

  return withSandboxAudit(resolved, options.auditor);
}
