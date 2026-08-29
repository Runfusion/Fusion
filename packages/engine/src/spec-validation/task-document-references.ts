import { access } from "node:fs/promises";
import { join } from "node:path";
import { extractSection } from "../execution/step-session-executor.js";

export interface DanglingTaskDocReference {
  path: string;
  sections: string[];
}

export interface DetectDanglingOptions {
  rootDir: string;
  taskId: string;
  existsImpl?: (absPath: string) => Promise<boolean>;
}

const TASK_PATH_REGEX = /\.fusion\/tasks\/[A-Z0-9]+(?:-[A-Z0-9]+)*\/[^\s`'"\]]+/g;

function normalizePathToken(token: string): string {
  return token.replace(/^[`([{"']+/, "").replace(/[`),.;:!?\]}'"]+$/, "");
}

function collectTaskPaths(text: string): string[] {
  const matches = text.match(TASK_PATH_REGEX) ?? [];
  return matches.map(normalizePathToken);
}

function collectStepSections(stepsSection: string): Array<{ name: string; body: string }> {
  const sections: Array<{ name: string; body: string }> = [];
  const headingMatches = Array.from(stepsSection.matchAll(/^### Step (\d+):[^\n]*$/gm));
  for (let i = 0; i < headingMatches.length; i += 1) {
    const heading = headingMatches[i];
    const start = (heading.index ?? 0) + heading[0].length;
    const end = i + 1 < headingMatches.length ? (headingMatches[i + 1].index ?? stepsSection.length) : stepsSection.length;
    sections.push({ name: `Step ${heading[1]}`, body: stepsSection.slice(start, end).trim() });
  }
  return sections;
}

function collectProducedArtifacts(stepsSection: string): Set<string> {
  const produced = new Set<string>();
  for (const step of collectStepSections(stepsSection)) {
    let inArtifacts = false;
    for (const line of step.body.split("\n")) {
      if (line.trim().startsWith("**Artifacts:**")) {
        inArtifacts = true;
        continue;
      }
      if (inArtifacts && /^##|^###/.test(line.trim())) {
        inArtifacts = false;
      }
      if (!inArtifacts) continue;
      if (!line.includes("(new)")) continue;
      for (const token of collectTaskPaths(line)) {
        produced.add(token);
      }
    }
  }
  return produced;
}

function collectFileScopePaths(promptContent: string): Set<string> {
  const section = extractSection(promptContent, "File Scope");
  const paths = new Set<string>();
  for (const token of collectTaskPaths(section)) {
    paths.add(token);
  }
  return paths;
}

function isWhitelistedSiblingArtifact(path: string): boolean {
  return path.endsWith("/PROMPT.md") || path.endsWith("/task.json") || path.includes("/attachments/");
}

function shouldSkipCandidate(path: string, taskId: string, producedArtifacts: Set<string>, fileScopePaths: Set<string>): boolean {
  if (isWhitelistedSiblingArtifact(path)) return true;
  const thisTaskPrefix = `.fusion/tasks/${taskId}/`;
  if (!path.startsWith(thisTaskPrefix)) return false;
  if (producedArtifacts.has(path)) return true;
  if (fileScopePaths.has(path)) return true;
  return false;
}

export async function detectDanglingTaskDocReferences(
  promptContent: string,
  opts: DetectDanglingOptions,
): Promise<DanglingTaskDocReference[]> {
  const existsImpl = opts.existsImpl ?? (async (absPath: string) => {
    try {
      await access(absPath);
      return true;
    } catch {
      return false;
    }
  });

  const contextSection = extractSection(promptContent, "Context to Read First");
  const stepsSection = extractSection(promptContent, "Steps");
  const producedArtifacts = collectProducedArtifacts(stepsSection);
  const fileScopePaths = collectFileScopePaths(promptContent);

  const references = new Map<string, Set<string>>();
  const addReferences = (sectionName: string, text: string) => {
    for (const path of collectTaskPaths(text)) {
      if (shouldSkipCandidate(path, opts.taskId, producedArtifacts, fileScopePaths)) continue;
      const sectionSet = references.get(path) ?? new Set<string>();
      sectionSet.add(sectionName);
      references.set(path, sectionSet);
    }
  };

  addReferences("Context to Read First", contextSection);
  addReferences("Steps", stepsSection);
  for (const step of collectStepSections(stepsSection)) {
    addReferences(step.name, step.body);
  }

  const dangling: DanglingTaskDocReference[] = [];
  for (const [path, sections] of references.entries()) {
    const absPath = join(opts.rootDir, path);
    if (await existsImpl(absPath)) continue;
    dangling.push({ path, sections: Array.from(sections).sort() });
  }

  return dangling.sort((a, b) => a.path.localeCompare(b.path));
}

export function formatDanglingDiagnostic(refs: DanglingTaskDocReference[]): string {
  if (refs.length === 0) return "REVISE — Dangling task-document references in PROMPT.md: none.";
  const lines = ["REVISE — Dangling task-document references in PROMPT.md:"];
  for (const ref of refs) {
    lines.push(`  - ${ref.path} (cited in: ${ref.sections.join(", ")})`);
    lines.push("    Fix: either remove these references, list the file under File Scope as a (new) artifact, or add a step that creates it before it is read.");
  }
  return lines.join("\n");
}
