#!/usr/bin/env python3
"""Opt-in Fusion native context hook; independent of AgentPulse and other hooks."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sys
import time
import uuid
from collector import connect, bind, post

EVENTS = {'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'}


def run(db, project, host, provider, payload, send, emit):
    native, event = payload.get('session_id'), payload.get('hook_event_name')
    if not isinstance(native, str) or not native or len(native) > 256 or event not in EVENTS:
        return
    session = hashlib.sha256(json.dumps([project, host, provider, native], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    now = datetime.now(timezone.utc)
    with db:
        old = db.execute('SELECT generation FROM runtimes WHERE provider=? AND native=?', (provider, native)).fetchone()
        if event == 'SessionEnd':
            db.execute('DELETE FROM runtimes WHERE provider=? AND native=?', (provider, native)); return
        generation = str(uuid.uuid4()) if (event == 'SessionStart' and payload.get('source') != 'compact') or not old else old[0]
        db.execute('INSERT OR REPLACE INTO runtimes VALUES (?,?,?,?)', (provider, native, generation, (now + timedelta(hours=24)).isoformat()))
        db.execute('DELETE FROM executions WHERE expires<?', ((now - timedelta(days=14)).isoformat(),))
    # The collector publishes this generation. Until then a hook claim is empty;
    # queued feedback for a previous generation can never enter a resumed runtime.
    result = send('feedback-claim', dict(sessionId=session, generation=generation))
    command = result.get('command')
    if not isinstance(command, dict):
        return
    expected = dict(sessionId=session, hostId=host, nativeSessionId=native, provider=provider, generation=generation)
    if any(command.get(k) != v for k, v in expected.items()) or not isinstance(command.get('text'), str) or len(command['text']) > 8000:
        return
    status = 'uncertain'
    expiry = command.get('expiresAt', '')
    with db:
        existing = db.execute('SELECT state FROM executions WHERE id=?', (command.get('commandId'),)).fetchone()
        if not existing and datetime.fromisoformat(expiry.replace('Z', '+00:00')) > now:
            db.execute('INSERT INTO executions VALUES (?, ?, ?)', (command['commandId'], 'prepared', expiry))
        else:
            existing = existing or ('expired',)
    if not existing:
        # Commit the fence before stdout. Ambiguous output is never replayed.
        emit({'hookSpecificOutput': {'hookEventName': event, 'additionalContext': '[Fusion feedback ' + command['commandId'] + ']\n' + command['text']}})
        with db:
            db.execute("UPDATE executions SET state='emitted' WHERE id=?", (command['commandId'],))
        status = 'delivered'
    send('feedback-ack', dict(sessionId=session, generation=generation, commandId=command['commandId'], status=status))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', required=True); p.add_argument('--project', required=True); p.add_argument('--host', required=True)
    p.add_argument('--provider', choices=['codex', 'claude'], required=True); p.add_argument('--token-file', type=Path, required=True); p.add_argument('--state', type=Path, required=True)
    args = p.parse_args()
    try:
        if args.token_file.stat().st_mode & 0o077:
            return
        token = args.token_file.read_text().strip()
        if len(token) < 32:
            return
        raw = sys.stdin.buffer.read(1048577)
        if len(raw) > 1048576:
            return
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            return
        db = connect(args.state); bind(db, args.project, args.host)
        deadline = time.monotonic() + 2
        def send(operation, body):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Native hook budget exhausted')
            return post(args.url, args.project, token, operation, body, timeout=min(0.75, remaining))
        try:
            run(db, args.project, args.host, args.provider, payload, send, lambda output: print(json.dumps(output), flush=True))
        finally:
            db.close()
    except Exception:
        # Observability failures must not hold the user's coding agent.
        return


if __name__ == '__main__':
    main()
