# Permanent Agent Heartbeat Playbooks

[← Agents](./agents.md)

Operator and implementer playbooks for durable (permanent) agent heartbeats. Heartbeats are **coordination** windows; task-body implementation runs on the executor path.

## Mental model

1. Wake (timer / assignment / message / on-demand)
2. Identity + Wake Delta + procedure
3. **One** concrete coordination action
4. Disposition + `fn_heartbeat_done`

Do **not** implement code, run tests, or commit from a default strict heartbeat.

## Playbook: Manager health tick

1. Process inbox / room notices first.
2. Read reports-health (if present) for stale direct reports.
3. Pick **one**: reassign blocked child, message an idle specialist, or create a focused follow-up.
4. Log outcome with next owner; `fn_heartbeat_done`.

## Playbook: Message / comment wake

1. Acknowledge the wake payload (message id or comment).
2. If one clear action: reply / create / delegate — then exit (scoped-wake).
3. Do not open a multi-step investigation in the same tick.

## Playbook: Bound task is executor-class or blocked

1. Do **not** re-read PROMPT.md to implement.
2. Skim for blocker risk; pivot to board signals (stale in-review, idle reports, memory themes).
3. **Blocked dedup:** if the same blocker was already logged and nothing new arrived → no-op with reason.

## Playbook: No-task ambient run

1. Inbox first.
2. Prefer auto-claim candidates only when policy allows and role matches.
3. Create or delegate **one** focused task; never unscheduled implementation with ambient tools alone.

## Playbook: Multi-assign inventory in Wake Delta

When Wake Delta lists “your assigned tasks (coordination inventory…)”:

- Use it to **unblock, reassign, or prioritize** — not to code.
- Bound line (`assigned task: FN-…`) remains the singular execution bind.
- Foreign `lease: held-by-other` → do **not** retry checkout this tick.

## Playbook: Empty wake / nothing to do

Explicit no-op with reason is success:

```text
fn_heartbeat_done summary: "No new inbox or wake delta; no open coordination lever; no-op."
```

## Anti-patterns

| Avoid | Prefer |
|---|---|
| Implement / test / commit in heartbeat | Executor path / create task |
| Re-comment same blocker every tick | Blocked dedup no-op |
| Retry checkout on conflict | Exit / other work |
| Pause task on failure | Log + create/delegate follow-up |
| Duplicate `fn_task_create` without scan | Scan open tasks first |
| Self-only “please review” with no real review path | Explicit reviewer / `in-review` handoff |

## Related

- Composition and settings: [Agents](./agents.md)
- Domain vocabulary: [CONCEPTS.md](../CONCEPTS.md)
