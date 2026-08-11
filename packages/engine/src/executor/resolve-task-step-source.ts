/**
 * FNXC:CodeOrganization 2026-08-03-21:50:
 * resolveTaskStepSource peeled from TaskExecutor (U4).
 *
 * Resolve which artifact/parser governs a graph-owned task's step list from its
 * workflow's parse-steps declaration (KTD-12). Returns undefined for legacy tasks
 * (no parse-steps node) so reconcile/resume keep their unchanged behavior.
 */
import type { WorkflowIr } from "@fusion/core";

export function resolveTaskStepSource(
  ir: WorkflowIr | undefined,
): { artifact: string; parser: string } | undefined {
  if (!ir) return undefined;
  for (const node of ir.nodes) {
    if (node.kind !== "parse-steps") continue;
    const cfg = (node.config ?? {}) as { artifact?: unknown; parser?: unknown };
    const parser = typeof cfg.parser === "string" ? cfg.parser : undefined;
    if (!parser) continue;
    const artifact = typeof cfg.artifact === "string" && cfg.artifact.trim() !== "" ? cfg.artifact : "PROMPT.md";
    return { artifact, parser };
  }
  return undefined;
}
