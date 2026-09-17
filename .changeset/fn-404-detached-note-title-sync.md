---
"@runfusion/fusion": patch
---

summary: Renommer une note met à jour aussitôt le titre de sa fenêtre détachée, sans voler le focus.
category: fix
dev: `usePoppedOutNotes.syncNote` réécrit l'instantané en place (sans toucher `focusNonce` ni l'ordre d'activation), la composition du dock le câble sur `notesController.notes`, et `NotesView` n'adopte une révision externe plus récente que si la fenêtre n'a pas de brouillon sale. Les fenêtres de tâches restent sans `syncTask` : elles refusionnent déjà la ligne vivante via `mergeTaskSnapshot`.
