"""Incremental, bounded Codex and Claude turns from native transcript events.

The caller persists ``state`` with its transcript cursor. No working-tree files are
read: a patch is shown only when the native event carries one.
"""
from datetime import datetime

from native_parser import CONTEXT_CAPACITY, bounded, claude_message_usage, codex_usage_record, content


def _elapsed(start, end):
    try:
        return round((datetime.fromisoformat(end.replace('Z', '+00:00')) -
                      datetime.fromisoformat(start.replace('Z', '+00:00'))).total_seconds() * 1000)
    except (AttributeError, ValueError):
        return None


def _finish(turn, at, native_duration=None):
    """Close a turn at ``at``, reporting only timing the transcript actually supports.

    FNXC:RemoteAgents 2026-09-30-10:59:
    A resumed or rewritten native transcript can carry a completion event whose timestamp precedes the turn's
    first prompt. Recording that as the end made a turn that "ends before it starts": Fusion rejects it (HTTP
    400) on every delivery, and because turns deliver in order, that one record blocked every later turn on
    the host until the spool filled and collection paused (measured on m3: 2,893 turns, 64 MiB, five days).
    The old clamp also reported such a turn as a derived 0 ms, a fabricated measurement.

    An end earlier than the start is therefore unknown, not zero: ``endedAt`` stays unset and only a native
    duration (the provider's own figure) is kept. A consistent end keeps the previous behaviour.
    """
    native = native_duration if isinstance(native_duration, int) and not isinstance(native_duration, bool) and native_duration >= 0 else None
    elapsed = _elapsed(turn['startedAt'], at)
    consistent = elapsed is not None and elapsed >= 0
    turn['endedAt'] = at if consistent else None
    turn['durationMs'] = native if native is not None else (elapsed if consistent else None)
    turn['durationSource'] = 'native' if native is not None else ('derived' if turn['durationMs'] is not None else None)


def _change(path, value):
    if not isinstance(path, str) or not path or not isinstance(value, dict):
        return None
    patch = value.get('unified_diff') or value.get('diff')
    available = isinstance(patch, str)
    patch = bounded(patch, 32768) if available else None
    operation = value.get('type', 'modify')
    operation = operation if operation in ('add', 'delete', 'modify', 'rename') else 'modify'
    full_patch = value.get('unified_diff') or value.get('diff')
    result = dict(path=bounded(path, 4096), operation=operation,
                  addedLines=sum(line.startswith('+') and not line.startswith('+++') for line in full_patch.splitlines()) if available else None,
                  removedLines=sum(line.startswith('-') and not line.startswith('---') for line in full_patch.splitlines()) if available else None,
                  patchAvailable=available, truncated=available and len(full_patch) > len(patch))
    if available:
        result['patch'] = patch
    if operation == 'rename':
        previous = value.get('previous_path') or value.get('previousPath')
        if not isinstance(previous, str) or not previous:
            result['operation'] = 'modify'
        else:
            result['previousPath'] = bounded(previous, 4096)
    return result


def consume_codex(state, event):
    """Update one active turn; return its contract-shaped snapshot when changed."""
    if not isinstance(event, dict) or not isinstance(event.get('timestamp'), str):
        return None
    payload = event.get('payload') or {}
    if not isinstance(payload, dict):
        return None
    kind, sub, at = event.get('type'), payload.get('type'), event['timestamp']
    turn = state.get('turn')
    if (not turn or turn['state'] != 'ongoing') and kind == 'event_msg' and sub == 'user_message':
        state['ordinal'] = state.get('ordinal', -1) + 1
        turn = dict(nativeTurnId='inferred:' + str(state['ordinal']), revision=0, ordinal=state['ordinal'],
                    state='ongoing', prompts=[], response=None, startedAt=at, endedAt=None,
                    durationMs=None, durationSource=None, toolCallCount=0, fileChanges=[],
                    usage=[], contextTokens=None, contextCapacity=CONTEXT_CAPACITY['codex'])
        state['turn'] = turn
    if kind == 'event_msg' and sub == 'task_started':
        native_id = payload.get('turn_id')
        if not isinstance(native_id, str) or not native_id:
            return None
        if turn and turn['nativeTurnId'] == native_id:
            return None
        if turn and turn['nativeTurnId'].startswith('inferred:') and turn['state'] == 'ongoing':
            turn['nativeTurnId'] = bounded(native_id, 256)
            turn['startedAt'] = at if at < turn['startedAt'] else turn['startedAt']
            return dict(turn) if turn['prompts'] else None
        state['ordinal'] = state.get('ordinal', -1) + 1
        turn = dict(nativeTurnId=bounded(native_id, 256), revision=0, ordinal=state['ordinal'],
                    state='ongoing', prompts=[], response=None, startedAt=at, endedAt=None,
                    durationMs=None, durationSource=None, toolCallCount=0, fileChanges=[])
        state['turn'] = turn
    
    """
    FNXC:ExternalSessionUsage 2026-09-24-00:04: Codex states the correlation itself: turn_context and
    token_usage_record both carry turn_id, and the transcript holds exactly one usage record per turn. Measured
    on a real 81-turn rollout: 81 turn_contexts, 81 usage records, 81 distinct turn_ids, zero on either side
    without a match. So usage is attached by stated identity, never by position or proximity.
    """
    if kind == 'turn_context':
        identity = payload.get('turn_id')
        model = payload.get('model')
        if isinstance(identity, str) and identity and isinstance(model, str) and model:
            models = state.setdefault('turnModels', {})
            if len(models) < 256:
                models[identity] = bounded(model, 256)
        if isinstance(identity, str) and identity:
            tiers = state.setdefault('turnTiers', {})
            if len(tiers) < 256:
                tiers[identity] = payload.get('service_tier') in ('fast', 'priority')
    if kind == 'token_usage_record':
        identity = payload.get('turn_id')
        usage = codex_usage_record(payload)
        if turn and isinstance(identity, str) and identity == turn['nativeTurnId']:
            if usage is None:
                # The record exists but cannot be read: the turn's accounting is incomplete, not zero.
                turn['usageComplete'] = False
                return dict(turn)
            request = payload.get('response_id')
            entries = turn.setdefault('usage', [])
            if len(entries) < 64 and not any(u.get('requestId') == request for u in entries):
                # FNXC:RemoteAgents 2026-10-04-09:20: the usage contract is strict and requires the pricing band
                # flags on every entry; without them Fusion rejected the whole turn (HTTP 400) and a collector
                # that sets rejected turns aside silently dropped it. Same derivation as session accounting.
                entries.append(dict(requestId=bounded(str(request), 256) if request else identity,
                                    model=state.get('turnModels', {}).get(identity),
                                    fast=state.get('turnTiers', {}).get(identity, False),
                                    longContext=usage['inputTokens'] > CONTEXT_CAPACITY['codex'], **usage))
                turn['contextTokens'] = usage['inputTokens']
                turn['contextCapacity'] = CONTEXT_CAPACITY['codex']
                return dict(turn)
        return None

    if not turn:
        return None
    changed = False
    if kind == 'event_msg' and sub == 'user_message' or kind == 'response_item' and sub == 'message' and payload.get('role') == 'user':
        value = payload.get('message') if sub == 'user_message' else content(payload.get('content'))
        if isinstance(value, str) and value and len(turn['prompts']) < 32:
            prompt = dict(at=at, text=bounded(value, 65536))
            if not turn['prompts'] or turn['prompts'][-1]['text'] != prompt['text']:
                turn['prompts'].append(prompt); changed = True
    elif kind == 'event_msg' and sub == 'item_completed':
        item = payload.get('item') or {}
        if isinstance(item, dict):
            typ = item.get('type')
            if typ == 'UserMessage':
                value = content(item.get('content'))
                if value and len(turn['prompts']) < 32 and (not turn['prompts'] or turn['prompts'][-1]['text'] != bounded(value, 65536)):
                    turn['prompts'].append(dict(at=at, text=bounded(value, 65536))); changed = True
            elif typ == 'AgentMessage' and item.get('phase') == 'final':
                turn['response'] = bounded(content(item.get('content')), 131072); changed = True
            elif typ == 'FileChange':
                changes = item.get('changes') or {}
                if isinstance(changes, dict):
                    for path, value in changes.items():
                        change = _change(path, value)
                        if change and len(turn['fileChanges']) < 128:
                            turn['fileChanges'].append(change); changed = True
            elif typ in ('CommandExecution', 'McpToolCall'):
                turn['toolCallCount'] += 1; changed = True
    elif kind == 'response_item' and sub == 'message' and payload.get('role') == 'assistant' and payload.get('phase') == 'final':
        turn['response'] = bounded(content(payload.get('content')), 131072); changed = True
    elif kind == 'event_msg' and sub in ('task_complete', 'task_completed', 'turn_aborted'):
        if isinstance(payload.get('last_agent_message'), str):
            turn['response'] = bounded(payload['last_agent_message'], 131072)
        turn['state'] = 'interrupted' if sub == 'turn_aborted' else 'completed'
        _finish(turn, at, payload.get('duration_ms'))
        changed = True
    if changed and turn['prompts']:
        turn['revision'] += 1
        return dict(turn) if not turn['nativeTurnId'].startswith('inferred:') else None
    return None


def consume_claude(state, event):
    """Project Claude user/assistant/tool events without inspecting host files."""
    if not isinstance(event, dict) or not isinstance(event.get('timestamp'), str):
        return None
    at, kind = event['timestamp'], event.get('type')
    message = event.get('message') or {}
    if not isinstance(message, dict):
        return None
    blocks = message.get('content')
    blocks = blocks if isinstance(blocks, list) else []
    turn = state.get('turn')
    if kind == 'user' and not event.get('isMeta'):
        prompt = content(message.get('content'))
        if prompt:
            if not turn or turn['state'] != 'ongoing':
                state['ordinal'] = state.get('ordinal', -1) + 1
                identity = event.get('uuid')
                native_id = identity if isinstance(identity, str) and identity else 'claude:' + str(state['ordinal'])
                turn = dict(nativeTurnId=bounded(native_id, 256), revision=0, ordinal=state['ordinal'],
                            state='ongoing', prompts=[], response=None, startedAt=at, endedAt=None,
                            durationMs=None, durationSource=None, toolCallCount=0, fileChanges=[],
                            usage=[], contextTokens=None, contextCapacity=CONTEXT_CAPACITY['claude'])
                state['turn'] = turn
            if len(turn['prompts']) < 32 and (not turn['prompts'] or turn['prompts'][-1]['text'] != bounded(prompt, 65536)):
                turn['prompts'].append(dict(at=at, text=bounded(prompt, 65536)))
                turn['revision'] += 1
                return dict(turn)
    if not turn:
        return None
    changed = False
    if kind == 'assistant':
        '''
        FNXC:ExternalSessionUsage 2026-09-23-23:24: A turn's cost is measured, never apportioned from the
        session total. Each priced request is recorded against the turn it belongs to, keyed by message id so a
        rewritten transcript cannot double count. contextTokens is the newest request's whole input, which is
        the context the model actually saw; capacity is the provider window.
        '''
        identity = message.get('id')
        usage = claude_message_usage(message)
        if isinstance(identity, str) and identity and usage is not None and usage['outputTokens'] is not None:
            if len(turn.setdefault('usage', [])) < 64 and not any(u.get('requestId') == identity for u in turn['usage']):
                model = message.get('model')
                turn['usage'].append(dict(requestId=bounded(identity, 256),
                                          model=bounded(model, 256) if isinstance(model, str) else None,
                                          fast=(message.get('usage') or {}).get('speed') == 'fast',
                                          longContext=usage['inputTokens'] > CONTEXT_CAPACITY['claude'], **usage))
                turn['contextTokens'] = usage['inputTokens']
                turn['contextCapacity'] = CONTEXT_CAPACITY['claude']
                changed = True
        elif usage is None and isinstance(message.get('usage'), dict):
            # Unreadable usage marks the turn's accounting incomplete rather than quietly under-reporting it.
            turn['usageComplete'] = False
            changed = True
        answer = content(message.get('content'))
        if answer and turn['response'] != bounded(answer, 131072):
            turn['response'] = bounded(answer, 131072); changed = True
        for block in blocks:
            if not isinstance(block, dict) or block.get('type') != 'tool_use':
                continue
            call_id = block.get('id')
            if not isinstance(call_id, str) or not call_id or call_id in state.setdefault('calls', {}):
                continue
            state['calls'][call_id] = dict(name=block.get('name'), input=block.get('input') or {})
            turn['toolCallCount'] += 1; changed = True
        if message.get('stop_reason') in ('end_turn', 'stop_sequence', 'max_tokens') and turn['state'] == 'ongoing':
            turn['state'] = 'completed'; _finish(turn, at)
            changed = True
    elif kind == 'user':
        result = event.get('toolUseResult') or {}
        for block in blocks:
            if not isinstance(block, dict) or block.get('type') != 'tool_result':
                continue
            call = state.setdefault('calls', {}).pop(block.get('tool_use_id'), None)
            if not call or block.get('is_error') or call['name'] not in ('Edit', 'Write', 'MultiEdit'):
                continue
            tool_input = call.get('input')
            if not isinstance(tool_input, dict):
                continue
            path = tool_input.get('file_path') or tool_input.get('path')
            if not isinstance(path, str) or not path or len(turn['fileChanges']) >= 128:
                continue
            patch = None
            if isinstance(result, dict) and isinstance(result.get('structuredPatch'), list):
                lines = []
                for hunk in result['structuredPatch']:
                    if not isinstance(hunk, dict):
                        continue
                    lines.append(f"@@ -{hunk.get('oldStart', 0)},{hunk.get('oldLines', 0)} +{hunk.get('newStart', 0)},{hunk.get('newLines', 0)} @@")
                    lines.extend(line for line in hunk.get('lines', []) if isinstance(line, str))
                patch = '\n'.join(lines) + '\n' if lines else None
            change = _change(path, {'type': 'modify', **({'diff': patch} if patch else {})})
            if change:
                turn['fileChanges'].append(change); changed = True
    elif kind == 'system' and event.get('subtype') == 'turn_duration':
        turn['state'] = 'completed'; _finish(turn, at, event.get('durationMs'))
        changed = True
    if changed and turn['prompts']:
        turn['revision'] += 1
        return dict(turn)
    return None
