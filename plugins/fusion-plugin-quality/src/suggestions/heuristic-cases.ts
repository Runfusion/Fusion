import { randomUUID } from "node:crypto";
import type { SuggestedCase } from "../store/quality-types.js";

/*
FNXC:Quality 2026-07-14-21:45:
Heuristic suggested test cases from PROMPT text and file paths — always available without AI.
Advisory only; never merge-blocking.
*/

export interface HeuristicInput {
  title?: string;
  prompt?: string;
  filePaths?: string[];
}

function uniqueCases(cases: SuggestedCase[]): SuggestedCase[] {
  const seen = new Set<string>();
  const out: SuggestedCase[] = [];
  for (const c of cases) {
    const key = c.text.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function caseOf(text: string, source: SuggestedCase["source"] = "heuristic"): SuggestedCase {
  return { id: `sc_${randomUUID()}`, text, done: false, source };
}

/** Extract acceptance-like bullets from markdown prompt. */
export function extractPromptBullets(prompt: string): string[] {
  const lines = prompt.split(/\r?\n/);
  const bullets: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (m?.[1]) bullets.push(m[1].trim());
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading?.[1] && /accept|verif|test|symptom|repro/i.test(heading[1])) {
      bullets.push(`Review section: ${heading[1].trim()}`);
    }
  }
  return bullets.slice(0, 12);
}

export function buildHeuristicSuggestedCases(input: HeuristicInput): SuggestedCase[] {
  const cases: SuggestedCase[] = [];
  const title = (input.title ?? "").trim();
  const prompt = (input.prompt ?? "").trim();
  const files = (input.filePaths ?? []).map((f) => f.trim()).filter(Boolean);

  if (title) {
    cases.push(caseOf(`Manually verify: ${title}`));
  }
  if (/bug|fix|regress/i.test(`${title}\n${prompt}`)) {
    cases.push(caseOf("Reproduce the original symptom and confirm it no longer occurs"));
    cases.push(caseOf("Check related empty/error/loading states on the same surface"));
  }

  for (const bullet of extractPromptBullets(prompt)) {
    if (bullet.length > 8 && bullet.length < 240) {
      cases.push(caseOf(bullet));
    }
  }

  const modules = new Set<string>();
  for (const f of files.slice(0, 20)) {
    const parts = f.split("/");
    const leaf = parts[parts.length - 1] ?? f;
    if (leaf.endsWith(".test.ts") || leaf.endsWith(".test.tsx") || leaf.endsWith(".spec.ts")) {
      cases.push(caseOf(`Run and pass tests in ${leaf}`));
    } else {
      const area = parts.slice(0, 3).join("/") || f;
      modules.add(area);
    }
  }
  for (const area of [...modules].slice(0, 8)) {
    cases.push(caseOf(`Exercise changed code under ${area}`));
  }

  if (files.some((f) => /\.(tsx|css|jsx)$/.test(f))) {
    cases.push(caseOf("Check desktop and mobile breakpoints for the changed UI"));
  }

  if (cases.length === 0) {
    cases.push(caseOf("Smoke the happy path described in the task"));
    cases.push(caseOf("Confirm no obvious regressions in adjacent flows"));
  }

  return uniqueCases(cases).slice(0, 20);
}
