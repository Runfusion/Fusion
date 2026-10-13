---
"@runfusion/fusion": patch
---

summary: A plan-premise probe that git could not answer no longer reads as a verified absence and releases the card.
category: fix
dev: `gitProbe`/`gitLine` returned `string | null`, so a locked index, the 20 s timeout, an over-buffered read, and a failed spawn all collapsed into the same `null` as a successful-but-empty answer. `text-absent` and `file-absent` premises resolved `satisfied: true` on that `null`, the hold released, and an executor was dispatched to re-implement work that was already delivered. Probes now return `Probe<T>` (`{ok:true,value}` or `{ok:false,detail}` naming the subcommand and the exit-code / timeout / buffer / spawn cause). `checkPlanPremises` stops at the first unanswered probe and returns `unavailable` — the verdict the release door already holds the card for, so no episode, no escalation, no replan — and an unreadable file is no longer read as "the literal is not in there". The identity ladder reports unanswered rungs as probe failures instead of classifying a card git would not answer as a card with no branch and no repository, and an unanswered history read is named as such instead of asserting the path is absent from that history. Attribution and merge-base semantics are unchanged: an unanswered attribution probe still fails closed toward the louder `stale` route, never toward a release.
