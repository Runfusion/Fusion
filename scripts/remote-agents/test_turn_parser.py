import unittest
import json
from pathlib import Path
import tempfile

from collector import RejectedError, bind, connect, drain_turns, scan
from turn_parser import consume_claude, consume_codex


class CodexTurnTests(unittest.TestCase):
    def test_prompt_result_duration_and_native_patch(self):
        state = {}
        def event(at, kind, **payload):
            return dict(timestamp=f'2026-09-22T12:00:{at:02d}Z', type=kind, payload=payload)

        self.assertIsNone(consume_codex(state, event(0, 'event_msg', type='task_started', turn_id='turn-1')))
        first = consume_codex(state, event(1, 'event_msg', type='user_message', message='Fix this'))
        self.assertEqual((first['nativeTurnId'], first['ordinal'], first['revision']), ('turn-1', 0, 1))
        self.assertEqual(first['prompts'][0]['text'], 'Fix this')
        consume_codex(state, event(2, 'event_msg', type='item_completed', item=dict(type='CommandExecution')))
        changed = consume_codex(state, event(3, 'event_msg', type='item_completed', item=dict(
            type='FileChange', changes={'src/a.ts': {'type': 'modify', 'unified_diff': '@@ -1 +1 @@\n-old\n+new\n'},
                                         'src/b.ts': {'type': 'add'}})))
        self.assertEqual(changed['toolCallCount'], 1)
        self.assertEqual((changed['fileChanges'][0]['addedLines'], changed['fileChanges'][0]['removedLines']), (1, 1))
        self.assertFalse(changed['fileChanges'][1]['patchAvailable'])
        done = consume_codex(state, event(8, 'event_msg', type='task_complete', last_agent_message='Done'))
        self.assertEqual((done['state'], done['response'], done['durationMs'], done['durationSource']),
                         ('completed', 'Done', 8000, 'derived'))
        self.assertEqual(done['revision'], 4)

    def test_native_duration_and_interrupted_turn(self):
        state = {}
        consume_codex(state, dict(timestamp='2026-09-22T12:00:00Z', type='event_msg', payload=dict(type='task_started', turn_id='a')))
        consume_codex(state, dict(timestamp='2026-09-22T12:00:01Z', type='event_msg', payload=dict(type='user_message', message='Prompt')))
        result = consume_codex(state, dict(timestamp='2026-09-22T12:00:05Z', type='event_msg', payload=dict(type='turn_aborted', duration_ms=1700)))
        self.assertEqual((result['state'], result['durationMs'], result['durationSource']), ('interrupted', 1700, 'native'))

    def test_prompt_before_task_start_keeps_one_native_identity(self):
        state = {}
        prompt = dict(timestamp='2026-09-22T12:00:00Z', type='event_msg', payload=dict(type='user_message', message='First'))
        self.assertIsNone(consume_codex(state, prompt))
        first = consume_codex(state, dict(timestamp='2026-09-22T12:00:01Z', type='event_msg', payload=dict(type='task_started', turn_id='native-a')))
        self.assertEqual((first['nativeTurnId'], first['ordinal'], first['revision'], first['startedAt']),
                         ('native-a', 0, 1, '2026-09-22T12:00:00Z'))
        consume_codex(state, dict(timestamp='2026-09-22T12:00:02Z', type='event_msg', payload=dict(type='task_complete')))
        self.assertIsNone(consume_codex(state, dict(timestamp='2026-09-22T12:00:03Z', type='event_msg', payload=dict(type='user_message', message='Second'))))
        second = consume_codex(state, dict(timestamp='2026-09-22T12:00:04Z', type='event_msg', payload=dict(type='task_started', turn_id='native-b')))
        self.assertEqual((second['nativeTurnId'], second['ordinal'], second['prompts'][0]['text']), ('native-b', 1, 'Second'))

    def test_durable_delivery_retries_latest_revision_after_observation_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = connect(root / 'spool.sqlite'); bind(db, 'project', 'host')
            transcript = root / 'rollout.jsonl'
            events = [
                dict(type='session_meta', timestamp='2026-09-22T12:00:00Z', payload=dict(id='native', cwd='/work')),
                dict(type='event_msg', timestamp='2026-09-22T12:00:01Z', payload=dict(type='user_message', message='Fix it')),
                dict(type='event_msg', timestamp='2026-09-22T12:00:02Z', payload=dict(type='task_started', turn_id='turn-a')),
                dict(type='event_msg', timestamp='2026-09-22T12:00:03Z', payload=dict(type='task_complete', last_agent_message='Fixed')),
            ]
            transcript.write_text(''.join(json.dumps(event) + '\n' for event in events))
            scan(db, transcript, 'codex')
            self.assertEqual(db.execute('SELECT count(*) FROM turns').fetchone()[0], 1)
            other = root / 'other.jsonl'
            other.write_text(''.join(json.dumps(event) + '\n' for event in [
                dict(type='session_meta', timestamp='2026-09-22T12:01:00Z', payload=dict(id='native-b', cwd='/work')),
                dict(type='event_msg', timestamp='2026-09-22T12:01:01Z', payload=dict(type='task_started', turn_id='turn-b')),
                dict(type='event_msg', timestamp='2026-09-22T12:01:02Z', payload=dict(type='user_message', message='Other work')),
            ]))
            scan(db, other, 'codex')
            sent = []
            def send(operation, body):
                sent.append((operation, body))
                return dict(eventId=body['eventId'], sessionId=body['sessionId'],
                            nativeTurnId=body['turn']['nativeTurnId'], revision=body['turn']['revision'])
            self.assertEqual(drain_turns(db, 'project', 'host', send), 0)
            db.execute("DELETE FROM pending WHERE json_extract(body,'$.session.nativeSessionId')='native'")
            db.execute('INSERT INTO acknowledged_sessions VALUES (?,?)', ('codex', 'native'))
            db.commit()
            self.assertGreater(db.execute('SELECT count(*) FROM pending').fetchone()[0], 0)
            self.assertEqual(drain_turns(db, 'project', 'host', send), 1)
            self.assertEqual(drain_turns(db, 'project', 'host', send), 0)
            self.assertEqual(sent[0][1]['turn']['response'], 'Fixed')
            self.assertEqual(len(sent[0][1]['sessionId']), 64)
            db.close()

    def test_rejected_turn_is_skipped_and_later_turns_still_deliver(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = connect(root / 'spool.sqlite'); bind(db, 'project', 'host')
            db.execute('INSERT INTO acknowledged_sessions VALUES (?,?)', ('claude', 'native'))
            for turn_id in ('bad', 'good'):
                db.execute('INSERT INTO turns(provider,native,turn_id,revision,body) VALUES (?,?,?,?,?)',
                           ('claude', 'native', turn_id, 1, json.dumps(dict(nativeTurnId=turn_id, revision=1, ordinal=0, state='completed',
                                                                            prompts=[dict(at='2026-09-22T12:00:00Z', text='Go')], response='Done',
                                                                            startedAt='2026-09-22T12:00:00Z', endedAt='2026-09-22T12:00:01Z',
                                                                            durationMs=1000, durationSource='derived', toolCallCount=0, fileChanges=[]))))
            db.commit()
            def send(operation, body):
                if body['turn']['nativeTurnId'] == 'bad':
                    raise RejectedError('Collector returned HTTP 400')
                return dict(eventId=body['eventId'], sessionId=body['sessionId'], nativeTurnId=body['turn']['nativeTurnId'], revision=body['turn']['revision'])
            self.assertEqual(drain_turns(db, 'project', 'host', send), 1)
            self.assertEqual(db.execute("SELECT turn_id,acked FROM turns ORDER BY turn_id").fetchall(), [('bad', 0), ('good', 1)])
            db.close()

    def test_reopen_repairs_spooled_turns_that_end_before_they_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / 'spool.sqlite'
            db = connect(path); bind(db, 'project', 'host')
            body = dict(nativeTurnId='t', revision=2, ordinal=0, state='completed', prompts=[dict(at='2026-09-07T17:43:48Z', text='Go')], response='Done',
                        startedAt='2026-09-07T17:43:48Z', endedAt='2026-09-07T17:37:49Z', durationMs=0, durationSource='derived', toolCallCount=0, fileChanges=[])
            db.execute('INSERT INTO turns(provider,native,turn_id,revision,body) VALUES (?,?,?,?,?)', ('claude', 'native', 't', 2, json.dumps(body)))
            db.execute("DELETE FROM config WHERE key='turn_order_repair_v1'")
            db.commit(); db.close()
            db = connect(path)
            repaired = json.loads(db.execute("SELECT body FROM turns WHERE turn_id='t'").fetchone()[0])
            self.assertEqual((repaired['startedAt'], repaired['endedAt'], repaired['revision']), ('2026-09-07T17:43:48Z', '2026-09-07T17:43:48Z', 2))
            db.close()

    def test_reopen_recovers_acknowledged_sessions_when_spool_is_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / 'spool.sqlite'
            db = connect(path); bind(db, 'project', 'host')
            db.execute('INSERT INTO observations VALUES (?,?,?,?,?)',
                       ('codex', 'native', '{}', 'digest', 1))
            db.commit(); db.close()
            db = connect(path)
            self.assertEqual(db.execute('SELECT provider,native FROM acknowledged_sessions').fetchall(),
                             [('codex', 'native')])
            db.close()


class ClaudeTurnTests(unittest.TestCase):
    def test_prompt_tools_patch_final_answer_and_native_duration(self):
        state = {}
        def event(second, kind, **extra):
            return dict(timestamp=f'2026-09-22T12:00:{second:02d}Z', type=kind,
                        sessionId='session', cwd='/work', **extra)
        prompt = consume_claude(state, event(0, 'user', uuid='prompt-a', message=dict(content='Change it')))
        self.assertEqual((prompt['nativeTurnId'], prompt['prompts'][0]['text']), ('prompt-a', 'Change it'))
        tool = consume_claude(state, event(1, 'assistant', message=dict(content=[
            dict(type='tool_use', id='edit-1', name='Edit', input=dict(file_path='src/a.ts'))])))
        self.assertEqual(tool['toolCallCount'], 1)
        result = consume_claude(state, event(2, 'user', message=dict(content=[dict(type='tool_result', tool_use_id='edit-1')]),
                                            toolUseResult=dict(structuredPatch=[dict(oldStart=1, oldLines=1, newStart=1, newLines=1,
                                                                                      lines=['-before', '+after'])])))
        self.assertEqual((result['fileChanges'][0]['addedLines'], result['fileChanges'][0]['removedLines']), (1, 1))
        self.assertTrue(result['fileChanges'][0]['patchAvailable'])
        answer = consume_claude(state, event(4, 'assistant', message=dict(content=[dict(type='text', text='Done')], stop_reason='end_turn')))
        self.assertEqual((answer['state'], answer['response'], answer['durationSource']), ('completed', 'Done', 'derived'))
        done = consume_claude(state, event(5, 'system', subtype='turn_duration', durationMs=3750))
        self.assertEqual((done['durationMs'], done['durationSource'], done['ordinal']), (3750, 'native', 0))
        next_prompt = consume_claude(state, event(6, 'user', uuid='prompt-b', message=dict(content='Next')))
        self.assertEqual((next_prompt['nativeTurnId'], next_prompt['ordinal']), ('prompt-b', 1))

    def test_completion_older_than_compaction_prompt_cannot_end_before_start(self):
        state = {}
        consume_claude(state, dict(timestamp='2026-09-07T17:43:48Z', type='user', uuid='summary', message=dict(content='Continued from compaction')))
        replayed = consume_claude(state, dict(timestamp='2026-09-07T17:37:49Z', type='assistant',
                                              message=dict(content=[dict(type='text', text='Earlier answer')], stop_reason='end_turn')))
        self.assertEqual((replayed['state'], replayed['startedAt'], replayed['endedAt']), ('completed', '2026-09-07T17:43:48Z', '2026-09-07T17:43:48Z'))
        self.assertEqual((replayed['durationMs'], replayed['durationSource']), (0, 'derived'))
        self.assertLessEqual(replayed['startedAt'], replayed['endedAt'])

    def test_unreported_patch_and_duplicate_tool_call(self):
        state = {}
        consume_claude(state, dict(timestamp='2026-09-22T12:00:00Z', type='user', uuid='a', message=dict(content='Write')))
        tool = dict(timestamp='2026-09-22T12:00:01Z', type='assistant', message=dict(content=[
            dict(type='tool_use', id='write-1', name='Write', input=dict(file_path='src/new.ts'))]))
        consume_claude(state, tool); consume_claude(state, tool)
        change = consume_claude(state, dict(timestamp='2026-09-22T12:00:02Z', type='user',
                                          message=dict(content=[dict(type='tool_result', tool_use_id='write-1')])))
        self.assertEqual(change['toolCallCount'], 1)
        self.assertFalse(change['fileChanges'][0]['patchAvailable'])

    def test_collector_spools_claude_turn_with_native_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); db = connect(root / 'spool.sqlite'); bind(db, 'project', 'host')
            transcript = root / 'session.jsonl'
            events = [
                dict(type='user', timestamp='2026-09-22T12:00:00Z', sessionId='session', cwd='/work',
                     uuid='prompt-a', message=dict(content='Fix the file')),
                dict(type='assistant', timestamp='2026-09-22T12:00:03Z', sessionId='session', cwd='/work',
                     message=dict(id='request-a', model='claude', content=[dict(type='text', text='Fixed')],
                                  stop_reason='end_turn')),
                dict(type='system', subtype='turn_duration', timestamp='2026-09-22T12:00:04Z', sessionId='session', cwd='/work',
                     durationMs=2400),
            ]
            transcript.write_text(''.join(json.dumps(event) + '\n' for event in events))
            scan(db, transcript, 'claude')
            row = db.execute('SELECT native,turn_id,revision,body FROM turns').fetchone()
            self.assertEqual((row[0], row[1]), ('session', 'prompt-a'))
            self.assertEqual((json.loads(row[3])['durationMs'], json.loads(row[3])['response']), (2400, 'Fixed'))
            self.assertEqual(db.execute('SELECT count(*) FROM turns').fetchone()[0], 1)
            db.close()


if __name__ == '__main__':
    unittest.main()
