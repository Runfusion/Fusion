#!/usr/bin/env python3
"""Repair a collector spool after a contract mismatch, then let the collector redeliver.

FNXC:RemoteAgents 2026-10-04-13:00: when collector and Fusion disagree on the turn contract, Fusion refuses the
affected turns with 400 and the collector sets them aside as delivered, so they are silently lost. The spool still
holds each turn's latest body. This tool rewrites usage entries to the current contract (adds the pricing band
flags, drops entries without a model and marks those turns' accounting incomplete), applies the same rewrite to
in-progress turns in the parser state, and requeues the set-aside turns. Turns are idempotent by event id, so a
turn Fusion already holds is acknowledged again without change.

Dry run by default. Refuses to run while a collector holds the spool lock: stop the collector first.
"""
import argparse
import fcntl
import json
from pathlib import Path
import sqlite3

CONTEXT_CAPACITY = {'claude': 200000, 'codex': 272000}


def repair_turn(turn, provider):
    entries = turn.get('usage')
    if not isinstance(entries, list):
        return False
    if all(u.get('model') and 'fast' in u and 'longContext' in u for u in entries):
        return False
    keep = []
    for u in entries:
        if not u.get('model'):
            continue
        u.setdefault('fast', False)
        u.setdefault('longContext', u.get('inputTokens', 0) > CONTEXT_CAPACITY.get(provider, CONTEXT_CAPACITY['codex']))
        keep.append(u)
    if len(keep) < len(entries):
        turn['usageComplete'] = False
    turn['usage'] = keep
    return True


def repair(db):
    requeued = repaired = states = 0
    with db:
        for provider, native, turn_id, revision, acked, body in db.execute(
                "SELECT provider,native,turn_id,revision,acked,body FROM turns WHERE json_extract(body,'$.usage') IS NOT NULL").fetchall():
            turn = json.loads(body)
            if not repair_turn(turn, provider):
                continue
            set_aside = acked >= revision
            db.execute('UPDATE turns SET body=?, acked=? WHERE provider=? AND native=? AND turn_id=?',
                       (json.dumps(turn), 0 if set_aside else acked, provider, native, turn_id))
            requeued += set_aside; repaired += not set_aside
        for path, state in db.execute('SELECT path,state FROM turn_state').fetchall():
            parsed = json.loads(state); turn = parsed.get('turn')
            provider = 'codex' if '/.codex/' in path else 'claude'
            if isinstance(turn, dict) and repair_turn(turn, provider):
                db.execute('UPDATE turn_state SET state=? WHERE path=?', (json.dumps(parsed), path)); states += 1
    return requeued, repaired, states


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--state', type=Path, required=True, help='the collector spool (its --state)')
    p.add_argument('--apply', action='store_true', help='write the repair; without it, report what would change')
    args = p.parse_args()
    with args.state.with_suffix('.collector.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('A collector is running on this spool; stop it before repairing.')
        db = sqlite3.connect(args.state, timeout=10)
        target = db if args.apply else sqlite3.connect(':memory:')
        if not args.apply:
            db.backup(target)
        requeued, repaired, states = repair(target)
        queued = target.execute('SELECT count(*) FROM turns WHERE revision>acked').fetchone()[0]
        verb = 'Requeued' if args.apply else 'Would requeue'
        print(f'{verb} {requeued} set-aside turns, repaired {repaired} queued turns and {states} in-progress parser states; {queued} turns queued.')


if __name__ == '__main__':
    main()
