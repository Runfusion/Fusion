---
"@runfusion/fusion": patch
---

summary: Idle heartbeats stop re-waking on the timer and the wake delta reports the real unread count.
category: fix
dev:
  An acknowledged idle heartbeat used to be dispatched again on the next timer tick, so an agent
  re-ran a byte-identical prompt for every tick of its interval. The tick now compares the current
  wake signals (inbox unread total, room entries, surfaced comments, board state, auto-claim
  candidates) against a cursor persisted in the acknowledged run and stays silent when nothing is
  newer; a probe that cannot read dispatches and logs loudly, and non-timer wakes, budget
  observability and pause authority are untouched.
  The wake delta's pending-messages line now carries the inbox unread total rather than the length
  of the capped preview, is omitted when no authoritative store exists, and a completed heartbeat
  marks read only the messages it was shown (`MessageStore.markInboxAsRead`) instead of the whole
  inbox, so unread mail is no longer consumed invisibly.
