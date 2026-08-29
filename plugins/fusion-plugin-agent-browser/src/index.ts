import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin, PluginSettingSchema } from "@fusion/plugin-sdk";
import { AGENT_BROWSER_SKILLS } from "./skills.js";
import { buildPromptContributions } from "./prompts.js";
import { setupHooks, setupManifest } from "./setup.js";
import { resolveSettings } from "./types.js";
import { AGENT_BROWSER_WORKFLOW_STEPS } from "./workflow-steps.js";
import { AGENT_BROWSER_TOOLS } from "./tools.js";
import { probeAgentBrowserBinary } from "./probe.js";

const MAX_PROBE_TIMEOUT_MS = 30_000;

export const AGENT_BROWSER_SETTINGS_SCHEMA: Record<string, PluginSettingSchema> = {
  enabled: { type: "boolean", label: "Enable Agent Browser", group: "General", defaultValue: true },
  installChannel: { type: "enum", label: "Install Channel", enumValues: ["stable", "beta", "nightly"], defaultValue: "stable", group: "General" },
  commandTimeoutMs: { type: "number", label: "Command Timeout (ms)", defaultValue: 120000, group: "General" },
  headlessMode: { type: "boolean", label: "Headless Mode", defaultValue: true, group: "Browser" },
  allowedDomains: { type: "array", label: "Allowed Domains", itemType: "string", defaultValue: [], group: "Browser" },
  promptExecutorSystem: { type: "string", label: "Executor System Prompt", multiline: true, defaultValue: "When browsing, summarize evidence with URLs.", group: "Prompt Contributions" },
  promptExecutorTask: { type: "string", label: "Executor Task Prompt", multiline: true, defaultValue: "Use browser context only when needed for the task.", group: "Prompt Contributions" },
  promptTriage: { type: "string", label: "Triage Prompt", multiline: true, defaultValue: "Mark tasks requiring browser evidence explicitly.", group: "Prompt Contributions" },
  promptReviewer: { type: "string", label: "Reviewer Prompt", multiline: true, defaultValue: "Verify browser-derived claims are backed by cited pages.", group: "Prompt Contributions" },
  promptHeartbeat: { type: "string", label: "Heartbeat Prompt", multiline: true, defaultValue: "Keep browser interactions bounded and report failures clearly.", group: "Prompt Contributions" },
  skillExposure: { type: "enum", label: "Skill Exposure", enumValues: ["none", "selected", "all"], defaultValue: "selected", group: "Skills" },
};

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-agent-browser",
    name: "Agent Browser Plugin",
    version: "0.1.0",
    description: "Adds agent-browser setup hooks plus skills, prompt contributions, and workflow steps",
    author: "Fusion Team",
    homepage: "https://github.com/gsxdsm/fusion",
    settingsSchema: AGENT_BROWSER_SETTINGS_SCHEMA,
    skills: AGENT_BROWSER_SKILLS.map((s) => ({ skillId: s.skillId, name: s.name })),
    workflowSteps: AGENT_BROWSER_WORKFLOW_STEPS.map((s) => ({ stepId: s.stepId, name: s.name })),
    promptSurfaces: ["executor-system", "executor-task", "triage", "reviewer", "heartbeat"],
    setup: setupManifest,
  },
  state: "installed",
  hooks: {
    onLoad: async (ctx) => {
      try {
        const settings = resolveSettings(ctx.settings);
        plugin.promptContributions = buildPromptContributions(settings);
        const probe = await probeAgentBrowserBinary({ timeoutMs: Math.min(settings.commandTimeoutMs, MAX_PROBE_TIMEOUT_MS) });
        ctx.logger.info(`Agent Browser Plugin loaded — available=${String(probe.available)} channel=${settings.installChannel}`);
        ctx.emitEvent("agent-browser:loaded", { available: probe.available, version: probe.version, settings });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.error(`Agent Browser Plugin probe failed: ${message}`);
        ctx.emitEvent("agent-browser:loaded", { available: false, error: message });
      }
    },
  },
  tools: AGENT_BROWSER_TOOLS,
  skills: AGENT_BROWSER_SKILLS,
  workflowSteps: AGENT_BROWSER_WORKFLOW_STEPS,
  promptContributions: buildPromptContributions(resolveSettings(undefined)),
  setup: {
    manifest: setupManifest,
    hooks: setupHooks,
  },
});

export default plugin;

// ── Verification-scoped app/browser driver (U8) ───────────────────────────────
//
// The navigate/interact/observe driver is exported as a typed capability the
// engine imports DIRECTLY inside the verification run (U5). It is intentionally
// NOT added to `plugin.tools` — the engine only exposes `plugin.tools` to
// coding-agent sessions (`pluginLoader.getPluginTools()`), so keeping the driver
// out of that array is what scopes it to verification and keeps it unreachable
// from normal coding sessions. `browser_fetch_metadata` remains the only
// coding-agent-facing tool.
export {
  launchBrowserDriver,
  createPlaywrightClient,
  type BrowserDriverSession,
  type BrowserAutomationClient,
  type DriverLaunchResult,
  type NavigateOutcome,
  type InteractOutcome,
  type ObserveOutcome,
  type OperationInconclusive,
  type InconclusiveReason,
  type LaunchDriverOptions,
} from "./driver.js";
export { probeBrowserExecutable, type BrowserExecutableProbeResult } from "./probe.js";
