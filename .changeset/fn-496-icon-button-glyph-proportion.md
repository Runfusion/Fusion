---
"@runfusion/fusion": patch
---

summary: Les icônes des boutons gardent sur mobile la même proportion que sur ordinateur.
category: fix
dev: Nouveau jeton `:root` `--icon-button-glyph-scale-mobile` (`calc(var(--icon-button-size-mobile) / var(--icon-button-size))`), appliqué dans le bloc `@media (max-width: 768px)` de `styles.css` aux deux variantes canoniques `.btn-icon`, si bien que le glyphe mobile se dérive de la boîte mobile. La règle mobile `.column-header .btn-icon { min-width: 28px; min-height: 28px }` (« Column-header action buttons stay compact ») est RETIRÉE : elle plaçait le menu « … » et le bouton d'historique sous le plancher mobile canonique de 36px, ce qui produisait le symptôme signalé. `ViewActionButton.css` applique explicitement la même échelle aux propriétaires qui épinglent leur propre glyphe hors du contrat `.btn-icon > svg` — la création réduite à son icône et la flèche de retour FN-486 (0,2,1, propriétés physiques) — dans chacun de leurs deux hôtes mobiles, préservant leur parité.
