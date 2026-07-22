/**
 * FNXC:FileScopeClassification 2026-07-21-12:00:
 * Regression for root-level File Scope files with extensions. GitHub issue import
 * embeds the issue body into PROMPT.md; when that body declares `## File Scope`
 * with paths like global.json / Directory.Packages.props / MyApp.slnx, createTask
 * must not throw InvalidFileScopeError, and extractEffectiveWriteScopeFromPrompt
 * must keep all four write targets (not only nested src/... entries).
 *
 * FNXC:FileScopeClassification 2026-07-21-18:05:
 * Also covers fenced repro snippets (GitHub #2389) whose escaped backticks produced
 * tokens like `global.json\` and blocked import via InvalidFileScopeError.
 */
import { describe, expect, it } from "vitest";
import {
  extractEffectiveWriteScopeFromPrompt,
  extractFileScopeTokens,
  isValidFileScopeEntry,
} from "../file-scope-classification.js";
import {
  isValidFileScopeEntry as storeIsValidFileScopeEntry,
  validateFileScopeInPromptContent,
} from "../task-store/file-scope.js";
import { buildBootstrapPrompt } from "../mesh-task-replication.js";

describe("isValidFileScopeEntry", () => {
  it("accepts root-level repo files with letter-leading extensions", () => {
    const roots = [
      "global.json",
      "Directory.Packages.props",
      "MyApp.slnx",
      "MyApp.sln",
      "tsconfig.json",
      "package.json",
      "pnpm-lock.yaml",
      "README.md",
      ".env",
      "AGENTS.md",
    ];
    for (const path of roots) {
      expect(isValidFileScopeEntry(path), path).toBe(true);
      expect(storeIsValidFileScopeEntry(path), `store:${path}`).toBe(true);
    }
  });

  it("accepts nested files, globs, and known extensionless roots", () => {
    const samples = [
      "src/MyApp/Program.cs",
      "packages/core/src/store.ts",
      "packages/engine/src/**/*.ts",
      "packages/dashboard/app/**",
      "Makefile",
      "Dockerfile",
      "foo/Dockerfile",
    ];
    for (const path of samples) {
      expect(isValidFileScopeEntry(path), path).toBe(true);
    }
  });

  it("rejects git refs, absolute paths, bare identifiers, and version-like tokens", () => {
    const rejects = [
      "origin/main",
      "upstream/main",
      "refs/heads/main",
      "https://example.com/repo",
      "git@github.com:org/repo.git",
      "ssh://git@host/repo",
      "feature/fn-123",
      "abc1234",
      "deadbeef",
      "main",
      "todo",
      "v1.2.3",
      "/abs/path.ts",
      "../escape.ts",
      "packages/../secret.ts",
      "",
      "   ",
    ];
    for (const path of rejects) {
      expect(isValidFileScopeEntry(path), JSON.stringify(path)).toBe(false);
    }
  });

  it("keeps create/update validation and classification on the same function", () => {
    expect(storeIsValidFileScopeEntry).toBe(isValidFileScopeEntry);
  });
});

describe("extractEffectiveWriteScopeFromPrompt / validateFileScopeInPromptContent", () => {
  const prompt = `# Task: FN-8459

## File Scope
- \`global.json\`
- \`Directory.Packages.props\`
- \`MyApp.slnx\`
- \`src/MyApp/Program.cs\`

## Steps
- [ ] Implement
`;

  it("includes all four FN-8459-style File Scope entries in effective write scope", () => {
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual([
      "global.json",
      "Directory.Packages.props",
      "MyApp.slnx",
      "src/MyApp/Program.cs",
    ]);
  });

  it("passes create/update File Scope validation for root-level extension paths", () => {
    const { valid, invalid } = validateFileScopeInPromptContent(prompt);
    expect(invalid).toEqual([]);
    expect(valid).toEqual([
      "global.json",
      "Directory.Packages.props",
      "MyApp.slnx",
      "src/MyApp/Program.cs",
    ]);
  });

  it("still rejects git-ref tokens inside File Scope on create/update validation", () => {
    const bad = `## File Scope
- \`packages/core/src/store.ts\`
- \`origin/main\`
`;
    const { valid, invalid } = validateFileScopeInPromptContent(bad);
    expect(valid).toEqual(["packages/core/src/store.ts"]);
    expect(invalid).toEqual(["origin/main"]);
  });

  it("ignores ## File Scope headings inside fenced code blocks (GitHub #2389 repro shape)", () => {
    // Mirrors issue body: fenced TS sample with escaped markdown backticks around paths.
    const issueBody = `## Summary

Root-level File Scope files are dropped.

## Repro (unit-level)

\`\`\`ts
import { extractEffectiveWriteScopeFromPrompt } from "packages/core/src/file-scope-classification";

const prompt = \`
## File Scope

- \\\`global.json\\\` (new)
- \\\`Directory.Packages.props\\\` (new)
- \\\`MyApp.slnx\\\` (new)
- \\\`src/MyApp/Program.cs\\\` (new)
\`;

extractEffectiveWriteScopeFromPrompt(prompt);
// actual:   ["src/MyApp/Program.cs"]
// expected: all four entries
\`\`\`
`;

    expect(extractFileScopeTokens(issueBody)).toEqual([]);
    expect(extractEffectiveWriteScopeFromPrompt(issueBody)).toEqual([]);
    expect(validateFileScopeInPromptContent(issueBody)).toEqual({ valid: [], invalid: [] });

    const bootstrap = buildBootstrapPrompt(
      "FN-8460",
      "File-Scope classifier silently drops .NET root-level files",
      `${issueBody}\n\nSource: https://github.com/Runfusion/Fusion/issues/2389`,
    );
    expect(validateFileScopeInPromptContent(bootstrap)).toEqual({ valid: [], invalid: [] });
  });

  it("still reads a real File Scope section after a fenced sample that also mentions File Scope", () => {
    const prompt = `# Task: FN-1

## Context

Example only:

\`\`\`md
## File Scope
- \\\`bogus/path\\\`
\`\`\`

## File Scope
- \`global.json\`
- \`src/MyApp/Program.cs\`

## Steps
- [ ] Go
`;
    expect(extractFileScopeTokens(prompt)).toEqual(["global.json", "src/MyApp/Program.cs"]);
    expect(extractEffectiveWriteScopeFromPrompt(prompt)).toEqual([
      "global.json",
      "src/MyApp/Program.cs",
    ]);
  });
});
