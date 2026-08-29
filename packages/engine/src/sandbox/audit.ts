import { createLogger } from "../logger.js";
import type { RunAuditor } from "../util/run-audit.js";
import type {
  SandboxBackend,
  SandboxCapabilities,
  SandboxFallbackEvent,
  SandboxPolicy,
  SandboxRunOptions,
  SandboxRunResult,
} from "./types.js";

const log = createLogger("sandbox-audit");

async function emitSandboxAudit(
  auditor: RunAuditor,
  type: "sandbox:prepare" | "sandbox:run" | "sandbox:failure" | "sandbox:fallback",
  target: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await auditor.sandbox({ type, target, metadata });
  } catch (error) {
    log.warn(`Failed to emit ${type} audit event: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function makeFallbackPolicy(policy: SandboxPolicy, backendId: SandboxCapabilities["id"], auditor: RunAuditor): SandboxPolicy {
  return {
    ...policy,
    onFallback: (event: SandboxFallbackEvent) => {
      void emitSandboxAudit(auditor, "sandbox:fallback", backendId, {
        backendId,
        fromBackendId: event.fromBackendId,
        toBackendId: event.toBackendId,
        reason: event.reason,
      });
      policy.onFallback?.(event);
    },
  };
}

export function withSandboxAudit(backend: SandboxBackend, auditor: RunAuditor): SandboxBackend {
  let prepared = false;
  const capabilities = backend.capabilities();
  const backendId = capabilities.id;

  return {
    capabilities: () => capabilities,
    prepare: async (policy: SandboxPolicy) => {
      await backend.prepare(makeFallbackPolicy(policy, backendId, auditor));
      if (!prepared) {
        prepared = true;
        await emitSandboxAudit(auditor, "sandbox:prepare", backendId, {
          backendId,
          supportsNetworkPolicy: capabilities.supportsNetworkPolicy,
          supportsFilesystemPolicy: capabilities.supportsFilesystemPolicy,
        });
      }
    },
    run: async (command: string, options: SandboxRunOptions): Promise<SandboxRunResult> => {
      const startedAt = Date.now();
      const commandSnippet = command.slice(0, 200);
      try {
        const result = await backend.run(command, options);
        const durationMs = Date.now() - startedAt;

        await emitSandboxAudit(auditor, "sandbox:run", backendId, {
          backendId,
          command: commandSnippet,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          exitCode: result.exitCode,
          durationMs,
          timedOut: false,
          bufferExceeded: false,
        });

        if (result.exitCode !== 0 || result.timedOut || result.bufferExceeded) {
          await emitSandboxAudit(auditor, "sandbox:failure", backendId, {
            backendId,
            command: commandSnippet,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            bufferExceeded: result.bufferExceeded,
            stderrExcerpt: result.stderr.slice(0, 500),
          });
        }

        return result;
      } catch (error) {
        await emitSandboxAudit(auditor, "sandbox:failure", backendId, {
          backendId,
          command: commandSnippet,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    runStreaming: async (command, options) => backend.runStreaming(command, options),
    dispose: async () => {
      await backend.dispose();
    },
  };
}
