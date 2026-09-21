import json
import shlex
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from collector import connect, bind, scan, validated_base_url
from native_parser import consume, totals
from feedback_hook import run
from install_hooks import install


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.db = connect(self.root / 'spool.sqlite'); bind(self.db, 'project', 'host')

    def tearDown(self):
        self.db.close(); self.tmp.cleanup()

    def test_collector_url_restricts_private_http_and_embedded_credentials(self):
        self.assertEqual(validated_base_url('https://fusion.example'), 'https://fusion.example')
        self.assertEqual(validated_base_url('http://10.8.0.5:4040/'), 'http://10.8.0.5:4040')
        self.assertEqual(validated_base_url('http://localhost:4040'), 'http://localhost:4040')
        self.assertEqual(validated_base_url('http://<collector-endpoint>'), 'http://<collector-endpoint>')
        for value in ('http://fusion.example', 'http://8.8.8.8', 'https://user:secret@fusion.example', 'file:///tmp/socket', 'https://fusion.example/prefix'):
            with self.assertRaises(ValueError):
                validated_base_url(value)

    def test_claude_request_deduplication_and_cache_accounting(self):
        state = {}; base = dict(type='assistant', timestamp='2026-09-18T05:00:00Z', sessionId='native', cwd='/work', message=dict(id='request', model='claude', usage=dict(input_tokens=100, cache_read_input_tokens=50, cache_creation_input_tokens=10, output_tokens=5)))
        consume(self.db, state, base, 'claude'); consume(self.db, state, base, 'claude')
        updated = json.loads(json.dumps(base)); updated['message']['usage']['output_tokens'] = 8
        consume(self.db, state, updated, 'claude')
        result = totals(self.db, 'claude', 'native')[0]
        self.assertEqual((result['inputTokens'], result['cachedInputTokens'], result['cacheWriteTokens'], result['outputTokens']), (160, 50, 10, 8))

    def test_codex_cumulative_snapshots_are_not_added_twice(self):
        state = dict(nativeSessionId='native', projectPath='/work', model='codex')
        e = dict(type='event_msg', timestamp='2026-09-18T05:00:00Z', payload=dict(type='token_count', info=dict(total_token_usage=dict(input_tokens=100, cached_input_tokens=50, output_tokens=10, reasoning_output_tokens=5))))
        consume(self.db, state, e, 'codex'); consume(self.db, state, e, 'codex')
        self.assertEqual(totals(self.db, 'codex', 'native')[0]['inputTokens'], 100)

    def test_codex_response_receipts_preserve_models_and_cache_writes(self):
        state = dict(nativeSessionId='native', projectPath='/work', model='model-a')
        e = dict(type='token_usage_record', timestamp='2026-09-18T05:00:00Z', payload=dict(response_id='response-a', usage=dict(input_tokens=100, cached_input_tokens=40, cache_write_input_tokens=10, output_tokens=8, reasoning_output_tokens=3)))
        consume(self.db, state, e, 'codex'); consume(self.db, state, e, 'codex')
        state['model']='model-b'; e=json.loads(json.dumps(e)); e['payload']['response_id']='response-b'
        consume(self.db, state, e, 'codex')
        result=totals(self.db, 'codex', 'native')
        self.assertEqual({u['model'] for u in result}, {'model-a','model-b'})
        self.assertEqual(sum(u['inputTokens'] for u in result),200)
        self.assertEqual(sum(u['cacheWriteTokens'] for u in result),20)

    def test_partial_line_retry_and_restart_preserve_sequence(self):
        p = self.root / 'rollout.jsonl'
        meta = json.dumps(dict(type='session_meta', timestamp='2026-09-18T05:00:00Z', payload=dict(id='native', cwd='/work')))
        prompt = json.dumps(dict(type='event_msg', timestamp='2026-09-18T05:01:00Z', payload=dict(type='user_message', message='Do the work')))
        p.write_text(meta + '\n' + prompt[:20]); scan(self.db, p, 'codex')
        first = self.db.execute('SELECT offset FROM files').fetchone()[0]
        self.assertEqual(first, len(meta) + 1)
        p.write_text(meta + '\n' + prompt + '\n'); scan(self.db, p, 'codex')
        rows = self.db.execute('SELECT sequence,body FROM pending ORDER BY sequence').fetchall()
        self.assertEqual([r[0] for r in rows], [1, 2]); self.assertEqual(json.loads(rows[-1][1])['session']['title'], 'Do the work')
        scan(self.db, p, 'codex'); self.assertEqual(self.db.execute('SELECT count(*) FROM pending').fetchone()[0], 2)

    def test_native_hook_emits_once_and_resumed_generation_rejects_old_command(self):
        emitted = []; acks = []; payload = dict(session_id='native', hook_event_name='PreToolUse')
        def send(operation, b):
            if operation == 'feedback-ack':
                acks.append(b); return dict(acknowledged=True)
            return dict(command=dict(commandId='command', text='Feedback', hostId='host', nativeSessionId='native', provider='codex', sessionId=b['sessionId'], generation=b['generation'], expiresAt=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()))
        run(self.db, 'project', 'host', 'codex', payload, send, emitted.append)
        run(self.db, 'project', 'host', 'codex', payload, send, emitted.append)
        self.assertEqual(len(emitted), 1); self.assertEqual(acks[0]['status'], 'delivered'); self.assertEqual(acks[1]['status'], 'uncertain')
        old = self.db.execute('SELECT generation FROM runtimes').fetchone()[0]
        run(self.db, 'project', 'host', 'codex', dict(session_id='native', hook_event_name='SessionStart'), lambda op, b: dict(command=None), emitted.append)
        self.assertNotEqual(self.db.execute('SELECT generation FROM runtimes').fetchone()[0], old)

    def test_large_compaction_does_not_hide_live_activity_or_reset_cursor(self):
        p = self.root / 'rollout.jsonl'
        meta = dict(type='session_meta', timestamp='2026-09-18T05:00:00Z', payload=dict(id='native', cwd='/work'))
        compact = dict(timestamp='2026-09-18T05:01:00Z', type='compacted', payload=dict(message='x' * (5 * 1024 * 1024)))
        prompt = dict(type='event_msg', timestamp='2026-09-18T05:02:00Z', payload=dict(type='user_message', message='Latest live prompt'))
        p.write_text('\n'.join(json.dumps(e) for e in [meta, compact, prompt]) + '\n')
        scan(self.db, p, 'codex'); scan(self.db, p, 'codex')
        newest = json.loads(self.db.execute('SELECT body FROM pending ORDER BY sequence DESC LIMIT 1').fetchone()[0])
        self.assertEqual(newest['session']['title'], 'Latest live prompt')
        self.assertFalse(newest['session']['usageComplete'])
        for _ in range(8): scan(self.db, p, 'codex')
        self.assertEqual(self.db.execute('SELECT offset FROM files').fetchone()[0], p.stat().st_size)
        count = self.db.execute('SELECT count(*) FROM pending').fetchone()[0]
        p.write_text('replaced\n')
        with self.assertRaises(ValueError): scan(self.db, p, 'codex')
        self.assertEqual(self.db.execute('SELECT count(*) FROM pending').fetchone()[0], count)

    def test_missing_usage_is_unknown_and_hook_install_preserves_other_hooks(self):
        state = {}
        consume(self.db, state, dict(type='assistant', timestamp='2026-09-18T05:00:00Z', sessionId='native', cwd='/work', message=dict(id='request', model='claude', usage=dict(output_tokens=3))), 'claude')
        self.assertTrue(state['unreportedUsage']); self.assertEqual(totals(self.db, 'claude', 'native'), [])
        path = self.root / 'settings.json'
        other = {'hooks': {'PreToolUse': [{'hooks': [{'type': 'command', 'command': 'existing-hook'}]}]}, 'otherSetting': True}
        path.write_text(json.dumps(other)); install(path, 'fusion-hook', True); install(path, 'fusion-hook', True)
        result = json.loads(path.read_text())
        self.assertTrue(result['otherSetting'])
        self.assertEqual(result['hooks']['PreToolUse'][0], other['hooks']['PreToolUse'][0])
        self.assertEqual(len(result['hooks']['PreToolUse']), 2)

    def test_hook_route_update_deduplicates_only_owned_invocations(self):
        path = self.root / 'hooks.json'
        old = shlex.join(['python3', '/owned/feedback_hook.py', '--url', 'http://127.0.0.1:14040', '--project', 'project', '--host', 'm3', '--provider', 'codex', '--token-file', '/private/token', '--state', '/private/spool'])
        new = old.replace('http://127.0.0.1:14040', 'http://<collector-endpoint>')
        peer = old.replace('--project project', '--project peer-project')
        wrapper = old + ' && echo operator-command'
        preserved = [{'type': 'command', 'command': 'existing-hook'}, {'type': 'command', 'command': peer}, {'type': 'command', 'command': wrapper}]
        config = {'trust': {'unchanged': True}, 'hooks': {'PreToolUse': [
            {'matcher': 'Bash', 'hooks': [*preserved, {'type': 'command', 'command': old, 'timeout': 3}]},
            {'hooks': [{'type': 'command', 'command': new}]},
            {'hooks': [{'type': 'command', 'command': old}]},
        ]}}
        path.write_text(json.dumps(config))
        before = path.read_bytes()
        install(path, new)
        self.assertEqual(path.read_bytes(), before)
        install(path, new, True)
        result = json.loads(path.read_text())
        self.assertEqual(result['trust'], config['trust'])
        self.assertEqual(result['hooks']['PreToolUse'][0]['matcher'], 'Bash')
        self.assertEqual(result['hooks']['PreToolUse'][0]['hooks'][:3], preserved)
        for groups in result['hooks'].values():
            commands = [hook.get('command') for group in groups for hook in group['hooks']]
            self.assertEqual(commands.count(new), 1)
            self.assertNotIn(old, commands)
        self.assertEqual(len(result['hooks']['PreToolUse']), 1)
        backups = list(self.root.glob('hooks.json.fusion-backup-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        after = path.read_bytes()
        install(path, new, True)
        self.assertEqual(path.read_bytes(), after)
        self.assertEqual(list(self.root.glob('hooks.json.fusion-backup-*')), backups)


if __name__ == '__main__':
    unittest.main()
