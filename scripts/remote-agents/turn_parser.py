"""Incremental, bounded Codex and Claude turns from native transcript events.

The caller persists ``state`` with its transcript cursor. No working-tree files are
read: a patch is shown only when the native event carries one.
"""
from datetime import datetime

from native_parser import bounded, content


def _elapsed(start, end):
    try:
        return max(0, round((datetime.fromisoformat(end.replace('Z', '+00:00')) -
                             datetime.fromisoformat(start.replace('Z', '+00:00'))).total_seconds() * 1000))
    except (AttributeError, ValueError):
        return None


def _ended(turn, at):
    # FNXC:RemoteAgents 2026-10-04-00:45: After a context compaction Claude writes the summary prompt with the
    # current time and then re-emits earlier messages with their original, older timestamps, so the event that
    # completes the new turn can predate its start. Fusion rejects a turn that ends before it starts, and one
    # rejected turn blocked every later turn of the host, so clamp the end to the start instead.
    started = turn.get('startedAt')
    return started if isinstance(started, str) and isinstance(at, str) and at < started else at


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
                    durationMs=None, durationSource=None, toolCallCount=0, fileChanges=[])
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
        turn['endedAt'] = _ended(turn, at)
        duration = payload.get('duration_ms')
        turn['durationMs'] = duration if isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0 else _elapsed(turn['startedAt'], turn['endedAt'])
        turn['durationSource'] = ('native' if isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0 else 'derived') if turn['durationMs'] is not None else None
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
                            durationMs=None, durationSource=None, toolCallCount=0, fileChanges=[])
                state['turn'] = turn
            if len(turn['prompts']) < 32 and (not turn['prompts'] or turn['prompts'][-1]['text'] != bounded(prompt, 65536)):
                turn['prompts'].append(dict(at=at, text=bounded(prompt, 65536)))
                turn['revision'] += 1
                return dict(turn)
    if not turn:
        return None
    changed = False
    if kind == 'assistant':
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
            turn['state'] = 'completed'; turn['endedAt'] = _ended(turn, at)
            turn['durationMs'] = _elapsed(turn['startedAt'], turn['endedAt'])
            turn['durationSource'] = 'derived' if turn['durationMs'] is not None else None
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
        duration = event.get('durationMs')
        turn['state'] = 'completed'; turn['endedAt'] = _ended(turn, at)
        turn['durationMs'] = duration if isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0 else _elapsed(turn['startedAt'], turn['endedAt'])
        turn['durationSource'] = ('native' if isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0 else 'derived') if turn['durationMs'] is not None else None
        changed = True
    if changed and turn['prompts']:
        turn['revision'] += 1
        return dict(turn)
    return None
