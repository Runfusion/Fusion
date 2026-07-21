import { describe, expect, it } from "vitest";
import { scrubReportPayload, scrubReportText } from "../report-scrub.js";

describe("report scrub", () => {
  const context = {
    rootDir: "/Users/alice/work/acme-private",
    homeDir: "/Users/alice",
    projectName: "acme-private",
  };

  it("removes paths, project identity, usernames, and secret-like values", () => {
    const result = scrubReportPayload({
      userPrompt: "Crash in acme-private at /Users/alice/work/acme-private/src/a.ts with ghp_abcdefghijk1234567890",
      summary: "acme-private failed",
      body: "See /home/bob/private/file and sk-abcdefghijk1234567890",
      context: { logs: "token=very-secret-value path C:\\Users\\alice\\secret.txt" },
    }, context);

    expect(JSON.stringify(result)).not.toContain("acme-private");
    expect(JSON.stringify(result)).not.toContain("/Users/alice");
    expect(JSON.stringify(result)).not.toContain("/home/bob");
    expect(JSON.stringify(result)).not.toContain("ghp_abcdefghijk1234567890");
    expect(JSON.stringify(result)).not.toContain("sk-abcdefghijk1234567890");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("removes PII from user prompts and nested gathered context", () => {
    const result = scrubReportPayload({
      userPrompt: "Jane Doe cannot sign in; email jane.doe@example.com",
      summary: "Reporter: Jane Doe",
      body: "Owner=John Smith saw the failure",
      context: { task: { title: "Jane Doe's project" }, logs: ["email: john.smith@company.test", "User: John Smith"] },
    }, context);

    expect(JSON.stringify(result)).not.toContain("Jane Doe");
    expect(JSON.stringify(result)).not.toContain("John Smith");
    expect(JSON.stringify(result)).not.toContain("jane.doe@example.com");
    expect(JSON.stringify(result)).not.toContain("john.smith@company.test");
    expect(JSON.stringify(result)).toContain("[REDACTED_EMAIL]");
    expect(JSON.stringify(result)).toContain("[REDACTED_NAME]");
  });

  it("handles absent text and context safely", () => {
    expect(scrubReportText(undefined, context)).toBe("");
    expect(scrubReportPayload({ summary: "", context: undefined }, context)).toEqual({ summary: "", context: undefined });
  });

  /*
   * FNXC:ReportPipeline 2026-07-19-20:45:
   * Activity labels are intentionally unsanitized in the local ring buffer.
   * Recursive report scrubbing must redact every nested trace egress field.
   */
  it("scrubs nested activity traces and does not exempt arbitrary data URLs", () => {
    const screenshot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=";
    const result = scrubReportPayload({
      context: { activityTrace: [{ ts: "2026-07-19", kind: "tool", label: "acme-private /Users/alice/work/acme-private ghp_abcdefghijk1234567890 sk-abcdefghijklmnopqrstuvwxyz" }] },
      body: `Pasted ${screenshot}`,
    }, context);
    expect(JSON.stringify(result.context?.activityTrace)).not.toMatch(/acme-private|\/Users\/alice|ghp_|sk-/);
    expect(result.body).toBe("Pasted [REDACTED_BINARY]");
  });

  it("preserves empty or undefined activity trace values without throwing", () => {
    expect(scrubReportPayload({ context: { activityTrace: [] } }, context)).toEqual({ context: { activityTrace: [] } });
    expect(scrubReportPayload({ context: { activityTrace: undefined } }, context)).toEqual({ context: { activityTrace: undefined } });
  });

});
