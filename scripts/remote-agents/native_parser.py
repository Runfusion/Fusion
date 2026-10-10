"""Bounded native Codex/Claude observations and request accounting. No service dependencies."""
import hashlib
import json


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991 else None



# FNXC:ExternalSessionUsage 2026-09-23-23:24: Context capacity per provider. The long-context threshold and the
# window an operator sees must be the same number, so both read this table instead of repeating a literal.
CONTEXT_CAPACITY = {'claude': 200000, 'codex': 272000}


def codex_usage_record(payload):
    """Normalized usage for one Codex token_usage_record, or None when the record cannot be trusted.

    Shared with the turn parser. The record names its own ``turn_id``, so a turn's usage is stated by the
    transcript rather than inferred from ordering.
    """
    u = payload.get('usage') if isinstance(payload, dict) else None
    if not isinstance(u, dict):
        return None
    usage = dict(inputTokens=count(u.get('input_tokens')), cachedInputTokens=count(u.get('cached_input_tokens', 0)),
                 outputTokens=count(u.get('output_tokens')), reasoningTokens=count(u.get('reasoning_output_tokens')),
                 cacheWriteTokens=count(u.get('cache_write_input_tokens', 0)), cacheWriteHourTokens=0)
    if usage['inputTokens'] is None or usage['outputTokens'] is None or usage['cachedInputTokens'] is None or usage['cacheWriteTokens'] is None:
        return None
    return usage


def claude_message_usage(message):
    """Normalized usage for one Claude assistant message, or None when the record cannot be trusted.

    Shared with the turn parser so per-turn and per-session accounting can never drift apart. inputTokens is
    the whole context presented to the model (fresh + cache read + cache write), which is also the context
    size for that request.
    """
    u = message.get('usage') if isinstance(message, dict) else None
    if not isinstance(u, dict):
        return None
    fresh = count(u.get('input_tokens'))
    read, write = (count(u.get(k, 0)) for k in ('cache_read_input_tokens', 'cache_creation_input_tokens'))
    hour = count((u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens', 0))
    if None in (fresh, read, write):
        return None
    return dict(inputTokens=fresh + read + write, cachedInputTokens=read, cacheWriteTokens=write,
                cacheWriteHourTokens=hour, outputTokens=count(u.get('output_tokens')), reasoningTokens=None)


def content(value):
    if isinstance(value, str):
        return value
    return '\n'.join(b.get('text', '') for b in value or [] if isinstance(b, dict) and b.get('type') in ('text', 'input_text', 'output_text')) if isinstance(value, list) else ''


def bounded(value, units=2048):
    return str(value).replace('\0', '␀').encode('utf-16-le', errors='replace')[:units * 2].decode('utf-16-le', errors='ignore')


def consume(db, state, event, provider, accounting=True):
    if not isinstance(event, dict) or not isinstance(event.get('timestamp'), str):
        return
    at, kind = event['timestamp'], event.get('type')
    p, message = event.get('payload') or {}, event.get('message') or {}
    if not isinstance(p, dict) or not isinstance(message, dict):
        return
    sub = p.get('type')
    if provider == 'codex' and kind == 'session_meta':
        state.update(nativeSessionId=p.get('id'), projectPath=p.get('cwd'))
    if provider == 'claude':
        state['nativeSessionId'] = event.get('sessionId') or state.get('nativeSessionId')
        state['projectPath'] = event.get('cwd') or state.get('projectPath')
    native = state.get('nativeSessionId')
    if not isinstance(native, str) or not isinstance(state.get('projectPath'), str):
        return
    latest = at >= state.get('observedAt', '')
    if latest:
        state['observedAt'] = at
        state.setdefault('activity', 'unknown')
        if kind == 'turn_context':
            state['model'] = p.get('model') or state.get('model')
            state['fast'] = p.get('service_tier') in ('fast', 'priority')
        if kind == 'assistant' and message.get('model'):
            state['model'] = message['model']
        if sub in ('task_started', 'user_message') or kind == 'user':
            state['activity'] = 'working'
        if sub in ('task_complete', 'task_completed', 'turn_aborted') or (kind == 'system' and event.get('subtype') == 'turn_duration'):
            state['activity'] = 'waiting'
        if sub == 'session_end':
            state['activity'] = 'completed'
        if kind == 'assistant':
            state['activity'] = 'waiting' if message.get('stop_reason') in ('end_turn', 'stop_sequence', 'max_tokens') else 'working'
        item = p.get('item') or {}
        if not isinstance(item, dict):
            item = {}
        value, category = '', None
        if sub == 'user_message':
            value, category = p.get('message', ''), 'prompt'
        elif kind == 'user' and not event.get('isMeta'):
            value, category = content(message.get('content')), 'prompt'
        elif kind == 'response_item' and sub == 'message':
            value = content(p.get('content'))
            category = 'prompt' if p.get('role') == 'user' else 'response'
        elif sub == 'item_completed' and item.get('type') in ('UserMessage', 'AgentMessage'):
            value = content(item.get('content')); category = 'prompt' if item['type'] == 'UserMessage' else 'response'
        elif p.get('last_agent_message'):
            value, category = p['last_agent_message'], 'response'
        elif kind == 'assistant':
            value, category = content(message.get('content')), 'response'
        elif sub in ('function_call', 'custom_tool_call'):
            value, category = p.get('name', 'Tool call'), 'tool'
        elif sub == 'item_completed' and item.get('type') in ('CommandExecution', 'McpToolCall', 'FileChange'):
            value, category = item.get('type'), 'tool'
        if value and category:
            value = bounded(value)
            recent = state.setdefault('recentActivity', [])
            entry = dict(kind=category, at=at, text=value)
            if not recent or recent[-1] != entry:
                recent.append(entry); del recent[:-10]
            if category == 'prompt':
                state['title'] = bounded(' '.join(value.split()), 512)
    if not accounting:
        return
    model = message.get('model') or state.get('model') or 'Unknown'
    fields = dict(inputTokens='input_tokens', cachedInputTokens='cached_input_tokens', outputTokens='output_tokens', reasoningTokens='reasoning_output_tokens')
    request, usage, authoritative = None, None, False
    if provider == 'codex' and kind == 'token_usage_record':
        u = p.get('usage') or {}
        if isinstance(u, dict):
            request = 'response:' + str(p.get('response_id') or event.get('ordinal') or hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest())
            usage = codex_usage_record(p)
            if usage is None:
                # Unreadable usage is UNKNOWN, not absent, exactly as on the Claude path.
                state['unreportedUsage'] = True
                return
            authoritative = True
    elif provider == 'codex' and sub == 'token_count':
        info = p.get('info') or {}; u = info.get('total_token_usage') or {}
        previous = state.get('previousUsage', {})
        if isinstance(u, dict) and count(u.get('input_tokens')) is not None:
            state['previousUsage'] = u
            if not state.get('authoritativeUsage'):
                usage = {k: max(0, u.get(v, 0) - previous.get(v, 0)) if count(u.get(v, 0 if k != 'reasoningTokens' else None)) is not None and count(previous.get(v, 0)) is not None else None for k, v in fields.items()}
                usage.update(cacheWriteTokens=0, cacheWriteHourTokens=0)
                request = 'fallback:' + hashlib.sha256(json.dumps(u, sort_keys=True).encode()).hexdigest()
    elif provider == 'claude' and kind == 'assistant' and message.get('id'):
        u = message.get('usage') or {}
        if isinstance(u, dict):
            request = 'message:' + str(message['id'])
            usage = claude_message_usage(message)
            # An unparseable usage record is UNKNOWN, not absent: without this the session would report a
            # complete total while silently dropping the request it could not read.
            if usage is None:
                state['unreportedUsage'] = True
                return
    if request and usage:
        if any(v is None for k, v in usage.items() if k != 'reasoningTokens') or usage['cachedInputTokens'] + usage['cacheWriteTokens'] > usage['inputTokens'] or (usage['reasoningTokens'] is not None and usage['reasoningTokens'] > usage['outputTokens']):
            state['unreportedUsage'] = True; return
        if authoritative and not state.get('authoritativeUsage'):
            fallback = db.execute("SELECT 1 FROM requests WHERE provider=? AND native=? AND request LIKE 'fallback:%' LIMIT 1", (provider, native)).fetchone()
            if fallback:
                state['unreportedUsage'] = True
            db.execute("DELETE FROM requests WHERE provider=? AND native=? AND request LIKE 'fallback:%'", (provider, native))
            state['authoritativeUsage'] = True
        previous = db.execute('SELECT usage FROM requests WHERE provider=? AND native=? AND request=?', (provider, native, request)).fetchone()
        if previous:
            old = json.loads(previous[0]); usage = {k: max(v, old[k]) if v is not None and old.get(k) is not None else v if v is not None else old.get(k) for k, v in usage.items()}
        usage.update(model=model, fast=state.get('fast', False) or u.get('speed') == 'fast', longContext=usage['inputTokens'] > CONTEXT_CAPACITY.get(provider, CONTEXT_CAPACITY['codex']))
        db.execute('INSERT INTO requests VALUES (?,?,?,?) ON CONFLICT(provider,native,request) DO UPDATE SET usage=excluded.usage', (provider, native, request, json.dumps(usage)))


def totals(db, provider, native):
    bands = {}
    for row in db.execute('SELECT usage FROM requests WHERE provider=? AND native=?', (provider, native)):
        u = json.loads(row[0]); key = (u['model'], u['fast'], u['longContext'])
        b = bands.setdefault(key, dict(model=u['model'], fast=u['fast'], longContext=u['longContext'], **{k: 0 for k in u if k not in ('model', 'fast', 'longContext')}))
        for k in b:
            if k not in ('model', 'fast', 'longContext'):
                b[k] = b[k] + u[k] if b[k] is not None and u[k] is not None else None
    if len(bands) > 64:
        raise ValueError('Model band capacity reached')
    return list(bands.values())
