/**
 * Thin façade over the three runtime-provider plugin probe functions.
 *
 * Each exported function delegates directly to the corresponding plugin's
 * probe. The indirection exists so that:
 *   1. Route handlers import from one stable internal module rather than
 *      reaching into plugin packages directly.
 *   2. Tests can spy/mock at this module boundary without touching the
 *      plugin packages.
 *   3. If a plugin package is somehow not installed, the error surfaces
 *      as an import-time TypeError with a clear message rather than a
 *      cryptic missing-module crash inside a route handler.
 */

import {
  listHermesProfiles,
  probeHermesBinary,
  type HermesBinaryStatus,
  type HermesProfileSummary,
} from "@fusion-plugin-examples/hermes-runtime";

import {
  probeOpenClawBinary,
  type OpenClawBinaryStatus,
} from "@fusion-plugin-examples/openclaw-runtime";

import {
  agentsMe,
  discoverPaperclipCliConfig,
  listCompanies,
  listCompaniesViaCli,
  listCompanyAgents,
  listCompanyAgentsViaCli,
  mintAgentApiKeyViaCli,
  probePaperclipConnection,
  probePaperclipViaCli,
  type MintCliKeyOptions,
  type MintedApiKey,
  type PaperclipAgentSummary,
  type PaperclipCliDiscoveryResult,
  type PaperclipCompanySummary,
  type PaperclipConnectionStatus,
} from "@fusion-plugin-examples/paperclip-runtime";

export type {
  HermesBinaryStatus,
  HermesProfileSummary,
  MintCliKeyOptions,
  MintedApiKey,
  OpenClawBinaryStatus,
  PaperclipAgentSummary,
  PaperclipCliDiscoveryResult,
  PaperclipCompanySummary,
  PaperclipConnectionStatus,
};
export { mintAgentApiKeyViaCli };

/**
 * Probe the local Hermes binary.
 *
 * Never throws — failures are reported as `available: false` with a reason
 * field so HTTP handlers can render the provider card without try/catch.
 */
export async function probeHermesProvider(opts?: {
  binaryPath?: string;
}): Promise<HermesBinaryStatus> {
  return probeHermesBinary(opts);
}

/**
 * List Hermes profiles via `hermes profile list`.
 *
 * Delegates directly to the plugin's listHermesProfiles.
 * Callers are expected to handle errors; this function does not swallow them.
 */
export async function listHermesProviderProfiles(opts?: {
  binaryPath?: string;
}): Promise<HermesProfileSummary[]> {
  return listHermesProfiles(opts);
}

/**
 * Probe the local OpenClaw binary.
 *
 * Never throws — failures are reported as `available: false` with a reason.
 */
export async function probeOpenClawProvider(opts?: {
  binaryPath?: string;
}): Promise<OpenClawBinaryStatus> {
  return probeOpenClawBinary(opts);
}

/**
 * Probe a Paperclip server by its API URL.
 *
 * Never throws — failures are reported as `available: false` with a reason.
 */
export async function probePaperclipProvider(opts: {
  apiUrl: string;
  apiKey?: string;
}): Promise<PaperclipConnectionStatus> {
  return probePaperclipConnection(opts);
}

/**
 * List companies visible to the bearer. Falls back to the single company
 * derived from `/api/agents/me` when `/api/companies` returns 403 (typical
 * for agent-key-scoped requests in `authenticated` deployment mode).
 *
 * Always returns at least an empty array; never throws — failures degrade
 * to an empty list so the UI can render a "no companies discovered" state.
 */
export async function listPaperclipCompanies(opts: {
  apiUrl: string;
  apiKey?: string;
}): Promise<PaperclipCompanySummary[]> {
  // Prefer the broad listing if it works (board cookie / multi-company access).
  try {
    const cs = await listCompanies(opts.apiUrl, opts.apiKey);
    if (cs.length > 0) return cs;
  } catch {
    // Fall through to /agents/me below.
  }
  // Fall back: agent keys can see their own company via /agents/me.
  try {
    const me = await agentsMe(opts.apiUrl, opts.apiKey);
    return [{ id: me.companyId, name: me.companyName ?? me.companyId }];
  } catch {
    return [];
  }
}

export async function listPaperclipCompanyAgents(opts: {
  apiUrl: string;
  apiKey?: string;
  companyId: string;
}): Promise<PaperclipAgentSummary[]> {
  return listCompanyAgents(opts.apiUrl, opts.apiKey, opts.companyId);
}

export async function discoverPaperclipCli(opts: {
  cliConfigPath?: string;
}): Promise<PaperclipCliDiscoveryResult> {
  return discoverPaperclipCliConfig({ configPath: opts.cliConfigPath });
}

/**
 * Probe Paperclip through the local `paperclipai` CLI. Used by the dashboard's
 * "Local CLI" tab so the test action exercises the same code path as actual
 * CLI-mode runtime calls (carries the user's onboarded CLI context).
 */
export async function probePaperclipViaCliFacade(opts: {
  cliBinaryPath?: string;
  cliConfigPath?: string;
}): Promise<PaperclipConnectionStatus> {
  return probePaperclipViaCli({
    cliBinaryPath: opts.cliBinaryPath,
    cliConfigPath: opts.cliConfigPath,
  });
}

export async function listPaperclipCompaniesViaCliFacade(opts: {
  cliBinaryPath?: string;
  cliConfigPath?: string;
}): Promise<PaperclipCompanySummary[]> {
  try {
    return await listCompaniesViaCli({
      cliBinaryPath: opts.cliBinaryPath,
      cliConfigPath: opts.cliConfigPath,
    });
  } catch {
    return [];
  }
}

export async function listPaperclipCompanyAgentsViaCliFacade(opts: {
  cliBinaryPath?: string;
  cliConfigPath?: string;
  companyId: string;
}): Promise<PaperclipAgentSummary[]> {
  try {
    return await listCompanyAgentsViaCli({
      cliBinaryPath: opts.cliBinaryPath,
      cliConfigPath: opts.cliConfigPath,
      companyId: opts.companyId,
    });
  } catch {
    return [];
  }
}

/**
 * Thin façade over `mintAgentApiKeyViaCli` that never throws.
 * Returns `{ ok: true, key }` on success or `{ ok: false, reason }` on failure,
 * so HTTP handlers and tests can destructure without try/catch.
 */
export async function mintPaperclipKeyViaCli(
  opts: MintCliKeyOptions,
): Promise<{ ok: true; key: MintedApiKey } | { ok: false; reason: string }> {
  try {
    const key = await mintAgentApiKeyViaCli(opts);
    return { ok: true, key };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
