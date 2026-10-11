import type { ProjectSettings } from "../types.js";
import { validateGithubRepoSlug } from "../config/settings-validation.js";

/*
FNXC:PostMergeCiRepository 2026-10-11-00:37 (RUFU-375):
The built-in post-merge `Full Suite` gate reads a CI run that lives in ONE specific repository, and for a
fork-shaped deployment that repository is not the one a card's worktree points at: this board publishes to
a fork, merges into a canonical upstream, and the Full Suite runs only on the canonical repo. Measured
before this module existed (RUFU-348): 12 of 12 durable `post-merge-verification` refusals across six cards
were of the class "a run in this repository does not and cannot exist" — the gate asked for evidence its
own deployment could never produce, and each card needed a named human waiver.

Three rules make this module worth its existence, and each one is a refusal of a plausible shortcut:

1. NO FALLBACK. `origin`, the `gh` context, `githubTrackingDefaultRepo`, and `merge.pushRemote` are all
   answers to a DIFFERENT question than "where does CI run". This project is the counter-example to every
   one of them: `gh` context returns the canonical upstream (no run), `githubTrackingDefaultRepo` already
   points at the fork — where the Full Suite has never run — and `merge.pushRemote` names where a push
   goes. Inheriting any of them would reintroduce exactly the dead-end that produced those 12 refusals.
2. A MISSING CONFIGURATION IS NOT A VERDICT. An unset or invalid value refuses dispatch through the gate's
   OWN named cause (`ci-repository-unresolved`, a `skipped` + `notRunReason` row) and says plainly that the
   run was not searched for. It never claims "no run exists" — that sentence is a FALSE negative about
   someone else's repository — and it never writes `passed`, which would let the gate's approval semantics
   (and RUFU-391's re-seed of verdict-less gates) operate on a review that never happened.
3. A CONFIGURED REPOSITORY IS NOT A PUBLISH PERMISSION. The slug tells the gate where to LOOK. Publishing
   stays with the configured publishing remotes; the canonical upstream stays a read-only evidence source
   and creating a pull request there is never a remedy for this refusal.

Core owns the rule; the engine owns the reading of git configuration, because core never shells out.
*/

/** Project setting that names the CI-evidence repository. Declared on `ProjectSettings.postMergeCiRepo`. */
export const POST_MERGE_CI_REPOSITORY_SETTING_KEY = "postMergeCiRepo" as const;

/*
FNXC:PostMergeCiRepository 2026-10-11-00:37 (RUFU-375):
The prompt token is DEFINED in `builtin-post-merge-group.ts`, beside the prompt text that carries it, and
re-exported here so the prompt, this resolver, and the engine's substitution seam share exactly one
definition. Re-exporting (rather than defining it here and importing it there) keeps the prompt module a
leaf: importing this module from the prompt builder would pull `settings-validation.ts`, and through it the
`types.ts` barrel that re-exports workflow modules, into the graph the IR parser loads.
*/
export { POST_MERGE_CI_REPOSITORY_PLACEHOLDER } from "./builtin-post-merge-group.js";
import { POST_MERGE_CI_REPOSITORY_PLACEHOLDER } from "./builtin-post-merge-group.js";

/** Not-run cause recorded when the gate cannot name its evidence repository. */
export const POST_MERGE_CI_REPOSITORY_NOT_RUN_REASON = "ci-repository-unresolved" as const;

/** The literal opening of every refusal sentence for this class. Banned from ever claiming a run is absent. */
export const POST_MERGE_CI_REPOSITORY_REFUSAL_PREFIX = "CI repository not configured";

/** The canonical upstream remote name that must never be presented as a publish target. */
const CANONICAL_ORIGIN_REMOTE = "origin";

/** The only settings this resolver reads; kept as a structural type so callers may pass a partial overlay. */
export type PostMergeCiRepositorySettings = Pick<ProjectSettings, "postMergeCiRepo" | "pushRemote">;

export type PostMergeCiRepositoryResolution =
  | { resolved: true; repo: string }
  | { resolved: false; cause: "not-configured" | "invalid" };

/**
 * Resolve the repository whose CI holds the post-landing delivery record.
 *
 * Only the project setting is consulted, and only through `validateGithubRepoSlug` — the same validator
 * `githubTrackingDefaultRepo` uses, so an operator who typed a URL, a bare owner, or whitespace learns the
 * value is unusable at dispatch instead of watching a reviewer search the wrong repository. An absent or
 * blank value is `not-configured`; a present value that is not a slug is `invalid`, because the operator
 * remedy differs (set it vs fix it).
 */
export function resolvePostMergeCiRepository(
  settings: PostMergeCiRepositorySettings | undefined,
): PostMergeCiRepositoryResolution {
  const raw = settings?.postMergeCiRepo;
  const repo = validateGithubRepoSlug(raw);
  if (repo !== undefined) return { resolved: true, repo };
  const present = typeof raw === "string" ? raw.trim().length > 0 : raw !== undefined && raw !== null;
  return { resolved: false, cause: present ? "invalid" : "not-configured" };
}

/**
 * Git remotes relevant to publishing, named by the kind of fact they are.
 *
 * `declared` is what the project NAMES as its publishing target (`merge.pushRemote`, "<remote> [branch]").
 * `present` is what merely EXISTS in the checkout's git config besides it. `origin` is dropped from both:
 * for a fork-shaped board it is the canonical upstream, and naming it in a message that follows "you may not
 * publish there" would contradict the sentence it belongs to.
 *
 * FNXC:PostMergeCiRepository 2026-10-11-04:00 (RUFU-375, Code Review finding P2):
 * These two used to be one flat list under the heading "Allowed publish targets", and that single heading
 * overclaimed. `extraRemoteNames` is read from `git remote` (`executor/post-merge-publish-remotes.ts`), so on
 * this deployment a read-only mirror remote configured alongside `one-dev` would be listed as PERMISSION to
 * publish to it, and a model that had just been refused could act on it. Listing what exists is still worth
 * more than saying nothing — an omitted line reads as "publishing is unconstrained" — so the message now
 * states both facts with the authorization claim attached only to the declared one.
 */
export type PostMergePublishTargetFacts = {
  /** Remotes the project declares as publishing targets, from `merge.pushRemote`. */
  declared: string[];
  /** Remotes present in git config that NO setting declares — presence is not authorization. */
  present: string[];
};

export function resolvePostMergePublishTargetFacts(
  settings: PostMergeCiRepositorySettings | undefined,
  extraRemoteNames: readonly string[] = [],
): PostMergePublishTargetFacts {
  const declared = new Set<string>();
  const pushRemote = typeof settings?.pushRemote === "string" ? settings.pushRemote.trim() : "";
  const pushRemoteName = pushRemote.split(/\s+/)[0];
  if (pushRemoteName && pushRemoteName !== CANONICAL_ORIGIN_REMOTE) declared.add(pushRemoteName);
  const present = new Set<string>();
  for (const name of extraRemoteNames) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed && trimmed !== CANONICAL_ORIGIN_REMOTE && !declared.has(trimmed)) present.add(trimmed);
  }
  return { declared: [...declared].sort(), present: [...present].sort() };
}

/**
 * The refusal the gate records when it cannot name its evidence repository.
 *
 * One sentence per cause, and every variant states three things a card cannot infer for itself: the exact
 * setting key to set, where publishing IS declared to go, and that the run was never searched for — the last
 * is what keeps the sentence from being read as "CI is red", which is the misreading that costs a card its
 * re-run budget on a fix nobody needed.
 */
export function buildCiRepositoryNotRunOutput(
  settings: PostMergeCiRepositorySettings | undefined,
  extraRemoteNames: readonly string[] = [],
): string {
  const resolution = resolvePostMergeCiRepository(settings);
  const publishTargets = resolvePostMergePublishTargetFacts(settings, extraRemoteNames);
  /*
  FNXC:PostMergeCiRepository 2026-10-11-04:00 (RUFU-375, Code Review finding P2):
  Two sentences, two kinds of fact. The authorization clause rides ONLY on the declared remote; the remotes
  that merely exist are reported as inventory with the disclaimer attached, so a stalled session cannot read
  a read-only mirror as somewhere to push.
  */
  const targetsLine = publishTargets.declared.length > 0
    ? `Publish targets: ${publishTargets.declared.join(", ")} — declared by the \`merge.pushRemote\` project setting.`
    : "Publish targets: none declared (`merge.pushRemote` is unset or names the canonical `origin`).";
  const presentLine = publishTargets.present.length > 0
    ? `Other remotes exist in this checkout (${publishTargets.present.join(", ")}) — a remote existing is not authorization to publish there.`
    : undefined;
  const detail = resolution.resolved === false && resolution.cause === "invalid"
    ? `The \`${POST_MERGE_CI_REPOSITORY_SETTING_KEY}\` project setting is set to a value that is not an \`owner/repo\` slug; correct it (the value was not searched for anywhere).`
    : `The \`${POST_MERGE_CI_REPOSITORY_SETTING_KEY}\` project setting is unset, so this gate was never told which repository runs the post-landing Full Suite; it will not guess that from the \`origin\` remote, the \`gh\` context, \`githubTrackingDefaultRepo\`, or \`merge.pushRemote\`.`;
  return [
    `${POST_MERGE_CI_REPOSITORY_REFUSAL_PREFIX}: ${detail}`,
    targetsLine,
    ...(presentLine ? [presentLine] : []),
    "Publishing means pushing a branch to a configured publishing remote — never to the canonical `origin` upstream, and creating a pull request against that upstream is never a remedy for this refusal.",
    "Set the setting, then use Retry to re-run this gate; until then no CI run was searched for and none was asserted to exist or be absent.",
  ].join(" ");
}

/**
 * Replace every `{{ciRepo}}` token with the resolved slug.
 *
 * `split`/`join` rather than `replace`: the replacement string of `String.prototype.replace` interprets
 * `$&`-style patterns, so a literal swap is the only form that cannot rewrite itself. (The slug validator
 * rejects `$`, but the guarantee belongs to the substitution, not to the caller.)
 */
export function substituteCiRepositoryVariable(prompt: string, repo: string): string {
  return prompt.split(POST_MERGE_CI_REPOSITORY_PLACEHOLDER).join(repo);
}
