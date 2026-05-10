// @vitest-environment node

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../../../");

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("github tracking documentation contract", () => {
  it("documents the GitHub Tracking Issues section with required behavior", () => {
    const taskManagement = readDoc("docs/task-management.md");

    expect(taskManagement).toContain("## GitHub Tracking Issues");
    expect(taskManagement).toContain("They are **not** the same as imported source issues (`issueInfo` / `sourceIssue`)");
    expect(taskManagement).toContain("task creation flows (including quick create, planning output, and subtask creation paths that create tasks)");
    expect(taskManagement).toContain("task.githubTracking.enabled");
    expect(taskManagement).toContain("task.githubTracking.repoOverride");
    expect(taskManagement).toContain("Repository resolution order");
    expect(taskManagement).toContain("1. Task override: `task.githubTracking.repoOverride`");
    expect(taskManagement).toContain("2. Project default: `githubTrackingDefaultRepo`");
    expect(taskManagement).toContain("3. Global default: `githubTrackingDefaultRepo`");
    expect(taskManagement).toContain("Creation is best-effort and non-blocking");
    expect(taskManagement).toContain("Title: `[FN-XXXX] Task title`");
    expect(taskManagement).toContain("Body prefix: `Fusion task: FN-XXXX`");
  });

  it("keeps GitHub auth cross-links discoverable from task management docs", () => {
    const taskManagement = readDoc("docs/task-management.md");
    const settingsReference = readDoc("docs/settings-reference.md");

    expect(taskManagement).toContain("[Settings Reference](./settings-reference.md)");
    expect(taskManagement).toContain("`githubAuthMode` (`gh-cli` or `token`) and `githubAuthToken`");

    expect(settingsReference).toContain("`githubAuthMode` | `\"gh-cli\" \\\| \"token\"` | `\"gh-cli\"`");
    expect(settingsReference).toContain("`githubAuthToken` | `string` | `undefined`");
  });
});
