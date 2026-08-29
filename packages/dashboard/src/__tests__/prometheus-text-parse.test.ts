// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  assertExpositionText,
  ExpositionParseError,
  indexFamilies,
  parseExpositionText,
  requireFamily,
  sampleValueOf,
  unescapeLabelValue,
  type ParsedMetrics,
} from "./prometheus-text-parse.js";

/**
 * RUFU-082 parser unit cases.
 *
 * These guard the independent exposition-text grammar that the endpoint and
 * sampler acceptance suites rely on, so the parser itself is covered
 * first: a gauge family, a counter family with the `_total` suffix, a
 * HELP/TYPE header block, a NaN sample (RUFU-081 coerces non-finite values to 0,
 * but the grammar must still PARSE a literal NaN/Inf), a labeled multiline
 * family, scaling/escape handling, and a non-exposition-text rejection (the
 * original bug class — `GET /metrics` used to serve the SPA `index.html`).
 */

const GAUGE_BODY = [
  '# HELP fusion_test_gauge A test gauge',
  '# TYPE fusion_test_gauge gauge',
  'fusion_test_gauge 42',
  '',
].join("\n");

const COUNTER_TOTAL_BODY = [
  '# HELP fusion_test_events_total Count of events',
  '# TYPE fusion_test_events_total counter',
  'fusion_test_events_total 7',
  '',
].join("\n");

const NAN_BODY = [
  '# HELP fusion_test_nan A NaN-valued gauge',
  '# TYPE fusion_test_nan gauge',
  'fusion_test_nan NaN',
  '',
].join("\n");

const MULTILINE_BODY = [
  '# HELP fusion_test_by_status Labeled gauge',
  '# TYPE fusion_test_by_status gauge',
  'fusion_test_by_status{status="todo"} 3',
  'fusion_test_by_status{status="done"} 1',
  '',
].join("\n");

describe("parseExpositionText", () => {
  it("parses a scalar gauge family with its HELP/TYPE header and finite value", () => {
    const parsed = parseExpositionText(GAUGE_BODY);
    const family = requireFamily(parsed, "fusion_test_gauge");
    expect(family.type).toBe("gauge");
    expect(family.help).toBe("A test gauge");
    expect(family.samples).toHaveLength(1);
    expect(family.samples[0].value).toBe(42);
    expect(sampleValueOf(family)).toBe(42);
  });

  it("parses a counter family with the _total suffix convention", () => {
    const parsed = parseExpositionText(COUNTER_TOTAL_BODY);
    const family = requireFamily(parsed, "fusion_test_events_total");
    expect(family.type).toBe("counter");
    expect(family.samples[0].value).toBe(7);
  });

  it("parses a literal NaN value and preserves it (grammar-level)", () => {
    const parsed = parseExpositionText(NAN_BODY);
    const family = requireFamily(parsed, "fusion_test_nan");
    expect(Number.isNaN(family.samples[0].value)).toBe(true);
    expect(family.samples[0].valueText).toBe("NaN");
  });

  it("parses +Inf / -Inf tokens", () => {
    const body = [
      '# TYPE fusion_test_inf gauge',
      'fusion_test_pos_inf +Inf',
      'fusion_test_neg_inf -Inf',
      '',
    ].join("\n");
    const parsed = parseExpositionText(body);
    expect(requireFamily(parsed, "fusion_test_pos_inf").samples[0].value).toBe(Number.POSITIVE_INFINITY);
    expect(requireFamily(parsed, "fusion_test_neg_inf").samples[0].value).toBe(Number.NEGATIVE_INFINITY);
  });

  it("parses a labeled multiline family into per-label samples", () => {
    const parsed = parseExpositionText(MULTILINE_BODY);
    const family = requireFamily(parsed, "fusion_test_by_status");
    expect(family.samples).toHaveLength(2);
    const byStatus = Object.fromEntries(
      family.samples.map((s) => [s.labels[0]?.value, s.value]),
    );
    expect(byStatus).toEqual({ todo: 3, done: 1 });
  });

  it("treats HELP and TYPE as paired metadata blocks", () => {
    const parsed = parseExpositionText(["# HELP fusion_paired help text", "# TYPE fusion_paired gauge", "fusion_paired 1", ""].join("\n"));
    const family = requireFamily(parsed, "fusion_paired");
    expect(family.help).toBe("help text");
    expect(family.type).toBe("gauge");
    expect(family.samples[0].value).toBe(1);
  });

  it("handles an optional epoch-millis timestamp suffix", () => {
    const body = ["# TYPE fusion_test_ts gauge", "fusion_test_ts 5 1700000000123", ""].join("\n");
    const parsed = parseExpositionText(body);
    expect(requireFamily(parsed, "fusion_test_ts").samples[0].timestampMs).toBe(1700000000123);
  });

  it("ignores comment lines and blank lines", () => {
    const body = ["# a comment", "", "# HELP fusion_test_c # help", "# TYPE fusion_test_c gauge", "fusion_test_c 9", "# trailing comment", ""].join("\n");
    const parsed = parseExpositionText(body);
    const family = requireFamily(parsed, "fusion_test_c");
    expect(family.samples[0].value).toBe(9);
    expect(parsed.samples).toHaveLength(1);
  });

  it("escapes label values per the exposition rules", () => {
    const body = ['fusion_test_esc{label="a\\\"b\\\\c\\n"} 1', ""].join("\n");
    const parsed = parseExpositionText(body);
    const family = requireFamily(parsed, "fusion_test_esc");
    expect(family.samples[0].labels[0].value).toBe('a"b\\c\n');
  });

  it("rejects a body that is not exposition text (HTML fallback)", () => {
    const html = '<!doctype html><html><head><title>Fusion</title></head><body><div id="root"></div></body></html>';
    expect(() => assertExpositionText(html)).toThrow(ExpositionParseError);
  });

  it("rejects a sample with a malformed numeric value", () => {
    expect(() => parseExpositionText(["fusion_bad abc", ""].join("\n"))).toThrow(ExpositionParseError);
  });

  it("rejects an empty body", () => {
    expect(() => parseExpositionText("")).toThrow(ExpositionParseError);
  });

  it("parses CREATE test fixtures produced by the serializer (round-trip)", () => {
    // A body shaped like the endpoint's output: HELP + TYPE + value lines.
    const body = [
      '# HELP fusion_system_request_count_total Total HTTP requests served through the latency recorder',
      '# TYPE fusion_system_request_count_total counter',
      'fusion_system_request_count_total 0',
      '# HELP fusion_system_process_rss_bytes Resident set size of the server process',
      '# TYPE fusion_system_process_rss_bytes gauge',
      'fusion_system_process_rss_bytes 1048576',
      '',
    ].join("\n");
    const parsed: ParsedMetrics = assertExpositionText(body);
    const fam = indexFamilies(parsed);
    expect(fam.has("fusion_system_request_count_total")).toBe(true);
    expect(fam.has("fusion_system_process_rss_bytes")).toBe(true);
  });
});

describe("unescapeLabelValue", () => {
  it("decodes the three reserved escapes", () => {
    expect(unescapeLabelValue('a\\"b\\\\c\\n')).toBe('a"b\\c\n');
  });
  it("leaves an unknown escape verbatim", () => {
    expect(unescapeLabelValue("a\\z")).toBe("a\\z");
  });
});