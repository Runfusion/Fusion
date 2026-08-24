---
"@runfusion/fusion": patch
---

summary: Repair four red workspace-merge tests caused by a stale module mock.
category: internal
dev: `project-engine.test.ts` mocks `../merge/merger-ai.js` with a hand-written factory that had not kept up with the module's exports: `WorkspaceMergeDispatchSupersededError` was missing. Production imports it, so the merge-queue drain threw "No <export> is defined on the mock" before reaching the behaviour under test, and the four Phase C hardening cases failed on a resolved promise and a missing `updateTask` call rather than on what they assert. No product change; the factory now provides the class and carries a note to keep it in step with merger-ai's exported errors.
