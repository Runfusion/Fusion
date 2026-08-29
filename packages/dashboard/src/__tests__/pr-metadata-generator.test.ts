import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

const { execMock, promptMock, disposeMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  promptMock: vi.fn(),
  disposeMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: execMock,
  };
});

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  resolveMcpServersForStore: vi.fn().mockResolvedValue({ servers: [], errors: [] }),
  createFnAgent: vi.fn(async () => ({
    session: {
      prompt: promptMock,
      dispose: disposeMock,
    },
  })),
}));

import { createFnAgent } from "@fusion/engine";
import { generatePrMetadata, PR_METADATA_SYSTEM_PROMPT } from "../pr-metadata-generator.js";

function createTask(): Task {
  return {
    id: "FN-4991",
    title: "Route contracts",
    description: "Implement route contracts",
    status: "todo",
    column: "in-progress",
    priority: "normal",
    dependencies: [],
    size: "M",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

function setupExec(outputs: Record<string, string>) {
  execMock.mockImplementation((command: string, _options: unknown, callback: (err: unknown, out: { stdout: string; stderr: string }) => void) => {
    const key = Object.keys(outputs).find((k) => command.includes(k));
    if (!key) {
      callback(null, { stdout: "", stderr: "" });
      return;
    }
    callback(null, { stdout: outputs[key], stderr: "" });
  });
}

function expectFallbackBody(body: string) {
  expect(body).toContain("## Summary");
  expect(body).toContain("## Changes");
  expect(body).toContain("## Testing");
  expect(body).toContain("## Linked Task");
  expect(body).toContain("Closes FN-4991");
}

function capturedSystemPrompt(): string {
  const call = vi.mocked(createFnAgent).mock.calls.at(-1)?.[0] as { systemPrompt?: string } | undefined;
  return call?.systemPrompt ?? "";
}

const BASE_PR_METADATA_SYSTEM_PROMPT = PR_METADATA_SYSTEM_PROMPT;

describe("generatePrMetadata", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "pr-metadata-"));
    mkdirSync(join(repoRoot, ".fusion", "tasks", "FN-4991"), { recursive: true });
    writeFileSync(join(repoRoot, ".fusion", "tasks", "FN-4991", "PROMPT.md"), "# Prompt");
    promptMock.mockResolvedValue(undefined);
    disposeMock.mockReset();
    vi.mocked(createFnAgent).mockImplementation(async ({ onText }: { onText?: (t: string) => void }) => {
      onText?.(JSON.stringify({
        title: "feat: add routes",
        summary: "Summary text",
        changes: "- Change A",
        testing: "- pnpm test",
        linkedTask: "FN-4991",
      }));
      return {
        session: {
          prompt: promptMock,
          dispose: disposeMock,
        },
      } as never;
    });
    setupExec({
      "gh repo view": "main",
      "git log": "commit",
      "git diff --stat": "1 file changed",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("uses the summarizer model lane for PR generation", async () => {
    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {
        titleSummarizerProvider: "anthropic",
        titleSummarizerModelId: "claude-haiku",
        planningProvider: "openai",
        planningModelId: "gpt-4o",
      } as never,
    });

    expect(vi.mocked(createFnAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultProvider: "anthropic",
        defaultModelId: "claude-haiku",
      }),
    );
    expect(result.title).toBe("feat: add routes");
    expect(result.body).toContain("## Summary");
    expect(result.body).toContain("## Changes");
    expect(result.body).toContain("## Testing");
    expect(result.body).toContain("## Linked Task");
    expect(result.templateUsed).toBe(false);
    expect(promptMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("keeps the base PR metadata system prompt unchanged when guidance is unset", async () => {
    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
    });

    expect(capturedSystemPrompt()).toBe(BASE_PR_METADATA_SYSTEM_PROMPT);
    expect(capturedSystemPrompt()).toContain("\"title\": string");
    expect(capturedSystemPrompt()).toContain("\"linkedTask\": string");
    expect(result.title).toBe("feat: add routes");
    expect(result.body).toContain("## Summary");
  });

  it("adds only title guidance when title instructions are set", async () => {
    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: { prTitlePromptInstructions: "  Use conventional commit style.  " } as never,
    });

    expect(capturedSystemPrompt()).toBe(`${BASE_PR_METADATA_SYSTEM_PROMPT}\nTitle guidance: Use conventional commit style.`);
    expect(capturedSystemPrompt()).not.toContain("Description guidance:");
    expect(result.title).toBe("feat: add routes");
    expect(result.body).toContain("- pnpm test");
  });

  it("adds only description guidance when description instructions are set", async () => {
    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: { prDescriptionPromptInstructions: "  Mention user-facing behavior.  " } as never,
    });

    expect(capturedSystemPrompt()).toBe(`${BASE_PR_METADATA_SYSTEM_PROMPT}\nDescription guidance: Mention user-facing behavior.`);
    expect(capturedSystemPrompt()).not.toContain("Title guidance:");
    expect(result.title).toBe("feat: add routes");
    expect(result.body).toContain("Summary text");
  });

  it("adds both title and description guidance when both instructions are set", async () => {
    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {
        prTitlePromptInstructions: "Use release-note tone.",
        prDescriptionPromptInstructions: "Group changes by operator impact.",
      } as never,
    });

    expect(capturedSystemPrompt()).toBe([
      BASE_PR_METADATA_SYSTEM_PROMPT,
      "Title guidance: Use release-note tone.",
      "Description guidance: Group changes by operator impact.",
    ].join("\n"));
    expect(result.title).toBe("feat: add routes");
    expect(result.body).toContain("## Changes");
  });

  it("treats whitespace-only PR prompt guidance as unset", async () => {
    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {
        prTitlePromptInstructions: "   \n\t  ",
        prDescriptionPromptInstructions: "  ",
      } as never,
    });

    expect(capturedSystemPrompt()).toBe(BASE_PR_METADATA_SYSTEM_PROMPT);
    expect(result.title).toBe("feat: add routes");
    expect(result.body).toContain("## Testing");
  });

  it("sends the upgraded prompt contract and keeps all context inputs", async () => {
    await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {
        titleSummarizerProvider: "anthropic",
        titleSummarizerModelId: "claude-haiku",
      } as never,
    });

    expect(PR_METADATA_SYSTEM_PROMPT).toContain("STRICT JSON ONLY");
    expect(PR_METADATA_SYSTEM_PROMPT).toContain("conventional-commit style");
    expect(PR_METADATA_SYSTEM_PROMPT).toContain("at most 72 characters");
    expect(PR_METADATA_SYSTEM_PROMPT).toContain("commit log and diff stat first");
    for (const field of ["title", "summary", "changes", "testing", "linkedTask"]) {
      expect(PR_METADATA_SYSTEM_PROMPT).toContain(field);
    }
    expect(vi.mocked(createFnAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: PR_METADATA_SYSTEM_PROMPT,
      }),
    );

    const contextPrompt = promptMock.mock.calls[0]?.[0] as string;
    expect(contextPrompt).toContain("Ground the PR title, summary, changes, and testing in the commit log and diff stat");
    expect(contextPrompt).toContain("Task ID: FN-4991");
    expect(contextPrompt).toContain("Task title: Route contracts");
    expect(contextPrompt).toContain("Task description: Implement route contracts");
    expect(contextPrompt).toContain("Commit log (source of truth):\n\ncommit");
    expect(contextPrompt).toContain("Diff stat (source of truth):\n\n1 file changed");
    expect(contextPrompt).toContain("Task prompt (supporting context):\n\n# Prompt");
  });

  it("fills known sections when template exists and preserves unknown headings", async () => {
    mkdirSync(join(repoRoot, ".github"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".github", "pull_request_template.md"),
      ["## Summary", "old", "## Unknown", "keep this", "## Testing", "old"].join("\n"),
    );

    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {
        titleSummarizerProvider: "anthropic",
        titleSummarizerModelId: "claude-haiku",
      } as never,
    });

    expect(result.templateUsed).toBe(true);
    expect(result.body).toContain("## Unknown");
    expect(result.body).toContain("keep this");
    expect(result.body).toContain("Summary text");
  });

  it("falls back deterministically when model output is invalid json", async () => {
    vi.mocked(createFnAgent).mockImplementation(async ({ onText }: { onText?: (t: string) => void }) => {
      onText?.("not json");
      return {
        session: {
          prompt: promptMock,
          dispose: disposeMock,
        },
      } as never;
    });

    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {
        titleSummarizerProvider: "anthropic",
        titleSummarizerModelId: "claude-haiku",
      } as never,
    });

    expect(result).toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
    expectFallbackBody(result.body);
  });

  it("returns fallback when createFnAgent times out before a session exists", async () => {
    vi.useFakeTimers();
    vi.mocked(createFnAgent).mockImplementationOnce(() => new Promise(() => undefined) as never);

    const resultPromise = generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
    const result = await resultPromise;
    expectFallbackBody(result.body);
    expect(promptMock).not.toHaveBeenCalled();
    expect(disposeMock).not.toHaveBeenCalled();
  });

  it("returns fallback when prompt times out", async () => {
    vi.useFakeTimers();
    promptMock.mockImplementation(() => new Promise(() => undefined));

    const resultPromise = generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
      timeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
    const result = await resultPromise;
    expectFallbackBody(result.body);
  });

  it("returns fallback immediately when caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
      signal: controller.signal,
    });

    expect(result).toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
    expect(createFnAgent).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("returns fallback when caller aborts mid-generation", async () => {
    const controller = new AbortController();
    vi.mocked(createFnAgent).mockImplementationOnce(() => new Promise(() => undefined) as never);

    const resultPromise = generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
      signal: controller.signal,
    });

    controller.abort();

    await expect(resultPromise).resolves.toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
    const result = await resultPromise;
    expectFallbackBody(result.body);
  });
});
