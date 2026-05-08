---
"@runfusion/fusion": patch
---

Remove automatic `🔍 Validate:` board task creation for single-feature validations. The mission execution loop still runs AI validation internally but no longer creates visible board tasks that violate task-authoring standards (§5). On validation failure, concrete Fix features are created as before.
