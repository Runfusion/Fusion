/**
 * Pure Prometheus text exposition serializer for the dashboard `/metrics`
 * endpoint (RUFU-081).
 *
 * This module has ZERO side effects and never reads the clock, the network, or
 * the environment. Callers pass an explicit snapshot (a list of metric
 * families) and get back a deterministic, scrapable Prometheus text body.
 *
 * Why direct text serialization instead of `prom-client` or a conversion from
 * the OTLP wire shape:
 * - A `/metrics` scrape is a plain `curl`/Prometheus scrape; the endpoint IS
 *   the surface. No new third-party metric library is added.
 * - The OTLP mapping (`packages/core/src/process/otel-metrics.ts`) produces
 *   the collector wire shape ({@link OtlpExportPayload}); this module reuses
 *   only its gauge/counter *semantics* (point-in-time gauges vs monotonic
 *   counters), not its wire envelope.
 *
 * Invariants enforced here:
 * - Output is deterministic (stable family + line order) so a diff of two
 *   scrapes only shows real changes.
 * - Bad values never crash a scrape: non-finite / non-numeric values are
 *   coerced to `0` (documented choice) so one NaN cannot take down the whole
 *   body.
 * - Label values are escaped per the exposition format (`\\`, `\"`, `\n`, `\`).
 * - Invalid metric/label names are sanitized to the permitted character set
 *   rather than rejected, so a ragged runtime value never sabotages the body.
 */

/** A single value or label-keyed value line for a metric family. */
export interface MetricSample {
  /** Serialize values stably by sorting on this key first when present. */
  labelValues?: string[];
  /** The numeric value; non-finite/non-numeric is coerced to 0. */
  value: number;
}

/** A Prometheus metric family (one HELP/TYPE pair plus sample lines). */
export interface MetricFamily {
  /** Prometheus metric name. Sanitized on serialize if invalid. */
  name: string;
  /** Human-readable HELP text (never reproduced in the run-audit). */
  help?: string;
  /** `gauge` (point-in-time) or `counter` (monotonic) semantics. */
  type: "gauge" | "counter";
  /**
   * Label names shared by every sample line in the family. Provide
   * `labels` AND per-sample `labelValues` (same cardinality) for a labeled
   * family; omit both for a scalar family.
   */
  labels?: string[];
  /** One line per sample. For a labeled family each entry contributes one label set. */
  samples: MetricSample[];
}

/** A full scrape snapshot assembled from pre-read gauge state. */
export interface MetricsSnapshot {
  families: MetricFamily[];
}

/** Permitted Prometheus metric-name characters: `[a-zA-Z_:][a-zA-Z0-9_:]*`. */
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
/** Permitted Prometheus label-name characters: `[a-zA-Z_][a-zA-Z0-9_]*`. */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** A trailing run of forbidden characters, used to sanitize metric names. */
const INVALID_METRIC_CHARS_RE = /[^a-zA-Z0-9_:]/g;
const INVALID_LABEL_CHARS_RE = /[^a-zA-Z0-9_]/g;

/**
 * Coerce a value to a finite number, defaulting to `0`. NaN, Infinity,
 * undefined, null, and strings that don't parse numerically all become `0` so
 * a single bad sample can never abort the whole exposition body.
 */
function coerceValue(value: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Sanitize a metric name to the permitted character set. Colons are reserved
 * for recording rules / client libraries and are preserved here because the
 * sampler chooses valid names at the call site; the sanitizer only strips
 * characters the exposition format forbids so a ragged runtime string can
 * never produce an unparseable body.
 */
export function sanitizeMetricName(name: string): string {
  const cleaned = String(name).replace(INVALID_METRIC_CHARS_RE, "_");
  return METRIC_NAME_RE.test(cleaned) ? cleaned : `_${cleaned}`;
}

/**
 * Sanitize a label name. Same contract as {@link sanitizeMetricName} but for
 * the narrower label-name character set (no colon).
 */
export function sanitizeLabelName(name: string): string {
  const cleaned = String(name).replace(INVALID_LABEL_CHARS_RE, "_");
  return LABEL_NAME_RE.test(cleaned) ? cleaned : `_${cleaned}`;
}

/**
 * Escape a label value per the Prometheus text exposition format: `\` ->
 * `\\`, `"` -> `\"`, and newline -> `\n`. All other bytes pass through.
 */
export function escapeLabelValue(value: string): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/**
 * Render a single label set `{name="value",other="value"}` (the leading brace
 * inclusive). Returns an empty string for a scalar (no-labels) family.
 */
function renderLabelSet(labels: string[], labelValues: string[]): string {
  if (labels.length === 0) return "";
  const parts = labels.map((rawName, index) => {
    const name = sanitizeLabelName(rawName);
    const rawValue = labelValues[index];
    const value = escapeLabelValue(rawValue === undefined ? "" : rawValue);
    return `${name}="${value}"`;
  });
  return `{${parts.join(",")}}`;
}

/**
 * Serialize a snapshot into a Prometheus text body.
 *
 * Ordering is deterministic: families are emitted in the order given (the
 * sampler owns the "meaningful order" contract — runtime first, domain
 * second), and within a labeled family samples are sorted by their joined
 * label values so scraping with `?sort=` stability is not required to diff
 * scrapes. Each family contributes exactly one `# HELP` and one `# TYPE` line
 * followed by its value lines.
 */
export function serializeMetrics(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  for (const family of snapshot.families) {
    const name = sanitizeMetricName(family.name);
    const help = family.help ?? `${name} measurement`;
    const type = family.type;

    // HELP/TYPE lines. HELP text is newline-escaped so a description with a
    // line break cannot inject a spurious line into the body.
    lines.push(`# HELP ${name} ${escapeLabelValue(help)}`);
    lines.push(`# TYPE ${name} ${type}`);

    if (family.labels && family.labels.length > 0) {
      const labeled = family.samples
        .map((sample) => ({ sample, key: (sample.labelValues ?? []).join("\u0000") }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      for (const { sample } of labeled) {
        const value = coerceValue(sample.value);
        lines.push(`${name}${renderLabelSet(family.labels, sample.labelValues ?? [])} ${value}`);
      }
    } else {
      for (const sample of family.samples) {
        const value = coerceValue(sample.value);
        lines.push(`${name} ${value}`);
      }
    }
  }

  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}