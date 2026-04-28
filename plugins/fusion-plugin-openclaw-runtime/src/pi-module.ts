/**
 * OpenClaw CLI spawn module.
 *
 * Drives the local `openclaw` binary via `openclaw --no-color agent --local --json`
 * and parses the resulting JSON document on stdout. No daemon required.
 *
 * (Filename kept as `pi-module.ts` for compatibility with imports — the tests,
 * runtime-adapter, and dashboard probe façade all import it under this name.)
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  CliConfig,
  GatewayCallbacks,
  GatewaySession,
  OpenClawAgentJson,
} from "./types.js";

// ---------------------------------------------------------------------------
// Defaults & helpers
// ---------------------------------------------------------------------------

const DEFAULT_BINARY = "openclaw";
const DEFAULT_AGENT_ID = "main";
const DEFAULT_THINKING = "off";
const DEFAULT_TIMEOUT_SEC = 0;        // 0 = no openclaw-side timeout
const DEFAULT_CLI_TIMEOUT_MS = 300_000; // 5 min hard kill on our side

// eslint-disable-next-line no-control-regex -- ANSI escapes are control chars by definition
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = asString(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  const s = asString(v);
  if (s === undefined) return undefined;
  return s === "1" || s.toLowerCase() === "true";
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// ---------------------------------------------------------------------------
// resolveCliConfig — settings + env-var resolution
// ---------------------------------------------------------------------------

export function resolveCliConfig(settings?: Record<string, unknown>): CliConfig {
  return {
    binaryPath:
      asString(settings?.binaryPath) ??
      asString(process.env.OPENCLAW_BIN) ??
      DEFAULT_BINARY,
    agentId:
      asString(settings?.agentId) ??
      asString(process.env.OPENCLAW_AGENT_ID) ??
      DEFAULT_AGENT_ID,
    model:
      asString(settings?.model) ??
      asString(process.env.OPENCLAW_MODEL),
    thinking:
      asString(settings?.thinking) ??
      asString(process.env.OPENCLAW_THINKING) ??
      DEFAULT_THINKING,
    cliTimeoutSec:
      asNumber(settings?.cliTimeoutSec) ??
      asNumber(process.env.OPENCLAW_TIMEOUT_SEC) ??
      DEFAULT_TIMEOUT_SEC,
    cliTimeoutMs:
      asNumber(settings?.cliTimeoutMs) ??
      asNumber(process.env.OPENCLAW_CLI_TIMEOUT_MS) ??
      DEFAULT_CLI_TIMEOUT_MS,
    useGateway:
      asBool(settings?.useGateway) ??
      asBool(process.env.OPENCLAW_USE_GATEWAY) ??
      false,
  };
}

// ---------------------------------------------------------------------------
// buildOpenClawArgs — argv builder
// ---------------------------------------------------------------------------

/**
 * Build the argv for a single openclaw agent invocation.
 *
 * `--no-color` is a TOP-LEVEL flag and must come BEFORE `agent`.
 * `--local` is appended unless `useGateway` is true.
 */
export function buildOpenClawArgs(
  config: CliConfig,
  sessionId: string,
  message: string,
): string[] {
  const args: string[] = ["--no-color", "agent"];

  if (!config.useGateway) args.push("--local");

  args.push("--json");
  args.push("--session-id", sessionId);
  args.push("--message", message);
  args.push("--agent", config.agentId);

  if (config.model) {
    args.push("--model", config.model);
  }

  args.push("--thinking", config.thinking);
  args.push("--timeout", String(config.cliTimeoutSec));

  return args;
}

// ---------------------------------------------------------------------------
// extractStderrError — last meaningful line, ANSI-stripped
// ---------------------------------------------------------------------------

export function extractStderrError(stderr: string, stdout?: string): string {
  const tryExtract = (raw: string): string | undefined => {
    if (!raw) return undefined;
    const lines = stripAnsi(raw)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines.length > 0 ? lines[lines.length - 1] : undefined;
  };

  return (
    tryExtract(stderr) ??
    tryExtract(stdout ?? "") ??
    "openclaw exited with non-zero status (no stderr)"
  );
}

// ---------------------------------------------------------------------------
// createCliSession — mints a UUID + transcript bookkeeping
// ---------------------------------------------------------------------------

export function createCliSession(opts: {
  systemPrompt: string;
  agentId?: string;
  callbacks?: GatewayCallbacks;
}): GatewaySession {
  return {
    sessionId: randomUUID(),
    agentId: opts.agentId ?? DEFAULT_AGENT_ID,
    systemPrompt: opts.systemPrompt,
    messages: [{ role: "developer", content: opts.systemPrompt }],
    lastModelDescription: `openclaw/${opts.agentId ?? DEFAULT_AGENT_ID}`,
    lastUsage: undefined,
    callbacks: opts.callbacks,
  };
}

// ---------------------------------------------------------------------------
// promptCli — spawns openclaw, parses the JSON, fires callbacks
// ---------------------------------------------------------------------------

export async function promptCli(
  session: GatewaySession,
  message: string,
  config: CliConfig,
  callbacks?: GatewayCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const args = buildOpenClawArgs(config, session.sessionId, message);
  const cb: GatewayCallbacks = { ...session.callbacks, ...callbacks };

  cb.onToolStart?.("openclaw.agent", { sessionId: session.sessionId });

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const child = spawn(config.binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const hardKill = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      reject(
        new Error(
          `openclaw: process timed out after ${config.cliTimeoutMs}ms`,
        ),
      );
    }, config.cliTimeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardKill);
      signal?.removeEventListener("abort", onAbort);
      const isNotFound = err.code === "ENOENT";
      reject(
        new Error(
          isNotFound
            ? `openclaw: binary not found at "${config.binaryPath}". Install OpenClaw (npm i -g openclaw) or set binaryPath/OPENCLAW_BIN.`
            : `openclaw: spawn error — ${err.message}`,
        ),
      );
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardKill);
      signal?.removeEventListener("abort", onAbort);

      if (code !== 0) {
        const err =
          stderr.trim() || stdout.trim()
            ? extractStderrError(stderr, stdout)
            : `openclaw: exited with code ${String(code)}`;
        reject(new Error(err));
        return;
      }

      // Exit 0 — parse JSON
      let parsed: OpenClawAgentJson;
      try {
        parsed = JSON.parse(stdout) as OpenClawAgentJson;
      } catch {
        reject(new Error(`openclaw: failed to parse JSON output (stdout=${stdout.slice(0, 200)})`));
        return;
      }

      const payloads = parsed.payloads ?? [];
      const visibleText = payloads
        .filter((p) => !p.isError && !p.isReasoning)
        .map((p) => p.text ?? "")
        .filter((t) => t.length > 0)
        .join("");
      const reasoningText = payloads
        .filter((p) => p.isReasoning)
        .map((p) => p.text ?? "")
        .filter((t) => t.length > 0)
        .join("\n");
      const errorText = payloads
        .filter((p) => p.isError)
        .map((p) => p.text ?? "")
        .filter((t) => t.length > 0);

      const finalText = visibleText || parsed.meta?.finalAssistantVisibleText || "";

      if (finalText) cb.onText?.(finalText);
      if (reasoningText) cb.onThinking?.(reasoningText);

      // Update transcript + session metadata
      session.messages.push({ role: "user", content: message });
      if (finalText) {
        session.messages.push({ role: "assistant", content: finalText });
      }
      const agentMeta = parsed.meta?.agentMeta;
      if (agentMeta?.usage) session.lastUsage = agentMeta.usage;
      if (agentMeta?.provider && agentMeta.model) {
        session.lastModelDescription = `openclaw/${session.agentId}/${agentMeta.provider}/${agentMeta.model}`;
      }

      const metaError = parsed.meta?.error;
      const isError = !!metaError;

      cb.onToolEnd?.(
        "openclaw.agent",
        isError,
        {
          usage: agentMeta?.usage,
          provider: agentMeta?.provider,
          model: agentMeta?.model,
          ...(metaError ? { error: metaError } : {}),
          ...(errorText.length > 0 ? { toolErrors: errorText } : {}),
        },
      );

      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// describeCliModel — for runtime-adapter's describeModel()
// ---------------------------------------------------------------------------

export function describeCliModel(session: GatewaySession): string {
  return session.lastModelDescription || `openclaw/${session.agentId}`;
}
