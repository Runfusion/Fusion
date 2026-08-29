// @vitest-environment node

import { describe, it, expect } from "vitest";
import {
  serializeMetrics,
  sanitizeMetricName,
  sanitizeLabelName,
  escapeLabelValue,
  type MetricFamily,
  type MetricsSnapshot,
} from "../prometheus-text.js";

/**
 * RUFU-081 Prometheus text serializer tests.
 *
 * Covers the pure serializer contract: scalar gauge, labeled multi-line
 * family, non-finite coercion, label-value escaping, invalid-name sanitization,
 * and stable HELP/TYPE + line ordering. Output must parse as a valid
 * Prometheus text body (starts with `# HELP`+`# TYPE` lines, then value lines).
 */

function sampleFamilies(families: MetricFamily[]): MetricsSnapshot {
  return { families };
}

function parseExpectValueLines(body: string): string[] {
  const lines = body.split("\n").filter((l) => l.length > 0);
  // Metadata lines start with `# `; a valid text body has no other comments.
  for (const line of lines) {
    expect(line.startsWith("# HELP ") || line.startsWith("# TYPE ") || !line.startsWith("#")).toBe(true);
  }
  const typeCount = lines.filter((l) => l.startsWith("# TYPE ")).length;
  const helpCount = lines.filter((l) => l.startsWith("# HELP ")).length;
  expect(typeCount).toBeGreaterThan(0);
  expect(helpCount).toBe(typeCount);
  return lines;
}

describe("serializeMetrics", () => {
  it("emits a scalar gauge with HELP/TYPE and a stable body", () => {
    const body = serializeMetrics(
      sampleFamilies([
        {
          name: "fusion_system_cpu_seconds_total",
          help: "Total user CPU seconds consumed by the server process",
          type: "counter",
          samples: [{ value: 12.5 }],
        },
      ]),
    );

    expect(body).toBe(
      ["# HELP fusion_system_cpu_seconds_total Total user CPU seconds consumed by the server process", "# TYPE fusion_system_cpu_seconds_total counter", "fusion_system_cpu_seconds_total 12.5", ""].join("\n"),
    );
    const lines = parseExpectValueLines(body);
    expect(lines).toContain("# TYPE fusion_system_cpu_seconds_total counter");
  });

  it("renders a labeled multi-line family with one line per label set", () => {
    const body = serializeMetrics(
      sampleFamilies([
        {
          name: "fusion_domain_tasks_total",
          type: "gauge",
          labels: ["column"],
          samples: [
            { labelValues: ["todo"], value: 3 },
            { labelValues: ["in-progress"], value: 1 },
            { labelValues: ["in-review"], value: 0 },
          ],
        },
      ]),
    );

    expect(body).toContain('fusion_domain_tasks_total{column="todo"} 3');
    expect(body).toContain('fusion_domain_tasks_total{column="in-progress"} 1');
    expect(body).toContain('fusion_domain_tasks_total{column="in-review"} 0');
    expect(parseExpectValueLines(body)).toContain("# TYPE fusion_domain_tasks_total gauge");
  });

  it("sorts labeled samples deterministically regardless of input order", () => {
    const makeBody = () =>
      serializeMetrics(
        sampleFamilies([
          {
            name: "fusion_test_labeled",
            type: "gauge",
            labels: ["col", "project"],
            samples: [
              { labelValues: ["b", "z"], value: 1 },
              { labelValues: ["a", "a"], value: 2 },
              { labelValues: ["a", "b"], value: 3 },
            ],
          },
        ]),
      );

    expect(makeBody()).toBe(makeBody());
    const lines = makeBody().split("\n").filter((l) => l.startsWith("fusion_test_labeled"));
    expect(lines).toEqual([
      'fusion_test_labeled{col="a",project="a"} 2',
      'fusion_test_labeled{col="a",project="b"} 3',
      'fusion_test_labeled{col="b",project="z"} 1',
    ]);
  });

  it("coerces non-finite and non-numeric values to 0 instead of crashing", () => {
    const body = serializeMetrics(
      sampleFamilies([
        {
          name: "fusion_system_last_request_age_ms",
          type: "gauge",
          samples: [{ value: Number.NaN }],
        },
        {
          name: "fusion_system_cpu_seconds_total",
          type: "counter",
          samples: [{ value: Number.POSITIVE_INFINITY }],
        },
      ]),
    );

    expect(body).toContain("fusion_system_last_request_age_ms 0");
    expect(body).toContain("fusion_system_cpu_seconds_total 0");
    // Both families emit, no throw, and a single bad value does not abort others.
    expect(parseExpectValueLines(body)).toHaveLength(6);
  });

  it("escapes special characters in label values", () => {
    const body = serializeMetrics(
      sampleFamilies([
        {
          name: "fusion_domain_agent_state",
          type: "gauge",
          labels: ["state"],
          samples: [{ labelValues: ['with"quote\\and\nnewline'], value: 1 }],
        },
      ]),
    );

    expect(body).toContain('fusion_domain_agent_state{state="with\\"quote\\\\and\\nnewline"} 1');
  });

  it("sanitizes invalid metric and label names instead of emitting broken lines", () => {
    const body = serializeMetrics(
      sampleFamilies([
        {
          name: "fusion_domain bad name",
          type: "gauge",
          labels: ["weird label!"],
          samples: [{ labelValues: ["x"], value: 5 }],
        },
      ]),
    );

    // The sanitized metric name is valid Prometheus.
    expect(body).toContain("# TYPE fusion_domain_bad_name gauge");
    expect(body).toContain('fusion_domain_bad_name{weird_label_="x"} 5');
    const lines = parseExpectValueLines(body);
    expect(lines.some((l) => l.startsWith("fusion_domain_bad_name"))).toBe(true);
  });

  it("handles an empty snapshot with a trailing newline only when non-empty", () => {
    expect(serializeMetrics({ families: [] })).toBe("");
  });

  it("omits label rendering for a scalar family and emits no braces", () => {
    const body = serializeMetrics(
      sampleFamilies([
        { name: "fusion_system_rss_bytes", type: "gauge", samples: [{ value: 1024 }] },
      ]),
    );
    expect(body).toContain("fusion_system_rss_bytes 1024");
    expect(body).not.toContain("{");
  });

  it("escapes newlines inside HELP text", () => {
    const body = serializeMetrics(
      sampleFamilies([
        { name: "fusion_test_help", type: "gauge", help: "line one\nline two", samples: [{ value: 1 }] },
      ]),
    );
    const helpLine = body.split("\n")[0];
    expect(helpLine).toBe("# HELP fusion_test_help line one\\nline two");
  });
});

describe("pure helpers", () => {
  it("sanitizeMetricName strips forbidden characters and guards a leading digit", () => {
    expect(sanitizeMetricName("fusion_system.rss")).toBe("fusion_system_rss");
    expect(sanitizeMetricName("9metric")).toBe("_9metric");
    expect(sanitizeMetricName("valid_name:ok")).toBe("valid_name:ok");
  });

  it("sanitizeLabelName strips colons and guards a leading digit", () => {
    expect(sanitizeLabelName("col:umn")).toBe("col_umn");
    expect(sanitizeLabelName("9label")).toBe("_9label");
    expect(sanitizeLabelName("column")).toBe("column");
  });

  it("escapeLabelValue handles backslash, quote, and newline", () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(escapeLabelValue("plain")).toBe("plain");
  });
});