import { randomUUID } from "node:crypto";
import {
  agentsMe,
  agentsMeViaCli,
  createIssue,
  createIssueViaCli,
  discoverPaperclipCliConfig,
  getIssue,
  getIssueComments,
  getIssueViaCli,
  getRunEvents,
  resolvePaperclipConfig,
  wakeAgent,
  type RunEvent,
} from "./paperclip-client.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSessionResult,
  PaperclipMode,
  PaperclipRuntimeConfig,
  PaperclipSession,
  RuntimeLogger,
} from "./types.js";

/** Run-level statuses that signal we should stop polling events. */
const TERMINAL_RUN_STATUSES = new Set<string>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

const VALID_MODES: ReadonlySet<PaperclipMode> = new Set([
  "issue-per-prompt",
  "rolling-issue",
  "wakeup-only",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function deriveIssueTitle(prompt: string): string {
  const firstLine =
    prompt.split("\n").find((line) => line.trim() !== "") ?? "Fusion runtime prompt";
  return firstLine.slice(0, 200);
}

function buildIssueDescription(session: PaperclipSession, prompt: string): string {
  return [
    `System Prompt:\n${session.systemPrompt}`,
    `Working Directory: ${session.cwd}`,
    `Prompt:\n${prompt}`,
  ].join("\n\n");
}

function pickIssueId(issue: Record<string, unknown>): string {
  const issueId = asString(issue.id);
  if (!issueId) {
    throw new Error("Paperclip createIssue response missing issue id");
  }
  return issueId;
}

function normalizeMode(mode: string | undefined): PaperclipMode {
  if (mode && VALID_MODES.has(mode as PaperclipMode)) return mode as PaperclipMode;
  return "rolling-issue";
}

/**
 * Adapter that drives Paperclip via its modern wakeup + heartbeat-run streaming API.
 *
 * Flow per prompt:
 *   1. Optional issue creation/reuse (depending on `mode`).
 *   2. POST /api/agents/{agentId}/wakeup with idempotencyKey + payload.
 *   3. Stream GET /api/heartbeat-runs/{runId}/events; forward log chunks.
 *   4. Once terminal, fetch the issue + comments for a final answer.
 */
export class PaperclipRuntimeAdapter implements AgentRuntime {
  readonly id = "paperclip";
  readonly name = "Paperclip Runtime";

  private readonly config: PaperclipRuntimeConfig;
  private readonly logger: RuntimeLogger;

  constructor(config?: Partial<PaperclipRuntimeConfig>, logger?: RuntimeLogger) {
    const resolved = resolvePaperclipConfig(
      config as Record<string, unknown> | undefined,
    );
    // resolvePaperclipConfig returns mode as string; narrow at the boundary.
    this.config = {
      ...resolved,
      mode: normalizeMode(resolved.mode),
      ...config,
    };
    this.logger = logger ?? console;
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    let effectiveApiUrl = this.config.apiUrl;
    let effectiveApiKey = this.config.apiKey;

    // CLI transport: read apiUrl (and possibly apiKey) from local paperclipai config.
    if (this.config.transport === "cli") {
      const discovery = await discoverPaperclipCliConfig({
        configPath: this.config.cliConfigPath,
      });
      if (!discovery.ok) {
        throw new Error(
          `Paperclip CLI mode failed: ${discovery.reason} (Switch to API mode in settings if paperclipai isn't installed.)`,
        );
      }
      effectiveApiUrl = discovery.apiUrl;
      // Only override apiKey if the user didn't explicitly set one.
      if (!effectiveApiKey) {
        effectiveApiKey = discovery.apiKey;
      }
      this.logger.info(
        `Paperclip CLI mode resolved apiUrl=${effectiveApiUrl} (deploymentMode=${discovery.deploymentMode ?? "unknown"})`,
      );
    }

    let agentId = this.config.agentId;
    let companyId = this.config.companyId;

    // Auto-derive agentId/companyId when missing. In CLI mode we go through
    // `paperclipai agent get <id>` (requires a known agentId); in API mode we
    // call /agents/me which derives identity from the bearer key.
    if (!agentId || !companyId) {
      try {
        if (this.config.transport === "cli") {
          if (!agentId) {
            throw new Error(
              "agentId is required in Local CLI mode (paperclipai has no `agents/me` equivalent — pick an agent in settings)",
            );
          }
          const me = await agentsMeViaCli({
            agentId,
            cliBinaryPath: this.config.cliBinaryPath,
            cliConfigPath: this.config.cliConfigPath,
          });
          companyId = companyId ?? me.companyId;
        } else {
          const me = await agentsMe(effectiveApiUrl, effectiveApiKey);
          agentId = agentId ?? me.agentId;
          companyId = companyId ?? me.companyId;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Paperclip runtime could not derive agentId/companyId. Configure them explicitly or check the API key / CLI auth. Underlying error: ${reason}`,
        );
      }
    }

    if (!agentId || !companyId) {
      throw new Error(
        "Paperclip runtime is missing required config: agentId or companyId. Configure plugin settings (apiUrl, apiKey, agentId, companyId) or PAPERCLIP_* env vars.",
      );
    }

    const session: PaperclipSession = {
      apiUrl: effectiveApiUrl,
      apiKey: effectiveApiKey,
      agentId,
      companyId,
      sessionId: randomUUID(),
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      mode: normalizeMode(this.config.mode),
      parentIssueId: this.config.parentIssueId,
      projectId: this.config.projectId,
      goalId: this.config.goalId,
      issueId: undefined,
      transport: this.config.transport ?? "api",
      cliBinaryPath: this.config.cliBinaryPath,
      cliConfigPath: this.config.cliConfigPath,
      turnIndex: 0,
      runTimeoutMs: this.config.runTimeoutMs ?? 600_000,
      pollIntervalMs: this.config.pollIntervalMs ?? 500,
      pollIntervalMaxMs: this.config.pollIntervalMaxMs ?? 2_000,
      onText: options.onText,
      onThinking: options.onThinking,
      onToolStart: options.onToolStart,
      onToolEnd: options.onToolEnd,
      dispose: () => undefined,
    };

    return { session, sessionFile: undefined };
  }

  async promptWithFallback(
    session: PaperclipSession,
    prompt: string,
    _options?: unknown,
  ): Promise<void> {
    session.turnIndex += 1;
    const turn = session.turnIndex;
    session.onToolStart?.("paperclip.run", {
      sessionId: session.sessionId,
      mode: session.mode,
      turn,
    });

    // ---- Stage 1: issue create/reuse ------------------------------------
    let issueId: string | undefined;
    if (session.mode === "issue-per-prompt") {
      issueId = await this.createIssueForPrompt(session, prompt);
    } else if (session.mode === "rolling-issue") {
      if (!session.issueId) {
        session.issueId = await this.createIssueForPrompt(session, prompt);
      }
      issueId = session.issueId;
    }
    // wakeup-only: no issue side-effect.

    // ---- Stage 2: wakeup -------------------------------------------------
    const idempotencyKey = `${session.sessionId}:${turn}`;
    let runId: string;
    try {
      const wakeResponse = await wakeAgent(session.apiUrl, session.apiKey, session.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "Fusion runtime prompt",
        idempotencyKey,
        payload: {
          fusionSessionId: session.sessionId,
          prompt,
          issueId,
        },
      });

      if (wakeResponse.status === "skipped") {
        session.onToolEnd?.("paperclip.run", true, {
          issueId,
          runStatus: "skipped",
          reason: "Paperclip coalesced this wakeup with a recent one (status=skipped).",
        });
        return;
      }

      runId = wakeResponse.id;
      if (!runId) {
        session.onToolEnd?.("paperclip.run", true, {
          issueId,
          reason: "Paperclip wakeup response missing run id",
        });
        return;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Paperclip wakeup failed: ${reason}`);
      session.onToolEnd?.("paperclip.run", true, { issueId, reason });
      return;
    }

    // ---- Stage 3: stream run events --------------------------------------
    const stream = await this.streamRunEvents(session, runId);

    // ---- Stage 4: collect final results ----------------------------------
    let issueStatus: string | undefined;
    let finalText = stream.text;
    if (issueId) {
      try {
        const issue =
          session.transport === "cli"
            ? await getIssueViaCli({
                issueId,
                cliBinaryPath: session.cliBinaryPath,
                cliConfigPath: session.cliConfigPath,
              })
            : await getIssue(session.apiUrl, session.apiKey, issueId);
        issueStatus = asString(issue.status) ?? undefined;

        // Comment fallback: if no streaming text was captured, use the latest
        // non-system comment as the visible answer. Note: paperclipai has no
        // `issue comments list` command, so this stays on HTTP — in CLI mode
        // it relies on the apiKey discovered from the local paperclipai config.
        if (!finalText) {
          const comments = await getIssueComments(session.apiUrl, session.apiKey, issueId);
          const latest = pickLatestVisibleComment(comments);
          if (latest) finalText = latest;
        }
      } catch (error) {
        // Non-fatal — we still have whatever we streamed.
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Paperclip post-run fetch failed: ${reason}`);
      }
    }

    if (finalText) session.onText?.(finalText);
    if (stream.thinking) session.onThinking?.(stream.thinking);

    const isError = stream.runStatus === "failed" || stream.runStatus === "timed_out";
    session.onToolEnd?.("paperclip.run", isError || stream.timedOutLocally, {
      runId,
      runStatus: stream.runStatus,
      issueId,
      issueStatus,
      timedOutLocally: stream.timedOutLocally,
      deepLink: issueId
        ? `${session.apiUrl.replace(/\/$/, "")}/issues/${issueId}`
        : undefined,
    });
  }

  describeModel(session: PaperclipSession): string {
    return `paperclip/${session.agentId}`;
  }

  async dispose(_session: PaperclipSession): Promise<void> {
    // no-op: Paperclip manages run/session lifecycle server-side
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async createIssueForPrompt(
    session: PaperclipSession,
    prompt: string,
  ): Promise<string> {
    const body = {
      title: deriveIssueTitle(prompt),
      description: buildIssueDescription(session, prompt),
      status: "todo",
      assigneeAgentId: session.agentId,
      ...(session.parentIssueId ? { parentId: session.parentIssueId } : {}),
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(session.goalId ? { goalId: session.goalId } : {}),
    };
    const created =
      session.transport === "cli"
        ? await createIssueViaCli({
            companyId: session.companyId,
            body,
            cliBinaryPath: session.cliBinaryPath,
            cliConfigPath: session.cliConfigPath,
          })
        : await createIssue(session.apiUrl, session.apiKey, session.companyId, body);
    return pickIssueId(created);
  }

  private async streamRunEvents(
    session: PaperclipSession,
    runId: string,
  ): Promise<{
    text: string;
    thinking: string;
    runStatus: string;
    timedOutLocally: boolean;
  }> {
    const startedAt = Date.now();
    let afterSeq = 0;
    let interval = session.pollIntervalMs;
    let runStatus = "running";
    let timedOutLocally = false;
    let textBuf = "";
    let thinkBuf = "";

    while (true) {
      let events: RunEvent[] = [];
      try {
        events = await getRunEvents(
          session.apiUrl,
          session.apiKey,
          runId,
          afterSeq,
          200,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Paperclip getRunEvents failed: ${reason}`);
      }

      for (const ev of events) {
        if (typeof ev.seq === "number" && ev.seq > afterSeq) afterSeq = ev.seq;
        const type = ev.type ?? "";
        const payload = ev.payload ?? {};
        if (type === "heartbeat.run.status") {
          const next = asString(payload.status);
          if (next) runStatus = next;
        } else if (type === "heartbeat.run.log") {
          const chunk = asString(payload.chunk) ?? "";
          if (!chunk) continue;
          if (payload.stream === "stdout") {
            textBuf += chunk;
            session.onText?.(chunk);
          } else if (payload.stream === "stderr") {
            this.logger.warn(`[paperclip:run:${runId}] ${chunk.trimEnd()}`);
          } else if (payload.stream === "system") {
            // system messages may carry reasoning/thinking-style content
            const message = asString(payload.message) ?? chunk;
            thinkBuf += (thinkBuf ? "\n" : "") + message;
          }
        }
        // Other event types (adapter.invoke, tool calls) are ignored for v1.
      }

      if (TERMINAL_RUN_STATUSES.has(runStatus)) break;

      if (Date.now() - startedAt > session.runTimeoutMs) {
        timedOutLocally = true;
        this.logger.warn(
          `Paperclip run ${runId} exceeded local runTimeoutMs=${session.runTimeoutMs}; abandoning poll. Run continues server-side.`,
        );
        break;
      }

      await sleep(interval);
      interval = Math.min(interval * 2, session.pollIntervalMaxMs);
    }

    return { text: textBuf, thinking: thinkBuf, runStatus, timedOutLocally };
  }
}

function pickLatestVisibleComment(
  comments: Array<Record<string, unknown>>,
): string | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    const body = asString(c.body)?.trim();
    if (body) return body;
  }
  return undefined;
}
