# Design Audit Report: FN-688

## Executive Summary

- **Total issues found:** 49
- **P0 (Critical/Broken):** 6
- **P1 (High/Poor UX):** 18
- **P2 (Medium/Polish):** 25

This audit covers the Fusion dashboard's three main views (Board, List, Agents), Header, Modals, Project Overview, Responsive behavior, Interaction States, and Visual Consistency.

---

## 1. Board View Issues

### P0-01: Missing CSS for `board-project-context` and `board-project-badge`

**File:** `packages/dashboard/app/components/Board.tsx` (lines 128-133)
**Location:** Board.tsx renders `<div className="board-project-context">` and `<span className="board-project-badge">`
**Issue:** These CSS classes do not exist anywhere in `styles.css`. The multi-project context badge renders as unstyled HTML — no background, no padding, no positioning. The `<Folder>` icon and project name appear as raw inline text with no visual treatment.
**Recommendation:** Add `.board-project-context` and `.board-project-badge` styles to `styles.css` with appropriate padding, background color, border-radius, and positioning (likely sticky above the board grid).

### P1-01: Archived column `column-archived` and `column-collapsed` classes have no CSS

**File:** `packages/dashboard/app/components/Column.tsx` (line 122)
**Location:** Column renders with `column-archived` and `column-collapsed` classes
**Issue:** No CSS rules target these classes. The archived column behaves visually identically to other columns. There is no visual differentiation to indicate its collapsed/archived nature — no muted opacity, no reduced width, no gray background. Users may not realize the column is in a special state.
**Recommendation:** Add `.column-archived` styles with reduced opacity or muted background. Add `.column-collapsed` styles to show a compact representation (e.g., reduced min-width, hidden body content, centered expand button).

### P1-02: Column description text padding inconsistency

**File:** `packages/dashboard/app/styles.css` (line 499)
**Location:** `.column-desc` uses `calc()` padding that creates sub-pixel values
**Issue:** The `.column-desc` padding is `var(--space-xs) calc(var(--space-lg) - 2px) calc(var(--space-md) - 2px)` which evaluates to `4px 14px 10px`. The `calc()` usage with -2px adjustments suggests manual tweaking rather than consistent spacing. Compare with `.column-header` which uses `calc(var(--space-lg) - 2px)` for its padding. These 2px offsets create inconsistent visual rhythm.
**Recommendation:** Use spacing token values directly (e.g., `var(--space-xs) var(--space-lg) var(--space-md)`) or define an explicit token for column internal padding.

### P2-01: Empty column state lacks visual depth

**File:** `packages/dashboard/app/styles.css` (line 3932)
**Location:** `.empty-column`
**Issue:** Empty column placeholder uses a simple dashed border (`border: 1px dashed var(--border)`) with fixed `height: 80px`. This fixed height doesn't scale with the column body height, creating an odd visual when columns have varying content heights. The empty state looks disconnected from the card-based visual language.
**Recommendation:** Consider using `min-height` instead of `height` and adding a subtle icon (e.g., inbox icon) for better visual communication.

### P2-02: Load More button in paginated columns lacks visual hierarchy

**File:** `packages/dashboard/app/components/Column.tsx` (lines 156-162)
**Location:** Load more button uses `btn btn-secondary btn-sm`
**Issue:** No `.btn-secondary` class exists in `styles.css`. The button falls back to the base `.btn` styling, making it visually indistinguishable from other actions. The "(X remaining)" text is helpful but the button itself doesn't stand out enough at the bottom of a long task list.
**Recommendation:** Define `.btn-secondary` class or use existing `.btn` with a distinct visual treatment. Consider a full-width style or a different visual pattern (e.g., "Show more ↓" link).

### P2-03: Auto-merge toggle label "Auto-merge" has small font and low contrast

**File:** `packages/dashboard/app/styles.css` (lines 3967-3969)
**Location:** `.toggle-label`
**Issue:** Toggle label uses `font-size: 11px` and `color: var(--text-muted)` (gray). On the in-review column header, this important feature toggle is easily missed. The label sits right-aligned via `margin-left: auto` and can be truncated on narrower column widths.
**Recommendation:** Increase font size to 12px and consider adding a subtle tooltip or making the toggle more prominent since it controls a significant workflow feature.

### P2-04: Card drag-over state only shown on column, not between cards

**File:** `packages/dashboard/app/styles.css` (line 436)
**Location:** `.column.drag-over`
**Issue:** During drag-and-drop, only the target column receives visual feedback (blue border + inset shadow). There's no insertion indicator between cards to show WHERE the task will be placed within the column. Cards are sorted by `columnMovedAt` automatically, so visual insertion position feedback isn't functionally needed, but users may be confused about where the card will land.
**Recommendation:** Add a visual affordance (e.g., a thin line or gap indicator) at the top of the column body when dragging over to signal that the task will be placed according to recency rules.

### P2-05: QuickEntryBox in triage column has no visual separation from cards

**File:** `packages/dashboard/app/styles.css` (line 10168)
**Location:** `.quick-entry-box` in board context
**Issue:** The QuickEntryBox sits at the top of the triage column body within the same gap spacing as task cards. There's minimal visual distinction between the entry area and the task cards below it, especially in collapsed state. Users might not immediately recognize it as an input area.
**Recommendation:** Add a subtle top border or slightly different background to the quick entry box when used in the board context.

---

## 2. List View Issues

### P0-02: Missing CSS for `list-project-context` and `list-project-badge`

**File:** `packages/dashboard/app/components/ListView.tsx` (lines rendering project context)
**Location:** ListView renders `<div className="list-project-context">` and `<span className="list-project-badge">`
**Issue:** Same as P0-01 — these CSS classes don't exist in `styles.css`. The project badge renders as unstyled text at the top of the list view.
**Recommendation:** Add corresponding styles with appropriate positioning and visual treatment matching the board view project badge.

### P1-03: Section header colSpan uses `visibleColumns.size` but doesn't account for checkbox column

**File:** `packages/dashboard/app/components/ListView.tsx` (line ~420)
**Location:** `<th colSpan={visibleColumns.size}>`
**Issue:** The section header's `colSpan` is set to `visibleColumns.size` but the table also has a checkbox column that isn't counted in `visibleColumns`. This means section headers don't span the full table width — leaving the checkbox column area empty and creating a visual gap. Similarly, empty section rows use the same incorrect colSpan.
**Recommendation:** Change colSpan to `visibleColumns.size + 1` to account for the checkbox column.

### P1-04: Bulk edit toolbar wraps awkwardly on medium screens

**File:** `packages/dashboard/app/components/ListView.tsx` (lines ~290-320)
**Location:** Bulk edit toolbar with model dropdowns
**Issue:** The bulk edit toolbar sits inside `.list-toolbar` which uses `flex-wrap: wrap`. On medium-width viewports (~900px), the toolbar items wrap to multiple lines but the model dropdowns have no defined min-width, causing them to either stretch too wide or compress too much. The "Apply" button can end up isolated on its own line.
**Recommendation:** Add explicit min/max widths to `.bulk-edit-dropdown` and consider moving the bulk edit toolbar to a separate row below the main toolbar when selections are active.

### P1-05: Drop zone labels hidden on mobile but dots too small for touch

**File:** `packages/dashboard/app/styles.css` (line ~5844)
**Location:** `@media (max-width: 768px)` - `.drop-zone-label { display: none; }`
**Issue:** On mobile, drop zone labels are hidden, leaving only small colored dots and counts. The dots (`.drop-zone-dot` at 6px) and touch targets for the drop zone items are too small for comfortable mobile tapping. The minimum recommended touch target is 44px.
**Recommendation:** Increase mobile drop zone padding to at least 44px height. Consider showing abbreviated column labels (e.g., "Tri", "Todo", "IP", "IR", "Done") instead of hiding them entirely.

### P2-06: List view section chevron animation uses transform but no explicit will-change

**File:** `packages/dashboard/app/styles.css`
**Location:** `.list-section-chevron`, `.list-section-chevron--expanded`
**Issue:** The section collapse/expand chevron rotates 90° when expanded. The CSS uses `transform: rotate(90deg)` with a transition, but doesn't set `will-change: transform` for smoother GPU-accelerated animation. Not a bug, but can cause jank on low-end devices.
**Recommendation:** Add `will-change: transform` to `.list-section-chevron` or verify the transition property includes transform.

### P2-07: Filter input clear button (×) inconsistent with search clear in header

**File:** `packages/dashboard/app/components/ListView.tsx` (line ~258)
**Location:** Filter clear button uses raw `×` character
**Issue:** The list filter clear button uses a plain `×` text character (`<button className="filter-clear" onClick={() => setFilter("")}>×</button>`), while the header search clear button uses a Lucide `<X size={14} />` icon. This creates visual inconsistency between two similar UI elements.
**Recommendation:** Replace the `×` text with a Lucide `X` icon for visual consistency.

### P2-08: Column dropdown positions may clip off-screen

**File:** `packages/dashboard/app/styles.css` (line 5364)
**Location:** `.list-column-dropdown`
**Issue:** The column toggle dropdown uses `position: absolute; top: calc(100% + 4px); right: 0;`. On mobile or when the button is near the right edge, the dropdown may extend beyond the viewport. No max-height or overflow protection is defined.
**Recommendation:** Add `max-height: 300px; overflow-y: auto;` and consider checking viewport edge detection.

---

## 3. Agents View Issues

### P0-03: AgentsView uses BEM double-dash class naming that doesn't match stylesheet

**File:** `packages/dashboard/app/components/AgentsView.tsx` (multiple lines)
**Location:** All button elements in AgentsView
**Issue:** AgentsView uses `.btn--primary`, `.btn--sm`, `.btn--danger` (BEM double-dash convention) throughout the component, but the global stylesheet only defines `.btn-primary`, `.btn-sm`, `.btn-danger` (single-dash). This means **all buttons in the AgentsView are missing their variant styling** — primary buttons have no green background, small buttons have no compact padding, and danger buttons have no red color. The only styling applied is the base `.btn` class.
**Recommendation:** Change all double-dash class names to single-dash to match the stylesheet: `btn--primary` → `btn-primary`, `btn--sm` → `btn-sm`, `btn--danger` → `btn-danger`.

### P0-04: AgentsView uses undefined `.select` and `.input` CSS classes

**File:** `packages/dashboard/app/components/AgentsView.tsx` (lines 190, 219, 223)
**Location:** Filter dropdown: `className="select"`, Create form input: `className="input"`, Role select: `className="select"`
**Issue:** The standalone `.select` and `.input` classes are not defined in `styles.css`. The filter dropdown and create form rely on browser default styling for `<select>` and `<input>` elements, which creates an inconsistent visual compared to styled form elements elsewhere in the app (which use `.form-group select` and `.form-group input` selectors).
**Recommendation:** Either wrap these elements in `.form-group` containers to inherit the existing styles, or create standalone `.select` and `.input` utility classes.

### P0-05: AgentsView state color CSS variables use undefined tokens

**File:** `packages/dashboard/app/components/AgentsView.tsx` (inline `<style>` block)
**Location:** CSS variable fallback definitions for `--state-idle-bg`, `--state-active-bg`, etc.
**Issue:** The AgentsView's inline `<style>` block defines fallback values for agent state CSS variables (e.g., `--state-idle-bg`, `--state-active-text`). These variables are NOT defined in the global `:root` or theme selectors in `styles.css`. The inline `<style>` fallback values work for the AgentsView component, but the AgentListModal also uses the same STATE_COLORS mapping with the same variables — yet it uses a different inline style block. If a theme tries to override these colors globally, there's no single source of truth.
**Recommendation:** Move agent state color variables to the global `:root` in `styles.css` so they participate in theming and have a single definition.

### P1-06: AgentsView inline `<style>` block creates style isolation issues

**File:** `packages/dashboard/app/components/AgentsView.tsx` (lines 337-580)
**Location:** Entire `<style>` block at bottom of component
**Issue:** AgentsView defines ~250 lines of CSS inside an inline `<style>` tag rather than using the central `styles.css` file. This means:
1. Styles are duplicated if AgentListModal redefines similar patterns
2. Hot module replacement may cause style flashing
3. Styles aren't subject to CSS optimizations (dedup, minification)
4. Developer confusion about where to find/modify agent styling
**Recommendation:** Move all AgentsView styles to `styles.css` and remove the inline `<style>` block.

### P1-07: Agent board card hover state has no cursor change indication

**File:** `packages/dashboard/app/components/AgentsView.tsx` (inline styles)
**Location:** `.agent-board-card:hover`
**Issue:** Agent board cards have hover effects (background change, border change) but no `cursor: pointer` is set. Users hovering over cards see visual feedback but the cursor remains default, creating uncertainty about whether cards are clickable (they're not — only the action buttons inside are interactive). This is a mixed signal.
**Recommendation:** Since the card itself isn't clickable, keep `cursor: default` but reduce the hover effect to be subtler (just a slight background change, no border movement) to avoid implying clickability.

### P2-09: Agent empty state icon opacity uses hardcoded value

**File:** `packages/dashboard/app/components/AgentsView.tsx` (line 198)
**Location:** `<Bot size={48} opacity={0.3} />`
**Issue:** Empty state uses inline `opacity={0.3}` prop on the Lucide icon. This doesn't respond to theme changes and bypasses the CSS theming system. In light mode, this 0.3 opacity may make the icon nearly invisible.
**Recommendation:** Use a CSS variable-based color instead of opacity: `color: var(--text-dim)` which already handles theme adaptation.

### P2-10: Agent create form has no cancel/close affordance

**File:** `packages/dashboard/app/components/AgentsView.tsx` (lines 210-234)
**Location:** Create form toggled by "New Agent" button
**Issue:** When the create form is open, the "New Agent" button changes to "Cancel" but there's no Escape key handler to dismiss it. The form persists even after clicking away. Compare to QuickEntryBox which supports Escape to dismiss.
**Recommendation:** Add keyboard event handler for Escape to close the create form.

---

## 4. Header & Navigation Issues

### P1-08: Header icon button density — 10+ icons in a row on desktop

**File:** `packages/dashboard/app/components/Header.tsx` (lines 168-287)
**Location:** Desktop header action buttons
**Issue:** The desktop header renders up to 11 icon buttons in a row: search, view toggle (3 buttons), usage, activity log, GitHub import, planning, schedules, terminal, files, git, workflow, agents, scripts, settings, pause, stop. This creates visual clutter and cognitive overload. Users cannot easily identify which icon corresponds to which function without hovering for tooltips.
**Recommendation:** Group related actions (e.g., put auxiliary tools behind a "More tools" dropdown, keep only primary actions — view toggle, search, pause/stop — as inline buttons). Consider using a secondary toolbar pattern or categorized dropdown.

### P1-09: Mobile overflow menu has a permanent blue dot indicator

**File:** `packages/dashboard/app/styles.css` (line 4212)
**Location:** `.mobile-overflow-trigger::after`
**Issue:** The mobile overflow trigger always shows a small blue dot (6px) in the top-right corner via `::after` pseudo-element. This suggests there are unread items or notifications, but the dot is purely decorative and always present. This is misleading UX that trains users to ignore it.
**Recommendation:** Remove the decorative dot, or only show it when there are actionable items (e.g., unauthenticated providers).

### P2-11: "Back to All Projects" button text hidden on mobile, leaving only icon

**File:** `packages/dashboard/app/styles.css` (line 4195)
**Location:** Mobile: `.header-back-button span { display: none; }`
**Issue:** On mobile, the back button hides its text "All Projects" and shows only the `<ChevronLeft>` icon. The icon alone (a left chevron) doesn't clearly communicate "back to all projects" — it could mean "back to previous page" or "collapse sidebar". The button itself is only 24px wide with 4px padding.
**Recommendation:** Show abbreviated text "Projects" or "All" on mobile instead of icon-only, or increase the icon size and add an aria-label for accessibility.

### P2-12: View toggle in header duplicated in AgentsView header

**File:** `packages/dashboard/app/components/AgentsView.tsx` (lines 145-168)
**Location:** AgentsView has its own board/list view toggle
**Issue:** The main header has a view toggle for board/list/agents, and when in agents view, the AgentsView component adds its own board/list toggle for the agent layout. Users see two view toggles simultaneously: the header one (board/list/agents) and the agents one (board/list for agents). This is confusing.
**Recommendation:** Either remove the agents view's internal toggle and rely solely on the header's view switcher (adding "agents-board" and "agents-list" options), or hide the header view toggle when in agents view.

---

## 5. Modal & Overlay Issues

### P1-10: TaskDetailModal tabs overflow without scroll indicators on desktop

**File:** `packages/dashboard/app/styles.css` (line 4076)
**Location:** `.detail-tabs`
**Issue:** The detail tabs use `display: flex; gap: 0;` with no overflow handling on desktop. With 7+ tabs (definition, activity, agent-log, changes, steering, comments, model, workflow), the tab bar can overflow its container on narrow modal widths. Mobile has `overflow-x: auto` and hidden scrollbar, but desktop has no overflow handling at all.
**Recommendation:** Add `overflow-x: auto; flex-wrap: nowrap;` to `.detail-tabs` with scrollbar styling for desktop. Consider a "More" dropdown when tabs exceed container width.

### P1-11: Modal close button uses raw character "×" inconsistently

**File:** `packages/dashboard/app/styles.css` (line 2296)
**Location:** `.modal-close`
**Issue:** The modal close button uses `font-size: 22px` with a raw `×` character. This has inconsistent rendering across platforms and browsers. Other parts of the UI use Lucide `<X>` icon for close actions (e.g., header search clear, filter clear in list view).
**Recommendation:** Replace all modal close buttons with Lucide `<X size={18} />` for consistent icon rendering.

### P2-13: Settings modal sidebar nav items lack visible focus indicators

**File:** `packages/dashboard/app/styles.css` (line 2497)
**Location:** `.settings-nav-item`
**Issue:** Settings navigation items have hover styles but no `:focus-visible` styles. Keyboard users tabbing through settings sections see no visual indicator of which section is focused. The `active` class applies a blue left border, but focus and active are different states.
**Recommendation:** Add `.settings-nav-item:focus-visible { outline: 2px solid var(--todo); outline-offset: -2px; }`.

### P2-14: Toast notifications position may overlap with mobile overflow menu

**File:** `packages/dashboard/app/styles.css` (line 3121)
**Location:** `.toast-container` at `bottom: 20px; right: 20px;`
**Issue:** Toast container is fixed at bottom-right (`z-index: 200`). On mobile, the overflow menu renders at top-right (`z-index: 1000`). While these don't overlap, toasts can overlap with the bottom of a full-screen modal (which also uses position: fixed). The z-index hierarchy (modals: 100, toasts: 200) means toasts appear above modal overlays but may be partially hidden by modal content.
**Recommendation:** Increase toast z-index to 300 or position toasts relative to the modal when a modal is open.

### P2-15: ActivityLogModal entry styling has no distinction between own-project and cross-project events

**File:** `packages/dashboard/app/components/ActivityLogModal.tsx` (lines ~43-50)
**Location:** Event type icons and labels
**Issue:** Activity log entries from different projects all use the same styling. The project badge (folder icon + name) is the only differentiator. When viewing global activity, entries from the current project look identical to entries from other projects. Users have to read the badge text to distinguish context.
**Recommendation:** Add a subtle left border color or background tint per project, or visually highlight entries from the currently-selected project.

---

## 6. Project Overview (Multi-Project) Issues

### P1-12: ProjectCard has no minimum height, causing uneven grid with variable health data

**File:** `packages/dashboard/app/styles.css` (line 937)
**Location:** `.project-card`
**Issue:** Project cards have `min-width: 280px` but no `min-height`. Cards with health data are taller than cards without health data (which show "No health data available"). In a 2-3 column grid, this creates uneven row heights and visual jankiness. The `align-items: stretch` on `.project-grid` helps but doesn't ensure visual consistency within rows.
**Recommendation:** Add `min-height: 200px` to `.project-card` and center the health section vertically when content is shorter.

### P2-16: Project Overview stats section wraps inconsistently on medium screens

**File:** `packages/dashboard/app/styles.css` (line 1207)
**Location:** `.project-overview__stats`
**Issue:** The stats section uses `flex-wrap: wrap; justify-content: center;` which causes stats to reflow unpredictably between 2-column and 3-column layouts. At `@media (max-width: 640px)`, stats switch to `flex: 1 1 calc(50% - var(--space-sm))` but on medium screens (641px-900px) there's no specific handling, so stats can wrap into awkward 3+1 or 2+2 layouts depending on the stat count.
**Recommendation:** Add a `@media (max-width: 900px)` rule for the stats section to define explicit 2-column behavior.

### P2-17: Project filter tabs "Errored" has-errors class may conflict with active state

**File:** `packages/dashboard/app/styles.css` (line 1380)
**Location:** `.project-filter-tab.has-errors:not(.active)`
**Issue:** The errored filter tab uses red text (`color: var(--color-error)`) when there are errored projects, but only when NOT active. When active, it gets the standard blue treatment (`background: rgba(88, 166, 255, 0.12)`). This means the "Errored" tab changes color as you click it — red text goes to blue, which confuses the semantic meaning.
**Recommendation:** When filtering for errored projects, maintain the red color scheme even in active state: `background: rgba(248, 81, 73, 0.12); border-color: rgba(248, 81, 73, 0.35); color: var(--color-error);`.

### P2-18: ProjectCard remove button has no confirmation on mobile

**File:** `packages/dashboard/app/components/ProjectCard.tsx` (line 114)
**Location:** Remove button `handleRemove`
**Issue:** The remove button calls `onRemove(project)` directly without confirmation. The parent component in `App.tsx` also calls `unregisterProject(project.id)` without confirmation. Removing a project is a destructive action that should have a confirmation dialog. Compare to agent deletion which uses `confirm()`.
**Recommendation:** Add a confirmation dialog before project removal, matching the pattern used in agent deletion.

---

## 7. Responsive & Mobile Issues

### P0-06: Mobile board columns have no minimum content height

**File:** `packages/dashboard/app/styles.css` (line 4061)
**Location:** Mobile `.board > .column { width: 280px; flex-shrink: 0; }`
**Issue:** On mobile, board columns use `width: 280px` with `flex-shrink: 0` but the board container uses `overflow-y: hidden`. If the viewport height is very short (e.g., landscape phone), columns clip their content with no visible scroll indicator. The column body has `overflow-y: auto` but the parent board height is `calc(100vh - 57px)` which on landscape phones could be as little as ~250px, leaving very little room for cards after the column header and description.
**Recommendation:** Consider reducing column header/description size on mobile or allowing the board to use `overflow-y: auto` on very short viewports.

### P1-13: List view table hides columns 5 and 6 on mobile using nth-child selector

**File:** `packages/dashboard/app/styles.css` (line 5850)
**Location:** `@media (max-width: 768px) .list-header-cell:nth-child(5), .list-header-cell:nth-child(6) { display: none; }`
**Issue:** Mobile CSS hides the 5th and 6th columns by position (nth-child), but the visible columns are user-configurable via the column visibility toggle. If a user hides the first two columns, the nth-child(5) rule would hide the wrong columns. This approach is fragile — it assumes a fixed column order.
**Recommendation:** Hide specific column types by class (e.g., `.list-cell-deps`, `.list-cell-progress`) rather than by position, or let the column visibility system handle mobile defaults.

### P1-14: Settings modal stacks sidebar horizontally on mobile but scrolls are hidden

**File:** `packages/dashboard/app/styles.css` (lines 4265-4290)
**Location:** Mobile `.settings-sidebar` layout
**Issue:** On mobile, the settings sidebar converts from vertical to horizontal scrolling tabs. The tabs use `overflow-x: auto` but `scrollbar-width` is not explicitly set to show scroll indicators. With 12 settings sections (General, Model, Model Presets, AI Summarization, Appearance, Scheduling, Worktrees, Commands, Merge, Backups, Notifications, Authentication), the tabs extend well beyond the screen width. Users have no visual cue that more tabs exist off-screen.
**Recommendation:** Add scroll fade indicators (gradient overlay on the edges) or show a scroll hint arrow. Consider grouping sections into categories for mobile.

### P2-19: Touch target sizes below 44px recommendation in several components

**File:** Various components
**Location:** Multiple touch targets
**Issue:** Several interactive elements fall below the 44px minimum touch target recommendation:
- `.view-toggle-btn`: 28px × 24px
- `.btn-icon`: 28px × 28px
- `.card-edit-btn`: 20px × 20px (expanded to 44px on mobile via media query — good!)
- `.drop-zone-dot`: 6px
- `.card-steps-toggle`: No min-height defined, relies on text content
- `.list-section-header` click target: full row height only
- `.column-count`: No minimum touch area
**Recommendation:** Ensure all interactive elements have at least 44px × 44px touch targets on mobile. The card-edit-btn pattern (expanding via media query) is a good model to follow.

---

## 8. Interaction States Issues

### P1-15: `.btn` class has no `:disabled` or `:focus-visible` styles

**File:** `packages/dashboard/app/styles.css` (line 367)
**Location:** `.btn` base class
**Issue:** The base `.btn` class defines hover, active, and transition states but has NO `:disabled` or `:focus-visible` styles. Only `.btn-icon--terminal:disabled` has a disabled style. This means:
- Disabled buttons look identical to enabled buttons (no opacity change, no cursor change)
- Keyboard users tabbing through buttons see no focus indicator
- Only specific one-off disabled states are handled (e.g., card edit button)
**Recommendation:** Add global styles:
```css
.btn:disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
.btn:focus-visible { outline: 2px solid var(--todo); outline-offset: 2px; }
```

### P1-16: Card hover effects conflict with keyboard focus

**File:** `packages/dashboard/app/styles.css` (line 533)
**Location:** `.card:hover`
**Issue:** Cards have hover effects (background change, border color change) but no `:focus` or `:focus-visible` styles. Since cards aren't focusable elements (they're `<div>` elements), keyboard navigation can't reach them at all. Cards rely entirely on mouse/touch interaction. Keyboard users have no way to open a card's detail modal without using the list view.
**Recommendation:** Add `tabindex="0"` and `:focus-visible` styles to card elements, or ensure the card's click handler is also reachable via keyboard (Enter/Space).

### P1-17: Bulk edit "Apply" button disabled state has no visual feedback

**File:** `packages/dashboard/app/components/ListView.tsx` (line ~310)
**Location:** Apply button with `disabled={isApplying || (executorModel === "__no_change__" && validatorModel === "__no_change__")}`
**Issue:** The Apply button can be disabled (when no changes are selected), but without global `.btn:disabled` styles, the button looks active and clickable even when disabled. The `.btn-primary` green color persists, creating a false affordance.
**Recommendation:** This will be fixed by the global `.btn:disabled` styles recommended in P1-15.

### P2-20: Card dragging state has no browser-native drag image override

**File:** `packages/dashboard/app/components/TaskCard.tsx`
**Location:** `handleDragStart` — no `setDragImage` call
**Issue:** When dragging a card, the browser generates a default drag ghost image (semi-transparent snapshot of the element). The card itself gets `opacity: 0.4; transform: scale(0.98)` which creates a visual disconnect — the original card fades while the drag ghost appears nearby. No custom drag image is set.
**Recommendation:** Consider using `e.dataTransfer.setDragImage()` with a compact card preview or hide the original card more aggressively during drag.

---

## 9. Visual Consistency Issues

### P1-18: Agent state CSS variables defined in two separate inline style blocks

**File:** `packages/dashboard/app/components/AgentsView.tsx` and `packages/dashboard/app/components/AgentListModal.tsx`
**Location:** Both files have inline `<style>` blocks defining `--state-idle-bg`, `--state-active-bg`, etc.
**Issue:** Agent state color variables are defined in two separate inline style blocks (AgentsView and AgentListModal) rather than in the global stylesheet. These definitions could diverge independently. Neither definition is accessible to other components that might want to show agent states (e.g., project health badges). Variables like `--state-idle-bg: rgba(139, 148, 158, 0.15)` should be part of the design system.
**Recommendation:** Move all `--state-*` color variables to the global `:root` in `styles.css` and add light theme overrides in `[data-theme="light"]`.

### P2-21: Border radius inconsistency between components

**File:** Various in `styles.css`
**Location:** Multiple components
**Issue:** Despite having a radius scale (`--radius-sm: 4px`, `--radius-md: 8px`, `--radius-lg: 12px`, `--radius-xl: 16px`), many components use hardcoded values:
- `.card-dep-badge.clickable:hover` — no border-radius
- `.toggle-slider` — uses `var(--radius-md)` for a pill shape (should use 999px or `--radius-xl`)
- `.card-status-badge` — uses `10px` (between sm and md tokens)
- `.card-size-badge` — uses `10px` (between sm and md tokens)
- `.column-count` — uses `var(--radius-xl)` for a pill
- `.project-filter-tab` — uses `999px` for pill
- `.card-steps-toggle:focus` — uses `2px` (no token)
- `.auth-status-badge` — uses `10px`
These inconsistencies make it harder to maintain a cohesive visual language.
**Recommendation:** Standardize on token usage. For pill shapes, use `999px` or add a `--radius-pill` token. For badges, consistently use either `--radius-sm` or add a `--radius-badge` token.

### P2-22: Font size hierarchy has gaps and inconsistencies

**File:** `packages/dashboard/app/styles.css`
**Location:** Multiple components
**Issue:** Font sizes used across the UI don't follow a strict scale:
- 10px: badge text, toggle labels
- 11px: column descriptions, card meta, timestamps, empty states, toggle labels, section headers
- 12px: filter inputs, column counts, agent IDs, button small
- 13px: card titles, form inputs, agent names, body text, placeholder text (base)
- 14px: buttons, column header h2, form inputs, tab labels
- 15px: project card names, modal headers
- 16px: agent name, mobile inputs
- 18px: project stat values, detail titles, agent card section heading
- 20px: logo, agents title, project overview title
- 24px: project overview title
The 10px-12px range is heavily used but has overlapping purposes. Consider defining semantic font-size tokens.
**Recommendation:** Create font-size tokens like `--font-size-xs: 10px`, `--font-size-sm: 11px`, `--font-size-base: 13px`, `--font-size-md: 14px`, `--font-size-lg: 16px` and use them consistently.

### P2-23: Shadow usage inconsistency — some components use `box-shadow` while others use `filter: drop-shadow`

**File:** `packages/dashboard/app/styles.css`
**Location:** Various
**Issue:** Shadow tokens (`--shadow-sm`, `--shadow-md`, `--shadow-lg`) are defined but not consistently used. Some components use inline shadow values:
- `.card.agent-active` — multi-layer box-shadow with rgba values
- `.project-card:hover` — uses `var(--shadow-md)` ✓
- `.step-progress-segment[data-tooltip]:hover::after` — uses `0 2px 8px rgba(0,0,0,0.2)` (not a token)
- `.modal-overlay` — no shadow
- `.toast` — uses `var(--shadow)` ✓
While most critical shadows use tokens, tooltip and incidental shadows use raw values.
**Recommendation:** Replace raw shadow values with tokens or add a `--shadow-tooltip` token.

### P2-24: Transition timing inconsistency between inline CSS and tokens

**File:** `packages/dashboard/app/components/AgentsView.tsx` and `styles.css`
**Location:** Inline styles vs CSS tokens
**Issue:** The global stylesheet defines transition tokens (`--transition-instant: 0.1s`, `--transition-fast: 0.15s`, `--transition-normal: 0.2s`, `--transition-slow: 0.3s`), but AgentsView's inline `<style>` uses raw `0.2s` values for its transitions:
- `.agent-board-card` — `transition: background var(--transition-fast), border-color var(--transition-fast)` ✓ Uses token
- `.agent-icon--clickable` — `transition: opacity 0.2s ease, transform 0.2s ease` ✗ Raw value
These inconsistencies mean timing adjustments to the design system tokens won't propagate to all animations.
**Recommendation:** Replace raw transition values with tokens throughout.

### P2-25: Duplicate `.card-error` CSS rule definition

**File:** `packages/dashboard/app/styles.css` (lines 695-706 and 714-725)
**Location:** `.card-error` block
**Issue:** The `.card-error` CSS rule is defined twice in `styles.css` with identical properties. Similarly, `.card-error-icon` and `.card-error-text` are duplicated. This appears to be a copy-paste artifact.
**Recommendation:** Remove the duplicate `.card-error`, `.card-error-icon`, and `.card-error-text` rule blocks (lines 714-725).

---

## Recommendations Summary

### Priority-Ordered Fix List

**P0 (Critical — Broken Functionality):**
1. **P0-01/P0-02:** Add missing CSS for `board-project-context`, `board-project-badge`, `list-project-context`, `list-project-badge` — multi-project badges are completely unstyled
2. **P0-03:** Fix AgentsView BEM class naming mismatch (`btn--primary` → `btn-primary`, etc.) — all agent action buttons are missing variant styles
3. **P0-04:** Add `.select` and `.input` utility classes or wrap agent form elements in `.form-group` — filter/create controls are unstyled
4. **P0-05:** Move agent state CSS variables to global `:root` — state color tokens are fragmented across inline styles
5. **P0-06:** Fix mobile board minimum content height — columns clip content on landscape phones

**P1 (High — Poor UX):**
1. **P1-15:** Add global `.btn:disabled` and `.btn:focus-visible` styles — affects ALL buttons across the app
2. **P1-03:** Fix ListView section header colSpan to include checkbox column
3. **P1-06:** Migrate AgentsView inline styles to `styles.css`
4. **P1-08:** Reduce header icon button density on desktop
5. **P1-16:** Add keyboard accessibility to TaskCard elements
6. **P1-01:** Add archived/collapsed column visual states
7. **P1-10:** Add horizontal scroll handling for TaskDetailModal tabs on desktop
8. **P1-13:** Fix mobile column hiding to use class-based selectors instead of nth-child
9. **P1-14:** Add scroll indicators for mobile settings tabs
10. **P1-18:** Consolidate agent state variables into design system

**P2 (Medium — Polish):**
1. Remove duplicate CSS rules (P2-25)
2. Standardize border-radius token usage (P2-21)
3. Create font-size semantic tokens (P2-22)
4. Replace raw shadow/transition values with tokens (P2-23, P2-24)
5. Improve empty column state (P2-01)
6. Add confirmation for project removal (P2-18)
7. Fix filter clear button consistency (P2-07)
8. Various mobile touch target improvements (P2-19)
