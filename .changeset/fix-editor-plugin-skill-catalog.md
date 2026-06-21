---
"@runfusion/fusion": patch
---

Show plugin-contributed skills (e.g. compound-engineering `ce-*`) in the workflow editor. The dashboard's discovered-skills catalog was built only from the disk-scanning package manager, so plugin skills — which the engine materializes for executor sessions separately — never appeared, and built-in workflow nodes that reference them (like `builtin:compound-engineering`) showed "— select skill —" / unresolved. The skills adapter now merges plugin skill contributions into the discovered list (deduped by bare name), and the editor's node summary + skill dropdown match namespaced skillNames (`compound-engineering:ce-work`) against the catalog's two-segment names (`ce-work/SKILL.md`) via a shared bare-name normalizer.
