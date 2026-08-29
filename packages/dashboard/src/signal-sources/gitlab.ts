import {
  applySignalCaps,
  verifySharedSecretToken,
  type Signal,
  type SignalSeverity,
  type SignalSource,
  type SignalVerifyContext,
  type SignalVerifyResult,
} from "../signal-source.js";

/*
FNXC:CommandCenterSignals 2026-07-02-00:00:
GitLab Command Center signals must support GitLab.com and self-managed instances through inbound HTTP webhooks only. Verify GitLab's `X-Gitlab-Token` secret-token header, normalize issue/MR payloads from project or group hooks, and never add a local GitLab CLI/download dependency or hard-code gitlab.com.
*/

type GitLabObject = Record<string, unknown>;

type GitLabSignalKind = "issue" | "merge_request";

function asObject(value: unknown): GitLabObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as GitLabObject) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const str = asString(value);
    if (str) return str;
  }
  return undefined;
}

function parseTimestamp(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function resolveKind(payload: GitLabObject, headers: Record<string, string | undefined>): GitLabSignalKind | null {
  const kind = asString(payload.object_kind) ?? asString(payload.event_type);
  if (kind === "issue" || kind === "work_item") return "issue";
  if (kind === "merge_request") return "merge_request";

  const event = headers["x-gitlab-event"]?.toLowerCase();
  if (event?.includes("issue")) return "issue";
  if (event?.includes("merge request")) return "merge_request";
  return null;
}

function mapGitLabSeverity(kind: GitLabSignalKind, attrs: GitLabObject): SignalSeverity {
  const severity = asString(attrs.severity)?.toLowerCase();
  switch (severity) {
    case "critical":
    case "blocker":
      return "critical";
    case "high":
    case "major":
      return "error";
    case "medium":
    case "warning":
    case "at_risk":
      return "warning";
    case "low":
    case "info":
      return "info";
  }

  const health = asString(attrs.health_status)?.toLowerCase();
  if (health === "at_risk") return "warning";
  if (health === "needs_attention") return "error";
  return kind === "issue" ? "warning" : "info";
}

function mapGitLabResolution(kind: GitLabSignalKind, attrs: GitLabObject): Signal["resolution"] {
  const action = asString(attrs.action)?.toLowerCase();
  const state = asString(attrs.state)?.toLowerCase();
  if (action === "close" || action === "closed") return "resolved";
  if (kind === "merge_request" && (action === "merge" || action === "merged")) return "resolved";
  if (state === "closed" || state === "merged") return "resolved";
  return "open";
}

function projectIdentity(payload: GitLabObject): {
  id?: string;
  path?: string;
  name?: string;
  webUrl?: string;
} {
  const project = asObject(payload.project) ?? asObject(payload.repository) ?? {};
  const group = asObject(payload.group) ?? {};
  return {
    id: asId(project.id) ?? asId(payload.project_id) ?? asId(group.id),
    path: asString(project.path_with_namespace) ?? asString(project.path) ?? asString(group.full_path),
    name: asString(project.name) ?? asString(group.name),
    webUrl: firstString(project.web_url, project.homepage, group.web_url),
  };
}

function labelsFrom(payload: GitLabObject, attrs: GitLabObject): string[] | undefined {
  const raw = Array.isArray(attrs.labels) ? attrs.labels : Array.isArray(payload.labels) ? payload.labels : undefined;
  if (!raw) return undefined;
  const labels = raw
    .map((label) => asObject(label)?.title ?? asString(label))
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels : undefined;
}

function deliveryIdFrom(headers: Record<string, string | undefined>): string | undefined {
  return firstString(
    headers["x-gitlab-event-uuid"],
    headers["idempotency-key"],
    headers["webhook-id"],
    headers["x-request-id"],
  );
}

function fallbackLink(kind: GitLabSignalKind, projectWebUrl: string | undefined, iid: string): string | undefined {
  if (!projectWebUrl) return undefined;
  const base = projectWebUrl.replace(/\/+$/, "");
  return kind === "issue" ? `${base}/-/issues/${iid}` : `${base}/-/merge_requests/${iid}`;
}

export const gitlabSource: SignalSource = {
  provider: "gitlab",
  secretEnvVar: "FUSION_SIGNAL_GITLAB_SECRET",

  verify(ctx: SignalVerifyContext): SignalVerifyResult {
    if (!ctx.secret) {
      return { valid: false, status: 401, error: "GitLab webhook secret is not configured" };
    }
    const token = ctx.headers["x-gitlab-token"];
    if (!token) {
      return { valid: false, status: 401, error: "Missing X-Gitlab-Token header" };
    }
    if (!verifySharedSecretToken(token, ctx.secret)) {
      return { valid: false, status: 401, error: "Invalid GitLab token" };
    }
    return { valid: true };
  },

  normalize(payload: unknown, ctx: SignalVerifyContext): Signal | null {
    const p = asObject(payload);
    if (!p) throw new Error("Payload must be a JSON object");

    const kind = resolveKind(p, ctx.headers);
    if (!kind) {
      return null;
    }

    const attrs = asObject(p.object_attributes);
    if (!attrs) throw new Error("Missing GitLab object_attributes");

    const iid = asId(attrs.iid);
    const title = asString(attrs.title);
    if (!iid) throw new Error("Missing GitLab object_attributes.iid");
    if (!title) throw new Error("Missing GitLab object_attributes.title");

    const project = projectIdentity(p);
    const projectKey = project.path ?? project.id ?? "unknown-project";
    const groupingKey = `gitlab:${projectKey}:${kind}:${iid}`;
    const action = asString(attrs.action)?.toLowerCase() ?? "event";
    const state = asString(attrs.state)?.toLowerCase();
    const timestamp = parseTimestamp(attrs.updated_at, attrs.created_at, p.updated_at, p.created_at);
    const deliveryId = deliveryIdFrom(ctx.headers);
    const externalId = deliveryId
      ? `delivery:${deliveryId}`
      : `${groupingKey}:${action}:${state ?? "unknown"}:${timestamp ?? "latest"}`;
    const itemLabel = kind === "issue" ? "issue" : "merge request";
    const ref = kind === "issue" ? `#${iid}` : `!${iid}`;
    const description = asString(attrs.description);
    const link = firstString(attrs.url, fallbackLink(kind, project.webUrl, iid));

    const signal: Signal = {
      source: "gitlab",
      externalId,
      groupingKey,
      title: `GitLab ${itemLabel} ${ref}: ${title}`,
      body: [
        description,
        `GitLab ${itemLabel} ${ref} ${action}${state ? ` (${state})` : ""}.`,
        project.name || project.path ? `Project: ${project.name ?? project.path}` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n\n"),
      severity: mapGitLabSeverity(kind, attrs),
      resolution: mapGitLabResolution(kind, attrs),
      link,
      timestamp,
      meta: {
        kind,
        action,
        state,
        iid,
        objectId: asId(attrs.id),
        projectId: project.id,
        projectPath: project.path,
        projectUrl: project.webUrl,
        user: asObject(p.user)?.username ?? asObject(p.user)?.name,
        labels: labelsFrom(p, attrs),
      },
    };

    return applySignalCaps(signal);
  },
};
