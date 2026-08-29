import { BUILTIN_AGENT_PROMPTS } from "../agents/agent-prompts.js";

const DEFAULT_EXECUTOR_PROMPT = BUILTIN_AGENT_PROMPTS.find((prompt) => prompt.role === "executor")?.prompt ?? "";
const DEFAULT_TRIAGE_PROMPT = BUILTIN_AGENT_PROMPTS.find((prompt) => prompt.id === "default-triage")?.prompt ?? "";
const DEFAULT_TRIAGE_FAST_PROMPT = BUILTIN_AGENT_PROMPTS.find((prompt) => prompt.id === "default-triage-fast")?.prompt ?? "";
const DEFAULT_REVIEWER_PROMPT = BUILTIN_AGENT_PROMPTS.find((prompt) => prompt.role === "reviewer")?.prompt ?? "";
const DEFAULT_MERGER_PROMPT = BUILTIN_AGENT_PROMPTS.find((prompt) => prompt.role === "merger")?.prompt ?? "";

export const BUILTIN_SEAM_PROMPTS: Record<string, string> = {
  execute: DEFAULT_EXECUTOR_PROMPT,
  planning: DEFAULT_TRIAGE_PROMPT,
  "planning-fast": DEFAULT_TRIAGE_FAST_PROMPT,
  "step-execute": DEFAULT_EXECUTOR_PROMPT,
  review: DEFAULT_REVIEWER_PROMPT,
  merge: DEFAULT_MERGER_PROMPT,
};

export function builtinSeamPrompt(seam: string): string {
  return BUILTIN_SEAM_PROMPTS[seam] ?? "";
}

export function builtinPromptConfig(seam: string, name: string): Record<string, unknown> {
  return { seam, name, prompt: builtinSeamPrompt(seam) };
}
