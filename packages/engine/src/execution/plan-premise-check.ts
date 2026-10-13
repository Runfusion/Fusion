import { parsePlanPremises, type PlanPremise, type Task, type TaskStore } from "@fusion/core";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { readFile } from "node:fs/promises";
import {
  attachCardCommitRange,
  describeCardGitIdentity,
  evaluatePremiseAtCommit,
  invalidatedByCardDelivery,
  lastCommitTouching,
  resolveCardGitIdentity,
} from "./plan-premise-tree.js";
import { getPromptPath } from "./spec-staleness.js";

/*
FNXC:PlanPremises 2026-09-16-03:20:
Every verdict carries `promptFingerprint` (sha256 of the authoritative prompt the verdict was
computed from) so the RUFU-246 refusal-episode signature can bind a refusal to the exact plan
revision: once replanning rewrites PROMPT.md, the fingerprint changes and the escalation count
resets. An unreadable prompt fingerprints as the empty string.

FNXC:PlanPremises 2026-09-27-02:40:
`premise-invalidated-by-delivery` is a NEW verdict, not a synonym for `stale`. Both mean "a stated
fact no longer holds", but only `stale` means "the plan was written against a repository that has
moved on". When the commits that falsified the facts are the card's OWN (see plan-premise-tree.ts),
replanning is the wrong remedy — the planner would re-derive the same facts from a tree its own
delivery changed — so this verdict must not enter the refusal ladder at all.
*/
export type PlanPremiseCheckResult =
  | { outcome: "satisfied"; promptFingerprint: string; premiseViolations: [] }
  | { outcome: "premise-invalidated-by-delivery"; detail: string; promptFingerprint: string; premiseViolations: PlanPremiseViolation[] }
  | { outcome: "stale"; detail: string; promptFingerprint: string; premiseViolations: PlanPremiseViolation[] }
  | { outcome: "invalid-contract"; detail: string; promptFingerprint: string; premiseViolations: [] }
  | { outcome: "unavailable"; detail: string; promptFingerprint: string; premiseViolations: [] };

/*
FNXC:PlanPremises 2026-09-16-02:49:
RUFU-246 lifts the violated premises out of the prose detail into a structured payload so the
rejection episode can hash exactly the fields that describe WHY the card was refused. Each entry
carries the violated premise JSON and a fixed human-readable reason naming what was found; the
premise's own `path` is its location. A verdict no longer stops reporting at the first violation:
the whole violated set is enumerated so a planner sees every fact that drifted. The shape is
deliberately unchanged by the commit-identity work — the culprit commit rides the prose detail, so
the episode signature of an existing refusal cannot shift under stored episodes.
*/
export interface PlanPremiseViolation {
  premise: PlanPremise;
  reason: string;
}

/*
FNXC:PlanPremises 2026-09-16-02:49:
RUFU-246 requires a stale verdict's detail to enumerate the ENTIRE violated set AND the identity it
was evaluated against, so the bound must survive a few full premise JSONs plus a worker-scoped tmp
root; 320 truncated the root clause in tests. Still one line, still capped.

FNXC:PlanPremises 2026-09-27-02:40:
The clause now also names the commit responsible, which 640 clipped on a multi-premise card.
*/
const MAX_DETAIL = 1024;
const bounded = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);

async function authoritativePrompt(store: TaskStore, task: Task): Promise<string> {
  if (typeof store.getTasksDir === "function") {
    return readFile(getPromptPath(store.getTasksDir(), task.id), "utf8");
  }
  if (typeof task.prompt === "string") return task.prompt;
  throw new Error("authoritative PROMPT.md is unavailable");
}

function enumerate(violations: Array<{ premise: PlanPremise; reason: string }>): string {
  return violations.map((violation) => `${JSON.stringify(violation.premise)} (${violation.reason})`).join("; ");
}

/*
FNXC:PlanPremiseWorkspaceReRoot 2026-10-05-19:14 (RUFU-570):
Name the workspace member the identity was resolved in, relative to the project root. Workspace
members are direct children of the container, so anything that is not exactly one path segment is not
a member and nothing is stripped — a card is never quietly measured against a sibling it did not name.
"" means "evaluate the path exactly as written", which is every single-repo card.
*/
function memberRepositoryName(rootDir: string, repo: string): string {
  if (repo === rootDir) return "";
  const rel = relative(rootDir, repo).split(/[\\/]/).filter(Boolean).join("/");
  return rel.length > 0 && !rel.startsWith("../") && !rel.includes("/") ? rel : "";
}

function reRootedPath(store: TaskStore, repo: string, premise: PlanPremise): { premise: PlanPremise; reRooted: boolean; member: string } {
  let rootDir: string;
  try {
    rootDir = store.getRootDir();
  } catch {
    return { premise, reRooted: false, member: "" };
  }
  const member = memberRepositoryName(rootDir, repo);
  if (member.length === 0) return { premise, reRooted: false, member: "" };
  const prefix = `${member}/`;
  if (!premise.path.startsWith(prefix)) return { premise, reRooted: false, member };
  const path = premise.path.slice(prefix.length);
  if (path.length === 0) return { premise, reRooted: false, member };
  return { premise: { ...premise, path } as PlanPremise, reRooted: true, member };
}

/*
FNXC:PlanPremises 2026-09-27-02:40:
Release evaluates plan facts against the CARD's own committed content — its worktree HEAD, else its
branch tip, else its declared base — never against the project root or common directory. See
plan-premise-tree.ts for the identity ladder and for why every read is a git object read.

FNXC:PlanPremises 2026-09-16-05:35:
The identity is resolved only when the plan actually states a premise, and an unresolvable identity
yields the fail-closed `unavailable` verdict instead of escaping checkPlanPremises as a TypeError:
premise evaluation must never throw at the caller, and a plan stating no facts needs no repository
to prove them (FN-8304's planless Fast cards legitimately state none).
*/
export async function checkPlanPremises(store: TaskStore, task: Task): Promise<PlanPremiseCheckResult> {
  let prompt: string;
  try {
    prompt = await authoritativePrompt(store, task);
  } catch (error) {
    return { outcome: "unavailable", detail: bounded(`Cannot read authoritative plan: ${error instanceof Error ? error.message : String(error)}`), promptFingerprint: "", premiseViolations: [] };
  }
  const promptFingerprint = createHash("sha256").update(prompt).digest("hex");
  const parsed = parsePlanPremises(prompt);
  /*
  FNXC:PlanPremises 2026-09-16-04:08:
  RUFU-246 — the release gate verifies the facts a plan STATES; a plan that states none has nothing
  to falsify, so a missing or empty `## Plan Premises` section releases as vacuously satisfied (the
  behavior every pre-gate spec and its tests encode). Only a section with content that cannot be
  trusted — invalid line, invalid JSON, disallowed premise — is a contract refusal. The parser keeps
  refusing absent/empty sections; this pass-through lives in the checker, which is the surface that
  decides release, so parser strictness and release behavior cannot drift into each other.
  */
  if (!parsed.ok && parsed.reason !== "missing-section" && parsed.reason !== "empty-section") {
    return { outcome: "invalid-contract", detail: bounded(parsed.detail), promptFingerprint, premiseViolations: [] };
  }
  const premises = parsed.ok ? parsed.premises : [];
  if (premises.length === 0) return { outcome: "satisfied", promptFingerprint, premiseViolations: [] };

  const identity = await resolveCardGitIdentity(store, task);
  if (!identity.ok) {
    return { outcome: "unavailable", detail: bounded(identity.detail), promptFingerprint, premiseViolations: [] };
  }

  const violations: PlanPremiseViolation[] = [];
  const resolvedPaths: string[] = [];
  for (const premise of premises) {
    /*
    FNXC:PlanPremiseWorkspaceReRoot 2026-10-05-19:14 (RUFU-570):
    Round 1 made the identity ladder resolve the declared base inside a workspace MEMBER, because a
    workspace root is a container and not a git repository. A premise path is written from the project
    root, so `lager-manager/src/main/java/X.java` is the SAME file the member repo calls
    `src/main/java/X.java`. Reading the written path out of the member's tree would ask that repo for a
    path it has never had and would call a true fact false. The path is therefore re-rooted at the
    member the identity resolved in — and ONLY when its first segment is exactly that member, because
    guessing which sibling a bare path meant is how a premise stops being falsifiable. A single-repo
    card has no member prefix and takes the untouched path.

    The violation keeps the WRITTEN path and only the git read is re-rooted: the refusal-episode
    signature is hashed from the premise as the plan states it, and shifting it under a running card
    would silently reset an escalation count the operator is watching. Both paths are named in the
    reason, because an operator reading only the card must be able to tell whether the plan named the
    wrong file or the resolved-in-member file is what went missing.

    An unresolvable re-rooted path stays `stale`, deliberately and not `unavailable`. We DID measure
    it: `git ls-tree` answered definitively inside the right repository at the right commit, and the
    answer was "not there" — which is the same physical fact that has always produced `stale` for a
    single-repo card, so a card must not get a different kind for the same fact depending on how its
    project is laid out. `unavailable` is the shape reserved for "the engine could not look", and
    claiming that here is what would wedge the card: `hold-release` treats it as a retryable refusal
    with NO episode, NO escalation, and NO replan, so the card would be re-measured forever, produce
    the same definitive negative every time, and never be handed the one remedy that clears a wrong
    path — a replan. `stale` is self-clearing by construction: it rewrites PROMPT.md, the prompt
    fingerprint changes, and the refusal count resets. Only a planner that keeps writing the same
    missing path escalates on, and that refusal is the correct loud one.
    */
    const written = premise.path;
    const resolved = reRootedPath(store, identity.identity.repo, premise);
    const evaluation = await evaluatePremiseAtCommit(identity.identity, resolved.premise);
    /*
    STAS-301: a premise git could not answer is neither satisfied nor violated. It stops the whole
    check right here — a verdict assembled from the premises that happened to be readable would release
    or replan a card on a partial read — and it leaves as `unavailable`, the verdict the release door
    already holds the card for: no episode, no escalation, no replan.
    */
    if (!evaluation.ok) {
      return { outcome: "unavailable", detail: bounded(`Plan premise ${JSON.stringify(premise)} could not be evaluated. ${evaluation.detail} Evaluated at ${describeCardGitIdentity(identity.identity)}.`), promptFingerprint, premiseViolations: [] };
    }
    const verdict = evaluation.value;
    if (!verdict.satisfied) {
      violations.push({ premise, reason: resolved.reRooted ? `${verdict.reason} (written "${written}", resolved inside workspace member "${resolved.member}" as "${resolved.premise.path}")` : verdict.reason });
    }
    resolvedPaths.push(resolved.premise.path);
  }
  if (violations.length === 0) return { outcome: "satisfied", promptFingerprint, premiseViolations: [] };

  /*
  FNXC:PlanPremises 2026-09-27-02:40:
  Attribution decides WHO falsified the facts. A violation whose path was last changed by a commit in
  the card's own `base..tip` set is the card's doing; anything else (an upstream commit, or a path
  the history never carried) is drift the planner has to reconcile. The split is deliberately
  conservative: ONE unattributable violation keeps the whole verdict `stale`, because a card with a
  genuinely outdated plan deserves its replan even if other facts drifted on its own watch.
  */
  const withRange = await attachCardCommitRange(store, task, identity.identity);
  const attributed = [];
  for (const [index, violation] of violations.entries()) {
    const path = resolvedPaths[index] ?? violation.premise.path;
    const delivery = await invalidatedByCardDelivery(withRange, path);
    let upstream: string | null = null;
    if (!delivery) {
      const commit = await lastCommitTouching(withRange, path);
      /*
      STAS-301: an unanswered `git log` used to be reported as "<path> is absent from this history" —
      git never said that. The verdict stays `stale`, the pre-existing fail-closed direction, but the
      detail now says which probe failed instead of asserting a fact nobody observed.
      */
      upstream = commit.ok
        ? (commit.value ?? `${path} is absent from this history`)
        : `${path}'s last commit could not be read (${commit.detail})`;
    }
    attributed.push({ ...violation, delivery, upstream });
  }
  const evaluatedAt = `Evaluated at ${describeCardGitIdentity(withRange)}.`;

  if (attributed.every((violation) => violation.delivery !== null)) {
    const culprits = [...new Set(attributed.map((violation) => violation.delivery as string))].join(", ");
    return {
      outcome: "premise-invalidated-by-delivery",
      detail: bounded(`Plan premises falsified by this card's own delivery — ${enumerate(attributed)}. Falsified by ${culprits}. ${evaluatedAt} Replanning cannot restore these facts.`),
      promptFingerprint,
      premiseViolations: violations,
    };
  }

  const upstreamCulprits = attributed
    .filter((violation) => violation.delivery === null)
    .map((violation) => violation.upstream ?? `${violation.premise.path} is absent from this history`);
  /*
  A mixed premise set refuses loudly, but the refusal also has to say which of its own facts the card
  already delivered: the re-plan this verdict triggers is what re-implements them if the two classes
  are not named separately. The all-delivered case returns above, so this clause only ever appears
  when both classes are present.
  */
  const deliveredCulprits = [...new Set(attributed.flatMap((violation) => (violation.delivery ? [violation.delivery] : [])))].join("; ");
  const alreadyDelivered = deliveredCulprits.length > 0 ? ` Part of it is this card's own delivery: ${deliveredCulprits}.` : "";
  return {
    outcome: "stale",
    detail: bounded(`Plan premise${violations.length === 1 ? "" : "s"} no longer true${violations.length === 1 ? ":" : " —"} ${enumerate(attributed)}. ${evaluatedAt} Falsified by: ${[...new Set(upstreamCulprits)].join("; ")}.${alreadyDelivered}`),
    promptFingerprint,
    premiseViolations: violations,
  };
}
