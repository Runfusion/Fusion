import { parsePlanPremises, type PlanPremise, type Task, type TaskStore } from "@fusion/core";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { getPromptPath } from "./spec-staleness.js";

export type PlanPremiseCheckResult =
  | { outcome: "satisfied" }
  | { outcome: "stale"; detail: string }
  | { outcome: "invalid-contract"; detail: string }
  | { outcome: "unavailable"; detail: string };

const MAX_DETAIL = 320;
const bounded = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);

async function authoritativePrompt(store: TaskStore, task: Task): Promise<string> {
  if (typeof store.getTasksDir === "function") {
    return readFile(getPromptPath(store.getTasksDir(), task.id), "utf8");
  }
  if (typeof task.prompt === "string") return task.prompt;
  throw new Error("authoritative PROMPT.md is unavailable");
}

async function nearestExistingRealPath(path: string): Promise<string> {
  let cursor = path;
  for (;;) {
    try {
      return await realpath(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

async function resolveContained(root: string, premise: PlanPremise): Promise<{ candidate: string; exists: boolean }> {
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, premise.path);
  const anchor = await nearestExistingRealPath(candidate);
  const rel = relative(rootReal, anchor);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(rootReal, rel) !== anchor) {
    throw Object.assign(new Error(`premise path resolves outside project root: ${premise.path}`), { code: "OUTSIDE_ROOT" });
  }
  try {
    await access(candidate, constants.F_OK);
    const actual = await realpath(candidate);
    const actualRel = relative(rootReal, actual);
    if (actualRel === ".." || actualRel.startsWith(`..${sep}`)) {
      throw Object.assign(new Error(`premise path resolves outside project root: ${premise.path}`), { code: "OUTSIDE_ROOT" });
    }
    return { candidate: actual, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { candidate, exists: false };
    throw error;
  }
}

function describe(premise: PlanPremise): string {
  return "literal" in premise
    ? `${premise.kind} ${premise.path} literal ${JSON.stringify(premise.literal).slice(0, 160)}`
    : `${premise.kind} ${premise.path}`;
}

/*
FNXC:PlanPremises 2026-09-13-04:01:
Release evaluates plan facts directly against the current main checkout returned by TaskStore.getRootDir(). The check is stateless and fail-closed; it neither creates a worktree nor persists a validation episode, and symlink resolution may never escape the project root.
*/
export async function checkPlanPremises(store: TaskStore, task: Task): Promise<PlanPremiseCheckResult> {
  let prompt: string;
  try {
    prompt = await authoritativePrompt(store, task);
  } catch (error) {
    return { outcome: "unavailable", detail: bounded(`Cannot read authoritative plan: ${error instanceof Error ? error.message : String(error)}`) };
  }
  const parsed = parsePlanPremises(prompt);
  if (!parsed.ok) return { outcome: "invalid-contract", detail: bounded(parsed.detail) };

  for (const premise of parsed.premises) {
    try {
      const resolved = await resolveContained(store.getRootDir(), premise);
      let satisfied: boolean;
      if (!resolved.exists) {
        satisfied = premise.kind === "file-absent" || premise.kind === "text-absent";
      } else {
        const info = await stat(resolved.candidate);
        /*
        FNXC:PlanPremises 2026-09-13-05:28:
        File and text premises describe regular files, not merely occupied paths. Replacing a source
        file with a directory invalidates file-exists and both text checks; text-absent must not pass
        vacuously when no file content was readable.
        */
        if (!info.isFile()) satisfied = false;
        else if (premise.kind === "file-exists") satisfied = true;
        else if (premise.kind === "file-absent") satisfied = false;
        else {
          const content = await readFile(resolved.candidate, "utf8");
          const present = content.includes((premise as Extract<PlanPremise, { literal: string }>).literal);
          satisfied = premise.kind === "text-present" ? present : !present;
        }
      }
      if (!satisfied) return { outcome: "stale", detail: bounded(`Plan premise is no longer true: ${describe(premise)}`) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "OUTSIDE_ROOT") {
        return { outcome: "invalid-contract", detail: bounded(error instanceof Error ? error.message : String(error)) };
      }
      return { outcome: "unavailable", detail: bounded(`Cannot verify ${describe(premise)}: ${error instanceof Error ? error.message : String(error)}`) };
    }
  }
  return { outcome: "satisfied" };
}
