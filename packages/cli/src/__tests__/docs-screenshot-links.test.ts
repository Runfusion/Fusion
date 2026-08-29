import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const docsRoot = resolve(workspaceRoot, "docs");

/*
FNXC:DocsScreenshots 2026-06-17-00:38:
Published docs render on GitHub and in fresh clones, so screenshot image references must resolve to committed files, not only developer-local files that happen to exist on disk.
Assert both filesystem presence and `git ls-files` tracking so a gitignored-but-present `docs/screenshots/` directory cannot regress silently.
*/

function collectMarkdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return collectMarkdownFiles(entryPath);
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      return [entryPath];
    }
    return [];
  });
}

function toRepoRelativePath(absolutePath: string): string {
  return relative(workspaceRoot, absolutePath).split(sep).join("/");
}

function gitTracks(relativePath: string): boolean {
  const output = execFileSync("git", ["ls-files", "--", relativePath], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  return output.length > 0;
}

describe("docs screenshot links", () => {
  it("points every screenshot image reference at an existing tracked asset", () => {
    const markdownFiles = [...collectMarkdownFiles(docsRoot), resolve(workspaceRoot, "README.md")];
    const screenshotReferences: Array<{ source: string; target: string; resolvedPath: string; repoPath: string }> = [];

    for (const markdownFile of markdownFiles) {
      const markdown = readFileSync(markdownFile, "utf8");
      const imagePattern = /!\[[^\]]*\]\(([^)]+)\)/g;
      for (const match of markdown.matchAll(imagePattern)) {
        const rawTarget = match[1]?.trim().replace(/^<|>$/g, "") ?? "";
        const targetWithoutTitle = rawTarget.split(/\s+/)[0] ?? "";
        const targetWithoutFragment = targetWithoutTitle.replace(/[?#].*$/, "");
        if (!/(?:^|\/)screenshots\/[^/]+\.png$/i.test(targetWithoutFragment)) {
          continue;
        }

        const resolvedPath = resolve(dirname(markdownFile), targetWithoutFragment);
        screenshotReferences.push({
          source: toRepoRelativePath(markdownFile),
          target: targetWithoutTitle,
          resolvedPath,
          repoPath: toRepoRelativePath(resolvedPath),
        });
      }
    }

    expect(screenshotReferences.map(({ repoPath }) => repoPath).sort()).toEqual([
      "docs/screenshots/agents-view.png",
      "docs/screenshots/artifacts-doc-edit.png",
      "docs/screenshots/artifacts-gallery.png",
      "docs/screenshots/chat-view.png",
      "docs/screenshots/dashboard-overview.png",
      "docs/screenshots/dashboard-overview.png",
      "docs/screenshots/dashboard-overview.png",
      "docs/screenshots/git-manager.png",
      "docs/screenshots/list-view.png",
      "docs/screenshots/mailbox-view.png",
      "docs/screenshots/memory-view.png",
      "docs/screenshots/mission-manager.png",
      "docs/screenshots/nodes-view.png",
      "docs/screenshots/skills-view.png",
      "docs/screenshots/task-detail.png",
      "docs/screenshots/task-detail.png",
      "docs/screenshots/terminal.png",
      "docs/screenshots/workflow-steps.png",
    ]);

    const missingFiles = screenshotReferences
      .filter(({ resolvedPath }) => !existsSync(resolvedPath))
      .map(({ source, target, repoPath }) => `${source} -> ${target} (${repoPath})`);
    const untrackedFiles = screenshotReferences
      .filter(({ repoPath }) => !gitTracks(repoPath))
      .map(({ source, target, repoPath }) => `${source} -> ${target} (${repoPath})`);

    expect(missingFiles).toEqual([]);
    expect(untrackedFiles).toEqual([]);
  });
});
