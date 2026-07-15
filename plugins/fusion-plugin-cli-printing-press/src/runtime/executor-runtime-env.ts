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
  /*
  FNXC:CliPrintingPressRuntime 2026-07-14-18:45:
  Build the runtime catalog with four fixed queries, then join in memory. Per-service and per-spec queries turned the former local SQLite traversal into dispatch-latency fanout after the PostgreSQL cutover.
  */
  const [services, specs, artifacts, credentials] = await Promise.all([
    store.listServices(),
    store.listAllSpecs(),
    store.listAllArtifacts(),
    store.listAllCredentials(),
  ]);
  const specsByService = groupBy(specs, (spec) => spec.serviceId);
  const artifactsBySpec = groupBy(artifacts, (artifact) => artifact.cliSpecId);
  const credentialsByService = groupBy(credentials, (credential) => credential.serviceId);

  for (const service of services) {
    const serviceSpecs = (specsByService.get(service.id) ?? [])
      .filter((spec) => spec.status === "generated")
      .sort((a, b) => toEpoch(b.generatedAt ?? b.updatedAt) - toEpoch(a.generatedAt ?? a.updatedAt));

    const selectedSpec = serviceSpecs.find((spec) =>
      (artifactsBySpec.get(spec.id) ?? []).some((artifact) => artifact.executable));
    if (selectedSpec) {
      const executableArtifacts = (artifactsBySpec.get(selectedSpec.id) ?? []).filter((artifact) => artifact.executable);
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

    for (const credential of credentialsByService.get(service.id) ?? []) {
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

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(value);
    else grouped.set(key, [value]);
  }
  return grouped;
}
