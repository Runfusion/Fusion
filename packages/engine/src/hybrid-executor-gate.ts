import type { CentralCore } from "@fusion/core";

export interface HybridExecutorGateDecision {
  enabled: boolean;
  reason: string;
}

function parseEnvOverride(value: string | undefined): HybridExecutorGateDecision | null {
  if (value === "1") {
    return { enabled: true, reason: "env-override" };
  }

  if (value === "0") {
    return { enabled: false, reason: "env-override" };
  }

  return null;
}

export async function shouldUseHybridExecutor(centralCore: CentralCore): Promise<HybridExecutorGateDecision> {
  const envOverride = parseEnvOverride(process.env.FUSION_HYBRID_EXECUTOR);
  if (envOverride) {
    return envOverride;
  }

  try {
    const nodes = await centralCore.listNodes();
    /*
    FNXC:HybridExecutorRouting 2026-07-18-01:35:
    Local project registrations may create more than one local node record. HybridExecutor
    only adds value when a remote node is routable, so node count must not enable duplicate
    local runtimes for a local-only multi-project installation.
    */
    if (nodes.some((node) => node.type === "remote")) {
      return { enabled: true, reason: "multi-node" };
    }

    // Local-only single-node: HybridExecutor's value is cross-node routing.
    // ProjectEngineManager already handles N local projects with one
    // InProcessRuntime per project; running HybridExecutor in parallel just
    // creates a second InProcessRuntime per project, duplicating self-healing
    // recovery and adding ~7s to cold start. Skip until a remote node is
    // registered (set FUSION_HYBRID_EXECUTOR=1 to force-enable).
    return { enabled: false, reason: "single-node-local-only" };
  } catch {
    return { enabled: false, reason: "central-unavailable" };
  }
}
