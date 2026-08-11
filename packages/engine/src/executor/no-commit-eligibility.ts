/**
 * FNXC:CodeOrganization 2026-08-03-07:20:
 * noCommitsExpected eligibility heuristics peeled from executor.ts (wave18 / U4 Slice A).
 */
import type { Task } from "@fusion/core";

function getPromptSection(prompt: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = prompt.match(new RegExp(`^##\\s+${escapedHeading}\\s*$([\\s\\S]*?)(?=^##\\s+|$(?![\\s\\S]))`, "im"));
  return match?.[1]?.trim() ?? "";
}

function promptDeclaresReviewLevelOnePlanOnly(prompt: string): boolean {
  return /^##\s+Review Level:\s*1\b[^\n]*\bPlan Only\b/im.test(prompt);
}

function promptDeclaresNoSourceChangeIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return [
    /should\s+not\s+change\s+(?:product\s+)?source/,
    /do\s+not\s+(?:edit|modify|change)\s+(?:product\s+)?source/,
    /no\s+(?:source|code)\s+changes?\s+(?:are\s+)?(?:expected|required|needed|allowed)/,
    /must\s+not\s+(?:edit|modify|change)\s+(?:product\s+)?(?:source|code)/,
  ].some((pattern) => pattern.test(normalized));
}

function promptLooksCoordinationOnly(prompt: string): boolean {
  const titleMatch = prompt.match(/^#\s+Task:\s+[^\n]+/im)?.[0] ?? "";
  const mission = getPromptSection(prompt, "Mission");
  const assessment = prompt.match(/^\*\*Assessment:\*\*\s*([^\n]+)/im)?.[1] ?? "";
  const coordinationText = `${titleMatch}\n${mission}\n${assessment}`.toLowerCase();
  const hasCoordinationIntent = /\b(coordination|routing|route|handoff|assign(?:ment)?|owner|triage|select exactly one|record (?:the )?intentional block)\b/.test(coordinationText);
  const missionLower = mission.toLowerCase()
    .replace(/do\s+not\s+(?:edit|modify|change)\s+(?:product\s+)?source/g, "")
    .replace(/should\s+not\s+change\s+(?:product\s+)?source/g, "")
    .replace(/must\s+not\s+(?:edit|modify|change)\s+(?:product\s+)?(?:source|code)/g, "");
  const hasImplementationDirective = /\b(implement|fix|add|change|modify|refactor|build|create|delete|remove)\b/.test(missionLower);
  return hasCoordinationIntent && !hasImplementationDirective;
}

function promptFileScopeIsBoardOnly(prompt: string): boolean {
  const fileScope = getPromptSection(prompt, "File Scope");
  if (!fileScope.trim()) return false;
  const normalized = fileScope.toLowerCase();
  const sourcePathPattern = /(?:^|[\s`'"(])(?:packages|src|source|sources|app|apps|lib|libs|components|scripts|docs|\.github|config|test|tests|__tests__)\//m;
  const sourceExtensionPattern = /\.(?:ts|tsx|js|jsx|mjs|cjs|swift|kt|java|py|go|rs|rb|php|cs|cpp|c|h|hpp|json|ya?ml|toml|mdx?|css|scss|html|sql|sh)\b/m;
  if (sourcePathPattern.test(normalized) || sourceExtensionPattern.test(normalized)) return false;
  const allowedBoardOnlyPattern = /(?:^|[^\w/])(?:task[- ]?board|board task|task document|task documents|task metadata|task logs|fusion task tools|fn_task_[\w-]*|\.fusion\/tasks|attachments?)(?=$|[^\w/-])/;
  return allowedBoardOnlyPattern.test(normalized);
}

export function getNoCommitEligibilityReason(task: Task): "explicit noCommitsExpected=true" | "prompt-derived coordination-only no-source scope" | null {
  if (task.noCommitsExpected === true) return "explicit noCommitsExpected=true";
  const rawPrompt = task.prompt;
  const prompt = typeof rawPrompt === "string" ? rawPrompt : "";
  if (!prompt.trim()) return null;
  if (
    promptDeclaresReviewLevelOnePlanOnly(prompt) &&
    promptLooksCoordinationOnly(prompt) &&
    promptDeclaresNoSourceChangeIntent(prompt) &&
    promptFileScopeIsBoardOnly(prompt)
  ) {
    return "prompt-derived coordination-only no-source scope";
  }
  return null;
}
