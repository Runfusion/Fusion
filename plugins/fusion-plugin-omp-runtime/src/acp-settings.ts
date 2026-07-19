/*
FNXC:OmpAcp 2026-07-11-23:35:
Route Oh My Pi through native ACP (`omp acp` / `omp --mode acp`) for realtime
session/update streaming, tool visibility, multi-turn reuse, and Fusion
permission-gate integration. Docs: https://omp.sh/docs/acp

Env is allow-listed (never full process.env) but must include HOME/PATH/XDG so
omp can read provider keys and OAuth state under ~/.omp (agent auth method).
*/

/** Env vars forwarded to the `omp acp` subprocess. */
export const OMP_ACP_ENV_ALLOWLIST = [
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
  // Common provider keys operators may set for omp (agent auth reuses ~/.omp too).
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  // FNXC:OmpAcp 2026-07-18-23:50: default omp models often use zai/minimax/kimi keys in env.
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "GLM_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_GROUP_ID",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
] as const;

/**
 * FNXC:OmpAcp 2026-07-11-23:35:
 * omp ACP docs: when the client does not opt into terminal auth, the only method
 * is `agent` — reusing provider keys and OAuth already configured under ~/.omp.
 * Prefer `agent` first; keep `terminal` as a non-preferred fallback if advertised
 * (headless Fusion cannot drive the TUI login flow).
 */
export function resolveOmpAcpAuthPreferMethods(): string[] {
  return ["agent", "terminal"];
}

/**
 * Build argv for native OMP ACP mode.
 *
 * FNXC:OmpAcp 2026-07-11-23:35:
 * Canonical launch from https://omp.sh/docs/acp:
 *   `omp acp`  (equivalent to `omp --mode acp`)
 * Optional model flag is placed before the mode: `omp --model <id> acp`.
 * Subprocess uses JSON-RPC framing on stdio — never pass interactive TUI flags.
 */
export function buildOmpAcpArgs(options?: { model?: string }): string[] {
  const args: string[] = [];
  const cliModel = options?.model?.trim();
  if (cliModel) {
    args.push("--model", cliModel);
  }
  args.push("acp");
  return args;
}

/**
 * Normalize provider-qualified model ids to the bare id the CLI accepts.
 * `omp/default` and empty → omit `--model` (CLI default model).
 */
export function normalizeOmpCliModel(model: string | undefined): string | undefined {
  const normalized = model?.trim();
  if (!normalized) return undefined;
  for (const prefix of ["omp-cli/", "omp/"]) {
    if (normalized.startsWith(prefix)) {
      const stripped = normalized.slice(prefix.length).trim();
      return stripped.length > 0 ? stripped : undefined;
    }
  }
  return normalized;
}

/** Concrete model id for `--model`, or undefined to let omp pick its default. */
export function modelForCli(model: string | undefined): string | undefined {
  const normalized = normalizeOmpCliModel(model);
  return normalized && normalized !== "default" ? normalized : undefined;
}

/** Settings bag accepted by AcpRuntimeAdapter for an OMP ACP session. */
export function buildOmpAcpRuntimeSettings(options: {
  binary: string;
  model?: string;
  /** Advertise client fs/read (default false — omp has native tools). */
  fsRead?: boolean;
  /** Advertise client fs/write (default false). */
  fsWrite?: boolean;
}): Record<string, unknown> {
  const cliModel = modelForCli(options.model);
  return {
    acpBinaryPath: options.binary,
    acpArgs: buildOmpAcpArgs({ model: cliModel }),
    acpModel: options.model ?? "omp/default",
    acpEnvAllowList: [...OMP_ACP_ENV_ALLOWLIST],
    // Conservative: keep protocol-level client fs off; omp tools + optional MCP
    // cover filesystem work. Operators can enable via plugin settings later.
    acpFsRead: options.fsRead === true,
    acpFsWrite: options.fsWrite === true,
    /*
    FNXC:OmpAcp 2026-07-11-23:35:
    OMP is an operator-selected first-party CLI (not an arbitrary untrusted ACP
    binary). Default Fusion policy is unrestricted; acknowledge that so
    sensitive tool kinds under allow-all do not escalate every call to HITL and
    hang autonomous executor turns. Non-allow policy categories still route
    through the ACP permission floor (require-approval / block).
    */
    acpAllowUnrestricted: true,
    /*
    FNXC:OmpAcp 2026-07-11-23:35:
    Docs: client drives initialize → authenticate → model selection.
    Prefer agent auth (reuses ~/.omp). require:false so agents already signed
    in without advertising methods still proceed; failures surface on session/new.
    */
    acpAuthenticate: {
      preferMethods: resolveOmpAcpAuthPreferMethods(),
      meta: { headless: true },
      require: false,
    },
  };
}
