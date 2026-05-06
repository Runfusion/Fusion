---
"@runfusion/fusion": patch
---

Mission sidebar follow-ups for card density and CTA prominence.

- **Wider title in the sidebar**: stack mission cards vertically inside the
  sidebar so the title row spans the full card width instead of competing
  with the action buttons. Action buttons now sit on their own row below.
- **Activity on its own row**: the `Activity X ago` label moved out of the
  cramped stats line into its own row.
- **Full-width progress bar**: the completion bar moved out of the stats
  row onto its own line and now scales to the full card width instead of
  competing with stat labels for horizontal space.
- **Centered "Plan New Mission" CTA**: the sidebar header now hosts a
  full-width primary-styled button (matches the chat sidebar's "New Chat"
  affordance) with the Sparkles icon and "Plan New Mission" text — replacing
  the dashed-outline icon-only buttons. Mobile footer uses the same label.
- **Auto-select first mission (inline desktop)**: the inline mission view
  now opens with the first mission preloaded into the detail pane instead
  of an empty placeholder. Falls back to the existing empty-pane copy when
  no missions exist. Standalone-modal usage is unchanged.
- **Richer empty state**: when no missions exist, the list now explains
  what missions are and surfaces a primary "Plan New Mission" CTA inline.
