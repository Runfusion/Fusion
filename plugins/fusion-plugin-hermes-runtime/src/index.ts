/**
 * Hermes Runtime Plugin
 *
 * Provides an executable Hermes runtime adapter that drives the local `hermes`
 * CLI as a subprocess. Discovered by Fusion's plugin runtime registry; the
 * settings configured in the dashboard's "Runtimes → Hermes" page flow through
 * `ctx.settings` into the CLI invocation.
 */

import { definePlugin } from "@fusion/plugin-sdk";
import { resolveCliSettings } from "./cli-spawn.js";
import { installFusionSkillIntoHermesHome } from "./fusion-skill-install.js";
import { HermesRuntimeAdapter } from "./runtime-adapter.js";
import type {
  FusionPlugin,
  PluginContext,
  PluginRuntimeFactory,
  PluginRuntimeManifestMetadata,
} from "@fusion/plugin-sdk";

// ── Hermes Runtime Metadata ───────────────────────────────────────────────────

const HERMES_RUNTIME_ID = "hermes";
const HERMES_RUNTIME_VERSION = "0.2.0";

const hermesRuntimeMetadata: PluginRuntimeManifestMetadata = {
  runtimeId: HERMES_RUNTIME_ID,
  name: "Hermes Runtime",
  description: "Drives the local `hermes` CLI (NousResearch/hermes-agent)",
  version: HERMES_RUNTIME_VERSION,
};

// ── Hermes Runtime Factory ────────────────────────────────────────────────────

const hermesRuntimeFactory: PluginRuntimeFactory = async (ctx) => {
  return new HermesRuntimeAdapter(ctx.settings as Record<string, unknown> | undefined);
};

// ── Plugin Definition ─────────────────────────────────────────────────────────

/*
FNXC:ModelCatalog 2026-07-07-08:00:
FN-7630 (GitHub #1931): connecting/activating this plugin must be strictly
additive to Fusion's global provider/model/auth catalogs — it must never
suppress, deactivate, or hide independently-configured custom providers,
models, or auth options. `onLoad`/`onUnload` below intentionally receive no
reference to AuthStorage/ModelRegistry/global settings (see PluginContext in
@fusion/plugin-sdk) so this plugin is structurally incapable of mutating
those stores; it only resolves its own CLI settings, installs its own skill,
and logs/emits its own lifecycle events. Do not widen PluginContext access
from this plugin without re-auditing this invariant.
*/
const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-hermes-runtime",
    name: "Hermes Runtime Plugin",
    version: HERMES_RUNTIME_VERSION,
    description:
      "Drives the local `hermes` CLI for Fusion agents — captures session ids and resumes via --resume.",
    author: "Fusion Team",
    homepage: "https://github.com/NousResearch/hermes-agent",
    runtime: hermesRuntimeMetadata,
  },
  state: "installed",
  hooks: {
    onLoad: (ctx: PluginContext) => {
      const settings = resolveCliSettings(ctx.settings);
      const skillInstall = installFusionSkillIntoHermesHome({ profile: settings.profile });

      if (skillInstall.outcome === "warning") {
        ctx.logger.warn(
          `Hermes Runtime Plugin: Fusion skill auto-install warning: ${skillInstall.reason ?? "unknown"}`,
        );
      } else if (skillInstall.outcome === "skipped") {
        ctx.logger.warn(
          `Hermes Runtime Plugin: Fusion skill auto-install skipped: ${skillInstall.reason ?? "unknown"}`,
        );
      }

      ctx.logger.info(
        `Hermes Runtime Plugin loaded — binary=${settings.binaryPath} model=${settings.model ?? "(default)"} fusionSkill=${skillInstall.outcome}`,
      );
      ctx.emitEvent("hermes-runtime:loaded", {
        runtimeId: HERMES_RUNTIME_ID,
        version: HERMES_RUNTIME_VERSION,
      });
    },
    onUnload: () => {
      // No persistent state to clean up — each prompt spawns a fresh subprocess.
    },
  },
  runtime: {
    metadata: hermesRuntimeMetadata,
    factory: hermesRuntimeFactory,
  },
});

export default plugin;

// ── Public exports ────────────────────────────────────────────────────────────

export { hermesRuntimeMetadata, hermesRuntimeFactory, HERMES_RUNTIME_ID };
export { HermesRuntimeAdapter } from "./runtime-adapter.js";
export {
  resolveCliSettings,
  invokeHermesCli,
  buildHermesArgs,
  parseHermesOutput,
  listHermesProfiles,
} from "./cli-spawn.js";
export {
  installFusionSkillIntoHermesHome,
  resolveBundledFusionSkillSource,
  resolveHermesHome,
} from "./fusion-skill-install.js";
export type { HermesCliSettings, HermesCliResult, HermesProfileSummary } from "./cli-spawn.js";

// Probe re-export for the dashboard's runtime-provider-probes façade.
export { probeHermesBinary } from "./probe.js";
export type { HermesBinaryStatus } from "./probe.js";
