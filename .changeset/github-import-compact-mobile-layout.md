---
"@runfusion/fusion": minor
---

summary: The GitHub import screen shows far more issues at once, and Import now sits under the issue you are reading.
category: feature
dev: Provider, type tabs, origin, filter and Load collapse into one wrapping control row (chrome 93px -> 70px at 412px; ~9 -> ~13 issues visible). Load is icon-only (label kept as aria-label/title). The labels filter is a popover whose trigger doubles as its readout, so collapsing never hides applied state; dismisses on outside pointerdown or Escape (stopPropagation so the modal survives). Origin stays visible as an inline chip. Import moves out of the preview header into a bottom action bar alongside Close issue, and the list footer's duplicate Import is removed — the footer keeps only Cancel, so an issue can no longer be imported without opening it. Obsolete `flex: 1 1 100%` mobile stacking on the toolbar zones removed.
