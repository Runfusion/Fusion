import { describe, expect, it } from "vitest";
import { readAppFile, listComponentFiles } from "../test/cssFixture";

/*
FNXC:TaskTitleDisplay 2026-09-14-17:20:
FN-391 makes `getTaskTitleDisplay` the ONE projection every task label goes through. The behavioral
tests prove each surface renders the right text today; this closed census is what stops the next
author from adding a thirteenth surface with an inline `task.title || task.description || task.id`
expression, which is exactly how the label rule ended up copied across a dozen components.

It asserts CODE CONSTRUCTS, not prose: the forbidden expression shape, and the presence of the
shared import in each surface that renders a task label. Both are mechanically checkable and both
fail loudly when the rule is bypassed.
*/

/** Source files that render or sort a task label and therefore must reach the shared projection. */
const TITLE_PROJECTION_SURFACES = [
  "components/TaskCard.tsx",
  "components/ListView.tsx",
  "components/TaskSearchInput.tsx",
  "components/TaskForm.tsx",
  "components/QuickEntryBox.tsx",
  "components/NewTaskModal.tsx",
  "components/InlineCreateCard.tsx",
  "components/PlanningModeModal.tsx",
  "components/AgentDetailView.tsx",
  "components/MissionManager.tsx",
  "components/ResearchTaskActionModal.tsx",
  "components/DevServerView.tsx",
  "components/TaskDetailModal.tsx",
  "hooks/useFileMention.ts",
] as const;

/*
FNXC:TaskTitleDisplay 2026-09-14-17:20:
The inline precedence chain the helper replaces, in the spacing variants that actually occurred in
this repository. A match is a surface that re-derived the label rule instead of importing it.
*/
const INLINE_TITLE_FALLBACK_PATTERNS: readonly RegExp[] = [
  /\btitle\s*\|\|\s*[A-Za-z_$][\w$]*\??\.description\b/,
  /\btitle\s*\?\?\s*[A-Za-z_$][\w$]*\??\.description\b/,
  /\.title\s*\|\|\s*[A-Za-z_$][\w$]*\??\.description\b/,
];

describe("task title display surface census", () => {
  it.each(TITLE_PROJECTION_SURFACES)("%s imports the shared title projection", (surface) => {
    expect(readAppFile(surface)).toContain("utils/taskTitleDisplay");
  });

  it.each(TITLE_PROJECTION_SURFACES)("%s contains no inline title-or-description fallback", (surface) => {
    const source = readAppFile(surface);
    const offending = source
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) =>
        !line.startsWith("*") &&
        !line.startsWith("//") &&
        INLINE_TITLE_FALLBACK_PATTERNS.some((pattern) => pattern.test(line)));

    expect(offending).toEqual([]);
  });

  it("no other dashboard component re-derives the label rule", () => {
    const known = new Set<string>(TITLE_PROJECTION_SURFACES.map((path) => path.replace(/^components\//, "")));
    const offenders = listComponentFiles()
      // Test doubles may stub a task label shape; the census governs production surfaces.
      .filter((name) => !name.includes("__tests__/") && !known.has(name))
      .flatMap((name) => {
        const source = readAppFile(`components/${name}`);
        return source
          .split("\n")
          .filter((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith("*") || trimmed.startsWith("//")) return false;
            return INLINE_TITLE_FALLBACK_PATTERNS.some((pattern) => pattern.test(trimmed));
          })
          .map((line) => `${name}: ${line.trim()}`);
      });

    expect(offenders).toEqual([]);
  });

  /*
  FNXC:TaskTitleDisplay 2026-09-14-17:20:
  The removed affordances. `#task-form-title` was the only title INPUT and `summarize-title-btn` the
  only manual Summarize action; both are gone with FN-391, and a reappearing one would re-create the
  two-writer title model this task removed. Negative construct assertions only \u2014 no prose.
  */
  it.each(["components/TaskForm.tsx", "components/TaskDetailModal.tsx"])(
    "%s renders no task title input or manual summarize affordance",
    (surface) => {
      const source = readAppFile(surface);
      expect(source).not.toContain("task-form-title");
      expect(source).not.toContain("summarize-title-btn");
    },
  );
});
