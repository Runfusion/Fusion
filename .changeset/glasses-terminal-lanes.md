---
"@runfusion/fusion": patch
---

summary: Finished cards no longer crowd live work off the glasses board on a renamed board.
category: fix
dev: `boardToDeck` filtered active cards on the literals `archived`/`done`. Because the deck is capped at `maxCards`, a renamed complete lane meant every finished card consumed a slot and displaced live work. The route now resolves the project's terminal lanes once per request via `resolveProjectColumnsForRoles` and passes `terminalColumns` down.
