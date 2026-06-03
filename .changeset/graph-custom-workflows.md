---
"@runfusion/fusion": minor
---

Add executable custom workflows with a visual graph node editor. Author a workflow as a graph (start → prompt/script/gate steps → end) in a new React Flow–based editor, then select it per task or set a project default. Selected workflows compile to the existing WorkflowStep engine and run at the pre/post-merge boundaries — no changes to the scheduler/executor/merger. Non-linear graphs are rejected with a clear message and reserved for the (deferred) graph interpreter.

Prompt nodes carry an execution profile: run on a chosen model, as a named agent, as a skill invocation, or as a named project script (CLI) with the prompt passed via FUSION_NODE_PROMPT — plus per-node retries and an auto-approve toggle. "User input" nodes pause the run with a needs-input badge on the task card and a banner in the task modal; replying in comments and unpausing resumes the workflow with the answer.

CLI nodes can run arbitrary commands (not just named scripts); the first run of an exact command pauses the task for explicit user approval. The task modal's input/approval banner is interactive — reply-and-resume for user-input nodes, approve-and-run for CLI commands.

Also fixes a latent persistence bug where `pausedReason` was written to the in-memory task and read by queries but never stored by the task upsert or mapped back on read — so it was lost on every reload. This silently broke any pause/resume that depends on the reason (workflow CLI-approval and await-input nodes, token-budget pauses, worktrunk failures). The approve-CLI endpoint now derives the approved command solely from the task's pausedReason (ignoring any caller-supplied command), await-input nodes only resume when this node actually paused the task (not on a pre-existing steering comment), and write-capable custom nodes are refused until a task worktree exists so they never mutate the shared repo root.
