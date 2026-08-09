// @vitest-environment node
import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { GITHUB_OUTCOME_MAP, githubSource } from "../signal-sources/github.js";

const secret = "github-secret";
function context(payload: object, event: string, delivery = "delivery-1") {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return { rawBody, secret, headers: { "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` } };
}
function payload(kind: "check_suite" | "workflow_run" | "status", outcome: string) {
  const repository = { full_name: "org/repo", html_url: "https://github.com/org/repo" };
  if (kind === "status") return { repository, state: outcome, context: "build", sha: "abc123", target_url: "https://github.com/org/repo/actions/1", created_at: "2026-08-09T12:00:00Z" };
  const event = { status: "completed", conclusion: outcome, head_sha: "abc123", head_branch: "main", updated_at: "2026-08-09T12:00:00Z", app: { slug: "checks" } };
  return kind === "check_suite" ? { repository, check_suite: event } : { repository, workflow: { name: "build" }, workflow_run: event };
}

it("verifies GitHub signatures and exhaustively maps terminal outcomes", () => {
  expect(Object.keys(GITHUB_OUTCOME_MAP).sort()).toEqual([
    "action_required", "cancelled", "error", "failure", "neutral", "skipped", "stale", "startup_failure", "success", "timed_out",
  ]);
  for (const [outcome, expected] of Object.entries(GITHUB_OUTCOME_MAP)) {
    for (const kind of ["check_suite", "workflow_run", "status"] as const) {
      const body = payload(kind, outcome);
      const ctx = context(body, kind);
      expect(githubSource.verify(ctx).valid).toBe(true);
      const signal = githubSource.normalize(body, ctx);
      expect(signal).toMatchObject({ severity: expected.severity, resolution: expected.resolution });
      expect(signal?.recoveryOnly).toBe("recoveryOnly" in expected ? true : undefined);
    }
  }
});

it("leaves unknown outcomes visible and pending events non-actionable", () => {
  const unknown = payload("check_suite", "future_outcome");
  expect(githubSource.normalize(unknown, context(unknown, "check_suite"))).toMatchObject({ severity: "warning", resolution: "open" });
  const pending = { repository: { full_name: "org/repo" }, state: "pending", context: "build", sha: "abc" };
  expect(githubSource.normalize(pending, context(pending, "status"))).toBeNull();
});

it("honors a present event header instead of falling back to a status-shaped payload", () => {
  const status = payload("status", "failure");
  expect(githubSource.normalize(status, context(status, "ping"))).toBeNull();
  expect(githubSource.normalize(status, context(status, "issues"))).toBeNull();

  const headerless = context(status, "status");
  delete headerless.headers["x-github-event"];
  expect(githubSource.normalize(status, headerless)).toMatchObject({ groupingKey: "github:org/repo:status:build:abc123" });
});
