import { isSandboxExperimentalEnabled } from "./sandbox-settings.js";
import type { SandboxBackendName, SandboxProjectSettings, Settings } from "../types.js";

/**
 * Sandbox backend override parsing for per-task PROMPT.md content (FN-4639; design from FN-4635).
 *
 * The engine can call these pure helpers to resolve the effective backend with precedence:
 * PROMPT override (`**Sandbox:** <backend>`) > project settings > default native backend.
 */
const SANDBOX_OVERRIDE_RE = /^\*\*Sandbox:\*\*\s*(native|sandbox-exec|bubblewrap|docker|podman|custom)\s*$/im;

export function parseSandboxPromptOverride(prompt: string | undefined): SandboxBackendName | undefined {
  if (!prompt) {
    return undefined;
  }
  const match = prompt.match(SANDBOX_OVERRIDE_RE);
  if (!match) {
    return undefined;
  }

  const backend = match[1];
  return backend === backend.toLowerCase() ? (backend as SandboxBackendName) : undefined;
}

export function resolveSandboxBackend(
  settings: Pick<Settings, "sandbox" | "experimentalFeatures"> | { sandbox?: SandboxProjectSettings } | undefined,
  prompt: string | undefined,
): { backend: SandboxBackendName; source: "default" | "project" | "prompt" } {
  if (!isSandboxExperimentalEnabled(settings)) {
    return { backend: "native", source: "default" };
  }

  const promptOverride = parseSandboxPromptOverride(prompt);
  if (promptOverride) {
    return { backend: promptOverride, source: "prompt" };
  }

  const projectBackend = settings?.sandbox?.backend;
  if (projectBackend) {
    return { backend: projectBackend, source: "project" };
  }

  return { backend: "native", source: "default" };
}
