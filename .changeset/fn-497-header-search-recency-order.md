---
"@runfusion/fusion": patch
---

summary: Header task search now lists matching tasks newest first, and paging stays in that order.
category: fix
dev: The `if (query)` branch of `listCurrentTasksPageImpl` now orders by `created_at DESC, id DESC` and continues with an exclusive `<` keyset predicate; order and cursor are inverted together through the exported `buildTaskSearchPageOrder`/`buildTaskSearchPageCursorPredicate` helpers. Board table pagination (no query) keeps its ascending `created-asc` contract, and search membership, totals, and cursor format are unchanged.
