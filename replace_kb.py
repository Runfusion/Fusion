import os
import re

ROOT = '/Users/eclipxe/Projects/kb'

# No longer skipping .kb — process everything except git, node_modules, dist, backups
SKIP_DIRS = {'.git', 'node_modules', 'dist', '.fusion-backup-20260331-223358'}
SKIP_FILES = {'replace_kb.py', 'replace_kb.py.bak'}

changed = []
errors = []

for dirpath, dirnames, filenames in os.walk(ROOT):
    # Prune directories in-place
    dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]

    for filename in filenames:
        if filename in SKIP_FILES:
            continue
        full_path = os.path.join(dirpath, filename)
        rel_path = os.path.relpath(full_path, ROOT)

        try:
            with open(full_path, 'rb') as fh:
                raw = fh.read()
        except Exception as e:
            errors.append(f"READ {rel_path}: {e}")
            continue

        # Skip binary files (check for null bytes)
        if b'\x00' in raw:
            continue

        try:
            content = raw.decode('utf-8')
        except UnicodeDecodeError:
            try:
                content = raw.decode('latin-1')
            except Exception as e:
                errors.append(f"DECODE {rel_path}: {e}")
                continue

        new_content = content.replace('kb.db', 'fusion.db')
        new_content = re.sub(r'\.kb(?![a-zA-Z0-9_\-])', '.fusion', new_content)

        if new_content != content:
            try:
                with open(full_path, 'w', encoding='utf-8') as fh:
                    fh.write(new_content)
                changed.append(rel_path)
            except Exception as e:
                errors.append(f"WRITE {rel_path}: {e}")

print(f"Changed {len(changed)} files:")
for f in sorted(changed):
    print(f"  {f}")

if errors:
    print(f"\nErrors ({len(errors)}):")
    for e in errors:
        print(f"  {e}")
