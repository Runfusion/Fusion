---
"@runfusion/fusion": patch
---

summary: Le défilement tactile du board n'applique plus l'état de survol aux cartes de tâches.
category: fix
dev: Toutes les règles `:hover` de carte dans `TaskCard.css` et `styles.css` sont gardées par `@media (hover: hover)`; une contrepartie `@media (hover: none)` fournit un retour visuel au tap (`.card:active`) et garde les contrôles de carte visibles sur tout pointeur tactile, y compris au-delà de 768px.
