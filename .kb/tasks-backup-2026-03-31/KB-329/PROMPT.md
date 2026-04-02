# Task: KB-329 - Rename Everything from kb to fusion

**Created:** 2026-03-31
**Size:** XL (Broken into subtasks)

## Review Level: 2 (Plan and Code)

**Assessment:** Comprehensive rebrand from "kb" to "Fusion" affecting packages, CLI, data storage, environment variables, and user-facing strings. This is an XL task that has been decomposed into 6 subtasks for independent execution.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 0, Security: 1 (env vars), Reversibility: 2

## Mission

Complete the comprehensive rebrand of the project from "kb" to "Fusion" across all touchpoints:
- Package names: @kb/* → @fusion/*
- Published package: @dustinbyrne/kb → @dustinbyrne/fusion
- Task IDs: KB-XXX → FN-XXX
- Git branches: kb/ → fusion/
- Environment variables: KB_* → FUSION_*
- Data directory: .fusion → .fusion
- Documentation and user-facing strings

## Dependencies

This task has been broken down into subtasks. See **Subtasks** section below.

## Subtasks

This XL task is decomposed into 6 subtasks with the following dependency chain:

| Subtask | Description | Dependencies |
|---------|-------------|--------------|
| **KB-330** | Rename internal packages from @kb/* to @fusion/* | None (foundation) |
| **KB-331** | Rename published package and CLI from @dustinbyrne/kb to @dustinbyrne/fusion | KB-330 |
| **KB-332** | Rename task ID prefix and branch naming (KB-XXX → FN-XXX, kb/ → fusion/) | KB-330 |
| **KB-333** | Rename environment variables (KB_* → FUSION_*) | KB-330 |
| **KB-334** | Rename data directory (.fusion → .fusion) | KB-330, KB-332 |
| **KB-335** | Update documentation and remaining references | KB-330, KB-331, KB-332, KB-333, KB-334 |

**Execution Order:**
1. Start with **KB-330** (internal packages) — this is the foundation
2. KB-331, KB-332, KB-333 can run in parallel after KB-330
3. KB-334 depends on KB-330 and ideally KB-332 for consistency
4. KB-335 must be last — final cleanup after all structural changes

## Execution Strategy

Each subtask has its own complete PROMPT.md specification:
- `.fusion/tasks/KB-330/PROMPT.md`
- `.fusion/tasks/KB-331/PROMPT.md`
- `.fusion/tasks/KB-332/PROMPT.md`
- `.fusion/tasks/KB-333/PROMPT.md`
- `.fusion/tasks/KB-334/PROMPT.md`
- `.fusion/tasks/KB-335/PROMPT.md`

**To execute:**
1. Move KB-330 to "todo" and begin execution
2. After KB-330 completes, move KB-331, KB-332, KB-333 to "todo" (they can run in parallel)
3. After KB-332 completes, move KB-334 to "todo"
4. After KB-331, KB-332, KB-333, KB-334 all complete, move KB-335 to "todo"

## Completion Criteria

This parent task is complete when:
- [ ] KB-330 is done (internal packages renamed)
- [ ] KB-331 is done (published package renamed)
- [ ] KB-332 is done (task IDs and branch naming updated)
- [ ] KB-333 is done (environment variables renamed)
- [ ] KB-334 is done (data directory renamed)
- [ ] KB-335 is done (documentation updated)

## Notes

- This task cannot be executed directly — it must be completed through its subtasks
- The subtasks are designed to be executed by independent agents
- Each subtask includes full context, file scope, and testing requirements
- Changesets should be created in each subtask for independent versioning
