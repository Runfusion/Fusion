"""Fast delivery: batched turns, connection reuse, scan-first wake."""
import http.server
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import collector
from collector import Rejected, StatusError, bind, connect, drain_turn_batches, open_wake, post, wait_for_wake, wake


def spool_turns(db, count, provider='claude', native='native'):
    db.execute('INSERT OR IGNORE INTO acknowledged_sessions VALUES (?,?)', (provider, native))
    for n in range(count):
        turn = dict(nativeTurnId=f't{n}', revision=1, ordinal=n, state='completed', prompts=[dict(at=None, text='Go')],
                    response='Done', startedAt=None, endedAt=None, durationMs=None, durationSource=None, toolCallCount=0, fileChanges=[])
        db.execute('INSERT INTO turns(provider,native,turn_id,revision,body) VALUES (?,?,?,?,?)', (provider, native, f't{n}', 1, json.dumps(turn)))
    db.commit()


def accept(request):
    return dict(status=200, eventId=request['eventId'], sessionId=request['sessionId'],
                nativeTurnId=request['turn']['nativeTurnId'], revision=request['turn']['revision'], applied=True)


class BatchDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); root = Path(self.directory.name)
        self.db = connect(root / 'spool.sqlite'); bind(self.db, 'project', 'host')

    def tearDown(self):
        self.db.close(); self.directory.cleanup()

    def queued(self):
        return self.db.execute('SELECT count(*) FROM turns WHERE revision>acked').fetchone()[0]

    def test_one_request_carries_many_turns_and_acknowledges_each(self):
        spool_turns(self.db, 30); sent = []
        def send(body):
            sent.append(body); return dict(schemaVersion=1, results=[accept(r) for r in body['turns']])
        self.assertEqual(drain_turn_batches(self.db, 'project', 'host', send), 30)
        self.assertEqual((len(sent), len(sent[0]['turns']), self.queued()), (1, 30, 0))

    def test_rejected_turn_is_set_aside_and_a_deferred_turn_stays_queued(self):
        spool_turns(self.db, 3)
        def send(body):
            first, second, third = body['turns']
            return dict(schemaVersion=1, results=[accept(first), dict(status=400, error='invalid-turn'), dict(status=404, error='session-not-found')])
        with self.assertRaises(ValueError):
            drain_turn_batches(self.db, 'project', 'host', send)
        rows = dict(self.db.execute('SELECT turn_id,acked FROM turns').fetchall())
        self.assertEqual(rows, {'t0': 1, 't1': 1, 't2': 0})
        self.assertEqual(self.db.execute("SELECT value FROM counters WHERE key='rejected_turns'").fetchone()[0], 1)

    def test_a_short_or_mismatched_answer_acknowledges_nothing(self):
        spool_turns(self.db, 2)
        with self.assertRaises(ValueError):
            drain_turn_batches(self.db, 'project', 'host', lambda body: dict(results=[accept(body['turns'][0])]))
        self.assertEqual(self.queued(), 2)

    def test_batches_are_bounded_by_bytes(self):
        spool_turns(self.db, 5); sizes = []
        def send(body):
            sizes.append(len(body['turns'])); return dict(results=[accept(r) for r in body['turns']])
        drain_turn_batches(self.db, 'project', 'host', send, max_bytes=1100)
        self.assertEqual(sizes, [2])

    def test_a_whole_batch_413_from_an_older_body_limit_also_falls_back(self):
        spool_turns(self.db, 2); calls = []
        def fake_post(url, project, token, operation, body, timeout=5, reuse=False):
            calls.append(operation)
            if operation == 'turn-ingest-batch':
                raise Rejected(413)
            return accept(body) if operation == 'turn-ingest' else {}
        args = SimpleNamespace(url='http://localhost:1', project='project', host='host')
        with patch.object(collector, 'post', fake_post), patch.object(collector, '_batch_retry_at', 0.0):
            self.assertTrue(collector.deliver(self.db, args, 'token', heartbeat=False))
        self.assertEqual((calls.count('turn-ingest'), self.queued()), (2, 0))
        self.assertEqual(self.db.execute("SELECT count(*) FROM counters WHERE key='rejected_turns'").fetchone()[0], 0)

    def test_delivery_falls_back_to_single_turns_when_fusion_has_no_batch_route(self):
        spool_turns(self.db, 2); calls = []
        def fake_post(url, project, token, operation, body, timeout=5, reuse=False):
            calls.append(operation)
            if operation == 'turn-ingest-batch':
                raise StatusError(404)
            if operation == 'turn-ingest':
                return accept(body)
            return {}
        args = SimpleNamespace(url='http://localhost:1', project='project', host='host')
        with patch.object(collector, 'post', fake_post), patch.object(collector, '_batch_retry_at', 0.0):
            self.assertTrue(collector.deliver(self.db, args, 'token', heartbeat=False))
            self.assertEqual(calls.count('turn-ingest-batch'), 1)
            self.assertEqual(calls.count('turn-ingest'), 2)
            self.assertEqual(self.queued(), 0)
            spool_turns(self.db, 1, native='native-b'); calls.clear()
            collector.deliver(self.db, args, 'token', heartbeat=False)
            self.assertNotIn('turn-ingest-batch', calls)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    statuses = []

    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        status = self.statuses.pop(0) if self.statuses else 200
        payload = json.dumps(dict(ok=True, port=self.client_address[1])).encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)

    def log_message(self, *args):
        pass


class ConnectionReuseTests(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://localhost:{self.server.server_address[1]}'
        collector._connections.clear(); Handler.statuses = []

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()
        for connection in collector._connections.values():
            connection.close()
        collector._connections.clear()

    def test_reused_requests_share_one_connection_and_one_shot_requests_do_not(self):
        ports = {post(self.url, 'p', 't', 'heartbeat', {}, reuse=True)['port'] for _ in range(3)}
        self.assertEqual(len(ports), 1)
        self.assertNotEqual(post(self.url, 'p', 't', 'heartbeat', {})['port'], post(self.url, 'p', 't', 'heartbeat', {})['port'])

    def test_a_connection_the_server_closed_is_replaced_transparently(self):
        post(self.url, 'p', 't', 'heartbeat', {}, reuse=True)
        stale = next(iter(collector._connections.values())); stale.sock.close()
        self.assertTrue(post(self.url, 'p', 't', 'heartbeat', {}, reuse=True)['ok'])

    def test_statuses_keep_their_meaning(self):
        Handler.statuses = [400, 404]
        with self.assertRaises(Rejected):
            post(self.url, 'p', 't', 'turn-ingest', {}, reuse=True)
        with self.assertRaises(StatusError) as caught:
            post(self.url, 'p', 't', 'turn-ingest', {}, reuse=True)
        self.assertEqual(caught.exception.status, 404)


class WakeTests(unittest.TestCase):
    def test_a_hook_wake_ends_the_wait_immediately_and_a_missing_collector_is_harmless(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as directory:
            state = Path(directory) / 'spool.sqlite'
            wake(state)
            sock = open_wake(state)
            self.assertIsNotNone(sock)
            try:
                started = time.monotonic(); self.assertFalse(wait_for_wake(sock, 0.2))
                wake(state); wake(state)
                started = time.monotonic(); self.assertTrue(wait_for_wake(sock, 5))
                self.assertLess(time.monotonic() - started, 1)
                self.assertFalse(wait_for_wake(sock, 0.1))
            finally:
                sock.close()


class HotTranscriptTests(unittest.TestCase):
    def test_a_write_to_an_active_transcript_ends_the_wait_without_any_hook(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rollout.jsonl'; path.write_text('{}\n')
            settled = {str(path): (collector.file_signature(path), time.monotonic())}
            hot = [(str(path), path)]
            with patch.object(collector, 'HOT_POLL_SECONDS', 0.05):
                started = time.monotonic()
                self.assertFalse(collector.wait_for_activity(None, hot, settled, 0.3))
                self.assertGreaterEqual(time.monotonic() - started, 0.25)
                threading.Timer(0.1, lambda: path.write_text('{}\n{}\n')).start()
                started = time.monotonic()
                self.assertTrue(collector.wait_for_activity(None, hot, settled, 5))
                self.assertLess(time.monotonic() - started, 1)

    def test_a_vanished_file_counts_as_activity_but_a_paused_one_does_not(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'gone.jsonl'
            self.assertTrue(collector.hot_changed([(str(path), path)], {str(path): ((0, 0, 0, 0), 0.0)}))
            self.assertFalse(collector.hot_changed([(str(path), path)], {}))


class HookWakeTests(unittest.TestCase):
    def test_claude_gets_a_stop_wake_and_codex_gets_no_new_definition(self):
        from install_hooks import PROVIDER_EVENTS, install
        with tempfile.TemporaryDirectory() as directory:
            for provider in ('claude', 'codex'):
                path = Path(directory) / f'{provider}.json'
                command = f'python3 /x/feedback_hook.py --url u --project p --host h --provider {provider} --token-file /t --state /s'
                install(path, command, True, PROVIDER_EVENTS[provider])
                events = set(json.loads(path.read_text())['hooks'])
                self.assertEqual('Stop' in events, provider == 'claude')

    def test_stop_only_wakes_the_collector_and_never_prints_or_calls_fusion(self):
        import io, sys, feedback_hook
        with tempfile.TemporaryDirectory(dir='/tmp') as directory:
            root = Path(directory); token = root / 'token'; token.write_text('x' * 40); token.chmod(0o600)
            state = root / 'spool.sqlite'; sock = open_wake(state)
            argv = ['feedback_hook.py', '--url', 'http://localhost:1', '--project', 'p', '--host', 'h', '--provider', 'claude',
                    '--token-file', str(token), '--state', str(state)]
            stdin = io.TextIOWrapper(io.BytesIO(json.dumps(dict(session_id='s', hook_event_name='Stop')).encode()))
            out = io.StringIO()
            try:
                with patch.object(sys, 'argv', argv), patch.object(sys, 'stdin', stdin), patch.object(sys, 'stdout', out), \
                        patch.object(feedback_hook, 'post', side_effect=AssertionError('no network on Stop')):
                    feedback_hook.main()
                self.assertEqual(out.getvalue(), '')
                self.assertTrue(wait_for_wake(sock, 1))
            finally:
                sock.close()


if __name__ == '__main__':
    unittest.main()
