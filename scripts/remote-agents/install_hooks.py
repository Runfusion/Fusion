#!/usr/bin/env python3
"""Install/update owned Fusion feedback hooks while preserving other hooks and trust."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shlex
import sys


def identity(command):
    """Only plain invocations of the same script/session spool are ours to update."""
    # FNXC:RemoteAgents 2026-09-18-08:55: Route changes replace only scoped Fusion commands; reruns must not append duplicate feedback hooks.
    try:
        parts = shlex.split(command)
        flags = {'--url', '--project', '--host', '--provider', '--token-file', '--state'}
        if len(parts) != 14 or set(parts[2::2]) != flags or Path(parts[1]).name != 'feedback_hook.py':
            return None
        values = []
        for flag in ['--project', '--host', '--provider', '--state']:
            if parts.count(flag) != 1:
                return None
            index = parts.index(flag)
            if index + 1 >= len(parts):
                return None
            values.append(parts[index + 1])
        if any(part in [';', '&&', '||', '|', '>', '<'] for part in parts):
            return None
        return (os.path.normpath(parts[1]), *values)
    except (ValueError, TypeError):
        return None


def install(path, command, apply=False):
    original = path.read_text() if path.exists() else '{}'
    config = json.loads(original)
    hooks = config.setdefault('hooks', {})
    changed = False
    owned = identity(command)
    for event in ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']:
        groups = hooks.setdefault(event, [])
        found = False
        retained = []
        for group in groups:
            entries = []
            removed = False
            for hook in group.get('hooks', []):
                existing = hook.get('command')
                if existing == command or (owned is not None and identity(existing) == owned):
                    if found:
                        changed = removed = True
                        continue
                    found = True
                    if existing != command:
                        hook = {**hook, 'command': command}
                        changed = True
                entries.append(hook)
            if entries or not removed:
                retained.append({**group, 'hooks': entries})
        if not found:
            retained.append({'hooks': [{'type': 'command', 'command': command, 'timeout': 3}]})
            changed = True
        hooks[event] = retained
    if not changed:
        print(str(path) + ': already installed'); return
    if not apply:
        print(str(path) + ': would install/update owned Fusion hooks; use --apply to install'); return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        backup = path.with_name(path.name + '.fusion-backup-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.write_text(original); os.chmod(backup, 0o600)
    temporary = path.with_name(path.name + '.fusion-tmp')
    temporary.write_text(json.dumps(config, indent=2) + '\n'); os.chmod(temporary, 0o600)
    temporary.replace(path)
    print(str(path) + ': owned Fusion hooks installed/updated; other hooks preserved')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', required=True); p.add_argument('--project', required=True); p.add_argument('--host', required=True)
    p.add_argument('--token-file', type=Path, required=True); p.add_argument('--state', type=Path, required=True)
    p.add_argument('--home', type=Path, default=Path.home()); p.add_argument('--apply', action='store_true')
    args = p.parse_args()
    script = Path(__file__).resolve().with_name('feedback_hook.py')
    for provider, path in [('codex', args.home / '.codex/hooks.json'), ('claude', args.home / '.claude/settings.json')]:
        command = shlex.join([sys.executable, str(script), '--url', args.url, '--project', args.project, '--host', args.host, '--provider', provider, '--token-file', str(args.token_file.resolve()), '--state', str(args.state.resolve())])
        install(path, command, args.apply)
    print('Codex: enable its hooks feature if needed and review/trust the new definitions in the native CLI. Trust is never set by this installer.')
    print('Claude: restart or resume a session to load the updated hook settings.')


if __name__ == '__main__':
    main()
