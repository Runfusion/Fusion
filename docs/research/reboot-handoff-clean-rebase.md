# Handoff: clean-rebase rebase + LCM/Stash stratégia (2026-08-11)

> Použi tento súbor ako reštartový kontext v ďalšom chate. Juž uložené aj v `.fusion/memory/MEMORY.md` (posledný zápis).

## STRATEGICKÝ ZÁVER (kritický)

**"Lossless Context Memory (LCM)" sme prevzali s VOLT** (`github.com/Martian-Engineering/volt`, research preview od Voltropy). Analyzované v `docs/research/volt-lcm-analysis.md`:
- Deterministic, DB-podporovaná LLM pamäť (immutable store + DAG summary nodes + lossless pointery, dolt/upward módy, three-level compaction-escalation, PostgreSQL 17.7 backend, nástroje lcm_expand/lcm_describe/lcm_grep).
- **LCM je dosiahnuteľné BEZ Stash.** LCM = Volt-DAG na PostgreSQL. Stash je úplne iná vec: externá sessions knowledge base (session auto-recording + source connectors), NIE DAG kompakcia.

**Memory cluster na clean-rebase sa "volá" Stash LCM backend, ale reálne implementuje Stash/TencentDB session storage** (memory-backend-stash.ts / -tencentdb.ts / RUFU-035 memory_focus) — NIE Volt-LCM. **Na clean-rebase NIE je žiadny Volt-LCM kód** (len research doc, untracked). LCM = samostatný budúci pilier, nezávislý od Stash. Userova priorita (LCM) teda NEVYŽADUJE Stash.

## GIT STAV (overené 2026-08-11)

- Branch: `clean-rebase`; HEAD = `3bd3f0563` (agentov SCHEMA fix); working tree clean (3 untracked: research doc, 2 dumpy).
- `origin/main` = **`67cdb33a9`** (advancoval z `0fc6f3d84` po fetche).
- **origin/main** vlastní migrácie `0049_fn_8864_agent_activity_events.sql`, `0053_mission_feature_spec_alignment.sql`; `SCHEMA_BASELINE_VERSION="0053"`. Žiadny 0054.
- **clean-rebase** vlastní `0049_chat_session_memory_focus.sql` (naš), `0050/0051/0052`; `SCHEMA_BASELINE_VERSION="0052"`.
- **Kolízia**: clean-rebase 0049 ≠ origin/main 0049 (rôzne migrácie). memory_focus musí byť renumované.
- Safety backup: `backup/clean-rebase-pre-rebase-20260810-232218`.

## KLASIFIKÁCIA COMMITOV (git cherry vs origin/main 67cdb33a9)

**Memory cluster (5) → PORT-TASK na origin/main U4 (NIE rebase, lebo Stash/TencentDB zostáva priorita):**
1. `63f2ada3c` - Stash+TencentDB backends
2. `409f4a606` - Stash routes
3. `25b73845f` - Stash API key
4. `109d7b62b` - stash-required agent_name+session_id
5. `2c0ad675e` - RUFU-035 memory focus (+ `0049_chat_session_memory_focus.sql` + schema-applier registrácia + celý chat UI surface)

**Net-new aux (6) → CARRIED v rebase:**
- `f89b8e06a` (TaskStore.emit)
- `91cd49557` (no-commits escape RUFU-014)
- `bfa5d37bd` (settings guard RUFU-043)
- `c424831d2` (vision doc RUFU-046)
- `7ea6f7fbd` (gitignore)
- `3addb4319` (roadmap M2)

**Absorbed/no-op (3) → rebase ich netreba (obsahovo identické na origin/main):**
- `281e3bfa9` (FN-8802, git cherry `-`)
- `4c3aaa9be` (migrations-align 0050-0052)
- `3bd3f0563` (SCHEMA baseline 0052)

## EXEKUČNÝ PLÁN (user schválil, asistent vykoná apple cherry-pick/squash)

1. Vytvor `clean-rebase-v2` z `origin/main` `67cdb33a9`.
2. Cherry-pick 6 net-new aux commitov s logickým squashom (docs spolu, fixes spolu).
3. Pridaj `memory_focus` ako NOVÝ commit na **0054** na vrch (súbor premenovaný, `MEMORY_FOCUS_VERSION="0054"`, registrácia schema-applier).
4. 5 memory-cluster commitov → port-task.
5. **NO GitHub push** (hard rule). Land na lokálny `main`.
6. Po rebase: clean up DB migration stamps (0049=agent_activity_events z main, 0050-0053 z main, 0054=memory_focus náš).

## OTVORENÉ BODY

- Dump súbory `fusion-pg-20260810-185148.dump` (219 MB) + `fusion-pg-plain.sql` (10.5 GB) — presunuté do `/tmp/fusion-dump-cleanup/`; potvrdiť zmazanie s userom.
- RUFU-067 = run-audit union-completeness gap; paused (worker-restorable).
- Port-task ešte NEVYTVORENÝ — treba `fn_task_create` pre 5 memory-cluster commitov na origin/main U4.