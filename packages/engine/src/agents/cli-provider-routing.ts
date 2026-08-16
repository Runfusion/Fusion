import type { AgentRuntimeOptions } from "./agent-runtime.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";

export type CliProviderClassification = "registry-native" | "runtime-routed" | "non-cli" | "withheld-unsupported";
export type CliPathPolicy = "fail-fast" | "pinned-pi-fallback" | "assert-available" | "defer-to-resolve-runtime" | "n/a";
export type CliFallbackPolicy = "promote-to-primary" | "defer-to-runtime" | "defer-cross-runtime" | "drop-with-warning" | "none";

export interface CliProviderRouting {
  providerId: string;
  classification: CliProviderClassification;
  runtimeId?: string;
  autoDerive: CliPathPolicy;
  guardNotApplicable: CliPathPolicy;
  onExplicitHint: CliPathPolicy;
  fallbackPolicy: CliFallbackPolicy;
  rationale?: string;
  missingRuntimeError?: () => Error;
  externalFailFastOwner?: string;
}

function unavailable(runtime: string, remediation: string): Error {
  return new Error(`${runtime} models require the bundled ${runtime} runtime plugin. ${remediation}`);
}

export function buildMissingOmpRuntimeError(): Error {
  return new Error(
    "Oh My Pi (omp) models require the bundled OMP runtime plugin. "
    + "Install and enable the OMP Runtime plugin (fusion-plugin-omp-runtime) and ensure the `omp` binary is installed and authenticated (`omp acp`, credentials under ~/.omp).",
  );
}

export function buildMissingGrokRuntimeError(): Error {
  return new Error(
    "Grok CLI models require the bundled Grok CLI runtime when no Fusion-visible GROK_API_KEY is set. "
    + "Install and enable the Grok CLI runtime plugin, or set GROK_API_KEY to use the direct xAI endpoint.",
  );
}

export function buildMissingHermesRuntimeError(): Error {
  return unavailable("Hermes CLI", "Install and enable the Hermes runtime plugin (fusion-plugin-hermes-runtime), install `hermes`, and run `hermes login`.");
}

export function buildMissingClaudeRuntimeError(): Error {
  return unavailable("Claude Code CLI", "Install and enable the Claude runtime plugin (fusion-plugin-claude-runtime), install Claude Code, and authenticate with `claude`.");
}

export function buildMissingCursorRuntimeError(): Error {
  return unavailable("Cursor CLI", "Install and enable the Cursor runtime plugin (fusion-plugin-cursor-runtime), install `cursor-agent`, and authenticate with `cursor-agent login`.");
}

/*
FNXC:CliRuntimeRouting 2026-08-15-13:51:
Picker rows are selectable execution contracts. The census keeps every catalog
provider's route and each unavailable-runtime path explicit so a missing plugin
cannot fall through to pi's unrelated custom-provider guidance after worktree
creation. Grok deliberately differs by path: no-key primary routing fails fast,
while visible-key, fallback-only, and explicit-hint paths retain their shipped
pi fallback. Factory failures remain observations because read-only
resolveRuntime decides them after this seam confirms a registration exists.

FN-9097 verified the supervised cursor-agent stream-json transport. Cursor now
uses the same runtime-routed contract as Hermes/Claude: a missing runtime fails
fast and fallback-only selection is dropped rather than delegated to pi.
*/
export const CLI_PROVIDER_ROUTING_CENSUS: readonly CliProviderRouting[] = [
  { providerId: "pi-claude-cli", classification: "registry-native", autoDerive: "n/a", guardNotApplicable: "n/a", onExplicitHint: "n/a", fallbackPolicy: "none", rationale: "Vendored pi extension resolves through pi's registry." },
  { providerId: "droid-cli", classification: "registry-native", autoDerive: "n/a", guardNotApplicable: "n/a", onExplicitHint: "n/a", fallbackPolicy: "none", rationale: "Vendored pi extension resolves through pi's registry." },
  { providerId: "llama-server", classification: "non-cli", autoDerive: "n/a", guardNotApplicable: "n/a", onExplicitHint: "n/a", fallbackPolicy: "none", rationale: "Llama server is not a bundled CLI runtime route." },
  { providerId: "omp-cli", classification: "runtime-routed", runtimeId: "omp", autoDerive: "fail-fast", guardNotApplicable: "n/a", onExplicitHint: "assert-available", fallbackPolicy: "promote-to-primary", missingRuntimeError: buildMissingOmpRuntimeError, rationale: "OMP's guard covers both primary and fallback selections; runtime factory errors remain resolveRuntime observations." },
  { providerId: "grok-cli", classification: "runtime-routed", runtimeId: "grok", autoDerive: "fail-fast", guardNotApplicable: "pinned-pi-fallback", onExplicitHint: "defer-to-resolve-runtime", fallbackPolicy: "defer-to-runtime", missingRuntimeError: buildMissingGrokRuntimeError, rationale: "Visible-key, fallback-only, and explicit-hint paths intentionally preserve the shipped direct xAI/pi fallback." },
  { providerId: "hermes", classification: "runtime-routed", runtimeId: "hermes", autoDerive: "fail-fast", guardNotApplicable: "pinned-pi-fallback", onExplicitHint: "assert-available", fallbackPolicy: "drop-with-warning", missingRuntimeError: buildMissingHermesRuntimeError, rationale: "Fallback-only Hermes cannot be resolved by a healthy primary pi runtime." },
  { providerId: "claude-cli", classification: "runtime-routed", runtimeId: "claude", autoDerive: "fail-fast", guardNotApplicable: "pinned-pi-fallback", onExplicitHint: "assert-available", fallbackPolicy: "drop-with-warning", missingRuntimeError: buildMissingClaudeRuntimeError, rationale: "Fallback-only Claude CLI cannot be resolved by a healthy primary pi runtime." },
  { providerId: "cursor-cli", classification: "runtime-routed", runtimeId: "cursor", autoDerive: "fail-fast", guardNotApplicable: "pinned-pi-fallback", onExplicitHint: "assert-available", fallbackPolicy: "defer-cross-runtime", missingRuntimeError: buildMissingCursorRuntimeError, rationale: "Cursor fallback is withheld from a healthy foreign runtime and armed for a single prompt-time cross-runtime swap." },
] as const;

export function getCliProviderRouting(providerId: string | undefined): CliProviderRouting | undefined {
  return CLI_PROVIDER_ROUTING_CENSUS.find((entry) => entry.providerId === providerId);
}

function isAvailable(pluginRunner: PluginRunner | undefined, runtimeId: string): boolean {
  try {
    return Boolean(pluginRunner?.getRuntimeById(runtimeId));
  } catch {
    return false;
  }
}

function assertAvailable(entry: CliProviderRouting, pluginRunner: PluginRunner | undefined): void {
  if (!entry.runtimeId || !isAvailable(pluginRunner, entry.runtimeId)) {
    throw entry.missingRuntimeError?.() ?? new Error(`${entry.providerId} runtime is unavailable.`);
  }
}

export function stripCliProviderPrefix(providerId: string, modelId: string | undefined): string | undefined {
  const normalized = modelId?.trim();
  if (!normalized) return normalized;
  const prefix = `${providerId}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

export function deriveCliRuntimeHint(args: {
  runtimeOptions: AgentRuntimeOptions;
  pluginRunner: PluginRunner | undefined;
  grokApiKeyVisible: boolean;
}): string | undefined {
  const { runtimeOptions, pluginRunner, grokApiKeyVisible } = args;
  const primary = getCliProviderRouting(runtimeOptions.defaultProvider);
  const omp = getCliProviderRouting("omp-cli")!;
  if (runtimeOptions.defaultProvider === "omp-cli" || runtimeOptions.fallbackProvider === "omp-cli") {
    assertAvailable(omp, pluginRunner);
    return "omp";
  }
  if (!primary || primary.classification === "registry-native" || primary.classification === "non-cli") return undefined;
  if (primary.classification === "withheld-unsupported") {
    throw primary.missingRuntimeError?.() ?? new Error(`${primary.providerId} is unavailable.`);
  }
  if (primary.providerId === "grok-cli" && grokApiKeyVisible) return undefined;
  assertAvailable(primary, pluginRunner);
  return primary.runtimeId;
}

export function assertExplicitCliRuntimeHint(args: {
  runtimeHint: string | undefined;
  runtimeOptions: AgentRuntimeOptions;
  pluginRunner: PluginRunner | undefined;
}): void {
  if (!args.runtimeHint) return;
  const selected = getCliProviderRouting(args.runtimeOptions.defaultProvider)
    ?? (args.runtimeOptions.fallbackProvider === "omp-cli" ? getCliProviderRouting("omp-cli") : undefined);
  if (!selected || selected.runtimeId !== args.runtimeHint || selected.onExplicitHint !== "assert-available") return;
  if (selected.classification === "withheld-unsupported") {
    throw selected.missingRuntimeError?.() ?? new Error(`${selected.providerId} is unavailable.`);
  }
  assertAvailable(selected, args.pluginRunner);
}

export function applyCliRuntimeOptions(runtimeOptions: AgentRuntimeOptions, runtimeHint: string | undefined): AgentRuntimeOptions {
  if (runtimeHint === "omp" && runtimeOptions.fallbackProvider === "omp-cli" && runtimeOptions.defaultProvider !== "omp-cli") {
    return {
      ...runtimeOptions,
      defaultProvider: "omp-cli",
      defaultModelId: stripCliProviderPrefix("omp-cli", runtimeOptions.fallbackModelId),
      defaultThinkingLevel: runtimeOptions.fallbackThinkingLevel ?? runtimeOptions.defaultThinkingLevel,
      fallbackProvider: undefined,
      fallbackModelId: undefined,
      fallbackThinkingLevel: undefined,
    };
  }
  const entry = getCliProviderRouting(runtimeOptions.defaultProvider);
  if (entry && entry.runtimeId === runtimeHint && entry.classification === "runtime-routed") {
    return { ...runtimeOptions, defaultModelId: stripCliProviderPrefix(entry.providerId, runtimeOptions.defaultModelId) };
  }
  return runtimeOptions;
}

export function dropUnsupportedCliFallback(runtimeOptions: AgentRuntimeOptions): { options: AgentRuntimeOptions; droppedProvider?: string } {
  const entry = getCliProviderRouting(runtimeOptions.fallbackProvider);
  if (!entry || entry.fallbackPolicy !== "drop-with-warning" || runtimeOptions.defaultProvider === entry.providerId) return { options: runtimeOptions };
  return {
    options: { ...runtimeOptions, fallbackProvider: undefined, fallbackModelId: undefined, fallbackThinkingLevel: undefined },
    droppedProvider: entry.providerId,
  };
}
