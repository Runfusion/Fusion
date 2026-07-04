import { dirname, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import type { ExecutorRuntimeEnvContribution, ExecutorRuntimeTaskContext, PluginContext } from "@fusion/plugin-sdk";
import type { CliPressStore } from "../store/cli-press-store.js";
import { decodeCredentialValue } from "../store/credentials.js";

function toEpoch(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function buildExecutorRuntimeEnv(
  store: CliPressStore,
  taskCtx: ExecutorRuntimeTaskContext,
  ctx: PluginContext,
): Promise<ExecutorRuntimeEnvContribution> {
  const pathDirs: string[] = [];
  const env: Record<string, string> = {};

  for (const service of await store.listServices()) {
    const specs = (await store.listSpecs(service.id))
      .filter((spec) => spec.status === "generated")
      .sort((a, b) => toEpoch(b.generatedAt ?? b.updatedAt) - toEpoch(a.generatedAt ?? a.updatedAt));

    const selectedSpec = await findExecutableSpec(store, specs);
    if (selectedSpec) {
      const executableArtifacts = (await store.listArtifacts(selectedSpec.id)).filter((artifact) => artifact.executable);
      for (const artifact of executableArtifacts) {
        const absoluteArtifactPath = isAbsolute(artifact.path)
          ? artifact.path
          : join(taskCtx.rootDir, ".fusion", artifact.path);
        if (!existsSync(absoluteArtifactPath)) {
          ctx.logger.warn(
            `[executorRuntimeEnv] Skipping missing artifact for service ${service.slug}: ${absoluteArtifactPath}`,
          );
          continue;
        }
        pathDirs.push(dirname(absoluteArtifactPath));
      }
    }

    for (const credential of await store.listCredentials(service.id)) {
      const credentialKind = (credential as { kind: string }).kind;
      if (credentialKind === "oauth" || credentialKind === "oauth2") {
        throw new Error(`OAuth credentials are not supported for service ${service.slug}`);
      }

      if (credential.kind !== "env_var") {
        continue;
      }

      if (credential.placement.kind !== "env_var") {
        throw new Error(
          `Credential placement mismatch for ${credential.name}: expected env_var placement, got ${credential.placement.kind}`,
        );
      }

      env[credential.placement.envVar] = decodeCredentialValue(credential.value);
    }
  }

  return {
    pathPrepend: Array.from(new Set(pathDirs)),
    env,
    description: "cli-printing-press generated CLIs",
  };
}

/**
 * First spec (in the given order) that owns at least one executable artifact.
 * Pulled out so the loop body stays flat; returns undefined when none qualify.
 */
async function findExecutableSpec(
  store: CliPressStore,
  specs: { id: string }[],
): Promise<{ id: string } | undefined> {
  for (const spec of specs) {
    const artifacts = await store.listArtifacts(spec.id);
    if (artifacts.some((artifact) => artifact.executable)) {
      return spec;
    }
  }
  return undefined;
}
