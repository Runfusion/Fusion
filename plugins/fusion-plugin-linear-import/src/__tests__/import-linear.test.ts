import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { buildLinearImportPreview, buildLinearTaskCreateInput, findExistingLinearTask, importLinearIssue, taskMatchesLinearIssue } from "../import-linear.js";
import type { LinearIssue } from "../linear-client.js";
import { hasLinearApiKey, linearSettingsSchema, resolveLinearSettings } from "../settings.js";

const issue: LinearIssue = {
  id: "lin-issue-1",
  identifier: "ENG-42",
  title: "Fix import",
  description: "Detailed markdown",
  url: "https://linear.app/acme/issue/ENG-42/fix-import",
  state: { name: "Todo", type: "unstarted" },
  team: { id: "team-1", key: "ENG", name: "Engineering" },
  assignee: { id: "user-1", name: "Ada" },
  creator: null,
  labels: [{ name: "bug" }],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
};

function task(overrides: Partial<Task>): Task {
  return { id: "FN-1", title: "Existing", description: "", status: "pending", column: "todo", createdAt: "", updatedAt: "", steps: [], dependencies: [], log: [], ...overrides } as Task;
}

describe("linear settings", () => {
  it("defines required password setting and defaults", () => {
    expect(linearSettingsSchema.apiKey.type).toBe("password");
    expect(linearSettingsSchema.apiKey.required).toBe(true);
    expect(resolveLinearSettings({ defaultStateFilter: "bogus" }).defaultStateFilter).toBe("active");
    expect(resolveLinearSettings({ apiKey: " token ", defaultStateFilter: "completed" })).toEqual(expect.objectContaining({ apiKey: "token", defaultStateFilter: "completed" }));
    expect(hasLinearApiKey({ apiKey: "  " })).toBe(false);
  });
});

describe("Linear import normalization", () => {
  it("normalizes populated issue descriptions and provenance", () => {
    const preview = buildLinearImportPreview(issue);
    expect(preview.title).toBe("[ENG-42] Fix import");
    expect(preview.description).toContain("Detailed markdown");
    expect(preview.description).toContain("Source: https://linear.app/acme/issue/ENG-42/fix-import");
    expect(preview.sourceIssue).toEqual(expect.objectContaining({ provider: "linear", repository: "ENG", externalIssueId: "lin-issue-1", issueNumber: 42 }));
    expect(preview.sourceMetadata).toEqual(expect.objectContaining({ provider: "linear", issueId: "lin-issue-1", identifier: "ENG-42", teamKey: "ENG" }));
  });

  it("normalizes empty descriptions", () => {
    const preview = buildLinearImportPreview({ ...issue, description: null });
    expect(preview.description).toContain("(no description)");
  });

  it("builds triage task create input with durable metadata", () => {
    const input = buildLinearTaskCreateInput(issue);
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-16:35:
    The import names NO column, so `createTask` resolves the workflow's intake lane.

    This assertion used to demand `"triage"` — a column U11 DELETED — which is how the defect
    survived: the test pinned the bug. An explicit `column` overrides `createTask`'s own intake
    resolution, so every Linear import landed in a lane no workflow declares, with a 200 and a task
    id and no card on the board.

    Absence is asserted rather than a resolved id, because absence is precisely the property that
    hands the decision to `createTask`. It is also what fails on revert.
    */
    expect(input.column).toBeUndefined();
    expect(Object.keys(input)).not.toContain("column");
    expect(input.source?.sourceType).toBe("api");
    expect(input.source?.sourceMetadata).toEqual(expect.objectContaining({ provider: "linear", issueId: "lin-issue-1" }));
  });

  it("detects duplicates by issue id, identifier, and source URL", async () => {
    const byIssueId = task({ sourceIssue: { provider: "linear", repository: "ENG", externalIssueId: issue.id, issueNumber: 42 } });
    expect(taskMatchesLinearIssue(byIssueId, issue)).toBe(true);
    expect(taskMatchesLinearIssue(task({ source: { sourceType: "api", sourceMetadata: { provider: "linear", identifier: "ENG-42" } } }), issue)).toBe(true);
    expect(taskMatchesLinearIssue(task({ description: `Imported\nSource: ${issue.url}` }), issue)).toBe(true);

    const existing = await findExistingLinearTask({ listTasks: vi.fn(async () => [byIssueId]) }, issue);
    expect(existing?.id).toBe("FN-1");
  });

  it("skips duplicate creation and imports new issues", async () => {
    const existingStore = { listTasks: vi.fn(async () => [task({ id: "FN-2", source: { sourceType: "api", sourceMetadata: { provider: "linear", issueId: issue.id } } })]), createTask: vi.fn() };
    await expect(importLinearIssue(existingStore, issue)).resolves.toEqual(expect.objectContaining({ imported: false, duplicate: true, taskId: "FN-2" }));
    expect(existingStore.createTask).not.toHaveBeenCalled();

    const created = task({ id: "FN-3" });
    const newStore = { listTasks: vi.fn(async () => []), createTask: vi.fn(async () => created) };
    await expect(importLinearIssue(newStore, issue)).resolves.toEqual(expect.objectContaining({ imported: true, duplicate: false, taskId: "FN-3" }));
    expect(newStore.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "[ENG-42] Fix import" }));
  });
});
