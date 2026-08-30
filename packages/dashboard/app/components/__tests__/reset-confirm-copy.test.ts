// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { listComponentFiles, readAppFile } from "../../test/cssFixture";

const key = "taskDetail.reset.confirmMessage";
const expectedCopy = "Restart this task from nothing but the original request. Its plan, worktree, branch and commits, and reviews are permanently deleted and cannot be recovered.";
const hosts = ["ListView.tsx", "TaskCard.tsx", "TaskDetailModal.tsx"];

describe("Reset dialog copy", () => {
  it("keeps the shared Reset dialog aligned with the English catalog", () => {
    const catalog = JSON.parse(readFileSync(resolve(__dirname, "../../../../i18n/locales/en/app.json"), "utf8")) as {
      taskDetail: { reset: { confirmMessage: string } };
    };
    expect(catalog.taskDetail.reset.confirmMessage).toBe(expectedCopy);
    expect(readAppFile("components/TaskResetDialog.tsx")).toContain(`t(\n              "${key}",\n              "${expectedCopy}",`);
  });

  it("routes all three hosts through the single dialog copy source", () => {
    for (const host of hosts) {
      const source = readAppFile(`components/${host}`);
      expect(source).toContain('import { TaskResetDialog } from "./TaskResetDialog";');
      expect(source).not.toContain(key);
    }

    const references = listComponentFiles()
      .filter((path) => readAppFile(`components/${path}`).includes(key));
    expect(references).toEqual(["TaskResetDialog.tsx"]);
  });
});
