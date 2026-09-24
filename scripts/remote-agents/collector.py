#!/usr/bin/env python3
"""Standalone Fusion collectors: native JSONL → private durable spool → Fusion."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.parse
import uuid
from native_parser import consume, totals, bounded
from opaque_records import ignored_header, scan_opaque_tail

VERSION = 'fusion-remote-1'
MAX_LINE = 4 * 1024 * 1024


def validate_url(value):
    """Accept HTTPS endpoints and allowlisted or literal private HTTP origins."""
    parsed = urllib.parse.urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Collector URL must not contain credentials, query, or fragment')
    if not parsed.hostname or parsed.path not in ('', '/'):
        raise ValueError('Collector URL must be an origin')
    if parsed.scheme == 'https':
        return value.rstrip('/')
    if parsed.scheme != 'http':
        raise ValueError('Collector URL must use HTTPS or private HTTP')
    # FNXC:RemoteAgents 2026-09-22-19:20: Only loopback is allowed by name. Private deployments name their own
    # relay host through FUSION_REMOTE_AGENTS_HTTP_HOSTS; no operator hostname is baked into shipped code.
    allowed_hosts = {'localhost'}
    allowed_hosts.update(host.strip().lower() for host in os.environ.get('FUSION_REMOTE_AGENTS_HTTP_HOSTS', '').split(',') if host.strip())
    if parsed.hostname.lower() in allowed_hosts:
        return value.rstrip('/')
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError as error:
        raise ValueError('HTTP collector URL must use a literal private address') from error
    if not (address.is_private or address.is_loopback or address.is_link_local):
        raise ValueError('HTTP collector URL must use a private address')
    return value.rstrip('/')


# Kept as an import-compatible alias for existing host tooling.
validated_base_url = validate_url


def connect(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(path, timeout=0.2)
    os.chmod(path, 0o600)
    db.executescript('''PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,inode TEXT,offset INTEGER,state TEXT,digest TEXT,revision INTEGER);
      CREATE TABLE IF NOT EXISTS requests(provider TEXT,native TEXT,request TEXT,usage TEXT,PRIMARY KEY(provider,native,request));
      CREATE TABLE IF NOT EXISTS pending(sequence INTEGER PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtimes(provider TEXT,native TEXT,generation TEXT,expires TEXT,PRIMARY KEY(provider,native));
      CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,state TEXT NOT NULL,expires TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(provider TEXT,native TEXT,session TEXT,digest TEXT,revision INTEGER,PRIMARY KEY(provider,native));
      CREATE TABLE IF NOT EXISTS live_files(path TEXT PRIMARY KEY,mtime INTEGER,state TEXT);
    ''')
    for key, value in [('stream', str(uuid.uuid4())), ('sequence', '0')]:
        db.execute('INSERT OR IGNORE INTO config VALUES (?,?)', (key, value))
    db.commit(); return db


def bind(db, project, host):
    scope = json.dumps([project, host])
    old = db.execute("SELECT value FROM config WHERE key='scope'").fetchone()
    if old and old[0] != scope:
        raise ValueError('Collector spool belongs to another host/project')
    with db:
        db.execute("INSERT OR IGNORE INTO config VALUES ('scope',?)", (scope,))


def post(url, project, token, operation, body, timeout=5):
    # FNXC:RemoteAgents 2026-09-21-04:51: Host collectors may use WireGuard HTTP, but arbitrary cleartext or credential-bearing destinations must fail before any token-bearing request.
    parsed = urllib.parse.urlsplit(validate_url(url))
    connection_type = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
    connection = connection_type(parsed.hostname, parsed.port, timeout=timeout)
    request_path = '/api/external-sessions/' + operation + '?' + urllib.parse.urlencode({'projectId': project})
    connection.request('POST', request_path, body=json.dumps(body).encode(), headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token,
    })
    try:
        response = connection.getresponse()
        raw = response.read(262145)
        if len(raw) > 262144:
            raise ValueError('Collector response limit exceeded')
        if response.status < 200 or response.status >= 300:
            raise ValueError(f'Collector returned HTTP {response.status}')
        return json.loads(raw)
    finally:
        connection.close()


def enqueue(db, session):
    pending = db.execute('SELECT count(*),coalesce(sum(length(body)),0) FROM pending').fetchone()
    if pending[0] >= 5000 or pending[1] >= 64 * 1024 * 1024:
        raise ValueError('Durable spool full; cursor preserved')
    seq = int(db.execute("SELECT value FROM config WHERE key='sequence'").fetchone()[0]) + 1
    stream = db.execute("SELECT value FROM config WHERE key='stream'").fetchone()[0]
    body = dict(schemaVersion=1, streamId=stream, sequence=seq, eventId=str(uuid.uuid4()), collectorVersion=VERSION, session=session)
    db.execute('INSERT INTO pending VALUES (?,?)', (seq, json.dumps(body)))
    db.execute("UPDATE config SET value=? WHERE key='sequence'", (str(seq),))


def scan(db, path, provider):
    stat = path.stat(); inode = f'{stat.st_dev}:{stat.st_ino}'
    old = db.execute('SELECT inode,offset,state,digest,revision FROM files WHERE path=?', (str(path),)).fetchone()
    if old and (old[0] != inode or old[1] > stat.st_size):
        raise ValueError('Transcript was replaced/truncated; cursor preserved for review')
    offset, state, previous, revision = (old[1], json.loads(old[2]), old[3], old[4]) if old else (0, {}, '', 0)
    opaque = state.get('opaque')
    raw = b''
    if not opaque:
        with path.open('rb') as stream:
            stream.seek(offset); raw = stream.read(1024 * 1024)
            if raw and b'\n' not in raw:
                raw += stream.read(MAX_LINE - len(raw) + 1)
        if len(raw) > MAX_LINE and b'\n' not in raw:
            header = ignored_header(raw, provider)
            if header is None:
                raise ValueError('Oversized meaningful native record; cursor preserved')
            opaque = dict(header=header, position=offset)
    if opaque:
        position, done = scan_opaque_tail(path, opaque['position'], 1024 * 1024)
        if done:
            offset = position; state.pop('opaque', None)
        else:
            state['opaque'] = dict(header=opaque['header'], position=position)
        raw = b''
    end = raw.rfind(b'\n') + 1
    with db:
        for line in raw[:end].splitlines():
            if len(line) > MAX_LINE:
                raise ValueError('Oversized native record; cursor preserved')
            # FNXC:RemoteAgents 2026-09-23-07:55: A COMPLETE line that is not valid JSON can never
            # become valid, so raising here pinned the cursor and blocked every later record in that
            # transcript forever. Skip it and report it; incomplete and oversized records still
            # preserve the cursor, because those can still complete on a later pass.
            try:
                record = json.loads(line)
            except ValueError:
                print('Skipped malformed native record:', path.name, flush=True)
                continue
            consume(db, state, record, provider)
        offset += end
        # A separate bounded tail keeps activity current while old token history
        # catches up. It never contributes usage, so tail/history cannot double bill.
        live = db.execute('SELECT mtime,state FROM live_files WHERE path=?', (str(path),)).fetchone()
        live_state = json.loads(live[1]) if live else dict(state)
        if not live or live[0] != stat.st_mtime_ns:
            with path.open('rb') as stream:
                start = max(0, stat.st_size - 262144); stream.seek(start); tail = stream.read(262144)
            if start:
                first = tail.find(b'\n'); tail = tail[first + 1:] if first >= 0 else b''
            last = tail.rfind(b'\n') + 1
            for line in tail[:last].splitlines():
                try:
                    consume(db, live_state, json.loads(line), provider, accounting=False)
                except (ValueError, TypeError):
                    pass
            db.execute('INSERT OR REPLACE INTO live_files VALUES (?,?,?)', (str(path), stat.st_mtime_ns, json.dumps(live_state)))
        state['usageComplete'] = offset == stat.st_size and not state.get('unreportedUsage', False)
        native = state.get('nativeSessionId')
        if native:
            usage = totals(db, provider, native)
            session = {k: state[k] for k in ('nativeSessionId', 'projectPath', 'observedAt', 'activity', 'title', 'model', 'recentActivity') if k in state}
            if live_state.get('observedAt', '') > session.get('observedAt', ''):
                session = {k: live_state[k] for k in ('nativeSessionId', 'projectPath', 'observedAt', 'activity', 'title', 'model', 'recentActivity') if k in live_state}
            existing = db.execute('SELECT session,digest,revision FROM observations WHERE provider=? AND native=?', (provider, native)).fetchone()
            if existing:
                latest = json.loads(existing[0])
                if latest.get('observedAt', '') > session.get('observedAt', ''):
                    session = latest
                previous, revision = existing[1], existing[2]
            other_incomplete = db.execute("SELECT 1 FROM files WHERE path<>? AND json_extract(state,'$.nativeSessionId')=? AND coalesce(json_extract(state,'$.usageComplete'),0)=0 LIMIT 1", (str(path), native)).fetchone()
            session.update(provider=provider, usage=usage, usageComplete=state['usageComplete'] and not other_incomplete)
            session['projectPath'] = bounded(session.get('projectPath', ''), 4096)
            session['title'] = bounded(' '.join(session.get('title', native).split()), 512)
            runtime = db.execute('SELECT generation,expires FROM runtimes WHERE provider=? AND native=?', (provider, native)).fetchone()
            if runtime and runtime[1] > datetime.now(timezone.utc).isoformat():
                session['feedback'] = dict(generation=runtime[0], expiresAt=runtime[1])
            else:
                session.pop('feedback', None)
            digest = hashlib.sha256(json.dumps(session, sort_keys=True).encode()).hexdigest()
            if digest != previous:
                revision += 1; enqueue(db, dict(revision=revision, **session)); previous = digest
            db.execute('INSERT OR REPLACE INTO observations VALUES (?,?,?,?,?)', (provider, native, json.dumps(session), previous, revision))
        encoded = json.dumps(state)
        if len(encoded) > 131072:
            raise ValueError('Parser state limit; cursor preserved')
        db.execute('INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?)', (str(path), inode, offset, encoded, previous, revision))


def discover(home, days):
    cutoff = time.time() - days * 86400
    for provider, root, pattern in [('codex', home / '.codex/sessions', '*/*/*/*.jsonl'), ('claude', home / '.claude/projects', '*/*.jsonl')]:
        for path in root.glob(pattern):
            if not path.is_symlink() and path.is_file() and path.stat().st_mtime >= cutoff:
                yield provider, path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', required=True); p.add_argument('--project', required=True); p.add_argument('--host', required=True)
    p.add_argument('--token-file', type=Path, required=True); p.add_argument('--state', type=Path, required=True)
    p.add_argument('--home', type=Path, default=Path.home()); p.add_argument('--days', type=int, default=7)
    p.add_argument('--once', action='store_true'); args = p.parse_args()
    if args.token_file.stat().st_mode & 0o077:
        raise ValueError('Collector token must be private')
    token = args.token_file.read_text().strip()
    if len(token) < 32:
        raise ValueError('Collector token too short')
    args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with args.state.with_suffix('.collector.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db = connect(args.state); bind(db, args.project, args.host)
        while True:
            try:
                post(args.url, args.project, token, 'heartbeat', dict(schemaVersion=1, collectorVersion=VERSION))
                for seq, body in db.execute('SELECT sequence,body FROM pending ORDER BY sequence LIMIT 100').fetchall():
                    b = json.loads(body); ack = post(args.url, args.project, token, 'ingest', b)
                    if ack.get('streamId') != b['streamId'] or ack.get('acknowledgedSequence', 0) < seq:
                        raise ValueError('Invalid ingestion acknowledgement')
                    with db:
                        db.execute('DELETE FROM pending WHERE sequence=?', (seq,))
            except Exception as error:
                print('Fusion delivery unavailable:', type(error).__name__, flush=True)
            files = sorted(discover(args.home, args.days), key=lambda item: item[1].stat().st_mtime, reverse=True)
            for provider, path in files[:2000]:
                try:
                    scan(db, path, provider)
                except Exception as error:
                    print('Native collection paused:', provider, type(error).__name__, flush=True)
            if args.state.stat().st_size > 512 * 1024 * 1024:
                raise ValueError('Collector storage capacity reached')
            if args.once:
                break
            time.sleep(5)


if __name__ == '__main__':
    main()
