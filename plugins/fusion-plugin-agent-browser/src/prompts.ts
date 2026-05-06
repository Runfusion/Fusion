import type { PluginPromptContributions } from "@fusion/plugin-sdk";

export function buildPromptContributions(settings: {
  promptExecutorSystem: string;
  promptExecutorTask: string;
  promptTriage: string;
  promptReviewer: string;
  promptHeartbeat: string;
}): PluginPromptContributions {
  const seed = [
    { surface: "executor-system", content: settings.promptExecutorSystem },
    { surface: "executor-task", content: settings.promptExecutorTask },
    { surface: "triage", content: settings.promptTriage },
    { surface: "reviewer", content: settings.promptReviewer },
    { surface: "heartbeat", content: settings.promptHeartbeat },
  ] as const;

  const contributions: PluginPromptContributions["contributions"] = seed
    .filter((p) => p.content.trim().length > 0)
    .map((p) => ({ surface: p.surface, content: p.content }));

  return { enabledByDefault: false, contributions };
}
