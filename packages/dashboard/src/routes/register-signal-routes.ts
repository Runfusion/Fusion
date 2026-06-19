import type { Request, Response } from "express";
import type { Task, TaskStore } from "@fusion/core";
import { ApiError, badRequest, rateLimited, unauthorized } from "../api-error.js";
import {
  DeliveryNonceCache,
  SIGNAL_MAX_BODY_BYTES,
  SignalRateLimiter,
  type Signal,
  type SignalProvider,
  type SignalSource,
} from "../signal-source.js";
import { webhookSource } from "../signal-sources/webhook.js";
import { sentrySource } from "../signal-sources/sentry.js";
import { datadogSource } from "../signal-sources/datadog.js";
import { pagerdutySource } from "../signal-sources/pagerduty.js";
import type { ApiRouteRegistrar } from "./types.js";

/**
 * U11 — inbound external-signal webhook routes.
 *
 * Mounts `POST /api/signals/:provider` for each supported provider. Each request
 * is HMAC-verified by the provider adapter against a per-provider secret sourced
 * from the environment (never source-controlled). Verified, normalized signals
 * create a task in the `triage` column via the scoped task store, mirroring the
 * GitHub ingestion path.
 *
 * Security applied here (mandatory, not deferred):
 *  - mandatory HMAC verify → 401 on missing/invalid secret or signature
 *  - body-size cap (~1 MB) → 413
 *  - per-source rate limit → 429
 *  - delivery-id nonce dedup (replay) → 401
 *  - persistent external-id dedup against existing tasks → 200, no new task
 *  - field-length caps + meta-byte cap applied in the adapter (applySignalCaps)
 *  - URLs are SSRF-untrusted (stored as data only; unsafe links dropped)
 *  - `meta` stored as JSON data, never rendered as raw HTML
 */

/** Thin registry — kept minimal per scope discipline (no heavy abstraction). */
const SIGNAL_SOURCES: Record<SignalProvider, SignalSource> = {
  webhook: webhookSource,
  sentry: sentrySource,
  datadog: datadogSource,
  pagerduty: pagerdutySource,
};

export function getSignalSource(provider: string): SignalSource | undefined {
  return SIGNAL_SOURCES[provider as SignalProvider];
}

/**
 * Resolve a provider's HMAC secret. Env var is the canonical, never
 * source-controlled source. An optional resolver (e.g. encrypted settings) can
 * be supplied for deployments that store secrets there.
 */
export function resolveSignalSecret(
  source: SignalSource,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[source.secretEnvVar];
  return value && value.length > 0 ? value : undefined;
}

const SIGNAL_DELIVERY_META_KEY = "signalDeliveryId";
const SIGNAL_GROUPING_META_KEY = "signalGroupingKey";
const SIGNAL_SOURCE_META_KEY = "signalSource";

/**
 * Persistent delivery dedup: has a task already been created for this provider +
 * external id? Scans recent tasks for the provenance marker. Mirrors the spirit
 * of `github-tracking-dedup.ts` for the inbound path.
 */
async function findExistingSignalTask(
  store: TaskStore,
  provider: SignalProvider,
  externalId: string,
): Promise<Task | undefined> {
  const tasks = await store.listTasks({ slim: true, includeArchived: true });
  return tasks.find((t) => {
    const meta = t.source?.sourceMetadata as Record<string, unknown> | undefined;
    return (
      meta?.[SIGNAL_SOURCE_META_KEY] === provider &&
      meta?.[SIGNAL_DELIVERY_META_KEY] === externalId
    );
  });
}

/** Build a task-create input from a normalized signal. */
export function signalToTaskInput(signal: Signal): Parameters<TaskStore["createTask"]>[0] {
  const lines: string[] = [];
  if (signal.body) lines.push(signal.body);
  if (signal.link) lines.push(`\nSource: ${signal.link}`);
  lines.push(`\nSeverity: ${signal.severity}`);
  const description = `${signal.title}\n\n${lines.join("\n")}`.trim();

  return {
    title: signal.title,
    description,
    column: "triage",
    priority: signal.severity === "critical" ? "high" : undefined,
    source: {
      // Reuse the existing `api` source type — signals arrive over the API
      // webhook surface. Provenance is carried in sourceMetadata so we do not
      // need a core schema/type change for U11.
      sourceType: "api",
      sourceMetadata: {
        [SIGNAL_SOURCE_META_KEY]: signal.source,
        [SIGNAL_DELIVERY_META_KEY]: signal.externalId,
        [SIGNAL_GROUPING_META_KEY]: signal.groupingKey,
        signalSeverity: signal.severity,
        signalLink: signal.link,
        // `meta` is stored as data only and never rendered as raw HTML.
        signalMeta: signal.meta,
      },
    },
  };
}

/**
 * Pure ingestion core: verify → dedup → normalize → create task. Exposed for
 * unit testing without the full express app.
 */
export interface SignalIngestDeps {
  source: SignalSource;
  store: TaskStore;
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
  body: unknown;
  nonceCache: DeliveryNonceCache;
}

export interface SignalIngestResult {
  status: number;
  taskId?: string;
  deduped?: boolean;
  error?: string;
}

export async function ingestSignal(deps: SignalIngestDeps): Promise<SignalIngestResult> {
  const { source, store, rawBody, headers, body, nonceCache } = deps;
  const secret = resolveSignalSecret(source);

  // 1. Mandatory HMAC verification. Missing/invalid secret or signature → 401.
  const verification = source.verify({ rawBody, headers, secret });
  if (!verification.valid) {
    return { status: verification.status ?? 401, error: verification.error ?? "Unauthorized" };
  }

  // 2. Normalize (malformed payload → throw → caller maps to 4xx, no task).
  let signal: Signal | null;
  try {
    signal = source.normalize(body, { rawBody, headers, secret });
  } catch (err) {
    return { status: 400, error: err instanceof Error ? err.message : "Malformed payload" };
  }
  if (!signal) {
    // Valid-but-not-actionable (e.g. ping/health) → accepted, no task.
    return { status: 200 };
  }

  // 3. Replay nonce dedup (same delivery id within the replay window) → 401.
  if (!nonceCache.check(`${signal.source}:${signal.externalId}`)) {
    return { status: 401, error: "Replayed delivery rejected" };
  }

  // 4. Persistent external-id dedup → 200 with the existing task, no new task.
  const existing = await findExistingSignalTask(store, signal.source, signal.externalId);
  if (existing) {
    return { status: 200, taskId: existing.id, deduped: true };
  }

  // 5. Create the triage task.
  const task = await store.createTask(signalToTaskInput(signal));
  return { status: 201, taskId: task.id };
}

export const registerSignalRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, getScopedStore } = ctx;

  // Shared per-process state for replay dedup + rate limiting.
  const nonceCache = new DeliveryNonceCache();
  const rateLimiter = new SignalRateLimiter();

  router.post("/signals/:provider", async (req: Request, res: Response) => {
    const provider = Array.isArray(req.params.provider)
      ? req.params.provider[0]
      : req.params.provider;

    const source = getSignalSource(provider);
    if (!source) {
      throw badRequest(`Unknown signal provider: ${String(provider)}`);
    }

    // Body-size cap (~1 MB) → 413.
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (rawBody && rawBody.byteLength > SIGNAL_MAX_BODY_BYTES) {
      throw new ApiError(413, "Signal payload too large");
    }

    // Per-source rate limit → 429.
    if (!rateLimiter.allow(source.provider)) {
      throw rateLimited(`Rate limit exceeded for signal source: ${source.provider}`);
    }

    if (!rawBody) {
      // Without the raw body we cannot HMAC-verify — never create a task.
      throw unauthorized("Raw body not available for signature verification");
    }

    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }

    const store = await getScopedStore(req);

    const result = await ingestSignal({
      source,
      store,
      rawBody,
      headers,
      body: req.body,
      nonceCache,
    });

    if (result.status === 401) {
      throw unauthorized(result.error ?? "Unauthorized");
    }
    if (result.status === 400) {
      throw badRequest(result.error ?? "Malformed payload");
    }

    res.status(result.status).json({
      ok: result.status < 400,
      taskId: result.taskId,
      deduped: result.deduped ?? false,
    });
  });
};
