---
"@runfusion/fusion": patch
---

summary: Une tâche lancée démarre son planning et sa revue sans attente ajoutée ni tick périodique.
category: fix
dev: |
  Supprime NUDGE_DEBOUNCE_MS (150 ms) au profit d'une coalescence par indicateur pending drainé en
  microtâche, clôturée par génération contre stop()/start(). Les reprises globalPause/enginePaused
  passent par requestImmediatePoll au lieu d'un poll() direct que la garde de ré-entrance abandonnait.
  onPlanningSlotReleased(taskId) réveille aussi le consommateur de continuations et lève la déférence
  planner-live (PLANNER_LIVE_CONTINUATION_DEFER_MS, 15 s) par CAS via
  wakePlannerLiveDeferredContinuations. Nouveau signal consultatif project-scoped
  (createDispatchWakeSignal) publié depuis TaskStore.emit et emitTaskLifecycleEventSafely ; les
  écritures de continuations utilisent pg_notify sur le même handle transactionnel, donc livraison
  après commit et rien sur rollback. Transport LISTEN/NOTIFY sur backend.directSessionUrl avec
  rattrapage après LISTEN/reconnexion, jamais le pooler ni le pool de mutations. Nouveau
  ProjectAdmissionCoordinator.onReservationReleased. Nouvel événement d'audit borné
  task:dispatch-latency-observed. Publishers et abonnés résolvent une seule clé de routage projet
  (resolveDispatchWakeProjectKey : identité de partition, sinon racine), et les publications
  canoniques tâches/settings sont notifiées aux autres processus via un transport non bloquant sur
  le handle existant de la couche de données. Les intervalles périodiques restent le filet de
  reprise.
