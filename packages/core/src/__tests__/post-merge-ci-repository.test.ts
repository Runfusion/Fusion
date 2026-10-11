/**
 * RUFU-375 — the CI-evidence repository a post-merge gate must be TOLD about.
 *
 * The behavior under test is a refusal, so the tests are written as claims about what a card may NOT say:
 * no inferred repository, no claim that a CI run is absent, no publish target that is the canonical upstream.
 * Each case names the RUFU-348 measurement it exists to prevent.
 */
import { describe, expect, it } from "vitest";
import {
  buildCiRepositoryNotRunOutput,
  buildPostMergeVerificationPrompt,
  POST_MERGE_CI_REPOSITORY_NOT_RUN_REASON,
  POST_MERGE_CI_REPOSITORY_PLACEHOLDER,
  POST_MERGE_CI_REPOSITORY_REFUSAL_PREFIX,
  POST_MERGE_CI_REPOSITORY_SETTING_KEY,
  POST_MERGE_VERIFICATION_PROMPT,
  resolvePostMergeCiRepository,
  resolvePostMergePublishTargetFacts,
  substituteCiRepositoryVariable,
  WORKFLOW_STEP_NOT_RUN_REASONS,
  postMergeOptionalGroupNode,
  postMergeVerificationOptionalGroupNode,
} from "../index.js";
import { validateGithubRepoSlug } from "../config/settings-validation.js";

describe("postMergeCiRepo resolves through the shared slug validator only", () => {
  it("resolves an owner/repo slug and trims surrounding whitespace", () => {
    expect(resolvePostMergeCiRepository({ postMergeCiRepo: "dustinbyrne/fusion " })).toEqual({
      resolved: true,
      repo: "dustinbyrne/fusion",
    });
  });

  it("reports not-configured when unset or blank, the operator remedy being to SET it", () => {
    for (const settings of [undefined, {}, { postMergeCiRepo: "" }, { postMergeCiRepo: "   " }] as const) {
      expect(resolvePostMergeCiRepository(settings)).toEqual({ resolved: false, cause: "not-configured" });
    }
  });

  it("reports invalid for a present value the validator refuses, the operator remedy being to FIX it", () => {
    for (const raw of ["https://github.com/dustinbyrne/fusion", "dustinbyrne", "a/b/c", "owner/repo/"]) {
      expect(resolvePostMergeCiRepository({ postMergeCiRepo: raw })).toEqual({ resolved: false, cause: "invalid" });
    }
  });

  it("shares the validator with githubTrackingDefaultRepo so the two agree on what a slug is", () => {
    // A second validator drifting from this one is how a value becomes saveable but unusable.
    expect(validateGithubRepoSlug("acme/co-op")).toBe("acme/co-op");
    expect(resolvePostMergeCiRepository({ postMergeCiRepo: "acme/co-op" })).toEqual({
      resolved: true,
      repo: "acme/co-op",
    });
  });

  it("never infers a repository from any other setting", () => {
    // RUFU-348: every one of the twelve refusals was a card that had to GUESS. A fallback re-opens that class.
    const boardWithEveryOtherRepoSet = {
      pushRemote: "origin",
    } as const;
    expect(resolvePostMergeCiRepository(boardWithEveryOtherRepoSet)).toEqual({
      resolved: false,
      cause: "not-configured",
    });
  });
});

describe("publish targets are named by the kind of fact they are, without ever offering the canonical upstream", () => {
  it("separates the declared publishing target from remotes that merely exist", () => {
    /*
    FNXC:PostMergeCiRepository 2026-10-11-04:00 (RUFU-375, Code Review finding P2):
    One flat list made every non-`origin` remote an "allowed publish target", when `extraRemoteNames` is just
    `git remote` output — a read-only mirror configured next to the real publishing remote would have been
    offered as somewhere to push. The split is now in the returned shape, not only in the prose.
    */
    expect(resolvePostMergePublishTargetFacts({ pushRemote: "one-dev main" }, ["origin", "fork", "one-dev"])).toEqual({
      declared: ["one-dev"],
      present: ["fork"],
    });
  });

  it("says plainly that nothing is declared when origin is the only remote", () => {
    // An omitted line reads to a model as "publishing is unconstrained".
    expect(resolvePostMergePublishTargetFacts({ pushRemote: "origin" }, ["origin"])).toEqual({ declared: [], present: [] });
    expect(resolvePostMergePublishTargetFacts(undefined, [])).toEqual({ declared: [], present: [] });
  });

  it("reads the remote name out of a '<remote> <branch>' push target", () => {
    expect(resolvePostMergePublishTargetFacts({ pushRemote: "peer some/branch" })).toEqual({ declared: ["peer"], present: [] });
  });
});

describe("the not-run refusal states the setting, the targets, and what was NOT searched", () => {
  const unset = buildCiRepositoryNotRunOutput({}, ["fork"]);
  const invalid = buildCiRepositoryNotRunOutput({ postMergeCiRepo: "not-a-slug" }, []);

  it("opens with the canonical prefix for every cause", () => {
    for (const output of [unset, invalid]) {
      expect(output.startsWith(POST_MERGE_CI_REPOSITORY_REFUSAL_PREFIX)).toBe(true);
    }
  });

  it("names the exact setting key so the operator does not search for a remedy", () => {
    expect(unset).toContain(POST_MERGE_CI_REPOSITORY_SETTING_KEY);
    expect(invalid).toContain(POST_MERGE_CI_REPOSITORY_SETTING_KEY);
  });

  it("names the declared publish target, and labels an existing-but-undeclared remote as inventory", () => {
    expect(unset).toContain("Publish targets: none declared");
    expect(unset).toContain("Other remotes exist in this checkout (fork) — a remote existing is not authorization to publish there.");
    expect(invalid).toContain("Publish targets: none declared (`merge.pushRemote` is unset or names the canonical `origin`).");
    // A declared target carries the authorization claim; an undeclared remote never does.
    expect(buildCiRepositoryNotRunOutput({ pushRemote: "one-dev main" }, ["fork"]))
      .toContain("Publish targets: one-dev — declared by the `merge.pushRemote` project setting.");
    /*
     * The precise guarantee: `origin` may appear in the PROHIBITION sentence ("never push to the canonical
     * `origin`"), it may never appear in a list of places where publishing IS permitted. Naming it there is
     * what would tell a stalled session to publish against the canonical upstream.
     */
    const originOnly = buildCiRepositoryNotRunOutput({ pushRemote: "origin" }, ["origin"]);
    expect(originOnly).not.toMatch(/Publish targets: [^(—]*\borigin\b/u);
    expect(originOnly).not.toMatch(/Other remotes[^)]*\borigin\b/u);
  });

  it("distinguishes unset from invalid in the sentence itself", () => {
    expect(unset).toContain("is unset");
    expect(invalid).toContain("is set to a value that is not an `owner/repo` slug");
  });

  it("names every repository it refuses to infer, so no reader fills the gap with a default", () => {
    for (const named of ["origin", "githubTrackingDefaultRepo", "merge.pushRemote"]) {
      expect(unset).toContain(named);
    }
  });

  it("never claims a CI run exists or is absent, because no run was searched for", () => {
    // The misreading this guards against is "CI is red", which spends a re-run budget on a fix nobody needs.
    expect(unset).toContain("no CI run was searched for and none was asserted to exist or be absent");
    for (const forbidden of [/no (post-merge )?ci (run|workflow) (exists|found)/i, /ci (run|check) (is )?(missing|absent|failing)/i]) {
      expect(unset).not.toMatch(forbidden);
      expect(invalid).not.toMatch(forbidden);
    }
  });

  it("records its own not-run cause, never reusing the workspace-context class", () => {
    expect(WORKFLOW_STEP_NOT_RUN_REASONS).toContain(POST_MERGE_CI_REPOSITORY_NOT_RUN_REASON);
    expect(POST_MERGE_CI_REPOSITORY_NOT_RUN_REASON).not.toBe("repository-context-unresolved");
  });
});

describe("{{ciRepo}} substitution is literal and total", () => {
  it("replaces every occurrence", () => {
    const prompt = `${POST_MERGE_CI_REPOSITORY_PLACEHOLDER} and ${POST_MERGE_CI_REPOSITORY_PLACEHOLDER}`;
    expect(substituteCiRepositoryVariable(prompt, "acme/widget")).toBe("acme/widget and acme/widget");
  });

  it("does not interpret replacement patterns in the substituted value", () => {
    // String.prototype.replace would expand `$&` to the matched token; a slug validator rejects `$`, but
    // the guarantee belongs to the substitution seam, not to the caller's discipline.
    expect(substituteCiRepositoryVariable(`x ${POST_MERGE_CI_REPOSITORY_PLACEHOLDER} y`, "$&")).toBe("x $& y");
  });

  it("leaves a prompt with no token byte-identical", () => {
    expect(substituteCiRepositoryVariable(POST_MERGE_VERIFICATION_PROMPT.replace(POST_MERGE_CI_REPOSITORY_PLACEHOLDER, "acme/widget"), "acme/widget"))
      .not.toContain(POST_MERGE_CI_REPOSITORY_PLACEHOLDER);
  });
});

describe("the built-in post-merge gate names the repository it must read", () => {
  it("carries the placeholder in the dispatched built-in prompt", () => {
    expect(POST_MERGE_VERIFICATION_PROMPT).toContain(POST_MERGE_CI_REPOSITORY_PLACEHOLDER);
    expect(POST_MERGE_VERIFICATION_PROMPT).toContain(`Post-merge CI evidence repository: ${POST_MERGE_CI_REPOSITORY_PLACEHOLDER}.`);
  });

  it("builds the CI-demanding contract without the token before dispatch", () => {
    expect(buildPostMergeVerificationPrompt("github-actions-full-suite")).toContain(POST_MERGE_CI_REPOSITORY_PLACEHOLDER);
    for (const kind of ["integration-only", "onedev-pipeline", "gitlab-pipeline"] as const) {
      expect(buildPostMergeVerificationPrompt(kind)).not.toContain(POST_MERGE_CI_REPOSITORY_PLACEHOLDER);
    }
  });

  it("keeps the shared publish guardrail repository-agnostic so other contracts gain no slug requirement", () => {
    for (const kind of ["integration-only", "onedev-pipeline", "gitlab-pipeline"] as const) {
      expect(buildPostMergeVerificationPrompt(kind)).toContain("Do not create a pull request");
    }
  });

  it("stamps the built-in group's inner prompt node as requiring the CI repository", () => {
    const group = postMergeVerificationOptionalGroupNode();
    const inner = innerPromptNode(group);
    expect(inner?.config?.requiresCiRepository).toBe(true);
    // RUFU-457 forbids weakening the gate itself: it stays a default-on, read-only gate.
    expect(inner?.config?.gateMode).toBe("gate");
    expect(inner?.config?.toolMode).toBe("readonly");
    expect(group.config?.defaultOn).toBe(true);
  });

  it("leaves a spec that does not opt in without the key, so its config bytes are unchanged", () => {
    const group = postMergeOptionalGroupNode({
      id: "custom-post-merge",
      name: "Custom",
      column: "done",
      description: "Custom evidence",
      prompt: "Read the evidence.",
    });
    const inner = innerPromptNode(group);
    expect(inner?.config).not.toHaveProperty("requiresCiRepository");
    expect(inner?.config?.gateMode).toBe("advisory");
  });
});

/** Read the single prompt node inside an authored `optional-group` node's template. */
function innerPromptNode(node: ReturnType<typeof postMergeVerificationOptionalGroupNode>) {
  const template = (node.config as { template?: { nodes?: Array<{ id: string; config?: Record<string, unknown> }> } }).template;
  return template?.nodes?.find((entry) => entry.id === `${node.id}-step`);
}
