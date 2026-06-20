// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  serializeCsv,
  tokenAnalyticsToTable,
  activityAnalyticsToTable,
  productivityAnalyticsToTable,
  type CsvTable,
} from "../command-center-csv.js";
import type { ActivityAnalytics, ProductivityAnalytics, TokenAnalytics } from "@fusion/core";

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

describe("activityAnalyticsToTable", () => {
  function result(): ActivityAnalytics {
    return {
      from: "2026-06-01",
      to: "2026-06-02",
      sessions: 2,
      messages: 5,
      activeNodes: 1,
      activeAgents: 2,
      agentRuns: { total: 9, active: 3, completed: 4, failed: 2 },
      daily: [{ day: "2026-06-01", messages: 5, activeNodes: 1, activeAgents: 2, agentRuns: 9 }],
      stickiness: 0.5,
      mttr: { value: null, unavailable: true, sampleCount: 0 },
      monitor: {
        mttr: { value: null, unavailable: true, sampleCount: 0 },
        incidentsOpened: 0,
        incidentsResolved: 0,
        openIncidents: 0,
        deployments: 0,
      },
      funnel: {
        stages: [],
        enteredInRange: 0,
        doneInRange: 0,
        completionRate: null,
        throughputPerDay: 0,
        rangeDays: 2,
      },
    };
  }

  it("includes agent run daily and summary rows", () => {
    const table = activityAnalyticsToTable(result());

    expect(table.header).toEqual(["day", "messages", "activeNodes", "activeAgents", "agentRuns"]);
    expect(table.rows).toContainEqual(["2026-06-01", 5, 1, 2, 9]);
    expect(table.rows).toContainEqual(["(agentRuns.total)", 9, "", "", ""]);
    expect(table.rows).toContainEqual(["(agentRuns.active)", 3, "", "", ""]);
    expect(table.rows).toContainEqual(["(agentRuns.completed)", 4, "", "", ""]);
    expect(table.rows).toContainEqual(["(agentRuns.failed)", 2, "", "", ""]);
  });
});

describe("productivityAnalyticsToTable", () => {
  function result(hoursSaved: ProductivityAnalytics["hoursSaved"]): ProductivityAnalytics {
    return {
      from: null,
      to: null,
      modifiedFiles: 2,
      byLanguage: [{ language: "ts", count: 2 }],
      commits: 1,
      pullRequests: 1,
      loc: hoursSaved.unavailable ? { value: null, unavailable: true } : { value: 15, unavailable: false },
      hoursSaved,
      taskDuration: {
        completedTasks: 0,
        averageMs: null,
        medianMs: null,
        p90Ms: null,
        totalMs: null,
        unavailable: true,
      },
    };
  }

  it("exports hours saved and preserves the unavailable sentinel as an empty cell", () => {
    expect(productivityAnalyticsToTable(result({ value: null, unavailable: true })).rows).toContainEqual([
      "hoursSaved",
      "",
    ]);
    expect(productivityAnalyticsToTable(result({ value: 1, unavailable: false })).rows).toContainEqual([
      "hoursSaved",
      1,
    ]);
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
