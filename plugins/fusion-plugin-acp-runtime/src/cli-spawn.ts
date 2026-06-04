// Resolves the ACP agent launch configuration from plugin settings.
//
// Unlike the Claude/Droid CLIs (one fixed binary per plugin), ACP is a protocol:
// the user points this runtime at *any* ACP-compatible agent binary plus the
// flag that puts it in ACP mode (e.g. `gemini --acp`). Settings therefore carry
// an arbitrary binary + args, plus the conservative-by-default fs capability
// toggles (KTD6: writes default OFF) and an env allow-list (KTD6b).

export interface AcpCliSettings {
  /** Agent binary to spawn (e.g. "gemini", "npx", an absolute path). */
  binaryPath: string;
  /** Arguments that launch the agent in ACP/stdio mode (e.g. ["--acp"]). */
  args: string[];
  /** Optional model identifier reported via describeModel. */
  model?: string;
  /** Advertise `fs/read_text_file` capability. Default: false (opt-in). */
  fsRead: boolean;
  /** Advertise `fs/write_text_file` capability. Default: false (opt-in, KTD6). */
  fsWrite: boolean;
  /**
   * Environment variables to forward to the agent subprocess (KTD6b allow-list).
   * The agent is untrusted; inherited `process.env` is NOT forwarded. Empty by
   * default — callers opt specific vars in by name.
   */
  envAllowList: string[];
  /**
   * Risk S1 acknowledgement. The shipped default permission policy is
   * `unrestricted` (every category → allow). Because the ACP agent is an
   * untrusted subprocess, the permission floor refuses to auto-approve a
   * *sensitive* category on a blanket `allow` disposition unless the user has
   * explicitly acknowledged that risk by setting this true — otherwise such
   * calls are escalated to approval (or denied when no approver exists).
   * Default: false (safe).
   */
  allowUnrestricted: boolean;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length === value.length ? out : undefined;
}

function asBool(value: unknown): boolean {
  return value === true;
}

export function resolveCliSettings(settings?: Record<string, unknown>): AcpCliSettings {
  const binaryPath = asTrimmedString(settings?.acpBinaryPath) ?? "acp-agent";
  const args = asStringArray(settings?.acpArgs) ?? [];
  const model = asTrimmedString(settings?.acpModel);
  const fsRead = asBool(settings?.acpFsRead);
  const fsWrite = asBool(settings?.acpFsWrite);
  const envAllowList = asStringArray(settings?.acpEnvAllowList) ?? [];
  const allowUnrestricted = asBool(settings?.acpAllowUnrestricted);
  return { binaryPath, args, model, fsRead, fsWrite, envAllowList, allowUnrestricted };
}
