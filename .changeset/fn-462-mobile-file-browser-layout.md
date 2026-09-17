---
"@runfusion/fusion": patch
---

summary: Make the mobile file explorer usable — compact header, touch rows, and a list that scrolls to the last file.
category: fix
dev: Declares the phone scroll invariant on `.file-browser` itself (`html[data-viewport-mode="mobile"]` plus the pre-hydration arm) instead of per host, completes the previously uncovered hosts (inline Files page in `FilesView.css`, the three Settings pickers sharing `.settings-overlap-path-picker-body`), and caps the phone header at three touch rows with clipped (never removed) labels. FN-427/FN-445 host rules are retained. Covered by `FileBrowser.mobile-layout.test.tsx`, which walks the resolved ancestor chain of every host.
