// Engine-side construction of the git + agent operations the U5 review-response
// run needs. These close over the engine-owned store/settings/worktree and the
// session helpers — the CLI composition layer supplies only the GitHub-client
// callbacks + a project-root resolver (it never holds these engine concerns).
//
// Kept separate from `pr-response-run.ts` (the pure orchestration) so the
// orchestration stays trivially unit-testable with fakes and these I/O builders
// can be excluded from those tests.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrEntity, Settings, TaskStore } from "@fusion/core";
import { resolveAgentPrompt, resolveMergerFallbackModel } from "@fusion/core";
import { createResolvedAgentSession, resolveMergerSessionModel, resolveMergerThinkingLevel, resolveMergerFallbackThinkingLevel } from "./agent-session-helpers.js";
import { resolveMcpServersForStore } from "./mcp-resolution.js";
import { promptWithFallback } from "./pi.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { checkSessionError } from "./usage-limit-detector.js";
import {
  buildResponseSystemPrompt,
  type PrAgentRunResult,
  type PrPushResult,
  type PrThreadVerdict,
} from "./pr-response-run.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * The per-thread verdict marker the agent emits. The agent run is instructed to
 * end with one `PR_THREAD:` line per thread; we parse them into structured
 * verdicts. Fail-safe: a thread with no parseable verdict is treated as a
 * disagreement (never an unrequested code change, never a silent fix).
 */
const VERDICT_LINE_RE = /^PR_THREAD:\s*(\S+)\s+(fix|disagree)\b\s*(.*)$/i;

export function parseAgentVerdicts(text: string, threadIds: string[]): PrThreadVerdict[] {
  const dispatched = new Set(threadIds);
  const byThread = new Map<string, PrThreadVerdict>();
  for (const line of (text ?? "").split(/\r?\n/)) {
    const m = VERDICT_LINE_RE.exec(line.trim());
    if (!m) continue;
    const [, threadId, decisionRaw, reply] = m;
    // Security: only honor verdicts for threads we actually dispatched. An
    // out-of-batch thread id is either model confusion or an injected/echoed
    // forgery from untrusted comment text — ignore it.
    if (!dispatched.has(threadId)) continue;
    const decision = decisionRaw.toLowerCase() === "fix" ? "fix" : "disagree";
    const prior = byThread.get(threadId);
    // Conflicting duplicate verdicts for the same thread fail safe to disagree
    // (never auto-resolve a thread on an ambiguous signal).
    if (prior && prior.decision !== decision) {
      byThread.set(threadId, {
        threadId,
        decision: "disagree",
        reply: "Conflicting verdicts emitted for this thread; leaving it for human review.",
      });
      continue;
    }
    byThread.set(threadId, { threadId, decision, reply: reply.trim() || "(no reasoning provided)" });
  }
  // Fail-safe default for any thread the agent did not emit a verdict for.
  const verdicts: PrThreadVerdict[] = [];
  for (const id of threadIds) {
    verdicts.push(
      byThread.get(id) ?? {
        threadId: id,
        decision: "disagree",
        reply: "No actionable change was identified for this thread.",
      },
    );
  }
  return verdicts;
}

/** Build the engine-owned mutating agent runner for the response run. */
export function makePrResponseAgentRunner(
  settings: Settings,
  taskId: string,
  cwd: string,
  store?: TaskStore,
  /*
   * FNXC:GrokCliRouting 2026-07-15-09:58:
   * PR-response createResolvedAgentSession must share chat/executor plugin-runtime injection so grok-cli/no-key merger models resolve via getRuntimeById("grok") instead of dual-remediation error or pi fallthrough.
   */
  pluginRunner?: import("./plugin-runner.js").PluginRunner,
): (input: {
  prompt: string;
  systemPrompt: string;
  signal?: AbortSignal;
  threads: Array<{ id: string }>;
}) => Promise<PrAgentRunResult> {
  return async ({ prompt, systemPrompt, signal, threads }) => {
    const model = resolveMergerSessionModel(settings);
    // FNXC:Settings-MergerModel 2026-07-16-00:00: PR-response retries use the merger-only fallback lane, retaining shared fallback inheritance when unset.
    const mergerFallbackModel = resolveMergerFallbackModel(settings);
    let captured = "";
    /*
     * FNXC:McpConfig 2026-06-26-00:00:
     * PR-response review threads are resolved by a merger-purpose coding agent, so this helper must forward the same store-resolved MCP set as the primary merger lane. Only counts/errors may be logged by callers; the server payload can contain materialized secrets.
     */
    const mcpServers = store ? (await resolveMcpServersForStore(store)).servers : undefined;
    // Append the strict verdict-output contract to the (untrusted-declaring)
    // system prompt so the agent emits parseable per-thread decisions.
    const fullSystem = [
      systemPrompt,
      "",
      "OUTPUT CONTRACT:",
      "  After making any code changes and committing them, end your turn with",
      "  exactly one line per thread of the form:",
      "    PR_THREAD: <threadId> fix <one-line summary of the change>",
      "    PR_THREAD: <threadId> disagree <one-line reasoning>",
    ].join("\n");
    const { session } = await createResolvedAgentSession({
      sessionPurpose: "merger",
      pluginRunner,
      cwd,
      systemPrompt: fullSystem,
      tools: "coding",
      onText: (delta: string) => {
        captured += delta;
      },
      defaultProvider: model.provider,
      defaultModelId: model.modelId,
      fallbackProvider: mergerFallbackModel.provider,
      fallbackModelId: mergerFallbackModel.modelId,
      fallbackThinkingLevel: resolveMergerFallbackThinkingLevel(settings),
      defaultThinkingLevel: resolveMergerThinkingLevel(settings),
      settings,
      taskId,
      mcpServers,
    });
    try {
      await withRateLimitRetry(async () => {
        await promptWithFallback(session, prompt);
        checkSessionError(session);
      }, { signal });
    } finally {
      session.dispose();
    }
    return { verdicts: parseAgentVerdicts(captured, threads.map((t) => t.id)) };
  };
}

/**
 * Build the git ops (content read, worktree head, fast-forward push) bound to a
 * worktree `cwd`. The push is fast-forward-ONLY — there is no force-push path.
 */
export function makePrResponseGitOps(getCwd: (entity: PrEntity) => string): {
  getChangedContent: (entity: PrEntity) => Promise<Array<{ path: string; content: string }>>;
  getWorktreeHeadOid: (entity: PrEntity) => Promise<string | null>;
  fetchAndFastForwardPush: (entity: PrEntity) => Promise<PrPushResult>;
} {
  return {
    getChangedContent: async (entity) => {
      const cwd = getCwd(entity);
      // Diff the local branch tip against its upstream to read what would be
      // pushed. `@{u}...HEAD` enumerates the commits unique to HEAD.
      const range = `origin/${entity.headBranch}..HEAD`;
      const names = (await git(["diff", "--name-only", range], cwd).catch(() => "")).split("\n").map((l) => l.trim()).filter(Boolean);
      const out: Array<{ path: string; content: string }> = [];
      for (const path of names) {
        const content = await git(["show", `HEAD:${path}`], cwd).catch(() => "");
        out.push({ path, content });
      }
      return out;
    },
    getWorktreeHeadOid: async (entity) => {
      const cwd = getCwd(entity);
      return (await git(["rev-parse", "HEAD"], cwd).catch(() => "")) || null;
    },
    fetchAndFastForwardPush: async (entity) => {
      const cwd = getCwd(entity);
      const branch = entity.headBranch;
      await git(["fetch", "origin", branch], cwd).catch(() => undefined);
      // Local must be ahead-of or equal-to origin (fast-forward). If origin has
      // commits we don't have (human pushed in between) → non-ff, abort.
      const remoteRef = `origin/${branch}`;
      const localHead = await git(["rev-parse", "HEAD"], cwd).catch(() => "");
      const remoteHead = await git(["rev-parse", remoteRef], cwd).catch(() => "");
      if (!localHead) return { status: "no-op" };
      if (remoteHead && remoteHead === localHead) return { status: "no-op" };
      if (remoteHead) {
        // Is remoteHead an ancestor of localHead? If not, the push is non-ff.
        const isAncestor = await git(["merge-base", "--is-ancestor", remoteHead, localHead], cwd)
          .then(() => true)
          .catch(() => false);
        if (!isAncestor) return { status: "non-ff" };
      }
      // Plain (non-force) push. `git push` fails on a non-ff; we already guarded.
      await git(["push", "origin", `HEAD:${branch}`], cwd);
      return { status: "pushed", sha: localHead };
    },
  };
}

// Re-export so the CLI factory can reference the system-prompt builder without a
// second import path.
export { buildResponseSystemPrompt, resolveAgentPrompt };
