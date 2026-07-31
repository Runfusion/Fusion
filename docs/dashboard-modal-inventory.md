<!-- FNXC:ModalTouchGeometry 2026-07-26-15:54: FN-8605's required task document was lost and FN-8615's recovery was archived incomplete. This committed inventory is the durable canonical copy so FN-8607 and later modal migrations do not have to reconstruct classifications. -->

# Dashboard modal inventory

> **Canonical copy:** This committed file is the durable canonical inventory. The identical
> `modal-inventory` task document lives on **FN-8617** because task documents are per-task and
> cannot be added retroactively to FN-8605 or archived FN-8615.

## Evidence scope and row accounting

Evidence was re-derived from `main` at **`743dc5f46ea5ebf53ff81ce1a9722ce9ef29d37a`**. The
revision-qualified glob command (`git ls-tree --name-only -r main --
packages/dashboard/app/components | grep -E 'Modal\\.tsx$'`) returned **40** files. Of the named
extras, **2** were not in that glob (`AgentDetailView.tsx`, `WorkflowNodeEditor.tsx`);
`RightDockExpandModal.tsx` matches the glob and appears exactly once.

The required `ArtifactsGallery.tsx` grep found **three distinct viewer pop-outs**—`MediaLightbox`,
`PdfViewer`, and `DocViewer`—which each render through `OverlayShell`; therefore it contributes
**3 rows** (not one vague aggregate row). The deduplicated union source-file set contains 43 files
and the union **row count is 45** (`40 + 2 + 3`).

The revision-qualified FloatingWindow, `useModalResizePersist`, shared-contract, and structural
searches were recorded in the table below. The bespoke pointer/drag/resize search was run across
all 43 union source-file pathspecs, explicitly including `AgentDetailView.tsx`,
`WorkflowNodeEditor.tsx`, and `ArtifactsGallery.tsx`; its positive surface-geometry candidates
were New Task, Right Dock Expand, and Terminal. Matches in other files were inspected and are
internal content controls (for example a sidebar splitter, list reordering, or a nested Files-pane
splitter), not modal move/resize mechanisms.

For every **D** row, the cited structural construct was directly inspected at this revision along
with its imports, handlers, geometry state, and corresponding local styling references. The note
“direct inspection” means no surface-level touch/pointer capture, custom `useDrag`/`useResize`,
drag/resize library, pointer-written window geometry, or CSS `resize` mechanism exists; where a
pointer-token match existed, the note records why it does not move or resize the modal itself.

## Shared migration contract

Migrations use `FloatingWindow` with a stable geometry-persistence key and consume
`isTabletTouchViewport` from `useViewportMode.ts`, never bare `@media (pointer: coarse)`. Effective
move/resize hit targets are at least 44px and marked `data-resize-hit-target="true"`. Phone-class
is **≤767.98px** and tablet-class starts at **768px**; JavaScript and CSS boundaries must stay in
sync. A headerless window using `hideHeader` plus `dragHandleSelector` must put the same hit-target
contract on its resolved delegated handle. `closeOnOutsidePointerDown` defaults **off**, so a
modal intended to dismiss on outside pointer-down must opt in explicitly.

## Classifications

| Surface | Class | Evidence (all at `main` SHA above) | Target | Owning subtask | Risk notes | Opt-out justification |
| --- | --- | --- | --- | --- | --- | --- |
| `ActivityLogModal.tsx` | A | `ActivityLogModal.tsx:486` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Embedded dock variant; header delegation. | — |
| `AddNodeModal.tsx` | A | `AddNodeModal.tsx:260` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Headerless delegated handle. | — |
| `AgentDetailView.tsx` | B | `AgentDetailView.tsx` `<FloatingWindow>` | already migrated | FN-8619 | Modal uses `floating-window:agent-detail`; paired mouse-only backdrop dismissal remains. Legacy size-only key is orphaned (one-time reset). | Inline presentation is explicitly gated by `inline` because its owner retains the detail layout and lifecycle. |
| `AgentErrorDetailsModal.tsx` | D | `AgentErrorDetailsModal.tsx:65` `.modal-overlay`, `role="dialog"`; direct inspection: no geometry mechanism. | stays static | FN-8607 agent/onboarding/utility | Short blocking error-detail acknowledgement. | Error detail is a brief, fault-recovery acknowledgement; moving/resizing would add state to an urgent recovery path. |
| `AgentGenerationModal.tsx` | D | `AgentGenerationModal.tsx:169` `role="dialog"`; direct inspection: no geometry mechanism. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | Generation progress can be long-running. | — |
| `AgentImportModal.tsx` | D | `AgentImportModal.tsx:473` `role="dialog" aria-modal`; direct inspection: no geometry mechanism. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | Import mapping has nested scroll. | — |
| `AgentListModal.tsx` | D | `AgentListModal.tsx:289` `.modal-overlay` / dialog; direct inspection: no geometry mechanism. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | List selection and outside dismissal. | — |
| `AgentOnboardingModal.tsx` | D | `AgentOnboardingModal.tsx:194` `.modal-overlay`; direct inspection: no geometry mechanism. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | Onboarding step chrome. | — |
| `ArtifactsGallery.tsx#MediaLightbox` | A | `ArtifactsGallery.tsx:532` `MediaLightbox`; shared `OverlayShell` at `:477` `<FloatingWindow` | already migrated | n/a | Focused media viewer; headerless delegated handle. | — |
| `ArtifactsGallery.tsx#PdfViewer` | A | `ArtifactsGallery.tsx:568` `PdfViewer`; shared `OverlayShell` at `:477` `<FloatingWindow` | already migrated | n/a | PDF viewer with nested browser scroll. | — |
| `ArtifactsGallery.tsx#DocViewer` | A | `ArtifactsGallery.tsx:706` `OverlayShell`; `:593` `DocViewerProps` | already migrated | n/a | Sandboxed HTML/markdown preview; headerless delegated handle. | — |
| `ChangesDiffModal.tsx` | A | `ChangesDiffModal.tsx:123` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Diff scroll and delegated header. | — |
| `ConnectNodeModal.tsx` | A | `ConnectNodeModal.tsx:171` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Headerless delegated handle. | — |
| `CreateRoomModal.tsx` | D | `CreateRoomModal.tsx` `<FloatingWindow windowKey="create-room">` | already migrated | FN-8621 | `floating-window:create-room`; explicit outside-pointer dismissal; member-picker remains nested scroll owner. | — |
| `DockerNodeOnboardingModal.tsx` | D | `DockerNodeOnboardingModal.tsx:214` `.modal-overlay`; direct inspection: no geometry mechanism. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | Onboarding commands and scroll. | — |
| `DuplicateWarningModal.tsx` | D | `DuplicateWarningModal.tsx:41` `.modal-overlay`; direct inspection: no geometry mechanism. | stays static | n/a | Small duplicate-decision confirmation. | This intentionally compact confirmation should stay centered and transient rather than acquire persisted window state. |
| `ExperimentalAgentOnboardingModal.tsx` | D | `ExperimentalAgentOnboardingModal.tsx:187` `.modal-overlay`; direct inspection: no geometry mechanism. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | Experimental onboarding step chrome. | — |
| `FileBrowserModal.tsx` | A | `FileBrowserModal.tsx:372` `<FloatingWindow` | already migrated | n/a | Nested Files-pane splitter is content layout, not window geometry. | — |
| `GitHubImportModal.tsx` | B | `GitHubImportModal.tsx` root `<FloatingWindow>`; nested import detail remains floating | already migrated | FN-8619 | Modal uses `floating-window:github-import`; nested import detail remains floating; legacy size-only key is replaced (one-time reset). | `useEmbeddedPresentation` / `resizePersistEnabled` explicitly keeps embedded import container-filling. |
| `GitManagerModal.tsx` | A | `GitManagerModal.tsx:1385` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Embedded right-dock presentation. | — |
| `GroupTaskModal.tsx` | A | `GroupTaskModal.tsx:107` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Branch-group detail and header delegation. | — |
| `MailboxModal.tsx` | D | `MailboxModal.tsx:731` `.modal-overlay`; direct inspection: no geometry mechanism. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | Thread/detail nested scroll. | — |
| `MilestoneSliceInterviewModal.tsx` | D | `MilestoneSliceInterviewModal.tsx:410` `.modal-overlay`; direct inspection: no geometry mechanism. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | Interview flow with step chrome. | — |
| `MissionInterviewModal.tsx` | A | `MissionInterviewModal.tsx:812` `<FloatingWindow` | already migrated | n/a | Plan Mission workspace; headerless delegated handle. | — |
| `ModelOnboardingModal.tsx` | A | `ModelOnboardingModal.tsx:2438` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Long provider onboarding flow. | — |
| `ModelSelectionModal.tsx` | D | `ModelSelectionModal.tsx:195` `.modal-overlay role="dialog"`; direct inspection: no geometry mechanism. | stays static | FN-8607 agent/onboarding/utility | Compact blocking model choice. | Model selection is a deliberately short, focused choice dialog; persistent movable geometry is unnecessary and risks obscuring the required selection. |
| `NativeShellOnboardingModal.tsx` | D | `NativeShellOnboardingModal.tsx:48` `.modal-overlay`; direct inspection: no geometry mechanism. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | Native-shell onboarding instructions. | — |
| `NewTaskModal.tsx` | A | FloatingWindow (`new-task`), headerless delegated drag host. | already migrated | FN-8620 | Phone sheet and focus trap remain; `fusion:new-task-modal-size` / `-position` superseded by `fusion:new-task-modal-geometry` (one-time reset). | — |
| `NodeDetailModal.tsx` | A | `NodeDetailModal.tsx:442` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Headerless delegated handle. | — |
| `PlanningModeModal.tsx` | A | `PlanningModeModal.tsx:3548` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Planner has internal sidebar and list drag controls; shell geometry is shared. | — |
| `PrCreateModal.tsx` | A | `PrCreateModal.tsx:549` `<FloatingWindow` | already migrated | n/a | Create-PR form; delegated header. | — |
| `ReportModal.tsx` | D | `ReportModal.tsx:79` `role="dialog" aria-modal`; direct inspection: no geometry mechanism. | stays static | n/a | Short reporting-action dialog. | Reporting is a brief confirmation/input flow; a fixed centered dialog preserves its blocking, one-shot interaction. |
| `ResearchTaskActionModal.tsx` | D | `ResearchTaskActionModal.tsx:57` `.modal-overlay`; direct inspection: no geometry mechanism. | stays static | n/a | Small action confirmation. | The modal is a bounded task-action confirmation, so persistent drag/resize state would be needless interaction cost. |
| `RightDockExpandModal.tsx` | A | FloatingWindow (`right-dock-expand`), headerless delegated drag host. | already migrated | FN-8620 | Dock-origin content remains; legacy size/position pair superseded by `fusion:right-dock-expand-modal-geometry` (one-time reset). | The expanded shell floats while content retains explicit dock-origin `surface: "expand"` behavior. |
| `ScheduledTasksModal.tsx` | A | `ScheduledTasksModal.tsx:560` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Embedded automation presentation. | — |
| `ScriptsModal.tsx` | A | `ScriptsModal.tsx:181` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Script output nested scroll. | — |
| `SettingsModal.tsx` | A | `SettingsModal.tsx:4632` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Embedded destination and internal nav-width splitter. | — |
| `SettingsSyncConflictModal.tsx` | D | `SettingsSyncConflictModal.tsx:218` `.modal-overlay`; direct inspection: no geometry mechanism. | stays static | n/a | Blocking conflict resolution. | Sync conflict resolution must remain an immediately legible centered blocking decision, not a persisted workspace window. |
| `SetupWizardModal.tsx` | D | `SetupWizardModal.tsx:452` `.modal-overlay role="dialog"`; direct inspection: no geometry mechanism. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | First-run step chrome and blocking setup. | — |
| `StashConflictModal.tsx` | D | `StashConflictModal.tsx:236` `.modal-overlay role="dialog"`; direct inspection: no geometry mechanism. | stays static | n/a | Blocking git-conflict recovery. | The conflict resolver is an urgent bounded recovery decision; centered static presentation keeps the destructive choices visible. |
| `SubtaskBreakdownModal.tsx` | D | `SubtaskBreakdownModal.tsx:607` `.modal-overlay role="dialog"`; direct inspection: list `draggable` controls reorder subtasks only, not window geometry. | migrate → FloatingWindow | FN-8607 agent/onboarding/utility | Nested subtask drag/reorder; panel itself is static. | — |
| `TaskDetailModal.tsx` | B | `TaskDetailModal.tsx` `<FloatingWindow layer="task-detail">` | already migrated | FN-8619 | Dense tabs and pop-out stacking retained; `task-detail-modal-size` is orphaned for `floating-window:task-detail` (one-time reset). | — |
| `TerminalModal.tsx` | A | Floating mode uses FloatingWindow (`terminal-<project>`), headerless delegated drag host. | already migrated | FN-8620 | Floating legacy pair superseded by `fusion:terminal-float-geometry-<project>` (one-time reset). | Docked mode is explicitly gated and retains its top-edge resize / `fusion:terminal-docked-height-<project>` because it owns dock layout. |
| `WorkflowAddStepModal.tsx` | A | `WorkflowAddStepModal.tsx:144` `<FloatingWindow` | already migrated | FN-8606 core/workflow (done) | Headerless delegated handle. | — |
| `WorkflowNodeEditor.tsx` | A | `WorkflowNodeEditor.tsx:5646` `<FloatingWindow`; `:19` `createPortal` | already migrated | n/a | Full-screen workflow editor, delegated header. | — |

## Completeness check

The table contains **45 rows**: 40 glob rows, 2 non-glob named-extra rows, and 3 independently
classified `ArtifactsGallery.tsx` viewer rows. `RightDockExpandModal.tsx` occurs once. All class-D
rows provide a concrete structural `file:line` citation plus direct-inspection result; every
`stays static` row has an explicit rationale. FN-8606’s landed core/workflow surfaces are class A
and marked **already migrated**; the remaining FN-8607 assignments match its agent/onboarding/
utility batch, with intentionally static confirmations assigned `n/a` where no migration is due.
