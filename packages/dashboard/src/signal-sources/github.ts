import {
  applySignalCaps,
  verifyHmacSignature,
  type Signal,
  type SignalSource,
  type SignalVerifyContext,
  type SignalVerifyResult,
} from "../signal-source.js";

type ObjectValue = Record<string, unknown>;
type GitHubKind = "check_suite" | "workflow_run" | "status";

/** GitHub terminal outcomes folded across check-suite, workflow-run, and status events. */
export const GITHUB_OUTCOME_MAP = {
  failure: { severity: "error", resolution: "open" },
  timed_out: { severity: "error", resolution: "open" },
  startup_failure: { severity: "error", resolution: "open" },
  stale: { severity: "error", resolution: "open" },
  error: { severity: "error", resolution: "open" },
  action_required: { severity: "warning", resolution: "open" },
  cancelled: { severity: "warning", resolution: "open" },
  success: { severity: "info", resolution: "resolved", recoveryOnly: true },
  neutral: { severity: "info", resolution: "resolved", recoveryOnly: true },
  skipped: { severity: "info", resolution: "resolved", recoveryOnly: true },
} as const;

type Outcome = keyof typeof GITHUB_OUTCOME_MAP;

function asObject(value: unknown): ObjectValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function firstString(...values: unknown[]): string | undefined {
  return values.map(asString).find(Boolean);
}
function timestamp(...values: unknown[]): number | undefined {
  for (const value of values) {
    const string = asString(value);
    if (string) {
      const parsed = Date.parse(string);
      if (Number.isFinite(parsed)) return parsed;
    }
    const number = asNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}
function stripSig(value: string | undefined): string | undefined {
  return value?.startsWith("sha256=") ? value.slice("sha256=".length) : value;
}
function fallbackKind(payload: ObjectValue): GitHubKind | null {
  if (asObject(payload.check_suite)) return "check_suite";
  if (asObject(payload.workflow_run)) return "workflow_run";
  return asString(payload.state) ? "status" : null;
}
function pullNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.map(asObject).map((item) => asNumber(item?.number)).filter((n): n is number => n !== undefined);
  return numbers.length ? numbers : undefined;
}

/*
FNXC:CommandCenterSignals 2026-08-09-13:23:
GitHub queued and in-progress CI is not an alert and must not create an incident that no terminal outcome can reliably resolve. Unknown future terminal values remain fail-visible opens rather than silently becoming green recovery.
*/
export const githubSource: SignalSource = {
  provider: "github",
  secretEnvVar: "FUSION_SIGNAL_GITHUB_SECRET",

  verify(ctx: SignalVerifyContext): SignalVerifyResult {
    if (!ctx.secret) return { valid: false, status: 401, error: "GitHub webhook secret is not configured" };
    const signature = stripSig(ctx.headers["x-hub-signature-256"]);
    if (!signature) return { valid: false, status: 401, error: "Missing X-Hub-Signature-256 header" };
    if (!verifyHmacSignature(ctx.rawBody, signature, ctx.secret)) return { valid: false, status: 401, error: "Invalid GitHub signature" };
    return { valid: true };
  },

  normalize(payload: unknown, ctx: SignalVerifyContext): Signal | null {
    const p = asObject(payload);
    if (!p) throw new Error("Payload must be a JSON object");
    const headerKind = asString(ctx.headers["x-github-event"])?.toLowerCase();
    /*
    FNXC:CommandCenterSignals 2026-08-09-13:36:
    GitHub's event header is authoritative when present. Payload-shape routing exists only for headerless test/proxy deliveries; falling back after an unsupported header could ingest an unrelated GitHub event that happens to contain a status-like field.
    */
    const kind = headerKind === undefined
      ? fallbackKind(p)
      : headerKind === "check_suite" || headerKind === "workflow_run" || headerKind === "status"
        ? headerKind
        : null;
    if (!kind) return null;

    const repository = asObject(p.repository);
    const repositoryName = asString(repository?.full_name);
    if (!repositoryName) throw new Error("Missing GitHub repository.full_name");
    const repositoryUrl = asString(repository?.html_url);
    const event = kind === "check_suite" ? asObject(p.check_suite) : kind === "workflow_run" ? asObject(p.workflow_run) : p;
    if (!event) throw new Error(`Missing GitHub ${kind} payload`);
    const status = asString(event.status ?? event.state)?.toLowerCase();
    const conclusion = kind === "status" ? status : asString(event.conclusion)?.toLowerCase();
    if ((kind !== "status" && (status !== "completed" || !conclusion)) || (kind === "status" && status === "pending")) return null;

    const sha = firstString(event.head_sha, event.sha);
    if (!sha) throw new Error("Missing GitHub head SHA");
    const workflow = asObject(p.workflow);
    const app = asObject(event.app);
    const checkName = kind === "workflow_run" ? asString(workflow?.name) : kind === "check_suite" ? asString(app?.slug) : asString(event.context);
    if (!checkName) throw new Error("Missing GitHub check name");
    const outcome = conclusion ?? "unknown";
    const mapped = GITHUB_OUTCOME_MAP[outcome as Outcome] ?? { severity: "warning" as const, resolution: "open" as const };
    const branch = firstString(event.head_branch, event.branch) ?? "unknown branch";
    const shortSha = sha.slice(0, 12);
    const groupingKey = `github:${repositoryName}:${kind}:${checkName}:${sha}`;
    const at = timestamp(event.updated_at, event.completed_at, event.created_at, p.updated_at, p.created_at);
    const delivery = asString(ctx.headers["x-github-delivery"]);
    const externalId = delivery ? `delivery:${delivery}` : `${groupingKey}:${outcome}:${at ?? "latest"}`;
    const link = firstString(event.html_url, event.target_url, repositoryUrl ? `${repositoryUrl.replace(/\/+$/, "")}/commit/${sha}` : undefined);
    const signal: Signal = {
      source: "github", externalId, groupingKey,
      title: `GitHub ${repositoryName} ${checkName}: ${outcome}`,
      body: `Branch: ${branch}\nCommit: ${shortSha}\nCheck: ${checkName}\nOutcome: ${outcome}`,
      severity: mapped.severity,
      resolution: mapped.resolution,
      ...("recoveryOnly" in mapped && mapped.recoveryOnly ? { recoveryOnly: true } : {}),
      link, timestamp: at,
      /* FNXC:PrMergeEventDrivenChecks 2026-08-09-14:35: terminal payload identity, never ambient repository config, is the only admissible event-driven check source. */
      ciCheck: { repo: repositoryName, headSha: sha, checkName, state: outcome, eventKind: kind, reportedAt: at ? new Date(at).toISOString() : undefined, detailsUrl: link },
      meta: { kind, repository: repositoryName, branch, sha, checkName, status, conclusion, runAttempt: asNumber(event.run_attempt), pullRequests: pullNumbers(event.pull_requests) },
    };
    return applySignalCaps(signal);
  },
};
