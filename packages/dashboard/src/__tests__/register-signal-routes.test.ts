// @vitest-environment node

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { DeliveryNonceCache, type SignalSource } from "../signal-source.js";
import {
  ingestSignal,
  resolveSignalSecret,
  signalToTaskInput,
  getSignalSource,
} from "../routes/register-signal-routes.js";
import { webhookSource } from "../signal-sources/webhook.js";
import { sentrySource } from "../signal-sources/sentry.js";
import { datadogSource } from "../signal-sources/datadog.js";
import { pagerdutySource } from "../signal-sources/pagerduty.js";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

/** Minimal fake task store implementing only what the ingestion path uses. */
function makeStore() {
  const tasks: Task[] = [];
  let counter = 0;
  const store = {
    async listTasks() {
      return tasks;
    },
    async createTask(input: Parameters<TaskStore["createTask"]>[0]) {
      const task = {
        id: `FN-${++counter}`,
        title: input.title,
        description: input.description,
        column: input.column,
        source: input.source,
      } as unknown as Task;
      tasks.push(task);
      return task;
    },
    _tasks: tasks,
  };
  return store as unknown as TaskStore & { _tasks: Task[] };
}

const SECRETS: Record<string, string> = {
  FUSION_SIGNAL_WEBHOOK_SECRET: "wh-secret",
  FUSION_SIGNAL_SENTRY_SECRET: "sentry-secret",
  FUSION_SIGNAL_DATADOG_SECRET: "datadog-secret",
  FUSION_SIGNAL_PAGERDUTY_SECRET: "pd-secret",
};

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(SECRETS)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  for (const k of Object.keys(SECRETS)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function ctxFor(source: SignalSource, payload: object, headers: Record<string, string>) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { rawBody, headers: lower, body: payload };
}

describe("getSignalSource registry", () => {
  it("resolves all four providers and rejects unknown", () => {
    expect(getSignalSource("webhook")).toBe(webhookSource);
    expect(getSignalSource("sentry")).toBe(sentrySource);
    expect(getSignalSource("datadog")).toBe(datadogSource);
    expect(getSignalSource("pagerduty")).toBe(pagerdutySource);
    expect(getSignalSource("bogus")).toBeUndefined();
  });
});

describe("ingestSignal — generic webhook (must-work path)", () => {
  it("creates one triage task for a valid signed payload", async () => {
    const store = makeStore();
    const ts = Date.now();
    const payload = { id: "evt-1", title: "Disk full", severity: "critical", link: "https://ops.example.com/a" };
    const { rawBody, headers, body } = ctxFor(webhookSource, payload, {
      "x-fusion-signature": sign(JSON.stringify(payload), SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
      "x-fusion-timestamp": String(ts),
    });

    const res = await ingestSignal({
      source: webhookSource,
      store,
      rawBody,
      headers,
      body,
      nonceCache: new DeliveryNonceCache(),
    });

    expect(res.status).toBe(201);
    expect(res.taskId).toBe("FN-1");
    expect(store._tasks).toHaveLength(1);
    expect(store._tasks[0].column).toBe("triage");
    const meta = store._tasks[0].source?.sourceMetadata as Record<string, unknown>;
    expect(meta.signalSource).toBe("webhook");
    expect(meta.signalDeliveryId).toBe("evt-1");
    expect(meta.signalGroupingKey).toBe("webhook:disk full");
  });

  it("rejects with 401 and creates no task when no secret is configured", async () => {
    delete process.env.FUSION_SIGNAL_WEBHOOK_SECRET;
    const store = makeStore();
    const payload = { id: "x", title: "y" };
    const { rawBody, headers, body } = ctxFor(webhookSource, payload, {
      "x-fusion-signature": "whatever",
      "x-fusion-timestamp": String(Date.now()),
    });
    const res = await ingestSignal({
      source: webhookSource,
      store,
      rawBody,
      headers,
      body,
      nonceCache: new DeliveryNonceCache(),
    });
    expect(res.status).toBe(401);
    expect(store._tasks).toHaveLength(0);
  });

  it("rejects with 401 on an invalid signature", async () => {
    const store = makeStore();
    const payload = { id: "x", title: "y" };
    const { rawBody, headers, body } = ctxFor(webhookSource, payload, {
      "x-fusion-signature": sign("tampered", SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
      "x-fusion-timestamp": String(Date.now()),
    });
    const res = await ingestSignal({
      source: webhookSource,
      store,
      rawBody,
      headers,
      body,
      nonceCache: new DeliveryNonceCache(),
    });
    expect(res.status).toBe(401);
    expect(store._tasks).toHaveLength(0);
  });

  it("rejects a stale timestamp (replay window)", async () => {
    const store = makeStore();
    const payload = { id: "x", title: "y" };
    const stale = Date.now() - 10 * 60_000;
    const { rawBody, headers, body } = ctxFor(webhookSource, payload, {
      "x-fusion-signature": sign(JSON.stringify(payload), SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
      "x-fusion-timestamp": String(stale),
    });
    const res = await ingestSignal({
      source: webhookSource,
      store,
      rawBody,
      headers,
      body,
      nonceCache: new DeliveryNonceCache(),
    });
    expect(res.status).toBe(401);
    expect(store._tasks).toHaveLength(0);
  });

  it("rejects a replayed delivery nonce", async () => {
    const store = makeStore();
    const nonceCache = new DeliveryNonceCache();
    const payload = { id: "dup", title: "y" };
    const headersInput = {
      "x-fusion-signature": sign(JSON.stringify(payload), SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
      "x-fusion-timestamp": String(Date.now()),
    };
    const first = ctxFor(webhookSource, payload, headersInput);
    const r1 = await ingestSignal({ source: webhookSource, store, ...first, nonceCache });
    expect(r1.status).toBe(201);
    const second = ctxFor(webhookSource, payload, headersInput);
    const r2 = await ingestSignal({ source: webhookSource, store, ...second, nonceCache });
    expect(r2.status).toBe(401);
    expect(store._tasks).toHaveLength(1);
  });

  it("dedupes a duplicate external id against existing tasks (no double-create)", async () => {
    const store = makeStore();
    const payload = { id: "same-id", title: "y" };
    const mk = () =>
      ctxFor(webhookSource, payload, {
        "x-fusion-signature": sign(JSON.stringify(payload), SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
        "x-fusion-timestamp": String(Date.now()),
      });
    // Two separate nonce caches simulate a process restart (nonce dedup reset),
    // so the persistent external-id dedup is what must catch the duplicate.
    const r1 = await ingestSignal({ source: webhookSource, store, ...mk(), nonceCache: new DeliveryNonceCache() });
    expect(r1.status).toBe(201);
    const r2 = await ingestSignal({ source: webhookSource, store, ...mk(), nonceCache: new DeliveryNonceCache() });
    expect(r2.status).toBe(200);
    expect(r2.deduped).toBe(true);
    expect(r2.taskId).toBe("FN-1");
    expect(store._tasks).toHaveLength(1);
  });

  it("returns 400 with no task on a malformed payload", async () => {
    const store = makeStore();
    const payload = { nope: true }; // missing id/title
    const { rawBody, headers, body } = ctxFor(webhookSource, payload, {
      "x-fusion-signature": sign(JSON.stringify(payload), SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
      "x-fusion-timestamp": String(Date.now()),
    });
    const res = await ingestSignal({
      source: webhookSource,
      store,
      rawBody,
      headers,
      body,
      nonceCache: new DeliveryNonceCache(),
    });
    expect(res.status).toBe(400);
    expect(store._tasks).toHaveLength(0);
  });
});

describe("ingestSignal — Sentry adapter", () => {
  it("creates one triage task with normalized title/severity/link + groupingKey from issue.id", async () => {
    const store = makeStore();
    const payload = {
      data: {
        issue: {
          id: "1234",
          title: "TypeError: undefined is not a function",
          level: "fatal",
          web_url: "https://sentry.io/issues/1234",
          shortId: "WEB-12",
          project: "web",
        },
      },
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(payload);
    const res = await ingestSignal({
      source: sentrySource,
      store,
      rawBody: Buffer.from(raw),
      headers: { "sentry-hook-signature": sign(raw, SECRETS.FUSION_SIGNAL_SENTRY_SECRET) },
      body: payload,
      nonceCache: new DeliveryNonceCache(),
    });
    expect(res.status).toBe(201);
    const task = store._tasks[0];
    const meta = task.source?.sourceMetadata as Record<string, unknown>;
    expect(meta.signalGroupingKey).toBe("1234");
    expect(meta.signalSeverity).toBe("critical");
    expect(task.title).toContain("TypeError");
  });

  it("rejects an unsigned Sentry webhook with 401", async () => {
    const store = makeStore();
    const payload = { data: { issue: { id: "1", title: "x" } } };
    const res = await ingestSignal({
      source: sentrySource,
      store,
      rawBody: Buffer.from(JSON.stringify(payload)),
      headers: {},
      body: payload,
      nonceCache: new DeliveryNonceCache(),
    });
    expect(res.status).toBe(401);
    expect(store._tasks).toHaveLength(0);
  });
});

describe("ingestSignal — Datadog & PagerDuty adapters (groupingKey from native primitive)", () => {
  it("Datadog uses aggreg_key as groupingKey", async () => {
    const store = makeStore();
    const payload = { aggreg_key: "agg-7", event_id: "ev-7", title: "High CPU", alert_type: "error" };
    const raw = JSON.stringify(payload);
    const res = await ingestSignal({
      source: datadogSource,
      store,
      rawBody: Buffer.from(raw),
      headers: { "x-datadog-signature": sign(raw, SECRETS.FUSION_SIGNAL_DATADOG_SECRET) },
      body: payload,
      nonceCache: new DeliveryNonceCache(),
    });
    expect(res.status).toBe(201);
    const meta = store._tasks[0].source?.sourceMetadata as Record<string, unknown>;
    expect(meta.signalGroupingKey).toBe("agg-7");
    expect(meta.signalDeliveryId).toBe("ev-7");
  });

  it("PagerDuty uses incident.id as groupingKey", async () => {
    const store = makeStore();
    const payload = {
      event: {
        id: "evt-pd-1",
        event_type: "incident.triggered",
        occurred_at: new Date().toISOString(),
        data: { id: "PINC1", title: "DB down", urgency: "high", html_url: "https://pd.example.com/i/PINC1", status: "triggered" },
      },
    };
    const raw = JSON.stringify(payload);
    const res = await ingestSignal({
      source: pagerdutySource,
      store,
      rawBody: Buffer.from(raw),
      headers: { "x-pagerduty-signature": `v1=${sign(raw, SECRETS.FUSION_SIGNAL_PAGERDUTY_SECRET)}` },
      body: payload,
      nonceCache: new DeliveryNonceCache(),
    });
    expect(res.status).toBe(201);
    const meta = store._tasks[0].source?.sourceMetadata as Record<string, unknown>;
    expect(meta.signalGroupingKey).toBe("PINC1");
    expect(meta.signalDeliveryId).toBe("evt-pd-1");
  });
});

describe("helpers", () => {
  it("resolveSignalSecret reads the provider env var", () => {
    expect(resolveSignalSecret(webhookSource)).toBe("wh-secret");
    expect(resolveSignalSecret(webhookSource, {})).toBeUndefined();
  });

  it("signalToTaskInput maps to a triage task with provenance metadata", () => {
    const input = signalToTaskInput({
      source: "webhook",
      externalId: "e",
      groupingKey: "g",
      title: "t",
      severity: "critical",
    });
    expect(input.column).toBe("triage");
    expect(input.priority).toBe("high");
    expect(input.source?.sourceType).toBe("api");
  });
});
