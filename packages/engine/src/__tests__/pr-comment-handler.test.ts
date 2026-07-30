import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrCommentHandler } from "../pr-comment-handler.js";
import type { TaskStore, Task } from "@fusion/core";

const mockStore = {
  addTaskComment: vi.fn<(id: string, text: string, author?: string) => Promise<Task>>(),
  getTask: vi.fn<(id: string) => Promise<Task>>().mockResolvedValue({ id: "FN-001", review: undefined } as Task),
  updateTask: vi.fn<(id: string, updates: Partial<Task>) => Promise<Task>>().mockResolvedValue({ id: "FN-001" } as Task),
  createTask: vi.fn<(input: Parameters<TaskStore["createTask"]>[0]) => Promise<Task>>().mockResolvedValue({ id: "FN-123" } as Task),
  listTasks: vi.fn<() => Promise<Task[]>>().mockResolvedValue([]),
  logEntry: vi.fn<(id: string, action: string, outcome?: string) => Promise<Task>>().mockResolvedValue({ id: "FN-001" } as Task),
  recordRunAuditEvent: vi.fn<(event: unknown) => Promise<void>>().mockResolvedValue(),
  moveTask: vi.fn<(id: string, column: Task["column"]) => Promise<Task>>().mockResolvedValue({ id: "FN-001", column: "in-progress" } as Task),
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-20:10:
  The workflow readers `resolveTerminalColumnsFor` needs. Default to "no workflow" so every existing case
  keeps the legacy-pair fallback unchanged; the renamed case overrides them per test.
  */
  getTaskWorkflowSelection: vi.fn<(id: string) => unknown>().mockReturnValue(undefined),
  getWorkflowDefinition: vi.fn<(id: string) => Promise<unknown>>().mockResolvedValue(undefined),
} as unknown as TaskStore;

describe("PrCommentHandler", () => {
  let handler: PrCommentHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    (mockStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "FN-001", review: undefined } as Task);
    (mockStore.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockStore.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "FN-123" } as Task);
    (mockStore.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "FN-001" } as Task);
    handler = new PrCommentHandler(mockStore);
  });

  const mockPrInfo = {
    url: "https://github.com/owner/repo/pull/42",
    number: 42,
    status: "open" as const,
    title: "Test PR",
    headBranch: "fusion/fn-001",
    baseBranch: "main",
    commentCount: 0,
  };

  describe("isNonActionable", () => {
    it.each([
      "LGTM",
      "lgtm",
      "Looks good",
      "Looks good to me",
      "Thanks",
      "Thank you",
      "Nice",
      "Great work",
      "👍",
      "✅",
    ])("filters out non-actionable comment: %s", async (body) => {
      await handler.handleNewComments("FN-001", mockPrInfo, [
        {
          id: 1,
          body,
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      expect(mockStore.addTaskComment).not.toHaveBeenCalled();
    });
  });

  describe("isActionable", () => {
    it.each([
      { body: "Please fix the indentation", keyword: "fix" },
      { body: "Should change the variable name", keyword: "change" },
      { body: "Update the documentation", keyword: "update" },
      { body: "Remove the unused import", keyword: "remove" },
      { body: "Add error handling", keyword: "add" },
      { body: "You should refactor this", keyword: "should" },
      { body: "Needs to handle edge cases", keyword: "needs to" },
      { body: "Consider using a different approach", keyword: "consider" },
      { body: "I suggest renaming this", keyword: "suggest" },
      { body: "Recommend adding tests", keyword: "recommend" },
    ])("creates comment for actionable feedback containing '$keyword': $body", async ({ body }) => {
      await handler.handleNewComments("FN-001", mockPrInfo, [
        {
          id: 1,
          body,
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      expect(mockStore.addTaskComment).toHaveBeenCalled();
    });
  });

  describe("code suggestions", () => {
    it("creates comment for comments with code blocks", async () => {
      await handler.handleNewComments("FN-001", mockPrInfo, [
        {
          id: 1,
          body: "```typescript\nconst x = 1;\n```",
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      expect(mockStore.addTaskComment).toHaveBeenCalled();
    });

    it("creates comment for inline code suggestions", async () => {
      await handler.handleNewComments("FN-001", mockPrInfo, [
        {
          id: 1,
          body: "Use `const` instead of `let`",
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      expect(mockStore.addTaskComment).toHaveBeenCalled();
    });
  });

  describe("comment content", () => {
    it("includes PR info and comment details", async () => {
      await handler.handleNewComments("FN-001", mockPrInfo, [
        {
          id: 1,
          body: "Please fix the bug",
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      const call = (mockStore.addTaskComment as ReturnType<typeof vi.fn>).mock.calls[0];
      const text = call[1] as string;

      expect(text).toContain("PR Review Feedback");
      expect(text).toContain("@reviewer");
      expect(text).toContain("#42");
      expect(text).toContain("open");
      expect(text).toContain("Please fix the bug");
      expect(text).toContain("View on GitHub");
    });

    it("truncates long comments", async () => {
      const longBody = "Please fix this issue: " + "a".repeat(1000);

      await handler.handleNewComments("FN-001", mockPrInfo, [
        {
          id: 1,
          body: longBody,
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      const call = (mockStore.addTaskComment as ReturnType<typeof vi.fn>).mock.calls[0];
      const text = call[1] as string;

      expect(text.length).toBeLessThan(longBody.length);
      expect(text).toContain("...");
    });

    it("marks as agent-authored", async () => {
      await handler.handleNewComments("FN-001", mockPrInfo, [
        {
          id: 1,
          body: "Please fix this",
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      expect(mockStore.addTaskComment).toHaveBeenCalledWith(
        "FN-001",
        expect.any(String),
        "agent"
      );
    });

    it("calls out follow-up context when feedback arrives after PR is merged", async () => {
      await handler.handleNewComments("FN-001", { ...mockPrInfo, status: "merged" }, [
        {
          id: 1,
          body: "Please add one more regression test",
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      const text = (mockStore.addTaskComment as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(text).toContain("This PR is already merged");
      expect(text).toContain("follow-up work");
    });
  });

  describe("handleChangesRequested", () => {
    it("persists review item feedback when changes are requested", async () => {
      (mockStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "FN-001", column: "in-review", review: undefined } as Task);

      await handler.handleChangesRequested("FN-001", mockPrInfo, "reviewer", "Please add tests");

      expect(mockStore.updateTask).toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({
          review: expect.objectContaining({
            mode: "pull-request",
            items: expect.arrayContaining([
              expect.objectContaining({ source: "github-pr", status: "queued" }),
            ]),
          }),
          reviewState: expect.objectContaining({
            source: "pull-request",
            items: expect.arrayContaining([
              expect.objectContaining({ source: "github-pr", body: "Please add tests" }),
            ]),
          }),
        }),
      );
      expect(mockStore.moveTask).toHaveBeenCalledWith("FN-001", "in-progress");
    });
  });

  describe("createFollowUpTask", () => {
    it("creates follow-up task for unaddressed feedback", async () => {
      await handler.createFollowUpTask("FN-001", mockPrInfo, [
        {
          id: 1,
          body: "This needs fixing",
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      /*
      FNXC:WorkflowLifecycleColumns 2026-07-29-20:40 (U11):
      This asserted `column: "triage"` and so PINNED the defect. `createTaskImpl`
      resolves the column as `input.column || resolvedEntryColumn || fallbackIntake
      || "triage"`, so an explicit column OVERRIDES the workflow's intake — and
      after #2515 `triage` is not a column the default lineage declares, so the
      follow-up was created straight into the stranded state.

      Now asserts the invariant instead of the id: the caller passes NO column, so
      whatever intake the task's workflow declares is what wins.
      */
      expect(mockStore.createTask).toHaveBeenCalledWith({
        title: "Follow-up: Address PR #42 feedback",
        description: expect.stringContaining("FN-001"),
        dependencies: ["FN-001"],
        source: {
          sourceType: "api",
          sourceParentTaskId: "FN-001",
          sourceMetadata: {
            prNumber: 42,
            prUrl: "https://github.com/owner/repo/pull/42",
          },
        },
      });
      const [createArg] = (mockStore.createTask as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0];
      expect(Object.hasOwn(createArg, "column")).toBe(false);
    });

    it("does nothing when no unaddressed comments", async () => {
      await handler.createFollowUpTask("FN-001", mockPrInfo, []);

      expect(mockStore.createTask).not.toHaveBeenCalled();
    });

    it("summarizes multiple comments", async () => {
      await handler.createFollowUpTask("FN-001", mockPrInfo, [
        {
          id: 1,
          body: "First issue to fix",
          user: { login: "reviewer1" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
        {
          id: 2,
          body: "Second issue",
          user: { login: "reviewer2" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-2",
        },
      ]);

      const call = (mockStore.createTask as ReturnType<typeof vi.fn>).mock.calls[0];
      const description = call[0].description as string;

      expect(description).toContain("@reviewer1");
      expect(description).toContain("@reviewer2");
      expect(description).toContain("First issue");
      expect(description).toContain("Second issue");
    });

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-20:10 (#2770 review — the SECOND copy, which I converted and did not cover):
    `PrCommentHandler` carries the same dedup as `eval-followups.ts` and I converted both in one commit,
    then wrote a regression case for only one of them. That is the Surface Enumeration rule I had just
    accepted on #2766 and repeated in the very next PR, which is why this case exists rather than an
    argument that the other file's coverage generalises.

    The reuse case below uses `todo` — open under both the old literal and the resolved answer, so it
    cannot tell them apart. This one puts the prior follow-up in a RENAMED complete lane, where they
    disagree: keyed on {done, archived} the finished card reads as open and blocks the new one forever.

    REVERT CHECK, measured: restoring the literal pair here fails this with `createTask` never called.
    */
    it("files a fresh PR follow-up when the prior one finished in a RENAMED complete lane", async () => {
      (mockStore.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([{
        id: "FN-finished",
        column: "shipped",
        description: "finished pr follow-up",
        sourceParentTaskId: "FN-001",
        sourceMetadata: { prNumber: 42 },
      }]);
      (mockStore.getTaskWorkflowSelection as ReturnType<typeof vi.fn>).mockReturnValue({ workflowId: "wf-renamed", stepIds: [] });
      (mockStore.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({
        ir: {
          version: "v2",
          id: "wf-renamed",
          name: "renamed",
          nodes: [],
          edges: [],
          columns: [
            { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
            { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
          ],
        },
      });

      await handler.createFollowUpTask("FN-001", mockPrInfo, [
        {
          id: 1,
          body: "This needs fixing",
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      expect(mockStore.createTask).toHaveBeenCalled();
    });

    it("reuses an existing PR follow-up when the same parent/prNumber is still open", async () => {
      (mockStore.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([{
        id: "FN-existing",
        column: "todo",
        description: "existing pr follow-up",
        sourceParentTaskId: "FN-001",
        sourceMetadata: { prNumber: 42 },
      }]);
      (mockStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "FN-existing", log: [] } as unknown as Task);

      await handler.createFollowUpTask("FN-001", mockPrInfo, [
        {
          id: 1,
          body: "This needs fixing",
          user: { login: "reviewer" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        },
      ]);

      // FNXC:PullRequestReview 2026-07-26-00:00: the "[verification recurrence]" logEntry
      // assertion here belonged to the deleted shared follow-up dedup engine (which wrote a
      // rate-limited recurrence note onto the reused card). The inlined dedup only has to
      // prove no duplicate card is filed for the same parent/prNumber, which is asserted above.
      expect(mockStore.createTask).not.toHaveBeenCalled();
    });
  });
});
