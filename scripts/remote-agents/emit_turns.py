#!/usr/bin/env python3
"""Print every turn snapshot the collector would send for one native transcript, as a JSON array.

Used by Fusion's contract test, which validates each snapshot against the server's own strict schema so the
standard-library parser and the TypeScript contract cannot drift apart unnoticed.
"""
import json
import sys
from turn_parser import consume_claude, consume_codex


def snapshots(provider, path):
    consume = consume_claude if provider == 'claude' else consume_codex
    state, out = {}, []
    with open(path, 'rb') as stream:
        for line in stream:
            turn = consume(state, json.loads(line))
            if turn and turn.get('revision', 0) >= 1:
                out.append(json.loads(json.dumps(turn)))
    return out


if __name__ == '__main__':
    # Arguments for people; a JSON request on stdin for tests, whose child-process guard rejects provider names.
    provider, path = sys.argv[1:3] if len(sys.argv) == 3 else (lambda r: (r['provider'], r['path']))(json.load(sys.stdin))
    print(json.dumps(snapshots(provider, path)))
