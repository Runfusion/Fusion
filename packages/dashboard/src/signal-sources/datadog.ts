import {
  applySignalCaps,
  isWithinReplayWindow,
  verifyHmacSignature,
  type Signal,
  type SignalSeverity,
  type SignalSource,
  type SignalVerifyContext,
  type SignalVerifyResult,
} from "../signal-source.js";

/**
 * Datadog adapter (scaffold).
 *
 * Datadog webhooks don't ship a built-in HMAC header, so the convention is to
 * include a shared-secret HMAC the user templates into a custom header
 * (`X-Datadog-Signature` = HMAC-SHA256(hex) of the raw body). `groupingKey` is
 * the Datadog monitor/aggregation key (`alert_id` / `aggreg_key`).
 */

function mapAlertType(value: unknown): SignalSeverity {
  switch (value) {
    case "error":
      return "critical";
    case "warning":
    case "warn":
      return "warning";
    case "success":
    case "recovery":
    case "info":
      return "info";
    default:
      return "error";
  }
}

export const datadogSource: SignalSource = {
  provider: "datadog",
  secretEnvVar: "FUSION_SIGNAL_DATADOG_SECRET",

  verify(ctx: SignalVerifyContext): SignalVerifyResult {
    if (!ctx.secret) {
      return { valid: false, status: 401, error: "Datadog signing secret is not configured" };
    }
    const signature = ctx.headers["x-datadog-signature"];
    if (!signature) {
      return { valid: false, status: 401, error: "Missing X-Datadog-Signature header" };
    }
    if (!verifyHmacSignature(ctx.rawBody, signature, ctx.secret)) {
      return { valid: false, status: 401, error: "Invalid signature" };
    }
    const tsHeader = ctx.headers["x-datadog-timestamp"];
    if (tsHeader && !isWithinReplayWindow(Number(tsHeader))) {
      return { valid: false, status: 401, error: "Timestamp outside replay window" };
    }
    return { valid: true };
  },

  normalize(payload: unknown): Signal | null {
    if (!payload || typeof payload !== "object") {
      throw new Error("Payload must be a JSON object");
    }
    const p = payload as Record<string, unknown>;

    const groupingKey =
      (typeof p.aggreg_key === "string" && p.aggreg_key) ||
      (typeof p.alert_id === "string" && p.alert_id) ||
      (typeof p.id === "string" && p.id) ||
      "";
    if (!groupingKey) throw new Error("Missing Datadog aggreg_key/alert_id");

    const externalId =
      (typeof p.event_id === "string" && p.event_id) ||
      (typeof p.id === "string" && p.id) ||
      groupingKey;

    const title =
      (typeof p.title === "string" && p.title) ||
      (typeof p.event_title === "string" && p.event_title) ||
      `Datadog alert ${groupingKey}`;

    const signal: Signal = {
      source: "datadog",
      externalId,
      groupingKey,
      title,
      body: typeof p.body === "string" ? p.body : typeof p.text_only_msg === "string" ? p.text_only_msg : undefined,
      severity: mapAlertType(p.alert_type),
      link: typeof p.link === "string" ? p.link : typeof p.url === "string" ? p.url : undefined,
      timestamp:
        typeof p.date === "number"
          ? p.date
          : typeof p.last_updated === "number"
            ? p.last_updated
            : undefined,
      meta: {
        priority: typeof p.priority === "string" ? p.priority : undefined,
        scope: typeof p.scope === "string" ? p.scope : undefined,
      },
    };
    return applySignalCaps(signal);
  },
};
