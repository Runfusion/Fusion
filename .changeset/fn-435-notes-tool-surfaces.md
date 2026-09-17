---
"@runfusion/fusion": minor
---

summary: Notes now autosave, and Activity and Notes open as phone-friendly surfaces on mobile.
category: feature
dev: Activity routes to `ActivityLogModal` and Notes to a new `NotesDrawer` bridge when `useViewportMode()` is `mobile`; the desktop Notes popover hosts the full rail + editor and no longer delegates to `openNoteInWindow`. The note editor drops its title field, Save, Delete, Ctrl/Cmd+S and the whole `FileEditor` toolbar (new opt-in `hideToolbar` prop, which never writes the shared Edit/Preview localStorage preference). Rename and delete moved to a per-row list menu backed by new `useNotes.renameNote`/`removeNote`; content is written by a debounced `saveIfDirty` flushed on note change, back-to-list, host close and unmount. The discard confirmation now fires only for an unresolved revision conflict or a failed save. `PoppedOutNoteWindows`, `usePoppedOutNotes` and the dock's `listOnly` Notes entry are unchanged.
