# Fusion Dashboard — UX Improvement Audit

## Methodology

This audit examined the complete Fusion dashboard UI surface by reviewing 30+ component files, the main App.tsx, the styles.css (27,744 lines with 34 color themes), and the hooks directory. The audit analyzed:

- **Desktop Experience**: Layout density, information hierarchy, navigation patterns, modal interactions, visual consistency
- **Mobile Experience**: Touch targets, responsive breakpoints, mobile-specific CSS, touch gesture handling
- **Interaction Patterns**: Loading states, error handling, empty states, transitions, progress communication
- **Accessibility**: ARIA labels, color contrast, keyboard navigation, focus management, screen reader compatibility
- **Workflow Friction**: Onboarding, task lifecycle, multi-project management, agent workflows, mission workflows

## Executive Summary

The Fusion dashboard is a feature-rich AI-powered task management system with sophisticated capabilities. The most critical UX issues center on:

1. **Information density on desktop** — The header is overloaded with 15+ actions, making it difficult to find commonly-used features
2. **Mobile navigation friction** — The bottom nav and overflow menus have discoverability issues and require too many taps for common actions
3. **Inconsistent feedback patterns** — Loading states are inconsistent across modals, and some operations lack visible feedback
4. **Settings modal complexity** — The 11-section settings sidebar is overwhelming for new users
5. **Empty state guidance** — Many views lack helpful empty state messaging to guide users

## Deduplication Note

This audit acknowledges and does not duplicate the following existing backlog items:

- **FN-1324**: Expandable textarea in QuickEntryBox/InlineCreateCard
- **FN-1325**: New Task modal full height on mobile
- **FN-1326**: Move list view search to header
- **FN-1328**: Multi-second delay when tapping a card (being addressed)
- **FN-1329**: Theme-aware focus highlight for description input
- **FN-1330**: Consolidate Board/List nav item to "Tasks"
- **FN-1331**: Horizontal scroll in task modal logs panel on mobile
- **FN-1332**: Activity Log Modal mobile layout
- **FN-1333**: Mobile touch highlight on stop button
- **FN-1334**: Reduce Terminal Tab Heights on Mobile
- **FN-1335**: Floating Search Box Below Header
- **FN-1336**: Fix Slow Settings Page Load
- **FN-1337**: Remove Name Auto-Focus in New Agent Dialog
- **FN-1338**: Agent Template Theme-Aware Backgrounds
- **FN-1339**: Move status footer above nav bar
- **FN-1343**: Create More Themes
- **FN-1357**: Make Mailbox and Site Components Theme-Aware
- **FN-1358**: Replace Agent ID Text Input with Agent Dropdown in Mailbox
- **FN-1370**: Merge execution settings page into scheduling
- **FN-1372**: Fix Android mobile nav bar height
- **FN-1374**: Mission labels truncation
- **FN-1375**: Fix Token Cap Setting UX
- **FN-1376**: Make sidebar icons theme aware
- **FN-1377**: Add More Themes
- **FN-1380**: Fix task card single-tap not opening detail modal

---

## Priority 1: Critical UX Issues

### 1.1 Header Overload on Desktop

- **Component:** `packages/dashboard/app/components/Header.tsx` (lines ~200-650)
- **Current behavior:** The header displays 15+ icon buttons without labels on desktop, including: Usage, Activity Log, Mailbox, GitHub Import, Planning, Automation, Terminal, Files, Git Manager, Nodes, Workflow Steps, Scripts, Pause, Stop, Settings, plus view toggle buttons and project selector. Users must hover over each icon to discover its function.
- **Recommended fix:** Group related actions into collapsible sections or a hamburger menu. Primary actions (Settings, Planning, Usage) should remain visible; secondary actions (Nodes, Workflow Steps, Scripts) should move to an overflow menu. Consider a "compact mode" toggle for users who want maximum screen space.
- **Impact:** All users are affected. New users cannot discover functionality, and power users waste time finding actions.
- **Effort estimate:** M

### 1.2 Modal Close Inconsistency

- **Component:** Multiple components (TaskDetailModal, SettingsModal, PlanningModeModal, etc.)
- **Current behavior:** Some modals have an explicit X button, some require clicking outside or pressing Escape, and some have both. The X button position varies (top-right vs. top-left). No keyboard shortcut hints are displayed.
- **Recommended fix:** Standardize on: (1) X button always in top-right corner, (2) "Press Esc to close" hint shown in modal footer, (3) click-outside-to-close behavior consistent across all modals. Create a shared ModalHeader component that enforces this standard.
- **Impact:** All users, particularly those using keyboard navigation, are affected.
- **Effort estimate:** M

### 1.3 Task Card Visual Overload

- **Component:** `packages/dashboard/app/components/TaskCard.tsx` (lines ~150-400)
- **Current behavior:** Task cards display up to 7 pieces of information: status badge, size badge, mission badge, agent badge, PR/issue badges, step progress, and the task title/description. Cards with many badges become visually cluttered, especially on mobile.
- **Recommended fix:** Implement progressive disclosure: show primary badges (status, size, mission) by default, with a "+N more" overflow indicator. On hover/tap, show all badges in a tooltip or expandable section. Reduce mobile card height to show more tasks per screen.
- **Impact:** All users, especially on mobile, are affected by reduced scanability.
- **Effort estimate:** M

### 1.4 Settings Modal 11-Section Complexity

- **Component:** `packages/dashboard/app/components/SettingsModal.tsx` (lines ~50-100)
- **Current behavior:** The settings sidebar has 11 sections (General, Models, Appearance, Scheduling, Worktrees, Commands, Merge, Memory, Backups, Notifications, Authentication). Each section is a separate page, requiring multiple clicks to find a setting.
- **Recommended fix:** (1) Add a search/filter input at the top of the sidebar, (2) Group related settings into 3-4 main categories with sub-sections, (3) Consider a "common settings" section for frequently-changed options, (4) Show breadcrumbs or tabs within the modal to show current location.
- **Impact:** All users, especially new users, are overwhelmed by the settings complexity.
- **Effort estimate:** L

### 1.5 Missing Keyboard Shortcuts

- **Component:** Global (App.tsx and all interactive components)
- **Current behavior:** No keyboard shortcuts are documented or discoverable. Power users who want to navigate without a mouse have no way to know what shortcuts exist (if any). Escape closes modals but no other shortcuts are implemented.
- **Recommended fix:** (1) Implement a keyboard shortcut system with common actions: N (new task), / (search), B/L/A/M (switch views), ? (show shortcuts), Ctrl+Enter (submit forms), (2) Add a "Keyboard Shortcuts" modal accessible via ? key or menu, (3) Show shortcut hints inline next to buttons where space permits.
- **Impact:** Power users and accessibility users are significantly impacted.
- **Effort estimate:** M

---

## Priority 2: High-Value Improvements

### 2.1 Empty State Guidance

- **Component:** Multiple views (Board.tsx, ListView.tsx, AgentsView.tsx, MissionManager.tsx)
- **Current behavior:** When views are empty (no tasks, no agents, no missions), users see blank space or minimal messaging like "No tasks found." No guidance is provided on what to do first.
- **Recommended fix:** Create a shared EmptyState component with:
  - Illustration or icon appropriate to the context
  - Primary message explaining what this view is for
  - Actionable next step (e.g., "Create your first task" with a prominent button)
  - Link to documentation if applicable
- **Impact:** New users are confused about where to start.
- **Effort estimate:** S

### 2.2 Toast Notification Improvements

- **Component:** `packages/dashboard/app/components/ToastContainer.tsx` and `useToast.ts`
- **Current behavior:** Toasts appear but have limited customization: no icons, limited positioning options, no action buttons, and no stacking management when multiple toasts appear simultaneously.
- **Recommended fix:** (1) Add type-specific icons to toasts (success checkmark, error X, warning triangle, info circle), (2) Add optional action buttons to toasts (e.g., "Undo" for deletions), (3) Implement toast stacking with a max visible limit and overflow indicator, (4) Add optional dismiss delay based on toast type (errors persist until dismissed, successes auto-dismiss after 4s).
- **Impact:** All users benefit from better feedback on operations.
- **Effort estimate:** S

### 2.3 Progress Indicator for Long Operations

- **Component:** PlanningModeModal.tsx, SubtaskBreakdownModal.tsx, GitManagerModal.tsx, MissionManager.tsx
- **Current behavior:** Long operations like AI planning, task breakdown, git operations, and mission interviews show a spinner or streaming text but lack: (1) Estimated time remaining, (2) Current step indicator, (3) Option to cancel, (4) Background execution with notification on completion.
- **Recommended fix:** (1) Add step indicators showing "Step 2 of 5: Analyzing requirements...", (2) Add cancel buttons for interruptible operations, (3) Implement background execution option for operations >10s with desktop notification on completion, (4) Show elapsed time counter.
- **Impact:** Users performing AI planning or complex git operations are left uncertain about progress.
- **Effort estimate:** M

### 2.4 Inline Edit Mode for Task Cards

- **Component:** `packages/dashboard/app/components/TaskCard.tsx` (lines ~130-180)
- **Current behavior:** Editing task title or description requires opening the full TaskDetailModal. Quick edits like changing a title typo or adding a dependency take 4+ clicks.
- **Recommended fix:** Add an edit mode to TaskCard where clicking the title or description makes it editable inline. Show save/cancel buttons, and persist changes on blur or Enter. Maintain existing modal flow for comprehensive editing.
- **Impact:** Power users performing many quick edits are slowed down.
- **Effort estimate:** M

### 2.5 Drag-and-Drop Feedback Enhancement

- **Component:** `packages/dashboard/app/components/Column.tsx`, `packages/dashboard/app/components/Board.tsx`
- **Current behavior:** When dragging a task card, the visual feedback is minimal: the card becomes semi-transparent, but drop targets don't highlight and insertion position is unclear.
- **Recommended fix:** (1) Highlight valid drop zones with a subtle background color, (2) Show a visual indicator (line or gap) where the task will be inserted, (3) Add haptic feedback on mobile when crossing drop zones, (4) Show task count in each column header during drag to help with decision-making.
- **Impact:** Users organizing many tasks benefit from clearer drag feedback.
- **Effort estimate:** S

### 2.6 Agent View Complexity

- **Component:** `packages/dashboard/app/components/AgentsView.tsx` (lines ~50-300)
- **Current behavior:** The agents view offers 4 view modes (board, list, tree, org) with no clear indication of when to use each. The hierarchy tree is collapsed by default and difficult to navigate for large agent fleets.
- **Recommended fix:** (1) Add view mode descriptions on hover/tap, (2) Default to list view for small fleets, board for medium, tree for large, (3) Add search/filter to tree view, (4) Add "expand all" / "collapse all" actions, (5) Show agent count badges in view toggle.
- **Impact:** Users managing agent hierarchies struggle with navigation.
- **Effort estimate:** M

### 2.7 Mission Manager Complexity

- **Component:** `packages/dashboard/app/components/MissionManager.tsx` (lines ~100-600)
- **Current behavior:** The mission manager is a complex hierarchy: Missions → Milestones → Slices → Features. Users can easily get lost navigating between levels. The breadcrumbs/back navigation are unclear.
- **Recommended fix:** (1) Add persistent breadcrumbs showing current location (Mission > Milestone > Slice), (2) Add a "back to parent" button in each sub-view, (3) Implement a breadcrumb-based drill-down instead of accordion/expansion, (4) Add a mini-map or overview panel showing current position in hierarchy.
- **Impact:** Users managing complex missions struggle with navigation depth.
- **Effort estimate:** M

### 2.8 Git Manager Complexity

- **Component:** `packages/dashboard/app/components/GitManagerModal.tsx` (2,290 lines)
- **Current behavior:** The Git Manager is a monolithic modal with tabs for status, staging, committing, branching, and history. The sheer size (2,290 lines) indicates a complex interface that may overwhelm users.
- **Recommended fix:** (1) Split into multiple focused modals or a multi-panel layout, (2) Add a guided mode for common operations (commit changes, create branch, merge), (3) Implement a command-line preview showing equivalent git commands for transparency, (4) Add visual diff preview for staged changes.
- **Impact:** Users unfamiliar with git are intimidated by the complex interface.
- **Effort estimate:** L

### 2.9 Undo/Redo for Destructive Actions

- **Component:** Global
- **Current behavior:** Deleting a task, agent, mission, or other item is permanent. No confirmation dialog with "Undo" option. Users who accidentally delete must recreate from scratch.
- **Recommended fix:** (1) Add "Undo" toast for 10 seconds after deletions, (2) Implement soft-delete with trash/restore functionality, (3) Add Ctrl+Z keyboard shortcut for undo in supported contexts, (4) Show "Deleted. Undo?" toast with action button.
- **Impact:** All users risk data loss from accidental deletions.
- **Effort estimate:** M

### 2.10 Loading State Inconsistency

- **Component:** Multiple components (SettingsModal, AgentsView, MissionManager, etc.)
- **Current behavior:** Some components show skeleton screens, some show spinners, some show no loading indicator at all. The inconsistency makes the app feel less polished and can confuse users about whether an action succeeded.
- **Recommended fix:** (1) Create a shared LoadingSpinner and SkeletonLoader component with consistent styling, (2) Use skeleton screens for content-heavy areas (task list, agent list), (3) Use spinners for quick operations (<2s), (4) Add loading overlays for modal content with centered spinner, (5) Ensure all API calls have loading state handling.
- **Impact:** All users benefit from consistent loading feedback.
- **Effort estimate:** S

---

## Priority 3: Polish & Delight

### 3.1 Cursor Changes for Interactive Elements

- **Component:** Global (styles.css)
- **Current behavior:** Not all interactive elements have appropriate cursor styles. Buttons, links, and draggable items sometimes use the default arrow cursor instead of pointer.
- **Recommended fix:** Audit styles.css for `cursor: pointer` on all interactive elements (buttons, links, checkboxes, drag handles, expandable sections). Add `cursor: grab` for draggable items and `cursor: grabbing` when actively dragging.
- **Impact:** Minor visual polish that improves perceived quality.
- **Effort estimate:** S

### 3.2 Focus Order in Complex Modals

- **Component:** Multiple modals (TaskDetailModal, SettingsModal, AgentDetailView)
- **Current behavior:** Focus order in complex modals follows DOM order, which may not follow logical user flow. After completing an action in a sub-section, focus jumps unexpectedly.
- **Recommended fix:** (1) Audit focus order in all complex modals, (2) Use `tabIndex` to control focus order where DOM order is suboptimal, (3) Return focus to the triggering element when modals close, (4) Add skip links for modal content.
- **Impact:** Keyboard and screen reader users benefit significantly.
- **Effort estimate:** S

### 3.3 Color Contrast in Status Badges

- **Component:** `styles.css` (34 color themes)
- **Current behavior:** Status badge colors (triage, todo, in-progress, etc.) may have insufficient contrast with background colors in certain themes, especially light themes.
- **Recommended fix:** Audit all status badge colors across all 34 themes for WCAG AA compliance (4.5:1 for text). Use darker variants of status colors in light themes. Test with accessibility tools.
- **Impact:** Users with visual impairments may struggle to distinguish status badges.
- **Effort estimate:** M

### 3.4 Transition Animations

- **Component:** Global (styles.css and components)
- **Current behavior:** View transitions (board → list, modal open/close) are instant with no animation. The abrupt change can feel jarring and makes it harder to understand spatial relationships.
- **Recommended fix:** (1) Add fade + slide transitions for modal open/close (200ms), (2) Add subtle fade for view switches, (3) Add staggered animations for list item appearance, (4) Consider motion for status changes (task moving columns), (5) Respect `prefers-reduced-motion` media query.
- **Impact:** All users benefit from smoother, more understandable transitions.
- **Effort estimate:** M

### 3.5 Responsive Table for List View

- **Component:** `packages/dashboard/app/components/ListView.tsx` (lines ~300-700)
- **Current behavior:** The list view uses a fixed table layout that doesn't adapt well to different screen widths. Columns may overlap or become unusable on smaller tablets.
- **Recommended fix:** (1) Implement horizontal scroll for the table with sticky first column, (2) Allow users to reorder and show/hide columns, (3) Collapse less important columns to icons on smaller screens, (4) Add a "compact mode" for dense data display.
- **Impact:** Users on tablets or with large monitors have suboptimal experience.
- **Effort estimate:** M

### 3.6 Persistent User Preferences

- **Component:** Multiple components
- **Current behavior:** Many UI preferences (column order, expanded/collapsed sections, filter settings, view mode) reset on page reload. Users must reconfigure their preferred view each session.
- **Recommended fix:** (1) Persist all UI preferences to localStorage, (2) Sync preferences across browser tabs, (3) Add "Reset to defaults" option in settings, (4) Allow exporting/importing preference profiles.
- **Impact:** Power users who customize their view benefit from persistence.
- **Effort estimate:** M

### 3.7 Notification Badge Management

- **Component:** Header.tsx, MobileNavBar.tsx, ExecutorStatusBar.tsx
- **Current behavior:** Badge counts (unread messages, active planning sessions) appear as numbers but have no way to: (1) Mark all as read, (2) View just the count without navigating, (3) Configure which notifications trigger badges.
- **Recommended fix:** (1) Add "Mark all read" action in each context, (2) Show notification preview on hover (desktop), (3) Add badge count overflow indicator (9+), (4) Consider notification center dropdown showing recent notifications.
- **Impact:** Users with many unread items are overwhelmed.
- **Effort estimate:** S

### 3.8 Copy-to-Clipboard Feedback

- **Component:** Multiple components (TaskCard, AgentDetailView, ActivityLogModal, etc.)
- **Current behavior:** Copying task IDs, agent IDs, or other values to clipboard has no visual feedback. Users don't know if the copy succeeded.
- **Recommended fix:** (1) Add "Copied!" tooltip or toast on successful copy, (2) Add subtle highlight animation on the copied element, (3) Implement "Copy" button next to all copyable values with icon.
- **Impact:** All users benefit from confirmation of copy actions.
- **Effort estimate:** S

---

## Priority 4: Future Considerations

### 4.1 Multi-Tab/Session Synchronization

- **Current behavior:** Opening Fusion in multiple browser tabs leads to stale data and potential conflicts. Changes in one tab aren't reflected in others.
- **Recommended approach:** Implement BroadcastChannel or WebSocket-based tab synchronization. Show "Another tab made changes" banner with refresh option.
- **Effort estimate:** L

### 4.2 Offline Mode

- **Current behavior:** The dashboard requires a server connection. Offline users see errors or blank screens.
- **Recommended approach:** Implement service worker caching for read-only offline access. Queue mutations for sync when online. Show offline indicator in header.
- **Effort estimate:** L

### 4.3 Collaborative Features

- **Current behavior:** No real-time collaboration indicators. Users don't know if others are viewing/editing the same task.
- **Recommended approach:** Show "Viewing" indicators when others have a task open. Implement conflict resolution for simultaneous edits. Add presence indicators in agent views.
- **Effort estimate:** L

### 4.4 Command Palette

- **Current behavior:** All navigation requires clicking through menus or using the sidebar.
- **Recommended approach:** Implement a command palette (Ctrl+K) with fuzzy search for all actions, tasks, agents, and missions. Show recently used actions. Include keyboard shortcut hints.
- **Effort estimate:** M

### 4.5 Advanced Filtering and Views

- **Current behavior:** Filtering is limited to text search and basic column filters.
- **Recommended approach:** Implement a query builder for advanced filters (e.g., "status=in-progress AND size=L AND assignedAgent EXISTS"). Save filter presets. Share filter URLs.
- **Effort estimate:** M

---

## Theme Consistency Issues

### T1.1 Inconsistent Button Padding

- **Component:** `styles.css` (multiple button styles)
- **Current behavior:** Different button variants have inconsistent padding: `.btn` uses `var(--btn-padding)`, icon buttons use fixed values, CTA buttons have custom padding. This creates visual inconsistency.
- **Recommended fix:** Standardize on CSS custom property spacing for all button types. Document padding tokens in the design system.
- **Effort estimate:** S

### T1.2 Status Badge Border Radius Inconsistency

- **Component:** `styles.css` (badge styles)
- **Current behavior:** Some badges use `border-radius: var(--radius-sm)`, others use `border-radius: var(--radius-md)`, and some have custom values. The inconsistency is visible when badges of different types are adjacent.
- **Recommended fix:** Standardize all status badges to a consistent border radius. Create a `.badge` base class with variants.
- **Effort estimate:** S

### T1.3 Modal Overlay Opacity Variations

- **Component:** `styles.css` (modal styles)
- **Current behavior:** Modal overlays use different opacity values: some use 0.5, others use 0.7, and there's no systematic approach.
- **Recommended fix:** Define `--modal-overlay-opacity` in `:root` and use it consistently. Dark themes may need different opacity than light themes.
- **Effort estimate:** S

### T1.4 Input Focus Ring Inconsistency

- **Component:** `styles.css` (form input styles)
- **Current behavior:** Text inputs, select dropdowns, and checkboxes have different focus ring styles: some use `box-shadow`, others use `outline`, and colors vary.
- **Recommended fix:** Create a shared `.focus-ring` utility class and apply it consistently. Use `--focus-ring` token defined in :root.
- **Effort estimate:** S

### T1.5 Typography Scale Inconsistency

- **Component:** `styles.css` (typography styles)
- **Current behavior:** The font size scale is not systematically applied. Headings, body text, labels, and captions have ad-hoc sizes rather than a defined scale.
- **Recommended fix:** Define a complete type scale in CSS custom properties (--text-xs, --text-sm, --text-base, --text-lg, --text-xl, etc.) and apply it consistently across components.
- **Effort estimate:** M

---

## Mobile-Specific Issues

### M1.1 Header Action Overload on Mobile

- **Component:** `packages/dashboard/app/components/Header.tsx` (lines ~350-450)
- **Current behavior:** Even with mobile nav enabled, the header still shows some actions (Usage, View toggle). The mobile overflow menu requires multiple taps to access common actions.
- **Recommended fix:** (1) Move ALL actions to the overflow menu on mobile, (2) Prioritize actions in overflow by frequency of use, (3) Show a compact version of the bottom nav's "More" section directly in the header, (4) Consider a swipe-up gesture for overflow menu.
- **Impact:** Mobile users struggle to find common actions.
- **Effort estimate:** S

### M1.2 Touch Target Size on Dense Lists

- **Component:** `packages/dashboard/app/components/ListView.tsx` (lines ~400-500)
- **Current behavior:** List view rows with multiple actions (move, delete, edit) have touch targets <44px, making precise tapping difficult.
- **Recommended fix:** Increase row height on mobile, separate action buttons with adequate spacing, consider swipe gestures for common row actions (swipe left to delete, swipe right to move).
- **Impact:** Mobile users frequently miss-tap on dense list views.
- **Effort estimate:** S

### M1.3 Modal Scrolling Issues

- **Component:** Multiple modals (TaskDetailModal, SettingsModal, AgentDetailView)
- **Current behavior:** Modals scroll independently from the page, but the scroll position may jump when content loads asynchronously. On iOS Safari, momentum scrolling can feel sluggish.
- **Recommended fix:** (1) Use `-webkit-overflow-scrolling: touch` for modal content, (2) Preserve scroll position when content updates, (3) Add pull-to-refresh in modal content where applicable, (4) Ensure modal content doesn't push behind the safe area inset.
- **Impact:** Mobile users experience jarring scroll behavior.
- **Effort estimate:** S

### M1.4 Keyboard Appearing/Disappearing Layout Shift

- **Component:** Global (modals with form inputs)
- **Current behavior:** When the virtual keyboard appears, the layout doesn't always adjust properly. Input fields may be hidden behind the keyboard, and the viewport may not scroll to show the focused input.
- **Recommended fix:** (1) Use `scrollIntoView` when inputs receive focus, (2) Test on actual iOS/Android devices, (3) Consider using `visualViewport` API for more reliable keyboard detection, (4) Ensure modal height accounts for keyboard.
- **Impact:** Mobile users on iOS/Android struggle with form inputs in modals.
- **Effort estimate:** M

### M1.5 Pull-to-Refresh on Task Lists

- **Component:** `packages/dashboard/app/components/Board.tsx`, `packages/dashboard/app/components/ListView.tsx`
- **Current behavior:** No pull-to-refresh gesture on task lists. Users must find and tap a refresh button or navigate away and back to refresh.
- **Recommended fix:** Implement pull-to-refresh using a library like `react-pull-to-refresh` or custom implementation with `touchstart`/`touchmove`/`touchend` events. Show spinner during refresh.
- **Impact:** Mobile users expect pull-to-refresh as a standard gesture.
- **Effort estimate:** S

### M1.6 Bottom Sheet Style for Mobile Menus

- **Component:** MobileNavBar.tsx, Header.tsx overflow menu
- **Current behavior:** Mobile menus use a full-screen modal style which covers too much content and requires dismissing to see context.
- **Recommended fix:** Convert overflow menus and action sheets to bottom sheet style (slides up from bottom, shows partial height, can be dragged to dismiss or expand). This is consistent with iOS/Android design patterns.
- **Impact:** Mobile users would benefit from more contextual menus.
- **Effort estimate:** M

### M1.7 Swipe Gestures for Task Cards

- **Component:** `packages/dashboard/app/components/TaskCard.tsx`
- **Current behavior:** No swipe gestures on task cards. All actions require tapping to open the card.
- **Recommended fix:** Implement swipe gestures: swipe right to move to next column, swipe left to access quick actions (archive, delete), long press to multi-select.
- **Impact:** Mobile users could perform common actions faster with gestures.
- **Effort estimate:** M

---

## Accessibility Gaps

### A1.1 Missing ARIA Labels on Icon Buttons

- **Component:** `packages/dashboard/app/components/Header.tsx` (lines ~400-600)
- **Current behavior:** Many icon-only buttons have `title` attributes but no `aria-label`. Screen readers read the icon's SVG path content or nothing at all.
- **Recommended fix:** Audit all icon buttons and add explicit `aria-label` with descriptive text (e.g., `aria-label="Open settings"` not just `title="Settings"`).
- **Impact:** Screen reader users cannot identify icon button purposes.
- **Effort estimate:** S

### A1.2 Live Regions for Dynamic Content

- **Component:** ToastContainer.tsx, ExecutorStatusBar.tsx, SessionNotificationBanner
- **Current behavior:** Toast notifications and status bar updates don't use ARIA live regions. Screen reader users miss important status changes.
- **Recommended fix:** Wrap toast notifications in `<div role="status" aria-live="polite">` and status updates in `<div aria-live="assertive">` for critical changes.
- **Impact:** Screen reader users miss important feedback.
- **Effort estimate:** S

### A1.3 Modal Focus Trap Incompleteness

- **Component:** Multiple modals (AppModals.tsx)
- **Current behavior:** Focus trap implementation may not cover all interactive elements in complex modals. Focus can escape to page content behind the modal.
- **Recommended fix:** (1) Use a proven library like `react-focus-trap` or `react-aria`, (2) Test focus trapping in all modals, (3) Add "Skip to main content" link that enters the modal correctly.
- **Impact:** Keyboard users can accidentally interact with background content.
- **Effort estimate:** M

### A1.4 Color-Only Status Indicators

- **Component:** Multiple components (TaskCard badges, Agent state indicators)
- **Current behavior:** Some status indicators use color alone to convey meaning (e.g., green dot = active, red dot = error) without text labels or icons.
- **Recommended fix:** (1) Always pair color with text or icon, (2) Use `aria-label` to describe the status, (3) Test with color blindness simulators, (4) Consider a legend or summary for complex color-coded displays.
- **Impact:** Users with color blindness cannot distinguish status indicators.
- **Effort estimate:** S

### A1.5 Skip Links

- **Component:** App.tsx
- **Current behavior:** No skip links to bypass the header and navigation and jump directly to main content.
- **Recommended fix:** Add "Skip to main content" and "Skip to navigation" links as the first elements in the DOM, visually hidden until focused.
- **Impact:** Keyboard users must tab through all navigation items on every page load.
- **Effort estimate:** S

### A1.6 Heading Hierarchy

- **Component:** Multiple components
- **Current behavior:** Heading levels (h1, h2, h3) may not follow proper hierarchy. Some pages use multiple h1s, others skip levels.
- **Recommended fix:** Audit heading structure across all views. Ensure single h1 per page, logical h2/h3 hierarchy, no skipped levels. Use sectioning elements appropriately.
- **Impact:** Screen reader users rely on headings for navigation.
- **Effort estimate:** M

### A1.7 Form Error Announcement

- **Component:** SettingsModal.tsx, TaskForm.tsx, NewAgentDialog.tsx
- **Current behavior:** Form validation errors are displayed visually but not announced to screen readers. Errors may be in visually-hidden containers that screen readers skip.
- **Recommended fix:** (1) Associate error messages with form fields using `aria-describedby`, (2) Use `aria-invalid="true"` on invalid fields, (3) Use `role="alert"` or live regions for error summaries, (4) Move focus to first error on form submission failure.
- **Impact:** Screen reader users cannot determine form errors.
- **Effort estimate:** S

### A1.8 Table Accessibility

- **Component:** `packages/dashboard/app/components/ListView.tsx` (lines ~300-400)
- **Current behavior:** The list view renders as a `<table>` but may not use proper table semantics (`<thead>`, `<tbody>`, `scope` attributes, caption).
- **Recommended fix:** Ensure proper table structure: `<caption>` for table purpose, `<th scope="col">` for column headers, `<th scope="row">` for row headers where applicable. Add `aria-sort` to sortable column headers.
- **Impact:** Screen reader users cannot understand table structure.
- **Effort estimate:** S

---

## Quick Wins (Under 1 hour each)

### QW-1: Add aria-label to all icon buttons
**File:** `packages/dashboard/app/components/Header.tsx`
**Change:** Add `aria-label` prop to all icon-only buttons
**Effort:** 15 minutes

### QW-2: Add "Press Esc to close" hint to modals
**File:** `packages/dashboard/app/components/TaskDetailModal.tsx` and others
**Change:** Add small text hint in modal footer: "Press Esc to close"
**Effort:** 10 minutes

### QW-3: Add success/error icons to toasts
**File:** `packages/dashboard/app/components/ToastContainer.tsx`
**Change:** Add Lucide icons based on toast type (CheckCircle, XCircle, AlertTriangle, Info)
**Effort:** 10 minutes

### QW-4: Add "Copied!" feedback for copy actions
**File:** Multiple components with copy functionality
**Change:** Show temporary "Copied!" text after successful copy
**Effort:** 15 minutes

### QW-5: Add cursor:pointer to all interactive elements
**File:** `packages/dashboard/app/styles.css`
**Change:** Audit and add `cursor: pointer` to `.btn`, `.btn-icon`, links, and clickable cards
**Effort:** 15 minutes

### QW-6: Add skip link to App.tsx
**File:** `packages/dashboard/app/App.tsx`
**Change:** Add visually-hidden "Skip to main content" link as first element
**Effort:** 10 minutes

### QW-7: Standardize modal close button position
**File:** `packages/dashboard/app/components/TaskDetailModal.tsx` and others
**Change:** Ensure X button is always in top-right corner with consistent styling
**Effort:** 20 minutes

### QW-8: Add loading spinner to agents list
**File:** `packages/dashboard/app/components/AgentsView.tsx`
**Change:** Add spinner when `isLoading` is true before agents load
**Effort:** 10 minutes

### QW-9: Add aria-live region for unread count badges
**File:** `packages/dashboard/app/components/Header.tsx`
**Change:** Wrap badge count updates in `aria-live="polite"` region
**Effort:** 10 minutes

### QW-10: Improve empty state for task list
**File:** `packages/dashboard/app/components/Board.tsx`
**Change:** Replace "No tasks" with helpful message and CTA button
**Effort:** 15 minutes

### QW-11: Add hover/focus states to table rows
**File:** `packages/dashboard/app/components/ListView.tsx`
**Change:** Add visual feedback for keyboard focus and mouse hover on rows
**Effort:** 10 minutes

### QW-12: Add "Mark all read" for mailbox
**File:** `packages/dashboard/app/components/MailboxModal.tsx`
**Change:** Add button to mark all messages as read
**Effort:** 10 minutes

---

## Summary Statistics

- **Total Findings:** 43
- **Critical (Priority 1):** 5
- **High-Value (Priority 2):** 10
- **Polish (Priority 3):** 8
- **Future (Priority 4):** 5
- **Theme Issues:** 5
- **Mobile-Specific:** 7
- **Accessibility:** 8
- **Quick Wins:** 12

---

*Report generated by FN-1379 UX Audit Task*
