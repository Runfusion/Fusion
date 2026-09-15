---
"@runfusion/fusion": patch
---

summary: Les réponses IA ne répètent plus leurs premiers mots dans le tchat et les journaux de tâches.
category: fix
dev: `createAssistantStreamCapture` réconcilie désormais deux curseurs bruts par bloc (`covered` émis, `consumed` par les deltas) au lieu de cumuler le snapshot d'un `text_start` puis le premier `text_delta`. Les producteurs de type Anthropic partagent un objet `partial` mutable non cloné par la file d'événements PI, donc un start drainé en retard contenait déjà ce delta.
