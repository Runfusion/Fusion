"""Bounded framing for native records whose bodies have no turn-history meaning.

Only canonical Codex compaction snapshots and raw tool output records qualify.
Other oversized records remain paused; a user/assistant message is never skipped.
"""
import json
import re

HEADER = re.compile(rb'^\s*\{\s*"timestamp"\s*:\s*("[^"\\]{1,40}")\s*,\s*(?:"ordinal"\s*:\s*[0-9]+\s*,\s*)?"type"\s*:\s*"(compacted|response_item)"\s*,\s*"payload"\s*:\s*\{')
PAYLOAD = re.compile(rb'\s*"type"\s*:\s*"(custom_tool_call_output|function_call_output)"\s*[,}]')

def ignored_header(raw, provider):
    if provider != 'codex':return None
    match=HEADER.match(raw[:4096])
    if not match:return None
    kind=match[2].decode()
    payload={}
    if kind=='response_item':
        sub=PAYLOAD.match(raw[match.end():match.end()+4096])
        if not sub:return None
        payload['type']=sub[1].decode()
    return dict(timestamp=json.loads(match[1]),type=kind,payload=payload)


def scan_opaque_tail(path, position, budget):
    """Advance at most budget bytes; commit the main cursor only at a newline."""
    with path.open('rb') as stream:
        stream.seek(position)
        while budget>0:
            chunk=stream.read(min(65536,budget))
            if not chunk:return position,False
            end=chunk.find(b'\n')
            if end>=0:return position+end+1,True
            position+=len(chunk);budget-=len(chunk)
    return position,False
