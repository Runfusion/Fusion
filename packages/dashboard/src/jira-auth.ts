import { resolveJiraConfig, resolveJiraEnabled, type GlobalSettings, type ProjectSettings } from "@fusion/core";
import type { TaskStore } from "@fusion/core";
export interface ResolvedJiraAuth { apiBaseUrl: string; webBaseUrl: string; headerName: "Authorization"; headerValue: string; scheme: "basic" | "bearer"; }
export type JiraAuthResolution = { ok: true; auth: ResolvedJiraAuth } | { ok: false; reason: "disabled" | "not_configured" | "invalid_config" | "token_missing"; message: string; };
export interface ResolveJiraAuthDeps { store: Pick<TaskStore, "getSecretsStore">; projectSettings?: Partial<ProjectSettings> | null; globalSettings?: Partial<GlobalSettings> | null; }
/** FNXC:JiraBranchNaming 2026-08-20-04:47: JIRA credentials are found by secret key and revealed only for this in-process read request; neither configuration nor failures expose token material. */
export async function resolveJiraAuth(deps: ResolveJiraAuthDeps): Promise<JiraAuthResolution> {
  if (!resolveJiraEnabled({ project: deps.projectSettings, global: deps.globalSettings })) return { ok: false, reason: "disabled", message: "JIRA integration is disabled in Settings." };
  let config: ReturnType<typeof resolveJiraConfig>;
  try { config = resolveJiraConfig({ project: deps.projectSettings, global: deps.globalSettings }); } catch (error) { const message = error instanceof Error ? error.message : "Invalid JIRA configuration."; return { ok: false, reason: message.includes("required") ? "not_configured" : "invalid_config", message }; }
  const secrets = await deps.store.getSecretsStore();
  const scopes = config.tokenSecretScope === "project" ? ["project", "global"] as const : ["global"] as const;
  let token: string | undefined;
  for (const scope of scopes) { const record = (await secrets.listSecrets(scope)).find((candidate) => candidate.key === config.tokenSecretKey); if (record) { token = (await secrets.revealSecret(record.id, scope, { agentId: null, userId: "dashboard" })).plaintextValue; break; } }
  if (!token) return { ok: false, reason: "token_missing", message: `JIRA token secret ${config.tokenSecretKey} was not found.` };
  const scheme = config.authEmail ? "basic" : "bearer" as const;
  return { ok: true, auth: { apiBaseUrl: config.apiBaseUrl, webBaseUrl: config.baseUrl, headerName: "Authorization", headerValue: scheme === "basic" ? `Basic ${Buffer.from(`${config.authEmail}:${token}`).toString("base64")}` : `Bearer ${token}`, scheme } };
}
