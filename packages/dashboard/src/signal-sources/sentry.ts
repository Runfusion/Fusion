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
 * Sentry adapter (scaffold).
 *
 * Sentry signs webhooks with `Sentry-Hook-Signature` = HMAC-SHA256(hex) of the
 * raw request body using the integration's client secret. `groupingKey` is the
 * Sentry `issue.id` (its native dedup primitive) — used by U13's storm guard.
 */

function mapLevel(level: unknown): SignalSeverity {
  switch (level) {
    case "fatal":
    case "critical":
      return "critical";
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
    case "debug":
      return "info";
    default:
      return "error";
  }
}

export const sentrySource: SignalSource = {
  provider: "sentry",
  secretEnvVar: "FUSION_SIGNAL_SENTRY_SECRET",

  verify(ctx: SignalVerifyContext): SignalVerifyResult {
    if (!ctx.secret) {
      return { valid: false, status: 401, error: "Sentry signing secret is not configured" };
    }
    const signature = ctx.headers["sentry-hook-signature"];
    if (!signature) {
      return { valid: false, status: 401, error: "Missing Sentry-Hook-Signature header" };
    }
    if (!verifyHmacSignature(ctx.rawBody, signature, ctx.secret)) {
      return { valid: false, status: 401, error: "Invalid signature" };
    }
    // Sentry sends `Sentry-Hook-Timestamp` (epoch ms) on installation events;
    // when absent on issue events we fall back to the payload timestamp checked
    // during normalize. Reject only when an explicit header is stale.
    const tsHeader = ctx.headers["sentry-hook-timestamp"];
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
    const data = (p.data as Record<string, unknown> | undefined) ?? p;
    const issue =
      (data.issue as Record<string, unknown> | undefined) ??
      (data.error as Record<string, unknown> | undefined) ??
      (data.event as Record<string, unknown> | undefined);
    if (!issue || typeof issue !== "object") {
      throw new Error("Missing Sentry issue/event data");
    }

    const issueId =
      typeof issue.id === "string"
        ? issue.id
        : typeof issue.id === "number"
          ? String(issue.id)
          : "";
    if (!issueId) throw new Error("Missing Sentry issue.id");

    const title =
      (typeof issue.title === "string" && issue.title) ||
      (typeof issue.culprit === "string" && issue.culprit) ||
      `Sentry issue ${issueId}`;

    const link =
      typeof issue.web_url === "string"
        ? issue.web_url
        : typeof issue.permalink === "string"
          ? issue.permalink
          : undefined;

    const signal: Signal = {
      source: "sentry",
      externalId: issueId,
      groupingKey: issueId,
      title,
      body: typeof issue.culprit === "string" ? issue.culprit : undefined,
      severity: mapLevel(issue.level),
      link,
      timestamp:
        typeof p.timestamp === "number"
          ? p.timestamp
          : typeof issue.lastSeen === "string"
            ? Date.parse(issue.lastSeen)
            : undefined,
      meta: {
        project: typeof issue.project === "string" ? issue.project : undefined,
        shortId: typeof issue.shortId === "string" ? issue.shortId : undefined,
      },
    };
    return applySignalCaps(signal);
  },
};
