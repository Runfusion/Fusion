import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {writePromptFileAtomic} from "../task-store/prompt-file.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fusion-prompt-atomic-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function* walkTypeScriptFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.name === "__tests__" || entry.name === "__test-utils__") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkTypeScriptFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield path;
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

describe("writePromptFileAtomic", () => {
  it("creates a fresh parent and overwrites byte-identically", async () => {
    const root = await makeTemporaryDirectory();
    const promptPath = join(root, "nested", "PROMPT.md");
    const initial = "# Task\n\nFirst plan 🚀\n";
    const replacement = "# Task\n\nReplacement plan\n";

    await writePromptFileAtomic(promptPath, initial);
    expect(await readFile(promptPath, "utf8")).toBe(initial);

    await writePromptFileAtomic(promptPath, replacement);
    expect(await readFile(promptPath, "utf8")).toBe(replacement);
  });

  it("never exposes an empty or prefix-truncated plan during replacement", async () => {
    const root = await makeTemporaryDirectory();
    const promptPath = join(root, "PROMPT.md");
    const initial = "# Original\n\n## What This Delivers\n\nStable summary\n";
    const replacement = `${"x".repeat(96 * 1024)}\n## What This Delivers\n\n${"new plan\n".repeat(64 * 1024)}`;
    await writeFile(promptPath, initial);

    let writeSettled = false;
    const observed: string[] = [];
    const publication = writePromptFileAtomic(promptPath, replacement).finally(() => {
      writeSettled = true;
    });
    while (!writeSettled) {
      observed.push(await readFile(promptPath, "utf8"));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await publication;

    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((sample) => sample === initial || sample === replacement)).toBe(true);
    expect(await readFile(promptPath, "utf8")).toBe(replacement);
  });

  it("cleans its temporary file when rename fails", async () => {
    const root = await makeTemporaryDirectory();
    const promptPath = join(root, "PROMPT.md");
    await mkdir(promptPath);
    await writeFile(join(promptPath, "marker"), "untouched");

    await expect(writePromptFileAtomic(promptPath, "replacement")).rejects.toThrow();

    expect(await readFile(join(promptPath, "marker"), "utf8")).toBe("untouched");
    const siblings = await readdir(root);
    expect(siblings.filter((name) => name.startsWith("PROMPT.md.") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("routes every production PROMPT.md writer through the atomic helper", async () => {
    const sourceRoot = join(import.meta.dirname, "..");
    const bareWriters: string[] = [];
    const atomicWriterModules: string[] = [];

    for await (const file of walkTypeScriptFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      if (basename(file) !== "prompt-file.ts") {
        const writesPromptPath = /writeFile\s*\(\s*promptPath\b/.test(source);
        const writesInlinePrompt = /writeFile\s*\(\s*join\([^)]*["']PROMPT\.md["']/.test(source);
        if (writesPromptPath || writesInlinePrompt) bareWriters.push(file);
      }
      if (source.includes("writePromptFileAtomic(")) atomicWriterModules.push(file);
    }

    expect(bareWriters).toEqual([]);
    expect(atomicWriterModules.map((file) => basename(file)).sort()).toEqual([
      "archive-lifecycle-2.ts",
      "branch-and-pr-entities.ts",
      "project-store-ops.ts",
      "prompt-file.ts",
      "task-creation.ts",
      "task-update.ts",
      "update-task-deps.ts",
    ]);
  });
});
