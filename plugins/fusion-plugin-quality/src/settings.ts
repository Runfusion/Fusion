import type { PluginSettingSchema } from "@fusion/plugin-sdk";

/*
FNXC:Quality 2026-07-14-21:45:
Quality plugin settings control retention, log size, and optional root-fallback for task runs.
Defaults keep history bounded and require worktree for task-scoped commands unless operators opt in.
*/

export const settingsSchema: Record<string, PluginSettingSchema> = {
  runRetentionCount: {
    type: "number",
    label: "Run history retention",
    description: "Max finished test runs kept per project. Default: 50.",
    defaultValue: 50,
  },
  logTruncateKb: {
    type: "number",
    label: "Log truncate (KB)",
    description: "Max stdout/stderr stored per run in kilobytes. Default: 64.",
    defaultValue: 64,
  },
  allowRootFallback: {
    type: "boolean",
    label: "Allow project-root fallback for task runs",
    description: "When a task has no worktree, allow targeted runs on project root. Default: false (block).",
    defaultValue: false,
  },
  defaultPreviewScript: {
    type: "string",
    label: "Default preview script",
    description: "Package script used for task preview servers when Dev Server has no selection. Default: dev.",
    defaultValue: "dev",
  },
};

export function getRunRetentionCount(settings: Record<string, unknown> | undefined): number {
  const n = settings?.runRetentionCount;
  return typeof n === "number" && n > 0 ? Math.floor(n) : 50;
}

export function getLogTruncateKb(settings: Record<string, unknown> | undefined): number {
  const n = settings?.logTruncateKb;
  return typeof n === "number" && n > 0 ? Math.floor(n) : 64;
}

export function getAllowRootFallback(settings: Record<string, unknown> | undefined): boolean {
  return settings?.allowRootFallback === true;
}

export function getDefaultPreviewScript(settings: Record<string, unknown> | undefined): string {
  const s = settings?.defaultPreviewScript;
  return typeof s === "string" && s.trim() ? s.trim() : "dev";
}
