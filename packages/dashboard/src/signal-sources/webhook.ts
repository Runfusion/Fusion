import {
  applySignalCaps,
  fallbackGroupingKey,
  isWithinReplayWindow,
  verifyHmacSignature,
  type Signal,
  type SignalSource,
  type SignalVerifyContext,
  type SignalVerifyResult,
  type SignalSeverity,
} from "../signal-source.js";

/**
 * Generic webhook adapter — the must-work path (per the plan's scope
 * discipline). It is NEVER an unauthenticated task-creation endpoint: a missing
 * or invalid secret/signature is rejected with 401.
 *
 * Signature: HMAC-SHA256 of the raw body, hex-encoded, in the
 * `X-Fusion-Signature` header (optionally `sha256=`-prefixed).
 * Timestamp: `X-Fusion-Timestamp` (epoch ms) drives the replay window.
 *
 * Payload contract (JSON):
 *   {
 *     "id": "<stable external id>",        // required
 *     "title": "<short title>",            // required
 *     "body"?: "...",
 *     "severity"?: "critical|error|warning|info",
 *     "link"?: "https://...",
 *     "groupingKey"?: "<caller-supplied>", // else falls back to source+title
 *     "timestamp"?: <epoch ms>,
 *     "meta"?: { ... }
 *   }
 */

const SEVERITIES: SignalSeverity[] = ["critical", "error", "warning", "info"];

function coerceSeverity(value: unknown): SignalSeverity {
  return typeof value === "string" && (SEVERITIES as string[]).includes(value)
    ? (value as SignalSeverity)
    : "warning";
}

function stripSig(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
}

export const webhookSource: SignalSource = {
  provider: "webhook",
  secretEnvVar: "FUSION_SIGNAL_WEBHOOK_SECRET",

  verify(ctx: SignalVerifyContext): SignalVerifyResult {
    if (!ctx.secret) {
      return { valid: false, status: 401, error: "Webhook signing secret is not configured" };
    }
    const signature = stripSig(ctx.headers["x-fusion-signature"]);
    if (!signature) {
      return { valid: false, status: 401, error: "Missing signature header" };
    }
    if (!verifyHmacSignature(ctx.rawBody, signature, ctx.secret)) {
      return { valid: false, status: 401, error: "Invalid signature" };
    }
    const tsHeader = ctx.headers["x-fusion-timestamp"];
    const ts = tsHeader ? Number(tsHeader) : undefined;
    if (!isWithinReplayWindow(ts)) {
      return { valid: false, status: 401, error: "Timestamp outside replay window" };
    }
    return { valid: true };
  },

  normalize(payload: unknown): Signal | null {
    if (!payload || typeof payload !== "object") {
      throw new Error("Payload must be a JSON object");
    }
    const p = payload as Record<string, unknown>;
    const externalId = typeof p.id === "string" ? p.id.trim() : "";
    const title = typeof p.title === "string" ? p.title.trim() : "";
    if (!externalId) throw new Error("Missing required field: id");
    if (!title) throw new Error("Missing required field: title");

    const supplied = typeof p.groupingKey === "string" ? p.groupingKey.trim() : "";
    const groupingKey = supplied || fallbackGroupingKey("webhook", title);

    const signal: Signal = {
      source: "webhook",
      externalId,
      groupingKey,
      title,
      body: typeof p.body === "string" ? p.body : undefined,
      severity: coerceSeverity(p.severity),
      link: typeof p.link === "string" ? p.link : undefined,
      timestamp: typeof p.timestamp === "number" ? p.timestamp : undefined,
      meta: p.meta && typeof p.meta === "object" ? (p.meta as Record<string, unknown>) : undefined,
    };
    return applySignalCaps(signal);
  },
};
