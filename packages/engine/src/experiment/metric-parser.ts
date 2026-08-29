import type { ExperimentSecondaryMetric } from "@fusion/core";

export const METRIC_LINE_REGEX =
  /^METRIC\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(?:\(([^)]+)\))?\s*$/;

export const PROTOTYPE_POLLUTION_DENYLIST = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export interface ParsedMetricLines {
  primary?: { name: string; value: number; unit?: string };
  secondary: ExperimentSecondaryMetric[];
  warnings: string[];
}

interface ParsedMetricEntry {
  name: string;
  value: number;
  unit?: string;
}

export function parseMetricLines(stdout: string): ParsedMetricLines {
  const warnings: string[] = [];
  const byName = new Map<string, ParsedMetricEntry>();
  const firstSeenOrder: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = METRIC_LINE_REGEX.exec(line);
    if (!match) {
      const looseMatch = /^METRIC\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*([^\s(]+).*$/.exec(
        line,
      );
      if (looseMatch) {
        const [, looseName, looseRawValue] = looseMatch;
        const looseValue = Number(looseRawValue);
        if (!Number.isFinite(looseValue)) {
          warnings.push(
            `Ignored non-finite metric value for ${looseName}: ${looseRawValue}`,
          );
        }
      }
      continue;
    }

    const [, name, rawValue, rawUnit] = match;
    if (PROTOTYPE_POLLUTION_DENYLIST.has(name)) {
      warnings.push(`Ignored denylisted metric name: ${name}`);
      continue;
    }

    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      warnings.push(`Ignored non-finite metric value for ${name}: ${rawValue}`);
      continue;
    }

    if (!byName.has(name)) {
      firstSeenOrder.push(name);
    }

    byName.set(name, {
      name,
      value,
      unit: rawUnit?.trim() || undefined,
    });
  }

  const ordered = firstSeenOrder
    .map((name) => byName.get(name))
    .filter((entry): entry is ParsedMetricEntry => Boolean(entry));

  const primaryEntry = ordered[0];
  const secondary = ordered.slice(1).map((entry) => ({
    name: entry.name,
    value: entry.value,
    unit: entry.unit,
  }));

  return {
    primary: primaryEntry
      ? {
          name: primaryEntry.name,
          value: primaryEntry.value,
          unit: primaryEntry.unit,
        }
      : undefined,
    secondary,
    warnings,
  };
}
