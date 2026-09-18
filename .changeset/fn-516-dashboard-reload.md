---
"@runfusion/fusion": patch
---

summary: Le dashboard ne se recharge plus seul sans mise à jour réellement déployée.
category: fix
dev: `/version.json` est exclu du cache du service worker ; `checkVersion` borne sa lecture (clé unique par tentative, `AbortController`, validation stricte) et clôture les réponses tardives par génération. `controllerchange` et `handleChunkLoadError` demandent désormais cette vérification partagée au lieu d'appeler `reloadOnce` ; le rechargement sur déploiement confirmé, les protections anti-boucle et les actions manuelles sont inchangés.
