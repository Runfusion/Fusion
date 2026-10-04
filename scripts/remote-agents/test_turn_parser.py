import unittest
import json
from pathlib import Path
import tempfile

from collector import Rejected, bind, connect, drain_turns, scan
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


class TurnUsageTests(unittest.TestCase):
    def claude(self, usage, message_id='msg-1'):
        state = {}
        consume_claude(state, {'type': 'user', 'uuid': 'u1', 'timestamp': '2026-09-23T10:00:00Z',
                               'message': {'role': 'user', 'content': 'go'}})
        return consume_claude(state, {'type': 'assistant', 'timestamp': '2026-09-23T10:00:05Z',
                                      'message': {'id': message_id, 'role': 'assistant', 'model': 'claude-sonnet-5',
                                                  'content': 'done', 'usage': usage}}), state

    def test_records_measured_usage_and_context_against_the_turn(self):
        turn, _ = self.claude({'input_tokens': 100, 'cache_read_input_tokens': 900,
                               'cache_creation_input_tokens': 50, 'output_tokens': 20})
        self.assertEqual(len(turn['usage']), 1)
        entry = turn['usage'][0]
        self.assertEqual(entry['requestId'], 'msg-1')
        self.assertEqual(entry['model'], 'claude-sonnet-5')
        # inputTokens is the whole context presented to the model, which is also the context size.
        self.assertEqual(entry['inputTokens'], 1050)
        self.assertEqual(entry['cachedInputTokens'], 900)
        self.assertEqual(entry['outputTokens'], 20)
        self.assertEqual(turn['contextTokens'], 1050)
        self.assertEqual(turn['contextCapacity'], 200000)
        self.assertEqual((entry['fast'], entry['longContext']), (False, False))

    USAGE_CONTRACT_KEYS = {'requestId', 'model', 'inputTokens', 'cachedInputTokens', 'cacheWriteTokens',
                           'cacheWriteHourTokens', 'outputTokens', 'reasoningTokens', 'fast', 'longContext'}

    def test_usage_entries_carry_exactly_the_strict_contract_fields(self):
        # FNXC:RemoteAgents 2026-10-04-09:20: the server schema is strict; a missing or extra key rejects the turn.
        turn, _ = self.claude({'input_tokens': 100, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0,
                               'output_tokens': 20, 'speed': 'fast'})
        self.assertEqual(set(turn['usage'][0]), self.USAGE_CONTRACT_KEYS)
        self.assertTrue(turn['usage'][0]['fast'])
        big, _ = self.claude({'input_tokens': 250000, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0, 'output_tokens': 1})
        self.assertTrue(big['usage'][0]['longContext'])

    def test_does_not_double_count_a_repeated_message_id(self):
        state = {}
        consume_claude(state, {'type': 'user', 'uuid': 'u1', 'timestamp': '2026-09-23T10:00:00Z',
                               'message': {'role': 'user', 'content': 'go'}})
        event = {'type': 'assistant', 'timestamp': '2026-09-23T10:00:05Z',
                 'message': {'id': 'msg-1', 'role': 'assistant', 'content': 'a',
                             'usage': {'input_tokens': 10, 'cache_read_input_tokens': 0,
                                       'cache_creation_input_tokens': 0, 'output_tokens': 5}}}
        consume_claude(state, event)
        consume_claude(state, event)
        self.assertEqual(len(state['turn']['usage']), 1)

    def test_unreadable_usage_marks_the_turn_incomplete_instead_of_dropping_it(self):
        turn, state = self.claude({'input_tokens': 'lots', 'output_tokens': 5})
        recorded = state['turn']
        self.assertEqual(recorded.get('usage'), [])
        # Silently reporting no usage would let the turn read as free.
        self.assertIs(recorded.get('usageComplete'), False)

    def test_usage_without_output_tokens_is_not_recorded(self):
        _, state = self.claude({'input_tokens': 10, 'cache_read_input_tokens': 0,
                                'cache_creation_input_tokens': 0})
        self.assertEqual(state['turn']['usage'], [])


class CodexTurnUsageTests(unittest.TestCase):
    def drive(self, events):
        state = {}
        last = None
        for event in events:
            snap = consume_codex(state, event)
            if snap:
                last = snap
        return last, state

    def events(self, turn_id='t-1', usage_turn_id=None, usage=None, model='gpt-5.6-sol'):
        usage = usage if usage is not None else {'input_tokens': 1000, 'cached_input_tokens': 200,
                                                 'cache_write_input_tokens': 0, 'output_tokens': 50,
                                                 'reasoning_output_tokens': 10}
        return [
            {'type': 'event_msg', 'timestamp': '2026-09-23T10:00:00Z', 'payload': {'type': 'user_message', 'message': 'go'}},
            {'type': 'event_msg', 'timestamp': '2026-09-23T10:00:01Z', 'payload': {'type': 'task_started', 'turn_id': turn_id}},
            {'type': 'turn_context', 'timestamp': '2026-09-23T10:00:02Z', 'payload': {'turn_id': turn_id, 'model': model}},
            {'type': 'token_usage_record', 'timestamp': '2026-09-23T10:00:03Z',
             'payload': {'turn_id': usage_turn_id or turn_id, 'response_id': 'resp-1', 'usage': usage}},
        ]

    def test_attaches_usage_by_the_turn_id_the_transcript_states(self):
        turn, _ = self.drive(self.events())
        self.assertEqual(len(turn['usage']), 1)
        entry = turn['usage'][0]
        self.assertEqual(entry['requestId'], 'resp-1')
        self.assertEqual(entry['model'], 'gpt-5.6-sol')
        self.assertEqual(entry['inputTokens'], 1000)
        self.assertEqual(entry['cachedInputTokens'], 200)
        self.assertEqual(entry['outputTokens'], 50)
        self.assertEqual(entry['reasoningTokens'], 10)
        self.assertEqual(turn['contextTokens'], 1000)
        self.assertEqual(turn['contextCapacity'], 272000)
        self.assertEqual((entry['fast'], entry['longContext']), (False, False))
        self.assertEqual(set(entry), TurnUsageTests.USAGE_CONTRACT_KEYS)

    def test_fast_service_tier_and_long_context_are_flagged(self):
        events = self.events(usage={'input_tokens': 300000, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0,
                                    'output_tokens': 5, 'reasoning_output_tokens': 0})
        events[2]['payload']['service_tier'] = 'fast'
        turn, _ = self.drive(events)
        self.assertEqual((turn['usage'][0]['fast'], turn['usage'][0]['longContext']), (True, True))

    def test_does_not_attach_usage_belonging_to_a_different_turn(self):
        # Guessing by position would attach this; the stated turn_id says it belongs elsewhere.
        _, state = self.drive(self.events(turn_id='t-1', usage_turn_id='t-other'))
        self.assertEqual(state['turn']['usage'], [])
        self.assertIsNone(state['turn']['contextTokens'])

    def test_unreadable_usage_marks_the_turn_incomplete_rather_than_zero(self):
        _, state = self.drive(self.events(usage={'input_tokens': 'lots'}))
        self.assertEqual(state['turn']['usage'], [])
        self.assertIs(state['turn'].get('usageComplete'), False)

    def test_does_not_double_count_a_repeated_response_id(self):
        events = self.events()
        _, state = self.drive(events + [events[-1]])
        self.assertEqual(len(state['turn']['usage']), 1)

    def test_usage_without_a_model_is_omitted_and_marked_incomplete_rather_than_invented(self):
        # FNXC:RemoteAgents 2026-10-04-09:50: the strict contract requires a model; a null rejects the whole turn.
        events = [e for e in self.events() if e['type'] != 'turn_context']
        _, state = self.drive(events)
        self.assertEqual(state['turn']['usage'], [])
        self.assertIs(state['turn']['usageComplete'], False)
        self.assertEqual(state['turn']['contextTokens'], 1000)

    def test_models_are_still_known_after_more_turns_than_the_map_limit(self):
        state = {}
        for n in range(300):
            consume_codex(state, {'type': 'turn_context', 'timestamp': '2026-09-23T10:00:00Z', 'payload': {'turn_id': f't-{n}', 'model': f'm-{n}'}})
        self.assertEqual(len(state['turnModels']), 256)
        self.assertNotIn('t-0', state['turnModels'])
        events = self.events(turn_id='t-299', model='m-299')
        turn, _ = self.drive([e for e in events if e['type'] != 'turn_context'] if False else events)
        self.assertEqual(turn['usage'][0]['model'], 'm-299')
        last, _ = self.drive(self.events(turn_id='t-299'))
        self.assertEqual(last['usage'][0]['model'], 'gpt-5.6-sol')


class TurnTimingIntegrityTests(unittest.TestCase):
    """FNXC:RemoteAgents 2026-09-30-10:59: a completion stamped before the prompt must not produce a turn that
    ends before it starts (Fusion rejects it forever) nor a fabricated 0 ms duration."""

    def test_claude_completion_before_the_prompt_leaves_the_end_unknown(self):
        state = {}
        consume_claude(state, dict(timestamp='2026-09-16T12:02:38.850Z', type='user', uuid='p', message=dict(content='Go')))
        done = consume_claude(state, dict(timestamp='2026-09-16T11:55:47.216Z', type='assistant',
                                          message=dict(content=[dict(type='text', text='Done')], stop_reason='end_turn')))
        self.assertEqual((done['state'], done['endedAt'], done['durationMs'], done['durationSource']), ('completed', None, None, None))
        # The provider's own duration is still a measurement worth keeping, even when its timestamp is out of order.
        native = consume_claude(state, dict(timestamp='2026-09-16T11:55:48Z', type='system', subtype='turn_duration', durationMs=3750))
        self.assertEqual((native['endedAt'], native['durationMs'], native['durationSource']), (None, 3750, 'native'))

    def test_codex_completion_before_the_start_leaves_the_end_unknown(self):
        state = {}
        consume_codex(state, dict(type='event_msg', timestamp='2026-09-22T12:00:05Z', payload=dict(type='task_started', turn_id='t')))
        consume_codex(state, dict(type='event_msg', timestamp='2026-09-22T12:00:06Z', payload=dict(type='user_message', message='Go')))
        done = consume_codex(state, dict(type='event_msg', timestamp='2026-09-22T12:00:01Z', payload=dict(type='task_complete', last_agent_message='ok')))
        self.assertEqual((done['endedAt'], done['durationMs'], done['durationSource']), (None, None, None))

    def test_a_consistent_end_is_unchanged(self):
        state = {}
        consume_claude(state, dict(timestamp='2026-09-16T12:00:00Z', type='user', uuid='p', message=dict(content='Go')))
        done = consume_claude(state, dict(timestamp='2026-09-16T12:00:02Z', type='assistant',
                                          message=dict(content=[dict(type='text', text='Done')], stop_reason='end_turn')))
        self.assertEqual((done['endedAt'], done['durationMs'], done['durationSource']), ('2026-09-16T12:00:02Z', 2000, 'derived'))


class RejectedTurnDeliveryTests(unittest.TestCase):
    """FNXC:RemoteAgents 2026-09-30-10:59: one record Fusion permanently refuses must not block the turns behind it,
    while a server-side failure still stops delivery so nothing is lost."""

    def _spool_two_sessions(self, root):
        db = connect(root / 'spool.sqlite'); bind(db, 'project', 'host')
        for name, native in (('a.jsonl', 'native-a'), ('b.jsonl', 'native-b')):
            (root / name).write_text(''.join(json.dumps(e) + '\n' for e in [
                dict(type='session_meta', timestamp='2026-09-22T12:00:00Z', payload=dict(id=native, cwd='/work')),
                dict(type='event_msg', timestamp='2026-09-22T12:00:01Z', payload=dict(type='task_started', turn_id='t-' + native)),
                dict(type='event_msg', timestamp='2026-09-22T12:00:02Z', payload=dict(type='user_message', message='Go')),
                dict(type='event_msg', timestamp='2026-09-22T12:00:03Z', payload=dict(type='task_complete', last_agent_message='ok')),
            ]))
            scan(db, root / name, 'codex')
        db.execute('DELETE FROM pending'); db.commit()
        return db

    def test_a_permanently_rejected_turn_is_set_aside_and_later_turns_deliver(self):
        with tempfile.TemporaryDirectory() as directory:
            db = self._spool_two_sessions(Path(directory))
            sent = []
            def send(operation, body):
                sent.append(body['turn']['nativeTurnId'])
                if len(sent) == 1:
                    raise Rejected(400)
                return dict(eventId=body['eventId'], sessionId=body['sessionId'],
                            nativeTurnId=body['turn']['nativeTurnId'], revision=body['turn']['revision'])
            self.assertEqual(drain_turns(db, 'project', 'host', send), 1)
            self.assertEqual(len(sent), 2)
            self.assertEqual(db.execute('SELECT count(*) FROM turns WHERE revision>acked').fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT value FROM counters WHERE key='rejected_turns'").fetchone()[0], 1)
            db.close()

    def test_a_server_failure_still_blocks_and_keeps_every_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            db = self._spool_two_sessions(Path(directory))
            def send(operation, body):
                raise ValueError('Collector returned HTTP 503')
            with self.assertRaises(ValueError):
                drain_turns(db, 'project', 'host', send)
            self.assertEqual(db.execute('SELECT count(*) FROM turns WHERE revision>acked').fetchone()[0], 2)
            db.close()
