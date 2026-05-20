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

      expect(mockStore.createTask).toHaveBeenCalledWith({
        title: "Follow-up: Address PR #42 feedback",
        description: expect.stringContaining("FN-001"),
        column: "triage",
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

      expect(mockStore.createTask).not.toHaveBeenCalled();
      expect(mockStore.logEntry).toHaveBeenCalledWith(
        "FN-existing",
        expect.stringContaining("[verification recurrence] signature=none"),
        expect.stringContaining("kind=pr-comment; parentTaskId=FN-001"),
      );
    });
  });
});
