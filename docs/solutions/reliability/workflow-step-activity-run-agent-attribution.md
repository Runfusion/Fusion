---
category: reliability
module: workflow step-session executor
tags: [agent-runs, postgresql, telemetry, workflow]
problem_type: foreign-key-attribution
applies_when: A workflow step session needs to publish an agent run for a task without a directly assigned agent.
---

# Workflow step activity-run agent attribution

`project.agent_runs.agent_id` is a composite foreign key to the project agent roster. A lane or role label such as `executor` is not an agent ID and must never be saved as one.

Step-session activity runs first prove their candidate against the roster. A directly read agent ID wins. Otherwise, the candidate is treated as a role slug and matched against role tags. A single matching agent is valid; where a same-role pool is present, the provisioned built-in workflow role owner wins deterministically. Empty or ambiguous matches are unattributable and are not written.

Roster reads are best-effort telemetry dependencies. The resolver has one bounded, never-throwing wait and is memoized for each step-session executor, including a null verdict. Missing, throwing, rejecting, or non-settling stores therefore skip activity bookkeeping and issue one warning for the executor rather than delaying every step boundary. This follows the FN-9175 rule that telemetry cannot alter task lifecycle execution.

The executor passes the effective step identity as the candidate: a governing column agent when present, otherwise the authoritative assigned agent. Both identities are existence-proved before this boundary. This preserves attribution for assigned tasks when no column agent can resolve, such as installations with no board rows.

This applies only to `agent_runs`. `run_audit_events` and `agent_activity_events` may legitimately record `executor` as a lane label because they do not claim it is a foreign-key-backed roster identity.
