import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDocument, TaskStore } from "@fusion/core";
import {
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
} from "../agent-tools.js";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual("@fusion/core");
  return {
    ...actual,
  };
});

const TASK_ID = "FN-1272";

type DocStore = Pick<TaskStore, "upsertTaskDocument" | "getTaskDocument" | "getTaskDocuments">;

function createMockDocument(overrides: Partial<TaskDocument> = {}): TaskDocument {
  return {
    id: "doc-1",
    taskId: TASK_ID,
    key: "plan",
    content: "Initial plan content",
    revision: 1,
    author: "agent",
    createdAt: "2026-04-08T12:00:00.000Z",
    updatedAt: "2026-04-08T12:00:00.000Z",
    ...overrides,
  };
}

function createMockStore(overrides: Partial<DocStore> = {}) {
  const upsertTaskDocument = vi.fn<DocStore["upsertTaskDocument"]>();
  const getTaskDocument = vi.fn<DocStore["getTaskDocument"]>();
  const getTaskDocuments = vi.fn<DocStore["getTaskDocuments"]>();

  const store: TaskStore = {
    upsertTaskDocument,
    getTaskDocument,
    getTaskDocuments,
    ...overrides,
  } as unknown as TaskStore;

  return {
    store,
    upsertTaskDocument,
    getTaskDocument,
    getTaskDocuments,
  };
}

async function runTool(
  tool: { execute: (...args: any[]) => Promise<any> },
  callId: string,
  params: Record<string, unknown>,
) {
  return tool.execute(callId, params, undefined as any, undefined as any, undefined as any);
}

function getText(result: any): string {
  const first = result?.content?.[0];
  return first?.type === "text" ? first.text : "";
}

describe("task_document_write tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls store.upsertTaskDocument with taskId, key, content, and author", async () => {
    const { store, upsertTaskDocument } = createMockStore();
    upsertTaskDocument.mockResolvedValue(
      createMockDocument({ key: "plan", content: "Refined implementation plan", revision: 3, author: "triage-agent" }),
    );

    const tool = createTaskDocumentWriteTool(store, TASK_ID);
    const result = await runTool(tool, "call-1", {
      key: "plan",
      content: "Refined implementation plan",
      author: "triage-agent",
    });

    expect(upsertTaskDocument).toHaveBeenCalledWith(TASK_ID, {
      key: "plan",
      content: "Refined implementation plan",
      author: "triage-agent",
    });
    expect(getText(result)).toContain("Saved document \"plan\"");
    expect(getText(result)).toContain("revision 3");
  });

  it("defaults author to agent when not provided", async () => {
    const { store, upsertTaskDocument } = createMockStore();
    upsertTaskDocument.mockResolvedValue(createMockDocument({ key: "notes", revision: 2 }));

    const tool = createTaskDocumentWriteTool(store, TASK_ID);
    await runTool(tool, "call-2", {
      key: "notes",
      content: "Executor notes",
    });

    expect(upsertTaskDocument).toHaveBeenCalledWith(TASK_ID, {
      key: "notes",
      content: "Executor notes",
      author: "agent",
    });
  });

  it("returns a user-facing error message for invalid key validation errors", async () => {
    const { store, upsertTaskDocument } = createMockStore();
    upsertTaskDocument.mockRejectedValue(
      new Error("Invalid document key: \"invalid key\". Must be 1-64 characters: letters, digits, hyphens, or underscores."),
    );

    const tool = createTaskDocumentWriteTool(store, TASK_ID);
    const result = await runTool(tool, "call-3", {
      key: "invalid key",
      content: "anything",
      author: "agent",
    });

    expect(getText(result)).toContain("ERROR: Failed to save document");
    expect(getText(result)).toContain("Invalid document key");
  });

  it("returns a user-facing error message for store errors", async () => {
    const { store, upsertTaskDocument } = createMockStore();
    upsertTaskDocument.mockRejectedValue(new Error("database temporarily unavailable"));

    const tool = createTaskDocumentWriteTool(store, TASK_ID);
    const result = await runTool(tool, "call-4", {
      key: "research",
      content: "Notes",
      author: "agent",
    });

    expect(getText(result)).toContain("ERROR: Failed to save document");
    expect(getText(result)).toContain("database temporarily unavailable");
  });

  it("returns archived read-only details when document writes are blocked", async () => {
    const { store, upsertTaskDocument } = createMockStore();
    upsertTaskDocument.mockRejectedValue(new Error("Task FN-007 is archived — documents are read-only"));

    const tool = createTaskDocumentWriteTool(store, TASK_ID);
    const result = await runTool(tool, "call-archived", {
      key: "research",
      content: "Notes",
      author: "agent",
    });

    expect(getText(result)).toContain("ERROR: Failed to save document");
    expect(getText(result)).toContain("archived");
  });
});

describe("task_document_read tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads a specific document by key and returns content", async () => {
    const { store, getTaskDocument } = createMockStore();
    getTaskDocument.mockResolvedValue(
      createMockDocument({ key: "plan", content: "Detailed execution checklist", revision: 4 }),
    );

    const tool = createTaskDocumentReadTool(store, TASK_ID);
    const result = await runTool(tool, "call-5", { key: "plan" });

    expect(getTaskDocument).toHaveBeenCalledWith(TASK_ID, "plan");
    expect(getText(result)).toContain("Document: plan");
    expect(getText(result)).toContain("Revision: 4");
    expect(getText(result)).toContain("Detailed execution checklist");
  });

  it("returns not found message when the requested key does not exist", async () => {
    const { store, getTaskDocument } = createMockStore();
    getTaskDocument.mockResolvedValue(null);

    const tool = createTaskDocumentReadTool(store, TASK_ID);
    const result = await runTool(tool, "call-6", { key: "plan" });

    expect(getTaskDocument).toHaveBeenCalledWith(TASK_ID, "plan");
    expect(getText(result)).toContain("Document \"plan\" not found.");
  });

  it("lists all documents when no key is provided", async () => {
    const { store, getTaskDocuments } = createMockStore();
    getTaskDocuments.mockResolvedValue([
      createMockDocument({ key: "plan", revision: 2, updatedAt: "2026-04-08T12:15:00.000Z" }),
      createMockDocument({ key: "research", revision: 1, updatedAt: "2026-04-08T12:30:00.000Z" }),
    ]);

    const tool = createTaskDocumentReadTool(store, TASK_ID);
    const result = await runTool(tool, "call-7", {});

    expect(getTaskDocuments).toHaveBeenCalledWith(TASK_ID);
    expect(getText(result)).toContain("Task documents:");
    expect(getText(result)).toContain("- plan (revision 2, updated 2026-04-08T12:15:00.000Z)");
    expect(getText(result)).toContain("- research (revision 1, updated 2026-04-08T12:30:00.000Z)");
  });

  it("returns a no-documents message when list is empty", async () => {
    const { store, getTaskDocuments } = createMockStore();
    getTaskDocuments.mockResolvedValue([]);

    const tool = createTaskDocumentReadTool(store, TASK_ID);
    const result = await runTool(tool, "call-8", {});

    expect(getTaskDocuments).toHaveBeenCalledWith(TASK_ID);
    expect(getText(result)).toBe("No documents found for this task.");
  });

  it("returns a user-facing error message for read failures", async () => {
    const { store, getTaskDocuments } = createMockStore();
    getTaskDocuments.mockRejectedValue(new Error("read timeout"));

    const tool = createTaskDocumentReadTool(store, TASK_ID);
    const result = await runTool(tool, "call-9", {});

    expect(getText(result)).toContain("ERROR: Failed to read task documents");
    expect(getText(result)).toContain("read timeout");
  });
});

describe("document tool factory integration", () => {
  it("uses the provided store instance across write and read tools", async () => {
    const { store, upsertTaskDocument, getTaskDocument, getTaskDocuments } = createMockStore();
    upsertTaskDocument.mockResolvedValue(createMockDocument({ key: "plan", revision: 1 }));
    getTaskDocument.mockResolvedValue(createMockDocument({ key: "plan", content: "Saved plan", revision: 1 }));
    getTaskDocuments.mockResolvedValue([
      createMockDocument({ key: "plan", revision: 1, updatedAt: "2026-04-08T12:45:00.000Z" }),
    ]);

    const writeTool = createTaskDocumentWriteTool(store, TASK_ID);
    const readTool = createTaskDocumentReadTool(store, TASK_ID);

    await runTool(writeTool, "call-10", { key: "plan", content: "Saved plan" });
    await runTool(readTool, "call-11", { key: "plan" });
    await runTool(readTool, "call-12", {});

    expect(upsertTaskDocument).toHaveBeenCalledTimes(1);
    expect(getTaskDocument).toHaveBeenCalledTimes(1);
    expect(getTaskDocuments).toHaveBeenCalledTimes(1);
  });
});
