---
"@runfusion/fusion": patch
---

summary: La liste des dossiers et fichiers défile à nouveau jusqu'à sa dernière entrée, sur mobile comme ailleurs.
category: fix
dev: `.view-sidebar__panel` héritait `flex: none` de ViewSidebar.css et prenait la hauteur de son contenu dans le conteneur colonne `.file-browser-sidebar`, si bien que `.file-browser-list` recevait `clientHeight === scrollHeight`. `min-height: 0` (FN-427/FN-445/FN-462) n'a aucun effet sur un élément qui ne rétrécit pas. Règle de base `.file-browser-sidebar > .file-browser-sidebar__panel { flex: 1 1 auto }`, sans media query. L'écouteur de fermeture du menu contextuel passe d'un `document.querySelector` global à une référence locale. Preuve rouge/verte dans la nouvelle suite Chromium `file-browser-scroll-browser.test.ts`.
