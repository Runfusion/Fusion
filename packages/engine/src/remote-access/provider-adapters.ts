import { accessSync, constants as fsConstants } from "node:fs";
import type {
  PreparedTunnelCommand,
  TunnelOutputStream,
  TunnelProvider,
  TunnelProviderAdapter,
  TunnelProviderConfig,
} from "./types.js";

const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

const URL_PATTERN = /(https?:\/\/[^\s]+)/i;

function isAbsoluteOrPathLike(input: string): boolean {
  return input.startsWith("/") || input.startsWith("./") || input.startsWith("../");
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid_config:${label} must be a non-empty string`);
  }
}

function ensureNumberInRange(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid_config:${label} must be a positive number`);
  }

  return Math.floor(value);
}

function collectSensitiveValues(config: TunnelProviderConfig): string[] {
  const values = new Set<string>();
  const env = config.env ?? {};

  const tokenEnvVar = config.tokenEnvVar;
  if (typeof tokenEnvVar === "string" && tokenEnvVar.trim().length > 0) {
    const tokenValue = env[tokenEnvVar] ?? process.env[tokenEnvVar];
    if (!tokenValue) {
      throw new Error(`invalid_config:missing credential in env var ${tokenEnvVar}`);
    }
    values.add(tokenValue);
  }

  for (const envName of config.sensitiveEnvVars ?? []) {
    const envValue = env[envName] ?? process.env[envName];
    if (envValue) {
      values.add(envValue);
    }
  }

  return [...values].sort((a, b) => b.length - a.length);
}

function redactValue(input: string, sensitiveValues: string[]): string {
  let redacted = input;
  for (const value of sensitiveValues) {
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}

function redactArgs(args: string[], sensitiveValues: string[]): string[] {
  return args.map((arg) => redactValue(arg, sensitiveValues));
}

function buildCommand(config: TunnelProviderConfig): PreparedTunnelCommand {
  const command = config.executablePath.trim();
  const args = [...config.args];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.env ?? {}),
  };
  const sensitiveValues = collectSensitiveValues(config);
  const redactedPreview = [command, ...redactArgs(args, sensitiveValues)].join(" ").trim();

  return {
    provider: config.provider,
    command,
    args,
    cwd: config.cwd,
    env,
    redactedPreview,
    sensitiveValues,
    readinessTimeoutMs: config.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    stopTimeoutMs: config.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
  };
}

function parseCommonReadiness(line: string): { ready: boolean; url?: string } | null {
  const normalized = line.trim();
  if (!normalized) {
    return null;
  }

  const urlMatch = normalized.match(URL_PATTERN);
  const url = urlMatch?.[1];

  if (/\b(connected|ready|available|started|serving)\b/i.test(normalized)) {
    return { ready: true, url };
  }

  if (url && /\b(trycloudflare|tailscale|ts\.net|serve|funnel)\b/i.test(normalized)) {
    return { ready: true, url };
  }

  return null;
}

function validateBaseConfig(config: TunnelProviderConfig, provider: TunnelProvider): void {
  if (config.provider !== provider) {
    throw new Error(`invalid_config:config provider ${config.provider} does not match ${provider}`);
  }

  assertNonEmpty(config.executablePath, "executablePath");

  if (!Array.isArray(config.args)) {
    throw new Error("invalid_config:args must be an array");
  }

  for (const [index, arg] of config.args.entries()) {
    assertNonEmpty(arg, `args[${index}]`);
  }

  if (config.cwd !== undefined) {
    assertNonEmpty(config.cwd, "cwd");
  }

  if (config.tokenEnvVar !== undefined) {
    assertNonEmpty(config.tokenEnvVar, "tokenEnvVar");
  }

  ensureNumberInRange(config.readinessTimeoutMs, "readinessTimeoutMs");
  ensureNumberInRange(config.stopTimeoutMs, "stopTimeoutMs");
}

const tailscaleAdapter: TunnelProviderAdapter = {
  provider: "tailscale",
  validateConfig(config) {
    validateBaseConfig(config, "tailscale");
  },
  buildCommand(config) {
    this.validateConfig(config);
    return buildCommand(config);
  },
  parseReadiness(line: string, _stream: TunnelOutputStream) {
    // tailscale funnel prints "Available on the internet:" first (no URL),
    // then a follow-up line with https://<host>.ts.net/. Don't signal ready
    // until we have the URL itself, otherwise the manager freezes status
    // before the URL line arrives.
    const normalized = line.trim();
    if (!normalized) return null;
    const urlMatch = normalized.match(URL_PATTERN);
    const url = urlMatch?.[1];
    if (!url) return null;
    if (/\bts\.net\b/i.test(url) || /\b(tailscale|funnel|serve)\b/i.test(normalized)) {
      return { ready: true, url };
    }
    return null;
  },
};

const cloudflareAdapter: TunnelProviderAdapter = {
  provider: "cloudflare",
  validateConfig(config) {
    validateBaseConfig(config, "cloudflare");

    if (config.provider === "cloudflare" && config.quickTunnel === true) {
      return;
    }

    if ("credentialsPath" in config && config.credentialsPath !== undefined) {
      assertNonEmpty(config.credentialsPath, "credentialsPath");
      if (isAbsoluteOrPathLike(config.credentialsPath)) {
        accessSync(config.credentialsPath, fsConstants.R_OK);
      }
    }
  },
  buildCommand(config) {
    this.validateConfig(config);
    return buildCommand(config);
  },
  parseReadiness(line: string, _stream: TunnelOutputStream) {
    return parseCommonReadiness(line);
  },
};

const ADAPTERS: Record<TunnelProvider, TunnelProviderAdapter> = {
  tailscale: tailscaleAdapter,
  cloudflare: cloudflareAdapter,
};

export function getTunnelProviderAdapter(provider: TunnelProvider): TunnelProviderAdapter {
  return ADAPTERS[provider];
}

export function redactTunnelText(input: string, sensitiveValues: string[]): string {
  return redactValue(input, sensitiveValues);
}
