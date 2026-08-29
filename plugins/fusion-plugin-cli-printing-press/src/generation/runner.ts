import { exec } from "node:child_process";
import { promisify } from "node:util";
import { redact } from "./redact.js";
import type { GeneratedCliArtifact, RunResult } from "./types.js";

const execAsync = promisify(exec);

export interface RunGeneratedCliInput {
  artifact: GeneratedCliArtifact;
  endpointId: string;
  params: Record<string, string | number | boolean>;
  credentials?: Record<string, string>;
  timeoutMs?: number;
  cwd?: string;
}

function toFlagName(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function createArgs(endpointId: string, params: Record<string, string | number | boolean>): string[] {
  const args: string[] = ["--endpoint", endpointId];
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "boolean") {
      if (value) args.push(`--${toFlagName(key)}`);
      continue;
    }
    args.push(`--${toFlagName(key)}`, String(value));
  }
  return args;
}

function quoteArg(arg: string): string {
  return JSON.stringify(arg);
}

// Credentials are passed only via env vars: CLIPP_CRED_<UPPER_SNAKE_KEY>.
export async function runGeneratedCli({ artifact, endpointId, params, credentials, timeoutMs = 30_000, cwd }: RunGeneratedCliInput): Promise<RunResult> {
  const args = createArgs(endpointId, params);
  const argv = [artifact.binPath, ...args];
  const command = ["node", ...argv].map(quoteArg).join(" ");

  const credEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials ?? {})) {
    credEnv[`CLIPP_CRED_${key.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`] = value;
  }

  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...credEnv },
    });

    const secrets = Object.values(credentials ?? {});
    return {
      stdout: redact(stdout, secrets),
      stderr: redact(stderr, secrets),
      exitCode: 0,
      durationMs: Date.now() - start,
      timedOut: false,
      argv: argv.map((part) => redact(part, secrets)),
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number | null; killed?: boolean; signal?: string };
    const timedOut = Boolean(err.killed && err.signal === "SIGTERM");
    const secrets = Object.values(credentials ?? {});
    return {
      stdout: redact(err.stdout ?? "", secrets),
      stderr: redact(err.stderr ?? (timedOut ? "Command timed out" : ""), secrets),
      exitCode: timedOut ? null : (typeof err.code === "number" ? err.code : null),
      durationMs: Date.now() - start,
      timedOut,
      argv: argv.map((part) => redact(part, secrets)),
    };
  }
}
