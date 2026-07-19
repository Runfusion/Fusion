// @vitest-environment node

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aggregateSignalsAnalytics, drizzleSql as sql, type AsyncDataLayer, type Task, type TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { DeliveryNonceCache, type SignalSource } from "../signal-source.js";
import {
  ingestSignal,
  resolveSignalSecret,
  signalToTaskInput,
  getSignalSource,
  resolveConfiguredSignalProviders,
} from "../routes/register-signal-routes.js";
import { webhookSource } from "../signal-sources/webhook.js";
import { sentrySource } from "../signal-sources/sentry.js";
import { datadogSource } from "../signal-sources/datadog.js";
import { pagerdutySource } from "../signal-sources/pagerduty.js";
import { gitlabSource } from "../signal-sources/gitlab.js";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

/** Minimal fake task store implementing only what the ingestion path uses. */
function makeStore(layer?: AsyncDataLayer) {
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
        // FNXC:Workflows 2026-07-05-00:00: FN-7611 — mirror the real store's intake-column
        // resolution (input.column || resolvedEntryColumn || "triage") for the default workflow.
        column: input.column ?? "triage",
        source: input.source,
      } as unknown as Task;
      tasks.push(task);
      return task;
    },
    getAsyncLayer() {
      if (!layer) throw new Error("test AsyncDataLayer not configured");
      return layer;
    },
    _tasks: tasks,
  };
  return store as unknown as TaskStore & { _tasks: Task[] };
}

async function makeDbStore() {
  const harness = await createTaskStoreForTest();
  // FNXC:PostgresCutover 2026-07-16-06:30: monitor writes are tenant-bound;
  // bind the isolated layer so incident ingestion exercises that invariant.
  (harness.layer as { projectId?: string }).projectId = "signal-routes-project";
  harnesses.push(harness);
  return { layer: harness.layer, store: makeStore(harness.layer) };
}

async function incidents(layer: AsyncDataLayer) {
  // FNXC:PostgresCutover 2026-07-16-06:30: inspect seeded connector rows via
  // the project schema instead of the removed synchronous SQLite Database API.
  return await layer.db.execute(sql`SELECT grouping_key AS "groupingKey", source, severity, status, meta::text AS meta FROM project.incidents WHERE project_id = ${layer.projectId} ORDER BY id ASC`) as Array<{
    groupingKey: string;
    source: string | null;
    severity: string | null;
    status: string;
    meta: string | null;
  }>;
}

const SECRETS: Record<string, string> = {
  FUSION_SIGNAL_WEBHOOK_SECRET: "wh-secret",
  FUSION_SIGNAL_SENTRY_SECRET: "sentry-secret",
  FUSION_SIGNAL_DATADOG_SECRET: "datadog-secret",
  FUSION_SIGNAL_PAGERDUTY_SECRET: "pd-secret",
  FUSION_SIGNAL_GITLAB_SECRET: "gitlab-secret",
};

const savedEnv: Record<string, string | undefined> = {};
const harnesses: PgTestHarness[] = [];

beforeEach(() => {
  for (const [k, v] of Object.entries(SECRETS)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(async () => {
  for (const k of Object.keys(SECRETS)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  while (harnesses.length > 0) await harnesses.pop()?.teardown();
});

function ctxFor(source: SignalSource, payload: object, headers: Record<string, string>) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { rawBody, headers: lower, body: payload };
}

function signedSignalContext(source: SignalSource, payload: object) {
  const raw = JSON.stringify(payload);
  switch (source.provider) {
    case "webhook":
      return ctxFor(source, payload, {
        "x-fusion-signature": sign(raw, SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
        "x-fusion-timestamp": String(Date.now()),
      });
    case "sentry":
      return ctxFor(source, payload, { "sentry-hook-signature": sign(raw, SECRETS.FUSION_SIGNAL_SENTRY_SECRET) });
    case "datadog":
      return ctxFor(source, payload, { "x-datadog-signature": sign(raw, SECRETS.FUSION_SIGNAL_DATADOG_SECRET) });
    case "pagerduty":
      return ctxFor(source, payload, { "x-pagerduty-signature": `v1=${sign(raw, SECRETS.FUSION_SIGNAL_PAGERDUTY_SECRET)}` });
    case "gitlab":
      return ctxFor(source, payload, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET });
  }
}

pgDescribe("getSignalSource registry", () => {
  it("resolves all five providers and rejects unknown", () => {
    expect(getSignalSource("webhook")).toBe(webhookSource);
    expect(getSignalSource("sentry")).toBe(sentrySource);
    expect(getSignalSource("datadog")).toBe(datadogSource);
    expect(getSignalSource("pagerduty")).toBe(pagerdutySource);
    expect(getSignalSource("gitlab")).toBe(gitlabSource);
    expect(getSignalSource("bogus")).toBeUndefined();
  });
});

pgDescribe("ingestSignal — generic webhook (must-work path)", () => {
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

pgDescribe("ingestSignal — Sentry adapter", () => {
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

pgDescribe("ingestSignal — Datadog & PagerDuty adapters (groupingKey from native primitive)", () => {
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

function gitlabIssuePayload(overrides: Record<string, unknown> = {}) {
  const { object_attributes: objectAttributeOverrides, ...topLevelOverrides } = overrides;
  const object_attributes = {
    id: 301,
    iid: 23,
    title: "New API: create/update/delete file",
    description: "Create new API for repository file edits",
    state: "opened",
    action: "open",
    severity: "high",
    url: "https://gitlab.example.com/gitlabhq/gitlab-test/-/issues/23",
    updated_at: new Date().toISOString(),
    ...(asRecord(objectAttributeOverrides)),
  };
  return {
    object_kind: "issue",
    event_type: "issue",
    user: { username: "root" },
    project: {
      id: 14,
      name: "Gitlab Test",
      path_with_namespace: "gitlabhq/gitlab-test",
      web_url: "https://gitlab.example.com/gitlabhq/gitlab-test",
    },
    object_attributes,
    ...topLevelOverrides,
  };
}

function gitlabMergeRequestPayload(overrides: Record<string, unknown> = {}) {
  const { object_attributes: objectAttributeOverrides, ...topLevelOverrides } = overrides;
  const object_attributes = {
    id: 701,
    iid: 7,
    title: "Improve alerts",
    description: "MR description",
    state: "opened",
    action: "open",
    url: "https://gitlab.com/acme/ops/-/merge_requests/7",
    updated_at: new Date().toISOString(),
    ...(asRecord(objectAttributeOverrides)),
  };
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    project: {
      id: 99,
      name: "ops",
      path_with_namespace: "acme/ops",
      web_url: "https://gitlab.com/acme/ops",
    },
    object_attributes,
    ...topLevelOverrides,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

pgDescribe("ingestSignal — GitLab adapter", () => {
  it("creates a triage task for a valid project issue webhook from a self-managed URL", async () => {
    const store = makeStore();
    const payload = gitlabIssuePayload();
    const res = await ingestSignal({
      source: gitlabSource,
      store,
      ...ctxFor(gitlabSource, payload, {
        "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET,
        "x-gitlab-event": "Issue Hook",
        "x-gitlab-event-uuid": "gl-delivery-issue-open",
      }),
      nonceCache: new DeliveryNonceCache(),
    });

    expect(res.status).toBe(201);
    expect(store._tasks).toHaveLength(1);
    expect(store._tasks[0].title).toBe("GitLab issue #23: New API: create/update/delete file");
    expect(store._tasks[0].description).toContain("https://gitlab.example.com/gitlabhq/gitlab-test/-/issues/23");
    const meta = store._tasks[0].source?.sourceMetadata as Record<string, unknown>;
    expect(meta.signalSource).toBe("gitlab");
    expect(meta.signalDeliveryId).toBe("delivery:gl-delivery-issue-open");
    expect(meta.signalGroupingKey).toBe("gitlab:gitlabhq/gitlab-test:issue:23");
    expect(meta.signalSeverity).toBe("error");
  });

  it("normalizes group issue hooks and GitLab.com merge request hooks", async () => {
    const issue = gitlabIssuePayload({
      project: undefined,
      group: { id: 5, name: "Platform", full_path: "platform" },
      object_attributes: { iid: 44, title: "Group issue", action: "reopen", state: "opened", url: "https://gitlab.example.net/groups/platform/-/work_items/44" },
    });
    const mr = gitlabMergeRequestPayload({ object_attributes: { action: "merge", state: "merged" } });

    const issueSignal = gitlabSource.normalize(issue, ctxFor(gitlabSource, issue, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET }));
    const mrSignal = gitlabSource.normalize(mr, ctxFor(gitlabSource, mr, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET }));

    expect(issueSignal).toMatchObject({
      source: "gitlab",
      groupingKey: "gitlab:platform:issue:44",
      resolution: "open",
      link: "https://gitlab.example.net/groups/platform/-/work_items/44",
    });
    expect(mrSignal).toMatchObject({
      source: "gitlab",
      groupingKey: "gitlab:acme/ops:merge_request:7",
      resolution: "resolved",
      link: "https://gitlab.com/acme/ops/-/merge_requests/7",
    });
  });

  it("maps issue and merge-request lifecycle actions without suppressing recovery events", async () => {
    const { layer, store } = await makeDbStore();
    const open = gitlabIssuePayload({ object_attributes: { action: "open", state: "opened", updated_at: "2026-03-04T00:00:00.000Z" } });
    const close = gitlabIssuePayload({ object_attributes: { action: "close", state: "closed", updated_at: "2026-03-04T00:05:00.000Z" } });

    expect((await ingestSignal({
      source: gitlabSource,
      store,
      ...ctxFor(gitlabSource, open, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET, "x-gitlab-event-uuid": "gl-issue-open" }),
      nonceCache: new DeliveryNonceCache(),
    })).status).toBe(201);
    expect((await ingestSignal({
      source: gitlabSource,
      store,
      ...ctxFor(gitlabSource, close, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET, "x-gitlab-event-uuid": "gl-issue-close" }),
      nonceCache: new DeliveryNonceCache(),
    })).status).toBe(201);

    expect(store._tasks).toHaveLength(2);
    expect(await incidents(layer)).toMatchObject([{ groupingKey: "gitlab:gitlabhq/gitlab-test:issue:23", source: "gitlab", status: "resolved" }]);
    const updateSignal = gitlabSource.normalize(gitlabIssuePayload({ object_attributes: { action: "update", state: "opened" } }), ctxFor(gitlabSource, open, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET }));
    const reopenSignal = gitlabSource.normalize(gitlabIssuePayload({ object_attributes: { action: "reopen", state: "opened" } }), ctxFor(gitlabSource, open, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET }));
    const mergedSignal = gitlabSource.normalize(gitlabMergeRequestPayload({ object_attributes: { action: "merge", state: "merged" } }), ctxFor(gitlabSource, open, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET }));
    expect(updateSignal?.resolution).toBe("open");
    expect(reopenSignal?.resolution).toBe("open");
    expect(mergedSignal?.resolution).toBe("resolved");
  });

  it("rejects missing secret, missing token, and invalid token without creating tasks", async () => {
    const payload = gitlabIssuePayload();
    const rawBody = Buffer.from(JSON.stringify(payload));
    const body = payload;

    delete process.env.FUSION_SIGNAL_GITLAB_SECRET;
    const missingSecretStore = makeStore();
    expect((await ingestSignal({ source: gitlabSource, store: missingSecretStore, rawBody, headers: { "x-gitlab-token": "x" }, body, nonceCache: new DeliveryNonceCache() })).status).toBe(401);
    process.env.FUSION_SIGNAL_GITLAB_SECRET = SECRETS.FUSION_SIGNAL_GITLAB_SECRET;

    const missingTokenStore = makeStore();
    expect((await ingestSignal({ source: gitlabSource, store: missingTokenStore, rawBody, headers: {}, body, nonceCache: new DeliveryNonceCache() })).status).toBe(401);
    const invalidTokenStore = makeStore();
    expect((await ingestSignal({ source: gitlabSource, store: invalidTokenStore, rawBody, headers: { "x-gitlab-token": "wrong" }, body, nonceCache: new DeliveryNonceCache() })).status).toBe(401);
    expect(missingSecretStore._tasks).toHaveLength(0);
    expect(missingTokenStore._tasks).toHaveLength(0);
    expect(invalidTokenStore._tasks).toHaveLength(0);
  });

  it("accepts unsupported GitLab ping events as non-actionable and rejects malformed actionable payloads", async () => {
    const pingStore = makeStore();
    const ping = { object_kind: "push", event_name: "push" };
    expect((await ingestSignal({
      source: gitlabSource,
      store: pingStore,
      ...ctxFor(gitlabSource, ping, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET, "x-gitlab-event": "Push Hook" }),
      nonceCache: new DeliveryNonceCache(),
    })).status).toBe(200);
    expect(pingStore._tasks).toHaveLength(0);

    const malformedStore = makeStore();
    const malformed = { object_kind: "issue", object_attributes: { title: "Missing IID" } };
    expect((await ingestSignal({
      source: gitlabSource,
      store: malformedStore,
      ...ctxFor(gitlabSource, malformed, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET, "x-gitlab-event": "Issue Hook" }),
      nonceCache: new DeliveryNonceCache(),
    })).status).toBe(400);
    expect(malformedStore._tasks).toHaveLength(0);
  });

  it("drops unsafe links, applies field caps, and keeps fallback external ids action-distinct", () => {
    const longTitle = "x".repeat(400);
    const payload = gitlabIssuePayload({
      project: { id: 10, path_with_namespace: "internal/project", web_url: "https://gitlab.example.com/internal/project" },
      object_attributes: {
        iid: 88,
        title: longTitle,
        description: "y".repeat(9000),
        action: "close",
        state: "closed",
        url: "http://127.0.0.1/internal",
        updated_at: "2026-03-04T00:05:00.000Z",
      },
    });
    const signal = gitlabSource.normalize(payload, ctxFor(gitlabSource, payload, { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET }));
    expect(signal?.title.length).toBeLessThanOrEqual(300);
    expect(signal?.body?.length).toBeLessThanOrEqual(8000);
    expect(signal?.link).toBeUndefined();
    expect(signal?.externalId).toContain(":close:closed:");
  });
});

pgDescribe("ingestSignal — incident capture", () => {
  it("writes source and normalized severity for all configured providers", async () => {
    const cases = [
      {
        source: webhookSource,
        payload: { id: "wh-1", title: "Disk full", severity: "critical", groupingKey: "wh-group", timestamp: Date.now() },
        headers(raw: string) {
          return {
            "x-fusion-signature": sign(raw, SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
            "x-fusion-timestamp": String(Date.now()),
          };
        },
        expected: { source: "webhook", severity: "critical", groupingKey: "wh-group" },
      },
      {
        source: sentrySource,
        payload: { data: { issue: { id: "sentry-1", title: "Fatal", level: "fatal" } }, timestamp: Date.now() },
        headers(raw: string) {
          return { "sentry-hook-signature": sign(raw, SECRETS.FUSION_SIGNAL_SENTRY_SECRET) };
        },
        expected: { source: "sentry", severity: "critical", groupingKey: "sentry-1" },
      },
      {
        source: datadogSource,
        payload: { aggreg_key: "dd-1", event_id: "dd-event-1", title: "Warn", alert_type: "warning" },
        headers(raw: string) {
          return { "x-datadog-signature": sign(raw, SECRETS.FUSION_SIGNAL_DATADOG_SECRET) };
        },
        expected: { source: "datadog", severity: "warning", groupingKey: "dd-1" },
      },
      {
        source: pagerdutySource,
        payload: {
          event: {
            id: "pd-event-1",
            event_type: "incident.triggered",
            occurred_at: new Date().toISOString(),
            data: { id: "pd-1", title: "Pager", urgency: "high", status: "triggered" },
          },
        },
        headers(raw: string) {
          return { "x-pagerduty-signature": `v1=${sign(raw, SECRETS.FUSION_SIGNAL_PAGERDUTY_SECRET)}` };
        },
        expected: { source: "pagerduty", severity: "critical", groupingKey: "pd-1" },
      },
      {
        source: gitlabSource,
        payload: gitlabIssuePayload({ object_attributes: { iid: 77, title: "GitLab incident", severity: "critical" } }),
        headers() {
          return { "x-gitlab-token": SECRETS.FUSION_SIGNAL_GITLAB_SECRET, "x-gitlab-event-uuid": "gl-incident-capture" };
        },
        expected: { source: "gitlab", severity: "critical", groupingKey: "gitlab:gitlabhq/gitlab-test:issue:77" },
      },
    ] as const;

    for (const c of cases) {
      const { layer, store } = await makeDbStore();
      const raw = JSON.stringify(c.payload);
      const res = await ingestSignal({
        source: c.source,
        store,
        rawBody: Buffer.from(raw),
        headers: Object.fromEntries(Object.entries(c.headers(raw)).map(([k, v]) => [k.toLowerCase(), v])),
        body: c.payload,
        nonceCache: new DeliveryNonceCache(),
      });
      expect(res.status).toBe(201);
      expect(await incidents(layer)).toMatchObject([{
        groupingKey: c.expected.groupingKey,
        source: c.expected.source,
        severity: c.expected.severity,
        status: "open",
      }]);
    }
  });

  it("absorbs re-fires by grouping key without inserting duplicate incident rows", async () => {
    const { layer, store } = await makeDbStore();
    const mk = (id: string) => {
      const payload = { id, title: "Same outage", severity: "error", groupingKey: "same-outage" };
      const raw = JSON.stringify(payload);
      return {
        source: webhookSource,
        store,
        rawBody: Buffer.from(raw),
        headers: {
          "x-fusion-signature": sign(raw, SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
          "x-fusion-timestamp": String(Date.now()),
        },
        body: payload,
        nonceCache: new DeliveryNonceCache(),
      };
    };

    expect((await ingestSignal(mk("refire-1"))).status).toBe(201);
    expect((await ingestSignal(mk("refire-2"))).status).toBe(201);

    const rows = await incidents(layer);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].meta ?? "{}")).toMatchObject({ occurrences: 2 });
  });

  it("marks resolution events as resolved for every provider", async () => {
    const now = Date.now();
    const cases = [
      {
        source: webhookSource,
        groupingKey: "wh-resolve",
        openPayload: { id: "wh-open", title: "Webhook outage", severity: "critical", groupingKey: "wh-resolve", timestamp: now },
        resolvePayload: { id: "wh-resolved", title: "Webhook recovered", severity: "critical", groupingKey: "wh-resolve", timestamp: now, status: "resolved" },
        expectedSource: "webhook",
      },
      {
        source: sentrySource,
        groupingKey: "sentry-resolve",
        openPayload: {
          id: "sentry-delivery-open",
          action: "created",
          data: { issue: { id: "sentry-resolve", title: "Sentry outage", level: "fatal" } },
          timestamp: now,
        },
        resolvePayload: {
          id: "sentry-delivery-resolved",
          action: "resolved",
          data: { issue: { id: "sentry-resolve", title: "Sentry recovered", level: "fatal", status: "resolved" } },
          timestamp: now + 1,
        },
        expectedSource: "sentry",
      },
      {
        source: datadogSource,
        groupingKey: "dd-resolve",
        openPayload: { aggreg_key: "dd-resolve", event_id: "dd-open", title: "CPU high", alert_type: "error" },
        resolvePayload: { aggreg_key: "dd-resolve", event_id: "dd-resolved", title: "CPU recovered", alert_type: "recovery" },
        expectedSource: "datadog",
      },
      {
        source: pagerdutySource,
        groupingKey: "pd-resolve",
        openPayload: {
          event: {
            id: "pd-open",
            event_type: "incident.triggered",
            occurred_at: new Date(now).toISOString(),
            data: { id: "pd-resolve", title: "PagerDuty outage", urgency: "high", status: "triggered" },
          },
        },
        resolvePayload: {
          event: {
            id: "pd-resolved",
            event_type: "incident.resolved",
            occurred_at: new Date(now + 1_000).toISOString(),
            data: { id: "pd-resolve", title: "PagerDuty recovered", urgency: "high", status: "resolved" },
          },
        },
        expectedSource: "pagerduty",
      },
      {
        source: gitlabSource,
        groupingKey: "gitlab:gitlabhq/gitlab-test:issue:23",
        openPayload: gitlabIssuePayload({ object_attributes: { action: "open", state: "opened", updated_at: new Date(now).toISOString() } }),
        resolvePayload: gitlabIssuePayload({ object_attributes: { action: "close", state: "closed", updated_at: new Date(now + 1_000).toISOString() } }),
        expectedSource: "gitlab",
      },
    ] as const;

    for (const c of cases) {
      const { layer, store } = await makeDbStore();
      expect((await ingestSignal({
        source: c.source,
        store,
        ...signedSignalContext(c.source, c.openPayload),
        nonceCache: new DeliveryNonceCache(),
      })).status).toBe(201);
      expect((await ingestSignal({
        source: c.source,
        store,
        ...signedSignalContext(c.source, c.resolvePayload),
        nonceCache: new DeliveryNonceCache(),
      })).status).toBe(201);

      expect(await incidents(layer)).toMatchObject([{ groupingKey: c.groupingKey, source: c.expectedSource, status: "resolved" }]);
    }
  });

  it("also resolves PagerDuty incidents when only data.status is resolved", async () => {
    const { layer, store } = await makeDbStore();
    const openedAt = new Date().toISOString();
    const openPayload = {
      event: {
        id: "pd-status-open",
        event_type: "incident.triggered",
        occurred_at: openedAt,
        data: { id: "pd-status-resolve", title: "PagerDuty status path", urgency: "high", status: "triggered" },
      },
    };
    const resolvePayload = {
      event: {
        id: "pd-status-resolved",
        event_type: "incident.annotated",
        occurred_at: new Date(Date.parse(openedAt) + 1_000).toISOString(),
        data: { id: "pd-status-resolve", title: "PagerDuty status recovered", urgency: "high", status: "resolved" },
      },
    };

    expect((await ingestSignal({
      source: pagerdutySource,
      store,
      ...signedSignalContext(pagerdutySource, openPayload),
      nonceCache: new DeliveryNonceCache(),
    })).status).toBe(201);
    expect((await ingestSignal({
      source: pagerdutySource,
      store,
      ...signedSignalContext(pagerdutySource, resolvePayload),
      nonceCache: new DeliveryNonceCache(),
    })).status).toBe(201);

    expect(await incidents(layer)).toMatchObject([{ groupingKey: "pd-status-resolve", source: "pagerduty", status: "resolved" }]);
  });

  it("keeps connector acceptance successful when the best-effort incident write fails", async () => {
    const store = makeStore();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const payload = { id: "incident-db-failure", title: "Accepted signal", groupingKey: "incident-db-failure" };

    const res = await ingestSignal({
      source: webhookSource,
      store,
      ...signedSignalContext(webhookSource, payload),
      nonceCache: new DeliveryNonceCache(),
    });

    expect(res.status).toBe(201);
    expect(res.taskId).toBe("FN-1");
    expect(store._tasks).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      "[signal-incident-bridge] Failed to record connector signal",
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("feeds connector-recorded incidents into aggregateSignalsAnalytics breakdowns", async () => {
    const { layer, store } = await makeDbStore();
    const sentryPayload = {
      id: "sentry-analytics-open",
      data: { issue: { id: "sentry-analytics", title: "Sentry analytics", level: "fatal" } },
      timestamp: Date.parse("2026-03-04T00:00:00.000Z"),
    };
    const datadogPayload = {
      aggreg_key: "datadog-analytics",
      event_id: "datadog-analytics-open",
      title: "Datadog analytics",
      alert_type: "warning",
      date: Date.parse("2026-03-04T00:05:00.000Z"),
    };

    expect((await ingestSignal({
      source: sentrySource,
      store,
      ...signedSignalContext(sentrySource, sentryPayload),
      nonceCache: new DeliveryNonceCache(),
    })).status).toBe(201);
    expect((await ingestSignal({
      source: datadogSource,
      store,
      ...signedSignalContext(datadogSource, datadogPayload),
      nonceCache: new DeliveryNonceCache(),
    })).status).toBe(201);

    const analytics = await aggregateSignalsAnalytics(layer, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
    });
    expect(analytics.totalSignals).toBe(2);
    expect(analytics.bySource).toEqual(expect.arrayContaining([
      { source: "sentry", count: 1 },
      { source: "datadog", count: 1 },
    ]));
    expect(analytics.bySeverity).toEqual(expect.arrayContaining([
      { severity: "critical", count: 1 },
      { severity: "warning", count: 1 },
    ]));
    expect(analytics.byStatus).toEqual([{ status: "open", count: 2 }]);
  });

  it("does not write incidents for malformed or duplicate payloads", async () => {
    const { layer, store } = await makeDbStore();
    const malformed = { nope: true };
    const malformedRaw = JSON.stringify(malformed);
    expect((await ingestSignal({
      source: webhookSource,
      store,
      rawBody: Buffer.from(malformedRaw),
      headers: {
        "x-fusion-signature": sign(malformedRaw, SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
        "x-fusion-timestamp": String(Date.now()),
      },
      body: malformed,
      nonceCache: new DeliveryNonceCache(),
    })).status).toBe(400);

    const payload = { id: "dup-incident", title: "Duplicate", groupingKey: "dup-group" };
    const raw = JSON.stringify(payload);
    const mk = () => ({
      source: webhookSource,
      store,
      rawBody: Buffer.from(raw),
      headers: {
        "x-fusion-signature": sign(raw, SECRETS.FUSION_SIGNAL_WEBHOOK_SECRET),
        "x-fusion-timestamp": String(Date.now()),
      },
      body: payload,
      nonceCache: new DeliveryNonceCache(),
    });
    expect((await ingestSignal(mk())).status).toBe(201);
    expect((await ingestSignal(mk())).deduped).toBe(true);

    expect(await incidents(layer)).toHaveLength(1);
  });
});

pgDescribe("helpers", () => {
  it("resolveSignalSecret reads the provider env var", () => {
    expect(resolveSignalSecret(webhookSource)).toBe("wh-secret");
    expect(resolveSignalSecret(webhookSource, {})).toBeUndefined();
  });

  it("resolveConfiguredSignalProviders reports providers with configured secrets", () => {
    expect(resolveConfiguredSignalProviders({
      FUSION_SIGNAL_WEBHOOK_SECRET: "wh",
      FUSION_SIGNAL_PAGERDUTY_SECRET: "pd",
      FUSION_SIGNAL_GITLAB_SECRET: "gl",
    })).toEqual(["webhook", "pagerduty", "gitlab"]);
  });

  it("signalToTaskInput omits column so the store resolves the default-workflow intake (triage)", () => {
    const input = signalToTaskInput({
      source: "webhook",
      externalId: "e",
      groupingKey: "g",
      title: "t",
      severity: "critical",
    });
    expect(input.column).toBeUndefined();
    expect(input.priority).toBe("high");
    expect(input.source?.sourceType).toBe("api");
  });
});
