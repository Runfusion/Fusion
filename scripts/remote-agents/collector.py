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
import select
import socket
import sqlite3
import time
import urllib.parse
import uuid
from native_parser import consume, totals, bounded
from turn_parser import consume_claude, consume_codex
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
    allowed_hosts = {'localhost', 'wj'}
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
      CREATE TABLE IF NOT EXISTS counters(key TEXT PRIMARY KEY,value INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,inode TEXT,offset INTEGER,state TEXT,digest TEXT,revision INTEGER);
      CREATE TABLE IF NOT EXISTS requests(provider TEXT,native TEXT,request TEXT,usage TEXT,PRIMARY KEY(provider,native,request));
      CREATE TABLE IF NOT EXISTS pending(sequence INTEGER PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtimes(provider TEXT,native TEXT,generation TEXT,expires TEXT,PRIMARY KEY(provider,native));
      CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,state TEXT NOT NULL,expires TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(provider TEXT,native TEXT,session TEXT,digest TEXT,revision INTEGER,PRIMARY KEY(provider,native));
      CREATE TABLE IF NOT EXISTS live_files(path TEXT PRIMARY KEY,mtime INTEGER,state TEXT);
      CREATE TABLE IF NOT EXISTS turn_state(path TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns(provider TEXT NOT NULL,native TEXT NOT NULL,turn_id TEXT NOT NULL,
        revision INTEGER NOT NULL,acked INTEGER NOT NULL DEFAULT 0,body TEXT NOT NULL,
        PRIMARY KEY(provider,native,turn_id));
      CREATE TABLE IF NOT EXISTS acknowledged_sessions(provider TEXT NOT NULL,native TEXT NOT NULL,
        PRIMARY KEY(provider,native));
    ''')
    for key, value in [('stream', str(uuid.uuid4())), ('sequence', '0')]:
        db.execute('INSERT OR IGNORE INTO config VALUES (?,?)', (key, value))
    if not db.execute("SELECT 1 FROM config WHERE key='display_repair_v1'").fetchone():
        for sequence, body in db.execute('SELECT sequence,body FROM pending').fetchall():
            envelope = json.loads(body)
            session = envelope.get('session') or {}
            changed = False
            for field, limit in (('title', 512), ('projectPath', 4096)):
                if isinstance(session.get(field), str):
                    cleaned = safe_display(session[field], limit)
                    if cleaned != session[field]:
                        session[field] = cleaned; changed = True
            if changed:
                db.execute('UPDATE pending SET body=? WHERE sequence=?', (json.dumps(envelope), sequence))
        db.execute("INSERT INTO config VALUES ('display_repair_v1','1')")
    if not db.execute('SELECT 1 FROM pending LIMIT 1').fetchone():
        db.execute('INSERT OR IGNORE INTO acknowledged_sessions SELECT provider,native FROM observations')
    db.commit(); return db


def safe_display(value, limit):
    return ''.join('\ufffd' if ord(character) < 32 or ord(character) == 127 else character
                   for character in bounded(value, limit))


def bind(db, project, host):
    scope = json.dumps([project, host])
    old = db.execute("SELECT value FROM config WHERE key='scope'").fetchone()
    if old and old[0] != scope:
        raise ValueError('Collector spool belongs to another host/project')
    with db:
        db.execute("INSERT OR IGNORE INTO config VALUES ('scope',?)", (scope,))


class Rejected(ValueError):
    """Fusion refused this one record for its content. Retrying the identical record can never succeed."""

    def __init__(self, status):
        super().__init__(f'Collector record rejected with HTTP {status}')
        self.status = status


# FNXC:RemoteAgents 2026-09-30-10:59: statuses that condemn the record itself. Auth (401/403), a missing route
# (404, e.g. a Fusion build without remote agents), rate limits (429) and 5xx describe the server, not the record,
# so they keep blocking and retrying rather than discarding data the server would accept later.
PERMANENT_REJECTIONS = frozenset({400, 409, 413, 422})


class StatusError(ValueError):
    """Fusion answered with a non-2xx status that says nothing final about the record itself."""

    def __init__(self, status):
        super().__init__(f'Collector returned HTTP {status}')
        self.status = status


RESPONSE_LIMIT = 262144
STALE_CONNECTION_ERRORS = (http.client.CannotSendRequest, http.client.BadStatusLine, OSError)
_connections = {}


def post(url, project, token, operation, body, timeout=5, reuse=False):
    # FNXC:RemoteAgents 2026-09-21-04:51: Host collectors may use WireGuard HTTP, but arbitrary cleartext or credential-bearing destinations must fail before any token-bearing request.
    parsed = urllib.parse.urlsplit(validate_url(url))
    connection_type = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
    request_path = '/api/external-sessions/' + operation + '?' + urllib.parse.urlencode({'projectId': project})
    payload = json.dumps(body).encode()
    headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token}
    key = (parsed.scheme, parsed.hostname, parsed.port)
    # FNXC:RemoteAgents 2026-10-04-12:00: the collector reuses one keep-alive connection across a delivery
    # round instead of a TCP (and TLS) handshake per record. Every collector operation is idempotent (sequence
    # or event id), so a request that fails on a reused connection the server already closed is retried once
    # on a fresh one. Hooks keep the one-shot behaviour.
    for attempt in (0, 1):
        connection = _connections.pop(key, None) if reuse else None
        fresh = connection is None
        if fresh:
            connection = connection_type(parsed.hostname, parsed.port, timeout=timeout)
        try:
            if not fresh:
                connection.timeout = timeout
                if connection.sock is not None:
                    connection.sock.settimeout(timeout)
            connection.request('POST', request_path, body=payload, headers=headers)
            response = connection.getresponse()
            raw = response.read(RESPONSE_LIMIT + 1)
        except STALE_CONNECTION_ERRORS as error:
            connection.close()
            # A timeout is the server being slow, not a dropped keep-alive; never double the wait for it.
            if fresh or attempt or isinstance(error, (TimeoutError, socket.timeout)):
                raise
            continue
        except BaseException:
            connection.close()
            raise
        if reuse and response.isclosed() and not response.will_close and len(raw) <= RESPONSE_LIMIT:
            _connections[key] = connection
        else:
            connection.close()
        break
    if len(raw) > RESPONSE_LIMIT:
        raise ValueError('Collector response limit exceeded')
    if response.status in PERMANENT_REJECTIONS:
        raise Rejected(response.status)
    if response.status < 200 or response.status >= 300:
        raise StatusError(response.status)
    return json.loads(raw)


def enqueue(db, session):
    pending = db.execute('SELECT count(*),coalesce(sum(length(body)),0) FROM pending').fetchone()
    if pending[0] >= 5000 or pending[1] >= 64 * 1024 * 1024:
        raise ValueError('Durable spool full; cursor preserved')
    seq = int(db.execute("SELECT value FROM config WHERE key='sequence'").fetchone()[0]) + 1
    stream = db.execute("SELECT value FROM config WHERE key='stream'").fetchone()[0]
    body = dict(schemaVersion=1, streamId=stream, sequence=seq, eventId=str(uuid.uuid4()), collectorVersion=VERSION, session=session)
    db.execute('INSERT INTO pending VALUES (?,?)', (seq, json.dumps(body)))
    db.execute("UPDATE config SET value=? WHERE key='sequence'", (str(seq),))


def drain_turns(db, project, host, send, limit=25):
    """Send turns for sessions whose observation has already been acknowledged."""
    if not db.execute('SELECT 1 FROM pending LIMIT 1').fetchone():
        with db:
            db.execute('INSERT OR IGNORE INTO acknowledged_sessions SELECT provider,native FROM observations')
    delivered = 0
    rows = db.execute('SELECT t.provider,t.native,t.turn_id,t.revision,t.body FROM turns t '
                      'JOIN acknowledged_sessions a ON a.provider=t.provider AND a.native=t.native '
                      'WHERE t.revision>t.acked ORDER BY t.rowid LIMIT ?', (limit,)).fetchall()
    for provider, native, turn_id, revision, body in rows:
        session_id = hashlib.sha256(json.dumps([project, host, provider, native], separators=(',', ':')).encode()).hexdigest()
        event_id = hashlib.sha256(json.dumps([session_id, turn_id, revision], separators=(',', ':')).encode()).hexdigest()
        request = dict(schemaVersion=1, eventId=event_id, sessionId=session_id, turn=json.loads(body))
        try:
            ack = send('turn-ingest', request)
        except Rejected as rejection:
            # FNXC:RemoteAgents 2026-09-30-10:59: turns deliver in order, so one record Fusion will never accept
            # used to block every later turn on the host until the spool filled. Set exactly that revision aside,
            # count it, and keep going; a later, corrected revision of the same turn is still delivered.
            with db:
                db.execute('UPDATE turns SET acked=max(acked,?) WHERE provider=? AND native=? AND turn_id=?',
                           (revision, provider, native, turn_id))
            bump(db, 'rejected_turns')
            print('Turn rejected by Fusion and set aside:', provider, rejection.status, flush=True)
            continue
        if (ack.get('eventId'), ack.get('sessionId'), ack.get('nativeTurnId')) != (event_id, session_id, turn_id) or ack.get('revision', 0) < revision:
            raise ValueError('Invalid turn ingestion acknowledgement')
        with db:
            db.execute('UPDATE turns SET acked=max(acked,?) WHERE provider=? AND native=? AND turn_id=?',
                       (revision, provider, native, turn_id))
        delivered += 1
    return delivered


TURN_BATCH_LIMIT = 50
TURN_BATCH_BYTES = 6 * 1024 * 1024


def drain_turn_batches(db, project, host, send_batch, limit=TURN_BATCH_LIMIT, max_bytes=TURN_BATCH_BYTES):
    """Send acknowledged sessions' turns as batches; same identities, acks and set-aside rules as drain_turns.

    FNXC:RemoteAgents 2026-10-04-12:00: one request per turn turned every catch-up into hundreds of POSTs per
    minute and ran into Fusion's per-client mutation rate limit. A batch carries up to ``limit`` turns and
    ``max_bytes`` of request, and the server answers each turn separately: accepted turns are acknowledged,
    turns Fusion permanently refuses are set aside exactly as single delivery does, and anything else stays
    queued and fails the round so it retries with backoff.
    """
    if not db.execute('SELECT 1 FROM pending LIMIT 1').fetchone():
        with db:
            db.execute('INSERT OR IGNORE INTO acknowledged_sessions SELECT provider,native FROM observations')
    rows = db.execute('SELECT t.provider,t.native,t.turn_id,t.revision,t.body FROM turns t '
                      'JOIN acknowledged_sessions a ON a.provider=t.provider AND a.native=t.native '
                      'WHERE t.revision>t.acked ORDER BY t.rowid LIMIT ?', (limit,)).fetchall()
    batch, size = [], 0
    for provider, native, turn_id, revision, body in rows:
        session_id = hashlib.sha256(json.dumps([project, host, provider, native], separators=(',', ':')).encode()).hexdigest()
        event_id = hashlib.sha256(json.dumps([session_id, turn_id, revision], separators=(',', ':')).encode()).hexdigest()
        request = dict(schemaVersion=1, eventId=event_id, sessionId=session_id, turn=json.loads(body))
        weight = len(body) + 256
        if batch and size + weight > max_bytes:
            break
        batch.append((provider, native, turn_id, revision, request)); size += weight
    if not batch:
        return 0
    answer = send_batch(dict(schemaVersion=1, turns=[entry[4] for entry in batch]))
    results = answer.get('results') if isinstance(answer, dict) else None
    if not isinstance(results, list) or len(results) != len(batch):
        raise ValueError('Invalid turn batch acknowledgement')
    delivered, deferred = 0, None
    for (provider, native, turn_id, revision, request), result in zip(batch, results):
        status = result.get('status') if isinstance(result, dict) else None
        if status == 200:
            if (result.get('eventId'), result.get('sessionId'), result.get('nativeTurnId')) != (request['eventId'], request['sessionId'], turn_id) or result.get('revision', 0) < revision:
                raise ValueError('Invalid turn ingestion acknowledgement')
            with db:
                db.execute('UPDATE turns SET acked=max(acked,?) WHERE provider=? AND native=? AND turn_id=?', (revision, provider, native, turn_id))
            delivered += 1
        elif status in PERMANENT_REJECTIONS:
            with db:
                db.execute('UPDATE turns SET acked=max(acked,?) WHERE provider=? AND native=? AND turn_id=?', (revision, provider, native, turn_id))
            bump(db, 'rejected_turns')
            print('Turn rejected by Fusion and set aside:', provider, status, result.get('error', ''), flush=True)
        else:
            deferred = deferred or f'Turn batch deferred a turn: HTTP {status} {result.get("error", "")}'.strip()
    if deferred:
        raise ValueError(deferred)
    return delivered


def scan(db, path, provider):
    stat = path.stat(); inode = f'{stat.st_dev}:{stat.st_ino}'
    old = db.execute('SELECT inode,offset,state,digest,revision FROM files WHERE path=?', (str(path),)).fetchone()
    # FNXC:RemoteAgents 2026-09-23-09:40: A native CLI may rewrite its transcripts in place (a history
    # migration replaced most rollout files with new inodes, some shorter). Refusing such a file paused its
    # session forever. Rescan it from the start instead: usage rows are keyed by response/message identity or
    # cumulative-usage digest and merged by maximum, turns only move forward by revision, and the observation
    # revision is kept monotonic, so a rescan cannot double-count or regress anything already delivered.
    rewritten = bool(old and (old[0] != inode or old[1] > stat.st_size))
    if rewritten:
        print('Transcript rewritten; rescanning from start:', provider, flush=True)
        offset, state, previous, revision = 0, {}, old[3], old[4]
    else:
        offset, state, previous, revision = (old[1], json.loads(old[2]), old[3], old[4]) if old else (0, {}, '', 0)
    turn_row = None if rewritten else db.execute('SELECT state FROM turn_state WHERE path=?', (str(path),)).fetchone()
    turn_state = json.loads(turn_row[0]) if turn_row else {}
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
    parsed = malformed = 0
    with db:
        for line in raw[:end].splitlines():
            if len(line) > MAX_LINE:
                raise ValueError('Oversized native record; cursor preserved')
            # FNXC:RemoteAgents 2026-09-23-10:05: A COMPLETE line that is not valid JSON can never become
            # valid, so raising on it pinned the cursor and blocked every later record in that transcript
            # forever. Skip such a line when other records in the batch parse. When NOTHING parses the file
            # is replaced or corrupt rather than carrying one bad record, so keep failing closed below and
            # preserve the cursor and pending spool. Incomplete and oversized records still preserve it too.
            try:
                event = json.loads(line)
            except ValueError:
                malformed += 1
                continue
            parsed += 1
            consume(db, state, event, provider)
            turn = consume_codex(turn_state, event) if provider == 'codex' else consume_claude(turn_state, event) if provider == 'claude' else None
            native = state.get('nativeSessionId')
            if turn and isinstance(native, str):
                body = json.dumps(turn)
                if len(body) > 2 * 1024 * 1024:
                    raise ValueError('Turn exceeds durable spool limit; cursor preserved')
                capacity = db.execute('SELECT count(*),coalesce(sum(length(body)),0) FROM turns WHERE revision>acked').fetchone()
                if capacity[0] >= 5000 or capacity[1] + len(body) > 64 * 1024 * 1024:
                    raise ValueError('Turn delivery spool full; cursor preserved')
                db.execute('INSERT INTO turns(provider,native,turn_id,revision,body) VALUES (?,?,?,?,?) '
                           'ON CONFLICT(provider,native,turn_id) DO UPDATE SET revision=excluded.revision,body=excluded.body '
                           'WHERE excluded.revision>turns.revision',
                           (provider, native, turn['nativeTurnId'], turn['revision'], body))
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
        if malformed and not parsed:
            raise ValueError('Native transcript has no parseable records; cursor preserved')
        if malformed:
            bump(db, 'parse_failures', malformed)
            print('Skipped malformed native records:', path.name, malformed, flush=True)
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
            session['projectPath'] = safe_display(session.get('projectPath', ''), 4096)
            session['title'] = safe_display(' '.join(session.get('title', native).split()), 512)
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
        turn_encoded = json.dumps(turn_state)
        if len(turn_encoded) > 2 * 1024 * 1024:
            raise ValueError('Turn parser state limit; cursor preserved')
        db.execute('INSERT OR REPLACE INTO turn_state VALUES (?,?)', (str(path), turn_encoded))
        db.execute('INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?)', (str(path), inode, offset, encoded, previous, revision))


DELIVERY_BACKOFF_BASE_SECONDS = 5
DELIVERY_BACKOFF_MAX_SECONDS = 300
UNCHANGED_RESCAN_SECONDS = 60
LOOP_SECONDS = 5
HEARTBEAT_SECONDS = 15
MIN_ROUND_SECONDS = 1
WAKE_SETTLE_SECONDS = 0.2
HOT_SECONDS = 600
HOT_POLL_SECONDS = 1
BATCH_RETRY_SECONDS = 600


def wake_path(state):
    return Path(state).with_suffix('.wake')


def wake(state):
    """Tell this host's collector that a native transcript just changed. Never fails and never blocks."""
    sock = None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.setblocking(False)
        sock.sendto(b'w', str(wake_path(state)))
    except OSError:
        pass
    finally:
        if sock is not None:
            sock.close()


def open_wake(state):
    """FNXC:RemoteAgents 2026-10-04-12:00: native hooks wake the collector through a private datagram socket next
    to its spool, so a finished turn is scanned and delivered within a second instead of on the next poll.
    Polling every LOOP_SECONDS remains the fallback, so a missing or failing hook only costs latency."""
    path = wake_path(state)
    try:
        if path.is_socket():
            path.unlink()
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.bind(str(path))
        os.chmod(path, 0o600)
        sock.setblocking(False)
        return sock
    except OSError as error:
        print('Collector wake socket unavailable; polling only:', describe(error), flush=True)
        return None


def file_signature(path):
    stat = path.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)


def hot_changed(hot, settled):
    """True when a recently active transcript moved since its last successful scan.

    A file without a successful scan is skipped: it is paused with backoff, and waking for it every second would
    undo that backoff."""
    for key, path in hot:
        known = settled.get(key)
        if known is None:
            continue
        try:
            if file_signature(path) != known[0]:
                return True
        except OSError:
            return True
    return False


def wait_for_activity(waker, hot, settled, seconds):
    """FNXC:RemoteAgents 2026-10-04-14:30: wait for a hook wake, for a recently active transcript to move, or
    for the full poll interval, whichever comes first. Codex gets no Stop hook (a new definition needs the user's
    native trust), so a Codex turn that ends without a tool call used to wait for the next 5 s poll. Checking only
    transcripts active in the last HOT_SECONDS costs a few stat calls per second (measured 0.012 ms for 11 files)
    against 5 ms for a full discovery pass, and needs no hook on any host."""
    deadline = time.monotonic() + seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        if wait_for_wake(waker, min(HOT_POLL_SECONDS, remaining)):
            return True
        if hot_changed(hot, settled):
            return True


def wait_for_wake(sock, seconds):
    if sock is None:
        time.sleep(seconds); return False
    ready, _, _ = select.select([sock], [], [], seconds)
    if not ready:
        return False
    try:
        while sock.recv(64):
            pass
    except (BlockingIOError, OSError):
        pass
    # A hook fires as the native CLI finishes the record it announces; give that write a moment to land.
    time.sleep(WAKE_SETTLE_SECONDS)
    return True


def describe(error):
    """FNXC:RemoteAgents 2026-09-30-11:10: log the reason, not just the class. A bare "ValueError" hid which of a
    dozen distinct refusals was stalling delivery on m3. Messages are the collector's own text (status codes,
    limits); the token is never part of one. Bounded so a pathological message cannot flood the log."""
    message = str(error).replace('\n', ' ')
    return f'{type(error).__name__}: {message[:200]}' if message else type(error).__name__


def delivery_delay(failures):
    # FNXC:RemoteAgents 2026-09-23-09:40: Consecutive failed delivery rounds back off 5s doubling to 5min, so
    # collectors stop hammering a slow or unreachable Fusion; local scanning continues every loop regardless.
    if failures <= 0:
        return 0
    return min(DELIVERY_BACKOFF_MAX_SECONDS, DELIVERY_BACKOFF_BASE_SECONDS * 2 ** (failures - 1))


def bump(db, key, amount=1):
    """Cumulative operational counter. Best effort: telemetry must never break collection."""
    try:
        with db:
            db.execute('INSERT INTO counters(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=value+?',
                       (key, amount, amount))
    except Exception:
        pass


def counter(db, key):
    row = db.execute('SELECT value FROM counters WHERE key=?', (key,)).fetchone()
    return int(row[0]) if row else 0


def health(db):
    """Spool depth and cumulative failures. Only the collector can see these; Fusion measures staleness itself."""
    depth = bytes_ = 0
    try:
        observations = db.execute('SELECT count(*),coalesce(sum(length(body)),0) FROM pending').fetchone()
        turns = db.execute('SELECT count(*),coalesce(sum(length(body)),0) FROM turns').fetchone()
        depth = int(observations[0]) + int(turns[0])
        bytes_ = int(observations[1]) + int(turns[1])
    except Exception:
        # A counter query failure must not suppress the heartbeat itself; report what is known.
        return {}
    return dict(spoolDepth=depth, spoolBytes=bytes_,
                parseFailures=counter(db, 'parse_failures'), deliveryFailures=counter(db, 'delivery_failures'))


_batch_retry_at = 0.0


def deliver(db, args, token, heartbeat=True):
    """One delivery round: heartbeat (when due) and spooled observations, then turns. True when both succeed."""
    global _batch_retry_at
    delivered = True
    send = lambda operation, body, timeout=20: post(args.url, args.project, token, operation, body, timeout=timeout, reuse=True)
    try:
        if heartbeat:
            send('heartbeat', dict(schemaVersion=1, collectorVersion=VERSION, **health(db)), timeout=5)
        for seq, body in db.execute('SELECT sequence,body FROM pending ORDER BY sequence LIMIT 100').fetchall():
            b = json.loads(body); ack = send('ingest', b)
            if ack.get('streamId') != b['streamId'] or ack.get('acknowledgedSequence', 0) < seq:
                raise ValueError('Invalid ingestion acknowledgement')
            with db:
                db.execute('DELETE FROM pending WHERE sequence=?', (seq,))
                db.execute('INSERT OR IGNORE INTO acknowledged_sessions VALUES (?,?)',
                           (b['session']['provider'], b['session']['nativeSessionId']))
    except Exception as error:
        delivered = False
        bump(db, 'delivery_failures')
        print('Fusion delivery unavailable:', describe(error), flush=True)
    try:
        if time.monotonic() >= _batch_retry_at:
            try:
                while drain_turn_batches(db, args.project, args.host, lambda body: send('turn-ingest-batch', body, timeout=60)) == TURN_BATCH_LIMIT:
                    pass
            except (StatusError, Rejected) as error:
                # A Fusion build without batched ingestion answers 404/405, or 413 when its default body limit
                # meets a large batch before routing. A whole-batch 413 from a current build means the batch
                # itself was too large. Either way deliver one turn per request and look again later, so
                # collectors can be upgraded before or after the server.
                if error.status not in (404, 405, 413):
                    raise
                _batch_retry_at = time.monotonic() + BATCH_RETRY_SECONDS
                print('Fusion has no batched turn ingestion; sending turns singly', flush=True)
        if time.monotonic() < _batch_retry_at:
            drain_turns(db, args.project, args.host, send)
    except Exception as error:
        delivered = False
        print('Fusion turn delivery unavailable:', describe(error), flush=True)
    return delivered


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
        failures, next_delivery, last_round, last_heartbeat = 0, 0.0, float('-inf'), float('-inf')
        paused, settled, hot = {}, {}, []
        waker = None if args.once else open_wake(args.state)
        while True:
            # FNXC:RemoteAgents 2026-10-04-12:00: scan before delivering. Delivering first made every new turn
            # wait a full extra loop (measured median 10.5 s from turn end to Fusion); scanning first sends it in
            # the same pass. Rounds are spaced by MIN_ROUND_SECONDS so hook wakes cannot multiply requests, and the
            # heartbeat goes every HEARTBEAT_SECONDS rather than every pass (Fusion marks a host stale at 60 s).
            files = sorted(discover(args.home, args.days), key=lambda item: item[1].stat().st_mtime, reverse=True)
            # FNXC:RemoteAgents 2026-10-04-00:30: Scanning re-read and re-parsed every discovered transcript
            # every five seconds, and a failed scan (rolled back, cursor preserved) repeated the same megabyte
            # of work each loop for as long as the fault lasted, which pinned a CPU core for days. Unchanged
            # files are now rescanned only every UNCHANGED_RESCAN_SECONDS (runtime expiry still surfaces within
            # that window) and a failing file backs off like delivery does. Cursor and spool semantics are unchanged.
            now = time.monotonic()
            current = set()
            hot = []
            for provider, path in files[:2000]:
                key = str(path)
                current.add(key)
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    continue
                signature = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
                if time.time() - stat.st_mtime < HOT_SECONDS:
                    hot.append((key, path))
                known = settled.get(key)
                if known and known[0] == signature and now - known[1] < UNCHANGED_RESCAN_SECONDS:
                    continue
                pause = paused.get(key)
                if pause and now < pause[1]:
                    continue
                try:
                    scan(db, path, provider)
                except Exception as error:
                    attempts = (pause[0] if pause else 0) + 1
                    paused[key] = (attempts, now + delivery_delay(attempts))
                    settled.pop(key, None)
                    print('Native collection paused:', provider, describe(error), 'retry in', delivery_delay(attempts), 'seconds', flush=True)
                else:
                    paused.pop(key, None)
                    settled[key] = (signature, now)
            for stale in [key for key in paused if key not in current] + [key for key in settled if key not in current]:
                paused.pop(stale, None); settled.pop(stale, None)
            now = time.monotonic()
            if now >= next_delivery and now - last_round >= MIN_ROUND_SECONDS:
                beat = now - last_heartbeat >= HEARTBEAT_SECONDS
                delivered = deliver(db, args, token, heartbeat=beat)
                last_round = time.monotonic()
                if beat:
                    last_heartbeat = last_round
                failures = 0 if delivered else failures + 1
                next_delivery = time.monotonic() + delivery_delay(failures)
                if failures:
                    print('Fusion delivery backing off:', delivery_delay(failures), 'seconds', flush=True)
            if args.state.stat().st_size > 512 * 1024 * 1024:
                raise ValueError('Collector storage capacity reached')
            if args.once:
                break
            wait_for_activity(waker, hot, settled, LOOP_SECONDS)


if __name__ == '__main__':
    main()
