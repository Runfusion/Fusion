import {
  applySignalCaps,
  verifyHmacSignature,
  type Signal,
  type SignalSeverity,
  type SignalSource,
  type SignalVerifyContext,
  type SignalVerifyResult,
} from "../signal-source.js";

/**
 * PagerDuty adapter (scaffold).
 *
 * PagerDuty v3 webhooks sign with `X-PagerDuty-Signature: v1=<hex>` =
 * HMAC-SHA256 of the raw body using the subscription secret. `groupingKey` is
 * the PagerDuty `incident.id` (native dedup primitive for U13's storm guard).
 */

function mapUrgency(urgency: unknown, severity: unknown): SignalSeverity {
  if (severity === "critical") return "critical";
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  if (severity === "info") return "info";
  return urgency === "high" ? "critical" : "warning";
}

function parsePagerDutySignatureHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  // Header may carry multiple comma-separated `v1=<hex>` signatures (key rotation).
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("v1=")) return trimmed.slice("v1=".length);
  }
  return undefined;
}

export const pagerdutySource: SignalSource = {
  provider: "pagerduty",
  secretEnvVar: "FUSION_SIGNAL_PAGERDUTY_SECRET",

  verify(ctx: SignalVerifyContext): SignalVerifyResult {
    if (!ctx.secret) {
      return { valid: false, status: 401, error: "PagerDuty signing secret is not configured" };
    }
    const signature = parsePagerDutySignatureHeader(ctx.headers["x-pagerduty-signature"]);
    if (!signature) {
      return { valid: false, status: 401, error: "Missing X-PagerDuty-Signature header" };
    }
    if (!verifyHmacSignature(ctx.rawBody, signature, ctx.secret)) {
      return { valid: false, status: 401, error: "Invalid signature" };
    }
    return { valid: true };
  },

  normalize(payload: unknown): Signal | null {
    if (!payload || typeof payload !== "object") {
      throw new Error("Payload must be a JSON object");
    }
    const p = payload as Record<string, unknown>;
    const event = (p.event as Record<string, unknown> | undefined) ?? p;
    const data = (event.data as Record<string, unknown> | undefined) ?? event;

    const incidentId =
      (typeof data.id === "string" && data.id) ||
      (typeof p.id === "string" && p.id) ||
      "";
    if (!incidentId) throw new Error("Missing PagerDuty incident.id");

    const title =
      (typeof data.title === "string" && data.title) ||
      (typeof data.summary === "string" && data.summary) ||
      `PagerDuty incident ${incidentId}`;

    const eventId =
      typeof event.id === "string" ? event.id : incidentId;

    const signal: Signal = {
      source: "pagerduty",
      externalId: eventId,
      groupingKey: incidentId,
      title,
      body: typeof data.description === "string" ? data.description : undefined,
      severity: mapUrgency(data.urgency, data.severity),
      link: typeof data.html_url === "string" ? data.html_url : undefined,
      timestamp:
        typeof event.occurred_at === "string" ? Date.parse(event.occurred_at) : undefined,
      meta: {
        eventType: typeof event.event_type === "string" ? event.event_type : undefined,
        status: typeof data.status === "string" ? data.status : undefined,
      },
    };
    return applySignalCaps(signal);
  },
};
