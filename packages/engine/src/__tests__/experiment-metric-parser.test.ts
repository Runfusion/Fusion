import { describe, expect, it } from "vitest";

import {
  parseMetricLines,
  PROTOTYPE_POLLUTION_DENYLIST,
} from "../experiment/metric-parser.js";

describe("parseMetricLines", () => {
  it.each([
    ["METRIC accuracy=1", "accuracy", 1, undefined],
    ["METRIC loss=0.125", "loss", 0.125, undefined],
    ["METRIC score=1.2e-3", "score", 0.0012, undefined],
    ["METRIC delta=-42", "delta", -42, undefined],
    ["METRIC latency=123.4(ms)", "latency", 123.4, "ms"],
    ["METRIC speed=5.5 (req/s)", "speed", 5.5, "req/s"],
  ])(
    "parses valid metric line: %s",
    (line, name, value, unit) => {
      const parsed = parseMetricLines(line);
      expect(parsed.primary).toEqual({ name, value, unit });
      expect(parsed.secondary).toEqual([]);
      expect(parsed.warnings).toEqual([]);
    },
  );

  it.each([
    "METRIC bad=Infinity",
    "METRIC bad=NaN",
    "METRIC",
    "not a metric",
    "",
    "   ",
  ])("ignores malformed or invalid line: %s", (line) => {
    const parsed = parseMetricLines(line);
    expect(parsed.primary).toBeUndefined();
    expect(parsed.secondary).toEqual([]);
  });

  it("warns and drops denylisted metric names", () => {
    const denylisted = Array.from(PROTOTYPE_POLLUTION_DENYLIST);
    const parsed = parseMetricLines(
      denylisted.map((name) => `METRIC ${name}=1`).join("\n"),
    );

    expect(parsed.primary).toBeUndefined();
    expect(parsed.secondary).toEqual([]);
    expect(parsed.warnings).toHaveLength(denylisted.length);
    for (const name of denylisted) {
      expect(parsed.warnings.some((w) => w.includes(name))).toBe(true);
    }
  });

  it("keeps first valid metric as primary and last-write-wins on duplicates", () => {
    const parsed = parseMetricLines([
      "METRIC accuracy=0.8",
      "METRIC loss=0.3",
      "METRIC accuracy=0.9",
      "METRIC loss=0.1",
      "METRIC f1=0.7",
    ].join("\n"));

    expect(parsed.primary).toEqual({ name: "accuracy", value: 0.9, unit: undefined });
    expect(parsed.secondary).toEqual([
      { name: "loss", value: 0.1, unit: undefined },
      { name: "f1", value: 0.7, unit: undefined },
    ]);
  });

  it("warns for non-finite metric values", () => {
    const parsed = parseMetricLines("METRIC score=1\nMETRIC bad=Infinity");
    expect(parsed.primary).toEqual({ name: "score", value: 1, unit: undefined });
    expect(parsed.warnings).toEqual([
      "Ignored non-finite metric value for bad: Infinity",
    ]);
  });

  it("parses multiple metrics preserving first-seen name order", () => {
    const parsed = parseMetricLines([
      "METRIC a=1",
      "METRIC b=2",
      "METRIC c=3",
    ].join("\n"));

    expect(parsed.primary).toEqual({ name: "a", value: 1, unit: undefined });
    expect(parsed.secondary).toEqual([
      { name: "b", value: 2, unit: undefined },
      { name: "c", value: 3, unit: undefined },
    ]);
  });
});
