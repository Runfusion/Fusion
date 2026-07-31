---
"@runfusion/fusion": patch
---

summary: Wedge notifications can be resolved again on PostgreSQL projects.
category: fix
dev: jsonb_build_object is variadic "any", so PostgreSQL could not infer the type of the bare `transitionedAt` bind parameter and rejected the resolve-wedge UPDATE at parse time with 42P18. Casting the parameter to ::text fixes it; the failure was total, not data-dependent.
