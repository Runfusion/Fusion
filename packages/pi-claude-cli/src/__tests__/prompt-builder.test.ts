import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildPrompt, buildResumePrompt } from "../prompt-builder";

describe("buildPrompt", () => {
  it("returns empty string for empty messages array", () => {
    const context = { messages: [] } as unknown as any;
    expect(buildPrompt(context)).toBe("");
  });

  it("produces 'USER:\\n{text}' for a single user text message", () => {
    const context = {
      messages: [{ role: "user", content: "Hello world" }],
    } as unknown as any;
    expect(buildPrompt(context)).toBe("USER:\nHello world");
  });

  it("produces 'ASSISTANT:\\n{text}' for a single assistant text message", () => {
    const context = {
      messages: [{ role: "assistant", content: "Hi there" }],
    } as unknown as any;
    expect(buildPrompt(context)).toBe("ASSISTANT:\nHi there");
  });

  it("produces 'TOOL RESULT ({claudeName}):\\n{content}' for a tool result message", () => {
    const context = {
      messages: [
        {
          role: "toolResult",
          content: "file contents here",
          toolName: "read",
        },
      ],
    } as unknown as any;
    // Pi tool name "read" should be mapped to Claude name "Read" in the label
    expect(buildPrompt(context)).toBe(
      "TOOL RESULT (Read):\nfile contents here",
    );
  });

  it("produces correctly ordered labeled blocks for mixed conversation", () => {
    const context = {
      messages: [
        { role: "user", content: "What is in file.ts?" },
        { role: "assistant", content: "Let me read that file." },
        {
          role: "toolResult",
          content: "export const x = 1;",
          toolName: "read",
        },
        { role: "user", content: "Now explain it." },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    const expected = [
      "USER:",
      "What is in file.ts?",
      "ASSISTANT:",
      "Let me read that file.",
      "TOOL RESULT (Read):",
      "export const x = 1;",
      "USER:",
      "Now explain it.",
    ].join("\n");

    expect(result).toBe(expected);
  });

  it("extracts text from array content blocks in user messages", () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "First block" },
            { type: "text", text: "Second block" },
          ],
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    expect(result).toBe("USER:\nFirst block\nSecond block");
  });

  it("serializes assistant mixed content (text + thinking + toolCall) with Claude name mapping", () => {
    const context = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will help you." },
            { type: "thinking", thinking: "Let me think about this..." },
            {
              type: "toolCall",
              name: "read",
              arguments: { path: "/file.ts" },
            },
          ],
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    expect(result).toContain("ASSISTANT:");
    expect(result).toContain("I will help you.");
    // Thinking content is skipped in prompt replay (internal reasoning)
    expect(result).not.toContain("Let me think about this...");
    // Tool name should be mapped from pi "read" to Claude "Read"
    // Arg "path" should be mapped from pi format to Claude "file_path"
    expect(result).toContain(
      '[Prior tool call — already executed; result follows in TOOL RESULT (Read):] args={"file_path":"/file.ts"}',
    );
  });

  it("inserts placeholder text for image blocks in non-final user messages", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this image" },
            { type: "image", data: "abc", mimeType: "image/png" },
          ],
        },
        { role: "assistant", content: "I see." },
        { role: "user", content: "Now explain it." },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // Non-final user message should have placeholder
    expect(result).toContain(
      "[An image was shared here but could not be included]",
    );
    // Console.warn should be called once with image count
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("1 image(s)");
    warnSpy.mockRestore();
  });

  it("handles toolCall with no arguments (maps pi name to Claude name)", () => {
    const context = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "bash",
            },
          ],
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // Pi "bash" maps to Claude "Bash"
    expect(result).toContain(
      "[Prior tool call — already executed; result follows in TOOL RESULT (Bash):] args={}",
    );
  });

  it("handles tool result with array content blocks", () => {
    const context = {
      messages: [
        {
          role: "toolResult",
          content: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ],
          toolName: "bash",
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    expect(result).toBe("TOOL RESULT (Bash):\nline 1\nline 2");
  });

  describe("tool name and argument reverse mapping", () => {
    it("maps pi tool name to Claude name in toolCall serialization", () => {
      const context = {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "read",
                arguments: { path: "/foo" },
              },
            ],
          },
        ],
      } as unknown as any;

      const result = buildPrompt(context);
      expect(result).toContain("Read");
      expect(result).toContain('"file_path":"/foo"');
    });

    it("translates pi arguments to Claude format for edit tool", () => {
      const context = {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "edit",
                arguments: { path: "/foo.ts", oldText: "old", newText: "new" },
              },
            ],
          },
        ],
      } as unknown as any;

      const result = buildPrompt(context);
      expect(result).toContain("Edit");
      expect(result).toContain('"file_path":"/foo.ts"');
      expect(result).toContain('"old_string":"old"');
      expect(result).toContain('"new_string":"new"');
    });

    it("maps pi tool name to Claude name in tool result label", () => {
      const context = {
        messages: [
          {
            role: "toolResult",
            content: "result text",
            toolName: "read",
          },
        ],
      } as unknown as any;

      const result = buildPrompt(context);
      expect(result).toContain("TOOL RESULT (Read):");
    });

    it("prefixes custom (non-built-in) tool names with MCP prefix", () => {
      const context = {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "custom_tool",
                arguments: { key: "value" },
              },
            ],
          },
        ],
      } as unknown as any;

      const result = buildPrompt(context);
      // Custom tool uses plain name format (not MCP-prefixed to avoid Claude re-calling)
      expect(result).toContain("[Used custom_tool tool with args:");
      expect(result).not.toContain("mcp__custom-tools__");
      expect(result).toContain('"key":"value"');
    });

    it("handles toolCall with string arguments (raw unparsed)", () => {
      const context = {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "read",
                arguments: "raw string args",
              },
            ],
          },
        ],
      } as unknown as any;

      const result = buildPrompt(context);
      // String arguments should be serialized as JSON string
      expect(result).toContain('TOOL RESULT (Read):');
      expect(result).toContain('args="raw string args"');
    });
  });
});

describe("image passthrough (HIST-02)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("single user message with text and image returns ContentBlock[]", () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            { type: "image", data: "base64data", mimeType: "image/png" },
          ],
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // Should return an array (not string) with text + image blocks
    expect(Array.isArray(result)).toBe(true);
    const arr = result as any[];
    expect(arr).toContainEqual({ type: "text", text: "Look at this" });
    expect(arr).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "base64data" },
    });
  });

  it("multi-turn with images only in final user message returns ContentBlock[]", () => {
    const context = {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        {
          role: "user",
          content: [
            { type: "text", text: "Check this" },
            { type: "image", data: "imgdata", mimeType: "image/jpeg" },
          ],
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as any[];
    // First elements should be text blocks for history
    const textBlocks = arr.filter((b: any) => b.type === "text");
    expect(textBlocks.length).toBeGreaterThanOrEqual(2);
    // History text should contain the prior messages
    const historyText = textBlocks[0].text;
    expect(historyText).toContain("USER:");
    expect(historyText).toContain("Hello");
    expect(historyText).toContain("ASSISTANT:");
    expect(historyText).toContain("Hi there");
    // Final user message text block
    expect(arr).toContainEqual({ type: "text", text: "Check this" });
    // Image block in Anthropic format
    expect(arr).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "imgdata" },
    });
  });

  it("multi-turn with images in non-final user message uses placeholder and returns string", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "See this" },
            { type: "image", data: "imgdata", mimeType: "image/png" },
          ],
        },
        { role: "assistant", content: "Noted." },
        { role: "user", content: "What do you think?" },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // No images in final message -> returns string
    expect(typeof result).toBe("string");
    // Non-final user message has placeholder
    expect(result).toContain(
      "[An image was shared here but could not be included]",
    );
    // Console.warn called once with image count
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("1 image(s)");
    warnSpy.mockRestore();
  });

  it("multi-turn with images in both non-final and final user messages", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "First image" },
            { type: "image", data: "img1", mimeType: "image/png" },
          ],
        },
        { role: "assistant", content: "Got it." },
        {
          role: "user",
          content: [
            { type: "text", text: "Second image" },
            { type: "image", data: "img2", mimeType: "image/jpeg" },
          ],
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // Final user message has images -> returns ContentBlock[]
    expect(Array.isArray(result)).toBe(true);
    const arr = result as any[];
    // Non-final user message should have placeholder in the history text
    const textBlocks = arr.filter((b: any) => b.type === "text");
    const historyText = textBlocks[0].text;
    expect(historyText).toContain(
      "[An image was shared here but could not be included]",
    );
    // Final user message image translated to Anthropic format
    expect(arr).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "img2" },
    });
    // Console.warn called with count of placeholder images (1 placeholder)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("1 image(s)");
    warnSpy.mockRestore();
  });

  it("no images returns string (backward compatible)", () => {
    const context = {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "How are you?" },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    expect(typeof result).toBe("string");
    expect(result).toContain("USER:");
    expect(result).toContain("Hello");
  });

  it("image block without data/mimeType uses placeholder", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Broken image" },
            { type: "image" }, // Missing data and mimeType
          ],
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // Invalid image in final message should fall back to placeholder -> string
    // The single user message IS the final message, but image is invalid
    // so it falls back to placeholder text block
    if (Array.isArray(result)) {
      // If still returns array, image should be a text placeholder
      const hasImageBlock = result.some((b: any) => b.type === "image");
      expect(hasImageBlock).toBe(false);
    } else {
      expect(result).toContain(
        "[An image was shared here but could not be included]",
      );
    }
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("buildPrompt with custom tool result prompt (images in earlier messages) returns string", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Run this" },
            { type: "image", data: "imgdata", mimeType: "image/png" },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "deploy",
              arguments: { target: "prod" },
            },
          ],
        },
        {
          role: "toolResult",
          content: "Deploy succeeded",
          toolName: "deploy",
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // Custom tool result prompt always returns string
    expect(typeof result).toBe("string");
    warnSpy.mockRestore();
  });
});

describe("tool result image handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tool result with image block triggers ContentBlock[] path with image passthrough", () => {
    const context = {
      messages: [
        {
          role: "user",
          content: "explain this image C:\\temp\\screenshot.png",
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { path: "C:\\temp\\screenshot.png" },
            },
          ],
        },
        {
          role: "toolResult",
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
          toolName: "read",
        },
        { role: "user", content: "what does that code do?" },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // Tool result has image -> should return ContentBlock[] so Claude sees the image
    expect(Array.isArray(result)).toBe(true);
    const arr = result as any[];
    // Should contain the translated image block from tool result
    expect(arr).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  it("tool result image in string path gets placeholder text", () => {
    const _warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = {
      messages: [
        { role: "user", content: "read that file" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { path: "photo.jpg" },
            },
          ],
        },
        {
          role: "toolResult",
          content: [
            { type: "text", text: "Read image file" },
            { type: "image", data: "base64jpg", mimeType: "image/jpeg" },
          ],
          toolName: "read",
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // No images in final user message, no images in user content at all
    // But tool result has image -> should still handle it
    // At minimum: placeholder text so Claude knows image existed
    if (typeof result === "string") {
      expect(result).toContain(
        "[An image was shared here but could not be included]",
      );
    } else {
      // Or ContentBlock[] with actual image
      expect(result).toContainEqual(expect.objectContaining({ type: "image" }));
    }
  });

  it("tool result with only text blocks works as before", () => {
    const context = {
      messages: [
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "read", arguments: { path: "test.txt" } },
          ],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "file contents here" }],
          toolName: "read",
        },
        { role: "user", content: "summarize it" },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // No images anywhere -> should return string
    expect(typeof result).toBe("string");
    expect(result).toContain("file contents here");
  });
});

describe("custom tool history replay", () => {
  it("toolCall with custom tool name 'deploy' uses plain format (no MCP prefix)", () => {
    const context = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "deploy",
              arguments: { target: "prod" },
            },
          ],
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    expect(result).toContain("[Used deploy tool with args:");
    expect(result).toContain('"target":"prod"');
    expect(result).not.toContain("mcp__custom-tools__");
  });

  it("toolCall with built-in name 'read' still produces 'Read' (not MCP-prefixed)", () => {
    const context = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { path: "/foo" },
            },
          ],
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    expect(result).toContain("Read");
    expect(result).not.toContain("mcp__custom-tools__read");
  });

  it("toolResult for custom tool 'deploy' uses plain name (no MCP prefix)", () => {
    const context = {
      messages: [
        {
          role: "toolResult",
          content: "deployment succeeded",
          toolName: "deploy",
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    expect(result).toContain("TOOL RESULT (deploy):");
    expect(result).not.toContain("mcp__custom-tools__");
  });

  it("toolResult for built-in 'read' still produces TOOL RESULT with Claude name", () => {
    const context = {
      messages: [
        {
          role: "toolResult",
          content: "file contents",
          toolName: "read",
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    expect(result).toContain("TOOL RESULT (Read):");
    expect(result).not.toContain("mcp__custom-tools__");
  });

  it("custom tool arguments pass through without translation", () => {
    const context = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "deploy",
              arguments: { target: "prod", force: true },
            },
          ],
        },
      ],
    } as unknown as any;

    const result = buildPrompt(context);
    // Custom tool args should pass through unchanged (no renames)
    expect(result).toContain('"target":"prod"');
    expect(result).toContain('"force":true');
  });
});

describe("buildSystemPrompt", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns context systemPrompt when no AGENTS.md found", async () => {
    // Mock fs to not find any AGENTS.md
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: () => "",
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [],
    } as unknown as any;
    const result = bsp(context, "/some/project/path");
    expect(result).toContain("You are a helpful assistant.");
  });

  it("appends AGENTS.md content when found", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (path: string) => path.endsWith("AGENTS.md"),
      readFileSync: () => "# Agent Instructions\nDo things carefully.",
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = {
      systemPrompt: "Base prompt.",
      messages: [],
    } as unknown as any;
    const result = bsp(context, "/some/project");
    expect(result).toContain("Base prompt.");
    expect(result).toContain("Agent Instructions");
    expect(result).toContain("Do things carefully.");
  });

  it("sanitizes .pi references to .claude in AGENTS.md content", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (path: string) => path.endsWith("AGENTS.md"),
      readFileSync: () => "Check ~/.pi/config and .pi/settings for details.",
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = { systemPrompt: "Base.", messages: [] } as unknown as any;
    const result = bsp(context, "/some/project");
    expect(result).toContain("~/.claude");
    expect(result).toContain(".claude/settings");
    expect(result).not.toContain(".pi/");
  });

  it("returns empty string when no systemPrompt and no AGENTS.md", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: () => "",
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = { messages: [] } as unknown as any;
    const result = bsp(context, "/some/project");
    expect(result).toBe("");
  });

  it("walks up directories to find AGENTS.md in parent", async () => {
    // Only the parent directory's AGENTS.md exists, not the cwd
    vi.doMock("node:fs", () => ({
      existsSync: (path: string) => {
        // Only parent path has AGENTS.md
        if (path.includes("parent") && path.endsWith("AGENTS.md")) return true;
        return false;
      },
      readFileSync: () => "# Parent AGENTS.md\nInstructions from parent.",
    }));
    vi.doMock("node:path", async () => {
      const actual =
        await vi.importActual<typeof import("node:path")>("node:path");
      return {
        ...actual,
        resolve: (p: string) => p,
        join: (...args: string[]) => args.join("/"),
        dirname: (p: string) => {
          // Simulate walking up: /a/b/parent/child -> /a/b/parent -> /a/b -> etc.
          const parts = p.split("/").filter(Boolean);
          if (parts.length <= 1) return p; // root
          return "/" + parts.slice(0, -1).join("/");
        },
      };
    });

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = {
      systemPrompt: "Base.",
      messages: [],
    } as unknown as any;
    const result = bsp(context, "/a/b/parent/child");
    expect(result).toContain("Parent AGENTS.md");
    expect(result).toContain("Instructions from parent.");
  });

  it("sanitizes empty AGENTS.md content gracefully", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (path: string) => path.endsWith("AGENTS.md"),
      readFileSync: () => "",
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = {
      systemPrompt: "Base prompt.",
      messages: [],
    } as unknown as any;
    const result = bsp(context, "/some/project");
    // Empty AGENTS.md content should just produce the base prompt
    expect(result).toContain("Base prompt.");
  });

  it("sanitizes AGENTS.md with only whitespace content", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (path: string) => path.endsWith("AGENTS.md"),
      readFileSync: () => "   \n\n  \t  \n",
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = {
      systemPrompt: "Base.",
      messages: [],
    } as unknown as any;
    const result = bsp(context, "/some/project");
    expect(result).toContain("Base.");
  });

  it("sanitizes AGENTS.md with special regex characters", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (path: string) => path.endsWith("AGENTS.md"),
      readFileSync: () =>
        "Config at ~/.pi/settings.json and .pi/rules/*.md files.",
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = {
      systemPrompt: "",
      messages: [],
    } as unknown as any;
    const result = bsp(context, "/some/project");
    expect(result).toContain("~/.claude/settings.json");
    expect(result).toContain(".claude/rules/*.md");
    expect(result).not.toContain(".pi/");
  });

  it("handles readFileSync error gracefully (skip silently)", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (path: string) => path.endsWith("AGENTS.md"),
      readFileSync: () => {
        throw new Error("EACCES: permission denied");
      },
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = {
      systemPrompt: "Base prompt.",
      messages: [],
    } as unknown as any;
    const result = bsp(context, "/some/project");
    // Should still return the base prompt despite read error
    expect(result).toContain("Base prompt.");
    // Should not include any AGENTS.md content
    expect(result).not.toContain("EACCES");
  });

  it("appends tool result instruction when messages contain toolResult", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: () => "",
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = {
      systemPrompt: "Base prompt.",
      messages: [
        { role: "user", content: "read the file" },
        {
          role: "toolResult",
          content: "file contents here",
          toolName: "read",
        },
      ],
    } as unknown as any;
    const result = bsp(context, "/some/project");
    expect(result).toContain("IMPORTANT:");
    expect(result).toContain("tool results");
  });

  it("rewrites bare custom tool references to MCP-prefixed names", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: () => "",
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = {
      systemPrompt:
        "Write the PROMPT.md, then call `fn_review_spec()` for review. " +
        "If REVISE, call fn_review_spec again. Do not call mcp__custom-tools__fn_review_spec twice manually.",
      messages: [],
      tools: [
        { name: "fn_review_spec", description: "review", parameters: {} },
        { name: "read", description: "builtin", parameters: {} },
      ],
    } as unknown as any;
    const result = bsp(context, "/some/project");

    // Bare name occurrences are rewritten
    expect(result).toContain(
      "call `mcp__custom-tools__fn_review_spec()` for review",
    );
    expect(result).toContain(
      "call mcp__custom-tools__fn_review_spec again",
    );
    // Already-prefixed occurrence is not double-prefixed
    expect(result).not.toContain(
      "mcp__custom-tools__mcp__custom-tools__fn_review_spec",
    );
    // Built-in pi tool names are not rewritten
    expect(result).not.toContain("mcp__custom-tools__read");
    // The addendum still lists the custom tool with its full mapping
    expect(result).toContain("mcp__custom-tools__fn_review_spec");
  });

  it("does not rewrite identifier substrings that happen to overlap a tool name", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: () => "",
    }));

    const { buildSystemPrompt: bsp } = await import("../prompt-builder");
    const context = {
      systemPrompt: "fn_review_specifier and fn_reviews are not the tool.",
      messages: [],
      tools: [
        { name: "fn_review", description: "x", parameters: {} },
        { name: "fn_review_spec", description: "y", parameters: {} },
      ],
    } as unknown as any;
    const result = bsp(context, "/some/project");
    // Neither substring should be rewritten — they're different identifiers.
    expect(result).toContain("fn_review_specifier");
    expect(result).toContain("fn_reviews");
    expect(result).not.toContain("mcp__custom-tools__fn_review_specifier");
    expect(result).not.toContain("mcp__custom-tools__fn_reviews");
  });
});

describe("buildResumePrompt", () => {
  it("returns empty string for empty messages array", () => {
    expect(buildResumePrompt({ messages: [] })).toBe("");
  });

  it("returns just the user message text for a single user message", () => {
    const context = {
      messages: [{ role: "user", content: "Hello world" }],
    };
    expect(buildResumePrompt(context)).toBe("Hello world");
  });

  it("extracts only the last user message from a multi-turn conversation", () => {
    const context = {
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Follow-up question" },
      ],
    };
    expect(buildResumePrompt(context)).toBe("Follow-up question");
  });

  it("includes tool results preceding the final user message", () => {
    const context = {
      messages: [
        { role: "user", content: "Read a file" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { path: "/foo.ts" },
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "read",
          content: "file contents here",
        },
        { role: "user", content: "Now explain it" },
      ],
    };
    const result = buildResumePrompt(context) as string;
    expect(result).toContain("TOOL RESULT (Read):");
    expect(result).toContain("file contents here");
    expect(result).toContain("Now explain it");
  });

  it("includes multiple tool results preceding the final user message", () => {
    const context = {
      messages: [
        { role: "user", content: "Read two files" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { path: "/a.ts" },
            },
            {
              type: "toolCall",
              name: "read",
              arguments: { path: "/b.ts" },
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "read",
          content: "contents of a",
        },
        {
          role: "toolResult",
          toolName: "read",
          content: "contents of b",
        },
        { role: "user", content: "Compare them" },
      ],
    };
    const result = buildResumePrompt(context) as string;
    expect(result).toContain("contents of a");
    expect(result).toContain("contents of b");
    expect(result).toContain("Compare them");
  });

  it("handles custom tool results with plain name format", () => {
    const context = {
      messages: [
        { role: "user", content: "Deploy" },
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "deploy", arguments: {} }],
        },
        {
          role: "toolResult",
          toolName: "deploy",
          content: "Deployed successfully",
        },
        { role: "user", content: "Check status" },
      ],
    };
    const result = buildResumePrompt(context) as string;
    expect(result).toContain("TOOL RESULT (deploy):");
    expect(result).toContain("Deployed successfully");
    expect(result).toContain("Check status");
  });

  it("returns empty string when no user message found", () => {
    const context = {
      messages: [{ role: "assistant", content: "Hello" }],
    };
    expect(buildResumePrompt(context)).toBe("");
  });

  it("handles content blocks array for user message", () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello from blocks" }],
        },
      ],
    };
    expect(buildResumePrompt(context)).toBe("Hello from blocks");
  });

  it("handles images in the final user message by returning ContentBlock[]", () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            {
              type: "image",
              data: "abc123",
              mimeType: "image/png",
            },
          ],
        },
      ],
    };
    const result = buildResumePrompt(context);
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).length).toBe(2);
    expect((result as any[])[0].type).toBe("text");
    expect((result as any[])[1].type).toBe("image");
  });
});
