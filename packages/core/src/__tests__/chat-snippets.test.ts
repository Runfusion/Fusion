import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobalSettingsStore } from "../config/global-settings.js";
import {
  CHAT_SNIPPET_MAX_ENTRIES,
  CHAT_SNIPPET_MAX_NAME_LENGTH,
  CHAT_SNIPPET_MAX_PROMPT_LENGTH,
  CHAT_SNIPPET_RESERVED_NAMES,
  DEFAULT_GLOBAL_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  isGlobalSettingsKey,
  normalizeChatSnippetName,
  normalizeChatSnippets,
  readChatSnippets,
} from "../config/settings-schema.js";

describe("chat snippet normalization", () => {
  it("returns a fresh empty list for absent, null, and non-array values", () => {
    const absent = readChatSnippets({});
    const secondAbsent = readChatSnippets({});

    expect(absent).toEqual([]);
    expect(absent).not.toBe(secondAbsent);
    expect(readChatSnippets({ chatSnippets: null })).toEqual([]);
    expect(readChatSnippets({ chatSnippets: { name: "test", prompt: "prompt" } })).toEqual([]);
  });

  it("drops non-object array entries", () => {
    expect(normalizeChatSnippets([null, "test", 42, [], { name: "valid", prompt: "keep" }])).toEqual([
      { name: "valid", prompt: "keep" },
    ]);
  });

  it("canonicalizes names with NFKC, trim, and lowercase while accepting Unicode", () => {
    expect(normalizeChatSnippetName("  ＴeＳt  ")).toBe("test");
    expect(normalizeChatSnippetName("  ÉTAPЕ_二-2  ")).toBe("étapе_二-2");
    expect(normalizeChatSnippets([{ name: "  ＴeＳt  ", prompt: "keep exactly" }])).toEqual([
      { name: "test", prompt: "keep exactly" },
    ]);
  });

  it("rejects empty, too-long, spaced, and punctuated names", () => {
    expect(normalizeChatSnippetName("   ")).toBeNull();
    expect(normalizeChatSnippetName("a".repeat(CHAT_SNIPPET_MAX_NAME_LENGTH + 1))).toBeNull();
    expect(normalizeChatSnippetName("two words")).toBeNull();
    expect(normalizeChatSnippetName("test!")).toBeNull();
    expect(normalizeChatSnippetName("name/child")).toBeNull();
  });

  it.each(CHAT_SNIPPET_RESERVED_NAMES)("rejects the reserved name %s", (name) => {
    expect(normalizeChatSnippetName(name)).toBeNull();
    expect(normalizeChatSnippetName(name.toUpperCase())).toBeNull();
  });

  it("rejects blank and oversized prompts without truncating valid text", () => {
    const prefix = "  exact internal spaces\nand emoji 😀  ";
    const exactPrompt = `${prefix}${"x".repeat(CHAT_SNIPPET_MAX_PROMPT_LENGTH - prefix.length)}`;

    expect(normalizeChatSnippets([
      { name: "empty", prompt: "" },
      { name: "blank", prompt: " \n\t " },
      { name: "long", prompt: "x".repeat(CHAT_SNIPPET_MAX_PROMPT_LENGTH + 1) },
      { name: "exact", prompt: exactPrompt },
    ])).toEqual([{ name: "exact", prompt: exactPrompt }]);
    expect(exactPrompt).toHaveLength(CHAT_SNIPPET_MAX_PROMPT_LENGTH);
  });

  it("keeps the first valid canonical duplicate", () => {
    expect(normalizeChatSnippets([
      { name: "ＴＥＳＴ", prompt: "first" },
      { name: "test", prompt: "second" },
      { name: "other", prompt: "third" },
    ])).toEqual([
      { name: "test", prompt: "first" },
      { name: "other", prompt: "third" },
    ]);
  });

  it("keeps at most 50 valid entries in input order", () => {
    const input = Array.from({ length: CHAT_SNIPPET_MAX_ENTRIES + 1 }, (_, index) => ({
      name: `snippet-${index}`,
      prompt: `prompt ${index}`,
    }));

    const normalized = normalizeChatSnippets(input);
    expect(normalized).toHaveLength(CHAT_SNIPPET_MAX_ENTRIES);
    expect(normalized[0]?.name).toBe("snippet-0");
    expect(normalized.at(-1)?.name).toBe("snippet-49");
  });

  it("returns deep fresh copies that cannot alias the source or later reads", () => {
    const source = [{ name: "beta", prompt: "second" }, { name: "alpha", prompt: "first" }];
    const first = readChatSnippets({ chatSnippets: source });
    first.sort((left, right) => left.name.localeCompare(right.name));
    first[0]!.name = "mutated";
    first[0]!.prompt = "mutated prompt";

    const second = readChatSnippets({ chatSnippets: source });
    expect(second).toEqual([
      { name: "beta", prompt: "second" },
      { name: "alpha", prompt: "first" },
    ]);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(source[0]);
    expect(DEFAULT_GLOBAL_SETTINGS.chatSnippets).toBeUndefined();
  });

  it("registers chatSnippets as a global settings key", () => {
    expect(GLOBAL_SETTINGS_KEYS).toContain("chatSnippets");
    expect(isGlobalSettingsKey("chatSnippets")).toBe(true);
  });
});

describe("GlobalSettingsStore chat snippets", () => {
  let dir: string;
  let store: GlobalSettingsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fusion-chat-snippets-"));
    store = new GlobalSettingsStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads malformed on-disk JSON as an empty effective snippet list", async () => {
    await writeFile(join(dir, "settings.json"), "{invalid json", "utf8");
    store.invalidateCache();

    expect(readChatSnippets(await store.getSettings())).toEqual([]);
  });

  it("canonicalizes writes and returns them from a fresh store read", async () => {
    await store.updateSettings({
      chatSnippets: [
        { name: "  ＴＥＳＴ  ", prompt: "  preserve me\nexactly 😀  " },
        { name: "steer", prompt: "reserved" },
      ],
    });

    const freshStore = new GlobalSettingsStore(dir);
    expect(readChatSnippets(await freshStore.getSettings())).toEqual([
      { name: "test", prompt: "  preserve me\nexactly 😀  " },
    ]);
  });

  it("preserves null-as-delete and reads the deleted key as an empty list", async () => {
    await store.updateSettings({ chatSnippets: [{ name: "test", prompt: "prompt" }] });
    await store.updateSettings({ chatSnippets: null } as unknown as Partial<import("../types.js").GlobalSettings> & Record<string, unknown>);

    const freshStore = new GlobalSettingsStore(dir);
    expect(readChatSnippets(await freshStore.getSettings())).toEqual([]);
    expect(await freshStore.readRaw()).not.toHaveProperty("chatSnippets");
  });
});
