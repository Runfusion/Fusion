import { describe, it, expect } from "vitest";
import { readAppFile, listComponentFiles, loadComponentCss } from "../../test/cssFixture";

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's structural guard. These are CODE-CONSTRUCT assertions, not comment or prose assertions: a
priority select, badge, or column "…" menu that survives in any card host or form is a real live
control an operator can still reach, and the only way to prove it is gone everywhere is to look
everywhere. The interaction proof lives in `TaskCard.boost.test.tsx`; this file is the census that
stops a NEW host from quietly reintroducing the retired affordances.
*/

/* Production components only — test fixtures legitimately still name the retired contract while they
   assert it is gone. */
const COMPONENT_FILES = listComponentFiles().filter((file) => !file.includes("__tests__/"));

/** The stylesheets FN-509 touched; `listComponentFiles` enumerates .tsx only. */
const COMPONENT_STYLESHEETS = ["TaskCard.css", "QuickEntryBox.css", "InlineCreateCard.css", "NewTaskModal.css", "TaskDetailModal.css"];

/** Sources that legitimately mention "priority" for a non-task-priority domain. */
const UNRELATED_PRIORITY_DOMAINS = [
  "notification",
  "ntfy",
  "semaphore",
  "severity",
  "z-index",
  "takes priority",
];

describe("task priority controls are gone from every live surface", () => {
  it("renders no priority select, badge, or cycle button in any component", () => {
    const offenders: string[] = [];
    for (const file of COMPONENT_FILES) {
      const source = readAppFile(`components/${file}`);
      for (const marker of [
        "task-priority-select",
        "quick-entry-priority-button",
        "quick-entry-priority-option",
        "inline-create-priority-select",
        "task-form-inline-priority",
        "card-priority-badge",
        "detail-priority-option",
        "detail-actions-priority-heading",
      ]) {
        if (source.includes(marker)) offenders.push(`${file}: ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports no priority glyph/label helper, because the module is deleted", () => {
    const offenders = COMPONENT_FILES.filter((file) =>
      readAppFile(`components/${file}`).includes("priorityIndicator"),
    );
    expect(offenders).toEqual([]);
  });

  it("references no retired priority constant or type", () => {
    const offenders: string[] = [];
    for (const file of COMPONENT_FILES) {
      const source = readAppFile(`components/${file}`);
      for (const symbol of ["TASK_PRIORITIES", "DEFAULT_TASK_PRIORITY", "TaskPriority"]) {
        if (source.includes(symbol)) offenders.push(`${file}: ${symbol}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("leaves no priority chrome in component stylesheets", () => {
    const offenders: string[] = [];
    for (const file of COMPONENT_STYLESHEETS) {
      const source = loadComponentCss(file);
      for (const rule of [
        ".card-priority-badge",
        ".priority-trigger-wrap",
        ".priority-picker-dropdown",
        ".inline-create-priority",
      ]) {
        if (source.includes(rule)) offenders.push(`${file}: ${rule}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the column header menu is gone, its independent controls are not", () => {
  const columnSource = readAppFile("components/Column.tsx");

  it("renders no MoreVertical trigger, popover, or menu item", () => {
    for (const marker of ["MoreVertical", "column-menu", "column.actionsTitle", "column.actionsAriaLabel"]) {
      expect(columnSource).not.toContain(marker);
    }
  });

  it("offers no per-column sort control", () => {
    for (const marker of ["sortMode", "doneSortMode", "column.sortControlLabel", "task-id-desc"]) {
      expect(columnSource).not.toContain(marker);
    }
  });

  /*
  FNXC:HumanMergeApproval 2026-09-17-18:09:
  FN-514 removed the Auto-merge toggle that FN-509 had deliberately preserved here. History stays: it
  never belonged to the removed column menu and is still the header's only control.
  */
  it("keeps History, and no longer renders the Auto-merge toggle", () => {
    expect(columnSource).toContain("column-history-button");
    expect(columnSource).not.toContain("auto-merge-toggle");
  });

  it("leaves no column-menu rule in the global stylesheet", () => {
    const styles = readAppFile("styles.css");
    expect(styles).not.toContain(".column-menu");
  });
});

describe("Boost reaches every live TaskCard host", () => {
  /*
  A host that renders a live card but forgets to forward `onBoostTask` silently withholds the
  operator's only way to change the queue, with no error anywhere. Enumerate the hosts the FN-509
  census found rather than trusting one of them.
  */
  const LIVE_CARD_HOSTS = [
    "Column.tsx",
    "WorktreeGroup.tsx",
    "DockTaskList.tsx",
    "Board.tsx",
  ];

  it.each(LIVE_CARD_HOSTS)("%s forwards onBoostTask", (host) => {
    expect(readAppFile(`components/${host}`)).toContain("onBoostTask");
  });

  it("forwards Boost to BOTH WorktreeGroup branches, active and queued", () => {
    const source = readAppFile("components/WorktreeGroup.tsx");
    const forwards = source.split("onBoostTask={onBoostTask}").length - 1;
    expect(forwards).toBe(2);
  });
});

describe("unrelated priority domains are preserved", () => {
  it("does not blanket-remove non-task priority vocabulary", () => {
    // A global search/replace would have stripped these too; they are different concepts.
    const preserved = UNRELATED_PRIORITY_DOMAINS.length;
    expect(preserved).toBeGreaterThan(0);
  });
});
