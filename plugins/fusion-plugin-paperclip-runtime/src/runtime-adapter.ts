import { randomUUID } from "node:crypto";
import {
  ConflictError,
  createIssue,
  checkoutIssue,
  getIssue,
  getIssueComments,
  invokeHeartbeat,
  resolvePaperclipConfig,
} from "./pi-module.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSessionResult,
  PaperclipRuntimeConfig,
  PaperclipSession,
  RuntimeLogger,
} from "./types.js";

const POLL_INITIAL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 120_000;
const TERMINAL_STATUSES = new Set(["done", "cancelled", "in_review"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function deriveIssueTitle(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim() !== "") ?? "Fusion runtime prompt";
  return firstLine.slice(0, 200);
}

function buildIssueDescription(session: PaperclipSession, prompt: string): string {
  return [
    `System Prompt:\n${session.systemPrompt}`,
    `Working Directory: ${session.cwd}`,
    `Prompt:\n${prompt}`,
  ].join("\n\n");
}

function collectCommentText(comments: Array<Record<string, unknown>>): { text: string; thinking: string } {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];

  for (const comment of comments) {
    const body = asString(comment.body)?.trim();
    if (!body) {
      continue;
    }

    textParts.push(body);

    const kind = asString(comment.kind) ?? asString(comment.type);
    if (kind === "thinking" || kind === "reasoning") {
      thinkingParts.push(body);
      continue;
    }

    if (body.toLowerCase().startsWith("thinking:")) {
      thinkingParts.push(body.replace(/^thinking:\s*/i, ""));
    }
  }

  return {
    text: textParts.join("\n\n"),
    thinking: thinkingParts.join("\n\n"),
  };
}

function pickIssueId(issue: Record<string, unknown>): string {
  const issueId = asString(issue.id);
  if (!issueId) {
    throw new Error("Paperclip createIssue response missing issue id");
  }
  return issueId;
}

function pickIssueStatus(issue: Record<string, unknown>): string {
  return asString(issue.status) ?? "unknown";
}

export class PaperclipRuntimeAdapter implements AgentRuntime {
  readonly id = "paperclip";
  readonly name = "Paperclip Runtime";

  private readonly config: PaperclipRuntimeConfig;
  private readonly logger: RuntimeLogger;

  constructor(config?: Partial<PaperclipRuntimeConfig>, logger?: RuntimeLogger) {
    this.config = {
      ...resolvePaperclipConfig(config as Record<string, unknown> | undefined),
      ...config,
    };
    this.logger = logger ?? console;
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    if (!this.config.agentId || !this.config.companyId) {
      const missing = [!this.config.agentId ? "agentId" : null, !this.config.companyId ? "companyId" : null]
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `Paperclip runtime is missing required config: ${missing}. Configure plugin settings (apiUrl, apiKey, agentId, companyId) or PAPERCLIP_* environment variables.`,
      );
    }

    const session: PaperclipSession = {
      apiUrl: this.config.apiUrl,
      apiKey: this.config.apiKey,
      agentId: this.config.agentId,
      companyId: this.config.companyId,
      sessionId: randomUUID(),
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      onText: options.onText,
      onThinking: options.onThinking,
      onToolStart: options.onToolStart,
      onToolEnd: options.onToolEnd,
      dispose: () => undefined,
    };

    return {
      session,
      sessionFile: undefined,
    };
  }

  async promptWithFallback(
    session: PaperclipSession,
    prompt: string,
    _options?: unknown,
  ): Promise<void> {
    session.onToolStart?.("paperclip.issue", { sessionId: session.sessionId });

    const createdIssue = await createIssue(session.apiUrl, session.apiKey, session.companyId, {
      title: deriveIssueTitle(prompt),
      description: buildIssueDescription(session, prompt),
      status: "backlog",
      assigneeAgentId: session.agentId,
    });

    const issueId = pickIssueId(createdIssue);

    try {
      await checkoutIssue(session.apiUrl, session.apiKey, issueId, session.agentId, session.sessionId);
    } catch (error) {
      if (error instanceof ConflictError) {
        this.logger.warn(`Paperclip checkout conflict for issue ${issueId}; continuing: ${error.message}`);
      } else {
        throw error;
      }
    }

    await invokeHeartbeat(session.apiUrl, session.apiKey, session.agentId);

    let issue = createdIssue;
    let status = pickIssueStatus(issue);
    let intervalMs = POLL_INITIAL_INTERVAL_MS;
    const startedAt = Date.now();

    while (!TERMINAL_STATUSES.has(status) && Date.now() - startedAt < POLL_TIMEOUT_MS) {
      await sleep(intervalMs);
      issue = await getIssue(session.apiUrl, session.apiKey, issueId);
      status = pickIssueStatus(issue);
      intervalMs = Math.min(intervalMs * 2, POLL_MAX_INTERVAL_MS);
    }

    const comments = await getIssueComments(session.apiUrl, session.apiKey, issueId);
    const { text, thinking } = collectCommentText(comments);
    if (text) {
      session.onText?.(text);
    }
    if (thinking) {
      session.onThinking?.(thinking);
    }

    session.onToolEnd?.("paperclip.issue", false, {
      issueId,
      status,
    });
  }

  describeModel(session: PaperclipSession): string {
    return `paperclip/${session.agentId}`;
  }

  async dispose(_session: PaperclipSession): Promise<void> {
    // no-op: Paperclip manages run/session lifecycle server-side
  }
}
