import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "@fusion/core";
import { analyzeUvDependencySelection } from "./python-uv-inference.js";

export type DependencyBootstrapDecisionKind = "run" | "no-command" | "configuration-required" | "environment-incompatible";

export interface DependencyBootstrapDecision {
  kind: DependencyBootstrapDecisionKind;
  command: string | null;
  configured: boolean;
  rationale: string;
  refusal?: "configuration-required" | "environment-incompatible";
  refusedCommand?: string;
}

/** A nonblank project command is the sole authoritative bootstrap choice in every lane. */
export function getConfiguredWorktreeInitCommand(settings?: Pick<Settings, "worktreeInitCommand"> | null): string | null {
  const trimmed = settings?.worktreeInitCommand?.trim();
  return trimmed ? trimmed : null;
}

export function getInferredNodeDependencyCommand(rootDir: string): string | null {
  if (existsSync(join(rootDir, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(join(rootDir, "package-lock.json"))) return "npm install";
  if (existsSync(join(rootDir, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(join(rootDir, "bun.lock")) || existsSync(join(rootDir, "bun.lockb"))) return "bun install --frozen-lockfile";
  return null;
}

/*
FNXC:DependencyBootstrap 2026-10-01-02:35:
FN-9438 makes bootstrap inference a shared task-and-merge decision. A declared runtime mismatch or
unselected extras/groups is deterministic configuration evidence, not an installation failure, so it
must stop before a command starts and direct operators to worktreeInitCommand rather than consume retries.
*/
export function resolveUvDependencyBootstrapDecision(
  rootDir: string,
  settings?: Pick<Settings, "worktreeInitCommand"> | null,
  env: NodeJS.ProcessEnv = process.env,
): DependencyBootstrapDecision {
  const configuredCommand = getConfiguredWorktreeInitCommand(settings);
  if (configuredCommand) {
    return {
      kind: "run",
      command: configuredCommand,
      configured: true,
      rationale: "A configured worktreeInitCommand is authoritative and suppresses inferred bootstrap preflight.",
    };
  }

  if (!existsSync(join(rootDir, "uv.lock"))) {
    return { kind: "no-command", command: null, configured: false, rationale: "No uv.lock was found." };
  }

  const uvDecision = analyzeUvDependencySelection(rootDir, env);
  if (uvDecision.kind !== "run") {
    return {
      kind: uvDecision.kind,
      command: uvDecision.command,
      configured: false,
      rationale: uvDecision.rationale,
      refusal: uvDecision.kind,
      refusedCommand: uvDecision.refusedCommand,
    };
  }
  return { kind: "run", command: uvDecision.command, configured: false, rationale: uvDecision.rationale };
}

export function resolveDependencyBootstrapDecision(
  rootDir: string,
  settings?: Pick<Settings, "worktreeInitCommand"> | null,
  env: NodeJS.ProcessEnv = process.env,
): DependencyBootstrapDecision {
  const uvDecision = resolveUvDependencyBootstrapDecision(rootDir, settings, env);
  if (uvDecision.configured || uvDecision.refusal) return uvDecision;

  const nodeCommand = getInferredNodeDependencyCommand(rootDir);
  if (nodeCommand) {
    return { kind: "run", command: nodeCommand, configured: false, rationale: "A supported Node lockfile selected the inferred dependency bootstrap after compatible uv metadata preflight." };
  }

  if (uvDecision.kind === "run") return uvDecision;
  return { kind: "no-command", command: null, configured: false, rationale: "No supported dependency lockfile or configured worktreeInitCommand was found." };
}

/** Render deterministic configuration evidence without exposing PATH directories or environment values. */
export function formatDependencyBootstrapDiagnostic(decision: DependencyBootstrapDecision): string {
  if (!decision.refusal) return decision.rationale;
  return `${decision.rationale} Inferred/refused command: ${decision.refusedCommand ?? decision.command ?? "none"}. Configure worktreeInitCommand with the project-specific bootstrap command.`;
}
