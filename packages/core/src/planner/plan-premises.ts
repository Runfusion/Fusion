import { posix } from "node:path";

export const PLAN_PREMISE_KINDS = [
  "file-exists",
  "file-absent",
  "text-present",
  "text-absent",
] as const;

export type PlanPremiseKind = (typeof PLAN_PREMISE_KINDS)[number];

export type PlanPremise =
  | { kind: "file-exists" | "file-absent"; path: string }
  | { kind: "text-present" | "text-absent"; path: string; literal: string };

export type PlanPremisesParseResult =
  | { ok: true; premises: PlanPremise[] }
  | { ok: false; reason: "missing-section" | "empty-section" | "invalid-line" | "invalid-json" | "invalid-premise"; detail: string };

const HEADING = /^## Plan Premises\s*$/;
const NEXT_HEADING = /^##\s+/;
const BULLET = /^- (\{.*\})$/;
const FORBIDDEN_PATH_CHARACTERS = ["\0", "*", "?", "[", "]", "{", "}"] as const;

/*
FNXC:PlanPremises 2026-09-13-04:01:
Plans expose a short closed set of atomic repository facts so release can reject stale assumptions without executing shell, regular expressions, JavaScript, or a model prompt. Parsing is deliberately strict: one JSON object per bullet, exact keys, and a project-relative non-glob path.
*/
function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")
    || FORBIDDEN_PATH_CHARACTERS.some((character) => value.includes(character))) return false;
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return false;
  const normalized = posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.startsWith("../") && !value.split("/").includes("..");
}

function parsePremise(value: unknown): PlanPremise | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!PLAN_PREMISE_KINDS.includes(record.kind as PlanPremiseKind) || !validRelativePath(record.path)) return null;
  const kind = record.kind as PlanPremiseKind;
  const textKind = kind === "text-present" || kind === "text-absent";
  const expected = textKind ? ["kind", "literal", "path"] : ["kind", "path"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  if (textKind) {
    if (typeof record.literal !== "string" || record.literal.length === 0) return null;
    return { kind, path: record.path, literal: record.literal };
  }
  return { kind, path: record.path };
}

/** Parse the mandatory `## Plan Premises` section without interpreting its values. */
export function parsePlanPremises(prompt: string): PlanPremisesParseResult {
  const lines = prompt.replace(/\r\n?/g, "\n").split("\n");
  const headingIndex = lines.findIndex((line) => HEADING.test(line));
  if (headingIndex < 0) return { ok: false, reason: "missing-section", detail: "PROMPT.md is missing ## Plan Premises" };

  const premises: PlanPremise[] = [];
  let sawContent = false;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (NEXT_HEADING.test(line)) break;
    if (line.trim() === "") continue;
    sawContent = true;
    const match = BULLET.exec(line);
    if (!match) return { ok: false, reason: "invalid-line", detail: `Plan Premises line ${index + 1} must be one JSON object bullet` };
    let decoded: unknown;
    try {
      decoded = JSON.parse(match[1]!);
    } catch {
      return { ok: false, reason: "invalid-json", detail: `Plan Premises line ${index + 1} is not valid JSON` };
    }
    const premise = parsePremise(decoded);
    if (!premise) return { ok: false, reason: "invalid-premise", detail: `Plan Premises line ${index + 1} is not an allowed atomic premise` };
    premises.push(premise);
  }
  if (!sawContent || premises.length === 0) return { ok: false, reason: "empty-section", detail: "## Plan Premises must contain at least one premise" };
  return { ok: true, premises };
}
