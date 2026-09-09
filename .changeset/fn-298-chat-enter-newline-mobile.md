---
"@runfusion/fusion": minor
---

summary: Let Enter create new lines in mobile conversation composers, with a global behavior setting.
category: feature
dev: Adds the global `chatSubmitOnEnter` setting and `ChatSubmitOnEnterContext` across the three conversation composers; `auto` makes plain Enter a newline for a coarse primary pointer and a send action for a fine pointer, while `always` and `never` force that branch. Shift+Enter never sends, including with Cmd/Ctrl held; it inserts a newline except while one of Chat's files/tasks, agents, or skills autocomplete menus is open, whereas it passes through the task Chat and planner Chat menus. Cmd/Ctrl+Enter without Shift ignores the setting and device after the existing guards. An open autocomplete menu consumes both Enter and Cmd/Ctrl+Enter until Escape closes it, and task Chat IME composition takes priority over every Enter path. Plain Enter without Cmd/Ctrl or Shift follows the setting, Alt does not alter it, and Send remains active whenever the draft is not empty.
