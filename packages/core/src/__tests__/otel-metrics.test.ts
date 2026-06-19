import { describe, it, expect } from "vitest";

import { mapAnalyticsToOtlp, OTEL_METRIC_PREFIX } from "../otel-metrics.js";
import type { TokenAnalytics } from "../token-analytics.js";
import type { ActivityAnalytics } from "../activity-analytics.js";

const TIME_NANO = "1700000000000000000";

function tokenFixture(): TokenAnalytics {
  return {
    from: null,
    to: null,
    groupBy: "model",
    totals: {
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      cacheWriteTokens: 50,
      totalTokens: 1750,
      nTasks: 3,
    },
    cost: { usd: 12.34, unavailable: false, stale: false },
    groups: [
      {
        key: "claude-opus-4-8",
        inputTokens: 600,
        outputTokens: 300,
        cachedTokens: 100,
        cacheWriteTokens: 25,
        totalTokens: 1025,
        nTasks: 2,
        cost: { usd: 9.0, unavailable: false, stale: false },
      },
      {
        key: "gpt-5",
        inputTokens: 400,
        outputTokens: 200,
        cachedTokens: 100,
        cacheWriteTokens: 25,
        totalTokens: 725,
        nTasks: 1,
        // Unpriced group → cost must be omitted, not reported as $0.
        cost: { usd: null, unavailable: true, stale: false },
      },
    ],
  };
}

function activityFixture(): ActivityAnalytics {
  // Focused fixture: the OTLP mapping only reads the activity gauge fields below,
  // so funnel/monitor (U7/U13 additions) are intentionally omitted via the cast.
  return {
    from: null,
    to: null,
    sessions: 7,
    messages: 42,
    activeNodes: 3,
    activeAgents: 5,
    daily: [],
    stickiness: 0.6,
    mttr: { value: null, unavailable: true, sampleCount: 0 },
  } as unknown as ActivityAnalytics;
}

function findMetric(payload: ReturnType<typeof mapAnalyticsToOtlp>, name: string) {
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
  const m = metrics.find((x) => x.name === name);
  expect(m, `metric ${name} present`).toBeDefined();
  return m!;
}

describe("mapAnalyticsToOtlp", () => {
  it("maps token totals to a monotonic Sum counter with a grand-total point", () => {
    const payload = mapAnalyticsToOtlp({
      tokens: tokenFixture(),
      activity: activityFixture(),
      timeUnixNano: TIME_NANO,
    });
    const total = findMetric(payload, `${OTEL_METRIC_PREFIX}.tokens.total`);
    expect(total.sum?.isMonotonic).toBe(true);
    expect(total.sum?.aggregationTemporality).toBe(2);
    // Grand total point (no attributes) carries the totals value.
    const grand = total.sum?.dataPoints.find((p) => p.attributes.length === 0);
    expect(grand?.asInt).toBe("1750");
  });

  it("emits one attributed data point per group (model/provider/node/agent)", () => {
    const payload = mapAnalyticsToOtlp({
      tokens: tokenFixture(),
      activity: activityFixture(),
      timeUnixNano: TIME_NANO,
    });
    const input = findMetric(payload, `${OTEL_METRIC_PREFIX}.tokens.input`);
    const modelPoints = input.sum!.dataPoints.filter((p) =>
      p.attributes.some((a) => a.key === "model"),
    );
    const models = modelPoints
      .map((p) => p.attributes.find((a) => a.key === "model")!.value.stringValue)
      .sort();
    expect(models).toEqual(["claude-opus-4-8", "gpt-5"]);
    const opus = modelPoints.find(
      (p) =>
        p.attributes.find((a) => a.key === "model")!.value.stringValue ===
        "claude-opus-4-8",
    );
    expect(opus?.asInt).toBe("600");
  });

  it("uses provider/node/agent attribute keys per groupBy", () => {
    const base = tokenFixture();
    for (const [groupBy, attrKey] of [
      ["provider", "provider"],
      ["node", "node.id"],
      ["agent", "agent.id"],
    ] as const) {
      const payload = mapAnalyticsToOtlp({
        tokens: { ...base, groupBy, groups: [{ ...base.groups[0], key: "k" }] },
        activity: activityFixture(),
        timeUnixNano: TIME_NANO,
      });
      const input = findMetric(payload, `${OTEL_METRIC_PREFIX}.tokens.input`);
      const attributed = input.sum!.dataPoints.find((p) => p.attributes.length > 0);
      expect(attributed?.attributes[0].key).toBe(attrKey);
    }
  });

  it("omits cost data points for unpriced groups (never reports $0)", () => {
    const payload = mapAnalyticsToOtlp({
      tokens: tokenFixture(),
      activity: activityFixture(),
      timeUnixNano: TIME_NANO,
    });
    const cost = findMetric(payload, `${OTEL_METRIC_PREFIX}.cost.usd`);
    // Grand total (12.34) + opus (9.0); gpt-5 (null) omitted ⇒ 2 points.
    expect(cost.sum?.dataPoints.length).toBe(2);
    const grand = cost.sum?.dataPoints.find((p) => p.attributes.length === 0);
    expect(grand?.asDouble).toBeCloseTo(12.34, 5);
    const hasGpt5 = cost.sum?.dataPoints.some((p) =>
      p.attributes.some((a) => a.value.stringValue === "gpt-5"),
    );
    expect(hasGpt5).toBe(false);
  });

  it("maps activity to gauges (active nodes/agents/sessions/messages/stickiness)", () => {
    const payload = mapAnalyticsToOtlp({
      tokens: tokenFixture(),
      activity: activityFixture(),
      timeUnixNano: TIME_NANO,
    });
    expect(
      findMetric(payload, `${OTEL_METRIC_PREFIX}.activity.active_nodes`).gauge
        ?.dataPoints[0].asInt,
    ).toBe("3");
    expect(
      findMetric(payload, `${OTEL_METRIC_PREFIX}.activity.active_agents`).gauge
        ?.dataPoints[0].asInt,
    ).toBe("5");
    expect(
      findMetric(payload, `${OTEL_METRIC_PREFIX}.activity.sessions`).gauge
        ?.dataPoints[0].asInt,
    ).toBe("7");
    expect(
      findMetric(payload, `${OTEL_METRIC_PREFIX}.activity.messages`).gauge
        ?.dataPoints[0].asInt,
    ).toBe("42");
    expect(
      findMetric(payload, `${OTEL_METRIC_PREFIX}.activity.stickiness`).gauge
        ?.dataPoints[0].asDouble,
    ).toBeCloseTo(0.6, 5);
  });

  it("applies resource attributes and a default service.name", () => {
    const dflt = mapAnalyticsToOtlp({
      tokens: tokenFixture(),
      activity: activityFixture(),
      timeUnixNano: TIME_NANO,
    });
    const defaultAttrs = dflt.resourceMetrics[0].resource.attributes;
    expect(
      defaultAttrs.find((a) => a.key === "service.name")?.value.stringValue,
    ).toBe("fusion-dashboard");

    const custom = mapAnalyticsToOtlp({
      tokens: tokenFixture(),
      activity: activityFixture(),
      timeUnixNano: TIME_NANO,
      resourceAttributes: { "service.name": "my-svc", env: "staging" },
    });
    const attrs = custom.resourceMetrics[0].resource.attributes;
    expect(attrs.find((a) => a.key === "env")?.value.stringValue).toBe("staging");
  });

  it("coerces non-finite / negative counts to 0 (no NaN on the wire)", () => {
    const bad = tokenFixture();
    bad.totals.inputTokens = Number.NaN;
    bad.totals.outputTokens = -5;
    const payload = mapAnalyticsToOtlp({
      tokens: bad,
      activity: activityFixture(),
      timeUnixNano: TIME_NANO,
    });
    const input = findMetric(payload, `${OTEL_METRIC_PREFIX}.tokens.input`);
    const grand = input.sum!.dataPoints.find((p) => p.attributes.length === 0);
    expect(grand?.asInt).toBe("0");
    const output = findMetric(payload, `${OTEL_METRIC_PREFIX}.tokens.output`);
    const grandOut = output.sum!.dataPoints.find((p) => p.attributes.length === 0);
    expect(grandOut?.asInt).toBe("0");
  });
});
