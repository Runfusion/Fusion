// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  serializeCsv,
  tokenAnalyticsToTable,
  type CsvTable,
} from "../command-center-csv.js";
import type { TokenAnalytics } from "@fusion/core";

describe("serializeCsv (RFC-4180)", () => {
  it("emits a header row and CRLF-terminated records", () => {
    const table: CsvTable = {
      header: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    };
    expect(serializeCsv(table)).toBe("a,b\r\n1,2\r\n3,4\r\n");
  });

  it("emits a header-only document for an empty result (not empty)", () => {
    const table: CsvTable = { header: ["x", "y"], rows: [] };
    expect(serializeCsv(table)).toBe("x,y\r\n");
  });

  it("quotes fields containing commas, quotes, and newlines (RFC-4180)", () => {
    const table: CsvTable = {
      header: ["name", "note"],
      rows: [
        ["a,b", 'he said "hi"'],
        ["line1\nline2", "carriage\rreturn"],
      ],
    };
    const out = serializeCsv(table);
    expect(out).toContain('"a,b","he said ""hi"""');
    expect(out).toContain('"line1\nline2","carriage\rreturn"');
  });

  it("serializes null/undefined as empty fields and numbers/booleans as-is", () => {
    const table: CsvTable = {
      header: ["a", "b", "c", "d"],
      rows: [[null, undefined, 42, true]],
    };
    expect(serializeCsv(table)).toBe("a,b,c,d\r\n,,42,true\r\n");
  });
});

describe("tokenAnalyticsToTable", () => {
  function emptyResult(): TokenAnalytics {
    return {
      from: null,
      to: null,
      groupBy: null,
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        nTasks: 0,
      },
      cost: { usd: null, unavailable: false, stale: false },
      groups: [],
    };
  }

  it("produces a single (total) row when no groupBy", () => {
    const table = tokenAnalyticsToTable(emptyResult());
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][0]).toBe("(total)");
    // Header-only output is impossible here — there is always a total row.
    expect(serializeCsv(table).split("\r\n")[0]).toContain("totalTokens");
  });

  it("produces one row per group when groupBy is set", () => {
    const result = emptyResult();
    result.groupBy = "model";
    result.groups = [
      {
        key: "claude-sonnet-4-5",
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 30,
        nTasks: 1,
        cost: { usd: 0.01, unavailable: false, stale: false },
      },
    ];
    const table = tokenAnalyticsToTable(result);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][0]).toBe("claude-sonnet-4-5");
    expect(table.rows[0][5]).toBe(30);
  });
});
