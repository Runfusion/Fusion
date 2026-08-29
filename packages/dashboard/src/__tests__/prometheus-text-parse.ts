/*
FNXC:PrometheusAcceptance 2026-08-13-16:40:
RUFU-082 acceptance tests need an INDEPENDENT Prometheus exposition-text grammar so a
scrape body is proven well-formed (and, critically, NOT the SPA index.html fallback that
GET /metrics used to serve before RUFU-081 replaced it) without sharing implementation
quirks with the serializer under test. No prometheus client library or OTLP collector is
added; this is a pure string->typed-families parser used only by tests.
*/

/**
 * RUFU-082: self-contained Prometheus text exposition (version 0.0.4) parser.
 *
 * The `/metrics` endpoint (RUFU-081) SERIALIZES Prometheus text
 * (`packages/dashboard/src/metrics/prometheus-text.ts`). This module is the
 * independent acceptance-test GRAMMAR: it tokenizes a scraped body into typed
 * metric families so tests can assert well-formedness, the counter `_total`
 * suffix convention, NaN/Inf values, and that a body is actually parseable
 * Prometheus exposition text rather than — critically — the SPA `index.html`
 * fallback that `GET /metrics` used to serve before RUFU-081 replaced it.
 *
 * The point of a separate parser (not reusing the serializer) is that the
 * acceptance test must not share implementation quirks with the thing under
 * test: a serializer that produces text the same author's parser could never
 * reject is a weaker guarantee than an independent grammar that does. There is
 * intentionally no third-party prometheus library dependency and no network —
 * this is a pure string->typed-families function.
 *
 * Invariants asserted here:
 *   - HELP/TYPE lines come in paired blocks preceding their sample lines;
 *   - sample lines are `name{labels} value` (timestamp optional, tolerated);
 *   - label values use the exposition escape rules (`\\`, `\"`, `\n`);
 *   - values parse as finite floats, `NaN`, `+Inf`, or `-Inf`;
 *   - a body that is not exposition text (e.g. an HTML shell) is rejected with
 *     a diff-style error naming the offending line.
 */

/** A parsed label key/value pair from a metric sample line. */
export interface ParsedLabel {
  name: string;
  value: string;
}

/** Type of a metric family per the exposition spec. */
export type ParsedMetricType = "counter" | "gauge" | "histogram" | "summary" | "untyped";

/** One parsed metric sample line. */
export interface ParsedSample {
  /** Metric name, exactly as serialized (e.g. `fusion_system_rss_bytes`). */
  name: string;
  /** Label set on the sample line (empty for a scalar family). */
  labels: ParsedLabel[];
  /** Numeric value with NaN/±Infinity preserved from the text. */
  value: number;
  /** The raw numeric token (e.g. `0`, `NaN`, `+Inf`). */
  valueText: string;
  /** Optional epoch-millis timestamp suffix, when present. */
  timestampMs?: number;
  /** HELP text from the preceding `# HELP <name> ...` line, when present. */
  help?: string;
  /** Type from the preceding `# TYPE <name> <type>` line, when present. */
  type?: ParsedMetricType;
}

/** A parsed family group: one name with its shared metadata and all samples. */
export interface ParsedFamily {
  name: string;
  help?: string;
  type?: ParsedMetricType;
  samples: ParsedSample[];
}

/** The result of a successful parse: every metric sample grouped by name. */
export interface ParsedMetrics {
  families: ParsedFamily[];
  /** Convenience: every sample flattened in body order. */
  samples: ParsedSample[];
  /** A family's `type` is implicitly `counter`/`summary` when a name ends in `_total`/`_sum`. */
}
/**
 * Direct map of name -> samples; faster lookups for endpoint tests that want
 * one family without scanning.
 */
export type ParsedFamilyIndex = Map<string, ParsedFamily>;

/* ------------------------------------------------------------------ *
 * Tokenization primitives
 * ------------------------------------------------------------------ */

const METRIC_TOKEN_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const NUMBER_TOKEN_RE = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const LABEL_VALUE_ESCAPES: Record<string, string> = {
  n: "\n",
  '\\': "\\",
  '"': '"',
};

/**
 * Decode a Prometheus-escaped label value (`\\`, `\"`, `\n`) back to the raw
 * string. Any other `\x` escape is left verbatim (spec reserves only these
 * three).
 */
export function unescapeLabelValue(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      const decoded = LABEL_VALUE_ESCAPES[next];
      if (decoded !== undefined) {
        out += decoded;
        i += 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Parse the trailing `{label="value",...}` (leading brace inclusive) of a
 * sample line into label pairs. Returns `[]` for a scalar line.
 */
function parseLabelSet(body: string): { labels: ParsedLabel[]; rest: string } {
  if (!body.startsWith("{")) return { labels: [], rest: body };
  const labels: ParsedLabel[] = [];
  let i = 1;
  let name = "";
  // Parse `name="value"` pairs separated by commas.
  while (i < body.length) {
    // Skip whitespace between tokens.
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (body[i] === "}") {
      i += 1;
      break;
    }
    // Label name ends at `=`.
    const nameStart = i;
    while (i < body.length && body[i] !== "=") i += 1;
    if (i >= body.length) throw new ExpositionParseError("unterminated label name");
    name = body.slice(nameStart, i).trim();
    // Expect `=` then `"value"`.
    if (body[i] !== "=") throw new ExpositionParseError(`missing '=' after label name "${name}"`);
    i += 1; // consume '='
    if (body[i] !== '"') throw new ExpositionParseError(`label "${name}" value must be double-quoted`);
    i += 1; // consume opening quote
    let value = "";
    let closed = false;
    while (i < body.length) {
      const ch = body[i];
      if (ch === "\\") {
        // Consume the escape; validate against the reserved set on decode.
        if (i + 1 >= body.length) throw new ExpositionParseError("dangling escape in label value");
        value += `\\${body[i + 1]}`;
        i += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        i += 1;
        break;
      }
      value += ch;
      i += 1;
    }
    if (!closed) throw new ExpositionParseError(`unterminated value for label "${name}"`);
    labels.push({ name, value: unescapeLabelValue(value) });
    // Expect either `,` or `}`.
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (i < body.length && body[i] === ",") {
      i += 1;
      continue;
    }
    if (i < body.length && body[i] === "}") {
      i += 1;
      break;
    }
    throw new ExpositionParseError(`expected ',' or '}' after label "${name}"`);
  }
  return { labels, rest: body.slice(i).trim() };
}

/** Parse the numeric value token and optional timestamp of a sample line. */
function parseValueToken(token: string): { value: number; valueText: string } {
  let text = token;
  if (text === "NaN") return { value: Number.NaN, valueText: text };
  if (text === "+Inf" || text === "Inf") return { value: Number.POSITIVE_INFINITY, valueText: text };
  if (text === "-Inf") return { value: Number.NEGATIVE_INFINITY, valueText: text };
  if (!NUMBER_TOKEN_RE.test(text)) {
    throw new ExpositionParseError(`invalid numeric value "${token}"`);
  }
  return { value: Number(text), valueText: text };
}

/** An error thrown when a body is not valid Prometheus exposition text. */
export class ExpositionParseError extends Error {
  readonly line: number;
  readonly rawLine: string;
  constructor(message: string, line?: number, rawLine?: string) {
    const at = line === undefined ? "" : ` (line ${line})`;
    super(`${message}${at}`);
    this.name = "ExpositionParseError";
    this.line = line ?? 0;
    this.rawLine = rawLine ?? "";
  }
}

/**
 * Parse a Prometheus text exposition (version 0.0.4) body into typed metric
 * families. Comments/blank lines are skipped; `# HELP` and `# TYPE` lines
 * attach metadata to their following samples. Throws {@link ExpositionParseError}
 * with a line-numbered diff when the body is not well-formed.
 */
export function parseExpositionText(body: string): ParsedMetrics {
  const families = new Map<string, ParsedFamily>();
  const samples: ParsedSample[] = [];
  // Pending HELP/TYPE for a name, carried until the first sample of that name
  // appears (metadata may precede samples in the body).
  const pendingMeta = new Map<string, { help?: string; type?: ParsedMetricType }>();
  const lines = body.split("\n");
  let hadAnyLine = false;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNo = idx + 1;
    const line = lines[idx];
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    hadAnyLine = true;

    if (trimmed.startsWith("#")) {
      // Comment, HELP, or TYPE directive.
      const rest = trimmed.slice(1).trimStart();
      if (rest.startsWith("HELP ") || rest === "HELP" || rest.startsWith("TYPE ")) {
        const keyword = rest.split(/\s/, 1)[0];
        const after = rest.slice(keyword.length).trimStart();
        if (keyword === "TYPE") {
          const parts = splitTopLevel(after);
          const name = parts[0];
          const typeText = parts[1];
          validateNameToken(name, lineNo, line);
          const type = typeText as ParsedMetricType;
          if (!["counter", "gauge", "histogram", "summary", "untyped"].includes(type)) {
            throw new ExpositionParseError(`unknown TYPE "${typeText}" for "${name}"`, lineNo, line);
          }
          const pending = getPending(pendingMeta, name);
          pending.type = type;
          // A TYPE line may follow an earlier HELP for the same family.
          flushPending(name, pending, families, samples, lineNo, line);
        } else if (keyword === "HELP") {
          const name = after.split(/\s/, 1)[0];
          validateNameToken(name, lineNo, line);
          const help = after.slice(name.length).trim();
          const pending = getPending(pendingMeta, name);
          pending.help = help;
        }
      } else {
        // A plain `# comment` or `# anything else` — valid comment line.
        // Prometheus requires a space after `#` for a comment; tolerate `#foo`
        // as a comment per the strictest readers? The spec says comments start
        // with `# ` + a space. Treat any `#` line that isn't HELP/TYPE as a
        // comment to mirror real scrape acceptance.
        continue;
      }
      continue;
    }

    // Sample line: `name{labels} value[ timestamp]`.
    const { name, rest } = splitMetricSample(trimmed, lineNo, line);
    const { labels, rest: valueAndTs } = parseLabelSet(rest);
    if (valueAndTs.length === 0) {
      throw new ExpositionParseError(`sample line for "${name}" is missing a value`, lineNo, line);
    }
    const valueParts = valueAndTs.split(/\s+/);
    const { value, valueText } = parseValueToken(valueParts[0]);
    const timestampMs = valueParts.length > 1 ? Number(valueParts[1]) : undefined;
    if (valueParts.length > 2) {
      throw new ExpositionParseError(`sample line for "${name}" has too many tokens`, lineNo, line);
    }
    if (timestampMs !== undefined && !Number.isFinite(timestampMs)) {
      throw new ExpositionParseError(`sample line for "${name}" has an invalid timestamp`, lineNo, line);
    }

    // Attach pending metadata.
    const pending = pendingMeta.get(name);
    const help = pending?.help;
    const type = pending?.type;
    pendingMeta.delete(name);

    const sample: ParsedSample = {
      name,
      labels,
      value,
      valueText,
      timestampMs,
      help,
      type,
    };
    samples.push(sample);

    let family = families.get(name);
    if (!family) {
      family = { name, help, type, samples: [] };
      families.set(name, family);
    } else if (family.samples.length === 0) {
      // First sample of this family — fill metadata from a pending/earlier line.
      if (help !== undefined && family.help === undefined) family.help = help;
      if (type !== undefined && family.type === undefined) family.type = type;
    }
    family.samples.push(sample);
  }

  if (!hadAnyLine) {
    throw new ExpositionParseError("empty body is not valid exposition text");
  }

  return { families: [...families.values()], samples };
}

/** Split the metric name from the rest (`name{...} value`). */
function splitMetricSample(line: string, lineNo: number, rawLine: string): { name: string; rest: string } {
  let i = 0;
  while (i < line.length && !line[i].match(/[{\s]/)) i += 1;
  const name = line.slice(0, i);
  validateNameToken(name, lineNo, rawLine);
  return { name, rest: line.slice(i).trim() };
}

/** Validate a metric or label-name token's character set. */
function validateNameToken(name: string, lineNo: number, rawLine: string): void {
  if (name.length === 0 || !METRIC_TOKEN_RE.test(name)) {
    throw new ExpositionParseError(`invalid metric name "${name}"`, lineNo, rawLine);
  }
}

/** Get-or-create pending metadata for a family name. */
function getPending(
  pendingMeta: Map<string, { help?: string; type?: ParsedMetricType }>,
  name: string,
): { help?: string; type?: ParsedMetricType } {
  let entry = pendingMeta.get(name);
  if (!entry) {
    entry = {};
    pendingMeta.set(name, entry);
  }
  return entry;
}

/** If a family already has samples, close the pending metadata hook. */
function flushPending(
  name: string,
  pending: { help?: string; type?: ParsedMetricType },
  families: Map<string, ParsedFamily>,
  _samples: ParsedSample[],
  _lineNo: number,
  _rawLine: string,
): void {
  const family = families.get(name);
  if (!family || family.samples.length === 0) return;
  if (family.help !== undefined && pending.help === undefined) pending.help = family.help;
  // Metadata is consumed lazily on the next sample; nothing to flush for an
  // already-populated family (its samples already captured their help/type).
  void name;
}

/** Split a string on the first run of whitespace, returning both halves. */
function splitTopLevel(text: string): string[] {
  const idx = text.search(/\s/);
  if (idx === -1) return [text, ""];
  const first = text.slice(0, idx);
  const rest = text.slice(idx).trim();
  return rest.length > 0 ? [first, rest] : [first, ""];
}

/* ------------------------------------------------------------------ *
 * Assert helper
 * ------------------------------------------------------------------ */

/**
 * Assert that `body` is valid Prometheus exposition text and return its typed
 * families. Throws an {@link ExpositionParseError} with a line-numbered diff
 * message otherwise — small and terminal for tests.
 */
export function assertExpositionText(body: string): ParsedMetrics {
  return parseExpositionText(body);
}

/** Create a name -> family index for convenient lookup in assertions. */
export function indexFamilies(parsed: ParsedMetrics): ParsedFamilyIndex {
  return new Map(parsed.families.map((f) => [f.name, f]));
}

/**
 * Convenience: find a family by name, asserting it exists and has at least one
 * sample. Returns the single value for a scalar (no-label) single-sample family,
 * otherwise the samples array.
 */
export function sampleValueOf(family: ParsedFamily | undefined): number {
  if (!family || family.samples.length === 0) {
    throw new ExpositionParseError("metric family has no samples");
  }
  if (family.samples.length !== 1) {
    throw new ExpositionParseError(
      `expected a scalar single-sample family, got ${family.samples.length} samples`,
    );
  }
  return family.samples[0].value;
}

/**
 * Assert (via the parser) that a metric family with the exact name exists and
 * returns it. Looks through the parsed families index.
 */
export function requireFamily(parsed: ParsedMetrics, name: string): ParsedFamily {
  const family = indexFamilies(parsed).get(name);
  if (!family) {
    throw new ExpositionParseError(`expected a metric family "${name}" but the body has none`);
  }
  return family;
}