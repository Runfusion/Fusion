---
"@runfusion/fusion": patch
---

summary: Le halo des cartes en cours d'exécution ne consomme plus de CPU en continu.
category: performance
dev: Remplace `agent-glow` (animation de `box-shadow` sur `.card.agent-active`, plus les keyframes de thème `agent-glow-factory`, `agent-glow-factory-light`, `neon-agent-pulse`, `neon-agent-pulse-light`) par `agent-halo`, qui n'anime que l'`opacity` d'un pseudo-élément `.card.agent-active::before` portant une ombre statique. Les thèmes surchargent les variables `--agent-halo-color/-blur/-strength/-duration` ou le `box-shadow` du `::before` ; les thèmes plats posent `content: none`.
