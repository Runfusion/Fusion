---
"@runfusion/fusion": patch
---

summary: Stop waking reviewer agents for cards that cannot have an open code review.
category: fix
dev: Wake-time bind revalidation in `executeHeartbeat` is now the single wake-admission owner: reviewer-only lanes additionally pass a candidacy verdict (`review-candidacy-mismatch`, same deduped no-mutation decline), with shared verdict predicates in `@fusion/core/workflows/review-verdict-state`. Mixed reviewer+executor lanes, comment-delivery wakes and automation sweep wakes are never declined. Carried comment ids are no longer re-advertised as new.
