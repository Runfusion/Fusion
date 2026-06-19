# Workflow Editor

[← Docs index](./README.md)

<!--
FNXC:WorkflowEditorDocs 2026-06-16-12:00:
Fusion needs one canonical user-facing guide for the dashboard WorkflowNodeEditor so operators can discover every shipped entry point, understand the visual Workflow IR authoring model, and distinguish read-only built-ins from editable custom workflows without piecing the behavior together from settings and workflow-step references.
-->

The workflow editor is Fusion's visual workflow authoring surface in the dashboard. It uses the `@xyflow/react` canvas to view built-in lifecycle workflows and create or edit custom workflow definitions backed by Fusion's [Workflow IR](./workflow-steps.md#workflow-ir-v1). The graph you see is the same policy model the runtime uses for task lifecycle routing: nodes describe work or control-flow boundaries, edges describe how execution moves between them, and side panels declare workflow-specific columns, task fields, and typed workflow settings.

Use this guide when you want to inspect the shipped lifecycle, copy a built-in workflow before customizing it, tune workflow setting values, or design a new workflow for a project. For lower-level execution semantics, see [Workflow Steps](./workflow-steps.md). For model lane and settings resolution details, see [Settings Reference](./settings-reference.md#workflow-settings). For dashboard navigation basics, see the [Dashboard Guide](./dashboard-guide.md).

## Opening the editor

The shipped dashboard opens the same workflow editor from four places:

- **Desktop header:** click the **Workflow** button in the top header.
- **Compact/mobile header overflow:** when the header collapses, open the overflow menu and choose **Workflows**.
- **Mobile bottom navigation:** open **More** and choose **Workflows**.
- **Task detail modal:** open a task, select the **Workflow** tab, and use **Edit workflow** to open the editor with that task's workflow context.
- **Settings moved-setting stubs:** settings sections whose policy moved into workflow settings show an **Open workflow settings** redirect. It closes Settings and opens the workflow editor with the **Settings** panel selected for the active project's default workflow.

These entry points do not create different workflow formats. Desktop and mobile render different layouts for the same workflow definition.

## Canvas anatomy

The editor is a modal with a workflow picker, toolbar actions, a React Flow graph, and inspectors:

- **Workflow list / picker:** choose a built-in or custom workflow. Built-ins are labeled and remain read-only; custom workflows are editable.
- **Graph canvas:** the central React Flow surface where nodes and edges are displayed. Drag nodes to rearrange them, connect handles to create edges, and select a node or edge to inspect it.
- **Minimap and controls:** the canvas includes React Flow's minimap plus controls for zooming and fitting the graph.
- **Swimlane column bands:** workflow-defined columns render as background bands behind nodes. They mirror the Columns panel and help show where lifecycle work occurs.
- **Node palette:** add new nodes from the palette. On mobile, the same palette lives under the **Add** destination.
- **Templates section:** insert reusable graph fragments, built-in workflow-step templates, and plugin-contributed workflow-step templates when available.
- **Inspectors and side panels:** selecting a node opens its configuration inspector; selecting an edge opens the edge inspector. Separate panels manage Columns, Fields, and Settings.
- **Validation and status banners:** save-time validation errors, import warnings, branch/interpreter notices, and read-only built-in hints appear inline instead of relying only on toasts.

## Node palette

The palette contains the following shipped node options:

| Palette label | Purpose |
|---|---|
| **Prompt** | Run a model/agent prompt step in the workflow. |
| **User input** | A prompt node preset to wait for user input before continuing. |
| **Script** | Run a named script or command-like workflow step. |
| **Gate** | Evaluate a pass/fail policy boundary before routing onward. |
| **Merge boundary** | Represent the workflow's merge handoff / merge-policy seam. |
| **Hold** | Park the task until a release condition is satisfied; the palette preset uses manual release. |
| **Split** | Fan out into multiple branches. |
| **Join** | Rejoin branches; the default join waits for all branches and collects branch failures. |
| **For-each step** | Iterate over the task step list (`task-steps`) and run a template per step. |
| **Loop** | Repeat a contained sequence until its exit condition or max-iteration limit is reached. |
| **Step review** | Model per-step review verdict routing such as approve, revise, rethink, or unavailable. |
| **Parse steps** | Parse a declared artifact, such as `PROMPT.md`, into the canonical task step list. |
| **Code** | Run timeout-bounded sandboxed TypeScript for custom workflow logic. |
| **Notify** | Send a workflow-authored notification event and then continue on the normal success path. |

Some nodes expose specialized inspector fields: for example prompt execution details, hold release condition, split/join behavior, for-each concurrency and max rework cycles, parse-step artifact/parser selection, code source, and notification event/title/message.

## Edges, conditions, and rework

Create edges by connecting node handles on the graph. In the mobile and compact simple graph, use a node's **Connect** action and target picker to create the same edge without dragging on the canvas; built-in workflows hide this mutation control because they are read-only. A new connection defaults to a **success** edge. The edge inspector lets you edit routing details when the source node supports it:

- **Success / failure conditions:** prompt, script, gate, code, and for-each style sources can route on `success` or `failure`.
- **Outcome conditions:** review-style nodes route verdicts as `outcome:<verdict>` values. The shipped verdict list is `approve`, `revise`, `rethink`, and `unavailable`.
- **Read-only conditions:** for node kinds whose outgoing condition is fixed, the inspector shows the current condition instead of an editable selector.
- **Rework edges:** mark an edge as a bounded rework loop from the edge inspector. Rework edges are the only legal author-time cycles and are intended to loop within a for-each step instance, bounded by the for-each node's max rework cycles.

The editor prevents ordinary cycles while connecting nodes. If a graph branches in a way that cannot compile to the older linear step engine, the editor shows an informational interpreter banner: the workflow can still run on the graph interpreter.

## Columns panel

The **Columns** panel edits workflow-defined swimlanes. A column has an id, name, ordered position, and composable traits. The panel can add, rename, reorder, and remove columns for custom workflows; built-ins show the same data read-only.

When column-agent support is enabled by the required experimental features, a column can also assign a permanent agent with one of two modes:

- **defer:** use the column agent only when the work has no more specific agent/model setting.
- **override:** let the column agent supersede task or node agent/model choices.

Trait composition problems and policy-escalation confirmations surface in the editor before or during save. Column bands on the canvas update from this panel so the graph and lifecycle lanes stay aligned.

## Fields panel

The **Fields** panel declares custom task fields for tasks using the workflow. Field definitions include an id, display name, type, required flag, default value, enum options where applicable, and render controls such as placement and widget. Supported field types are `string`, `text`, `number`, `boolean`, `enum`, `multi-enum`, `date`, and `url`.

Fields placed on cards show a badge preview so authors can see how the value will render on the board. Server-side validation still owns the final save contract: unique ids, legal type/widget combinations, enum options, and render placement are checked when the workflow is saved.

## Settings panel: Definitions and Values

Workflow settings are typed settings declared by a workflow in its IR. The editor uses the same terms as [Concepts](../CONCEPTS.md): a **Workflow Setting** has a declaration, and the engine consumes **Effective Settings** after resolving stored values against defaults.

The **Settings** panel has two tabs:

- **Definitions:** edit the workflow's setting schema — id, name, type, default, enum options, description, and widget. This tab is read-only for built-in workflows and editable for custom workflows. Declarations save with the workflow IR through the editor's normal **Save** action.
- **Values:** edit per-project values for the currently open workflow. Values are writable even for built-in workflows. Edits batch locally and commit through the tab's dedicated **Save values** action, separate from the workflow IR save.

Resolution is `stored value ?? declaration default`. Stored values that no longer validate against the current declaration are treated as orphaned and dropped from the effective settings the engine reads. The Values tab exposes provider/model lane pairs with the same model dropdown used elsewhere in Settings, while custom settings use controls based on their declared type. See [Settings Reference → Workflow Settings](./settings-reference.md#workflow-settings) for moved settings, model lane hierarchy, export behavior, and sync posture.

## Templates and reusable pieces

The editor has two template concepts:

1. **New workflow templates:** when creating a workflow, start from **Blank**, from a built-in workflow, or from one of your existing custom workflows. Choosing a source creates a fresh copy with new ids; it is not a live reference to the source.
2. **Palette templates:** inside an editable workflow, the Templates section can insert reusable fragments, built-in workflow-step templates, and plugin-contributed workflow-step templates. Fragment insertion remaps ids and refuses seam conflicts that would duplicate a protected workflow seam.

Plugin-contributed workflow-step templates appear alongside built-ins when installed plugins provide them. They insert as preconfigured prompt or script nodes using the same metadata that powers the workflow-step chooser described in [Workflow Steps](./workflow-steps.md#plugin-contributed-steps).

## AI-assisted design

The editor can call `designWorkflow` from two places:

- **New workflow dialog:** expand the AI design area, describe the workflow you want, and submit **Design with AI**. On success, Fusion creates and opens the designed workflow. The request can be cancelled while in flight, and failures render inline in the dialog.
- **Toolbar design action:** run AI design against the active workflow. The returned graph is a proposed replacement; the editor asks for confirmation because applying it replaces the current graph and unsaved changes are lost. The replacement remains unsaved until you explicitly click **Save**.

If you switch workflows while an AI design request is in flight, the stale result is discarded instead of applying to the newly selected workflow.

## Import, export, auto-layout, save, and delete

- **Export:** downloads the active persisted workflow as a JSON envelope. Export is available for built-ins too because it reads the server's saved definition.
- **Import:** choose a JSON workflow envelope to create a workflow from it. Invalid JSON and server validation errors render in a persistent inline error region; non-blocking import warnings render beside it.
- **Auto-layout:** applies a left-to-right tidy layout to editable graph nodes. It changes positions only and marks the workflow dirty.
- **Save:** custom workflows serialize the current graph, columns, fields, and setting declarations to Workflow IR and update the active workflow. After saving, Fusion compiles the workflow to report whether it can run on the linear engine or must run on the graph interpreter.
- **Delete:** deletes the active custom workflow after confirmation. Built-in workflows cannot be deleted.
- **Duplicate to customize:** copies the active workflow, including built-ins, into a new editable custom workflow.

Save is blocked by client-side issues such as unplaced nodes and blocking column-trait violations, then by server-side workflow validation. Built-ins show read-only hints and disable mutation controls instead of allowing edits that cannot be saved.

## Built-in vs. custom workflows

Fusion ships built-in workflows as read-only references:

- `builtin:coding` — the default coding lifecycle and fallback for tasks without a workflow selection.
- `builtin:stepwise-coding` — a graph variant that models per-step parse, execute, review, and rework structure.

Built-ins can be viewed, exported, and used as templates, but their graph, columns, field declarations, and setting declarations are not editable. Their per-project setting **values** are editable from the Settings panel's Values tab.

To customize behavior, create a workflow from **Blank** or copy a built-in/custom workflow with **Duplicate to customize**. Tasks select a workflow by workflow id. Agents and automation can discover workflows with `fn_workflow_list`, assign one to an existing task with `fn_workflow_select`, or pass `workflow_id` when creating tasks through `fn_task_create` / delegation tools.

## Mobile editor

Mobile uses staged destinations to keep the same editor usable on narrow screens:

- **Graph:** shows a mobile-friendly graph/list representation and lets you select nodes or edges.
- **Add:** contains the node palette and available templates.
- **Settings:** opens the same Definitions/Values settings panel.
- **Fields:** opens custom task field definitions.
- **Columns:** opens workflow columns and traits.
- **Actions:** groups workflow-level actions such as AI design, import/export, save, duplicate, and delete depending on read-only state.

The mobile destinations edit the same workflow IR as desktop. There is no separate mobile workflow format.

## Related docs

- [Workflow Steps](./workflow-steps.md) — Workflow IR, runtime behavior, built-in workflow ids, and workflow-step templates.
- [Settings Reference](./settings-reference.md#workflow-settings) — workflow setting values, effective settings, model lane hierarchy, and moved settings.
- [Dashboard Guide](./dashboard-guide.md) — general dashboard navigation and UI surfaces.
