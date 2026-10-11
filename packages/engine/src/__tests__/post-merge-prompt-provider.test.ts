/*
FNXC:PostMergeEvidenceContract 2026-10-01-07:59 (RUFU-457):
Coverage for the prompt-materialization seam — the place where the post-merge gate's reviewer prompt stops
being one GitHub-specific text and becomes the reporter platform's own wording.

Two layers are tested on purpose:
1. `materializePostMergePrompt` as a helper (resolution rules: authored kind wins, byte-exact built-in
   match is the only substitution trigger, a failed contract read cannot break dispatch).
2. The dispatch seam itself — the built-in gate's real template node run through `runGraphCustomNode` with
   the executor's own store double — asserting the text handed to the session. A helper test alone would
   stay green if the wiring were dropped, which is exactly how RUFU-430's `provider` axis shipped with one
   reporter implemented: the machinery existed and nothing called it with the platform's text.

Absence assertions read the shipped blocks, not a wish list: the OneDev/GitLab contracts deliberately MENTION
GitHub's shard artifacts and the Actions smoke job inside a "Do NOT demand …" sentence, so "no GitHub
vocabulary" is asserted as (a) none of GitHub's actual demands present and (b) every line that names Actions
sits inside that prohibition. Asserting the bare word is absent would either fail on correct text or force
the block to lose the sentence that stops a reviewer demanding shards.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_WORKFLOWS,
  POST_MERGE_CI_REPOSITORY_PLACEHOLDER,
  POST_MERGE_VERIFICATION_PROMPT,
  buildPostMergeVerificationPrompt,
  derivePostMergeEvidenceContract,
  parseDeclaredPostMergeEvidence,
  type PostMergeEvidenceContract,
} from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";
import {
  WORKFLOW_POST_MERGE_EVIDENCE_KIND_CONTEXT_KEY,
  postMergeEvidenceKindOfContext,
} from "../workflows/workflow-graph-executor.js";
import { materializePostMergePrompt } from "../executor/post-merge-prompt.js";
import { resetPostMergeEvidenceContractCacheForTest } from "../merge/post-merge-evidence-contract.js";

/** One contract per reporter, built by the real derivation so these fixtures cannot drift from its rules. */
function contractFor(provider: "onedev" | "gitlab" | "github-actions" | "none"): PostMergeEvidenceContract {
  const remotes = {
    onedev: "https://onedev.example.com/fusion/saneca.git",
    gitlab: "https://gitlab.example.com/team/test-banks.git",
    "github-actions": "https://github.com/runfusion/fusion.git",
    none: "http://192.168.12.60:6610/lan/internal.git",
  } as const;
  const declared = provider === "onedev"
    ? parseDeclaredPostMergeEvidence({ provider: "onedev", baseUrl: "https://onedev.example.com", tokenSecret: "onedev-token" })
    : undefined;
  const endpoints = provider === "onedev"
    ? [{ provider: "onedev" as const, baseUrl: "https://onedev.example.com", credentialConfigured: true }]
    : provider === "gitlab"
      ? [{ provider: "gitlab" as const, baseUrl: "https://gitlab.example.com", credentialConfigured: true }]
      : [];
  const contract = derivePostMergeEvidenceContract({
    ...(declared ? { declared } : {}),
    repo: {
      factsReadable: true,
      remoteUrl: remotes[provider],
      githubWorkflowFileCount: provider === "github-actions" ? 3 : 0,
    },
    endpoints,
  });
  // A fixture that silently derived something else would test nothing, so pin its identity first.
  expect(contract.provider).toBe(provider);
  return contract;
}

function dispatch(contract: PostMergeEvidenceContract | undefined, params: {
  prompt?: string;
  authoredKind?: string;
} = {}) {
  return materializePostMergePrompt({
    prompt: params.prompt ?? POST_MERGE_VERIFICATION_PROMPT,
    ...(params.authoredKind ? { authoredKind: params.authoredKind as never } : {}),
    store: null,
    resolveContract: async () => contract,
  });
}

/** Every GitHub demand the full-suite contract makes; a non-GitHub prompt must make none of them. */
const GITHUB_ONLY_DEMANDS = [
  "test-timings-shard-1",
  "test-timings-shard-4",
  "Full Suite",
  "1/4",
  "run ID and run SHA",
] as const;

/** Words a reviewer on another platform cannot name; they may appear ONLY inside the explicit prohibition. */
function expectNoGitHubDemand(prompt: string): void {
  for (const demand of GITHUB_ONLY_DEMANDS) expect(prompt).not.toContain(demand);
  for (const line of prompt.split("\n").filter((row) => row.includes("Actions"))) {
    expect(line).toMatch(/Do NOT demand|produces none/);
  }
}

describe("materializePostMergePrompt", () => {
  it("hands an OneDev board the OneDev record, with no GitHub demand in it", async () => {
    const prompt = await dispatch(contractFor("onedev"));

    expect(prompt).toContain("OneDev pipeline evidence");
    expect(prompt).toContain("build id");
    expect(prompt).toContain("job/step conclusions");
    expect(prompt).toContain("publish none");
    expectNoGitHubDemand(prompt);
    // The verdict protocol is shared verbatim across all four contracts.
    expect(prompt).toContain('{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}');
    expect(prompt).toContain("An empty `notes` string is a protocol violation");
  });

  it("hands a GitLab board the pipeline record, with no GitHub demand in it", async () => {
    const prompt = await dispatch(contractFor("gitlab"));

    expect(prompt).toContain("GitLab pipeline evidence");
    expect(prompt).toContain("pipeline id");
    expect(prompt).toContain("Every job in that pipeline");
    expect(prompt).toContain("artifact list");
    expectNoGitHubDemand(prompt);
  });

  it("leaves an edited prompt byte-identical, because an edit is the operator's wording", async () => {
    const edited = `${POST_MERGE_VERIFICATION_PROMPT}\n\nAlso check the deployment.`;
    const resolveContract = vi.fn(async () => contractFor("onedev"));
    const prompt = await materializePostMergePrompt({
      prompt: edited,
      store: { getRootDir: () => { throw new Error("the store must not be read for an edited prompt"); } },
      resolveContract,
    });

    expect(prompt).toBe(edited);
    expect(prompt).not.toContain("OneDev");
    // Non-vacuous ordering check: the byte comparison short-circuits BEFORE any contract read, so an
    // unrelated or edited node costs no settings read and no `git remote` shellout.
    expect(resolveContract).not.toHaveBeenCalled();
  });

  // Controls: the two contracts that must not move at all. This is the byte-identical bar the card is graded on.
  it("keeps the GitHub contract byte-for-byte identical to today's text", async () => {
    const prompt = await dispatch(contractFor("github-actions"));
    expect(prompt).toBe(POST_MERGE_VERIFICATION_PROMPT);
    expect(prompt).toBe(buildPostMergeVerificationPrompt("github-actions-full-suite"));
  });

  it("keeps the no-reporter contract byte-for-byte identical to today's text", async () => {
    expect(await dispatch(contractFor("none"))).toBe(POST_MERGE_VERIFICATION_PROMPT);
  });

  it("keeps an authored evidence kind ahead of the platform default", async () => {
    // An OneDev board whose workflow authored `integration-only` is a repo fact, not a host fact.
    const prompt = await dispatch(contractFor("onedev"), { authoredKind: "integration-only" });

    expect(prompt).toBe(buildPostMergeVerificationPrompt("integration-only"));
    expect(prompt).not.toContain("OneDev");
  });

  it("dispatches the historical text when the contract cannot be read at all", async () => {
    // A failing contract read must never be the reason a gate has no prompt.
    const store = { getRootDir: () => { throw new Error("store down"); } } as never;
    const prompt = await materializePostMergePrompt({ prompt: POST_MERGE_VERIFICATION_PROMPT, store });

    expect(prompt).toBe(POST_MERGE_VERIFICATION_PROMPT);
  });
});

describe("post-merge prompt dispatch seam", () => {
  afterEach(() => {
    resetPostMergeEvidenceContractCacheForTest();
  });

  beforeEach(() => {
    resetExecutorMocks();
    resetPostMergeEvidenceContractCacheForTest();
    // Quiet git for the executor's own plumbing; the two contract facts are answered per test.
    mockedExecSync.mockImplementation((cmd: string) => {
      if (/rev-parse --is-inside-work-tree/.test(cmd)) return "true\n";
      if (/remote get-url origin/.test(cmd)) return "https://onedev.example.com/fusion/saneca.git\n";
      return "";
    });
  });

  /** The real built-in gate node, so this asserts against the shipped prompt text and not a copy of it. */
  function builtInPostMergeTemplateNode(): { id: string; kind: string; config: Record<string, unknown> } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coding: any = BUILTIN_WORKFLOWS.find((wf) => wf.id === "builtin:coding");
    const group: any = (coding?.ir?.nodes ?? []).find((node: any) => node.id === "post-merge-verification");
    const inner: any = (group?.config?.template?.nodes ?? []).find((node: any) => node.kind === "prompt");
    if (!inner) throw new Error("built-in post-merge template node not found");
    return inner;
  }

  function makeExecutor(store: ReturnType<typeof createMockStore>) {
    const agentStore = { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() };
    return new TaskExecutor(store as any, "/tmp/test", { agentStore, pluginRunner: undefined } as any);
  }

  function makeTask() {
    const now = new Date().toISOString();
    return {
      id: "FN-PM-1",
      title: "Post-merge prompt",
      description: "verify the landing",
      column: "in-review",
      worktree: "/tmp/test",
      branch: "fusion/fn-pm-1",
      baseCommitSha: "abc123",
      dependencies: [],
      steps: [{ name: "verify", status: "in-progress" }],
      currentStep: 0,
      log: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Dispatch the built-in node and return the prompt the session was handed. */
  async function dispatchedPrompt(params: {
    settings?: Record<string, unknown>;
    context?: Record<string, unknown>;
  } = {}): Promise<string> {
    const store = createMockStore();
    store.getTask.mockResolvedValue(makeTask() as never);
    store.readRawProjectSettings = vi.fn(async () => params.settings ?? {});
    store.getSecretsStore = vi.fn(async () => ({ listSecrets: async () => [{ id: "onedev-token", key: "onedev-token" }] }));
    const executor = makeExecutor(store);

    const captured: { prompt?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.prompt = args[1]?.prompt;
      return { success: true, output: '{"verdict":"APPROVE","notes":"Evidence recorded."}' };
    });

    const node = builtInPostMergeTemplateNode();
    expect(node.config.prompt).toBe(POST_MERGE_VERIFICATION_PROMPT);

    // Facade order is (node, task, settings, columnBinding, graphContext, …): the run context is the FIFTH arg.
    //
    /*
    FNXC:PostMergeCiRepository 2026-10-11-02:55 (RUFU-375):
    The board's project settings go to BOTH seams now: the contract read (`readRawProjectSettings`, which picks the
    reporter platform) and the facade's `settings` argument, which is where production hands the same merged object
    to the CI-repository guard. Passing `{}` there kept this fixture green only while the built-in prompt named no
    repository; a post-merge gate that cannot name its CI-evidence repository now refuses before the session, so a
    fixture that wants its prompt text inspected must state the repository it reads evidence from.
    */
    const result = await (executor as any).runGraphCustomNode(node, { id: "FN-PM-1" }, params.settings ?? {}, undefined, params.context ?? undefined);
    expect(result.outcome).toBe("success");
    expect(captured.prompt).toBeTruthy();
    return captured.prompt as string;
  }

  it("substitutes the OneDev record for the built-in gate on an OneDev board", async () => {
    const prompt = await dispatchedPrompt({
      settings: { postMergeEvidence: { provider: "onedev", baseUrl: "https://onedev.example.com", tokenSecret: "onedev-token" } },
    });

    expect(prompt).toContain("OneDev pipeline evidence");
    expectNoGitHubDemand(prompt);
  });

  it("keeps the built-in text on a board whose facts name no reporter", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (/rev-parse --is-inside-work-tree/.test(cmd)) return "true\n";
      // No origin at all: the fail-closed reason must not acquire another platform's vocabulary.
      if (/remote get-url origin/.test(cmd)) throw new Error("error: No such remote 'origin'");
      return "";
    });

    /*
    FNXC:PostMergeCiRepository 2026-10-11-02:55 (RUFU-375):
    This case's subject is unchanged — a board whose remote facts name no reporter keeps GitHub's built-in text
    rather than acquiring another platform's vocabulary. It now declares `postMergeCiRepo`, because that is what
    makes the built-in gate runnable at all: the assertion is the built-in text with the token filled in, and the
    no-origin mock above still proves nothing else was substituted.
    */
    expect(await dispatchedPrompt({ settings: { postMergeCiRepo: "runfusion/fusion" } }))
      .toBe(POST_MERGE_VERIFICATION_PROMPT.replace(POST_MERGE_CI_REPOSITORY_PLACEHOLDER, "runfusion/fusion"));
  });

  it("applies the authored kind carried in the optional-group run context", async () => {
    const prompt = await dispatchedPrompt({
      settings: { postMergeEvidence: { provider: "onedev", baseUrl: "https://onedev.example.com", tokenSecret: "onedev-token" } },
      context: { [WORKFLOW_POST_MERGE_EVIDENCE_KIND_CONTEXT_KEY]: "integration-only" },
    });

    expect(prompt).toBe(buildPostMergeVerificationPrompt("integration-only"));
  });

  it("reads a kind the run context did not author as 'authored nothing'", () => {
    // A persisted continuation from an older build carries no key at all.
    expect(postMergeEvidenceKindOfContext(undefined)).toBeUndefined();
    expect(postMergeEvidenceKindOfContext({})).toBeUndefined();
    // A value that is not on the allow-list reads as authored nothing rather than trusting the row.
    expect(postMergeEvidenceKindOfContext({ [WORKFLOW_POST_MERGE_EVIDENCE_KIND_CONTEXT_KEY]: "azure-pipelines" })).toBeUndefined();
    expect(postMergeEvidenceKindOfContext({ [WORKFLOW_POST_MERGE_EVIDENCE_KIND_CONTEXT_KEY]: "onedev-pipeline" })).toBe("onedev-pipeline");
  });
});
