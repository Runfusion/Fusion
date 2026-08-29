/*
FNXC:GrokAcp 2026-07-11-12:00:
Route Grok CLI through native ACP (`grok agent stdio`) instead of one-shot
`grok -p --output-format json`. ACP gives realtime `session/update` streaming
(agent_message_chunk / agent_thought_chunk / tool_call), multi-turn session
reuse, and Fusion permission-gate integration. Env is still allow-listed
(never full process.env) but must include the vars Grok needs to find
~/.grok/auth.json and optional XAI/GROK API keys — thin {HOME,PATH} starves
auth (see acp-bridge-not-logged-in-thin-env-keychain-isolation learning).
*/

/** Env vars forwarded to the `grok agent stdio` subprocess. */
export const GROK_ACP_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TERMINFO",
  "TMPDIR",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  // Official headless/ACP auth: https://docs.x.ai/build/cli/headless-scripting#acp
  // Prefer XAI_API_KEY (xai.api_key auth method); GROK_API_KEY kept as legacy alias.
  "XAI_API_KEY",
  "GROK_API_KEY",
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
  "GROK_CLI_CHAT_PROXY_BASE_URL",
  "XAI_API_BASE_URL",
] as const;

/**
 * Auth methods preferred for Grok ACP, matching the official scripting example:
 * use `xai.api_key` when XAI_API_KEY is present, otherwise `cached_token`.
 * Interactive `grok.com` is intentionally not preferred for headless Fusion.
 */
export function resolveGrokAcpAuthPreferMethods(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // Prefer API-key method first whenever the env might supply a key (the
  // authenticate step only selects it if the agent also advertised it).
  if (typeof env.XAI_API_KEY === "string" && env.XAI_API_KEY.trim().length > 0) {
    return ["xai.api_key", "cached_token"];
  }
  // Some installs still use GROK_API_KEY; Grok may map it or fall through to cached_token.
  if (typeof env.GROK_API_KEY === "string" && env.GROK_API_KEY.trim().length > 0) {
    return ["xai.api_key", "cached_token"];
  }
  return ["cached_token", "xai.api_key"];
}

/**
 * Build argv for native Grok ACP mode.
 *
 * FNXC:GrokAcp 2026-07-11-14:00:
 * `--plugin-dir` injects session-scoped Fusion skills as a trusted process-local
 * plugin so Grok discovers SKILL.md trees without mutating ~/.grok.
 *
 * FNXC:GrokAcp 2026-07-11-15:00:
 * Official headless/ACP scripting docs recommend `--no-auto-update` for CI and
 * automated clients (https://docs.x.ai/build/cli/headless-scripting). Place it
 * before the `agent` subcommand: `grok --no-auto-update agent … stdio`.
 *
 * FNXC:GrokAcp 2026-08-09-00:00:
 * The released Grok CLI (v1.0.0, latest stable) does not recognize
 * `--no-auto-update` and exits immediately with "unexpected argument".
 * Default is now OFF; callers must opt in via noAutoUpdate:true. Fusion
 * manages its own update cycle, so disabling auto-update in the subprocess
 * is unnecessary and breaks startup for all users on current Grok CLI.
 */
export function buildGrokAcpArgs(options?: {
  model?: string;
  pluginDirs?: string[];
  noAutoUpdate?: boolean;
}): string[] {
  const args: string[] = [];
  // Default OFF — Grok CLI v1.0.0 rejects --no-auto-update (unknown flag).
  if (options?.noAutoUpdate === true) {
    args.push("--no-auto-update");
  }
  args.push("agent");
  for (const dir of options?.pluginDirs ?? []) {
    const trimmed = dir?.trim();
    if (trimmed) {
      args.push("--plugin-dir", trimmed);
    }
  }
  const cliModel = options?.model?.trim();
  if (cliModel) {
    args.push("-m", cliModel);
  }
  args.push("stdio");
  return args;
}

/**
 * Normalize provider-qualified model ids to the bare id the CLI accepts.
 * `grok/default` and empty → omit `-m` (CLI default model).
 */
export function normalizeGrokCliModel(model: string | undefined): string | undefined {
  const normalized = model?.trim();
  if (!normalized) return undefined;
  for (const prefix of ["grok-cli/", "grok/"]) {
    if (normalized.startsWith(prefix)) {
      const stripped = normalized.slice(prefix.length).trim();
      return stripped.length > 0 ? stripped : undefined;
    }
  }
  return normalized;
}

/** Concrete model id for `-m`, or undefined to let Grok pick its default. */
export function modelForCli(model: string | undefined): string | undefined {
  const normalized = normalizeGrokCliModel(model);
  return normalized && normalized !== "default" ? normalized : undefined;
}

/** Settings bag accepted by AcpRuntimeAdapter for a Grok ACP session. */
export function buildGrokAcpRuntimeSettings(options: {
  binary: string;
  model?: string;
  pluginDirs?: string[];
}): Record<string, unknown> {
  const cliModel = modelForCli(options.model);
  return {
    acpBinaryPath: options.binary,
    acpArgs: buildGrokAcpArgs({ model: cliModel, pluginDirs: options.pluginDirs }),
    acpModel: options.model ?? "grok/default",
    acpEnvAllowList: [...GROK_ACP_ENV_ALLOWLIST],
    // Grok has native tools; client-side fs capabilities stay off (conservative).
    // Official ACP example enables client fs; Fusion keeps protocol fs off and
    // relies on Grok-native tools + forwarded MCP.
    acpFsRead: false,
    acpFsWrite: false,
    /*
    FNXC:GrokAcp 2026-07-11-12:00:
    Grok is an operator-selected first-party CLI (not an arbitrary untrusted
    ACP binary). Default Fusion policy is unrestricted; acknowledge that so
    sensitive tool kinds under allow-all do not escalate every call to HITL
    and hang autonomous executor turns. Non-allow policy categories still
    route through the ACP permission floor (require-approval / block).
    */
    acpAllowUnrestricted: true,
    /*
    FNXC:GrokAcp 2026-07-11-15:00:
    Match https://docs.x.ai/build/cli/headless-scripting#acp — after initialize,
    authenticate with xai.api_key (when XAI_API_KEY is set) or cached_token,
    headless meta, before session/new. require:false so a method mismatch
    surfaces as a later session error with stderr rather than failing agents
    that already inherited login-session auth without advertising methods.
    */
    acpAuthenticate: {
      preferMethods: resolveGrokAcpAuthPreferMethods(),
      meta: { headless: true },
      require: false,
    },
  };
}
