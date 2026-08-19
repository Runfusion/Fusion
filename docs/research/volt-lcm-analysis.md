# Volt Lossless Context Management (LCM) — Technická analýza

> Zdroj: `github.com/Martian-Engineering/volt` (default branch `dev`, MIT, research preview od Voltropy, forknuté z OpenCode).
> Dátum analýzy: 2026-08. Overené priamo zo zdroja (README, `CLAUDE.md`, `packages/voltcode/src/session/lcm/config.ts`, `compaction-escalation.ts`).

---

## 1. Jednovetová definícia

Deterministická, **databázou podporovaná** architektúra pamäte LLM, ktorá **presúva zodpovednosť za pamäť z modelu na engine**: udržiava **DAG súhrnov** v persistentnom transakčnom store, agresívne komprimuje context a zároveň zachováva **bezextratové (lossless) ukazatele** na originál — žiadna správa zo skoršieho behu sa nikdy nestratí.

## 2. Dual-state memory architektúra (jadro)

- **Immutable Store** (zdroj pravdy): každá user správa, asistentova odpoveď, tool výsledok sa uloží **verbatím a nikdy nemení**.
- **Active Context** (okno poslané LLM pri každom turne): zostavené z **nedávnych raw správ + vopred pripravených Summary Nodes** (komprimované náhrady starších správ).
  - **Summary Nodes = materializované pohľady (cache) nad immutable históriou ≠ zdroj pravdy.**
- Core = **Directed Acyclic Graph (DAG)** v persistentnom store s transakčnými zápismi, FK integritou, indexovaným vyhľadávaním.

## 3. Deterministický kontrolný cyklus (nepretečie, nečaká)

- **Pod soft thresholdom:** žiadna summarizácia, beží raw latencia modelu.
- **Nad soft thresholdom:** kompaktácia beží **asynchrónne medzi turnmi**, výsledný súhrn sa **atómovo swapuje** do contextu pred ďalším turnom → **nikdy nečakáš na kompresiu**.

## 4. Three-level escalation (zaručená konvergencia)

`compaction-escalation.ts`, `CompactionEscalationTier = "normal" | "aggressive" | "fallback"`:

1. **Normal (pass 1):** štandardný LLM súhrn. Akceptuje sa len ak `Token.estimate(output) < inputTokens` (striktná redukcia, non-empty) — `shouldAcceptCompactionOutput`.
2. **Aggressive (pass 2):** ak pass 1 nebol kratší než vstup → `withAggressiveCompactionDirective` pridá `## Aggressive Compression Override` direktívu.
3. **Fallback (pass 3):** deterministický truncation **bez LLM** (`buildDeterministicFallbackCompaction`) — binárnym vyhľadávaním najväčší prefix spĺňajúci token-redukciu, s `[label; truncated from N tokens]` sufixom. → **garancia konvergencie.**

## 5. Dva runtime módy (`VOLTCODE_LCM_MODE` = `dolt` | `upward`, default `upward`)

| | **dolt** | **upward** |
|---|---|---|
| Kompakcia | evictne najstaršie **bindles** (top summary nodes) pri prekročení budgetu | rekurzívne kondenzuje súhrny bottom-up do neobmedzenej hĺbky (d1→d2→d3→dN, d3 prompt reusable) |
| Off-context retrieval (`lcm_expand_query`, pre-response cues) | ✅ evictnuté bindles searchovateľné (ghost cues + qmd retrieval) | ❌ off-context adaptér vypnutý (`off_context_unavailable`), nič sa neevictne |
| `lcm_grep` (raw DB query) | ✅ | ✅ (obaja) |

### Kľúčové parametre (`config.ts`)

**Runtime:**
- `defaultCtxCutoffThreshold = 0.6` — sumár začne pri 60 % okna
- `targetFreePercentage = 0.25`, `minMessagesToSummarize = 3`, `minProtectedTailLeaves = 2`
- `criticalThresholdMultiplier = 1.2`, `maxCompactionRounds = 10`
- `summaryMaxOutputTokens = 2200`, `condenseMaxOutputTokens = 2200`

**Upward:**
- `contextThreshold = 0.75`, `freshTailCount = 32`, `leafChunkTokens = 20_000`
- `leafMinFanout = 8`, `condensedMinFanout = 4`, `condensedMinFanoutHard = 2`, `condensedTargetTokens = 2_000`
- `UPWARD_CONDENSED_MIN_INPUT_RATIO = 0.1` → `minChunkTokens = max(condensedTargetTokens, floor(leafChunkTokens*0.1))`

**Dolt lanes (leaves/sprigs/bindles):** `soft`/`delta`/`target` (leaves soft 50k/target 50k, bindles soft 10k), `minFanout`, `ghostCueArchiveEnabled=true`.

**Retrieval hinty (QMD):** `RETRIEVAL_TOP_K = 3`, `RETRIEVAL_MIN_SCORE = 0.3`, index prefix `voltcode-lcm-retrieval`, collection `off-context-bindles`, **pre-response hook topK = 3**. Retrieval index pre Dolt je per-konzervácia suffix (izolácia recall spaces).

## 6. Dolt retrieval traversal (off-context pamäť)

- **Pre-response hooks** injektujú top memory cues s **summary IDs, summary type metadata, lineage pointer IDs**.
- **`lcm_describe`** — zobrazí lineage metadata (type/level, off-context status, pointer targets, lineage closure IDs) → agent si vyberie správny node.
- **`lcm_expand`** — sleduje lineage (vrátane archive pointerov) a rozbalí na pôvodné správy.
- Cesta end-to-end: **hook pointer → bindle/stub → expanded content**.
- Retrieval beží na QMD indexe (per-konverzácia suffix = izolácia).

## 7. Operator-Level Recursion (deterministické nástroje, nie LLM slučky)

- **`LLM-Map`** — paralelné stateless LLM volania nad JSONL (worker pool, concurrency **16**), validácia proti JSON Schema, retry s feedbackom. Čistá funkcia, bez tools/side-effects. Výsledky do JSONL + immutable store. (klasifikácia/extrakcia/scoring)
- **`Agentic-Map`** — plný **sub-agent session** na item s tools + multi-step reasoning. `read_only` flag riadi FS modifikácie.
- **`Map-shared`** — worker pool infra pre oba.
- **`tasks.ts`** — delegácia s **infinite-recursion guard** (scope-reduction invariant).
- Pointa: **control flow z modelu (stochastická vrstva) → engine (deterministická vrstva).**

## 8. Large-file handling

Ak tool výsledok (súbor) presahuje token threshold → súbor sa **nikdy nenačíta celý** do active contextu. Engine:
1. uloží súbor **externé**, 2. vloží **kompaktnú referenciu** = content-addressed ID + cesta + **Exploration Summary**, 3. summary generuje **type-aware dispatcher** (Python/TS/Go/Rust explorery) podľa typu súboru.

## 9. PostgreSQL backend

- **Embedded Postgres 17.7** (default): host `127.0.0.1`, port `54329`, db `voltcode_lcm`, user `voltcode`. Alebo externý cez `LCM_DATABASE_URL` / `RDS_*`.
- DAG (messages, summaries, file references) s transakčnými zápismi, FK integritou, indexovaným vyhľadávaním.

## 10. Korešpondencia s definíciou "LCM" (uživateľ: nikdy nepretečie + stále fokusovaný)

Volt pokrýva oboje deterministicky:
- **"Nikdy nepretečie"** → deterministický kompaktný cyklus (asynchrónne medzi turnmi) + **tri-level escalation s garantovaným be-LLM fallbackom**.
- **"Stále fokusovaný na to, čo sa rieši"** → 3 časti:
  1. **Pre-response hooks** vstrekujú top-3 relevantné memory cues **pred každým turnom** (QMD retrieval, min score 0.3) — **per-turn**, nie session-start.
  2. **Large-file handling** — súbory > threshold sa nikdy nenačítajú, nahrádzajú sa exploration summary.
  3. **DAG summary nodes** — staré správy sa nemenia na plný text, ale hierarchické súhrny (balans pozornosti).

## 11. Gap vs. Fusion (čo Fusion už má / čo chýba)

| Volt pilier | Fusion stav (overené v code) |
|---|---|
| Deterministická kompakcia medzi turnmi | ✅ **`TokenCapDetector`** (`packages/engine/src/errors/token-cap-detector.ts`), volaný z `executor.ts:15295` — monitoruje `session.getContextUsage().tokens`, nad `tokenCap` volá `compactFn(session)`. **Default `tokenCap: undefined` (vypnuté, len overflow-errors).** Volt má cutoff 0.6; my nič. |
| Immutable Store + Summary DAG | ❌ Nemáme žiadny immutable transakčný store správ + DAG. Máme `.fusion/memory/` (QMD layered files) + folder memory + Stash session store. |
| Pre-response hook per-turn | ⚠️ **`buildProactiveMemoryCueBlock`** (`project-memory.ts:378`) je **aditívny, raz na session-start** (`agentPrompt += cue` v `executor.ts:15274`). **Nie per-turn, bez kompakcie.** |
| Large-file handling | ⚠️ Iba `truncateWorkflowScriptOutput` (tool output truncate). **Nie** exploration-summary + content-addressed ref. |
| Off-context retrieval (lcm_expand/lcm_describe/lcm_grep) | ❌ Chýba. |

**Zhrnutie:** z piatich pilierov Volt LCM má Fusion reálne funkčný len **jeden** (deterministická kompakcia cez `tokenCap`) a ešte vypnutý (default `undefined`). Proaktívny recall je skeleton (aditívny, session-start, bez kompakcie/off-context/DAG).

---

## A. Korešpončný dokument Fusion ↔ Volt LCM

### A.1 Čo Fusion UŽ MÁ (a stačí zapnúť/vyladiť)

1. **Deterministická kompakcia (tokenCap)** — `TokenCapDetector`, `executor.ts:15295`. Ekvivalent Volt "soft threshold → compact between turns". Akcia: nastaviť default (Volt použiť model cutoff ~0.6; my by sme mohli default nastaviť podľa modelu alebo per-projekt). Tiež `step-session-executor.ts:1282` (compact-and-resume) a `reviewer.ts:604` (FN-4082) existujú.
2. **Maddená kompakcia na overflow** — už existuje (pred tokenCap).

### A.2 Čo Fusion MÁ IBA čiastočne

3. **Proaktívny recall** — `buildProactiveMemoryCueBlock` je session-start aditívny. Volt je per-turn + score-filtered + dedup. Fusion má `searchProjectMemory` / `fn_memory_search` — môže byť rozšírené na per-turn.
4. **Large-file referencie** — chýba exploration-summary spôsob. Fusion niečo podobné nemá.

### A.3 Čo Fusion ÚPLNE CHÝBA (nová práca)

5. **Immutable Store + Summary DAG** — architektúra, ktorú do Fusion netreba 1:1 importovať, ale treba rozhodnúť: (a) použiť Stash ako immutable session store + vybudovať nad ním vlastný sumárny mechanizmus, alebo (b) implementovať vlastný minimálny DAG.
6. **Pre-response hook per-turn** (keď recall má byť "fokused na to čo sa rieši").
7. **Off-context retrieval nástroje** (lcm_expand/describe/grep ekvivalent) — ak má byť recall searchovateľný vo forme session/summary.

### A.4 Sémantický rozdiel DAG vs. naša roadmapa

- Volt **nikdy nemení** immutable správy; DAG je len cache na ich čítanie.
- Naša `.fusion/memory` aj Stash capture sú **write-side** (append), nie DAG.
- Ak chceme "nikdy nepretečie", nepotrebujeme nutne DAG — stačí deterministická kompakcia. **DAG je potrebný až pre "fokused per-turn + lossless okamžitý expanded recall".**

---

## B. Minimal-delta plán pre Fusion (najmenšia práca na splnenie definície LCM)

### B.1 Fáza 1 — "Nikdy nepretečie" (nízko-hängendes ovocie, už je z 80 % v engine)

- **Zapnúť deterministickú kompakciu**: nastaviť východiskový `tokenCap` (napr. per-project `tokenCap` so sane default ~ 0.8*soft limit modelu, alebo relatívne k model context window). Overiť, že `compactFn` reálne komprimuje medzi turnmi (Volt robí asynchrónne; my môžeme začať synchrónne medzi turnmi).
- **Vystaviť v Settings** (Settings→Memory alebo Model) — aktuálne `tokenCap` len v `settings-scope.ts`, GUI nemá.
- **Overiť `reviewer.ts` / `step-session-executor.ts`** kompaktné a-resume pathy v praxi.
- **Výstup:** "nikdy nepretečie" je už funkčné s jedným settingom zapnutým.

### B.2 Fáza 2 — "Stále fokusovaný na to, čo sa rieši" (per-turn recall)

- **Rozšíriť `buildProactiveMemoryCueBlock` na per-turn**: namiesto raz na session-start volať recall **pred každým promptom** na aktuálny task/poslednú správu; score-filter (+min score), dedup, top-K (Volt topK=3).
- **Mapovať na Stash**: ak backend je `stash`, per-turn recall = `GET /api/v1/me/events/search?q=<aktuálna úloha>&limit=...` (limity: Stash search má len q+limit, žiadny score filter, žiadny scope param — per-projekt prostredníctvom owner_user_id SQL scope). Score filtering by sme museli robiť klient-side (nie je v Stash API).
- **Backend-agnostické**: `MemoryBackend.search` interface už sedí; per-turn volanie stačí zaviesť v executor.ts.
- **Výstup:** recall sa aktivuje per-turn, nie len na začiatku session.

### B.3 Fáza 3 — DAG / off-context (len ak treba "view into full history" v GUI)

- **Rozhodnúť:** či naozaj chceme off-context retrieval (searchable história) teraz, alebo stačí kompaktácia + per-turn recall.
- **Ak áno:** Stash treba ako immutable session store (session auto-recording) + vlastný sumárny mechanizmus (LLM sumarizácia starších správ do Stash eventov alebo do Fusion minimálne DAG tabuľky).
- **Ak nie:** odložiť; definícia LCM (nepretečie + fokused) je splnená už B.1+B.2, bez DAG.

---

## C. Úloha Stash v LCM (analýza)

**Záver (predbežný, treba overiť API):** Stash môže byť **immutable session store (write-side mutácia histórie)** a **recall zdroj (read-side search)**, ale **NIE je kompaktný/DAG engine** — nemá native summary nodes, soft/hard thresholds, escalation, ani token-based compaction. To musí zostať **v Fusion engine** (`tokenCap` + prípadne vlastný sumárny mechanizmus).

**Konkrétne:**
- ✅ Stash = **Immutable Store** (session auto-recording, verbatím events, batch push `POST /api/v1/me/events/batch`, search `GET /api/v1/me/events/search` — DB-level owner scope). Pokrýva Volt "Immutable Store" rolu.
- ✅ Stash = zdroj pre **pre-response hook recall** (per-turn QMD search; len q+limit, score filter client-side).
- ⚠️ Stash **nemá**: summary nodes, DAG, soft/hard compaction thresholds, tri-level escalation, lcm_expand/describe/grep semantics, large-file exploration-summary.
- ⚠️ **Retrieval relevance** je slabšia ako Voltov QMD: Stash REST search = SQL fulltext (q) nad events, nie vektor/semantic. Volt používa QMD vektor retrieval s min_score 0.3. Pre "fokused na to čo sa rieši" by Stash rola bola na **hrubý fulltext recall**, nad ktorým by Fusion sám robil **LLM-score/ranking pred vstreknutím** (držíme deterministickosť — LLM ranking by mohol byť nescored a pomalý; pozor).

**Biznis rozhodnutie:** Stash **vie pomôcť** ako persistentné session + search memory úložisko pre read-side, ale **sám o sebe nevyrieši** LST (lossless) "adjust context per query". Keďže na clean-rebase **už máme** Stash+TencentDB backends a capture/recall seam, Stash je najlepší kandidát na úložisko; kompakcia + per-turn recall musí byť naše. Nestojí za to hľadať iné riešenie pre úložisko — Stash to pokrýva; chýbajúca časť je **engine-side kompaktácia + per-turn recall**, čo je čistá Fusion práca (B.1+B.2).

*(Pozn.: pôvodný Stash = fork/rewrite `pi-plugin-rewrite`, REST-only, žiadny MCP. Overené 2026-08.)*